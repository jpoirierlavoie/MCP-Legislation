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
  domain: "penal",
  jurisdiction: "ca",
});

const WAVE3_LAWS: LawRow[] = [
  makeLaw({
    id: "ca-c-46",
    name_fr: "Code criminel",
    official_cite: "L.R.C. (1985), ch. C-46",
    official_cite_en: "R.S.C. 1985, c. C-46",
    fonction: "loi",
    unit: "article",
  }),
  makeLaw({
    id: "ca-c-38.8",
    name_fr: "Loi réglementant certaines drogues et autres substances",
    official_cite: "L.C. 1996, ch. 19",
    official_cite_en: "S.C. 1996, c. 19",
    fonction: "loi",
    unit: "article",
  }),
  makeLaw({
    id: "ca-y-1.5",
    name_fr: "Loi sur le système de justice pénale pour les adolescents",
    official_cite: "L.C. 2002, ch. 1",
    official_cite_en: "S.C. 2002, c. 1",
    fonction: "loi",
    unit: "article",
  }),
];

describe("parseCitation — Vague 3 (silo criminel fédéral)", () => {
  it("résout Code criminel, C.cr., Cr.C., articles décimaux et citations L.R.C.", () => {
    expect(parseCitation("art. 487.0551 C.cr.", WAVE3_LAWS)).toMatchObject({
      law: "ca-c-46",
      article: "487.0551",
      ambigu: null,
    });
    expect(parseCitation("Criminal Code, s. 320.14", WAVE3_LAWS)).toMatchObject({
      law: "ca-c-46",
      article: "320.14",
      ambigu: null,
    });
    expect(parseCitation("s. 718 Cr.C.", WAVE3_LAWS)).toMatchObject({
      law: "ca-c-46",
      article: "718",
      ambigu: null,
    });
    expect(parseCitation("L.R.C. (1985), ch. C-46, art. 265", WAVE3_LAWS)).toMatchObject({
      law: "ca-c-46",
      article: "265",
      ambigu: null,
    });
    expect(parseCitation("R.S.C. 1985, c. C-46, s. 265", WAVE3_LAWS)).toMatchObject({
      law: "ca-c-46",
      article: "265",
      ambigu: null,
    });
    expect(parseCitation("Code criminel, Formule 1", WAVE3_LAWS)).toMatchObject({
      law: "ca-c-46",
      article: "formule-1",
      ambigu: null,
    });
    expect(parseCitation("Criminal Code, Form 1", WAVE3_LAWS)).toMatchObject({
      law: "ca-c-46",
      article: "form-1",
      ambigu: null,
    });
  });

  it("résout LRCDAS / CDSA et LSJPA / YCJA en français et en anglais", () => {
    expect(parseCitation("L.R.C.D.A.S., art. 5", WAVE3_LAWS)).toMatchObject({
      law: "ca-c-38.8",
      article: "5",
      ambigu: null,
    });
    expect(parseCitation("L.C. 1996, ch. 19, art. 4", WAVE3_LAWS)).toMatchObject({
      law: "ca-c-38.8",
      article: "4",
      ambigu: null,
    });
    expect(parseCitation("C.D.S.A., Schedule I", WAVE3_LAWS)).toMatchObject({
      law: "ca-c-38.8",
      article: "annexe-i",
      ambigu: null,
    });
    expect(parseCitation("L.S.J.P.A., art. 42", WAVE3_LAWS)).toMatchObject({
      law: "ca-y-1.5",
      article: "42",
      ambigu: null,
    });
    expect(parseCitation("L.C. 2002, ch. 1, art. 42", WAVE3_LAWS)).toMatchObject({
      law: "ca-y-1.5",
      article: "42",
      ambigu: null,
    });
    expect(parseCitation("Y.C.J.A., s. 38", WAVE3_LAWS)).toMatchObject({
      law: "ca-y-1.5",
      article: "38",
      ambigu: null,
    });
  });

  it("refuse quand CRIMINAL_CORPUS est fermé (absentes de `laws`) et ne mord pas sur C.c.B.-C.", () => {
    expect(parseCitation("art. 265 C.cr.", []).law).toBeNull();
    expect(parseCitation("art. 1053 C.c.B.-C.", WAVE3_LAWS).law).toBeNull();
    expect(parseCitation("art. 1053 C.c.", WAVE3_LAWS).law).toBeNull();
  });
});
