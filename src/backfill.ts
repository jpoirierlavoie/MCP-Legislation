// Rattrapage des vecteurs (plan v2, 2.2) — route d'administration HORS MCP.
//
// POST /admin/backfill-vectors, active SEULEMENT si le secret BACKFILL_TOKEN est posé et
// que l'Authorization Bearer concorde (comparaison à temps constant sur empreintes SHA-256).
// Utilise les BINDINGS (AI + VECTORS) : mêmes chemins de code que la requête de production,
// aucun scope de jeton supplémentaire.
//
// Modes :
//   - "full"        (défaut) : embedde/upsert toute la page et met à jour `vector_state` ;
//   - "incremental" : n'embedde que les éléments absents de `vector_state` ou dont le SHA-256
//                     du texte canonique (fil d'Ariane compris) a changé ;
//   - "seed"        : enregistre les empreintes actuelles dans `vector_state` SANS appeler AI/VECTORS ;
//   - "prune"       : supprime de Vectorize et de `vector_state` les vecteurs orphelins de la loi ;
//   - "ping"        : vérifie les liaisons AI + VECTORS et retourne le nombre suivi dans `vector_state`.

import { breadcrumbChains, EMBED_MODEL } from "./lib";

/** Fenêtre bge-m3 : 60 K tokens PAR REQUÊTE, consommés comme lot × (texte le plus
 * long) — le moteur REMBOURRE tous les textes à la longueur du plus long (constaté :
 * « Max context reached 60850 » pour 50 textes de 1 217 tokens max). Contrainte réelle :
 * n × tokens(max) <= 60 000. */
const EMBED_BATCH = 50;
const EMBED_TOKEN_BUDGET = 55_000;
/** Estimation d'empaquetage seulement : la VÉRITÉ vient du modèle (scission sur l'erreur
 * 3030), jamais de ce chiffre — invariant 8. Mesuré le 2026-07-21 : les textes les plus
 * denses du corpus (énumérations d'i-16) descendent à ~2,4 car./token ; on empaquette à
 * 2,0 pour rester SOUS la mesure. Ne pas y substituer une moyenne du corpus : c'est le
 * pire cas qui décide si le lot passe. */
const estTokens = (chars: number) => Math.ceil(chars / 2.0);
/** Plafond du texte embeddé (~1 500 tokens — plan 2.2) ; dépassements comptés. */
const MAX_CHARS = 6000;
/** Plafond d'éléments par invocation de la route (borne le temps par requête). */
const MAX_COUNT = 250;
/** Taille de lot SQL pour IN (...) et db.batch (D1 plafonne à 100 liaisons par énoncé). */
const SQL_CHUNK = 90;

export type BackfillMode = "full" | "incremental" | "seed" | "prune" | "ping";
const MODES_VALIDES = new Set<string>(["full", "incremental", "seed", "prune", "ping"]);

interface BackfillBody {
  kind: "articles" | "divisions";
  law: string;
  mode?: BackfillMode;
  offset?: number;
  count?: number;
}

interface EnvWithSecrets extends Env {
  BACKFILL_TOKEN?: string;
}

