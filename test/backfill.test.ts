import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { handleBackfill } from "../src/backfill";

function db() {
  return (env as unknown as { DB: D1Database }).DB;
}

function makeMocks() {
  const embeddedTexts: string[][] = [];
  const upserted: { id: string; values: number[]; metadata?: Record<string, unknown> }[] = [];
  const deleted: string[] = [];

  const AI = {
    async run(_model: string, input: { text: string[] }) {
      embeddedTexts.push([...input.text]);
      return {
        data: input.text.map((_, idx) => [0.1 * (idx + 1), 0.2, 0.3, 0.4]),
      };
    },
  } as unknown as Ai;

  const VECTORS = {
    async upsert(vectors: { id: string; values: number[]; metadata?: Record<string, unknown> }[]) {
      upserted.push(...vectors);
      return { ids: vectors.map((v) => v.id), count: vectors.length };
    },
    async deleteByIds(ids: string[]) {
      deleted.push(...ids);
      return { ids, count: ids.length };
    },
  } as unknown as VectorizeIndex;

  return { AI, VECTORS, embeddedTexts, upserted, deleted };
}

async function seedTestLaw() {
  const d = db();
  await d
    .prepare(
      "INSERT INTO laws (id, name_fr, name_en, official_cite, jurisdiction) VALUES (?, ?, ?, ?, ?)",
    )
    .bind("loi-test", "Loi d'essai", "Test Act", "RLRQ, c. L-1", "qc")
    .run();
  await d
    .prepare(
      "INSERT INTO divisions (id, law_id, lang, kind, number, heading, path, repealed, parent_id, sort_order) VALUES (?, ?, 'fr', 'chapitre', 'I', ?, ?, 0, NULL, 1)",
    )
    .bind(101, "loi-test", "CHAPITRE UN", "ga:l_i")
    .run();
  await d
    .prepare(
      "INSERT INTO articles (id, law_id, lang, number, sort_key, division_id, division_path, text, repealed) VALUES (?, ?, 'fr', ?, ?, ?, ?, ?, 0)",
    )
    .bind(1001, "loi-test", "1", 1_000_000_000_000, 101, "ga:l_i", "Premier article.")
    .run();
  await d
    .prepare(
      "INSERT INTO articles (id, law_id, lang, number, sort_key, division_id, division_path, text, repealed) VALUES (?, ?, 'fr', ?, ?, ?, ?, ?, 0)",
    )
    .bind(1002, "loi-test", "2", 2_000_000_000_000, 101, "ga:l_i", "Deuxième article.")
    .run();
}

function post(
  testEnv: Env,
  body: unknown,
  { auth = "Bearer jeton-admin", method = "POST" }: { auth?: string | null; method?: string } = {},
) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (auth !== null) headers.Authorization = auth;
  return handleBackfill(
    new Request("https://legislation.test/admin/backfill-vectors", {
      method,
      headers,
      body: method === "POST" ? JSON.stringify(body) : undefined,
    }),
    testEnv,
  );
}

