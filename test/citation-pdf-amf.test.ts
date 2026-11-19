import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { citationOf, type LawRow, parseCitation, parseLinks, unitLabel } from "../src/lib";
import { construireOutils } from "../src/tools";

const db = () => (env as unknown as { DB: D1Database }).DB;

const PROD_LAWS = [
  {
    id: "cpc",
    name_fr: "Code de procédure civile",
    official_cite: "RLRQ, c. C-25.01",
    official_cite_en: "CQLR, c. C-25.01",
    fonction: "loi",
    unit: "article",
  },
  {
    id: "ccq",
    name_fr: "Code civil du Québec",
    official_cite: "RLRQ, c. CCQ-1991",
    official_cite_en: "CQLR, c. CCQ-1991",
    fonction: "loi",
    unit: "article",
  },
  {
    id: "ca-c-36",
    name_fr: "Loi sur les arrangements avec les créanciers des compagnies",
    official_cite: "L.R.C. (1985), ch. C-36",
    official_cite_en: "R.S.C., 1985, c. C-36",
    fonction: "loi",
    unit: "article",
  },
  {
    id: "qccs-dist-mtl",
    name_fr: "Directives de la Cour supérieure — District de Montréal",
    official_cite: "Directives C.S. (District de Montréal)",
    fonction: "directive",
    unit: "paragraphe",
  },
  {
    id: "qccs-div-mtl",
    name_fr: "Directives de la Cour supérieure — Division de Montréal",
    official_cite: "Directives C.S. (Division de Montréal)",
    fonction: "directive",
    unit: "paragraphe",
  },
  {
    id: "qccs-div-qc",
    name_fr: "Directives de la juge en chef associée pour la division de Québec",
    official_cite: "Directives C.S. (Division de Québec)",
    fonction: "directive",
    unit: "paragraphe",
  },
  {
    id: "qccq-regles-simplifiees",
    name_fr:
      "Directive concernant la gestion de l'instance régie par les règles simplifiées particulières",
    official_cite: "Directive C.Q. (Règles simplifiées particulières)",
    fonction: "directive",
    unit: "paragraphe",
  },
  {
    id: "qccq-mtl-prat-civile",
    name_fr:
      "Mode de fonctionnement — Division de pratique civile — District de Montréal (Salles 2.06 et 2.02)",
    official_cite: "Mode de fonctionnement C.Q. Montréal (Pratique civile)",
    fonction: "directive",
    unit: "paragraphe",
  },
  {
    id: "qccq-mtl-prat-admin",
    name_fr:
      "Mode de fonctionnement — Division de pratique administrative — District de Montréal (Salle 13.09)",
    official_cite: "Mode de fonctionnement C.Q. Montréal (Pratique administrative)",
    fonction: "directive",
    unit: "paragraphe",
  },
  {
    id: "qccq-daa-jurisprudence",
    name_fr:
      "Directive concernant la liste commune de jurisprudence — Division administrative et d'appel",
    official_cite: "Directive C.Q. (DAA — Liste commune de jurisprudence)",
    fonction: "directive",
    unit: "paragraphe",
  },
  {
    id: "v-1.1-r.10",
    name_fr: "Règlement 31-103 sur les obligations et dispenses d'inscription",
    official_cite: "RLRQ, c. V-1.1, r. 10",
    official_cite_en: "CQLR, c. V-1.1, r. 10",
    fonction: "reglement",
    unit: "article",
  },
  {
    id: "v-1.1-r.21",
    name_fr: "Règlement 45-106 sur les dispenses de prospectus",
    official_cite: "RLRQ, c. V-1.1, r. 21",
    official_cite_en: "CQLR, c. V-1.1, r. 21",
    fonction: "reglement",
    unit: "article",
  },
  {
    id: "v-1.1-r.24",
    name_fr: "Règlement 51-102 sur les obligations d'information continue",
    official_cite: "RLRQ, c. V-1.1, r. 24",
    official_cite_en: "CQLR, c. V-1.1, r. 24",
    fonction: "reglement",
    unit: "article",
  },
  {
    id: "amf-ig-31-103",
    name_fr: "Instruction générale relative au Règlement 31-103",
    official_cite: "Instruction générale 31-103",
    official_cite_en: "Policy Statement 31-103",
    fonction: "orientation",
    unit: "article",
  },
  {
    id: "amf-ig-45-106",
    name_fr: "Instruction générale relative au Règlement 45-106",
    official_cite: "Instruction générale 45-106",
    official_cite_en: "Policy Statement 45-106",
    fonction: "orientation",
    unit: "article",
  },
  {
    id: "amf-ig-51-102",
    name_fr: "Instruction générale relative au Règlement 51-102",
    official_cite: "Instruction générale 51-102",
    official_cite_en: "Policy Statement 51-102",
    fonction: "orientation",
    unit: "article",
  },
] as unknown as LawRow[];

describe("unitLabel & citationOf avec paragraphe", () => {
  it("rend par./para. pour paragraphe, art./s. pour article, règle/rule pour regle", () => {
    expect(unitLabel("paragraphe", "fr")).toBe("par.");
    expect(unitLabel("paragraphe", "en")).toBe("para.");
    expect(unitLabel("article", "fr")).toBe("art.");
    expect(unitLabel("article", "en")).toBe("s.");
    expect(unitLabel("regle", "fr")).toBe("règle");
    expect(unitLabel("regle", "en")).toBe("rule");

    const dir = {
      official_cite: "Directives C.S. Montréal",
      official_cite_en: "S.C. Directives Montréal",
      unit: "paragraphe",
    } as unknown as LawRow;
    expect(citationOf(dir, "12", "fr")).toBe("Directives C.S. Montréal, par. 12");
    expect(citationOf(dir, "12", "en")).toBe("S.C. Directives Montréal, para. 12");
  });
});