interface BackfillItem {
  id: string;
  text: string;
  contentHash: string;
  metadata: Record<string, VectorizeVectorMetadataValue>;
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

async function sha256Bytes(input: string): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return new Uint8Array(buf);
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = await sha256Bytes(input);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Comparaison à temps constant sur empreintes SHA-256 du jeton Bearer. */
async function verifieJetonBackfill(authHeader: string, secret: string): Promise<boolean> {
  if (!authHeader.startsWith("Bearer ")) return false;
  const [a, b] = await Promise.all([sha256Bytes(authHeader), sha256Bytes(`Bearer ${secret}`)]);
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ (b[i] ?? 0);
  return diff === 0;
}

/**
 * Id Vectorize d'une division : les ids sont plafonnés à 64 OCTETS, or un chemin Irosoft
 * profond dépasse largement (div:ccq:ga:l_cinquieme-gb:…). On hache le chemin (SHA-256,
 * 24 hex = 96 bits — collision impensable sur ~2,7 K divisions) ; le chemin complet vit
 * dans metadata.path. Stable -> upserts idempotents.
 */
async function divVectorId(law: string, path: string): Promise<string> {
  const hex = await sha256Hex(`${law}|${path}`);
  return `div:${law}:${hex.slice(0, 24)}`;
}

/**
 * Id Vectorize d'un article : les ids sont plafonnés à 64 OCTETS UTF-8. Les numéros
 * courts restent verbatim (`art:${law}:${number}`) pour préserver les vecteurs existants ;
 * au-delà de 64 octets UTF-8, on hache (`art:${law}:${hex.slice(0, 24)}`) à l'instar de
 * `divVectorId` (le numéro complet vit dans `metadata.article`).
 */
export async function artVectorId(law: string, number: string): Promise<string> {
  const raw = `art:${law}:${number}`;
  if (new TextEncoder().encode(raw).byteLength <= 64) return raw;
  const hex = await sha256Hex(`${law}|${number}`);
  return `art:${law}:${hex.slice(0, 24)}`;
}

async function upsertVectorState(
  db: D1Database,
  law: string,
  kind: "articles" | "divisions",
  items: BackfillItem[],
): Promise<void> {
  if (!items.length) return;
  const stmt = db.prepare(
    `INSERT INTO vector_state (vector_id, law_id, kind, content_hash, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(vector_id) DO UPDATE SET
       law_id = excluded.law_id,
       kind = excluded.kind,
       content_hash = excluded.content_hash,
       updated_at = excluded.updated_at`,
  );
  for (let i = 0; i < items.length; i += SQL_CHUNK) {
    const chunk = items.slice(i, i + SQL_CHUNK);
    await db.batch(chunk.map((it) => stmt.bind(it.id, law, kind, it.contentHash)));
  }
}

async function readTrackedHashes(
  db: D1Database,
  law: string,
  kind: "articles" | "divisions",
  ids: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < ids.length; i += SQL_CHUNK) {
    const chunk = ids.slice(i, i + SQL_CHUNK);
    const rows = (
      await db
        .prepare(
          `SELECT vector_id, content_hash FROM vector_state
           WHERE law_id = ? AND kind = ? AND vector_id IN (${chunk.map(() => "?").join(",")})`,
        )
        .bind(law, kind, ...chunk)
        .all<{ vector_id: string; content_hash: string }>()
    ).results;
    for (const r of rows) out.set(r.vector_id, r.content_hash);
  }
  return out;
}

/**
 * Construit les textes canoniques FR d'une page, avec le fil d'Ariane cuit dans le texte
 * embeddé et son SHA-256 pour le suivi incrémental.
 */
async function chargerPageBackfill(
  db: D1Database,
  law: string,
  lawNameFr: string,
  lawDomain: string,
  lawJurisdiction: string,
  kind: "articles" | "divisions",
  count: number,
  offset: number,
): Promise<{ items: BackfillItem[]; overruns: number }> {
  const items: BackfillItem[] = [];
  let overruns = 0;

  if (kind === "articles") {
    // Départage par `id` : le rattrapage pagine par LIMIT/OFFSET, or deux articles peuvent
    // partager une clé de tri (cf. `boundRef` dans src/lib.ts). Sans ordre total, un lot
    // pouvait sauter un article ou en embarquer deux fois — invisible depuis l'API.
    const rows = (
      await db
        .prepare(
          `SELECT number, division_path, text, marginal_note FROM articles
           WHERE law_id = ? AND lang = 'fr' ORDER BY sort_key, id LIMIT ? OFFSET ?`,
        )
        .bind(law, count, offset)
        .all<{
          number: string;
          division_path: string;
          text: string;
          marginal_note: string | null;
        }>()
    ).results;
    const chains = await breadcrumbChains(
      db,
      "fr",
      rows.map((r) => ({ law_id: law, division_path: r.division_path })),
    );
    for (const r of rows) {
      const chain = chains.get(`${law}|${r.division_path}`) ?? [];
      const crumb = chain
        .map((n) => [n.kind, n.number, n.heading].filter(Boolean).join(" "))
        .join(" › ");
      const mNote = r.marginal_note?.trim() ? ` (${r.marginal_note.trim()})` : "";
      let text = `${lawNameFr} — ${crumb} — art. ${r.number}${mNote}. ${r.text}`;
      if (text.length > MAX_CHARS) {
        text = text.slice(0, MAX_CHARS);
        overruns++;
      }
      const heading = [...chain].reverse().find((n) => n.heading)?.heading ?? "";
      items.push({
        id: await artVectorId(law, r.number),
        text,
        contentHash: await sha256Hex(text),
        metadata: {
          law,
          article: r.number,
          path: r.division_path,
          heading,
          type: "article",
          domain: lawDomain,
          jurisdiction: lawJurisdiction,
        },
      });
    }
  } else {
    // Départage par `id`, même raison que pour les articles : `sort_order` n'est pas garanti
    // unique sur toute l'histoire d'une base. Sans ordre total, LIMIT/OFFSET devient ambigu.
    const rows = (
      await db
        .prepare(
          `SELECT path, heading FROM divisions
           WHERE law_id = ? AND lang = 'fr' ORDER BY sort_order, id LIMIT ? OFFSET ?`,
        )
        .bind(law, count, offset)
        .all<{ path: string; heading: string | null }>()
    ).results;
    const chains = await breadcrumbChains(
      db,
      "fr",
      rows.map((r) => ({ law_id: law, division_path: r.path })),
    );
    for (const r of rows) {
      const chain = chains.get(`${law}|${r.path}`) ?? [];
      const crumb = chain
        .map((n) => [n.kind, n.number, n.heading].filter(Boolean).join(" "))
        .join(" › ");
      const text = `${lawNameFr} — ${crumb}`.slice(0, MAX_CHARS);
      items.push({
        id: await divVectorId(law, r.path),
        text,
        contentHash: await sha256Hex(text),
        metadata: {
          law,
          path: r.path,
          heading: r.heading ?? "",
          type: "division",
          domain: lawDomain,
          jurisdiction: lawJurisdiction,
        },
      });
    }
  }
  return { items, overruns };
}

