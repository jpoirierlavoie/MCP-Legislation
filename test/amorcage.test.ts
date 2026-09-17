import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Éprouve l'AMORÇAGE, non le domaine : que la base de test porte bien le schéma de
// production. Jusqu'au 2026-09-17 elle était vide, et tout ce qui touchait D1 échouait sur
// « no such table: laws » — donc rien de ce qui lit la base n'était éprouvable ici.
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
    expect(t).toContain("article_numbers"); // migration 0004
  });

  it("la migration 0004 a bien renommé rlrq_cite en official_cite", async () => {
    // L'assertion NÉGATIVE est celle qui compte, dit la CI : un schema.sql déclarant déjà
    // `official_cite` ferait passer un bootstrap naïf sans que la migration ait joué.
    const { results } = await db()
      .prepare("SELECT name FROM pragma_table_info('laws')")
      .all<{ name: string }>();
    const cols = results.map((r) => r.name);
    expect(cols).toContain("official_cite");
    expect(cols).not.toContain("rlrq_cite");
  });

  it("articles_fts a `text` en position 0 — un snippet() y est codé en dur", async () => {
    // `src/lib.ts` appelle `snippet(articles_fts, 0, …)` : une inversion servirait une note
    // marginale comme s'il s'agissait du texte officiel.
    const { results } = await db()
      .prepare("SELECT name, cid FROM pragma_table_info('articles_fts')")
      .all<{ name: string; cid: number }>();
    expect(results.find((r) => r.cid === 0)?.name).toBe("text");
  });

  it("une écriture puis une lecture fonctionnent — la base est UTILISABLE", async () => {
    await db()
      .prepare("INSERT INTO laws (id, name_fr, name_en, official_cite) VALUES (?,?,?,?)")
      .bind("essai", "Loi d'essai", "Test Act", "RLRQ, c. E-1")
      .run();
    const l = await db()
      .prepare("SELECT name_fr FROM laws WHERE id = ?")
      .bind("essai")
      .first<{ name_fr: string }>();
    expect(l?.name_fr).toBe("Loi d'essai");
  });

  it("chaque fichier de test repart d'une base NEUVE", async () => {
    // Le setup s'exécute par fichier : la ligne écrite par le test précédent ne doit pas
    // fuir ici. Sans cela, l'ordre des tests deviendrait significatif.
    const n = await db().prepare("SELECT COUNT(*) AS n FROM divisions").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });
});