describe("parseCitation — désambiguïsation PDF / AMF et marqueurs", () => {
  it("prend en charge par./para./dir./règle/§ et les numéros alphanumériques", () => {
    expect(
      parseCitation("Directives C.S. (District de Montréal), par. 115.1", PROD_LAWS),
    ).toMatchObject({
      law: "qccs-dist-mtl",
      article: "115.1",
      ambigu: null,
    });
    expect(
      parseCitation("Directives C.S. Division de Montréal, para. 42", PROD_LAWS),
    ).toMatchObject({
      law: "qccs-div-mtl",
      article: "42",
      ambigu: null,
    });
    expect(parseCitation("Directives C.S. Québec (2022), § 3.2", PROD_LAWS)).toMatchObject({
      law: "qccs-div-qc",
      article: "3.2",
      ambigu: null,
    });
    expect(parseCitation("Règlement 45-106, art. 5A.6", PROD_LAWS)).toMatchObject({
      law: "v-1.1-r.21",
      article: "5A.6",
      ambigu: null,
    });
    expect(parseCitation("IG 31-103, art. 13.2.01", PROD_LAWS)).toMatchObject({
      law: "amf-ig-31-103",
      article: "13.2.01",
      ambigu: null,
    });
  });

  it("refuse les citations ambiguës QCCS et QCCQ et garde C.S. hors de s.", () => {
    const cs = parseCitation("Directives C.S., par. 12", PROD_LAWS);
    expect(cs.law).toBeNull();
    expect(cs.article).toBe("12");
    expect(cs.ambigu?.map((a) => a.id).sort()).toEqual([
      "qccs-dist-mtl",
      "qccs-div-mtl",
      "qccs-div-qc",
    ]);

    const mtl = parseCitation("Directives C.S. Montréal, par. 12", PROD_LAWS);
    expect(mtl.law).toBeNull();
    expect(mtl.ambigu?.map((a) => a.id).sort()).toEqual(["qccs-dist-mtl", "qccs-div-mtl"]);

    const csBare = parseCitation("Directives C.S. 115", PROD_LAWS);
    expect(csBare.law).toBeNull();
    expect(csBare.article).toBe("115");
    expect(csBare.ambigu?.length).toBe(3);

    const cq = parseCitation(
      "Mode de fonctionnement C.Q. Montréal Pratique civile, par. 2.1",
      PROD_LAWS,
    );
    expect(cq.law).toBe("qccq-mtl-prat-civile");
    expect(cq.article).toBe("2.1");
    expect(cq.ambigu).toBeNull();
  });

  it("sépare strictement Règlement vs Instruction générale et refuse le nu", () => {
    expect(
      parseCitation("Instruction générale relative au Règlement 45-106, art. 1.1", PROD_LAWS).law,
    ).toBe("amf-ig-45-106");
    expect(
      parseCitation("Policy Statement to Regulation 51-102, s. 4A.1", PROD_LAWS),
    ).toMatchObject({
      law: "amf-ig-51-102",
      article: "4A.1",
      ambigu: null,
    });
    expect(parseCitation("Règlement 51-102, art. 4B.2", PROD_LAWS)).toMatchObject({
      law: "v-1.1-r.24",
      article: "4B.2",
      ambigu: null,
    });
    const nu = parseCitation("45-106, art. 2.4", PROD_LAWS);
    expect(nu.law).toBeNull();
    expect(nu.article).toBe("2.4");
    expect(nu.ambigu?.map((a) => a.id).sort()).toEqual(["amf-ig-45-106", "v-1.1-r.21"]);
  });

  it("ne fuit pas les PDF quand ils sont absents de laws (PDF_CORPUS='0') et garde les invariants", () => {
    const sansPdf = PROD_LAWS.filter((l) => !l.id.startsWith("qcc") && !l.id.startsWith("amf-ig-"));
    const dir = parseCitation("Directives C.S., par. 12", sansPdf);
    expect(dir.law).toBeNull();
    expect(dir.ambigu).toBeNull();

    const ig = parseCitation("IG 45-106, art. 2A.1", sansPdf);
    expect(ig.law).toBeNull();
    expect(ig.ambigu).toBeNull();

    // Sans v-1.1-r.21 (ex. PDF_CORPUS="0"), V-1.1 ne doit PAS avaler ", r. 21"
    const noPdfLaws: LawRow[] = [
      ...PROD_LAWS.filter(
        (l) => l.id !== "v-1.1-r.21" && !l.id.startsWith("qcc") && !l.id.startsWith("amf-ig-"),
      ),
      {
        id: "v-1.1",
        name_fr: "Loi sur les valeurs mobilières",
        official_cite: "RLRQ, c. V-1.1",
        official_cite_en: "CQLR, c. V-1.1",
        fonction: "loi",
        unit: "article",
      } as unknown as LawRow,
    ];
    expect(parseCitation("RLRQ, c. V-1.1, r. 21, art. 1", noPdfLaws)).toMatchObject({
      law: null,
      chapitre_inconnu: "V-1.1, r. 21",
      article: "1",
    });
    expect(parseCitation("RLRQ, c. V-1.1 r. 21, art. 1", noPdfLaws)).toMatchObject({
      law: null,
      chapitre_inconnu: "V-1.1 r. 21",
      article: "1",
    });
    expect(parseCitation("RLRQ, c. V-1.1, art. 1", noPdfLaws)).toMatchObject({
      law: "v-1.1",
      article: "1",
      chapitre_inconnu: null,
    });

    // QCCQ narrow() inconditionnel et sans collision avec qccq-daa-jurisprudence
    expect(
      parseCitation("Directive C.Q. pratique administrative, par. 1", PROD_LAWS),
    ).toMatchObject({
      law: "qccq-mtl-prat-admin",
      article: "1",
      ambigu: null,
    });
    expect(
      parseCitation("Mode de fonctionnement C.Q. Salle 13.09, par. 1", PROD_LAWS),
    ).toMatchObject({
      law: "qccq-mtl-prat-admin",
      article: "1",
      ambigu: null,
    });
    expect(
      parseCitation(
        "Directive C.Q. pratique administrative, par. 1",
        PROD_LAWS.filter((l) => l.id !== "qccq-mtl-prat-admin"),
      ),
    ).toMatchObject({
      law: null,
      ambigu: null,
      article: "1",
    });
    expect(parseCitation("Directive C.Q. pratique civile, par. 1", PROD_LAWS)).toMatchObject({
      law: "qccq-mtl-prat-civile",
      article: "1",
      ambigu: null,
    });
    expect(
      parseCitation("Mode de fonctionnement C.Q. Salle 2.06, par. 1", PROD_LAWS),
    ).toMatchObject({
      law: "qccq-mtl-prat-civile",
      article: "1",
      ambigu: null,
    });
    expect(
      parseCitation(
        "Directive C.Q. pratique civile, par. 1",
        PROD_LAWS.filter((l) => l.id !== "qccq-mtl-prat-civile"),
      ),
    ).toMatchObject({
      law: null,
      ambigu: null,
      article: "1",
    });

    const synth1Qccq = PROD_LAWS.filter((l) => l.id === "qccq-mtl-prat-civile");
    expect(
      parseCitation("Directive C.Q. pratique administrative, par. 1", synth1Qccq),
    ).toMatchObject({
      law: null,
      ambigu: null,
      article: "1",
    });
    expect(
      parseCitation("Directive C.Q. pratique civile (Salle 13.09), par. 1", PROD_LAWS),
    ).toMatchObject({
      law: null,
      ambigu: null,
      article: "1",
    });
    expect(parseCitation("dir. C.Q., par. 5", PROD_LAWS).ambigu?.length).toBe(4);
    expect(parseCitation("Directives C.Q., par. 5", PROD_LAWS).ambigu?.length).toBe(4);

    expect(parseCitation("RLRQ, c. C-36, art. 1", PROD_LAWS).law).toBeNull();
    expect(parseCitation("article 110 du Code de procédure civile", PROD_LAWS).law).toBeNull();
    expect(parseCitation("art. 2 ancien C.p.c.", PROD_LAWS).hors_corpus).toBe("C-25");
  });

  it("refuse les districts/villes non ingérés sans rabattre sur Montréal et extrait annexe/numéro proprement", () => {
    for (const cit of [
      "Directives de la Cour supérieure — District de Laval, par. 12",
      "Directives de la Cour supérieure — District de Longueuil, par. 12",
      "Directives de la Cour supérieure — District de Sherbrooke, par. 12",
      "Directives de la Cour supérieure — District de Québec, par. 12",
      "Mode de fonctionnement de la Cour du Québec — District de Québec — Pratique civile, par. 5",
      "Directives C.Q. Laval, par. 5",
    ]) {
      const p = parseCitation(cit, PROD_LAWS);
      expect(p.law, cit).toBeNull();
      expect(p.ambigu, cit).toBeNull();
    }

    // Titres verbatim QCCQ + variantes C.Q. / CSA / ACVM
    expect(
      parseCitation(
        "Mode de fonctionnement — Division de pratique civile — District de Montréal (Salles 2.06 et 2.02), par. 5",
        PROD_LAWS,
      ),
    ).toMatchObject({ law: "qccq-mtl-prat-civile", article: "5", ambigu: null });

    expect(
      parseCitation(
        "Mode de fonctionnement — Division de pratique administrative — District de Montréal (Salle 13.09), par. 5",
        PROD_LAWS,
      ),
    ).toMatchObject({ law: "qccq-mtl-prat-admin", article: "5", ambigu: null });

    expect(parseCitation("C.Q. Règles simplifiées, par. 5", PROD_LAWS)).toMatchObject({
      law: "qccq-regles-simplifiees",
      article: "5",
      ambigu: null,
    });

    expect(parseCitation("N.I. 45-106, s. 2.3", PROD_LAWS)).toMatchObject({
      law: "v-1.1-r.21",
      article: "2.3",
      ambigu: null,
    });

    expect(parseCitation("Norme canadienne 45-106, art. 2.3", PROD_LAWS)).toMatchObject({
      law: "v-1.1-r.21",
      article: "2.3",
      ambigu: null,
    });

    // Step 4 : sans marqueur d'article, les identifiants de règlement, salles, dates et annexes ne polluent pas
    expect(parseCitation("Règlement 45-106 (RLRQ, c. V-1.1, r. 21) 2.1", PROD_LAWS)).toMatchObject({
      law: "v-1.1-r.21",
      article: "2.1",
      ambigu: null,
    });
    expect(parseCitation("RLRQ, c. V-1.1, r. 21 (Règlement 45-106) 2.1", PROD_LAWS)).toMatchObject({
      law: "v-1.1-r.21",
      article: "2.1",
      ambigu: null,
    });
    expect(
      parseCitation(
        "Mode de fonctionnement C.Q. Montréal (Pratique civile) Salles 2.06 et 2.02, 5",
        PROD_LAWS,
      ),
    ).toMatchObject({ law: "qccq-mtl-prat-civile", article: "5", ambigu: null });
    expect(
      parseCitation(
        "Mode de fonctionnement C.Q. Montréal (Pratique administrative) Salle 13.09, 5",
        PROD_LAWS,
      ),
    ).toMatchObject({ law: "qccq-mtl-prat-admin", article: "5", ambigu: null });
    expect(
      parseCitation("Directives C.S. District de Montréal, 23 février 2026, 12", PROD_LAWS),
    ).toMatchObject({ law: "qccs-dist-mtl", article: "12", ambigu: null });
    expect(
      parseCitation("Directives C.S. District de Montréal, annexe-1", PROD_LAWS),
    ).toMatchObject({ law: "qccs-dist-mtl", article: "annexe-1", ambigu: null });
  });

  it("Round 2 Tier 5 : 4A.1/5A.1 sans art., IG parenthésée, Annexe 45-106A1, C.S./C.Q. du Québec, DAA, Salles virgule", () => {
    // 1) Alphanumérique CSA/AMF sans préfixe art. : a./s. lookbehind inclut 0-9
    expect(parseCitation("RLRQ, c. V-1.1, r. 21, 5A.1", PROD_LAWS)).toMatchObject({
      law: "v-1.1-r.21",
      article: "5A.1",
      ambigu: null,
    });
    expect(parseCitation("RLRQ, c. V-1.1, r. 24, 4A.1", PROD_LAWS)).toMatchObject({
      law: "v-1.1-r.24",
      article: "4A.1",
      ambigu: null,
    });
    expect(parseCitation("Instruction générale 51-102, 4A.1", PROD_LAWS)).toMatchObject({
      law: "amf-ig-51-102",
      article: "4A.1",
      ambigu: null,
    });
    expect(parseCitation("Instruction générale 45-106, 2A.1", PROD_LAWS)).toMatchObject({
      law: "amf-ig-45-106",
      article: "2A.1",
      ambigu: null,
    });

    // 2a) IG / Policy Statement avec (RLRQ, c. V-1.1, r. 21) entre parenthèses vs Règlement nu
    expect(
      parseCitation(
        "Instruction générale relative au Règlement 45-106 (RLRQ, c. V-1.1, r. 21), art. 2.1",
        PROD_LAWS,
      ),
    ).toMatchObject({ law: "amf-ig-45-106", article: "2.1", ambigu: null });
    expect(
      parseCitation(
        "Policy Statement to Regulation 45-106 (CQLR, c. V-1.1, r. 21), s. 2.1",
        PROD_LAWS,
      ),
    ).toMatchObject({ law: "amf-ig-45-106", article: "2.1", ambigu: null });
    expect(
      parseCitation("Instruction générale relative à RLRQ, c. V-1.1, r. 21, art. 2.1", PROD_LAWS),
    ).toMatchObject({ law: "amf-ig-45-106", article: "2.1", ambigu: null });
    expect(
      parseCitation("Règlement 45-106 (RLRQ, c. V-1.1, r. 21), art. 2.1", PROD_LAWS),
    ).toMatchObject({ law: "v-1.1-r.21", article: "2.1", ambigu: null });

    const sansPdf = PROD_LAWS.filter((l) => !l.id.startsWith("qcc") && !l.id.startsWith("amf-ig-"));
    expect(
      parseCitation(
        "Instruction générale relative au Règlement 45-106 (RLRQ, c. V-1.1, r. 21), art. 2.1",
        sansPdf.filter((l) => l.id !== "v-1.1-r.21"),
      ).law,
    ).toBeNull();

    // 2b) Annexe 45-106A1 / 31-103A1 / 51-102A6E non tronquée par extraStrip/STRIP_DATES_ET_SALLES
    expect(parseCitation("Règlement 45-106, Annexe 45-106A1", PROD_LAWS)).toMatchObject({
      law: "v-1.1-r.21",
      article: "annexe-45-106a1",
      ambigu: null,
    });
    expect(parseCitation("Règlement 31-103, Annexe 31-103A1", PROD_LAWS)).toMatchObject({
      law: "v-1.1-r.10",
      article: "annexe-31-103a1",
      ambigu: null,
    });
    expect(parseCitation("Règlement 51-102, Annexe 51-102A6E", PROD_LAWS)).toMatchObject({
      law: "v-1.1-r.24",
      article: "annexe-51-102a6e",
      ambigu: null,
    });

    // 3) C.S. du Québec / C.Q. du Québec / DAA
    expect(
      parseCitation("Directives C.S. du Québec — Division de Montréal, par. 12", PROD_LAWS),
    ).toMatchObject({ law: "qccs-div-mtl", article: "12", ambigu: null });
    expect(
      parseCitation("Directives de la C.S. du Québec — District de Montréal, par. 12", PROD_LAWS),
    ).toMatchObject({ law: "qccs-dist-mtl", article: "12", ambigu: null });
    expect(
      parseCitation("Directives C.S. du Québec (District de Montréal), par. 12", PROD_LAWS),
    ).toMatchObject({ law: "qccs-dist-mtl", article: "12", ambigu: null });
    expect(
      parseCitation("Directives C.S. du Québec — Division de Québec, par. 12", PROD_LAWS),
    ).toMatchObject({ law: "qccs-div-qc", article: "12", ambigu: null });
    const csQcAmbigu = parseCitation("Directives C.S. du Québec, par. 12", PROD_LAWS);
    expect(csQcAmbigu.law).toBeNull();
    expect(csQcAmbigu.article).toBe("12");
    expect(csQcAmbigu.ambigu?.map((a) => a.id).sort()).toEqual([
      "qccs-dist-mtl",
      "qccs-div-mtl",
      "qccs-div-qc",
    ]);

    expect(
      parseCitation("Directives C.Q. du Québec — Pratique civile, par. 1", PROD_LAWS),
    ).toMatchObject({ law: "qccq-mtl-prat-civile", article: "1", ambigu: null });
    expect(
      parseCitation("Directives C.Q. du Québec — Règles simplifiées, par. 1", PROD_LAWS),
    ).toMatchObject({ law: "qccq-regles-simplifiees", article: "1", ambigu: null });
    expect(
      parseCitation("Directives C.Q. — Division administrative et d'appel, par. 1", PROD_LAWS),
    ).toMatchObject({ law: "qccq-daa-jurisprudence", article: "1", ambigu: null });

    // 4) Salles avec virgule sans espace avant virgule + Salle singulière
    expect(
      parseCitation(
        "Mode de fonctionnement — Division de pratique civile — District de Montréal (Salles 2.06, 2.02), 5",
        PROD_LAWS,
      ),
    ).toMatchObject({ law: "qccq-mtl-prat-civile", article: "5", ambigu: null });
    expect(
      parseCitation(
        "Mode de fonctionnement — Division de pratique civile — District de Montréal (Salles 2.06, 2.02), 2.1",
        PROD_LAWS,
      ),
    ).toMatchObject({ law: "qccq-mtl-prat-civile", article: "2.1", ambigu: null });
    expect(
      parseCitation(
        "Mode de fonctionnement C.Q. Montréal (Pratique administrative) Salle 13.09, 2.1",
        PROD_LAWS,
      ),
    ).toMatchObject({ law: "qccq-mtl-prat-admin", article: "2.1", ambigu: null });

    // 5) note-preliminaire citationOf
    const reg21 = PROD_LAWS.find((l) => l.id === "v-1.1-r.21")!;
    expect(citationOf(reg21, "note-preliminaire", "fr")).toBe(
      "RLRQ, c. V-1.1, r. 21, note préliminaire",
    );
    expect(citationOf(reg21, "note-preliminaire", "en")).toBe(
      "CQLR, c. V-1.1, r. 21, preliminary note",
    );
  });

  it("Round 3 Tier 5 : C.1 (IG + c. V-1.1, r. 21 / RLRQ c. V-1.1, r. 21), C.2 (3+ Salles virgule), C.3 (juge en chef associée)", () => {
    // C.1 — IG avec citation RLRQ/c. sans virgule ou entre parenthèses -> jamais "1" de V-1.1
    expect(
      parseCitation("Instruction générale relative à c. V-1.1, r. 21, 2.1", PROD_LAWS),
    ).toMatchObject({ law: "amf-ig-45-106", article: "2.1", ambigu: null });
    expect(
      parseCitation(
        "Instruction générale relative au Règlement 45-106 (c. V-1.1, r. 21), 2.1",
        PROD_LAWS,
      ),
    ).toMatchObject({ law: "amf-ig-45-106", article: "2.1", ambigu: null });
    expect(
      parseCitation(
        "Instruction générale relative au Règlement 45-106, RLRQ c. V-1.1, r. 21, 2.1",
        PROD_LAWS,
      ),
    ).toMatchObject({ law: "amf-ig-45-106", article: "2.1", ambigu: null });
    expect(
      parseCitation("Policy Statement 45-106, CQLR c. V-1.1, r. 21, 2.1", PROD_LAWS),
    ).toMatchObject({ law: "amf-ig-45-106", article: "2.1", ambigu: null });
    // Non-régression citations législatives classiques
    expect(parseCitation("c. C-25.01, art. 1", PROD_LAWS)).toMatchObject({
      law: "cpc",
      article: "1",
      ambigu: null,
    });
    expect(parseCitation("RLRQ, c. V-1.1, r. 21, 5A.1", PROD_LAWS)).toMatchObject({
      law: "v-1.1-r.21",
      article: "5A.1",
      ambigu: null,
    });
    expect(parseCitation("L.R.C. 1985, c. C-36, art. 11", PROD_LAWS)).toMatchObject({
      law: null,
      article: "11",
      chapitre_inconnu: "C-36",
    });

    // C.2 — 3+ salles séparées par des virgules sans « et » ni « par. »
    expect(
      parseCitation(
        "Mode de fonctionnement C.Q. Montréal (Pratique civile) Salles 2.06, 2.02, 2.03, 5",
        PROD_LAWS,
      ),
    ).toMatchObject({ law: "qccq-mtl-prat-civile", article: "5", ambigu: null });
    expect(
      parseCitation(
        "Mode de fonctionnement C.Q. Montréal (Pratique civile) Salles 2.06, 2.02, 2.1, 5",
        PROD_LAWS,
      ),
    ).toMatchObject({ law: "qccq-mtl-prat-civile", article: "5", ambigu: null });
    expect(
      parseCitation(
        "Mode de fonctionnement C.Q. Montréal (Pratique civile) Salles 2.06, 2.02, 2.03, par. 5",
        PROD_LAWS,
      ),
    ).toMatchObject({ law: "qccq-mtl-prat-civile", article: "5", ambigu: null });
    expect(
      parseCitation(
        "Mode de fonctionnement C.Q. Montréal (Pratique administrative) Salle 13.09, 5",
        PROD_LAWS,
      ),
    ).toMatchObject({ law: "qccq-mtl-prat-admin", article: "5", ambigu: null });
    expect(
      parseCitation(
        "Mode de fonctionnement C.Q. Montréal (Pratique civile) (Salles 2.06, 2.02), 5",
        PROD_LAWS,
      ),
    ).toMatchObject({ law: "qccq-mtl-prat-civile", article: "5", ambigu: null });
    expect(
      parseCitation(
        "Mode de fonctionnement C.Q. Montréal (Pratique civile) Salles 2.06 et 2.02, par. 5",
        PROD_LAWS,
      ),
    ).toMatchObject({ law: "qccq-mtl-prat-civile", article: "5", ambigu: null });

    // C.3 — Directives de la juge en chef associée -> qccs-div-qc sauf district/ville explicite
    expect(
      parseCitation("Directives de la juge en chef associée, par. 1", PROD_LAWS),
    ).toMatchObject({
      law: "qccs-div-qc",
      article: "1",
      ambigu: null,
    });
    expect(
      parseCitation(
        "Directives de la juge en chef associée — Division de Montréal, par. 1",
        PROD_LAWS,
      ),
    ).toMatchObject({ law: "qccs-div-mtl", article: "1", ambigu: null });
    expect(
      parseCitation("Directives de la juge en chef associée — Laval, par. 1", PROD_LAWS),
    ).toMatchObject({ law: null, article: "1", ambigu: null });
    expect(
      parseCitation(
        "Directives de la juge en chef associée — District de Québec, par. 1",
        PROD_LAWS,
      ),
    ).toMatchObject({ law: null, article: "1", ambigu: null });
  });

  it("Round 4 Tier 5 : annexe-division-*, Règlement/IG + RLRQ c. V-1.1, et ch./chapitre/chapter + lookbehind '.'", () => {
    const prodAvecV11: LawRow[] = [
      ...PROD_LAWS,
      {
        id: "v-1.1",
        name_fr: "Loi sur les valeurs mobilières",
        official_cite: "RLRQ, c. V-1.1",
        official_cite_en: "CQLR, c. V-1.1",
        fonction: "loi",
        unit: "article",
      } as unknown as LawRow,
    ];

    // Bug 1 : annexe-division-1..8 sur qccs-dist-mtl vs qccs-div-mtl
    expect(
      parseCitation("Directives C.S. District de Montréal, annexe-division-1", prodAvecV11),
    ).toMatchObject({ law: "qccs-dist-mtl", article: "annexe-division-1", ambigu: null });
    expect(
      parseCitation(
        "Directives de la Cour supérieure — District de Montréal, annexe-division-1",
        prodAvecV11,
      ),
    ).toMatchObject({ law: "qccs-dist-mtl", article: "annexe-division-1", ambigu: null });
    expect(
      parseCitation("Directives C.S. District de Montréal, annexe-division-8", prodAvecV11),
    ).toMatchObject({ law: "qccs-dist-mtl", article: "annexe-division-8", ambigu: null });
    expect(
      parseCitation("Directives C.S. Division de Montréal, annexe-division-1", prodAvecV11),
    ).toMatchObject({ law: "qccs-div-mtl", article: "annexe-division-1", ambigu: null });
    const ambDiv = parseCitation("Directives C.S. Montréal, annexe-division-1", prodAvecV11);
    expect(ambDiv.law).toBeNull();
    expect(ambDiv.article).toBe("annexe-division-1");
    expect(ambDiv.ambigu?.map((a) => a.id).sort()).toEqual(["qccs-dist-mtl", "qccs-div-mtl"]);

    // Bug 2 : Règlement ou IG mentionnant la loi habilitante (RLRQ, c. V-1.1) ne rabat jamais sur v-1.1
    expect(parseCitation("Règlement 45-106 (RLRQ, c. V-1.1), art. 1", prodAvecV11)).toMatchObject({
      law: "v-1.1-r.21",
      article: "1",
      ambigu: null,
    });
    expect(parseCitation("Règlement 45-106 (RLRQ, c. V-1.1), art. 2.1", prodAvecV11)).toMatchObject(
      { law: "v-1.1-r.21", article: "2.1", ambigu: null },
    );
    expect(
      parseCitation("Norme canadienne 51-102 (RLRQ, c. V-1.1), art. 1", prodAvecV11),
    ).toMatchObject({ law: "v-1.1-r.24", article: "1", ambigu: null });
    expect(
      parseCitation("National Instrument 31-103 (CQLR, c. V-1.1), s. 1.1", prodAvecV11),
    ).toMatchObject({ law: "v-1.1-r.10", article: "1.1", ambigu: null });
    expect(
      parseCitation("Norme multilatérale 45-106 (RLRQ, c. V-1.1), art. 1", prodAvecV11),
    ).toMatchObject({ law: "v-1.1-r.21", article: "1", ambigu: null });
    expect(parseCitation("IG 45-106 (RLRQ, c. V-1.1), 1", prodAvecV11)).toMatchObject({
      law: "amf-ig-45-106",
      article: "1",
      ambigu: null,
    });
    expect(parseCitation("IG 45-106 (RLRQ, c. V-1.1), 2.1", prodAvecV11)).toMatchObject({
      law: "amf-ig-45-106",
      article: "2.1",
      ambigu: null,
    });
    // Non-régression : la Loi sur les valeurs mobilières seule reste résolue sur v-1.1
    expect(
      parseCitation("Loi sur les valeurs mobilières (RLRQ, c. V-1.1), art. 1", prodAvecV11),
    ).toMatchObject({ law: "v-1.1", article: "1", ambigu: null });
    // Avec PDF_CORPUS="0" (ni Règlement ni IG PDF), ne rabat jamais silencieusement sur v-1.1
    const sansPdfAvecV11 = prodAvecV11.filter(
      (l) => !l.id.startsWith("qcc") && !l.id.startsWith("amf-ig-") && !l.id.startsWith("v-1.1-r."),
    );
    expect(
      parseCitation("Règlement 45-106 (RLRQ, c. V-1.1), art. 1", sansPdfAvecV11).law,
    ).toBeNull();
    expect(parseCitation("IG 45-106 (RLRQ, c. V-1.1), 1", sansPdfAvecV11).law).toBeNull();

    // Bug 3 : ch. / chapitre / chapter + lookbehind '.' empêchant d'extraire "1" de V-1.1
    expect(
      parseCitation("Instruction générale 45-106 (RLRQ, ch. V-1.1, r. 21), 2.1", prodAvecV11),
    ).toMatchObject({ law: "amf-ig-45-106", article: "2.1", ambigu: null });
    expect(
      parseCitation("Instruction générale 45-106 (chapitre V-1.1, r. 21), 2.1", prodAvecV11),
    ).toMatchObject({ law: "amf-ig-45-106", article: "2.1", ambigu: null });
    expect(
      parseCitation("Policy Statement 45-106 (chapter V-1.1, r. 21), 2.1", prodAvecV11),
    ).toMatchObject({ law: "amf-ig-45-106", article: "2.1", ambigu: null });
    expect(
      parseCitation("Instruction générale 31-103 (L.R.Q., ch. V-1.1, r. 10), 13.2.01", prodAvecV11),
    ).toMatchObject({ law: "amf-ig-31-103", article: "13.2.01", ambigu: null });
    expect(parseCitation("Instruction générale 45-106 (V-1.1), 2.1", prodAvecV11)).toMatchObject({
      law: "amf-ig-45-106",
      article: "2.1",
      ambigu: null,
    });
    expect(parseCitation("IG 45-106, art. 2.1", prodAvecV11)).toMatchObject({
      law: "amf-ig-45-106",
      article: "2.1",
      ambigu: null,
    });
    expect(parseCitation("IG 31-103, 13.2.01", prodAvecV11)).toMatchObject({
      law: "amf-ig-31-103",
      article: "13.2.01",
      ambigu: null,
    });
  });

  it("Round 5 Tier 5 : AMF L.R.Q./R.S.Q./nu (c. V-1.1), districts QC complets, 1ᵉʳ, Salles —/;, Annexe division/district", () => {
    const prodAvecV11: LawRow[] = [
      ...PROD_LAWS,
      {
        id: "v-1.1",
        name_fr: "Loi sur les valeurs mobilières",
        official_cite: "RLRQ, c. V-1.1",
        official_cite_en: "CQLR, c. V-1.1",
        fonction: "loi",
        unit: "article",
      } as unknown as LawRow,
    ];

    // Bug 1 : L.R.Q. / R.S.Q. -> Règlement ; (c. V-1.1) / (V-1.1) sans marqueur -> ambigu (jamais v-1.1)
    expect(parseCitation("45-106 (L.R.Q., c. V-1.1), art. 1", prodAvecV11)).toMatchObject({
      law: "v-1.1-r.21",
      article: "1",
      ambigu: null,
    });
    expect(parseCitation("45-106 (R.S.Q., c. V-1.1), s. 1", prodAvecV11)).toMatchObject({
      law: "v-1.1-r.21",
      article: "1",
      ambigu: null,
    });
    expect(parseCitation("31-103 (L.R.Q., c. V-1.1), art. 1.1", prodAvecV11)).toMatchObject({
      law: "v-1.1-r.10",
      article: "1.1",
      ambigu: null,
    });
    expect(parseCitation("45-106 (R.L.R.Q., c. V-1.1), art. 1", prodAvecV11)).toMatchObject({
      law: "v-1.1-r.21",
      article: "1",
      ambigu: null,
    });

    for (const [cit, expIds, expArt] of [
      ["45-106 (c. V-1.1), art. 2.1", ["amf-ig-45-106", "v-1.1-r.21"], "2.1"],
      ["45-106 (V-1.1), art. 1", ["amf-ig-45-106", "v-1.1-r.21"], "1"],
      ["51-102 (c. V-1.1), art. 1.1", ["amf-ig-51-102", "v-1.1-r.24"], "1.1"],
      ["31-103 (V-1.1), 1.1", ["amf-ig-31-103", "v-1.1-r.10"], "1.1"],
    ] as const) {
      const p = parseCitation(cit, prodAvecV11);
      expect(p.law, cit).toBeNull();
      expect(p.article, cit).toBe(expArt);
      expect(p.ambigu?.map((a) => a.id).sort(), cit).toEqual([...expIds]);
    }

    // Sous PDF_CORPUS="0", (c. V-1.1) avec 45-106 ne rabat pas sur v-1.1
    const sansPdfAvecV11 = prodAvecV11.filter(
      (l) => !l.id.startsWith("qcc") && !l.id.startsWith("amf-ig-") && !l.id.startsWith("v-1.1-r."),
    );
    expect(parseCitation("45-106 (c. V-1.1), art. 2.1", sansPdfAvecV11)).toMatchObject({
      law: null,
      article: "2.1",
      ambigu: null,
    });
    expect(parseCitation("45-106 (V-1.1), art. 1", sansPdfAvecV11)).toMatchObject({
      law: null,
      article: "1",
      ambigu: null,
    });
    // Non-régression : Loi sur les valeurs mobilières explicite reste sur v-1.1
    expect(
      parseCitation("Loi sur les valeurs mobilières (L.R.Q., c. V-1.1), art. 1", prodAvecV11),
    ).toMatchObject({ law: "v-1.1", article: "1", ambigu: null });

    // Bug 2 : districts judiciaires non ingérés refusés (jamais rabattus sur qccs-dist-mtl)
    for (const district of [
      "Mont-Laurier",
      "Cowansville",
      "La Malbaie",
      "Percé",
      "Montmagny",
      "Rivière-du-Loup",
      "Matane",
      "Chibougamau",
      "Amqui",
      "New Carlisle",
      "Campbell's Bay",
      "Havre-Saint-Pierre",
      "Sainte-Anne-des-Monts",
      "Lac-Mégantic",
      "Saint-Jean-sur-Richelieu",
      "Saint-Imaginaire",
    ]) {
      const cit = `Directives de la Cour supérieure — District de ${district}, par. 1`;
      const p = parseCitation(cit, prodAvecV11);
      expect(p.law, cit).toBeNull();
      expect(p.ambigu, cit).toBeNull();
      expect(p.article, cit).toBe("1");
    }
    expect(
      parseCitation(
        "Directives de la Cour supérieure — Division de Mont-Laurier, par. 1",
        prodAvecV11,
      ),
    ).toMatchObject({ law: null, ambigu: null, article: "1" });
    expect(
      parseCitation("Directives de la Cour supérieure — District d'Iberville, par. 1", prodAvecV11),
    ).toMatchObject({ law: null, ambigu: null, article: "1" });
    // Non-régression des 3 textes QCCS ingérés (FR et EN)
    expect(
      parseCitation("Directives de la Cour supérieure — District de Montréal, par. 1", prodAvecV11),
    ).toMatchObject({ law: "qccs-dist-mtl", article: "1", ambigu: null });
    expect(
      parseCitation(
        "Directives de la Cour supérieure — District of Montreal, para. 1",
        prodAvecV11,
      ),
    ).toMatchObject({ law: "qccs-dist-mtl", article: "1", ambigu: null });
    expect(
      parseCitation("Directives de la Cour supérieure — Division de Montréal, par. 1", prodAvecV11),
    ).toMatchObject({ law: "qccs-div-mtl", article: "1", ambigu: null });
    expect(
      parseCitation("Directives de la Cour supérieure — Division de Québec, par. 1", prodAvecV11),
    ).toMatchObject({ law: "qccs-div-qc", article: "1", ambigu: null });

    // Bug 3a : exposants Unicode 1ᵉʳ / 1ʳᵉ / 2ᵉ dans les dates françaises
    expect(
      parseCitation(
        "Directives de la Cour supérieure — District de Montréal (1\u1d49\u02b3 janvier 2026), 12",
        prodAvecV11,
      ),
    ).toMatchObject({ law: "qccs-dist-mtl", article: "12", ambigu: null });
    expect(
      parseCitation(
        "Directives de la Cour supérieure — Division de Montréal (1er janvier 2026), 10",
        prodAvecV11,
      ),
    ).toMatchObject({ law: "qccs-div-mtl", article: "10", ambigu: null });

    // Bug 3b : séparateurs ; — – - après listes de Salles
    for (const sep of ["—", "–", "-", ";"]) {
      const cit = `Mode de fonctionnement C.Q. Montréal (Pratique civile) Salles 2.06, 2.02 ${sep} 5`;
      expect(parseCitation(cit, prodAvecV11), cit).toMatchObject({
        law: "qccq-mtl-prat-civile",
        article: "5",
        ambigu: null,
      });
    }

    // Bug 4 : Annexe division <n> et Annexe district <n> séparés par des espaces
    expect(
      parseCitation("Directives C.S. District de Montréal, Annexe division 1", prodAvecV11),
    ).toMatchObject({ law: "qccs-dist-mtl", article: "annexe-division-1", ambigu: null });
    expect(
      parseCitation("Directives C.S. District de Montréal, Annexe division 8", prodAvecV11),
    ).toMatchObject({ law: "qccs-dist-mtl", article: "annexe-division-8", ambigu: null });
    expect(
      parseCitation("Directives C.S. District de Montréal, Annexe district 1", prodAvecV11),
    ).toMatchObject({ law: "qccs-dist-mtl", article: "annexe-district-1", ambigu: null });
    expect(
      parseCitation("Directives C.S. Division de Montréal, Annexe division 1", prodAvecV11),
    ).toMatchObject({ law: "qccs-div-mtl", article: "annexe-division-1", ambigu: null });
    expect(
      parseCitation("Directives C.S. District de Montréal, Annexe A1", prodAvecV11),
    ).toMatchObject({ law: "qccs-dist-mtl", article: "annexe-a1", ambigu: null });
    expect(parseCitation("Règlement 45-106, Annexe 45-106A1", prodAvecV11)).toMatchObject({
      law: "v-1.1-r.21",
      article: "annexe-45-106a1",
      ambigu: null,
    });
  });

  it("Round 6 Tier 5 : AMF + Loi V-1.1, Superior Court Directives / Quebec Division, Annexe accentuée & subdivisions, ch.", () => {
    const prodAvecV11: LawRow[] = [
      ...PROD_LAWS,
      {
        id: "v-1.1",
        name_fr: "Loi sur les valeurs mobilières",
        official_cite: "RLRQ, c. V-1.1",
        official_cite_en: "CQLR, c. V-1.1",
        fonction: "loi",
        unit: "article",
      } as unknown as LawRow,
    ];

    // 1) Règlement / IG AMF nommant la Loi sur les valeurs mobilières (RLRQ, c. V-1.1)
    expect(
      parseCitation(
        "Règlement 45-106 pris en vertu de la Loi sur les valeurs mobilières (RLRQ, c. V-1.1), art. 1",
        prodAvecV11,
      ),
    ).toMatchObject({ law: "v-1.1-r.21", article: "1", ambigu: null });
    expect(
      parseCitation(
        "IG 45-106 relative à la Loi sur les valeurs mobilières (RLRQ, c. V-1.1), art. 1.1",
        prodAvecV11,
      ),
    ).toMatchObject({ law: "amf-ig-45-106", article: "1.1", ambigu: null });
    expect(
      parseCitation(
        "Instruction générale relative au Règlement 45-106 pris en vertu de la Loi sur les valeurs mobilières (RLRQ, c. V-1.1), art. 2.1",
        prodAvecV11,
      ),
    ).toMatchObject({ law: "amf-ig-45-106", article: "2.1", ambigu: null });
    expect(
      parseCitation(
        "Policy Statement 45-106 under the Securities Act (CQLR, c. V-1.1), s. 1.1",
        prodAvecV11,
      ),
    ).toMatchObject({ law: "amf-ig-45-106", article: "1.1", ambigu: null });
    // Non-régression : la Loi sur les valeurs mobilières seule résout toujours vers v-1.1
    expect(
      parseCitation("Loi sur les valeurs mobilières (RLRQ, c. V-1.1), art. 1", prodAvecV11),
    ).toMatchObject({ law: "v-1.1", article: "1", ambigu: null });
    // Sous PDF_CORPUS="0" (sans règlements/IG PDF) : ni rabat sur v-1.1 ni faux chapitre_inconnu V-1.1
    const sansPdfAvecV11 = prodAvecV11.filter(
      (l) => !l.id.startsWith("qcc") && !l.id.startsWith("amf-ig-") && !l.id.startsWith("v-1.1-r."),
    );
    expect(
      parseCitation(
        "Règlement 45-106 pris en vertu de la Loi sur les valeurs mobilières (RLRQ, c. V-1.1), art. 1",
        sansPdfAvecV11,
      ),
    ).toMatchObject({ law: null, article: "1", chapitre_inconnu: null, ambigu: null });
    expect(
      parseCitation(
        "IG 45-106 relative à la Loi sur les valeurs mobilières (RLRQ, c. V-1.1), art. 1.1",
        sansPdfAvecV11,
      ),
    ).toMatchObject({ law: null, article: "1.1", chapitre_inconnu: null, ambigu: null });

    // 2) Formulations anglaises Superior Court Directives / Quebec Division
    expect(
      parseCitation("Superior Court Directives — District of Montreal, para. 1", prodAvecV11),
    ).toMatchObject({ law: "qccs-dist-mtl", article: "1", ambigu: null });
    expect(
      parseCitation("Superior Court Directives — Division of Montreal, para. 1", prodAvecV11),
    ).toMatchObject({ law: "qccs-div-mtl", article: "1", ambigu: null });
    expect(
      parseCitation("Superior Court Directives — Quebec Division, para. 1", prodAvecV11),
    ).toMatchObject({ law: "qccs-div-qc", article: "1", ambigu: null });
    expect(
      parseCitation(
        "Directives of the Superior Court — District of Montreal, para. 1",
        prodAvecV11,
      ),
    ).toMatchObject({ law: "qccs-dist-mtl", article: "1", ambigu: null });
    expect(
      parseCitation("Directives of the Superior Court — Quebec Division, para. 1", prodAvecV11),
    ).toMatchObject({ law: "qccs-div-qc", article: "1", ambigu: null });
    expect(
      parseCitation("Superior Court of Quebec — District of Montreal, para. 1", prodAvecV11),
    ).toMatchObject({ law: "qccs-dist-mtl", article: "1", ambigu: null });
    // Quebec District (non ingéré) vs Quebec Division
    expect(
      parseCitation("Superior Court Directives — Quebec District, para. 1", prodAvecV11),
    ).toMatchObject({ law: null, article: "1", ambigu: null });
    expect(
      parseCitation("Superior Court Directives — District of Quebec, para. 1", prodAvecV11),
    ).toMatchObject({ law: null, article: "1", ambigu: null });
    const scAmbig = parseCitation("Superior Court Directives, para. 1", prodAvecV11);
    expect(scAmbig.law).toBeNull();
    expect(scAmbig.article).toBe("1");
    expect(scAmbig.ambigu?.map((a) => a.id).sort()).toEqual([
      "qccs-dist-mtl",
      "qccs-div-mtl",
      "qccs-div-qc",
    ]);

    // 3) Annexe accentuée multi-mots & subdivisions séparées par virgule (Partie/Rubrique/Appendice)
    expect(
      parseCitation("Directive C.Q. (DAA), Annexe déontologie policière", prodAvecV11),
    ).toMatchObject({
      law: "qccq-daa-jurisprudence",
      article: "annexe-deontologie-policiere",
      ambigu: null,
    });
    expect(
      parseCitation("Directive C.Q. (DAA), Annexe fiscalité municipale", prodAvecV11),
    ).toMatchObject({
      law: "qccq-daa-jurisprudence",
      article: "annexe-fiscalite-municipale",
      ambigu: null,
    });
    expect(
      parseCitation("Directive C.Q. (DAA), Annexe accès à l'information", prodAvecV11),
    ).toMatchObject({
      law: "qccq-daa-jurisprudence",
      article: "annexe-acces-information",
      ambigu: null,
    });
    expect(parseCitation("Règlement 51-102, Annexe 51-102A1, Partie 1", prodAvecV11)).toMatchObject(
      {
        law: "v-1.1-r.24",
        article: "annexe-51-102a1-partie-1",
        ambigu: null,
      },
    );
    expect(
      parseCitation("Règlement 51-102, Annexe 51-102A2, rubrique 4", prodAvecV11),
    ).toMatchObject({
      law: "v-1.1-r.24",
      article: "annexe-51-102a2-rubrique-4",
      ambigu: null,
    });
    expect(
      parseCitation("Règlement 45-106, Annexe 45-106A1, Appendice 1", prodAvecV11),
    ).toMatchObject({
      law: "v-1.1-r.21",
      article: "annexe-45-106a1-appendice-1",
      ambigu: null,
    });
    expect(
      parseCitation("Règlement 45-106, Annexe 45-106A1, Appendice A", prodAvecV11),
    ).toMatchObject({
      law: "v-1.1-r.21",
      article: "annexe-45-106a1-appendice-a",
      ambigu: null,
    });
    expect(
      parseCitation("Règlement 51-102, Annexe 51-102A1, Partie 1, rubrique 2", prodAvecV11),
    ).toMatchObject({
      law: "v-1.1-r.24",
      article: "annexe-51-102a1-partie-1-rubrique-2",
      ambigu: null,
    });
    // Non-régression : Annexe A1, art. 1 -> art. 1 prime ; Annexe division 1 reste intact
    expect(parseCitation("Règlement 45-106, Annexe 45-106A1, art. 1", prodAvecV11)).toMatchObject({
      law: "v-1.1-r.21",
      article: "1",
      ambigu: null,
    });

    // 4) CHAPITRE_EXPLICITE avec ch.
    expect(parseCitation("L.R.C. 1985, ch. B-3, art. 67", prodAvecV11)).toMatchObject({
      law: null,
      article: "67",
      chapitre_inconnu: "B-3",
      ambigu: null,
    });
    expect(parseCitation("L.R.C. 1985, ch. X-99, art. 1", prodAvecV11)).toMatchObject({
      law: null,
      article: "1",
      chapitre_inconnu: "X-99",
      ambigu: null,
    });
  });

  it("Round 7 Tier 5 : annexes v-1.1-r.21 avec « Instructions générales » / « Instructions » / prépositions sans détournement isIG ni troncature", () => {
    const prodAvecV11: LawRow[] = [
      ...PROD_LAWS,
      {
        id: "v-1.1",
        name_fr: "Loi sur les valeurs mobilières",
        official_cite: "RLRQ, c. V-1.1",
        official_cite_en: "CQLR, c. V-1.1",
        fonction: "loi",
        unit: "article",
      } as unknown as LawRow,
    ];

    // 1) Bug 1 [HIGH] : Instructions générales dans un titre d'annexe de Règlement 45-106 / V-1.1, r. 21 -> v-1.1-r.21 (jamais amf-ig-45-106)
    for (const cit of [
      "RLRQ, c. V-1.1, r. 21, Annexe 45-106A2, A. Instructions générales",
      "Règlement 45-106, Annexe 45-106A2, A. Instructions générales",
      "RLRQ, c. V-1.1, r. 21, annexe 45 106a2 a instructions generales",
      "Annexe 45-106A2, A. Instructions générales (RLRQ, c. V-1.1, r. 21)",
    ]) {
      expect(parseCitation(cit, prodAvecV11), cit).toMatchObject({
        law: "v-1.1-r.21",
        article: "annexe-45-106a2-a-instructions-generales",
        ambigu: null,
      });
    }
    expect(
      parseCitation("Règlement 45-106, Annexe 45-106A3, A. Instructions générales", prodAvecV11),
    ).toMatchObject({
      law: "v-1.1-r.21",
      article: "annexe-45-106a3-a-instructions-generales",
      ambigu: null,
    });
    expect(
      parseCitation(
        "Règlement 45-106, Annexe 45-106A2, B. États financiers – instructions générales",
        prodAvecV11,
      ),
    ).toMatchObject({
      law: "v-1.1-r.21",
      article: "annexe-45-106a2-b-etats-financiers-instructions-generales",
      ambigu: null,
    });

    // Non-régression IG explicite (avec ou sans Annexe)
    expect(parseCitation("Annexe A de l'Instruction générale 45-106", prodAvecV11)).toMatchObject({
      law: "amf-ig-45-106",
      article: "annexe-a",
      ambigu: null,
    });
    expect(parseCitation("Annexe A, Instruction générale 45-106", prodAvecV11)).toMatchObject({
      law: "amf-ig-45-106",
      article: "annexe-a",
      ambigu: null,
    });
    expect(parseCitation("Instruction générale 45-106, Annexe A", prodAvecV11)).toMatchObject({
      law: "amf-ig-45-106",
      article: "annexe-a",
      ambigu: null,
    });
    expect(
      parseCitation(
        "IG 45-106 relative à la Loi sur les valeurs mobilières (RLRQ, c. V-1.1), art. 1.1",
        prodAvecV11,
      ),
    ).toMatchObject({
      law: "amf-ig-45-106",
      article: "1.1",
      ambigu: null,
    });

    // 2) Bug 2 [MEDIUM] : ANNEXE_STOP_MOTS resserré (Instructions, pour, l', a, de, la, sur)
    for (const [cit, expArt] of [
      ["Règlement 45-106, Annexe 45-106A19 Instructions", "annexe-45-106a19-instructions"],
      ["Règlement 45-106, Annexe 45-106A19, Instructions", "annexe-45-106a19-instructions"],
      ["Règlement 45-106, Annexe 45-106A2 Instructions", "annexe-45-106a2-instructions"],
      ["Règlement 45-106, Annexe 45-106A2, Instructions", "annexe-45-106a2-instructions"],
      ["Règlement 45-106, Annexe 45-106A2, Indications", "annexe-45-106a2-indications"],
      [
        "RLRQ, c. V-1.1, r. 21, annexe 45 106a2 instructions pour l appl",
        "annexe-45-106a2-instructions-pour-l-appl",
      ],
      [
        "RLRQ, c. V-1.1, r. 21, annexe 45 106a3 c mises a jour de la not",
        "annexe-45-106a3-c-mises-a-jour-de-la-not",
      ],
      [
        "RLRQ, c. V-1.1, r. 21, annexe 45 106a3 d information sur l emet",
        "annexe-45-106a3-d-information-sur-l-emet",
      ],
      [
        "RLRQ, c. V-1.1, r. 21, annexe 45 106a16 instructions pour l appl",
        "annexe-45-106a16-instructions-pour-l-appl",
      ],
      [
        "Règlement 45-106, Annexe 45-106A2, Instructions pour l'application",
        "annexe-45-106a2-instructions-pour-l-application",
      ],
    ] as const) {
      expect(parseCitation(cit, prodAvecV11), cit).toMatchObject({
        law: "v-1.1-r.21",
        article: expArt,
        ambigu: null,
      });
    }
  });
});

