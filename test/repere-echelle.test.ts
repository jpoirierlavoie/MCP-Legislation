import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { ftsTokens, paginate, searchText, toFtsQuery } from "../src/lib";
import { RELAX_MIN_LOO_TOTAL } from "../src/relevance";
import { construireOutils } from "../src/tools";

const db = () => (env as unknown as { DB: D1Database }).DB;

const registre = () =>
  construireOutils({
    DB: db(),
    RELAX_SEARCH: "1",
    HYBRID_SEARCH: "0",
    FEDERAL_CORPUS: "1",
  } as unknown as Parameters<typeof construireOutils>[0]);

const LOIS: [string, string, string][] = [
  ["essai-a", "Texte d'essai A", "Test Text A"],
  ["essai-b", "Texte d'essai B", "Test Text B"],
];

const ARTICLES: [number, string, string, string][] = [
  [1, "essai-a", "1", "Le vendeur doit garantir la chose vendue contre les vices cachés."],
  [2, "essai-a", "2", "Un vice caché engage la garantie du vendeur."],
  [3, "essai-b", "3", "La qualité de la chose est présumée conforme."],
  [4, "essai-a", "4", "La résiliation du bail suit le défaut de paiement du loyer."],
  [5, "essai-a", "5", "La résiliation du bail exige un avis écrit; le loyer reste dû."],
  [6, "essai-b", "6", "Le loyer est payable le premier jour du mois, sauf résiliation du bail."],
  [7, "essai-a", "8", "La servitude de passage vise le fonds en enclave."],
  [8, "essai-b", "9", "Le propriétaire en enclave obtient une servitude de passage."],
  [9, "essai-b", "7", "Le locateur remet le bien en bon état d'usage."],
];

const Q_MAIGRE = "garantie vice caché qualité";
const Q_FOURNIE = "loyer bail résiliation introuvable";
const Q_FRONTIERE = "servitude passage enclave inexistante";

async function amorcerCorpus(): Promise<void> {
  const d = db();
  for (const [id, fr, en] of LOIS) {
    await d
      .prepare("INSERT INTO laws (id, name_fr, name_en, official_cite) VALUES (?,?,?,?)")
      .bind(id, fr, en, `ESSAI, c. ${id}`)
      .run();
    await d
      .prepare(
        "INSERT INTO divisions (id, law_id, lang, kind, number, heading, path, sort_order) " +
          "VALUES (?,?,?,?,?,?,?,?)",
      )
      .bind(id === "essai-a" ? 1 : 2, id, "fr", "chapitre", "I", "DISPOSITIONS", "ga:l_i", 0)
      .run();
  }
  for (const [id, lawId, number, texte] of ARTICLES) {
    await d
      .prepare(
        "INSERT INTO articles (id, law_id, lang, number, sort_key, division_path, text) " +
          "VALUES (?,?,?,?,?,?,?)",
      )
      .bind(id, lawId, "fr", number, id * 1000, "ga:l_i", texte)
      .run();
  }
  await d.prepare("INSERT INTO articles_fts(articles_fts) VALUES('rebuild')").run();
}

beforeAll(amorcerCorpus);

const chercher = (query: string, limite = 5) =>
  searchText(db(), query, "fr", undefined, paginate(limite, 0), { relax: true });

describe("toFtsQuery — l'expression réellement envoyée à SQLite", () => {
  it("combine les termes en ET IMPLICITE, chacun en littéral quoté", () => {
    expect(toFtsQuery(Q_MAIGRE)).toBe('"garantie" "vice" "caché" "qualité"');
  });

  it("ne produit JAMAIS de troncature de préfixe", () => {
    expect(toFtsQuery("garantie")).not.toContain("*");
  });

  it("neutralise les opérateurs qu'un usager pourrait taper", () => {
    expect(toFtsQuery("vice OR caché")).toBe('"vice" "OR" "caché"');
    expect(toFtsQuery("(vice*)")).toBe('"vice"');
    expect(toFtsQuery("   ")).toBe("");
  });

  it("garde les composés d'un seul tenant — donc en PHRASE exigeant l'adjacence", () => {
    expect(ftsTokens("clause non-concurrence art. 2926.1")).toEqual([
      "clause",
      "non-concurrence",
      "art.",
      "2926.1",
    ]);
    expect(toFtsQuery("non-concurrence")).toBe('"non-concurrence"');
  });
});

