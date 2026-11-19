// Veille de consolidation — DÉTECTEUR EN LECTURE SEULE. N'écrit RIEN en base.
//
// But : savoir quand LégisQuébec a consolidé une loi au-delà de ce qui est chargé en D1,
// c.-à-d. quand un rafraîchissement (procédure manuelle et supervisée, cf. CLAUDE.md
// « Rafraîchissement semestriel ») est dû. Ce script se contente de le CONSTATER ; la
// bascule reste humaine.
//
// Deux sources, aucune n'exige de secret :
//   • date STOCKÉE   ← list_laws sur l'endpoint MCP public (= colonnes consol_date_*
//                       de D1, telles que servies aux usagers). Une seule session MCP.
//   • date LIVE      ← page LégisQuébec de chaque loi (« À jour au JJ mois AAAA »).
//
// extractConsolidation() est un MIROIR FIDÈLE de pipeline/ingest.py:fetch_consolidation :
// même portée (blocs class="text-end" uniquement), même regex, même table de mois, même
// « première date à mois valide ». Une page atteinte (2xx) dont la bannière devient
// illisible n'est PAS confondue avec une page injoignable : c'est une anomalie du
// détecteur (le miroir a peut-être cassé), donc un signal ACTIONNABLE — jamais un null
// silencieux. Contrat : ne JAMAIS produire de faux négatif silencieux.
//
// Sortie : consolidation-report.md (corps d'issue) + DEUX drapeaux séparés sur
// GITHUB_OUTPUT : `drift` (dérive corpus actionnable) et `unreachable` (blocage réseau
// massif). Le workflow ne clot l'issue que si les DEUX sont éteints — une page
// injoignable est une loi NON VÉRIFIÉE, pas une loi à jour.
// Code de sortie : 0 même en cas de dérive (la dérive est le signal attendu, pas une
// erreur) ; ≠ 0 seulement si le détecteur lui-même n'a rien pu vérifier.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createMcpClient } from "../eval/mcp-client.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const MCP_URL = process.env.MCP_URL || "https://legislation.poirierlavoie.ca/mcp";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"; // = pipeline/config.py:USER_AGENT
const CONCURRENCY = 8;
const TIMEOUT_MS = 20_000;
// Fraction de pages INJOIGNABLES (réseau/HTTP) au-delà de laquelle on ouvre une issue même
// sans autre dérive : un blocage massif (WAF, filtrage d'IP de centre de données) est en
// soi une information. Ne s'applique QU'aux injoignables réseau ; une page atteinte mais
// illisible est traitée à part (bucket `illisible`, toujours actionnable).
export const UNREACHABLE_ALERT_RATIO = 0.25;

// Miroir de _FR_MONTHS (pipeline/ingest.py).
export const FR_MONTHS = {
  janvier: 1,
  février: 2,
  mars: 3,
  avril: 4,
  mai: 5,
  juin: 6,
  juillet: 7,
  août: 8,
  septembre: 9,
  octobre: 10,
  novembre: 11,
  décembre: 12,
};

/**
 * Date « À jour au JJ mois AAAA » -> ISO (AAAA-MM-JJ), ou null si aucun bloc text-end n'en
 * porte. MIROIR FIDÈLE de fetch_consolidation() :
 *   - <script>/<style> retirés (leur contenu n'est pas du texte affiché) ;
 *   - on ne lit QUE les blocs class="text-end" (la bannière), comme find_all(class_=…) —
 *     ce qui exclut les fausses dates de l'historique d'articles ailleurs dans la page ;
 *   - première date à MOIS VALIDE, en poursuivant sur un bloc au mois invalide.
 */
