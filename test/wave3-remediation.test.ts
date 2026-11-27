import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { DISPOSITION_SORT_BASE, type LawRow, parseCitation, sortKeyOf } from "../src/lib";
import { detectLanguageMismatch, normalize } from "../src/relevance";
import { construireOutils } from "../src/tools";

const db = () => (env as unknown as { DB: D1Database }).DB;

const legacySortKey = (n: number) => n * 1_000_000_000_000;

const FEDERAL_LAWS_SAMPLE = [
  {
    id: "ca-b-3",
    name_fr: "Loi sur la faillite et l’insolvabilité",
    official_cite: "L.R.C. (1985), ch. B-3",
    official_cite_en: "R.S.C. 1985, c. B-3",
  },
  {
    id: "ca-c-36",
    name_fr: "Loi sur les arrangements avec les créanciers des compagnies",
    official_cite: "L.R.C. (1985), ch. C-36",
    official_cite_en: "R.S.C. 1985, c. C-36",
  },
  {
    id: "ca-d-3.4",
    name_fr: "Loi sur le divorce",
    official_cite: "L.R.C. (1985), ch. 3 (2e suppl.)",
    official_cite_en: "R.S.C. 1985, c. 3 (2nd Supp.)",
  },
  {
    id: "ca-c-44",
    name_fr: "Loi canadienne sur les sociétés par actions",
    official_cite: "L.R.C. (1985), ch. C-44",
    official_cite_en: "R.S.C. 1985, c. C-44",
  },
  {
    id: "ca-c-42",
    name_fr: "Loi sur le droit d’auteur",
    official_cite: "L.R.C. (1985), ch. C-42",
    official_cite_en: "R.S.C. 1985, c. C-42",
  },
  {
    id: "ca-t-13",
    name_fr: "Loi sur les marques de commerce",
    official_cite: "L.R.C. (1985), ch. T-13",
    official_cite_en: "R.S.C. 1985, c. T-13",
  },
  {
    id: "ca-l-2",
    name_fr: "Code canadien du travail",
    official_cite: "L.R.C. (1985), ch. L-2",
    official_cite_en: "R.S.C. 1985, c. L-2",
  },
  {
    id: "ca-p-8.6",
    name_fr: "Loi sur la protection des renseignements personnels et les documents électroniques",
    official_cite: "L.C. 2000, ch. 5",
    official_cite_en: "S.C. 2000, c. 5",
  },
  {
    id: "ca-c-5",
    name_fr: "Loi sur la preuve au Canada",
    official_cite: "L.R.C. (1985), ch. C-5",
    official_cite_en: "R.S.C. 1985, c. C-5",
  },
  {
    id: "ca-f-7",
    name_fr: "Loi sur les Cours fédérales",
    official_cite: "L.R.C. (1985), ch. F-7",
    official_cite_en: "R.S.C. 1985, c. F-7",
  },
  {
    id: "ca-s-26",
    name_fr: "Loi sur la Cour suprême",
    official_cite: "L.R.C. (1985), ch. S-26",
    official_cite_en: "R.S.C. 1985, c. S-26",
  },
  {
    id: "ca-c-50",
    name_fr: "Loi sur la responsabilité civile de l’État et le contentieux administratif",
    official_cite: "L.R.C. (1985), ch. C-50",
    official_cite_en: "R.S.C. 1985, c. C-50",
  },
  {
    id: "ca-b-4",
    name_fr: "Loi sur les lettres de change",
    official_cite: "L.R.C. (1985), ch. B-4",
    official_cite_en: "R.S.C. 1985, c. B-4",
  },
  {
    id: "ca-dors-98-106",
    name_fr: "Règles des Cours fédérales",
    official_cite: "DORS/98-106",
    official_cite_en: "SOR/98-106",
    unit: "regle",
  },
  {
    id: "ca-crc-368",
    name_fr: "Règles générales sur la faillite et l’insolvabilité",
    official_cite: "C.R.C., ch. 368",
    official_cite_en: "C.R.C., c. 368",
  },
  {
    id: "ccq",
    name_fr: "Code civil du Québec",
    official_cite: "RLRQ, c. CCQ-1991",
    official_cite_en: "CQLR, c. CCQ-1991",
  },
  {
    id: "cpc",
    name_fr: "Code de procédure civile",
    official_cite: "RLRQ, c. C-25.01",
    official_cite_en: "CQLR, c. C-25.01",
  },
] as unknown as LawRow[];

