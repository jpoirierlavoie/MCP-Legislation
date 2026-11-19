import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { ftsTokens, paginate, searchText, type VectorBackend } from "../src/lib";
import {
  FONCTION_WEIGHTS,
  fonctionWeight,
  MAX_PER_FONCTION_SOUPLE,
  normalize,
  type RelevanceInput,
  rank,
  tokenize,
} from "../src/relevance";

const db = () => (env as unknown as { DB: D1Database }).DB;

describe("FONCTION_WEIGHTS & fonctionWeight", () => {
  it("attribue 1.0 aux lois et règlements adoptés et < 1.0 aux directives/orientations", () => {
    expect(FONCTION_WEIGHTS.loi).toBe(1);
    expect(FONCTION_WEIGHTS.reglement).toBe(1);
    expect(FONCTION_WEIGHTS["regles-procedure"]).toBe(1);
    expect(FONCTION_WEIGHTS.tarif).toBe(1);
    expect(FONCTION_WEIGHTS.directive).toBeLessThan(1);
    expect(FONCTION_WEIGHTS.orientation).toBeLessThan(1);
    expect(fonctionWeight("reglement")).toBe(1);
    expect(fonctionWeight(null)).toBe(1);
    expect(fonctionWeight(undefined)).toBe(1);
    expect(fonctionWeight("directive")).toBe(0.7);
    expect(fonctionWeight("orientation")).toBe(0.65);
  });
});

describe("rank() — pondération normative et plafond de diversité par fonction", () => {
  const mkInput = (query: string): RelevanceInput => ({
    tokens: tokenize(query),
    subjects: [
      {
        id: "procedure-civile",
        label_fr: "Procédure civile",
        label_norm: normalize("Procédure civile"),
        description_fr: "greffe demande civile cahier audience",
      },
      {
        id: "valeurs-mobilieres",
        label_fr: "Valeurs mobilières",
        label_norm: normalize("Valeurs mobilières"),
        description_fr: "dispense prospectus investisseur qualifie valeurs mobilieres",
      },
    ],
    subjectMap: [
      { subject_id: "procedure-civile", law_id: "cpc", division_path: "" },
      { subject_id: "procedure-civile", law_id: "qccs-dist-mtl", division_path: "" },
      { subject_id: "procedure-civile", law_id: "qccs-div-mtl", division_path: "" },
      { subject_id: "procedure-civile", law_id: "qccs-div-qc", division_path: "" },
      { subject_id: "valeurs-mobilieres", law_id: "v-1.1-r.21", division_path: "" },
      { subject_id: "valeurs-mobilieres", law_id: "amf-ig-45-106", division_path: "" },
    ],
    laws: [
      {
        id: "cpc",
        name_fr: "Code de procédure civile",
        name_norm: normalize("Code de procédure civile"),
        fonction: "loi",
      },
      {
        id: "qccs-dist-mtl",
        name_fr: "Directives C.S. District de Montréal",
        name_norm: normalize("Directives C.S. District de Montréal"),
        fonction: "directive",
      },
      {
        id: "qccs-div-mtl",
        name_fr: "Directives C.S. Division de Montréal",
        name_norm: normalize("Directives C.S. Division de Montréal"),
        fonction: "directive",
      },
      {
        id: "qccs-div-qc",
        name_fr: "Directives C.S. Division de Québec",
        name_norm: normalize("Directives C.S. Division de Québec"),
        fonction: "directive",
      },
      {
        id: "v-1.1-r.21",
        name_fr: "Règlement 45-106 sur les dispenses de prospectus",
        name_norm: normalize("Règlement 45-106 sur les dispenses de prospectus"),
        fonction: "reglement",
      },
      {
        id: "amf-ig-45-106",
        name_fr: "Instruction générale 45-106 relative au Règlement 45-106",
        name_norm: normalize("Instruction générale 45-106 relative au Règlement 45-106"),
        fonction: "orientation",
      },
    ],
    divisions: [],
    relations: [],
    mappedHeadings: new Map(),
  });

  it("classe le règlement AMF devant son instruction générale sur requête générale, mais cède sur requête explicite IG", () => {
    const gen = rank(mkInput("dispense prospectus investisseur qualifie"), 10);
    const reg = gen.find((c) => c.law_id === "v-1.1-r.21");
    const ig = gen.find((c) => c.law_id === "amf-ig-45-106");
    expect(reg).toBeDefined();
    expect(ig).toBeDefined();
    expect(reg!.score).toBeGreaterThan(ig!.score);

    const explicite = rank(mkInput("instruction generale 45-106"), 10);
    expect(explicite[0]?.law_id).toBe("amf-ig-45-106");
  });

  it("applique MAX_PER_FONCTION_SOUPLE en passe principale tout en conservant MAX_PER_SUBJECT", () => {
    const cands = rank(mkInput("greffe"), 10);
    expect(cands[0]?.law_id).toBe("cpc");
    const cpcIdx = cands.findIndex((c) => c.law_id === "cpc");
    expect(cpcIdx).toBe(0);
    expect(MAX_PER_FONCTION_SOUPLE).toBe(2);
    // Les 3 directives restent toutes accessibles en file d'attente si limit le permet
    const dirs = cands.filter((c) => c.law_id.startsWith("qccs-"));
    expect(dirs).toHaveLength(3);
  });
});