describe("/admin/backfill-vectors", () => {
  beforeEach(async () => {
    const d = db();
    await d.prepare("DELETE FROM vector_state").run();
    await d.prepare("DELETE FROM article_numbers").run();
    await d.prepare("DELETE FROM articles").run();
    await d.prepare("DELETE FROM divisions").run();
    await d.prepare("DELETE FROM laws").run();
    await seedTestLaw();
  });

  it("refuse sans secret (404), mauvais jeton (401) et méthode non-POST (405)", async () => {
    const mocks = makeMocks();
    const sansSecret = { ...env, AI: mocks.AI, VECTORS: mocks.VECTORS } as unknown as Env;
    expect((await post(sansSecret, { kind: "articles", law: "loi-test" })).status).toBe(404);

    const avecSecret = {
      ...env,
      BACKFILL_TOKEN: "jeton-admin",
      AI: mocks.AI,
      VECTORS: mocks.VECTORS,
    } as unknown as Env;
    expect(
      (await post(avecSecret, { kind: "articles", law: "loi-test" }, { auth: "Bearer faux" }))
        .status,
    ).toBe(401);
    expect(
      (await post(avecSecret, { kind: "articles", law: "loi-test" }, { method: "GET" })).status,
    ).toBe(405);
  });

  it("mode 'ping' vérifie les liaisons AI/VECTORS et compte vector_state", async () => {
    const sansLiaisons = { ...env, BACKFILL_TOKEN: "jeton-admin" } as unknown as Env;
    const r503 = await post(sansLiaisons, { kind: "articles", law: "loi-test", mode: "ping" });
    expect(r503.status).toBe(503);

    const mocks = makeMocks();
    const testEnv = {
      ...env,
      BACKFILL_TOKEN: "jeton-admin",
      AI: mocks.AI,
      VECTORS: mocks.VECTORS,
    } as unknown as Env;
    const r200 = await post(testEnv, { kind: "articles", law: "loi-test", mode: "ping" });
    expect(r200.status).toBe(200);
    expect(await r200.json()).toEqual({
      ok: true,
      mode: "ping",
      kind: "articles",
      law: "loi-test",
      exists: true,
      tracked: 0,
    });
  });

  it("mode 'seed' amorce vector_state sans appeler AI/VECTORS, puis 'incremental' ré-embedde uniquement les écarts", async () => {
    const mocks = makeMocks();
    const testEnv = {
      ...env,
      BACKFILL_TOKEN: "jeton-admin",
      AI: mocks.AI,
      VECTORS: mocks.VECTORS,
    } as unknown as Env;

    // 1. Seed initial (0 appel AI/VECTORS)
    const rSeed = await post(testEnv, { kind: "articles", law: "loi-test", mode: "seed" });
    expect(rSeed.status).toBe(200);
    const jSeed = (await rSeed.json()) as Record<string, unknown>;
    expect(jSeed).toMatchObject({ mode: "seed", scanned: 2, seeded: 2, embedded: 0, done: true });
    expect(mocks.embeddedTexts.length).toBe(0);
    expect(mocks.upserted.length).toBe(0);

    // 2. Incremental sans changement -> 0 embedding
    const rInc0 = await post(testEnv, { kind: "articles", law: "loi-test", mode: "incremental" });
    expect(rInc0.status).toBe(200);
    expect(await rInc0.json()).toMatchObject({
      mode: "incremental",
      scanned: 2,
      embedded: 0,
      skipped: 2,
      done: true,
    });
    expect(mocks.upserted.length).toBe(0);

    // 3. Modification d'un seul article -> 1 seul embedding
    await db()
      .prepare("UPDATE articles SET text = ? WHERE id = 1002")
      .bind("Deuxième article modifié.")
      .run();
    const rInc1 = await post(testEnv, { kind: "articles", law: "loi-test", mode: "incremental" });
    expect(await rInc1.json()).toMatchObject({
      mode: "incremental",
      scanned: 2,
      embedded: 1,
      skipped: 1,
      done: true,
    });
    expect(mocks.upserted.map((v) => v.id)).toEqual(["art:loi-test:2"]);

    // 4. Modification d'un intitulé de division -> fil d'Ariane change donc tous ses articles sont ré-embeddés
    await db().prepare("UPDATE divisions SET heading = ? WHERE id = 101").bind("TITRE NEUF").run();
    const rInc2 = await post(testEnv, { kind: "articles", law: "loi-test", mode: "incremental" });
    expect(await rInc2.json()).toMatchObject({
      mode: "incremental",
      scanned: 2,
      embedded: 2,
      skipped: 0,
      done: true,
    });
    // 5. Deuxième passage immédiat -> 0 embedding
    const rInc3 = await post(testEnv, { kind: "articles", law: "loi-test", mode: "incremental" });
    expect(await rInc3.json()).toMatchObject({
      mode: "incremental",
      scanned: 2,
      embedded: 0,
      skipped: 2,
      done: true,
    });
  });

  it("mode 'prune' supprime de Vectorize et vector_state les articles et divisions orphelins", async () => {
    const mocks = makeMocks();
    const testEnv = {
      ...env,
      BACKFILL_TOKEN: "jeton-admin",
      AI: mocks.AI,
      VECTORS: mocks.VECTORS,
    } as unknown as Env;

    // Indexation complète initiale (articles + divisions)
    const rArt = await post(testEnv, { kind: "articles", law: "loi-test" });
    expect(await rArt.json()).toMatchObject({ mode: "full", embedded: 2, done: true });
    const rDiv = await post(testEnv, { kind: "divisions", law: "loi-test" });
    expect(await rDiv.json()).toMatchObject({ mode: "full", embedded: 1, done: true });

    const initialDivVecId = mocks.upserted.find((v) => v.id.startsWith("div:"))!.id;
    const artVec = mocks.upserted.find((v) => v.id === "art:loi-test:1")!;
    const divVec = mocks.upserted.find((v) => v.id === initialDivVecId)!;
    expect(artVec.metadata).toMatchObject({ domain: "core", jurisdiction: "qc" });
    expect(divVec.metadata).toMatchObject({ domain: "core", jurisdiction: "qc" });

    // Suppression de l'art. 2 et remplacement de ga:l_i par ga:l_i__2
    await db().prepare("DELETE FROM articles WHERE id = 1002").run();
    await db().prepare("UPDATE divisions SET path = 'ga:l_i__2' WHERE id = 101").run();
    await db().prepare("UPDATE articles SET division_path = 'ga:l_i__2' WHERE id = 1001").run();

    const rPruneArt = await post(testEnv, { kind: "articles", law: "loi-test", mode: "prune" });
    expect(await rPruneArt.json()).toMatchObject({
      mode: "prune",
      deleted: 1,
      deleted_ids: ["art:loi-test:2"],
      done: true,
    });

    const rPruneDiv = await post(testEnv, { kind: "divisions", law: "loi-test", mode: "prune" });
    expect(await rPruneDiv.json()).toMatchObject({
      mode: "prune",
      deleted: 1,
      deleted_ids: [initialDivVecId],
      done: true,
    });
    expect(mocks.deleted).toEqual(["art:loi-test:2", initialDivVecId]);

    const trackedDivs = await db()
      .prepare(
        "SELECT COUNT(*) AS n FROM vector_state WHERE law_id = 'loi-test' AND kind = 'divisions'",
      )
      .first<{ n: number }>();
    expect(trackedDivs?.n).toBe(0);
  });

  it("inclut marginal_note fédérale dans le texte d'embedding et les métadonnées domain/jurisdiction", async () => {
    const d = db();
    await d
      .prepare(
        "INSERT INTO laws (id, name_fr, name_en, official_cite, jurisdiction, domain) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(
        "ca-test",
        "Loi fédérale test",
        "Federal Test Act",
        "L.R.C. (1985), c. F-7",
        "ca",
        "cours-federales",
      )
      .run();
    await d
      .prepare(
        "INSERT INTO articles (id, law_id, lang, number, sort_key, division_path, marginal_note, text, repealed) VALUES (?, ?, 'fr', ?, ?, '', ?, ?, 0)",
      )
      .bind(
        2001,
        "ca-test",
        "18",
        18_000_000_000_000,
        "Compétence exclusive de la Cour fédérale",
        "La Cour fédérale a compétence exclusive en première instance.",
      )
      .run();

    const mocks = makeMocks();
    const testEnv = {
      ...env,
      BACKFILL_TOKEN: "jeton-admin",
      AI: mocks.AI,
      VECTORS: mocks.VECTORS,
    } as unknown as Env;

    const r = await post(testEnv, { kind: "articles", law: "ca-test" });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ mode: "full", embedded: 1, done: true });
    expect(mocks.embeddedTexts[0][0]).toContain("Compétence exclusive de la Cour fédérale");
    expect(mocks.upserted[0].metadata).toMatchObject({
      law: "ca-test",
      domain: "cours-federales",
      jurisdiction: "ca",
    });
  });

  it("hache les identifiants d'articles dépassant 64 octets UTF-8 (full, incremental et prune)", async () => {
    const longNum = "annexe-procédure-particulière-avec-accents-très-longue-depassant-64";
    await db()
      .prepare(
        "INSERT INTO articles (id, law_id, lang, number, sort_key, division_id, division_path, text, repealed) VALUES (?, ?, 'fr', ?, ?, ?, ?, ?, 0)",
      )
      .bind(1003, "loi-test", longNum, 9_000_000_000_000_001, 101, "ga:l_i", "Annexe longue.")
      .run();

    const mocks = makeMocks();
    const testEnv = {
      ...env,
      BACKFILL_TOKEN: "jeton-admin",
      AI: mocks.AI,
      VECTORS: mocks.VECTORS,
    } as unknown as Env;

    const rFull = await post(testEnv, { kind: "articles", law: "loi-test", mode: "full" });
    expect(rFull.status).toBe(200);
    expect(await rFull.json()).toMatchObject({ mode: "full", embedded: 3, done: true });

    const longVec = mocks.upserted.find((v) => v.metadata?.article === longNum);
    expect(longVec).toBeDefined();
    expect(new TextEncoder().encode(longVec!.id).byteLength).toBeLessThanOrEqual(64);
    expect(longVec!.id).toMatch(/^art:loi-test:[0-9a-f]{24}$/);

    // Deuxième passage en incremental -> 0 ré-embedding (hash d'id stable dans vector_state)
    const rInc = await post(testEnv, { kind: "articles", law: "loi-test", mode: "incremental" });
    expect(await rInc.json()).toMatchObject({ mode: "incremental", embedded: 0, skipped: 3 });

    // Suppression de l'article long -> prune supprime exactement le même id haché
    await db().prepare("DELETE FROM articles WHERE id = 1003").run();
    const rPrune = await post(testEnv, { kind: "articles", law: "loi-test", mode: "prune" });
    expect(await rPrune.json()).toMatchObject({
      mode: "prune",
      deleted: 1,
      deleted_ids: [longVec!.id],
      done: true,
    });
    expect(mocks.deleted).toEqual([longVec!.id]);
  });
});
