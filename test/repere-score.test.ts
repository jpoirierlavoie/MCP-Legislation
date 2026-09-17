// Garde du classement de `legislation_find_relevant` — le facteur de COUVERTURE, et les
// deux faux positifs qu'il ferme.
//
// POURQUOI CETTE GARDE EXISTE. Mesuré en production le 2026-09-17, sur la requête
// « bail commercial résiliation défaut de payer le loyer » :
//
//   1. c-25.1 (Code de procédure pénale)      score 4,0909  « matière : Procédure pénale »
//   2. c-52.2 (confiscation)                  score 4,0909  « matière : Procédure pénale »
//   3. ca-c-34 (Loi sur la concurrence)        score 4,0909  « matière : Pratiques commerciales restrictives »
//
// Aucun de ces trois textes ne régit le bail. Le rapprochement venait d'UN SEUL token :
// « défaut », littéralement présent dans la description de la matière Procédure pénale
// (« comparution, défaut, instruction »), et « commercial », préfixe de « commerciales »
// dans le libellé Pratiques commerciales restrictives. Le score ne regardait PAS la part de
// la question expliquée : `ca-c-34` marquait 4,0909 qu'il apparie 1 token sur 2 ou 1 sur 6 —
// mesuré, identique. Le chapitre du louage du C.c.Q., lui, était absent du top 5.
//
// Les descriptions de matières sont des SURFACES D'APPARIEMENT (invariant 13), pas de la
// prose : les fixtures ci-dessous sont donc LUES dans `taxonomy.json` et jamais recopiées,
// sinon la garde éprouverait un texte que la production n'emploie plus.

import { describe, expect, it } from "vitest";

import {
  COVERAGE_FLOOR,
  coverageFactor,
  type DivisionLite,
  type LawLite,
  normalize,
  type RelevanceInput,
  rank,
  type SubjectLite,
  type SubjectMapLite,
  tokenize,
  wordMatch,
} from "../src/relevance";
import taxonomy from "../taxonomy.json";

type Mappage = { subject: string; law: string; division_path?: string };

const sujets = (ids: string[]): SubjectLite[] =>
  taxonomy.subjects
    .filter((s) => ids.includes(s.id))
    .map((s) => ({
      id: s.id,
      label_fr: s.label_fr,
      label_norm: normalize(s.label_fr),
      description_fr: s.description_fr,
    }));

const mappages = (ids: string[]): SubjectMapLite[] =>
  (taxonomy.mappings as Mappage[])
    .filter((m) => ids.includes(m.subject))
    .map((m) => ({
      subject_id: m.subject,
      law_id: m.law,
      division_path: m.division_path ?? "",
    }));

/** Entrée de `rank()` réduite aux matières nommées — S2/S3/S4 neutralisés par défaut. */
const entree = (
  query: string,
  ids: string[],
  extra: { divisions?: DivisionLite[]; laws?: LawLite[] } = {},
): RelevanceInput => ({
  tokens: tokenize(query),
  subjects: sujets(ids),
  subjectMap: mappages(ids),
  laws: extra.laws ?? [],
  divisions: extra.divisions ?? [],
  relations: [],
  mappedHeadings: new Map(),
});

const CHAPITRE_LOUAGE = "ga:l_cinquieme-gb:l_deuxieme-gc:l_quatrieme";
const SECTION_LOGEMENT = `${CHAPITRE_LOUAGE}-gd:l_iv`;
const REQUETE = "bail commercial résiliation défaut de payer le loyer";
const MATIERES = [
  "louage",
  "louage-residentiel",
  "procedure-penale",
  "pratiques-commerciales-restrictives",
];

const scoreDe = (cands: ReturnType<typeof rank>, lawId: string, path = "") =>
  cands.find((c) => c.law_id === lawId && c.division_path === path)?.score;

