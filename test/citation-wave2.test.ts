import { describe, expect, it } from "vitest";

import { type LawRow, parseCitation } from "../src/lib";

const makeLaw = (
  base: Pick<LawRow, "id" | "name_fr" | "official_cite" | "official_cite_en" | "fonction" | "unit">,
): LawRow => ({
  ...base,
  name_en: base.official_cite_en ?? base.name_fr,
  consol_date_fr: null,
  consol_date_en: null,
  forum: null,
  scope_fr: null,
  parent_law_id: null,
  name_norm: null,
});

const LAWS: LawRow[] = [
  makeLaw({
    id: "c-12",
    name_fr: "Charte des droits et libertés de la personne",
    official_cite: "RLRQ, c. C-12",
    official_cite_en: "CQLR, c. C-12",
    fonction: "loi",
    unit: "article",
  }),
  makeLaw({
    id: "ca-const-1982",
    name_fr: "Loi constitutionnelle de 1982",
    official_cite: "Loi constitutionnelle de 1982",
    official_cite_en: "Constitution Act, 1982",
    fonction: "loi",
    unit: "article",
  }),
  makeLaw({
    id: "ca-l-2",
    name_fr: "Code canadien du travail",
    official_cite: "L.R.C. (1985), ch. L-2",
    official_cite_en: "R.S.C. 1985, c. L-2",
    fonction: "loi",
    unit: "article",
  }),
  makeLaw({
    id: "c-11",
    name_fr: "Charte de la langue française",
    official_cite: "RLRQ, c. C-11",
    official_cite_en: "CQLR, c. C-11",
    fonction: "loi",
    unit: "article",
  }),
  makeLaw({
    id: "a-25",
    name_fr: "Loi sur l’assurance automobile",
    official_cite: "RLRQ, c. A-25",
    official_cite_en: "CQLR, c. A-25",
    fonction: "loi",
    unit: "article",
  }),
  makeLaw({
    id: "c-27",
    name_fr: "Code du travail",
    official_cite: "RLRQ, c. C-27",
    official_cite_en: "CQLR, c. C-27",
    fonction: "loi",
    unit: "article",
  }),
  makeLaw({
    id: "t-15.1",
    name_fr: "Loi instituant le Tribunal administratif du travail",
    official_cite: "RLRQ, c. T-15.1",
    official_cite_en: "CQLR, c. T-15.1",
    fonction: "loi",
    unit: "article",
  }),
  makeLaw({
    id: "t-15.1-r.1.1",
    name_fr: "Règles de preuve et de procédure du Tribunal administratif du travail",
    official_cite: "RLRQ, c. T-15.1, r. 1.1",
    official_cite_en: "CQLR, c. T-15.1, r. 1.1",
    fonction: "regles-procedure",
    unit: "article",
  }),
  makeLaw({
    id: "a-3.001",
    name_fr: "Loi sur les accidents du travail et les maladies professionnelles",
    official_cite: "RLRQ, c. A-3.001",
    official_cite_en: "CQLR, c. A-3.001",
    fonction: "loi",
    unit: "article",
  }),
  makeLaw({
    id: "s-2.1",
    name_fr: "Loi sur la santé et la sécurité du travail",
    official_cite: "RLRQ, c. S-2.1",
    official_cite_en: "CQLR, c. S-2.1",
    fonction: "loi",
    unit: "article",
  }),
  makeLaw({
    id: "q-2",
    name_fr: "Loi sur la qualité de l’environnement",
    official_cite: "RLRQ, c. Q-2",
    official_cite_en: "CQLR, c. Q-2",
    fonction: "loi",
    unit: "article",
  }),
  makeLaw({
    id: "a-19.1",
    name_fr: "Loi sur l’aménagement et l’urbanisme",
    official_cite: "RLRQ, c. A-19.1",
    official_cite_en: "CQLR, c. A-19.1",
    fonction: "loi",
    unit: "article",
  }),
  makeLaw({
    id: "c-47.1",
    name_fr: "Loi sur les compétences municipales",
    official_cite: "RLRQ, c. C-47.1",
    official_cite_en: "CQLR, c. C-47.1",
    fonction: "loi",
    unit: "article",
  }),
  makeLaw({
    id: "p-41.1",
    name_fr: "Loi sur la protection du territoire et des activités agricoles",
    official_cite: "RLRQ, c. P-41.1",
    official_cite_en: "CQLR, c. P-41.1",
    fonction: "loi",
    unit: "article",
  }),
  makeLaw({
    id: "ca-dors-2002-156",
    name_fr: "Règles de la Cour suprême du Canada",
    official_cite: "DORS/2002-156",
    official_cite_en: "SOR/2002-156",
    fonction: "regles-procedure",
    unit: "regle",
  }),
  makeLaw({
    id: "ca-c-7.75",
    name_fr: "Loi canadienne sur les organisations à but non lucratif",
    official_cite: "L.C. 2009, ch. 23",
    official_cite_en: "S.C. 2009, c. 23",
    fonction: "loi",
    unit: "article",
  }),
  makeLaw({
    id: "ca-p-4",
    name_fr: "Loi sur les brevets",
    official_cite: "L.R.C. (1985), ch. P-4",
    official_cite_en: "R.S.C. 1985, c. P-4",
    fonction: "loi",
    unit: "article",
  }),
  makeLaw({
    id: "ca-i-9",
    name_fr: "Loi sur les dessins industriels",
    official_cite: "L.R.C. (1985), ch. I-9",
    official_cite_en: "R.S.C. 1985, c. I-9",
    fonction: "loi",
    unit: "article",
  }),
  makeLaw({
    id: "s-29.02",
    name_fr: "Loi sur les sociétés de fiducie et les sociétés d’épargne",
    official_cite: "RLRQ, c. S-29.02",
    official_cite_en: "CQLR, c. S-29.02",
    fonction: "loi",
    unit: "article",
  }),
];