describe("rank() — portée par texte (law_id) et mot vide « clause »", () => {
  it("tokenize() omet « clause »/« clauses » alors que ftsTokens() les préserve pour la recherche plein texte", () => {
    const query = "clause non-concurrence fin d'emploi";
    expect(tokenize(query)).toEqual(["non", "concurrence", "fin", "emploi"]);
    expect(tokenize("clauses abusives")).toEqual(["abusives"]);
    expect(ftsTokens(query)).toContain("clause");
    expect(ftsTokens(query)).toEqual(["clause", "non-concurrence", "fin", "d'emploi"]);
  });

  it("classe ccq contrat de travail devant v-1.1-r.10›ps:5 et c-38›ga:l_ii malgré plusieurs annexes « emploi » dans v-1.1-r.21", () => {
    const query = "clause non-concurrence fin d'emploi";
    const v11r21EmploiDivisions = [
      "ps:6-ph1:1",
      "ps:7-ph1:1",
      "ps:16-ph1:3",
      "ps:17",
      "ps:17-ph1:1",
      "ps:20-ph1:4",
    ].map((path) => ({
      law_id: "v-1.1-r.21",
      path,
      heading: "Emploi du produit",
      heading_norm: normalize("Emploi du produit"),
    }));

    const baseInput = (r21Count: number): RelevanceInput => ({
      tokens: tokenize(query),
      subjects: [
        {
          id: "travail-emploi",
          label_fr: "Travail et emploi",
          label_norm: normalize("Travail et emploi"),
          description_fr: "contrat de travail congediement fin d'emploi normes du travail",
        },
      ],
      subjectMap: [
        {
          subject_id: "travail-emploi",
          law_id: "ccq",
          division_path: "ga:l_cinquieme-gb:l_deuxieme-gc:l_septieme",
        },
        { subject_id: "travail-emploi", law_id: "ca-l-2", division_path: "fh1:5" },
      ],
      laws: [
        {
          id: "ccq",
          name_fr: "Code civil du Québec",
          name_norm: normalize("Code civil du Québec"),
          fonction: "loi",
        },
        {
          id: "ca-l-2",
          name_fr: "Code canadien du travail",
          name_norm: normalize("Code canadien du travail"),
          fonction: "loi",
        },
        {
          id: "v-1.1-r.21",
          name_fr: "Règlement 45-106 sur les dispenses de prospectus",
          name_norm: normalize("Règlement 45-106 sur les dispenses de prospectus"),
          fonction: "reglement",
        },
        {
          id: "v-1.1-r.10",
          name_fr: "Règlement 31-103 sur les obligations d'inscription",
          name_norm: normalize("Règlement 31-103 sur les obligations d'inscription"),
          fonction: "reglement",
        },
        {
          id: "c-38",
          name_fr: "Loi sur les compagnies",
          name_norm: normalize("Loi sur les compagnies"),
          fonction: "loi",
        },
        {
          id: "ca-c-34",
          name_fr: "Loi sur la concurrence",
          name_norm: normalize("Loi sur la concurrence"),
          fonction: "loi",
        },
      ],
      divisions: [
        ...v11r21EmploiDivisions.slice(0, r21Count),
        {
          law_id: "v-1.1-r.10",
          path: "ps:5",
          heading: "ANNEXE A CLAUSES DE CAUTIONNEMENT ET D'ASSURANCE",
          heading_norm: normalize("ANNEXE A CLAUSES DE CAUTIONNEMENT ET D'ASSURANCE"),
        },
        {
          law_id: "c-38",
          path: "ga:l_ii",
          heading: "DES CLAUSES GÉNÉRALES DE LA COMPAGNIE",
          heading_norm: normalize("DES CLAUSES GÉNÉRALES DE LA COMPAGNIE"),
        },
        {
          law_id: "ca-c-34",
          path: "fh1:7",
          heading: "Concurrence et pratiques restrictives",
          heading_norm: normalize("Concurrence et pratiques restrictives"),
        },
      ],
      relations: [],
      mappedHeadings: new Map(),
    });

    const cands6 = rank(baseInput(6), 8);
    const cands1 = rank(baseInput(1), 8);

    const ccqIdx = cands6.findIndex(
      (c) => c.law_id === "ccq" && c.division_path === "ga:l_cinquieme-gb:l_deuxieme-gc:l_septieme",
    );
    const r10Idx = cands6.findIndex((c) => c.law_id === "v-1.1-r.10" && c.division_path === "ps:5");
    const c38Idx = cands6.findIndex((c) => c.law_id === "c-38" && c.division_path === "ga:l_ii");

    expect(ccqIdx).toBeGreaterThanOrEqual(0);
    // « clause » étant mot vide, v-1.1-r.10›ps:5 et c-38›ga:l_ii ne reçoivent aucun signal
    expect(r10Idx).toBe(-1);
    expect(c38Idx).toBe(-1);

    // La portée de « emploi » compte les textes (law_id) distincts et non le nombre d'annexes dans v-1.1-r.21
    const ccq6 = cands6[ccqIdx];
    const ccq1 = cands1.find(
      (c) => c.law_id === "ccq" && c.division_path === "ga:l_cinquieme-gb:l_deuxieme-gc:l_septieme",
    );
    expect(ccq1).toBeDefined();
    expect(ccq6.score).toBeCloseTo(ccq1!.score, 10);
  });
});

