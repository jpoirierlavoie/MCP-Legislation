// Garde de l'ÉCHELLE de `legislation_search_text` : quel barreau arrête la descente, et
// sous quelle étiquette.
//
// POURQUOI CETTE GARDE EXISTE. L'échelle s'arrêtait au premier barreau rendant au moins UN
// résultat. Mesuré en production le 2026-09-17 sur « vice caché garantie qualité » : le
// leave-one-out retirait « qualité », trouvait UN article — p-40.1 art. 53.1, sur les
// automobiles gravement défectueuses — et s'arrêtait là, masquant le barreau OU qui met
// C.c.Q. 1726, 1728 et 1727 en tête, soit la garantie de qualité. Le cas fondateur de
// l'échelle (art. 490 C.p.c.) rend 8 résultats et devait, lui, rester intact.
//
// CE QUE CE FICHIER N'ÉPROUVE PAS, ET POURQUOI. Pas le CLASSEMENT. `bm25` pondère par les
// statistiques du corpus entier ; dans une base d'essai de dix lignes, un ordre de
// pertinence serait un artefact du gabarit, pas une propriété du moteur. Un test qui
// l'affirmerait rassurerait sans rien garantir. Le classement sur le VRAI corpus est éprouvé
// par `tests/evals.mjs`, contre un serveur vivant. Ici : le choix du barreau, les étiquettes,
// et les décomptes — tous déterministes, donc réellement gardables hors ligne.
//
// LE GABARIT N'EST PAS DU DROIT. Les phrases ci-dessous sont inventées et les lois
// s'appellent `essai-*` : aucune ne cite un texte officiel, précisément pour qu'on ne puisse
// jamais les prendre pour des données. Elles reproduisent le SEUL phénomène qui compte ici —
// FTS5 sur D1 n'a aucune racinisation française, donc « garantie » n'atteint pas
// « garantir », ni « vice » le pluriel « vices ».

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { ftsTokens, paginate, searchText, toFtsQuery } from "../src/lib";
import { RELAX_MIN_LOO_TOTAL } from "../src/relevance";
import { construireOutils } from "../src/tools";

const db = () => (env as unknown as { DB: D1Database }).DB;

/** Registre d'outils hors ligne : HYBRID_SEARCH à « 0 » -> aucun appel AI/Vectorize. */
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

// [id, law_id, number, texte]
const ARTICLES: [number, string, string, string][] = [
  // — Famille 1 : « garantie vice caché qualité ». UN SEUL article porte les trois premiers
  //   termes, aucun ne porte les quatre. Le leave-one-out y rend donc 1, sous le plancher.
  [1, "essai-a", "1", "Le vendeur doit garantir la chose vendue contre les vices cachés."],
  [2, "essai-a", "2", "Un vice caché engage la garantie du vendeur."],
  [3, "essai-b", "3", "La qualité de la chose est présumée conforme."],
  // — Famille 2 : « loyer bail résiliation introuvable ». TROIS articles portent les trois
  //   premiers termes : le leave-one-out atteint le plancher et garde la main.
  [4, "essai-a", "4", "La résiliation du bail suit le défaut de paiement du loyer."],
  [5, "essai-a", "5", "La résiliation du bail exige un avis écrit; le loyer reste dû."],
  [6, "essai-b", "6", "Le loyer est payable le premier jour du mois, sauf résiliation du bail."],
  // — Famille 3 : « servitude passage enclave inexistante ». EXACTEMENT DEUX articles
  //   portent les trois premiers termes. C'est la frontière calibrée : 2 passe, 1 tombe.
  [7, "essai-a", "8", "La servitude de passage vise le fonds en enclave."],
  [8, "essai-b", "9", "Le propriétaire en enclave obtient une servitude de passage."],
  // — Remplissage : aucun terme des trois familles.
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
  // Table à CONTENU EXTERNE : elle ne se remplit pas toute seule (schema.sql, §recherche).
  await d.prepare("INSERT INTO articles_fts(articles_fts) VALUES('rebuild')").run();
}

beforeAll(amorcerCorpus);

const chercher = (query: string, limite = 5) =>
  searchText(db(), query, "fr", undefined, paginate(limite, 0), { relax: true });