describe("Wave 3 Remediation — D7, D16, D17, D19, D20", () => {
  beforeAll(async () => {
    const d = db();
    await d
      .prepare(
        `INSERT INTO laws (id, name_fr, name_en, official_cite, official_cite_en, consol_date_fr, consol_date_en, jurisdiction, source, fonction, unit, name_norm)
         VALUES
           ('ccq', 'Code civil du Québec', 'Civil Code of Québec', 'RLRQ, c. CCQ-1991', 'CQLR, c. CCQ-1991', '2026-02-23', '2026-02-10', 'qc', 'epub', 'loi', 'article', ?),
           ('cpc', 'Code de procédure civile', 'Code of Civil Procedure', 'RLRQ, c. C-25.01', 'CQLR, c. C-25.01', '2026-02-23', '2026-02-10', 'qc', 'epub', 'loi', 'article', ?),
           ('sans-date', 'Loi sans date', 'Undated Act', 'RLRQ, c. U-1', 'CQLR, c. U-1', NULL, NULL, 'qc', 'epub', 'loi', 'article', ?),
           ('ca-b-3', 'Loi sur la faillite et l’insolvabilité', 'Bankruptcy and Insolvency Act', 'L.R.C. (1985), ch. B-3', 'R.S.C. 1985, c. B-3', '2026-03-01', '2026-03-01', 'ca', 'lims', 'loi', 'article', ?)`,
      )
      .bind(
        normalize("Code civil du Québec"),
        normalize("Code de procédure civile"),
        normalize("Loi sans date"),
        normalize("Loi sur la faillite et l’insolvabilité"),
      )
      .run();

    await d
      .prepare(
        `INSERT INTO divisions (id, law_id, lang, kind, number, heading, heading_norm, path, sort_order)
         VALUES
           (1, 'ccq', 'fr', 'livre', 'V', 'DES OBLIGATIONS', 'des obligations', 'ga:l_v', 1),
           (2, 'ccq', 'en', 'livre', 'V', 'OBLIGATIONS', 'obligations', 'ga:l_five', 1),
           (3, 'cpc', 'fr', 'livre', 'II', 'PROCÉDURE CONTENTIEUSE', 'procedure contentieuse', 'ga:l_ii', 1),
           (4, 'cpc', 'en', 'livre', 'II', 'CONTENTIOUS PROCEEDINGS', 'contentious proceedings', 'ga:l_two', 1),
           (5, 'sans-date', 'fr', 'chapitre', 'I', 'OBJET', 'objet', 'ga:l_i', 1),
           (6, 'ca-b-3', 'fr', 'partie', 'III', 'PROPOSITIONS CONCORDATAIRES ET FAILLITE', 'propositions concordataires et faillite', 'pt:III', 1)`,
      )
      .run();

    const ccqNums = [2693, 2694, 2695, 2696, 2697, 3165, 3166, 3167, 3168, 3170];
    let artId = 1;
    for (const n of ccqNums) {
      await d
        .prepare(
          `INSERT INTO articles (id, law_id, lang, number, sort_key, division_id, division_path, text)
           VALUES (?, 'ccq', 'fr', ?, ?, 1, 'ga:l_v', ?)`,
        )
        .bind(artId++, String(n), legacySortKey(n), `Texte de l'article ${n} C.c.Q.`)
        .run();
    }
    await d
      .prepare(
        `INSERT INTO articles (id, law_id, lang, number, sort_key, division_id, division_path, text)
         VALUES (?, 'ccq', 'fr', 'finales', ?, 1, 'ga:l_v', 'Dispositions finales.')`,
      )
      .bind(artId++, DISPOSITION_SORT_BASE + 1_000_000)
      .run();

    await d
      .prepare(
        `INSERT INTO articles (id, law_id, lang, number, sort_key, division_id, division_path, text)
         VALUES
           (?, 'cpc', 'fr', '145', ?, 3, 'ga:l_ii', 'Le défendeur doit répondre dans les 15 jours.'),
           (?, 'cpc', 'fr', '146', ?, 3, 'ga:l_ii', 'La réponse précise les moyens de défense.'),
           (?, 'cpc', 'en', '145', ?, 4, 'ga:l_two', 'The defendant must answer within 15 days.'),
           (?, 'cpc', 'en', '146', ?, 4, 'ga:l_two', 'The answer states the grounds of defence.'),
           (?, 'sans-date', 'fr', '1', ?, 5, 'ga:l_i', 'Article premier sans date de consolidation.'),
           (?, 'ca-b-3', 'fr', '69.3', ?, 6, 'pt:III', 'Suspension des procédures lors de la faillite.'),
           (?, 'ccq', 'fr', '1457', ?, 1, 'ga:l_v', 'Toute personne a le devoir de respecter les règles de conduite et de réparer le préjudice.'),
           (?, 'ccq', 'en', '1457', ?, 2, 'ga:l_five', 'Every person has a duty to abide by the rules of conduct and repair injury caused.')`,
      )
      .bind(
        artId++,
        sortKeyOf("145"),
        artId++,
        sortKeyOf("146"),
        artId++,
        sortKeyOf("145"),
        artId++,
        sortKeyOf("146"),
        artId++,
        sortKeyOf("1"),
        artId++,
        sortKeyOf("69.3"),
        artId++,
        legacySortKey(1457),
        artId++,
        legacySortKey(1457),
      )
      .run();

    await d.prepare("INSERT INTO articles_fts(articles_fts) VALUES('rebuild')").run();
  });

  const makeOutils = (federal = "1") =>
    construireOutils({
      DB: db(),
      FEDERAL_CORPUS: federal,
      PDF_CORPUS: "1",
      HYBRID_SEARCH: "0",
      RELAX_SEARCH: "1",
    } as unknown as Env);

  it("D16 : get_articles émet l'en-tête titre/citation + date de consolidation en prose et structuredContent", async () => {
    const outils = makeOutils();

    const fr = await outils.get_articles({ law: "cpc", numbers: ["145"], lang: "fr" } as never);
    expect(fr.isError).toBeUndefined();
    expect(fr.content[0].text).toContain(
      "Code de procédure civile (RLRQ, c. C-25.01) (à jour au 2026-02-23)",
    );
    expect(fr.content[0].text).not.toContain("Introuvable");
    expect(fr.structuredContent).toMatchObject({
      consolidation: "2026-02-23",
      missing_numbers: [],
    });

    const enRange = await outils.get_articles({
      law: "cpc",
      from: "145",
      to: "146",
      lang: "en",
    } as never);
    expect(enRange.isError).toBeUndefined();
    expect(enRange.content[0].text).toContain(
      "Code of Civil Procedure (CQLR, c. C-25.01) (updated to 2026-02-10)",
    );
    expect(enRange.structuredContent).toMatchObject({
      consolidation: "2026-02-10",
    });
    expect(enRange.structuredContent?.missing_numbers).toBeUndefined();

    const undated = await outils.get_articles({ law: "sans-date", numbers: ["1"] } as never);
    expect(undated.isError).toBeUndefined();
    expect(undated.content[0].text).toContain("Loi sans date (RLRQ, c. U-1)");
    expect(undated.content[0].text).not.toContain("à jour au");
    expect(undated.structuredContent?.consolidation).toBeNull();
  });

  it("D7 : get_articles signale explicitement les numéros manquants en mode numbers[]", async () => {
    const outils = makeOutils();

    const frMissing = await outils.get_articles({
      law: "cpc",
      numbers: ["145", "9999"],
      lang: "fr",
    } as never);
    expect(frMissing.isError).toBeUndefined();
    expect(frMissing.content[0].text).toContain("Introuvable(s) dans cpc (fr) : 9999.");
    expect(frMissing.structuredContent).toMatchObject({
      count: 1,
      missing_numbers: ["9999"],
    });

    const enMissing = await outils.get_articles({
      law: "cpc",
      numbers: [" 145 ", "9999", "145", "8888"],
      lang: "en",
    } as never);
    expect(enMissing.isError).toBeUndefined();
    expect(enMissing.content[0].text).toContain("Not found in cpc (en): 9999, 8888.");
    expect(enMissing.structuredContent).toMatchObject({
      count: 1,
      missing_numbers: ["9999", "8888"],
    });

    const allMissing = await outils.get_articles({
      law: "cpc",
      numbers: ["9998", "9999"],
      lang: "fr",
    } as never);
    expect(allMissing.isError).toBe(true);
    expect(allMissing.content[0].text).toContain("9998, 9999");

    const blankNums = await outils.get_articles({
      law: "cpc",
      numbers: ["  ", ""],
    } as never);
    expect(blankNums.isError).toBe(true);
  });

  it("D17 : detectLanguageMismatch détecte les décalages francs sans faux positifs bilingues", () => {
    for (const q of [
      "breach of contract damages",
      "landlord and tenant eviction",
      "limitation of liability",
      "defendant outside Quebec time to answer",
      "shareholder agreement without notice",
    ]) {
      expect(detectLanguageMismatch(q, "fr"), q).toContain("lang='en'");
    }

    for (const q of [
      "responsabilité civile faute préjudice",
      "délai de prescription",
      "vice caché maison",
      "les obligations du contrat",
      "congédiement sans préavis",
      "procédure",
      "demande pour vice",
    ]) {
      expect(detectLanguageMismatch(q, "en"), q).toContain("lang='fr'");
    }

    expect(
      detectLanguageMismatch("Court of Québec civil notice provisional roll", "en"),
    ).toBeNull();
    expect(detectLanguageMismatch("Superior Court Montréal practice", "en")).toBeNull();
    expect(
      detectLanguageMismatch("commercial lease resiliation failure to pay rent", "en"),
    ).toBeNull();
    expect(detectLanguageMismatch("procedure", "en")).toBeNull();
    expect(detectLanguageMismatch("Bélanger", "en")).toBeNull();
    expect(detectLanguageMismatch("Québec", "en")).toBeNull();
    expect(detectLanguageMismatch("vice versa", "en")).toBeNull();
    expect(detectLanguageMismatch("damages", "fr")).toBeNull();
    expect(detectLanguageMismatch("Bank of Montreal", "fr")).toBeNull();
    expect(detectLanguageMismatch("Convention La Haye", "fr")).toBeNull();
    expect(detectLanguageMismatch("clause non-concurrence fin d'emploi", "fr")).toBeNull();
  });

  it("D17 : find_relevant et search_text servent avertissement_langue en prose et structuredContent", async () => {
    const outils = makeOutils();

    const frSearchWithEnQuery = await outils.search_text({
      query: "duty to repair injury caused",
      lang: "fr",
    } as never);
    expect(frSearchWithEnQuery.isError).toBe(true);
    expect(frSearchWithEnQuery.content[0].text).toContain("lang='en'");

    const enSearchWithEnQuery = await outils.search_text({
      query: "duty to repair injury caused",
      lang: "en",
    } as never);
    expect(enSearchWithEnQuery.isError).toBeUndefined();
    expect(enSearchWithEnQuery.structuredContent?.avertissement_langue).toBeUndefined();

    const frQueryUnderEn = await outils.search_text({
      query: "règles de conduite et de réparer le préjudice",
      lang: "en",
    } as never);
    expect(frQueryUnderEn.isError).toBe(true);
    expect(frQueryUnderEn.content[0].text).toContain("lang='fr'");

    await db()
      .prepare(
        `INSERT INTO articles (id, law_id, lang, number, sort_key, division_id, division_path, text)
         VALUES (999, 'cpc', 'fr', '900', ?, 3, 'ga:l_ii', 'breach contract damages witness')`,
      )
      .bind(sortKeyOf("900"))
      .run();
    await db().prepare("INSERT INTO articles_fts(articles_fts) VALUES('rebuild')").run();

    const hitWarn = await outils.search_text({
      query: "breach contract damages",
      lang: "fr",
    } as never);
    expect(hitWarn.isError).toBeUndefined();
    expect(hitWarn.content[0].text).toContain("lang='en'");
    expect(hitWarn.structuredContent?.avertissement_langue).toContain("lang='en'");

    const frFindZero = await outils.find_relevant({
      query: "breach of contract damages",
      lang: "fr",
    } as never);
    expect(frFindZero.isError).toBe(true);
    expect(frFindZero.content[0].text).toContain("lang='en'");

    const frFindHit = await outils.find_relevant({
      query: "breach of obligations without notice",
      lang: "fr",
    } as never);
    expect(frFindHit.isError).toBeUndefined();
    expect(frFindHit.content[0].text).toContain("lang='en'");
    expect(frFindHit.structuredContent?.avertissement_langue).toContain("lang='en'");

    const enFindHit = await outils.find_relevant({
      query: "responsabilité des obligations",
      lang: "en",
    } as never);
    expect(enFindHit.isError).toBeUndefined();
    expect(enFindHit.content[0].text).toContain("lang='fr'");
    expect(enFindHit.structuredContent?.avertissement_langue).toContain("lang='fr'");

    const validEnFind = await outils.find_relevant({
      query: "Court of Québec contentious proceedings",
      lang: "en",
    } as never);
    expect(validEnFind.isError).toBeUndefined();
    expect(validEnFind.structuredContent?.avertissement_langue).toBeUndefined();
    expect(validEnFind.content[0].text).not.toContain("appears to be in French");
  });

  it("D19 : get_article(law='ccq', article='3169') et resolve_reference retournent 3165..3168/3170 et jamais 2693..2697", async () => {
    const outils = makeOutils();

    const ga = await outils.get_article({ law: "ccq", article: "3169", lang: "fr" } as never);
    expect(ga.isError).toBe(true);
    expect(ga.content[0].text).toContain("3168");
    expect(ga.content[0].text).toContain("3170");
    expect(ga.content[0].text).toContain("3167");
    expect(ga.content[0].text).not.toContain("2694");
    expect(ga.content[0].text).not.toContain("2695");
    expect(ga.content[0].text).not.toContain("finales");

    const rr = await outils.resolve_reference({
      citation: "art. 3169 C.c.Q.",
      lang: "fr",
    } as never);
    expect(rr.isError).toBe(true);
    expect(rr.content[0].text).toContain("3168");
    expect(rr.content[0].text).toContain("3170");
    expect(rr.content[0].text).not.toContain("2694");
  });

  it("D20 : parseCitation résout les abréviations fédérales usuelles FR/EN et respecte FEDERAL_CORPUS", async () => {
    const cases: Array<[string, string, string]> = [
      ["art. 69.3 L.F.I.", "ca-b-3", "69.3"],
      ["art. 69.3 LFI", "ca-b-3", "69.3"],
      ["s. 69.3 B.I.A.", "ca-b-3", "69.3"],
      ["s. 69.3 BIA", "ca-b-3", "69.3"],
      ["art. 241 L.C.S.A.", "ca-c-44", "241"],
      ["art. 241 LCSA", "ca-c-44", "241"],
      ["s. 241 C.B.C.A.", "ca-c-44", "241"],
      ["s. 241 CBCA", "ca-c-44", "241"],
      ["art. 11.02 L.A.C.C.", "ca-c-36", "11.02"],
      ["art. 11.02 LACC", "ca-c-36", "11.02"],
      ["s. 11.02 C.C.A.A.", "ca-c-36", "11.02"],
      ["s. 11.02 CCAA", "ca-c-36", "11.02"],
      ["art. 15.1 L.D.", "ca-d-3.4", "15.1"],
      ["L.D., art. 15.1", "ca-d-3.4", "15.1"],
      ["L.D. s. 15.1", "ca-d-3.4", "15.1"],
      ["art. 34 L.D.A.", "ca-c-42", "34"],
      ["art. 34 LDA", "ca-c-42", "34"],
      ["art. 19 L.M.C.", "ca-t-13", "19"],
      ["s. 19 T.M.A.", "ca-t-13", "19"],
      ["art. 240 C.c.t.", "ca-l-2", "240"],
      ["s. 240 C.L.C.", "ca-l-2", "240"],
      ["art. 5 L.P.R.P.D.E.", "ca-p-8.6", "5"],
      ["art. 5 LPRPDE", "ca-p-8.6", "5"],
      ["s. 5 P.I.P.E.D.A.", "ca-p-8.6", "5"],
      ["s. 5 PIPEDA", "ca-p-8.6", "5"],
      ["s. 30 C.E.A.", "ca-c-5", "30"],
      ["art. 18.1 L.C.F.", "ca-f-7", "18.1"],
      ["s. 18.1 F.C.A.", "ca-f-7", "18.1"],
      ["art. 40 L.C.S.", "ca-s-26", "40"],
      ["s. 40 S.C.A.", "ca-s-26", "40"],
      ["art. 3 L.R.C.E.C.A.", "ca-c-50", "3"],
      ["s. 3 C.L.P.A.", "ca-c-50", "3"],
      ["art. 16 L.L.C.", "ca-b-4", "16"],
      ["s. 16 B.E.A.", "ca-b-4", "16"],
      ["règle 221 R.C.F.", "ca-dors-98-106", "221"],
      ["rule 221 F.C.R.", "ca-dors-98-106", "221"],
      ["DORS/98-106, règle 221", "ca-dors-98-106", "221"],
      ["SOR/98-106, rule 221", "ca-dors-98-106", "221"],
      ["art. 105 R.G.F.I.", "ca-crc-368", "105"],
      ["s. 105 B.I.G.R.", "ca-crc-368", "105"],
    ];

    for (const [cit, expLaw, expArt] of cases) {
      expect(parseCitation(cit, FEDERAL_LAWS_SAMPLE), cit).toMatchObject({
        law: expLaw,
        article: expArt,
        ambigu: null,
      });
    }

    expect(parseCitation("art. 10 L.P.C.", FEDERAL_LAWS_SAMPLE).law).toBeNull();
    expect(parseCitation("art. 15 L.D.Q.", FEDERAL_LAWS_SAMPLE).law).toBeNull();
    expect(parseCitation("art. 10 L.C.S.Q.", FEDERAL_LAWS_SAMPLE).law).toBeNull();
    expect(parseCitation("Acme LLC, art. 1", FEDERAL_LAWS_SAMPLE).law).toBeNull();

    const qcOnly = FEDERAL_LAWS_SAMPLE.filter((l) => !l.id.startsWith("ca-"));
    expect(parseCitation("art. 69.3 L.F.I.", qcOnly).law).toBeNull();

    const outilsOpen = makeOutils("1");
    const rrOpen = await outilsOpen.resolve_reference({ citation: "art. 69.3 L.F.I." } as never);
    expect(rrOpen.isError).toBeUndefined();
    expect(rrOpen.structuredContent?.resolved).toMatchObject({
      law: "ca-b-3",
      number: "69.3",
      reconnue_par: "abreviation",
    });

    const outilsClosed = makeOutils("0");
    const rrClosed = await outilsClosed.resolve_reference({
      citation: "art. 69.3 L.F.I.",
    } as never);
    expect(rrClosed.isError).toBe(true);
  });

  it("B-N1 & B-N6 & B-N11 : get_articles gère l'échelle 1000^4 sur borne absente, la troncature, l'inversion et les bornes alphabétiques", async () => {
    const outils = makeOutils();

    const narrow = await outils.get_articles({
      law: "ccq",
      from: "1457",
      to: "1457.5",
    } as never);
    expect(narrow.isError).toBeUndefined();
    expect(
      ((narrow.structuredContent?.articles ?? []) as Array<{ number: string }>).map(
        (a) => a.number,
      ),
    ).toEqual(["1457"]);
    expect(narrow.content[0].text).toContain("1457.5");

    const upperOpen = await outils.get_articles({
      law: "ccq",
      from: "3165",
      to: "3200",
    } as never);
    expect(upperOpen.isError).toBeUndefined();
    expect(
      ((upperOpen.structuredContent?.articles ?? []) as Array<{ number: string }>).map(
        (a) => a.number,
      ),
    ).toEqual(["3165", "3166", "3167", "3168", "3170"]);
    expect(upperOpen.content[0].text).toContain("3200");

    const alpha = await outils.get_articles({
      law: "ccq",
      from: "abc",
      to: "1460",
    } as never);
    expect(alpha.isError).toBe(true);
    expect(alpha.content[0].text).toContain("abc");

    const inv = await outils.get_articles({
      law: "ccq",
      from: "3168",
      to: "3165",
    } as never);
    expect(inv.isError).toBeUndefined();
    expect(inv.content[0].text).toContain("bornes inversées");

    const page1 = await outils.get_articles({
      law: "ccq",
      from: "2693",
      to: "3170",
      limit: 3,
      offset: 0,
    } as never);
    expect(page1.isError).toBeUndefined();
    expect(page1.content[0].text).toContain("Articles 1–3 / ");
    expect(page1.content[0].text).toContain("suite : offset=3");

    const withBlank = await outils.get_articles({
      law: "cpc",
      numbers: ["145", ""],
    } as never);
    expect(withBlank.isError).toBeUndefined();
    expect(withBlank.content[0].text).toContain("(chaîne vide)");
  });

  it("B-N2 : get_articles découpe numbers[] au-delà de 98 éléments (limite D1 à 100 paramètres)", async () => {
    const outils = makeOutils();
    const nums = [
      "1457",
      "2693",
      "3170",
      ...Array.from({ length: 147 }, (_, i) => String(4000 + i)),
    ];
    const res = await outils.get_articles({
      law: "ccq",
      numbers: nums,
    } as never);
    expect(res.isError).toBeUndefined();
    expect(
      ((res.structuredContent?.articles ?? []) as Array<{ number: string }>).map((a) => a.number),
    ).toEqual(["1457", "2693", "3170"]);
  });

  it("B-N8 : parseCitation & resolve_reference gèrent les intitulés complets, L.I. ambiguë, les plages et alinéas", async () => {
    const withInterps = [
      ...FEDERAL_LAWS_SAMPLE,
      {
        id: "i-16",
        name_fr: "Loi d’interprétation",
        name_en: "Interpretation Act",
        official_cite: "RLRQ, c. I-16",
        official_cite_en: "CQLR, c. I-16",
      },
      {
        id: "ca-i-21",
        name_fr: "Loi d’interprétation",
        name_en: "Interpretation Act",
        official_cite: "L.R.C. (1985), ch. I-21",
        official_cite_en: "R.S.C. 1985, c. I-21",
      },
    ] as unknown as LawRow[];

    expect(parseCitation("article 1457 du Code civil du Québec", withInterps)).toMatchObject({
      law: "ccq",
      article: "1457",
    });
    expect(parseCitation("Code civil du Québec, art. 1457", withInterps)).toMatchObject({
      law: "ccq",
      article: "1457",
    });
    expect(
      parseCitation("art. 52 L.I.", withInterps)
        .ambigu?.map((a) => a.id)
        .sort(),
    ).toEqual(["ca-i-21", "i-16"]);
    expect(parseCitation("art. 52 L.I. (Québec)", withInterps)).toMatchObject({
      law: "i-16",
      article: "52",
      ambigu: null,
    });

    const outils = makeOutils();
    const rrRange = await outils.resolve_reference({
      citation: "art. 1457 à 1460 C.c.Q.",
    } as never);
    expect(rrRange.isError).toBeUndefined();
    expect(rrRange.content[0].text).toContain("plage détectée (1457 à 1460)");
    expect(rrRange.content[0].text).toContain("get_articles");

    const rrAlinea = await outils.resolve_reference({
      citation: "art. 1457, al. 2 C.c.Q.",
    } as never);
    expect(rrAlinea.isError).toBeUndefined();
    expect(rrAlinea.content[0].text).toContain("alinéa relevé (al. 2)");
  });

  it("B-N9, B-N10, B-N11 : NFD/ligature search_text, offset > total, get_article trim/casse/preliminaire, get_division offset", async () => {
    const outils = makeOutils();

    const trimmed = await outils.get_article({ law: " CCQ ", article: "1457 " } as never);
    expect(trimmed.isError).toBeUndefined();
    expect(trimmed.structuredContent?.law).toBe("ccq");
    expect(trimmed.structuredContent?.number).toBe("1457");

    const prelimMiss = await outils.get_article({
      law: "ccq",
      article: "preliminaire",
    } as never);
    expect(prelimMiss.isError).toBe(true);
    expect(prelimMiss.content[0].text).toContain("finales");

    const divEmpty = await outils.get_division({
      law: "ccq",
      path: "ga:l_v",
      offset: 999,
    } as never);
    expect(divEmpty.isError).toBeUndefined();
    expect(divEmpty.content[0].text).toContain("offset=999 ; total :");

    await db()
      .prepare(
        `INSERT INTO articles (id, law_id, lang, number, sort_key, division_id, division_path, text)
         VALUES (998, 'ccq', 'fr', '2100', ?, 1, 'ga:l_v', 'Responsabilité du maître d’œuvre pour la malfaçon.')`,
      )
      .bind(legacySortKey(2100))
      .run();
    await db().prepare("INSERT INTO articles_fts(articles_fts) VALUES('rebuild')").run();

    const nfd = await outils.search_text({
      query: "pre\u0301judice",
      law: "ccq",
    } as never);
    expect(nfd.isError).toBeUndefined();
    expect(nfd.structuredContent?.total).toBeGreaterThanOrEqual(1);

    const oeAsc = await outils.search_text({
      query: "maitre d'oeuvre",
      law: "ccq",
    } as never);
    expect(oeAsc.isError).toBeUndefined();
    expect(
      ((oeAsc.structuredContent?.results ?? []) as Array<{ number: string }>).some(
        (r) => r.number === "2100",
      ),
    ).toBe(true);

    const oeLig = await outils.search_text({
      query: "maître d’œuvre",
      law: "ccq",
    } as never);
    expect(oeLig.isError).toBeUndefined();
    expect(
      ((oeLig.structuredContent?.results ?? []) as Array<{ number: string }>).some(
        (r) => r.number === "2100",
      ),
    ).toBe(true);

    const overOffset = await outils.search_text({
      query: "article",
      law: "ccq",
      offset: 500,
    } as never);
    expect(overOffset.isError).toBe(true);
    expect(overOffset.content[0].text).toContain("Offset (500) au-delà du total");
  });

  it("post-stress-test gaps : ordinal 1er/1re, get_structure sur texte plat sans divisions, déduplication list_laws X / X", async () => {
    const pSingle = parseCitation("art. 1er C.c.Q.", FEDERAL_LAWS_SAMPLE);
    expect(pSingle.law).toBe("ccq");
    expect(pSingle.article).toBe("1");

    const pSup = parseCitation("art. 1\u1d49\u02b3 C.c.Q.", FEDERAL_LAWS_SAMPLE);
    expect(pSup.law).toBe("ccq");
    expect(pSup.article).toBe("1");

    const pRange = parseCitation("art. 1er à 5 C.c.Q.", FEDERAL_LAWS_SAMPLE);
    expect(pRange.law).toBe("ccq");
    expect(pRange.article).toBe("1");
    expect(pRange.plage_fin).toBe("5");

    const pSupRange = parseCitation("art. 1\u02b3\u1d49 à 5 C.c.Q.", FEDERAL_LAWS_SAMPLE);
    expect(pSupRange.law).toBe("ccq");
    expect(pSupRange.article).toBe("1");
    expect(pSupRange.plage_fin).toBe("5");

    const pAl = parseCitation("1er al. 1457 C.c.Q.", FEDERAL_LAWS_SAMPLE);
    expect(pAl.law).toBe("ccq");
    expect(pAl.article).toBe("1457");

    const pAlNoNum = parseCitation("C.c.Q., 1er alinéa", FEDERAL_LAWS_SAMPLE);
    expect(pAlNoNum.law).toBe("ccq");
    expect(pAlNoNum.article).toBeNull();

    await db()
      .prepare(
        `INSERT OR IGNORE INTO laws (id, name_fr, name_en, official_cite, consol_date_fr, consol_date_en, jurisdiction, source, fonction, unit, name_norm)
         VALUES
           ('b-1-r.5', 'Règlement test', 'Règlement test', 'RLRQ, c. B-1, r. 5', '2026-07-01', '2026-07-01', 'qc', 'pdf', 'reglement', 'article', 'reglement test'),
           ('vide-test', 'Loi vide test', 'Empty Test Act', 'RLRQ, c. V-99', '2026-07-01', '2026-07-01', 'qc', 'epub', 'loi', 'article', 'loi vide test')`,
      )
      .run();
    await db()
      .prepare(
        `INSERT OR IGNORE INTO articles (id, law_id, lang, number, sort_key, division_id, division_path, text)
         VALUES
           (997, 'b-1-r.5', 'fr', '1', ?, NULL, '', 'Article premier test.'),
           (996, 'b-1-r.5', 'en', '1', ?, NULL, '', 'First test section.')`,
      )
      .bind(legacySortKey(1), legacySortKey(1))
      .run();

    const outils = makeOutils();

    const rOrd = await outils.get_article({ law: "b-1-r.5", article: "1er" } as never);
    expect(rOrd.isError).toBeUndefined();
    expect(rOrd.structuredContent?.number).toBe("1");

    const rNums = await outils.get_articles({ law: "b-1-r.5", numbers: ["1er"] } as never);
    expect(rNums.isError).toBeUndefined();
    expect(rNums.structuredContent?.count).toBe(1);
    expect(rNums.structuredContent?.missing_numbers).toEqual([]);

    const rFlat = await outils.get_structure({ law: "b-1-r.5" } as never);
    expect(rFlat.isError).toBeUndefined();
    expect(rFlat.structuredContent?.tree).toEqual([]);
    expect(rFlat.structuredContent?.flat_text).toBe(true);
    expect(rFlat.content[0].text).toContain("get_articles");

    const rFlatEn = await outils.get_structure({ law: "b-1-r.5", lang: "en" } as never);
    expect(rFlatEn.isError).toBeUndefined();
    expect(rFlatEn.structuredContent?.flat_text).toBe(true);
    expect(rFlatEn.content[0].text).toContain("lang='en'");

    const rEmptyLaw = await outils.get_structure({ law: "vide-test" } as never);
    expect(rEmptyLaw.isError).toBe(true);

    const rBadRoot = await outils.get_structure({
      law: "b-1-r.5",
      root_path: "ga:inexistant",
    } as never);
    expect(rBadRoot.isError).toBe(true);

    const rLaws = await outils.list_laws({ structure: false } as never);
    expect(rLaws.content[0].text).not.toContain("Règlement test / Règlement test");
  });
});