describe("coverageFactor — continu, borné, neutre sur un seul token", () => {
  it("ne change RIEN à une requête d'un seul token", () => {
    // La garantie qui protège les cas d'éval existants : « congédiement », « vice caché ».
    expect(coverageFactor(1, 1)).toBe(1);
    expect(coverageFactor(2, 2)).toBe(1);
  });

  it("plafonne au plancher quand rien n'est apparié", () => {
    expect(coverageFactor(0, 6)).toBe(COVERAGE_FLOOR);
  });

  it("croît avec la part de la question expliquée", () => {
    const suite = [1, 2, 3, 4, 5, 6].map((n) => coverageFactor(n, 6));
    for (let i = 1; i < suite.length; i++) {
      expect(suite[i], `couverture ${i + 1}/6`).toBeGreaterThan(suite[i - 1]);
    }
    expect(suite.at(-1)).toBe(1);
  });

  it("est CONTINU : aucune falaise entre deux couvertures voisines (invariant 12)", () => {
    // Un seuil (« ≥ N tokens -> bonus ») a une position qui dépend de la longueur de la
    // requête. Le pas doit rester constant, donc borné bien en dessous de l'écart total.
    const pas = [];
    for (let n = 1; n <= 8; n++) pas.push(coverageFactor(n, 8) - coverageFactor(n - 1, 8));
    for (const p of pas) expect(p).toBeCloseTo((1 - COVERAGE_FLOOR) / 8, 10);
  });

  it("ne rend jamais plus de 1, même si l'appariement dépasse le décompte", () => {
    expect(coverageFactor(9, 6)).toBe(1);
    expect(coverageFactor(1, 0)).toBe(1);
  });
});

describe("la description de la matière « louage » est la surface qui referme le fossé bail/louage", () => {
  // Le défaut était STRUCTURELLEMENT francophone : l'intitulé anglais « LEASE » apparie le
  // token « lease », donc S2 s'allume ; l'intitulé français « DU LOUAGE » ne partage AUCUN
  // token avec « bail », et `wordMatch` est unidirectionnel (le token doit être préfixe du
  // mot cible). Mesuré : le chapitre sortait au rang 2 en anglais, absent du top 5 en
  // français. Rien ne le rapprochera jamais de « bail » sans passage par la description.
  const sujet = sujets(["louage"])[0];
  const hay = `${sujet.label_norm} ${normalize(sujet.id)} ${normalize(sujet.description_fr)}`;

  it("existe", () => {
    expect(sujet, "la matière « louage » a disparu de taxonomy.json").toBeDefined();
  });

  for (const token of ["bail", "louage", "commercial", "resiliation", "loyer", "locataire"]) {
    it(`apparie « ${token} »`, () => {
      expect(wordMatch(hay, token), `« ${token} » ne trouve plus la matière louage`).toBe(true);
    });
  }

  it("ne porte AUCUNE mention contrastive (invariant 13)", () => {
    // « distincte de la procédure civile » dans Procédure pénale lui a fait capter
    // « appel civil » : S1 apparie des tokens et ignore la négation.
    for (const s of taxonomy.subjects) {
      const d = normalize(s.description_fr).concat(" ", normalize(s.label_fr));
      for (const piege of ["ne pas confondre", "distincte de", "distinct de", "plutot que"]) {
        expect(d.includes(piege), `${s.id} : « ${piege} » dans une surface d'appariement`).toBe(
          false,
        );
      }
    }
  });
});