describe("H_RESOLVE_REFERENCE — garde de chapitre RLRQ sous PDF_CORPUS='0' vs '1'", () => {
  beforeAll(async () => {
    const d = db();
    await d
      .prepare(
        `INSERT INTO laws (id, name_fr, name_en, official_cite, official_cite_en, consol_date_fr, jurisdiction, source, fonction, unit, name_norm)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "v-1.1",
        "Loi sur les valeurs mobilières",
        "Securities Act",
        "RLRQ, c. V-1.1",
        "CQLR, c. V-1.1",
        "2026-04-07",
        "qc",
        "epub",
        "loi",
        "article",
        "loi sur les valeurs mobilieres",
      )
      .run();
    await d
      .prepare(
        `INSERT INTO laws (id, name_fr, name_en, official_cite, official_cite_en, consol_date_fr, jurisdiction, source, fonction, unit, name_norm)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "v-1.1-r.21",
        "Règlement 45-106 sur les dispenses de prospectus",
        "Regulation 45-106",
        "RLRQ, c. V-1.1, r. 21",
        "CQLR, c. V-1.1, r. 21",
        "2025-09-19",
        "qc",
        "pdf",
        "reglement",
        "article",
        "reglement 45 106 sur les dispenses de prospectus",
      )
      .run();
    await d
      .prepare(
        "INSERT INTO divisions (id, law_id, lang, kind, number, heading, path, sort_order) VALUES (?,?,?,?,?,?,?,?)",
      )
      .bind(1, "v-1.1", "fr", "titre", "I", "OBJET", "ga:l_premier", 1)
      .run();
    await d
      .prepare(
        "INSERT INTO divisions (id, law_id, lang, kind, number, heading, path, sort_order) VALUES (?,?,?,?,?,?,?,?)",
      )
      .bind(2, "v-1.1-r.21", "fr", "partie", "1", "DÉFINITIONS", "ph1:1", 2)
      .run();
    await d
      .prepare(
        "INSERT INTO articles (id, law_id, lang, number, sort_key, division_id, division_path, text) VALUES (?,?,?,?,?,?,?,?)",
      )
      .bind(
        1,
        "v-1.1",
        "fr",
        "1",
        1_000_000_000_000,
        1,
        "ga:l_premier",
        "La présente loi s'applique aux valeurs mobilières.",
      )
      .run();
    await d
      .prepare(
        "INSERT INTO articles (id, law_id, lang, number, sort_key, division_id, division_path, text) VALUES (?,?,?,?,?,?,?,?)",
      )
      .bind(
        2,
        "v-1.1-r.21",
        "fr",
        "1",
        1_000_000_000_000,
        2,
        "ph1:1",
        "Définitions du Règlement 45-106.",
      )
      .run();
  });

  it("refuse RLRQ, c. V-1.1, r. 21 sous PDF_CORPUS='0' sans le rabattre sur v-1.1, tout en résolvant V-1.1", async () => {
    const outilsOff = construireOutils({
      DB: db(),
      PDF_CORPUS: "0",
      FEDERAL_CORPUS: "1",
    } as unknown as Parameters<typeof construireOutils>[0]);

    const regOff = await outilsOff.resolve_reference({
      citation: "RLRQ, c. V-1.1, r. 21, art. 1",
    } as never);
    expect(regOff.isError).toBe(true);
    expect(regOff.content[0].text).toContain("V-1.1, r. 21");

    const lawOff = await outilsOff.resolve_reference({
      citation: "RLRQ, c. V-1.1, art. 1",
    } as never);
    expect(lawOff.isError).toBeUndefined();
    expect((lawOff.structuredContent as { resolved: { law: string } }).resolved.law).toBe("v-1.1");

    const outilsOn = construireOutils({
      DB: db(),
      PDF_CORPUS: "1",
      FEDERAL_CORPUS: "1",
    } as unknown as Parameters<typeof construireOutils>[0]);
    const regOn = await outilsOn.resolve_reference({
      citation: "RLRQ, c. V-1.1, r. 21, art. 1",
    } as never);
    expect(regOn.isError).toBeUndefined();
    expect((regOn.structuredContent as { resolved: { law: string } }).resolved.law).toBe(
      "v-1.1-r.21",
    );

    const regWithV11 = await outilsOn.resolve_reference({
      citation: "Règlement 45-106 (RLRQ, c. V-1.1), art. 1",
    } as never);
    expect(regWithV11.isError).toBeUndefined();
    expect((regWithV11.structuredContent as { resolved: { law: string } }).resolved.law).toBe(
      "v-1.1-r.21",
    );

    const regOffWithV11 = await outilsOff.resolve_reference({
      citation: "Règlement 45-106 (RLRQ, c. V-1.1), art. 1",
    } as never);
    expect(regOffWithV11.isError).toBe(true);
  });
});

describe("parseLinks", () => {
  it("analyse un JSON valide et retourne [] sur null, vide ou invalide", () => {
    expect(parseLinks(null)).toEqual([]);
    expect(parseLinks("")).toEqual([]);
    expect(parseLinks("[]")).toEqual([]);
    expect(parseLinks("{not-json")).toEqual([]);
    expect(
      parseLinks(JSON.stringify([{ label: "PDF", url: "https://ex.ca/a.pdf" }, { foo: 1 }])),
    ).toEqual([{ label: "PDF", url: "https://ex.ca/a.pdf" }]);
  });
});