export function extractConsolidation(html) {
  const cleaned = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const textEnd = /<div[^>]*class="[^"]*\btext-end\b[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
  let block;
  while ((block = textEnd.exec(cleaned)) !== null) {
    const text = block[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const m = text.match(/jour au\s*(\d{1,2})\s*(?:er)?\s*([A-Za-zÀ-ÿ]+)\s*(\d{4})/i);
    if (m && FR_MONTHS[m[2].toLowerCase()]) {
      const mm = String(FR_MONTHS[m[2].toLowerCase()]).padStart(2, "0");
      const dd = String(Number(m[1])).padStart(2, "0");
      return `${m[3]}-${mm}-${dd}`;
    }
  }
  return null;
}

/**
 * Date « à jour AAAA-MM-JJ » / « current to AAAA-MM-JJ » d'une page de Justice Canada.
 * MIROIR FIDÈLE de pipeline/ingest.py:extrait_consolidation_federale.
 *
 *   - Portée bornée au SEUL <p id="assentedDate">, comme le couple québécois l'est aux
 *     blocs text-end. La page porte d'autres dates (historique, versions antérieures).
 *   - Ancrage sur la PHRASE, jamais sur la première date du bloc : celui-ci en porte
 *     DEUX — « à jour AAAA-MM-JJ » puis « dernière modification AAAA-MM-JJ ». Mesuré le
 *     2026-09-14 sur les 36 pages : bloc présent partout, phrase présente partout, au
 *     moins deux dates partout. Borner la portée NE SUFFIT DONC PAS.
 *   - La date est DÉJÀ en ISO : aucune table de mois, contrairement à FR_MONTHS. Si
 *     Justice Canada passait un jour au format littéral, les DEUX moitiés du miroir
 *     rendraient null — c'est-à-dire « illisible », donc actionnable, jamais « à jour ».
 *
 * On s'ancre sur « jour » et non sur « à jour » : le « à » arrive tantôt en entité
 * (&agrave;, pages de lois) tantôt en littéral (pages de règlements), et ce
 * dépouillement-ci ne décode PAS les entités là où BeautifulSoup le fait côté Python.
 * L'ancrage court neutralise cette asymétrie — les deux moitiés rendent la même valeur
 * sur le même HTML, ce qui est tout l'objet d'un miroir.
 *
 * Le retrait de <script>/<style> n'a pas d'équivalent côté Python parce que BeautifulSoup
 * PARSE là où l'on dépouille ici : sans lui, une chaîne ressemblant à la balise cible dans
 * un script pourrait être captée par la regex et jamais par le parseur. Cet écart RAPPROCHE
 * les deux moitiés au lieu de les éloigner.
 */
// Nommée, et non inline, pour être la MOITIÉ COMPARABLE de `_DATE_FEDERALE`
// (pipeline/ingest.py) : `scripts/check-consolidation.test.mjs` extrait les deux des
// SOURCES et exige qu'elles soient identiques. Un miroir que rien ne compare finit par
// diverger — c'est l'invariant 2, appliqué ici avant qu'il ne coûte quelque chose.
const DATE_FEDERALE = /(?:jour|current\s+to)\s*(\d{4}-\d{2}-\d{2})/i;

export function extractConsolidationFederale(html) {
  const cleaned = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const bloc = cleaned.match(/<p[^>]*\bid=['"]assentedDate['"][^>]*>([\s\S]*?)<\/p>/i);
  if (!bloc) return null;
  const text = bloc[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const m = text.match(DATE_FEDERALE);
  return m ? m[1] : null;
}

/**
 * Trois issues distinctes, jamais confondues :
 *   { status: "ok", date }              page atteinte, date lue
 *   { status: "illisible", note }       page atteinte (2xx) mais date introuvable — le
 *                                        miroir a peut-être cassé : ACTIONNABLE
 *   { status: "injoignable", note }     réseau / HTTP >= 400 / délai / URL absente
 *
 * `extracteur` est passé par l'appelant parce que le corpus a DEUX publieurs, dont les
 * bannières n'ont ni la même portée ni le même format. Le choisir ici, d'après l'URL,
 * reviendrait à deviner le publieur à partir d'une chaîne — alors que la configuration le
 * DIT déjà (`consolidation_source` ou `official_source`).
 */
async function fetchLiveDate(url, extracteur) {
  if (!url)
    return { status: "injoignable", note: "URL de consolidation absente de laws.config.json" };
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { status: "injoignable", note: `HTTP ${res.status}` };
    const date = extracteur(await res.text());
    if (date) return { status: "ok", date };
    return { status: "illisible", note: "page atteinte (200) mais date « À jour au » introuvable" };
  } catch (e) {
    return { status: "injoignable", note: e.name === "TimeoutError" ? "délai dépassé" : "réseau" };
  }
}

export function isCloudflare403(status, headers, bodyText = "") {
  if (status !== 403) return false;
  const cfMitigated = headers?.get?.("cf-mitigated") ?? headers?.["cf-mitigated"] ?? "";
  if (String(cfMitigated).toLowerCase() === "challenge") return true;
  return /Just a moment|cf-browser-verification|_cf_chl_opt|cType:\s*['"]managed['"]/i.test(
    bodyText,
  );
}

export function sha256HexBytes(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

export function parsePdfHeader(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const head = Buffer.from(bytes.subarray(0, 16)).toString("latin1");
  if (!head.startsWith("%PDF-")) return { valid: false, modDate: null };
  // /ModDate est lu à titre informatif uniquement (jamais comme date de consolidation, cf. §7.1).
  const text = Buffer.from(bytes).toString("latin1");
  const m = text.match(/\/ModDate\s*\(D:(\d{4})(\d{2})(\d{2})/i);
  const modDate = m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  return { valid: true, modDate };
}

export function extractPdfIndexDrift(html, { expectedFilename, baseUrl } = {}) {
  const cleaned = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const links = [];
  const anchorRe = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = anchorRe.exec(cleaned)) !== null) {
    const rawHref = m[1].trim();
    if (!/\.pdf(?:[?#].*)?$/i.test(rawHref)) continue;
    let resolved = rawHref;
    if (baseUrl) {
      try {
        resolved = new URL(rawHref, baseUrl).href;
      } catch {
        // conserver brut si URL relative invalide
      }
    }
    links.push(resolved);
  }
  const plain = cleaned.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const dm = plain.match(/jour au\s*(\d{1,2})\s*(?:er)?\s*([A-Za-zÀ-ÿ]+)\s*(\d{4})/i);
  let liveDate = null;
  if (dm && FR_MONTHS[dm[2].toLowerCase()]) {
    const mm = String(FR_MONTHS[dm[2].toLowerCase()]).padStart(2, "0");
    const dd = String(Number(dm[1])).padStart(2, "0");
    liveDate = `${dm[3]}-${mm}-${dd}`;
  }
  if (links.length === 0) {
    return {
      status: "illisible",
      links,
      matchedUrl: null,
      liveDate,
      note: "page d'index atteinte (200) mais aucun lien .pdf trouvé",
    };
  }
  if (expectedFilename) {
    const cible = expectedFilename.toLowerCase();
    const cleanPaths = links.map((u) => {
      const rawPath = u.split(/[?#]/)[0];
      let decoded = rawPath;
      try {
        decoded = decodeURIComponent(rawPath);
      } catch {
        decoded = rawPath;
      }
      return {
        u,
        cleanPath: decoded.toLowerCase(),
      };
    });
    const matchedUrl =
      cleanPaths.find(({ cleanPath }) => cleanPath.endsWith(`/${cible}`) || cleanPath === cible)
        ?.u ??
      cleanPaths.find(({ cleanPath }) => cleanPath.includes(cible))?.u ??
      null;
    if (!matchedUrl) {
      return {
        status: "ok",
        shaDrift: true,
        links,
        matchedUrl: links[0],
        liveDate,
        note: `lien PDF attendu (${expectedFilename}) absent ou remplacé sur la page d'index`,
      };
    }
    return { status: "ok", shaDrift: false, links, matchedUrl, liveDate };
  }
  return { status: "ok", shaDrift: false, links, matchedUrl: links[0], liveDate };
}

export function checkPdfBuffer(buf, { expectedSha256, storedDate } = {}) {
  const { valid, modDate } = parsePdfHeader(buf);
  if (!valid) {
    return { status: "illisible", note: "réponse 200 non-PDF (en-tête %PDF- absent)" };
  }
  if (!expectedSha256) {
    return {
      status: "illisible",
      date: storedDate ?? null,
      shaDrift: false,
      note: "empreinte SHA-256 attendue absente du profil PDF",
    };
  }
  const actual = sha256HexBytes(buf);
  if (actual !== expectedSha256.toLowerCase()) {
    return {
      status: "ok",
      date: storedDate ?? null,
      shaDrift: true,
      note: `empreinte SHA-256 modifiée (${actual.slice(0, 12)}… ≠ ${expectedSha256.slice(0, 12)}…)`,
    };
  }
  return {
    status: "ok",
    date: storedDate ?? null,
    shaDrift: false,
    note: modDate ? `ModDate PDF : ${modDate}` : null,
  };
}

export function loadPdfProfilePins(root = ROOT) {
  const dir = join(root, "pipeline", "pdf_profiles");
  const pins = new Map();
  if (!existsSync(dir)) return pins;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const prof = JSON.parse(readFileSync(join(dir, name), "utf8"));
    if (prof?.law_id && prof?.files) pins.set(prof.law_id, prof.files);
  }
  return pins;
}

export async function fetchLivePdf(url, pin, storedDate, fetchImpl = fetch, _depth = 0) {
  if (!url)
    return { status: "injoignable", note: "URL de consolidation absente de laws.config.json" };
  try {
    const res = await fetchImpl(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 403) {
      const bodyText = await res.text().catch(() => "");
      const cf = isCloudflare403(res.status, res.headers, bodyText);
      return {
        status: "injoignable",
        note: cf ? "Cloudflare 403 (challenge WAF — vérification manuelle requise)" : "HTTP 403",
      };
    }
    if (!res.ok) return { status: "injoignable", note: `HTTP ${res.status}` };
    const buf = new Uint8Array(await res.arrayBuffer());
    const ct = (res.headers?.get?.("content-type") ?? "").toLowerCase();
    const looksHtml =
      ct.includes("text/html") ||
      (!url.toLowerCase().split(/[?#]/)[0].endsWith(".pdf") &&
        !Buffer.from(buf.subarray(0, 8)).toString("latin1").startsWith("%PDF-"));
    if (looksHtml) {
      if (_depth >= 1) {
        return {
          status: "illisible",
          note: "réponse 200 HTML/non-PDF après suivi de lien d'index (en-tête %PDF- absent)",
        };
      }
      const html = Buffer.from(buf).toString("utf8");
      const idx = extractPdfIndexDrift(html, {
        expectedFilename: pin?.filename,
        baseUrl: url,
      });
      if (idx.status !== "ok" || idx.shaDrift) {
        return {
          status: idx.status,
          date: storedDate ?? null,
          shaDrift: Boolean(idx.shaDrift),
          note: idx.note ?? null,
        };
      }
      if (idx.matchedUrl) {
        return await fetchLivePdf(idx.matchedUrl, pin, storedDate, fetchImpl, _depth + 1);
      }
    }
    return checkPdfBuffer(buf, { expectedSha256: pin?.sha256, storedDate });
  } catch (e) {
    return { status: "injoignable", note: e.name === "TimeoutError" ? "délai dépassé" : "réseau" };
  }
}

/** Répartit les contrôles (déjà dotés de status/live/stored) en catégories. */
export function classify(checks) {
  const retard = [],
    anomalie = [],
    sansStockee = [],
    illisible = [],
    injoignable = [];
  for (const c of checks) {
    if (c.status === "injoignable") {
      injoignable.push(c);
      continue;
    }
    if (c.status === "illisible") {
      illisible.push(c);
      continue;
    }
    if (c.shaDrift) {
      retard.push(c);
      continue;
    }
    // status === "ok" : c.live est une date ISO. Comparaison lexicographique valide.
    if (c.stored == null) {
      sansStockee.push(c);
      continue;
    }
    if (c.live > c.stored) retard.push(c);
    else if (c.live < c.stored) anomalie.push(c);
    // c.live === c.stored : à jour, rien à signaler
  }
  return { retard, anomalie, sansStockee, illisible, injoignable };
}

/**
 * Dérive = ce qui est ACTIONNABLE côté corpus (retard, anomalie, date absente, page
 * illisible, loi sans langue). Le blocage réseau massif est un signal SÉPARÉ
 * (unreachableAlert) : une page injoignable est une loi NON VÉRIFIÉE — ni fraîche ni en
 * retard — et l'issue ne doit ni l'annoncer comme un « rafraîchissement dû » (le titre
 * mentait : constaté le 2026-07-23, dérive résolue mais issue tenue ouverte sous ce
 * titre par 33 % de 502), ni la laisser passer pour un corpus vérifié. Les deux drapeaux
 * sortent séparément sur GITHUB_OUTPUT ; le workflow ne clôt que si les DEUX sont éteints.
 */
export function computeDrift({
  retard,
  anomalie,
  sansStockee,
  illisible,
  sansLangue,
  injoignable,
  total,
}) {
  const unreachableRatio = total ? injoignable.length / total : 0;
  const unreachableAlert = unreachableRatio >= UNREACHABLE_ALERT_RATIO;
  const actionable =
    retard.length + anomalie.length + sansStockee.length + illisible.length + sansLangue.length;
  return { drift: actionable > 0, unreachableRatio, unreachableAlert };
}

/** Exécute `worker` sur `items` avec un parallélisme borné (politesse envers LégisQuébec). */
async function pool(items, size, worker) {
  let i = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx]);
    }
  });
  await Promise.all(runners);
}

/** Trois publieurs, trois modes d'extraction. Le seau est porté par le contrôle. */
const EXTRACTEURS = {
  legisquebec: extractConsolidation,
  justice: extractConsolidationFederale,
  pdf: checkPdfBuffer,
};
export const NOM_PUBLIEUR = {
  legisquebec: "LégisQuébec",
  justice: "Justice Canada",
  pdf: "Sources PDF (QCCS/QCCQ/AMF)",
};

/**
 * Répartit les contrôles PAR PUBLIEUR, applique `classify` puis `computeDrift` à CHAQUE
 * seau, et réunit les drapeaux par OU.
 *
 * C'EST LE CŒUR DU CORRECTIF DU 2026-09-14, et c'est pour ça que cette fonction est
 * extraite et exportée plutôt que fondue dans `main()` : l'agrégation n'était gardée par
 * RIEN, alors que c'est elle qui décide si le job mensuel parle ou se tait.
 *
 * `computeDrift` compare `injoignable.length / total` à un seuil de 25 %. Agrégé sur tout
 * le corpus, ce ratio DILUE : un blocage TOTAL du fédéral (36 pages sur 36) pesait
 * 36/194 = 18,6 %, donc sous le seuil, donc le job passait VERT pendant que 18 textes sur
 * 97 n'étaient vérifiés par rien. La dilution joue dans les DEUX sens — un blocage
 * québécois massif noierait de même un signal fédéral propre.
 *
 * Les SIGNATURES de `classify` et de `computeDrift` ne bougent pas : c'est ce qui préserve
 * leurs contrôles. Seul le NOMBRE d'appels change.
 *
 * Un seau VIDE est omis, et non compté comme sain : sans quoi un corpus qui perdrait
 * toutes ses entrées fédérales rendrait `drift = false` en le présentant comme un succès.
 */
export function agregeParSeau(checks, sansLangue = []) {
  const seaux = new Map();
  for (const nom of Object.keys(EXTRACTEURS)) {
    const lot = checks.filter((c) => c.publieur === nom);
    const lotSansLangue = sansLangue.filter((c) => c.publieur === nom);
    if (!lot.length && !lotSansLangue.length) continue;
    const parts = classify(lot);
    const arg = { ...parts, sansLangue: lotSansLangue, total: lot.length };
    seaux.set(nom, { ...arg, ...computeDrift(arg) });
  }
  const vals = [...seaux.values()];
  return {
    seaux,
    drift: vals.some((s) => s.drift),
    unreachableAlert: vals.some((s) => s.unreachableAlert),
    // Quel publieur a bloqué. Sans cette sortie, le titre d'issue nomme LégisQuébec en dur
    // et MENTIRAIT dès qu'un blocage viendrait de Justice Canada — le dépôt a déjà corrigé
    // exactement ce défaut le 2026-07-23 (« le titre mentait »).
    bloquees: [...seaux.entries()]
      .filter(([, s]) => s.unreachableAlert)
      .map(([nom]) => NOM_PUBLIEUR[nom]),
  };
}

async function main() {
  const config = JSON.parse(readFileSync(join(ROOT, "laws.config.json"), "utf8"));

  // Le corpus a DEUX publieurs, et la configuration DIT lequel : `consolidation_source`
  // pour LégisQuébec (EPUB), `official_source` pour Justice Canada (XML). Deviner le
  // publieur d'après l'URL serait deviner ce qui est déjà déclaré.
  //
  // Défaut mesuré le 2026-09-14 : seule `consolidation_source` était lue, donc les 36
  // contrôles fédéraux n'avaient AUCUNE URL, tombaient en `injoignable`, et — exclus
  // d'`actionable` et noyés sous le seuil global de 25 % (36/194 = 18,6 %) — laissaient le
  // job MENSUEL passer VERT pendant que 18 textes sur 97 n'étaient surveillés par rien.
  const sources = new Map(
    config.laws.map((l) => [
      l.id,
      l.source === "pdf"
        ? { urls: l.consolidation_source || {}, publieur: "pdf" }
        : l.consolidation_source
          ? { urls: l.consolidation_source, publieur: "legisquebec" }
          : { urls: l.official_source || {}, publieur: "justice" },
    ]),
  );
  const pdfPins = loadPdfProfilePins(ROOT);

  // 1) Dates stockées, via l'endpoint MCP public (une seule session).
  const mcp = createMcpClient(MCP_URL);
  await mcp.connect();
  const res = await mcp.callTool("list_laws", {});
  const laws = res?.structuredContent?.laws;
  if (!Array.isArray(laws) || laws.length === 0) {
    throw new Error(`list_laws n'a renvoyé aucune loi (endpoint ${MCP_URL} injoignable ?)`);
  }

  // 2) Un contrôle par (loi, langue). Une loi sans langue déclarée (langs vide -> ligne
  // laws sans article, cf. invariant n° 1) serait sinon SILENCIEUSEMENT sautée : on la
  // range dans une catégorie actionnable au lieu de la perdre.
  const checks = [];
  const sansLangue = [];
  for (const law of laws) {
    const src = sources.get(law.id) || { urls: {}, publieur: "legisquebec" };
    const langs = Array.isArray(law.langs) ? law.langs : [];
    if (langs.length === 0) {
      sansLangue.push({
        id: law.id,
        name: law.name_fr || law.name_en || law.id,
        publieur: src.publieur,
      });
      continue;
    }
    for (const lang of langs) {
      checks.push({
        id: law.id,
        name: law.name_fr || law.name_en || law.id,
        lang,
        stored: law[`consol_date_${lang}`] ?? null,
        url: src.urls[lang] ?? null,
        // `publieur` TRAVERSE `classify` sans qu'elle le lise : sa signature ne bouge pas,
        // donc ses contrôles restent intacts. C'est l'appelant qui répartit.
        publieur: src.publieur,
      });
    }
  }
  // Garde : un détecteur qui n'a construit AUCUN contrôle ne doit pas rapporter « vert ».
  if (checks.length === 0 && sansLangue.length === 0) {
    throw new Error("aucun couple (loi, langue) construit — forme de list_laws inattendue ?");
  }

  // 3) Date live (ou empreinte SHA-256 PDF) pour chaque contrôle, avec l'extracteur de SON publieur.
  await pool(checks, CONCURRENCY, async (c) => {
    const res =
      c.publieur === "pdf"
        ? await fetchLivePdf(c.url, pdfPins.get(c.id)?.[c.lang], c.stored)
        : await fetchLiveDate(c.url, EXTRACTEURS[c.publieur]);
    c.status = res.status;
    c.live = res.date ?? null;
    c.note = res.note ?? null;
    if (res.shaDrift) c.shaDrift = true;
  });

  // 4) Classement et dérive, PAR SEAU DE PUBLIEUR — cf. `agregeParSeau`, qui porte le
  //    raisonnement et que `scripts/check-consolidation.test.mjs` verrouille.
  const { seaux, drift, unreachableAlert, bloquees } = agregeParSeau(checks, sansLangue);

  // Totaux, pour le rapport et le journal : union des seaux, jamais recalculés à part.
  const cat = (cle) => [...seaux.values()].flatMap((s) => s[cle]);
  const retard = cat("retard"),
    anomalie = cat("anomalie"),
    sansStockee = cat("sansStockee");
  const illisible = cat("illisible"),
    injoignable = cat("injoignable");
  const total = checks.length;
  const unreachableRatio = total ? injoignable.length / total : 0;

  // 5) Rapport.
  const report = buildReport({
    total,
    laws: laws.length,
    retard,
    anomalie,
    sansStockee,
    illisible,
    sansLangue,
    injoignable,
    unreachableRatio,
    unreachableAlert,
    seaux,
  });
  writeFileSync(join(ROOT, "consolidation-report.md"), report, "utf8");

  console.log(`Vérifié : ${laws.length} lois, ${total} couples (loi, langue).`);
  console.log(`  en retard          : ${retard.length}`);
  console.log(`  anomalies          : ${anomalie.length}`);
  console.log(`  sans date stockée  : ${sansStockee.length}`);
  console.log(`  page illisible     : ${illisible.length}`);
  console.log(`  loi sans langue    : ${sansLangue.length}`);
  console.log(
    `  injoignables réseau: ${injoignable.length} (${(unreachableRatio * 100).toFixed(0)} %)`,
  );
  for (const [nom, s] of seaux) {
    console.log(
      `  — ${NOM_PUBLIEUR[nom]} : ${s.total} couples, ` +
        `${s.injoignable.length} injoignables (${(s.unreachableRatio * 100).toFixed(0)} %), ` +
        `dérive ${s.drift ? "OUI" : "non"}, alerte réseau ${s.unreachableAlert ? "OUI" : "non"}`,
    );
  }
  console.log(`  => dérive corpus   : ${drift ? "OUI" : "non"}`);
  console.log(
    `  => alerte réseau   : ${unreachableAlert ? "OUI" : "non"}` +
      (bloquees.length ? ` (${bloquees.join(" et ")})` : ""),
  );
  for (const c of retard)
    console.log(`    RETARD ${c.id}/${c.lang} : D1 ${c.stored} < live ${c.live}`);
  for (const c of illisible) console.log(`    ILLISIBLE ${c.id}/${c.lang} : ${c.note}`);

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `drift=${drift}\nunreachable=${unreachableAlert}\n` +
        `sources_bloquees=${bloquees.join(" et ")}\n`,
    );
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
  }
}

function buildReport(d) {
  const {
    total,
    laws,
    retard,
    anomalie,
    sansStockee,
    illisible,
    sansLangue,
    injoignable,
    unreachableRatio,
    unreachableAlert,
    seaux,
  } = d;
  const stamp = `${new Date().toISOString().replace("T", " ").slice(0, 16)} UTC`;
  const pub = (c) => NOM_PUBLIEUR[c.publieur] ?? "?";
  const rows = (list) =>
    list
      .map(
        (c) =>
          `| ${c.id} | ${c.lang} | ${pub(c)} | ${c.stored ?? "—"} | ${c.live ?? "—"} | ${(c.name || "").replace(/\|/g, "/")} |`,
      )
      .join("\n");
  const dateTable = (title, list) =>
    list.length
      ? `\n### ${title}\n\n| Loi | Langue | Publieur | D1 (chargé) | Source (live) | Titre |\n|---|---|---|---|---|---|\n${rows(list)}\n`
      : "";

  let md = `# Veille de consolidation — ${stamp}\n\n`;
  md += `Détecteur **en lecture seule** : ${laws} lois, ${total} couples (loi, langue) comparés `;
  md += `entre les dates chargées en D1 (via \`list_laws\`) et les sources officielles `;
  md += `— LégisQuébec pour le Québec, Justice Canada pour le fédéral et les sources PDF `;
  md += `(QCCS, QCCQ, AMF).\n\n`;

  // Ventilation par publieur. Le seuil de joignabilité s'applique PAR SEAU : agrégé, un
  // blocage total d'un des deux se diluerait sous les 25 % et le job passerait vert.
  if (seaux && seaux.size > 1) {
    md += `| Publieur | Couples | Retard | Injoignables | Dérive | Alerte réseau |\n`;
    md += `|---|---|---|---|---|---|\n`;
    for (const [nom, s] of seaux) {
      md += `| ${NOM_PUBLIEUR[nom]} | ${s.total} | ${s.retard.length} | `;
      md += `${s.injoignable.length} (${(s.unreachableRatio * 100).toFixed(0)} %) | `;
      md += `${s.drift ? "**OUI**" : "non"} | ${s.unreachableAlert ? "**OUI**" : "non"} |\n`;
    }
    md += `\n`;
  }
  md += `- en retard (rafraîchissement dû) : **${retard.length}**\n`;
  md += `- en avance / anomalie : **${anomalie.length}**\n`;
  md += `- sans date stockée : **${sansStockee.length}**\n`;
  md += `- pages atteintes mais date illisible : **${illisible.length}**\n`;
  md += `- lois sans langue déclarée : **${sansLangue.length}**\n`;
  md += `- injoignables réseau : **${injoignable.length}** (${(unreachableRatio * 100).toFixed(0)} %)\n`;

  md += dateTable("Rafraîchissement dû — D1 en retard sur la source officielle", retard);
  md += dateTable("Anomalie — D1 EN AVANCE sur la source officielle (à investiguer)", anomalie);
  md += dateTable("Date de consolidation absente en D1", sansStockee);

  if (illisible.length) {
    md += `\n### Pages atteintes mais date « À jour au » introuvable\n\n`;
    md += `> ⚠️ Ces pages répondent (HTTP 200) mais le parseur n'y trouve pas la date. `;
    md += `Cause probable : le publieur a changé le libellé ou le format de la bannière — le `;
    md += `miroir correspondant est à mettre à jour, DANS SES DEUX MOITIÉS `;
    md += `(\`extractConsolidation\` ↔ \`fetch_consolidation\` pour LégisQuébec ; `;
    md += `\`extractConsolidationFederale\` ↔ \`extrait_consolidation_federale\` pour Justice `;
    md += `Canada ; \`checkPdfBuffer\` / \`extractPdfIndexDrift\` pour les sources PDF). Ce n'est PAS un problème réseau.\n\n`;
    md += `| Loi | Langue | Publieur | Détail |\n|---|---|---|---|\n`;
    md +=
      illisible.map((c) => `| ${c.id} | ${c.lang} | ${pub(c)} | ${c.note ?? "?"} |`).join("\n") +
      "\n";
  }

  if (sansLangue.length) {
    md += `\n### Lois sans langue déclarée en D1\n\n`;
    md += `> ⚠️ Aucune langue servie par \`list_laws\` : ligne \`laws\` sans article ? `;
    md += `(ingestion incomplète). À vérifier.\n\n`;
    md += `| Loi | Titre |\n|---|---|\n`;
    md +=
      sansLangue.map((c) => `| ${c.id} | ${(c.name || "").replace(/\|/g, "/")} |`).join("\n") +
      "\n";
  }

  if (injoignable.length) {
    md += `\n### Pages injoignables (réseau)\n\n`;
    if (unreachableAlert) {
      const bloquees = [...(seaux ?? new Map()).entries()]
        .filter(([, s]) => s.unreachableAlert)
        .map(([nom, s]) => `**${NOM_PUBLIEUR[nom]}** (${(s.unreachableRatio * 100).toFixed(0)} %)`);
      md += `> ⚠️ Le seuil de joignabilité est franchi chez ${bloquees.join(" et ") || "un publieur"}. `;
      md += `Il s'applique PAR PUBLIEUR : agrégé sur tout le corpus, un blocage total de l'un `;
      md += `des deux se diluerait sous les 25 % et ce rapport passerait vert. `;
      md += `Un blocage massif (WAF, filtrage des IP de centre de données) est possible — il `;
      md += `conditionnerait aussi toute ingestion automatisée. À vérifier hors CI.\n\n`;
    }
    md += `| Loi | Langue | Publieur | Motif |\n|---|---|---|---|\n`;
    md +=
      injoignable.map((c) => `| ${c.id} | ${c.lang} | ${pub(c)} | ${c.note ?? "?"} |`).join("\n") +
      "\n";
  }

  md += `\n---\n`;
  md += `Pour rafraîchir : exécuter le flux **\`rafraichir-corpus\`** (\`mode=preparer\` puis `;
  md += `\`mode=appliquer\` après revue du diff) ou suivre la procédure \`pipeline.refresh\` `;
  md += `de \`CLAUDE.md\` (staging→bascule incrémentale, découverte, backfill incrémental des `;
  md += `vecteurs, porte \`eval:gate\`). Ce job ne fait que détecter ; il n'écrit jamais en base.\n`;
  return md;
}

// N'exécute main() que si le script est lancé directement (pas à l'import par les tests).
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => {
    console.error("Échec du détecteur :", e.message);
    process.exit(1);
  });
}