describe("le cas reproduit : bail commercial, résiliation pour défaut de paiement", () => {
  const cands = rank(entree(REQUETE, MATIERES), 10);

  it("tokenise en six termes, mots vides retirés", () => {
    expect(tokenize(REQUETE)).toEqual([
      "bail",
      "commercial",
      "resiliation",
      "defaut",
      "payer",
      "loyer",
    ]);
  });

  it("met le CHAPITRE DU LOUAGE du C.c.Q. en tête", () => {
    expect(cands[0].law_id).toBe("ccq");
    expect(cands[0].division_path).toBe(CHAPITRE_LOUAGE);
  });

  it("le chapitre du louage explique quatre tokens sur six, et le dit", () => {
    expect(cands[0].pourquoi).toContain("matière : Louage (bail)");
  });

  it("ne place AUCUNE loi pénale ni la Loi sur la concurrence devant lui", () => {
    const tete = cands[0].score;
    for (const loi of ["c-25.1", "c-52.2", "ca-c-34"]) {
      const s = scoreDe(cands, loi);
      if (s !== undefined) expect(s, `${loi} devance le chapitre du louage`).toBeLessThan(tete);
    }
  });

  it("les trois faux positifs mesurés tombent sous la moitié du candidat de tête", () => {
    // Ils restent CANDIDATS — ils apparient réellement un token, et l'outil ne mentirait pas
    // en les montrant ; ils ne doivent simplement plus primer. Un `absent` strict serait un
    // test plus joli et une garantie plus faible.
    const tete = cands[0].score;
    for (const loi of ["c-25.1", "c-52.2", "ca-c-34"]) {
      const s = scoreDe(cands, loi);
      if (s !== undefined) expect(s, loi).toBeLessThan(tete / 2);
    }
  });

  it("distingue le régime GÉNÉRAL de la section du bail d'habitation", () => {
    // C'est l'erreur de taxonomie corrigée : le chapitre entier (art. 1851 et s., dont les
    // sections qui régissent le bail commercial) portait la matière « Louage résidentiel ».
    const general = scoreDe(cands, "ccq", CHAPITRE_LOUAGE);
    const logement = scoreDe(cands, "ccq", SECTION_LOGEMENT);
    expect(general, "le chapitre du louage n'est plus candidat").toBeDefined();
    expect(logement, "la section du bail d'habitation n'est plus candidate").toBeDefined();
    expect(general).toBeGreaterThan(logement as number);
  });
});

describe("la couverture, isolée du reste du calcul", () => {
  it("un token sur six ne vaut plus autant qu'un token sur deux", () => {
    // LA mesure qui a fait ouvrir ce chantier : ca-c-34 marquait 4,0909 dans les DEUX cas.
    const court = rank(entree("bail commercial", MATIERES), 10);
    const long = rank(entree(REQUETE, MATIERES), 10);
    const a = scoreDe(court, "ca-c-34");
    const b = scoreDe(long, "ca-c-34");
    expect(a, "ca-c-34 n'apparie plus « commercial »").toBeDefined();
    expect(b).toBeDefined();
    expect(b as number).toBeLessThan(a as number);
  });

  it("un seul token : le score reste le produit exact du poids et de la spécificité", () => {
    // Requête à un token, une matière, une entité mappée -> portée 1, spécificité ×2,
    // couverture 1/1 = ×1. S1_SUBJECT × 2 = 6. Aucun arrondi n'intervient nulle part.
    //
    // « cartel » et non « concurrence » : `wordMatch` veut le token PRÉFIXE du mot cible, et
    // « concurrence » n'est pas un préfixe de « concurrents ». La Loi sur la concurrence ne
    // se trouve donc pas par son propre nom de domaine — relevé en écrivant cette garde,
    // consigné ici parce que c'est exactement le genre d'angle mort que S1 ne signale pas.
    const cands = rank(entree("cartel", ["pratiques-commerciales-restrictives"]), 10);
    expect(cands).toHaveLength(1);
    expect(cands[0].law_id).toBe("ca-c-34");
    expect(cands[0].score).toBeCloseTo(6, 10);
  });

  it("le rééchelonnage précède S4, qui n'a aucune couverture à mesurer", () => {
    // S4 ne vient d'aucun token : l'appoint de graphe ne doit donc pas être rééchelonné,
    // comme il échappe déjà au facteur de spécificité.
    const base = entree(REQUETE, MATIERES);
    const avecGraphe = rank(
      {
        ...base,
        relations: [
          {
            from_law_id: "ccq",
            to_law_id: "t-11.002",
            rel_type: "connexe",
            source: "cure",
            in_corpus: 1,
            note: null,
          },
        ],
      },
      50,
    );
    const voisin = avecGraphe.find((c) => c.law_id === "t-11.002");
    expect(voisin, "le voisin de graphe n'est plus produit").toBeDefined();
    expect(voisin?.score).toBeCloseTo(1, 10);
  });
});
