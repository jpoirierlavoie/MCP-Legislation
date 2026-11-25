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
    id: "ca-const-1867",
    name_fr: "Loi constitutionnelle de 1867",
    official_cite: "Loi constitutionnelle de 1867",
    official_cite_en: "Constitution Act, 1867",
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
];

describe("parseCitation — Lois constitutionnelles de 1867 et 1982 et Chartes", () => {
  it("résout les formes officielles, regnales et abréviations de 1867", () => {
    expect(
      parseCitation("Loi constitutionnelle de 1867, 30 & 31 Vict., c. 3 (R.-U.), art. 91", LAWS),
    ).toMatchObject({ law: "ca-const-1867", article: "91", ambigu: null });

    expect(parseCitation("Constitution Act, 1867, s. 92A", LAWS)).toMatchObject({
      law: "ca-const-1867",
      article: "92A",
      ambigu: null,
    });

    expect(parseCitation("art. 90Q.1 L.C. 1867", LAWS)).toMatchObject({
      law: "ca-const-1867",
      article: "90Q.1",
      ambigu: null,
    });

    expect(parseCitation("A.A.N.B., art. 96", LAWS)).toMatchObject({
      law: "ca-const-1867",
      article: "96",
      ambigu: null,
    });

    expect(parseCitation("B.N.A. Act, s. 93", LAWS)).toMatchObject({
      law: "ca-const-1867",
      article: "93",
      ambigu: null,
    });

    expect(parseCitation("L.R.C. (1985), app. II, no 5, art. 133", LAWS)).toMatchObject({
      law: "ca-const-1867",
      article: "133",
      ambigu: null,
    });

    expect(
      parseCitation(
        "Constitution Act, 1867, 30 & 31 Vict., c. 3 (U.K.), R.S.C. 1985, App. II, No. 5, s. 129",
        LAWS,
      ),
    ).toMatchObject({ law: "ca-const-1867", article: "129", ambigu: null });

    expect(
      parseCitation("Première annexe de la Loi constitutionnelle de 1867", LAWS),
    ).toMatchObject({
      law: "ca-const-1867",
      article: "annexe-1",
      ambigu: null,
    });

    expect(parseCitation("Sixth Schedule to the Constitution Act, 1867", LAWS)).toMatchObject({
      law: "ca-const-1867",
      article: "annexe-6",
      ambigu: null,
    });

    expect(parseCitation("Loi constitutionnelle de 1867, préambule", LAWS)).toMatchObject({
      law: "ca-const-1867",
      article: "preambule",
      ambigu: null,
    });
  });

  it("résout les formes officielles et abréviations de 1982 et la Charte canadienne", () => {
    expect(
      parseCitation("art. 7 de la Charte canadienne des droits et libertés", LAWS),
    ).toMatchObject({
      law: "ca-const-1982",
      article: "7",
      ambigu: null,
    });

    expect(parseCitation("Canadian Charter, s. 2(b)", LAWS)).toMatchObject({
      law: "ca-const-1982",
      article: "2",
      ambigu: null,
    });

    expect(parseCitation("s. 52(1) of the Constitution Act, 1982", LAWS)).toMatchObject({
      law: "ca-const-1982",
      article: "52",
      ambigu: null,
    });

    expect(
      parseCitation(
        "Constitution Act, 1982, Schedule B to the Canada Act 1982 (U.K.), 1982, c. 11, s. 35",
        LAWS,
      ),
    ).toMatchObject({ law: "ca-const-1982", article: "35", ambigu: null });

    expect(parseCitation("L.C. 1982, art. 24", LAWS)).toMatchObject({
      law: "ca-const-1982",
      article: "24",
      ambigu: null,
    });

    expect(parseCitation("Annexe de la Loi constitutionnelle de 1982", LAWS)).toMatchObject({
      law: "ca-const-1982",
      article: "annexe",
      ambigu: null,
    });

    expect(parseCitation("Constitution Acts, 1867 to 1982, s. 1", LAWS)).toMatchObject({
      law: null,
      article: "1",
    });
    expect(
      parseCitation("Constitution Acts, 1867 to 1982, s. 1", LAWS).ambigu?.map((c) => c.id),
    ).toEqual(["ca-const-1867", "ca-const-1982"]);
  });

  it("distingue la Charte québécoise et signale l'ambiguïté sur « Charte » nu", () => {
    expect(parseCitation("Charte québécoise, art. 4", LAWS)).toMatchObject({
      law: "c-12",
      article: "4",
      ambigu: null,
    });

    expect(
      parseCitation("Charte des droits et libertés de la personne, art. 49", LAWS),
    ).toMatchObject({
      law: "c-12",
      article: "49",
      ambigu: null,
    });

    expect(parseCitation("Quebec Charter, s. 10", LAWS)).toMatchObject({
      law: "c-12",
      article: "10",
      ambigu: null,
    });

    const ambFr = parseCitation("art. 7 de la Charte", LAWS);
    expect(ambFr.law).toBeNull();
    expect(ambFr.article).toBe("7");
    expect(ambFr.ambigu?.map((c) => c.id)).toEqual(["c-12", "ca-const-1982"]);

    const ambEn = parseCitation("s. 1 of the Charter", LAWS);
    expect(ambEn.law).toBeNull();
    expect(ambEn.article).toBe("1");
    expect(ambEn.ambigu?.map((c) => c.id)).toEqual(["c-12", "ca-const-1982"]);

    // Lorsque PDF_CORPUS='0', ca-const-1982 est absent de `laws` : repli déterministe sur c-12 seul
    const sansPdf = LAWS.filter((l) => !l.id.startsWith("ca-const-"));
    expect(parseCitation("art. 7 de la Charte", sansPdf)).toMatchObject({
      law: "c-12",
      article: "7",
      ambigu: null,
    });
  });

  it("rejette les faux positifs : lois annuelles L.C. et Charte de la langue française", () => {
    expect(parseCitation("L.C. 2009, ch. 23, art. 5", LAWS)).toMatchObject({
      law: null,
      ambigu: null,
    });

    expect(parseCitation("art. 55 de la Charte de la langue française", LAWS)).toMatchObject({
      law: null,
      ambigu: null,
    });
  });
});