/** Supprime de Vectorize et de `vector_state` les vecteurs devenus orphelins pour une loi. */
async function pruneVectors(
  db: D1Database,
  vectors: VectorizeIndex,
  law: string,
  kind: "articles" | "divisions",
): Promise<string[]> {
  const tracked = (
    await db
      .prepare("SELECT vector_id FROM vector_state WHERE law_id = ? AND kind = ?")
      .bind(law, kind)
      .all<{ vector_id: string }>()
  ).results;
  if (!tracked.length) return [];

  const live = new Set<string>();
  if (kind === "articles") {
    const rows = (
      await db
        .prepare("SELECT number FROM articles WHERE law_id = ? AND lang = 'fr'")
        .bind(law)
        .all<{ number: string }>()
    ).results;
    for (const r of rows) live.add(await artVectorId(law, r.number));
  } else {
    const rows = (
      await db
        .prepare("SELECT path FROM divisions WHERE law_id = ? AND lang = 'fr'")
        .bind(law)
        .all<{ path: string }>()
    ).results;
    for (const r of rows) live.add(await divVectorId(law, r.path));
  }

  const orphans = tracked.map((r) => r.vector_id).filter((id) => !live.has(id));
  for (let i = 0; i < orphans.length; i += SQL_CHUNK) {
    const chunk = orphans.slice(i, i + SQL_CHUNK);
    await vectors.deleteByIds(chunk);
    await db
      .prepare(`DELETE FROM vector_state WHERE vector_id IN (${chunk.map(() => "?").join(",")})`)
      .bind(...chunk)
      .run();
  }
  return orphans;
}

export async function handleBackfill(request: Request, env: Env): Promise<Response> {
  try {
    return await handleBackfillInner(request, env);
  } catch (e) {
    return json({ error: `exception: ${(e as Error).message?.slice(0, 300)}` }, 500);
  }
}

