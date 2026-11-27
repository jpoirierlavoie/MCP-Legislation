import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { DISPOSITION_SORT_BASE, sortKeyOf, translateDivisionPath } from "../src/lib";
import { isPdfPath } from "../src/paths";
import { normalize } from "../src/relevance";
import { construireOutils } from "../src/tools";

const db = () => (env as unknown as { DB: D1Database }).DB;

describe("Tier 5 — Adversarial Hardening & Regression Suite", () => {
  beforeAll(async () => {
    const d = db();
    const laws = [
      [
        "cpc",
        "Code de procédure civile",
        "Code of Civil Procedure",
        "RLRQ, c. C-25.01",
        "CQLR, c. C-25.01",
        "qc",
        "epub",
        "loi",
        "article",
      ],
      [
        "v-1.1-r.21",
        "Règlement 45-106 sur les dispenses de prospectus",
        "Regulation 45-106",
        "RLRQ, c. V-1.1, r. 21",
        "CQLR, c. V-1.1, r. 21",
        "qc",
        "pdf",
        "reglement",
        "article",
      ],
      [
        "qccs-dist-mtl",
        "Directives de la Cour supérieure — District de Montréal",
        "Directives de la Cour supérieure — District de Montréal",
        "Directives C.S. (District de Montréal)",
        null,
        "qc",
        "pdf",
        "directive",
        "paragraphe",
      ],
      [
        "qccs-div-mtl",
        "Directives de la Cour supérieure — Division de Montréal",
        "Directives de la Cour supérieure — Division de Montréal",
        "Directives C.S. (Division de Montréal)",
        null,
        "qc",
        "pdf",
        "directive",
        "paragraphe",
      ],
      [
        "amf-ig-45-106",
        "Instruction générale relative au Règlement 45-106",
        "Policy Statement to Regulation 45-106",
        "Instruction générale 45-106",
        "Policy Statement 45-106",
        "qc",
        "pdf",
        "orientation",
        "article",
      ],
      [
        "v-1.1",
        "Loi sur les valeurs mobilières",
        "Securities Act",
        "RLRQ, c. V-1.1",
        "CQLR, c. V-1.1",
        "qc",
        "epub",
        "loi",
        "article",
      ],
      [
        "qccq-mtl-prat-civile",
        "Mode de fonctionnement — Division de pratique civile — District de Montréal (Salles 2.06 et 2.02)",
        "Mode de fonctionnement — Division de pratique civile — District de Montréal (Salles 2.06 et 2.02)",
        "Mode de fonctionnement C.Q. Montréal (Pratique civile)",
        null,
        "qc",
        "pdf",
        "directive",
        "paragraphe",
      ],
      [
        "qccs-div-qc",
        "Directives de la juge en chef associée pour la division de Québec",
        "Directives of the Associate Chief Justice for the Québec Division",
        "Directives C.S. (Division de Québec)",
        null,
        "qc",
        "pdf",
        "directive",
        "paragraphe",
      ],
      [
        "qccq-daa-jurisprudence",
        "Directive concernant la liste commune de jurisprudence — Division administrative et d'appel",
        "Directive concernant la liste commune de jurisprudence — Division administrative et d'appel",
        "Directive C.Q. (DAA — Liste commune de jurisprudence)",
        null,
        "qc",
        "pdf",
        "directive",
        "paragraphe",
      ],
      [
        "v-1.1-r.24",
        "Règlement 51-102 sur les obligations d'information continue",
        "Regulation 51-102 respecting Continuous Disclosure Obligations",
        "RLRQ, c. V-1.1, r. 24",
        "CQLR, c. V-1.1, r. 24",
        "qc",
        "pdf",
        "reglement",
        "article",
      ],
    ] as const;

    for (const [id, nf, ne, oc, oce, jur, src, fn, unit] of laws) {
      await d
        .prepare(
          `INSERT INTO laws (id, name_fr, name_en, official_cite, official_cite_en, consol_date_fr, jurisdiction, source, fonction, unit, name_norm)
           VALUES (?, ?, ?, ?, ?, '2026-02-23', ?, ?, ?, ?, ?)`,
        )
        .bind(id, nf, ne, oc, oce, jur, src, fn, unit, normalize(nf))
        .run();
    }

    const divs = [
      [1, "cpc", "fr", "livre", "I", "PROCÉDURE", "ga:l_i", 0, 1],
      [2, "cpc", "en", "livre", "I", "PROCEDURE", "ga:l_one", 0, 1],
      [3, "v-1.1-r.21", "fr", "partie", "1", "DISPENSES", "ph1:1", 0, 1],
      [4, "qccs-dist-mtl", "fr", "partie", "1", "DIRECTIVES GÉNÉRALES", "ph1:1", 0, 1],
      [5, "qccs-dist-mtl", "fr", "annexe", null, "LISTE DES ANNEXES", "ps:1", 0, 2],
      [6, "qccs-div-mtl", "fr", "partie", "1", "DIVISION DE MONTRÉAL", "ph1:1", 0, 1],
      [7, "qccs-div-mtl", "en", "partie", "1", "MONTRÉAL DIVISION", "ph1:1", 0, 1],
      [8, "amf-ig-45-106", "fr", "partie", "2", "INTERPRÉTATION", "ph1:2", 0, 1],
      [9, "qccs-div-mtl", "en", "section", "9", "REPEALED DIV", "ph1:9", 1, 2],
      [10, "v-1.1-r.21", "fr", "note", null, "Note préliminaire", "pp:0", 0, 0],
      [11, "v-1.1", "fr", "titre", "I", "OBJET", "ga:l_premier", 0, 1],
      [12, "qccs-div-mtl", "fr", "annexe", null, "ANNEXES", "ps:1", 0, 2],
      [13, "qccq-mtl-prat-civile", "fr", "partie", "1", "PRATIQUE CIVILE", "ph1:1", 0, 1],
      [14, "qccs-div-qc", "fr", "partie", "1", "DIVISION DE QUÉBEC", "ph1:1", 0, 1],
      [15, "qccq-daa-jurisprudence", "fr", "annexe", null, "ANNEXES", "ps:1", 0, 1],
      [16, "v-1.1-r.24", "fr", "annexe", null, "ANNEXES", "ps:1", 0, 1],
    ] as const;
    for (const [id, lid, lang, kind, num, hd, path, rep, so] of divs) {
      await d
        .prepare(
          "INSERT INTO divisions (id, law_id, lang, kind, number, heading, path, repealed, sort_order) VALUES (?,?,?,?,?,?,?,?,?)",
        )
        .bind(id, lid, lang, kind, num, hd, path, rep, so)
        .run();
    }

    const arts: [
      number,
      string,
      string,
      string,
      number,
      number,
      string,
      string,
      number,
      string | null,
    ][] = [
      [
        1,
        "cpc",
        "fr",
        "145",
        sortKeyOf("145"),
        1,
        "ga:l_i",
        "La procédure de demande civile respecte les règles générales.",
        0,
        null,
      ],
      [
        2,
        "cpc",
        "en",
        "145",
        sortKeyOf("145"),
        2,
        "ga:l_one",
        "Civil procedure application and courtroom schedule.",
        0,
        null,
      ],
      [
        3,
        "v-1.1-r.21",
        "fr",
        "2.3",
        sortKeyOf("2.3"),
        3,
        "ph1:1",
        "Dispense d'investisseur qualifié.",
        0,
        null,
      ],
      [
        4,
        "qccs-dist-mtl",
        "fr",
        "1",
        sortKeyOf("1"),
        4,
        "ph1:1",
        "Paragraphe 1 sur le rôle provisoire du greffier spécial montréalais.",
        0,
        null,
      ],
      [
        5,
        "qccs-dist-mtl",
        "fr",
        "2",
        sortKeyOf("2"),
        4,
        "ph1:1",
        "Paragraphe 2 sur le rôle provisoire et le calendrier de salle 15.07.",
        0,
        null,
      ],
      [
        6,
        "qccs-dist-mtl",
        "fr",
        "3",
        sortKeyOf("3"),
        4,
        "ph1:1",
        "Paragraphe 3 sur le rôle provisoire devant le maître des rôles.",
        0,
        null,
      ],
      [
        7,
        "qccs-dist-mtl",
        "fr",
        "4",
        sortKeyOf("4"),
        4,
        "ph1:1",
        "Paragraphe 4 sur le rôle provisoire en chambre familiale.",
        0,
        null,
      ],
      [
        8,
        "qccs-dist-mtl",
        "fr",
        "5",
        sortKeyOf("5"),
        4,
        "ph1:1",
        "Paragraphe 5 sur le rôle provisoire et la conférence préparatoire.",
        0,
        null,
      ],
      [9, "qccs-dist-mtl", "fr", "6", sortKeyOf("6"), 4, "ph1:1", "Abrogé.", 1, null],
      [
        10,
        "qccs-dist-mtl",
        "fr",
        "7",
        sortKeyOf("7"),
        4,
        "ph1:1",
        "Paragraphe 7 sur le rôle provisoire et la demande de remise.",
        0,
        null,
      ],
      [
        11,
        "qccs-dist-mtl",
        "fr",
        "8",
        sortKeyOf("8"),
        4,
        "ph1:1",
        "Paragraphe 8 : règle particulière de salle 2.16 et procédure de rôle.",
        0,
        null,
      ],
      [
        12,
        "qccs-dist-mtl",
        "fr",
        "annexe-1",
        DISPOSITION_SORT_BASE + 1_000_000,
        5,
        "ps:1",
        "Formulaire de déclaration commune pour la fixation d'une audience.",
        0,
        JSON.stringify([
          { label: "Déclaration commune", url: "https://coursuperieureduquebec.ca/annexe-1.docx" },
        ]),
      ],
      [
        13,
        "qccs-div-mtl",
        "fr",
        "10",
        sortKeyOf("10"),
        6,
        "ph1:1",
        "Directive de la division de Montréal sur la procédure civile.",
        0,
        null,
      ],
      [14, "qccs-div-mtl", "fr", "11", sortKeyOf("11"), 6, "ph1:1", "Abrogé.", 1, null],
      [15, "qccs-div-mtl", "en", "11", sortKeyOf("11"), 7, "ph1:1", "Repealed.", 1, null],
      [
        16,
        "amf-ig-45-106",
        "fr",
        "2A.1",
        sortKeyOf("2A.1"),
        8,
        "ph1:2",
        "Orientation sur la procédure de dispense d'investisseur qualifié.",
        0,
        null,
      ],
      [
        17,
        "v-1.1-r.21",
        "fr",
        "note-preliminaire",
        0,
        10,
        "pp:0",
        "Note préliminaire de l'AMF sur le Règlement 45-106.",
        0,
        null,
      ],
      [
        18,
        "qccs-dist-mtl",
        "fr",
        "annexe-division-1",
        DISPOSITION_SORT_BASE + 2_000_000,
        5,
        "ps:1",
        "Annexe division 1 du district de Montréal.",
        0,
        null,
      ],
      [
        19,
        "qccs-div-mtl",
        "fr",
        "annexe-division-1",
        DISPOSITION_SORT_BASE + 2_000_000,
        12,
        "ps:1",
        "Annexe division 1 de la division de Montréal.",
        0,
        null,
      ],
      [
        20,
        "v-1.1",
        "fr",
        "1",
        sortKeyOf("1"),
        11,
        "ga:l_premier",
        "Loi sur les valeurs mobilières — objet.",
        0,
        null,
      ],
      [
        21,
        "v-1.1",
        "fr",
        "2.3",
        sortKeyOf("2.3"),
        11,
        "ga:l_premier",
        "Loi sur les valeurs mobilières — définitions.",
        0,
        null,
      ],
      [
        22,
        "amf-ig-45-106",
        "fr",
        "1",
        sortKeyOf("1"),
        8,
        "ph1:2",
        "Instruction générale 45-106 — objet.",
        0,
        null,
      ],
      [
        23,
        "amf-ig-45-106",
        "fr",
        "2.1",
        sortKeyOf("2.1"),
        8,
        "ph1:2",
        "Instruction générale 45-106 — dispense.",
        0,
        null,
      ],
      [
        24,
        "qccs-dist-mtl",
        "fr",
        "12",
        sortKeyOf("12"),
        4,
        "ph1:1",
        "Paragraphe 12 sur les audiences civiles.",
        0,
        null,
      ],
      [
        25,
        "qccs-dist-mtl",
        "fr",
        "annexe-district-1",
        DISPOSITION_SORT_BASE + 3_000_000,
        5,
        "ps:1",
        "Annexe district 1 du district de Montréal.",
        0,
        null,
      ],
      [
        26,
        "qccq-mtl-prat-civile",
        "fr",
        "5",
        sortKeyOf("5"),
        13,
        "ph1:1",
        "Paragraphe 5 sur les audiences de pratique.",
        0,
        null,
      ],
      [
        28,
        "amf-ig-45-106",
        "fr",
        "1.1",
        sortKeyOf("1.1"),
        8,
        "ph1:2",
        "Article 1.1 de l'Instruction générale 45-106.",
        0,
        null,
      ],
      [
        29,
        "qccs-div-mtl",
        "fr",
        "1",
        sortKeyOf("1"),
        6,
        "ph1:1",
        "Paragraphe 1 de la division de Montréal.",
        0,
        null,
      ],
      [
        30,
        "qccs-div-qc",
        "fr",
        "1",
        sortKeyOf("1"),
        14,
        "ph1:1",
        "Paragraphe 1 de la division de Québec.",
        0,
        null,
      ],
      [
        31,
        "qccq-daa-jurisprudence",
        "fr",
        "annexe-deontologie-policiere",
        DISPOSITION_SORT_BASE + 1_000_000,
        15,
        "ps:1",
        "Liste commune en matière de déontologie policière.",
        0,
        null,
      ],
      [
        32,
        "v-1.1-r.24",
        "fr",
        "annexe-51-102a1",
        DISPOSITION_SORT_BASE + 1_000_000,
        16,
        "ps:1",
        "Annexe 51-102A1 intro.",
        0,
        null,
      ],
      [
        33,
        "v-1.1-r.24",
        "fr",
        "annexe-51-102a1-partie-1",
        DISPOSITION_SORT_BASE + 2_000_000,
        16,
        "ps:1",
        "Annexe 51-102A1, Partie 1 — Dispositions générales.",
        0,
        null,
      ],
      [
        34,
        "v-1.1-r.24",
        "fr",
        "annexe-51-102a2-rubrique-4",
        DISPOSITION_SORT_BASE + 3_000_000,
        16,
        "ps:1",
        "Annexe 51-102A2, rubrique 4 — Changements importants.",
        0,
        null,
      ],
      [
        35,
        "v-1.1-r.21",
        "fr",
        "annexe-45-106a1-appendice-1",
        DISPOSITION_SORT_BASE + 4_000_000,
        3,
        "ph1:1",
        "Annexe 45-106A1, Appendice 1 — Instructions.",
        0,
        null,
      ],
      [
        36,
        "v-1.1-r.21",
        "fr",
        "annexe-45-106a2-a-instructions-generales",
        DISPOSITION_SORT_BASE + 5_000_000,
        3,
        "ph1:1",
        "A. Instructions générales de l'Annexe 45-106A2.",
        0,
        null,
      ],
      [
        37,
        "v-1.1-r.21",
        "fr",
        "annexe-45-106a3-a-instructions-generales",
        DISPOSITION_SORT_BASE + 6_000_000,
        3,
        "ph1:1",
        "A. Instructions générales de l'Annexe 45-106A3.",
        0,
        null,
      ],
      [
        38,
        "v-1.1-r.21",
        "fr",
        "annexe-45-106a19-instructions",
        DISPOSITION_SORT_BASE + 7_000_000,
        3,
        "ph1:1",
        "INSTRUCTIONS de l'Annexe 45-106A19.",
        0,
        null,
      ],
      [
        39,
        "v-1.1-r.21",
        "fr",
        "annexe-45-106a2-instructions",
        DISPOSITION_SORT_BASE + 8_000_000,
        3,
        "ph1:1",
        "Instructions de l'Appendice 1 de l'Annexe 45-106A2.",
        0,
        null,
      ],
      [
        40,
        "v-1.1-r.21",
        "fr",
        "annexe-45-106a3-c-mises-a-jour-de-la-not",
        DISPOSITION_SORT_BASE + 9_000_000,
        3,
        "ph1:1",
        "C. Mises à jour de la notice d'offre.",
        0,
        null,
      ],
      [
        41,
        "v-1.1-r.21",
        "fr",
        "annexe-45-106a3-d-information-sur-l-emet",
        DISPOSITION_SORT_BASE + 10_000_000,
        3,
        "ph1:1",
        "D. Information sur l'émetteur.",
        0,
        null,
      ],
      [
        42,
        "amf-ig-45-106",
        "fr",
        "annexe-a",
        DISPOSITION_SORT_BASE + 1_000_000,
        8,
        "ph1:2",
        "Annexe A de l'Instruction générale 45-106.",
        0,
        null,
      ],
    ];
    for (const [id, lid, lang, num, sk, did, dp, txt, rep, links] of arts) {
      await d
        .prepare(
          `INSERT INTO articles (id, law_id, lang, number, sort_key, division_id, division_path, text, repealed, links)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, lid, lang, num, sk, did, dp, txt, rep, links)
        .run();
    }

    await d
      .prepare(
        "INSERT INTO law_relations (from_law_id, to_law_id, rel_type, source, in_corpus, note) VALUES (?,?,?,?,?,?)",
      )
      .bind("qccs-dist-mtl", "cpc", "preseance-sur", "cure", 1, "Le C.p.c. prévaut.")
      .run();
    await d
      .prepare(
        "INSERT INTO law_relations (from_law_id, to_law_id, rel_type, source, in_corpus, note) VALUES (?,?,?,?,?,?)",
      )
      .bind("qccs-div-mtl", "cpc", "preseance-sur", "cure", 1, "Le C.p.c. prévaut.")
      .run();
    await d
      .prepare(
        "INSERT INTO law_relations (from_law_id, to_law_id, rel_type, source, in_corpus, note) VALUES (?,?,?,?,?,?)",
      )
      .bind(
        "amf-ig-45-106",
        "v-1.1-r.21",
        "interprete",
        "cure",
        1,
        "Interprète le Règlement 45-106.",
      )
      .run();

    await d.prepare("INSERT INTO articles_fts(articles_fts) VALUES('rebuild')").run();
  });

  const makeOutils = (hybridePermis = true) =>
    construireOutils(
      {
        DB: db(),
        PDF_CORPUS: "1",
        FEDERAL_CORPUS: "1",
        HYBRID_SEARCH: "0",
        RELAX_SEARCH: "1",
      } as unknown as Env,
      { hybridePermis },
    );

  it("translateDivisionPath court-circuite les chemins positionnels PDF (ph1:1, ps:1, pp:0)", async () => {
    expect(isPdfPath("ph1:1")).toBe(true);
    expect(isPdfPath("ps:1-ph1:2")).toBe(true);
    expect(isPdfPath("pp:0")).toBe(true);
    expect(isPdfPath("ga:l_i")).toBe(false);

    const sqlQueries: string[] = [];
    const spyDb = {
      prepare(sql: string) {
        sqlQueries.push(sql);
        return db().prepare(sql);
      },
    } as unknown as D1Database;

    const hit = await translateDivisionPath(spyDb, "qccs-div-mtl", "ph1:1", "en");
    expect(hit).toEqual({ path: "ph1:1", heading: "MONTRÉAL DIVISION" });
    expect(sqlQueries).toHaveLength(1);
    expect(sqlQueries[0]).not.toContain("JOIN articles");
  });

  it("resolve_reference('Directives C.S. District de Montréal, annexe-1') rend annexe-1 et jamais par. 1", async () => {
    const outils = makeOutils();
    const res = await outils.resolve_reference({
      citation: "Directives C.S. District de Montréal, annexe-1",
    } as never);
    expect(res.isError).toBeUndefined();
    const sc = res.structuredContent as {
      resolved: { law: string; number: string };
      links: Array<{ label: string; url: string }>;
    };
    expect(sc.resolved.law).toBe("qccs-dist-mtl");
    expect(sc.resolved.number).toBe("annexe-1");
    expect(sc.links).toHaveLength(1);
    expect(res.content[0].text).toContain("Déclaration commune");
    expect(res.content[0].text).not.toContain("Paragraphe 1");
  });

  it("H_SEARCH_TEXT ne tronque pas à 3 hits une requête ne touchant que des directives, tout en gardant le plafond mixte", async () => {
    const outils = makeOutils();

    const dirOnly = await outils.search_text({
      query: "rôle provisoire",
      limit: 14,
    } as never);
    expect(dirOnly.isError).toBeUndefined();
    const dirSc = dirOnly.structuredContent as {
      total: number;
      returned: number;
      results: Array<{ law_id: string }>;
    };
    expect(dirSc.total).toBe(6);
    expect(dirSc.returned).toBe(6);
    expect(dirSc.results.every((r) => r.law_id === "qccs-dist-mtl")).toBe(true);

    const mixed = await outils.search_text({
      query: "procédure",
      limit: 10,
    } as never);
    expect(mixed.isError).toBeUndefined();
    const mixedSc = mixed.structuredContent as {
      results: Array<{ law_id: string; fonction: string }>;
    };
    expect(mixedSc.results.some((r) => r.law_id === "cpc")).toBe(true);
    const dirCount = mixedSc.results.filter((r) => r.fonction === "directive").length;
    expect(dirCount).toBeLessThanOrEqual(3);
  });

  it("H_GET_ARTICLES expose normativeNote et relations en prose et structuredContent", async () => {
    const outils = makeOutils();

    const dir = await outils.get_articles({
      law: "qccs-div-mtl",
      numbers: ["10"],
    } as never);
    expect(dir.isError).toBeUndefined();
    expect(dir.content[0].text).toMatch(/directive de pratique judiciaire/i);
    expect(dir.content[0].text).toContain("cpc");
    const dirSc = dir.structuredContent as {
      source: string;
      fonction: string;
      relations?: Array<{ rel_type: string; other_id: string }>;
    };
    expect(dirSc.source).toBe("pdf");
    expect(dirSc.fonction).toBe("directive");
    expect(
      dirSc.relations?.some((r) => r.rel_type === "preseance-sur" && r.other_id === "cpc"),
    ).toBe(true);

    const ig = await outils.get_articles({
      law: "amf-ig-45-106",
      numbers: ["2A.1"],
    } as never);
    expect(ig.isError).toBeUndefined();
    expect(ig.content[0].text).toMatch(/orientation administrative/i);
    expect(ig.content[0].text).toContain("v-1.1-r.21");
    const igSc = ig.structuredContent as {
      relations?: Array<{ rel_type: string; other_id: string }>;
    };
    expect(
      igSc.relations?.some((r) => r.rel_type === "interprete" && r.other_id === "v-1.1-r.21"),
    ).toBe(true);
  });

  it("H_SEARCH_TEXT rend conciseNormLine dans la prose de 'elsewhere' et signale fr-only en lang='en'", async () => {
    const outils = makeOutils();
    const scoped = await outils.search_text({
      query: "procédure",
      law: "cpc",
    } as never);
    expect(scoped.isError).toBeUndefined();
    const text = scoped.content[0].text;
    expect(text).toContain("Ailleurs au corpus");
    expect(text).toMatch(/Directive de pratique judiciaire|Orientation administrative/i);
    expect(text).toMatch(/preseance-sur|interprete/);

    const frZero = await outils.search_text({
      query: "nonexistentxyz",
      law: "qccs-dist-mtl",
      lang: "en",
    } as never);
    expect(frZero.isError).toBe(true);
    expect(frZero.content[0].text).toContain("published in French only (langs: ['fr'])");

    const outilsLex = makeOutils(false);
    const frWidened = await outilsLex.search_text({
      query: "procedure",
      law: "qccs-dist-mtl",
      lang: "en",
    } as never);
    expect(frWidened.isError).toBeUndefined();
    expect(frWidened.content[0].text).toContain("published in French only (langs: ['fr'])");
    expect((frWidened.structuredContent as { fr_only_law?: boolean }).fr_only_law).toBe(true);
  });

  it("H_GET_DIVISION affiche (abrogé) / (repealed) en prose pour include_text true et false", async () => {
    const outils = makeOutils();
    for (const includeText of [true, false]) {
      const fr = await outils.get_division({
        law: "qccs-div-mtl",
        path: "ph1:1",
        lang: "fr",
        include_text: includeText,
      } as never);
      expect(fr.isError).toBeUndefined();
      expect(fr.content[0].text).toContain("par. 11 (abrogé)");

      const en = await outils.get_division({
        law: "qccs-div-mtl",
        path: "ph1:1",
        lang: "en",
        include_text: includeText,
      } as never);
      expect(en.isError).toBeUndefined();
      expect(en.content[0].text).toContain("para. 11 (repealed)");
    }

    const repDivEn = await outils.get_division({
      law: "qccs-div-mtl",
      path: "ph1:9",
      lang: "en",
    } as never);
    expect(repDivEn.isError).toBeUndefined();
    expect(repDivEn.content[0].text).toContain("(repealed)");
    expect(repDivEn.content[0].text).not.toContain("(abrogé)");
  });

  it("H_GET_ARTICLES & H_GET_STRUCTURE localisent (repealed) en EN et note-preliminaire sortKeyOf == 0", async () => {
    const outils = makeOutils();
    expect(sortKeyOf("note-preliminaire")).toBe(0);

    const artEn = await outils.get_articles({
      law: "qccs-div-mtl",
      numbers: ["11"],
      lang: "en",
    } as never);
    expect(artEn.isError).toBeUndefined();
    expect(artEn.content[0].text).toContain("para. 11 (repealed)");
    expect(artEn.content[0].text).not.toContain("(abrogé)");

    const structEn = await outils.get_structure({
      law: "qccs-div-mtl",
      lang: "en",
      depth: 2,
    } as never);
    expect(structEn.isError).toBeUndefined();
    expect(structEn.content[0].text).toContain("(repealed)");
    expect(structEn.content[0].text).not.toContain("(abrogé)");

    const rangeNote = await outils.get_articles({
      law: "v-1.1-r.21",
      from: "note-preliminaire",
      to: "2.3",
      lang: "fr",
    } as never);
    expect(rangeNote.isError).toBeUndefined();
    const rangeSc = rangeNote.structuredContent as {
      range_resolution: string;
      articles: Array<{ number: string }>;
    };
    expect(rangeSc.range_resolution).toBe("cle");
    expect(rangeSc.articles.map((a) => a.number)).toEqual(["note-preliminaire", "2.3"]);
  });

  it("Round 3 Tier 5 : KIND_LABEL traduit 'partie' en 'Partie' (FR) / 'Part' (EN) et resolve_reference résout IG + c. V-1.1, r. 21", async () => {
    const outils = makeOutils();

    const structFr = await outils.get_structure({
      law: "v-1.1-r.21",
      lang: "fr",
      depth: 2,
    } as never);
    expect(structFr.isError).toBeUndefined();
    expect(structFr.content[0].text).toContain("Partie 1 — DISPENSES");
    expect(structFr.content[0].text).not.toMatch(/\bpartie 1 —/);

    const divFr = await outils.get_division({
      law: "v-1.1-r.21",
      path: "ph1:1",
      lang: "fr",
    } as never);
    expect(divFr.isError).toBeUndefined();
    expect(divFr.content[0].text).toContain("Partie 1 — DISPENSES");

    const structEn = await outils.get_structure({
      law: "qccs-div-mtl",
      lang: "en",
      depth: 2,
    } as never);
    expect(structEn.isError).toBeUndefined();
    expect(structEn.content[0].text).toContain("Part 1 — MONTRÉAL DIVISION");

    const divEn = await outils.get_division({
      law: "qccs-div-mtl",
      path: "ph1:1",
      lang: "en",
    } as never);
    expect(divEn.isError).toBeUndefined();
    expect(divEn.content[0].text).toContain("Part 1 — MONTRÉAL DIVISION");

    const igCite = await outils.resolve_reference({
      citation: "Instruction générale relative au Règlement 45-106 (c. V-1.1, r. 21), 2A.1",
    } as never);
    expect(igCite.isError).toBeUndefined();
    expect(
      (igCite.structuredContent as { resolved: { law: string; number: string } }).resolved,
    ).toMatchObject({
      law: "amf-ig-45-106",
      number: "2A.1",
    });

    const igNoComma = await outils.resolve_reference({
      citation: "Instruction générale relative au Règlement 45-106, RLRQ c. V-1.1, r. 21, 2A.1",
    } as never);
    expect(igNoComma.isError).toBeUndefined();
    expect(
      (igNoComma.structuredContent as { resolved: { law: string; number: string } }).resolved,
    ).toMatchObject({
      law: "amf-ig-45-106",
      number: "2A.1",
    });

    const igNoParen = await outils.resolve_reference({
      citation: "Instruction générale relative à c. V-1.1, r. 21, 2A.1",
    } as never);
    expect(igNoParen.isError).toBeUndefined();
    expect(
      (igNoParen.structuredContent as { resolved: { law: string; number: string } }).resolved,
    ).toMatchObject({
      law: "amf-ig-45-106",
      number: "2A.1",
    });
  });

  it("Round 4 Tier 5 : annexe-division-1 (QCCS), Règlement/IG + RLRQ c. V-1.1, et ch./chapitre/chapter IG contre D1", async () => {
    const outils = makeOutils();

    for (const cit of [
      "Directives C.S. District de Montréal, annexe-division-1",
      "Directives de la Cour supérieure — District de Montréal, annexe-division-1",
    ]) {
      const r = await outils.resolve_reference({ citation: cit } as never);
      expect(r.isError, cit).toBeUndefined();
      expect(
        (r.structuredContent as { resolved: { law: string; number: string } }).resolved,
      ).toMatchObject({
        law: "qccs-dist-mtl",
        number: "annexe-division-1",
      });
    }
    const divMtl = await outils.resolve_reference({
      citation: "Directives C.S. Division de Montréal, annexe-division-1",
    } as never);
    expect(divMtl.isError).toBeUndefined();
    expect(
      (divMtl.structuredContent as { resolved: { law: string; number: string } }).resolved,
    ).toMatchObject({
      law: "qccs-div-mtl",
      number: "annexe-division-1",
    });

    const regV11 = await outils.resolve_reference({
      citation: "Règlement 45-106 (RLRQ, c. V-1.1), art. 2.3",
    } as never);
    expect(regV11.isError).toBeUndefined();
    expect(
      (regV11.structuredContent as { resolved: { law: string; number: string } }).resolved,
    ).toMatchObject({
      law: "v-1.1-r.21",
      number: "2.3",
    });

    for (const cit of ["IG 45-106 (RLRQ, c. V-1.1), 1", "IG 45-106 (RLRQ, c. V-1.1), 2.1"]) {
      const r = await outils.resolve_reference({ citation: cit } as never);
      expect(r.isError, cit).toBeUndefined();
      expect((r.structuredContent as { resolved: { law: string } }).resolved.law).toBe(
        "amf-ig-45-106",
      );
    }

    const loiV11 = await outils.resolve_reference({
      citation: "Loi sur les valeurs mobilières (RLRQ, c. V-1.1), art. 1",
    } as never);
    expect(loiV11.isError).toBeUndefined();
    expect(
      (loiV11.structuredContent as { resolved: { law: string; number: string } }).resolved,
    ).toMatchObject({
      law: "v-1.1",
      number: "1",
    });

    for (const cit of [
      "Instruction générale 45-106 (RLRQ, ch. V-1.1, r. 21), 2.1",
      "Instruction générale 45-106 (chapitre V-1.1, r. 21), 2.1",
      "Policy Statement 45-106 (chapter V-1.1, r. 21), 2.1",
    ]) {
      const r = await outils.resolve_reference({ citation: cit } as never);
      expect(r.isError, cit).toBeUndefined();
      expect(
        (r.structuredContent as { resolved: { law: string; number: string } }).resolved,
      ).toMatchObject({
        law: "amf-ig-45-106",
        number: "2.1",
      });
    }
  });

  it("Round 5 Tier 5 : resolve_reference contre D1 (AMF L.R.Q./nu, districts QC, 1ᵉʳ, Salles —/;, Annexe division/district)", async () => {
    const outils = makeOutils();

    for (const cit of [
      "45-106 (L.R.Q., c. V-1.1), art. 2.3",
      "45-106 (R.S.Q., c. V-1.1), s. 2.3",
    ]) {
      const r = await outils.resolve_reference({ citation: cit } as never);
      expect(r.isError, cit).toBeUndefined();
      expect(
        (r.structuredContent as { resolved: { law: string; number: string } }).resolved,
      ).toMatchObject({ law: "v-1.1-r.21", number: "2.3" });
    }
    for (const cit of ["45-106 (c. V-1.1), art. 2.1", "45-106 (V-1.1), art. 1"]) {
      const r = await outils.resolve_reference({ citation: cit } as never);
      expect(r.isError, cit).toBe(true);
      expect(r.content[0].text, cit).toContain("v-1.1-r.21");
      expect(r.content[0].text, cit).toContain("amf-ig-45-106");
      expect(r.content[0].text, cit).not.toContain("RLRQ, c. V-1.1 (");
    }
    const v11Explicit = await outils.resolve_reference({
      citation: "Loi sur les valeurs mobilières (RLRQ, c. V-1.1), art. 1",
    } as never);
    expect(v11Explicit.isError).toBeUndefined();
    expect(
      (v11Explicit.structuredContent as { resolved: { law: string; number: string } }).resolved,
    ).toMatchObject({ law: "v-1.1", number: "1" });

    for (const cit of [
      "Directives de la Cour supérieure — District de Mont-Laurier, par. 1",
      "Directives de la Cour supérieure — District de Cowansville, par. 1",
      "Directives de la Cour supérieure — District de Percé, par. 1",
    ]) {
      const r = await outils.resolve_reference({ citation: cit } as never);
      expect(r.isError, cit).toBe(true);
      expect(r.content[0].text, cit).not.toContain("qccs-dist-mtl");
    }

    const dateSuperscript = await outils.resolve_reference({
      citation:
        "Directives de la Cour supérieure — District de Montréal (1\u1d49\u02b3 janvier 2026), 12",
    } as never);
    expect(dateSuperscript.isError).toBeUndefined();
    expect(
      (dateSuperscript.structuredContent as { resolved: { law: string; number: string } }).resolved,
    ).toMatchObject({ law: "qccs-dist-mtl", number: "12" });

    for (const cit of [
      "Mode de fonctionnement C.Q. Montréal (Pratique civile) Salles 2.06, 2.02 — 5",
      "Mode de fonctionnement C.Q. Montréal (Pratique civile) Salles 2.06, 2.02 ; 5",
    ]) {
      const r = await outils.resolve_reference({ citation: cit } as never);
      expect(r.isError, cit).toBeUndefined();
      expect(
        (r.structuredContent as { resolved: { law: string; number: string } }).resolved,
      ).toMatchObject({ law: "qccq-mtl-prat-civile", number: "5" });
    }

    const annDiv = await outils.resolve_reference({
      citation: "Directives C.S. District de Montréal, Annexe division 1",
    } as never);
    expect(annDiv.isError).toBeUndefined();
    expect(
      (annDiv.structuredContent as { resolved: { law: string; number: string } }).resolved,
    ).toMatchObject({ law: "qccs-dist-mtl", number: "annexe-division-1" });

    const annDist = await outils.resolve_reference({
      citation: "Directives C.S. District de Montréal, Annexe district 1",
    } as never);
    expect(annDist.isError).toBeUndefined();
    expect(
      (annDist.structuredContent as { resolved: { law: string; number: string } }).resolved,
    ).toMatchObject({ law: "qccs-dist-mtl", number: "annexe-district-1" });
  });

  it("Round 6 Tier 5 : resolve_reference contre D1 (AMF + V-1.1, Superior Court Directives, Annexe accentuée & subdivisions, ch.)", async () => {
    const outils = makeOutils();

    const regAct = await outils.resolve_reference({
      citation:
        "Règlement 45-106 pris en vertu de la Loi sur les valeurs mobilières (RLRQ, c. V-1.1), art. 2.3",
    } as never);
    expect(regAct.isError).toBeUndefined();
    expect(
      (regAct.structuredContent as { resolved: { law: string; number: string } }).resolved,
    ).toMatchObject({ law: "v-1.1-r.21", number: "2.3" });

    const regActMissing = await outils.resolve_reference({
      citation:
        "Règlement 45-106 pris en vertu de la Loi sur les valeurs mobilières (RLRQ, c. V-1.1), art. 1",
    } as never);
    expect(regActMissing.isError).toBe(true);
    expect(regActMissing.content[0].text).toContain("loi v-1.1-r.21");

    const igAct = await outils.resolve_reference({
      citation: "IG 45-106 relative à la Loi sur les valeurs mobilières (RLRQ, c. V-1.1), art. 1.1",
    } as never);
    expect(igAct.isError).toBeUndefined();
    expect(
      (igAct.structuredContent as { resolved: { law: string; number: string } }).resolved,
    ).toMatchObject({ law: "amf-ig-45-106", number: "1.1" });

    const loiV11 = await outils.resolve_reference({
      citation: "Loi sur les valeurs mobilières (RLRQ, c. V-1.1), art. 1",
    } as never);
    expect(loiV11.isError).toBeUndefined();
    expect(
      (loiV11.structuredContent as { resolved: { law: string; number: string } }).resolved,
    ).toMatchObject({ law: "v-1.1", number: "1" });

    for (const [cit, expLaw] of [
      ["Superior Court Directives — District of Montreal, para. 1", "qccs-dist-mtl"],
      ["Superior Court Directives — Division of Montreal, para. 1", "qccs-div-mtl"],
      ["Superior Court Directives — Quebec Division, para. 1", "qccs-div-qc"],
      ["Directives of the Superior Court — District of Montreal, para. 1", "qccs-dist-mtl"],
      ["Superior Court of Quebec — District of Montreal, para. 1", "qccs-dist-mtl"],
    ] as const) {
      const r = await outils.resolve_reference({ citation: cit } as never);
      expect(r.isError, cit).toBeUndefined();
      expect(
        (r.structuredContent as { resolved: { law: string; number: string } }).resolved,
        cit,
      ).toMatchObject({ law: expLaw, number: "1" });
    }
    const qcDist = await outils.resolve_reference({
      citation: "Superior Court Directives — Quebec District, para. 1",
    } as never);
    expect(qcDist.isError).toBe(true);

    const daaAnn = await outils.resolve_reference({
      citation: "Directive C.Q. (DAA), Annexe déontologie policière",
    } as never);
    expect(daaAnn.isError).toBeUndefined();
    expect(
      (daaAnn.structuredContent as { resolved: { law: string; number: string } }).resolved,
    ).toMatchObject({ law: "qccq-daa-jurisprudence", number: "annexe-deontologie-policiere" });

    const r51Part1 = await outils.resolve_reference({
      citation: "Règlement 51-102, Annexe 51-102A1, Partie 1",
    } as never);
    expect(r51Part1.isError).toBeUndefined();
    expect(
      (r51Part1.structuredContent as { resolved: { law: string; number: string } }).resolved,
    ).toMatchObject({ law: "v-1.1-r.24", number: "annexe-51-102a1-partie-1" });

    const r51Rub4 = await outils.resolve_reference({
      citation: "Règlement 51-102, Annexe 51-102A2, rubrique 4",
    } as never);
    expect(r51Rub4.isError).toBeUndefined();
    expect(
      (r51Rub4.structuredContent as { resolved: { law: string; number: string } }).resolved,
    ).toMatchObject({ law: "v-1.1-r.24", number: "annexe-51-102a2-rubrique-4" });

    const r45App1 = await outils.resolve_reference({
      citation: "Règlement 45-106, Annexe 45-106A1, Appendice 1",
    } as never);
    expect(r45App1.isError).toBeUndefined();
    expect(
      (r45App1.structuredContent as { resolved: { law: string; number: string } }).resolved,
    ).toMatchObject({ law: "v-1.1-r.21", number: "annexe-45-106a1-appendice-1" });

    const chB3 = await outils.resolve_reference({
      citation: "L.R.C. 1985, ch. B-3, art. 67",
    } as never);
    expect(chB3.isError).toBe(true);
    expect(chB3.content[0].text).toContain("B-3");
  });

  it("Round 7 Tier 5 : resolve_reference contre D1 — annexes v-1.1-r.21 Instructions générales / Instructions / prépositions vs IG", async () => {
    const outils = makeOutils();

    for (const [cit, expLaw, expNum] of [
      [
        "RLRQ, c. V-1.1, r. 21, Annexe 45-106A2, A. Instructions générales",
        "v-1.1-r.21",
        "annexe-45-106a2-a-instructions-generales",
      ],
      [
        "Règlement 45-106, Annexe 45-106A2, A. Instructions générales",
        "v-1.1-r.21",
        "annexe-45-106a2-a-instructions-generales",
      ],
      [
        "Règlement 45-106, Annexe 45-106A3, A. Instructions générales",
        "v-1.1-r.21",
        "annexe-45-106a3-a-instructions-generales",
      ],
      [
        "Règlement 45-106, Annexe 45-106A19 Instructions",
        "v-1.1-r.21",
        "annexe-45-106a19-instructions",
      ],
      [
        "Règlement 45-106, Annexe 45-106A19, Instructions",
        "v-1.1-r.21",
        "annexe-45-106a19-instructions",
      ],
      [
        "Règlement 45-106, Annexe 45-106A2 Instructions",
        "v-1.1-r.21",
        "annexe-45-106a2-instructions",
      ],
      [
        "RLRQ, c. V-1.1, r. 21, annexe 45 106a3 c mises a jour de la not",
        "v-1.1-r.21",
        "annexe-45-106a3-c-mises-a-jour-de-la-not",
      ],
      [
        "RLRQ, c. V-1.1, r. 21, annexe 45 106a3 d information sur l emet",
        "v-1.1-r.21",
        "annexe-45-106a3-d-information-sur-l-emet",
      ],
      ["Annexe A de l'Instruction générale 45-106", "amf-ig-45-106", "annexe-a"],
      [
        "IG 45-106 relative à la Loi sur les valeurs mobilières (RLRQ, c. V-1.1), art. 1.1",
        "amf-ig-45-106",
        "1.1",
      ],
    ] as const) {
      const r = await outils.resolve_reference({ citation: cit } as never);
      expect(r.isError, cit).toBeUndefined();
      expect(
        (r.structuredContent as { resolved: { law: string; number: string } }).resolved,
        cit,
      ).toMatchObject({ law: expLaw, number: expNum });
    }
  });
});
