import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("la base de test porte le schéma de production", () => {
  const db = () => (env as unknown as { DB: D1Database }).DB;

  const tables = async (): Promise<string[]> => {
    const { results } = await db()
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name")
      .all<{ name: string }>();
    return results.map((r) => r.name);
  };

  it("porte les tables de l'état initial", async () => {
    const t = await tables();
    for (const n of ["laws", "divisions", "articles"]) expect(t, n).toContain(n);
  });

  it("porte la couche de DÉCOUVERTE, que le bootstrap de la CI n'applique pas", async () => {
    const t = await tables();
    for (const n of ["subjects", "subject_map", "law_relations"]) expect(t, n).toContain(n);
  });

  it("porte ce que les migrations ajoutent", async () => {
    const t = await tables();
    for (const n of ["search_log", "division_links", "concept_gazetteer", "article_headnotes"])
      expect(t, n).toContain(n);
    expect(t).toContain("article_numbers");
    expect(t).toContain("vector_state");
    expect(t).toContain("refresh_state");
  });

  it("porte les index de clés étrangères de la migration 0006", async () => {
    const { results } = await db()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
      .all<{ name: string }>();
    const indexes = results.map((r) => r.name);
    expect(indexes).toContain("idx_art_division_id");
    expect(indexes).toContain("idx_art_num_article_id");
  });

  it("la migration 0004 a bien renommé rlrq_cite en official_cite", async () => {
    const { results } = await db()
      .prepare("SELECT name FROM pragma_table_info('laws')")
      .all<{ name: string }>();
    const cols = results.map((r) => r.name);
    expect(cols).toContain("official_cite");
    expect(cols).not.toContain("rlrq_cite");
  });

  it("articles_fts a `text` en position 0 — un snippet() y est codé en dur", async () => {
    const { results } = await db()
      .prepare("SELECT name, cid FROM pragma_table_info('articles_fts')")
      .all<{ name: string; cid: number }>();
    expect(results.find((r) => r.cid === 0)?.name).toBe("text");
    expect(results.map((r) => r.name)).not.toContain("links");
  });

  it("la migration 0007 ajoute laws.source (défaut 'epub') et articles.links sans reconstruire FTS", async () => {
    const lawCols = (
      await db()
        .prepare("SELECT name, dflt_value FROM pragma_table_info('laws')")
        .all<{ name: string; dflt_value: string | null }>()
    ).results;
    const sourceCol = lawCols.find((c) => c.name === "source");
    expect(sourceCol).toBeDefined();
    expect(sourceCol?.dflt_value).toBe("'epub'");

    const artCols = (
      await db().prepare("SELECT name FROM pragma_table_info('articles')").all<{ name: string }>()
    ).results;
    expect(artCols.map((c) => c.name)).toContain("links");
  });

  it("une écriture puis une lecture fonctionnent — la base est UTILISABLE", async () => {
    await db()
      .prepare("INSERT INTO laws (id, name_fr, name_en, official_cite) VALUES (?,?,?,?)")
      .bind("essai", "Loi d'essai", "Test Act", "RLRQ, c. E-1")
      .run();
    const l = await db()
      .prepare("SELECT name_fr, source FROM laws WHERE id = ?")
      .bind("essai")
      .first<{ name_fr: string; source: string }>();
    expect(l?.name_fr).toBe("Loi d'essai");
    expect(l?.source).toBe("epub");
  });

  it("chaque fichier de test repart d'une base NEUVE", async () => {
    const n = await db().prepare("SELECT COUNT(*) AS n FROM divisions").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });
});