describe("l'échelle de recherche, barreau par barreau", () => {
  it("le plancher vaut deux — à un, cette garde ne prouve plus rien", () => {
    expect(RELAX_MIN_LOO_TOTAL).toBe(2);
  });

  it("DEUX résultats suffisent à garder la main — c'est la frontière calibrée", async () => {
    const r = await chercher(Q_FRONTIERE);
    expect(r.fallback).toEqual({ loo: "inexistante" });
    expect(r.total).toBe(2);
  });

  it("le ET exact ne franchit pas la flexion française", async () => {
    const r = await searchText(db(), Q_MAIGRE, "fr", "essai-a", paginate(5, 0), {});
    expect(r.fallback, "l'échelle a tourné alors que relax était coupé").toBeNull();
    expect(r.total).toBe(0);
  });

  it("un leave-one-out MAIGRE laisse l'échelle descendre jusqu'au OU", async () => {
    const r = await chercher(Q_MAIGRE);
    expect(r.fallback, "l'échelle s'est encore arrêtée au leave-one-out").toBe("or_relax");
    expect(r.total).toBe(2);
    expect(r.hits.map((h) => h.number).sort()).toEqual(["2", "3"]);
  });

  it("un leave-one-out FOURNI garde la main, et nomme le terme RETIRÉ", async () => {
    const r = await chercher(Q_FOURNIE);
    expect(r.fallback).toEqual({ loo: "introuvable" });
    expect(r.total).toBe(3);
  });

  it("l'étiquette `loo` nomme le terme OMIS, jamais un terme conservé", async () => {
    const r = await chercher(Q_FOURNIE);
    const omis = (r.fallback as { loo: string }).loo;
    expect(omis).toBe("introuvable");
    expect(ftsTokens(Q_FOURNIE)).toContain(omis);
  });

  it("une liste d'un seul résultat SUFFIT si elle remplit la page demandée", async () => {
    const r = await chercher(Q_MAIGRE, 1);
    expect(r.fallback).toEqual({ loo: "qualité" });
    expect(r.total).toBe(1);
  });

  it("le barreau OU éclate les composés", async () => {
    const r = await chercher("bail-commercial introuvable");
    expect(r.fallback).toBe("or_relax");
    expect(r.total).toBeGreaterThan(0);
  });

  it("épuisée, l'échelle rend zéro SANS étiquette de repli", async () => {
    const r = await chercher("zzzzq wxyv");
    expect(r.hits).toEqual([]);
    expect(r.total).toBe(0);
    expect(r.fallback).toBeNull();
  });
});

describe("les trois décomptes servis, et leurs trois sens", () => {
  it("`total` compte le lexique, `returned` la page, `sources` les départage", async () => {
    const res = await registre().search_text({ query: Q_MAIGRE, limit: 5 } as never);
    const sc = res.structuredContent as {
      total: number;
      returned: number;
      sources: { lexical: number; semantique: number };
      fallback: string | null;
      results: unknown[];
    };
    expect(sc.fallback).toBe("or_relax");
    expect(sc.returned).toBe(sc.results.length);
    expect(sc.sources.lexical + sc.sources.semantique).toBe(sc.returned);
    expect(sc.total).toBe(2);
    expect(sc.sources.semantique).toBe(0);
  });

  it("l'étiquette de repli voyage dans l'objet typé, pas seulement en prose", async () => {
    const res = await registre().search_text({
      query: Q_FOURNIE,
      limit: 5,
    } as never);
    expect((res.structuredContent as { fallback: string }).fallback).toBe("loo:introuvable");
    expect(res.content?.[0]?.text).toContain("introuvable");
  });
});