async function handleBackfillInner(request: Request, env: Env): Promise<Response> {
  const secret = (env as EnvWithSecrets).BACKFILL_TOKEN;
  if (!secret) return new Response("Not found", { status: 404 }); // route inerte sans secret
  if (!(await verifieJetonBackfill(request.headers.get("Authorization") ?? "", secret))) {
    return new Response("Non autorisé.", { status: 401 });
  }
  if (request.method !== "POST") return new Response("POST attendu.", { status: 405 });

  let body: BackfillBody;
  try {
    body = await request.json<BackfillBody>();
  } catch {
    return json({ error: "corps JSON invalide" }, 400);
  }
  const { kind, law } = body;
  if (!law || (kind !== "articles" && kind !== "divisions")) {
    return json({ error: "kind ('articles'|'divisions') et law requis" }, 400);
  }
  if (body.mode !== undefined && !MODES_VALIDES.has(body.mode)) {
    return json({ error: "mode invalide (full|incremental|seed|prune|ping)" }, 400);
  }
  const mode: BackfillMode = body.mode ?? "full";

  const db = env.DB;

  if (mode === "ping") {
    if (!env.AI || !env.VECTORS) {
      return json({ error: "liaisons AI/VECTORS absentes" }, 503);
    }
    const lawExists = await db
      .prepare("SELECT id FROM laws WHERE id = ?")
      .bind(law)
      .first<{ id: string }>();
    const row = await db
      .prepare("SELECT COUNT(*) AS n FROM vector_state WHERE law_id = ? AND kind = ?")
      .bind(law, kind)
      .first<{ n: number }>();
    return json({ ok: true, mode, kind, law, exists: Boolean(lawExists), tracked: row?.n ?? 0 });
  }

  const lawRow = await db
    .prepare("SELECT id, name_fr, domain, jurisdiction FROM laws WHERE id = ?")
    .bind(law)
    .first<{ id: string; name_fr: string; domain: string | null; jurisdiction: string | null }>();
  if (!lawRow) return json({ error: `loi inconnue : ${law}` }, 404);

  if (mode === "prune") {
    if (!env.VECTORS) {
      return json({ error: "liaison VECTORS absente" }, 503);
    }
    const orphans = await pruneVectors(db, env.VECTORS, law, kind);
    return json({
      kind,
      law,
      mode,
      deleted: orphans.length,
      deleted_ids: orphans,
      done: true,
    });
  }

  const offset = Math.max(0, body.offset ?? 0);
  const count = Math.min(MAX_COUNT, Math.max(1, body.count ?? MAX_COUNT));
  const { items, overruns } = await chargerPageBackfill(
    db,
    law,
    lawRow.name_fr,
    lawRow.domain ?? "core",
    lawRow.jurisdiction ?? "qc",
    kind,
    count,
    offset,
  );
  const done = items.length < count;
  const next = offset + items.length;

  if (mode === "seed") {
    await upsertVectorState(db, law, kind, items);
    return json({
      kind,
      law,
      mode,
      offset,
      scanned: items.length,
      seeded: items.length,
      embedded: 0,
      skipped: 0,
      overruns,
      done,
      next,
    });
  }

  let toEmbed = items;
  let skipped = 0;
  if (mode === "incremental" && items.length > 0) {
    const existing = await readTrackedHashes(
      db,
      law,
      kind,
      items.map((it) => it.id),
    );
    toEmbed = items.filter((it) => existing.get(it.id) !== it.contentHash);
    skipped = items.length - toEmbed.length;
  }

  if (toEmbed.length > 0 && (!env.AI || !env.VECTORS)) {
    return json({ error: "liaisons AI/VECTORS absentes" }, 503);
  }

  // --- embed (lots bornés en items ET en caractères) puis upsert ---------------
  const batches: BackfillItem[][] = [];
  let cur: BackfillItem[] = [];
  let curMaxChars = 0;
  for (const it of toEmbed) {
    const nextMax = Math.max(curMaxChars, it.text.length);
    const cost = (cur.length + 1) * estTokens(nextMax); // rembourrage au plus long
    if (cur.length && (cur.length >= EMBED_BATCH || cost > EMBED_TOKEN_BUDGET)) {
      batches.push(cur);
      cur = [];
      curMaxChars = 0;
    }
    cur.push(it);
    curMaxChars = Math.max(curMaxChars, it.text.length);
  }
  if (cur.length) batches.push(cur);

  // Embed AUTO-ADAPTATIF : l'estimation ne fait que pré-empaqueter ; si le modèle
  // répond « Max context reached » (3030), on scinde le lot en deux et on recommence —
  // jusqu'au texte seul, qui tient toujours (6 000 car. ÷ 2 car./token = 3 000 tokens).
  async function embedSplit(texts: string[]): Promise<number[][]> {
    try {
      const res = (await env.AI.run(EMBED_MODEL as Parameters<Ai["run"]>[0], {
        text: texts,
      })) as { data?: number[][] };
      if (!res?.data || res.data.length !== texts.length) {
        throw new Error(`réponse d'embedding inattendue (data: ${res?.data?.length ?? "absent"})`);
      }
      return res.data;
    } catch (e) {
      const msg = (e as Error).message ?? "";
      if (texts.length > 1 && /3030|Max context/i.test(msg)) {
        const mid = Math.ceil(texts.length / 2);
        const [a, b] = await Promise.all([
          embedSplit(texts.slice(0, mid)),
          embedSplit(texts.slice(mid)),
        ]);
        return [...a, ...b];
      }
      throw e;
    }
  }

  let embedded = 0;
  for (const batch of batches) {
    let data: number[][];
    try {
      data = await embedSplit(batch.map((b) => b.text));
    } catch (e) {
      // JAMAIS de page HTML : le pilote a besoin d'un JSON actionnable.
      return json(
        {
          error: `AI.run a échoué (${(e as Error).message?.slice(0, 200)})`,
          law,
          kind,
          offset,
          batch_size: batch.length,
          batch_chars: batch.reduce((a, b) => a + b.text.length, 0),
        },
        502,
      );
    }
    await env.VECTORS.upsert(
      batch.map((b, j) => ({
        id: b.id,
        values: data[j],
        metadata: b.metadata,
      })),
    );
    await upsertVectorState(db, law, kind, batch);
    embedded += batch.length;
  }

  return json({
    kind,
    law,
    mode,
    offset,
    scanned: items.length,
    embedded,
    skipped,
    overruns,
    done,
    next,
  });
}