describe("toFtsQuery — l'expression réellement envoyée à SQLite", () => {
  it("combine les termes en ET IMPLICITE, chacun en littéral quoté", () => {
    // L'espace est un ET en FTS5. C'est la cause nº 1 du cas fondateur : un seul mot absent
    // du texte vide le résultat. Il est conservé — l'échelle le rattrape, en le DISANT (R7).
    expect(toFtsQuery(Q_MAIGRE)).toBe('"garantie" "vice" "caché" "qualité"');
  });

  it("ne produit JAMAIS de troncature de préfixe", () => {
    // Un `garanti*` apparierait garantir/garantie/garantit et fermerait le fossé de flexion
    // — au prix de la classe de faux positifs de l'invariant 14 (« fin » captant
    // « financier »), sur tout le corpus. Le choix est de relâcher par barreaux étiquetés.
    expect(toFtsQuery("garantie")).not.toContain("*");
  });

  it("neutralise les opérateurs qu'un usager pourrait taper", () => {
    // Quoté, `OR` est un TERME, pas un opérateur : personne ne peut injecter de la syntaxe.
    expect(toFtsQuery("vice OR caché")).toBe('"vice" "OR" "caché"');
    expect(toFtsQuery("(vice*)")).toBe('"vice"');
    expect(toFtsQuery("   ")).toBe("");
  });

  it("garde les composés d'un seul tenant — donc en PHRASE exigeant l'adjacence", () => {
    // `unicode61` re-découpe l'intérieur du littéral sur le tiret : « non-concurrence »
    // devient une phrase de deux tokens adjacents. C'est ce que le barreau OU vient défaire
    // en éclatant les composés.
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
    // Calibré par MESURE, et revu à la baisse le 2026-09-17 : à 3, le cas fondateur
    // RESTREINT au C.p.c. basculait au OU (son leave-one-out n'y rend que 2 résultats, alors
    // qu'il en rend 8 sur le corpus). À 2, aucun cas mesuré ne se déplace. Une valeur plus
    // haute corrigeait davantage que ce qui était cassé.
    expect(RELAX_MIN_LOO_TOTAL).toBe(2);
  });

  it("DEUX résultats suffisent à garder la main — c'est la frontière calibrée", async () => {
    const r = await chercher(Q_FRONTIERE);
    expect(r.fallback).toEqual({ loo: "inexistante" });
    expect(r.total).toBe(2);
  });

  it("le ET exact ne franchit pas la flexion française", async () => {
    // « garantir » et « vices cachés » sont dans le corpus ; « garantie », « vice » et
    // « caché » au singulier n'y sont pas sous cette forme. Aucun stemming ne les rapproche.
    const r = await searchText(db(), Q_MAIGRE, "fr", "essai-a", paginate(5, 0), {});
    expect(r.fallback, "l'échelle a tourné alors que relax était coupé").toBeNull();
    expect(r.total).toBe(0);
  });

  it("un leave-one-out MAIGRE laisse l'échelle descendre jusqu'au OU", async () => {
    const r = await chercher(Q_MAIGRE);
    // Le leave-one-out rendait 1 résultat et arrêtait tout. Il descend désormais.
    expect(r.fallback, "l'échelle s'est encore arrêtée au leave-one-out").toBe("or_relax");
    expect(r.total).toBe(2); // l'article à trois termes, plus celui qui porte « qualité »
    expect(r.hits.map((h) => h.number).sort()).toEqual(["2", "3"]);
  });

  it("un leave-one-out FOURNI garde la main, et nomme le terme RETIRÉ", async () => {
    const r = await chercher(Q_FOURNIE);
    // Le cas fondateur de l'échelle est de cette forme : un terme absent du texte tue le ET,
    // et son retrait rend une liste réellement fournie. Elle ne doit pas être sacrifiée.
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
    // Le `Math.min(RELAX_MIN_LOO_TOTAL, page.limit)` : rejeter une page pleine serait
    // absurde, et ferait dépendre le barreau choisi du seul `limit` de l'appelant.
    const r = await chercher(Q_MAIGRE, 1);
    expect(r.fallback).toEqual({ loo: "qualité" });
    expect(r.total).toBe(1);
  });

  it("le barreau OU éclate les composés", async () => {
    // « non-concurrence » en phrase n'existe pas dans le gabarit ; éclaté, « concurrence »
    // non plus — mais « bail » oui. C'est l'éclatement qui sauve la requête.
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
    const res = await registre().legislation_search_text({ query: Q_MAIGRE, limit: 5 } as never);
    const sc = res.structuredContent as {
      total: number;
      returned: number;
      sources: { lexical: number; semantique: number };
      fallback: string | null;
      results: unknown[];
    };
    expect(sc.fallback).toBe("or_relax");
    // `total: 1` avec cinq résultats rendus n'était pas une incohérence mais un piège : un
    // appariement lexical plus quatre voisins sémantiques, sans rien pour le dire.
    expect(sc.returned).toBe(sc.results.length);
    expect(sc.sources.lexical + sc.sources.semantique).toBe(sc.returned);
    expect(sc.total).toBe(2);
    // Hors ligne, aucun voisin sémantique ne peut entrer : la page est purement lexicale.
    expect(sc.sources.semantique).toBe(0);
  });

  it("l'étiquette de repli voyage dans l'objet typé, pas seulement en prose", async () => {
    const res = await registre().legislation_search_text({
      query: Q_FOURNIE,
      limit: 5,
    } as never);
    // Corollaire structuré de R4 (décision 001) : un client peut jeter la prose et garder
    // l'objet. Si l'étiquette ne vivait qu'en prose, elle tomberait sans qu'un test rougisse.
    expect((res.structuredContent as { fallback: string }).fallback).toBe("loo:introuvable");
    expect(res.content?.[0]?.text).toContain("introuvable");
  });
});