describe("parseCitation — Vague 2 (lois sectorielles QC et fédérales)", () => {
  it("résout la Charte de la langue française (c-11) sans confondre avec les autres Chartes", () => {
    expect(parseCitation("RLRQ, c. C-11, art. 55", LAWS)).toMatchObject({
      law: "c-11",
      article: "55",
      ambigu: null,
    });
    expect(parseCitation("art. 55 de la Charte de la langue française", LAWS)).toMatchObject({
      law: "c-11",
      article: "55",
      ambigu: null,
    });
    expect(parseCitation("Charter of the French language, s. 52", LAWS)).toMatchObject({
      law: "c-11",
      article: "52",
      ambigu: null,
    });
    expect(parseCitation("art. 88.0.1 de la Loi 101", LAWS)).toMatchObject({
      law: "c-11",
      article: "88.0.1",
      ambigu: null,
    });
    expect(parseCitation("art. 7 de la Charte", LAWS).ambigu?.map((l) => l.id)).toEqual([
      "c-12",
      "ca-const-1982",
    ]);
  });

  it("résout les lois du travail, santé-sécurité, assurance automobile et environnement", () => {
    expect(parseCitation("L.A.A., art. 83.57", LAWS)).toMatchObject({
      law: "a-25",
      article: "83.57",
      ambigu: null,
    });
    expect(parseCitation("C.t., art. 45", LAWS)).toMatchObject({
      law: "c-27",
      article: "45",
      ambigu: null,
    });
    expect(parseCitation("Code canadien du travail, art. 240", LAWS)).toMatchObject({
      law: "ca-l-2",
      article: "240",
      ambigu: null,
    });
    expect(parseCitation("RLRQ, c. T-15.1, r. 1.1, art. 9", LAWS)).toMatchObject({
      law: "t-15.1-r.1.1",
      article: "9",
      ambigu: null,
    });
    expect(parseCitation("L.I.T.A.T., art. 9", LAWS)).toMatchObject({
      law: "t-15.1",
      article: "9",
      ambigu: null,
    });
    expect(parseCitation("L.A.T.M.P., art. 438", LAWS)).toMatchObject({
      law: "a-3.001",
      article: "438",
      ambigu: null,
    });
    expect(parseCitation("L.S.S.T., art. 12", LAWS)).toMatchObject({
      law: "s-2.1",
      article: "12",
      ambigu: null,
    });
    expect(parseCitation("L.Q.E., art. 22", LAWS)).toMatchObject({
      law: "q-2",
      article: "22",
      ambigu: null,
    });
    expect(parseCitation("L.A.U., art. 113", LAWS)).toMatchObject({
      law: "a-19.1",
      article: "113",
      ambigu: null,
    });
    expect(parseCitation("L.C.M., art. 4", LAWS)).toMatchObject({
      law: "c-47.1",
      article: "4",
      ambigu: null,
    });
    expect(parseCitation("L.P.T.A.A., art. 26", LAWS)).toMatchObject({
      law: "p-41.1",
      article: "26",
      ambigu: null,
    });
    expect(parseCitation("RLRQ, c. S-29.02, art. 1", LAWS)).toMatchObject({
      law: "s-29.02",
      article: "1",
      ambigu: null,
    });
  });

  it("résout les 4 textes fédéraux de la Vague 2", () => {
    expect(parseCitation("DORS/2002-156, règle 25", LAWS)).toMatchObject({
      law: "ca-dors-2002-156",
      article: "25",
      ambigu: null,
    });
    expect(parseCitation("SOR/2002-156, rule 25", LAWS)).toMatchObject({
      law: "ca-dors-2002-156",
      article: "25",
      ambigu: null,
    });
    expect(parseCitation("R.C.S.C., règle 47", LAWS)).toMatchObject({
      law: "ca-dors-2002-156",
      article: "47",
      ambigu: null,
    });
    expect(parseCitation("L.C. 2009, ch. 23, art. 12", LAWS)).toMatchObject({
      law: "ca-c-7.75",
      article: "12",
      ambigu: null,
    });
    expect(parseCitation("S.C. 2009, c. 23, s. 12", LAWS)).toMatchObject({
      law: "ca-c-7.75",
      article: "12",
      ambigu: null,
    });
    expect(parseCitation("L.C.O.B.N.L., art. 12", LAWS)).toMatchObject({
      law: "ca-c-7.75",
      article: "12",
      ambigu: null,
    });
    expect(parseCitation("ch. C-7.75, art. 14", LAWS)).toMatchObject({
      law: "ca-c-7.75",
      article: "14",
      ambigu: null,
    });
    expect(parseCitation("L.R.C. (1985), ch. P-4, art. 42", LAWS)).toMatchObject({
      law: "ca-p-4",
      article: "42",
      ambigu: null,
    });
    expect(parseCitation("Patent Act, s. 42", LAWS)).toMatchObject({
      law: "ca-p-4",
      article: "42",
      ambigu: null,
    });
    expect(parseCitation("Industrial Design Act, s. 11", LAWS)).toMatchObject({
      law: "ca-i-9",
      article: "11",
      ambigu: null,
    });
  });
});