describe("fuseHybrid / searchText — calibration RRF des directives et orientations", () => {
  beforeAll(async () => {
    const d = db();
    const laws: [string, string, string, string, string, string][] = [
      ["cpc", "Code de procédure civile", "RLRQ, c. C-25.01", "epub", "loi", "article"],
      [
        "v-1.1-r.21",
        "Règlement 45-106 sur les dispenses de prospectus",
        "RLRQ, c. V-1.1, r. 21",
        "pdf",
        "reglement",
        "article",
      ],
      [
        "qccs-dist-mtl",
        "Directives de la Cour supérieure — District de Montréal",
        "Directives C.S. (District de Montréal)",
        "pdf",
        "directive",
        "paragraphe",
      ],
      [
        "amf-ig-45-106",
        "Instruction générale relative au Règlement 45-106",
        "Instruction générale 45-106",
        "pdf",
        "orientation",
        "article",
      ],
    ];
    for (const [id, name, cite, source, fonction, unit] of laws) {
      await d
        .prepare(
          `INSERT INTO laws (id, name_fr, name_en, official_cite, consol_date_fr, jurisdiction, source, fonction, unit, name_norm)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, name, name, cite, "2026-01-01", "qc", source, fonction, unit, normalize(name))
        .run();
    }
    const divs: [number, string, string, string][] = [
      [1, "cpc", "ga:l_i", "DISPOSITIONS GÉNÉRALES"],
      [2, "v-1.1-r.21", "ph1:1", "DISPENSES"],
      [3, "qccs-dist-mtl", "ph1:1", "AUDIENCE"],
      [4, "amf-ig-45-106", "ph1:1", "INTERPRÉTATION"],
    ];
    for (const [id, lawId, path, heading] of divs) {
      await d
        .prepare(
          "INSERT INTO divisions (id, law_id, lang, kind, number, heading, path, sort_order) VALUES (?,?,?,?,?,?,?,?)",
        )
        .bind(id, lawId, "fr", "titre", "I", heading, path, id)
        .run();
    }
    let artId = 1;
    for (let i = 101; i <= 115; i++) {
      await d
        .prepare(
          "INSERT INTO articles (id, law_id, lang, number, sort_key, division_id, division_path, text) VALUES (?,?,?,?,?,?,?,?)",
        )
        .bind(
          artId++,
          "cpc",
          "fr",
          String(i),
          i * 1_000_000_000_000,
          1,
          "ga:l_i",
          `Disposition civile générale numéro ${i} sur la conduite de l'instance.`,
        )
        .run();
    }
    await d
      .prepare(
        "INSERT INTO articles (id, law_id, lang, number, sort_key, division_id, division_path, text) VALUES (?,?,?,?,?,?,?,?)",
      )
      .bind(
        artId++,
        "v-1.1-r.21",
        "fr",
        "2.1",
        2_001_000_000_000,
        2,
        "ph1:1",
        "Dispense de prospectus pour investisseur qualifié souscription privée.",
      )
      .run();
    await d
      .prepare(
        "INSERT INTO articles (id, law_id, lang, number, sort_key, division_id, division_path, text) VALUES (?,?,?,?,?,?,?,?)",
      )
      .bind(
        artId++,
        "qccs-dist-mtl",
        "fr",
        "12",
        12_000_000_000_000,
        3,
        "ph1:1",
        "Dépôt du cahier des autorités judiciaires avant l'audience civile.",
      )
      .run();
    await d
      .prepare(
        "INSERT INTO articles (id, law_id, lang, number, sort_key, division_id, division_path, text) VALUES (?,?,?,?,?,?,?,?)",
      )
      .bind(
        artId++,
        "amf-ig-45-106",
        "fr",
        "2.1",
        2_001_000_000_000,
        4,
        "ph1:1",
        "Orientation interprétative sur la dispense de prospectus pour investisseur qualifié.",
      )
      .run();
    await d.prepare("INSERT INTO articles_fts(articles_fts) VALUES('rebuild')").run();
  });

  const makeMockVector = (
    matches: { id: string; score: number; law: string; article: string }[],
  ): VectorBackend => ({
    ai: {
      async run(_model: string, input: { text: string[] }) {
        return { data: input.text.map(() => [0.5, 0.5, 0.5, 0.5]) };
      },
    } as unknown as Ai,
    index: {
      async query() {
        return {
          matches: matches.map((m) => ({
            id: m.id,
            score: m.score,
            metadata: { type: "article", law: m.law, article: m.article },
          })),
        };
      },
    } as unknown as VectorizeIndex,
  });

  it("Probe 2b : directive rang #1 sémantique (cos 0.88) survit dans le top 14 face à 15 hits loi (cos 0.41..0.424)", async () => {
    const matches = [
      { id: "dir-12", score: 0.88, law: "qccs-dist-mtl", article: "12" },
      ...Array.from({ length: 15 }, (_, idx) => ({
        id: `cpc-${101 + idx}`,
        score: Number((0.424 - idx * 0.001).toFixed(3)),
        law: "cpc",
        article: String(101 + idx),
      })),
    ];
    const res = await searchText(db(), "xyznonexistentterm", "fr", undefined, paginate(14, 0), {
      relax: true,
      vector: makeMockVector(matches),
      env: { PDF_CORPUS: "1", FEDERAL_CORPUS: "1" },
    });
    expect(res.fallback).toBe("semantic");
    expect(res.hits.length).toBe(14);
    expect(res.hits.some((h) => h.law_id === "qccs-dist-mtl" && h.number === "12")).toBe(true);
  });

  it("Probe C : directive rang #1 FTS exact survit dans le top 14 face à 15 hits vecteurs loi (cos 0.405..0.419)", async () => {
    const matches = Array.from({ length: 15 }, (_, idx) => ({
      id: `cpc-${101 + idx}`,
      score: Number((0.419 - idx * 0.001).toFixed(3)),
      law: "cpc",
      article: String(101 + idx),
    }));
    const res = await searchText(db(), "cahier autorités", "fr", undefined, paginate(14, 0), {
      relax: true,
      vector: makeMockVector(matches),
      env: { PDF_CORPUS: "1", FEDERAL_CORPUS: "1" },
    });
    expect(res.fallback).toBeNull();
    expect(res.hits.some((h) => h.law_id === "qccs-dist-mtl" && h.number === "12")).toBe(true);
  });

  it("à rang RRF égal, loi et règlement priment toujours sur directive et orientation", async () => {
    // Rangs symétriques : v-1.1-r.21 (FTS #1, Vec #2) vs amf-ig-45-106 (FTS #2, Vec #1)
    const matches = [
      { id: "ig-2.1", score: 0.9, law: "amf-ig-45-106", article: "2.1" },
      { id: "reg-2.1", score: 0.89, law: "v-1.1-r.21", article: "2.1" },
    ];
    const res = await searchText(
      db(),
      "dispense prospectus investisseur qualifié",
      "fr",
      undefined,
      paginate(10, 0),
      {
        relax: true,
        vector: makeMockVector(matches),
        env: { PDF_CORPUS: "1", FEDERAL_CORPUS: "1" },
      },
    );
    const regIdx = res.hits.findIndex((h) => h.law_id === "v-1.1-r.21");
    const igIdx = res.hits.findIndex((h) => h.law_id === "amf-ig-45-106");
    expect(regIdx).toBeGreaterThanOrEqual(0);
    expect(igIdx).toBeGreaterThanOrEqual(0);
    expect(regIdx).toBeLessThan(igIdx);
  });
});
