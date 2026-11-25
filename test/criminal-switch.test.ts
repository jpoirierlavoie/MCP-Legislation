import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { listLaws } from "../src/lib";
import { renderSite } from "../src/site";
import { construireOutils } from "../src/tools";

const db = () => (env as unknown as { DB: D1Database }).DB;

function makeVectorMocks() {
  const AI = {
    async run(_model: string, input: { text: string[] }) {
      return { data: input.text.map(() => [0.5, 0.5, 0.5, 0.5]) };
    },
  } as unknown as Ai;

  const VECTORS = {
    async query(_values: number[], opts?: { filter?: { law?: string } }) {
      const allMatches = [
        {
          id: "art-essai-ca-penal-2",
          score: 0.96,
          metadata: {
            type: "article",
            law: "essai-ca-penal",
            article: "2",
            domain: "penal",
            jurisdiction: "ca",
          },
        },
        {
          id: "art-essai-ca-penal-1",
          score: 0.92,
          metadata: {
            type: "article",
            law: "essai-ca-penal",
            article: "1",
            domain: "penal",
            jurisdiction: "ca",
          },
        },
        {
          id: "art-essai-qc-penal-1",
          score: 0.88,
          metadata: {
            type: "article",
            law: "essai-qc-penal",
            article: "1",
            domain: "penal",
            jurisdiction: "qc",
          },
        },
        {
          id: "art-essai-qc-core-1",
          score: 0.85,
          metadata: {
            type: "article",
            law: "essai-qc-core",
            article: "1",
            domain: "core",
            jurisdiction: "qc",
          },
        },
        {
          id: "div-essai-ca-penal-1",
          score: 0.93,
          metadata: {
            type: "division",
            law: "essai-ca-penal",
            path: "fh1:1",
            heading: "INFRACTIONS CRIMINELLES",
            domain: "penal",
            jurisdiction: "ca",
          },
        },
        {
          id: "div-essai-qc-penal-1",
          score: 0.84,
          metadata: {
            type: "division",
            law: "essai-qc-penal",
            path: "ga:l_i",
            heading: "POURSUITES PÉNALES",
            domain: "penal",
            jurisdiction: "qc",
          },
        },
      ];
      const law = opts?.filter?.law;
      return {
        matches: law ? allMatches.filter((m) => m.metadata.law === law) : allMatches,
      };
    },
  } as unknown as VectorizeIndex;

  return { AI, VECTORS };
}

function makeRegistre(flags: {
  FEDERAL_CORPUS?: string;
  PDF_CORPUS?: string;
  CRIMINAL_CORPUS?: string;
  HYBRID_SEARCH?: string;
  DOMAIN_QUARANTINE?: string;
}) {
  const { AI, VECTORS } = makeVectorMocks();
  return construireOutils({
    DB: db(),
    RELAX_SEARCH: "1",
    HYBRID_SEARCH: flags.HYBRID_SEARCH ?? "0",
    FEDERAL_CORPUS: flags.FEDERAL_CORPUS,
    PDF_CORPUS: flags.PDF_CORPUS,
    CRIMINAL_CORPUS: flags.CRIMINAL_CORPUS,
    DOMAIN_QUARANTINE: flags.DOMAIN_QUARANTINE ?? "1",
    AI,
    VECTORS,
  } as unknown as Parameters<typeof construireOutils>[0]);
}

async function seedCorpus(): Promise<void> {
  const d = db();
  const insertLaw = d.prepare(
    `INSERT INTO laws (id, name_fr, name_en, official_cite, official_cite_en, chapter, consol_date_fr, consol_date_en, jurisdiction, source, fonction, domain, name_norm)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  await d.batch([
    insertLaw.bind(
      "essai-qc-core",
      "Loi civile d'essai QC",
      "Test QC Civil Act",
      "RLRQ, c. E-10",
      "CQLR, c. E-10",
      null,
      "2026-09-01",
      "2026-09-01",
      "qc",
      "epub",
      "loi",
      "core",
      "loi civile d essai qc",
    ),
    insertLaw.bind(
      "essai-qc-penal",
      "Code pénal provincial d'essai",
      "Test Provincial Penal Code",
      "RLRQ, c. C-25.1",
      "CQLR, c. C-25.1",
      null,
      "2026-09-01",
      "2026-09-01",
      "qc",
      "epub",
      "loi",
      "penal",
      "code penal provincial d essai",
    ),
    insertLaw.bind(
      "essai-ca-core",
      "Loi fédérale civile d'essai",
      "Test Federal Civil Act",
      "L.R.C. (1985), ch. C-5",
      "R.S.C. 1985, c. C-5",
      "C-5",
      "2026-09-02",
      "2026-09-02",
      "ca",
      "lims",
      "loi",
      "core",
      "loi federale civile d essai",
    ),
    insertLaw.bind(
      "essai-ca-penal",
      "Loi criminelle fédérale d'essai",
      "Test Federal Criminal Act",
      "L.R.C. (1985), ch. C-46",
      "R.S.C. 1985, c. C-46",
      "C-46",
      "2026-10-29",
      "2026-10-29",
      "ca",
      "lims",
      "loi",
      "penal",
      "loi criminelle federale d essai",
    ),
  ]);

  const divs: [number, string, string, string, string, string, string, string][] = [
    [1, "essai-qc-core", "fr", "chapitre", "I", "PREUVE CIVILE", "preuve civile", "ga:l_i"],
    [
      2,
      "essai-qc-penal",
      "fr",
      "chapitre",
      "I",
      "POURSUITES PÉNALES",
      "poursuites penales",
      "ga:l_i",
    ],
    [3, "essai-ca-core", "fr", "partie", "I", "PREUVE FÉDÉRALE", "preuve federale", "fh1:1"],
    [
      4,
      "essai-ca-penal",
      "fr",
      "partie",
      "I",
      "INFRACTIONS CRIMINELLES",
      "infractions criminelles",
      "fh1:1",
    ],
    [5, "essai-qc-core", "en", "chapitre", "I", "CIVIL EVIDENCE", "civil evidence", "ga:l_i"],
    [
      6,
      "essai-qc-penal",
      "en",
      "chapitre",
      "I",
      "PENAL PROCEEDINGS",
      "penal proceedings",
      "ga:l_i",
    ],
    [7, "essai-ca-core", "en", "partie", "I", "FEDERAL EVIDENCE", "federal evidence", "fh1:1"],
    [8, "essai-ca-penal", "en", "partie", "I", "CRIMINAL OFFENCES", "criminal offences", "fh1:1"],
  ];
  for (const [id, lawId, lang, kind, num, heading, headingNorm, path] of divs) {
    await d
      .prepare(
        "INSERT INTO divisions (id, law_id, lang, kind, number, heading, heading_norm, path, sort_order) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .bind(id, lawId, lang, kind, num, heading, headingNorm, path, id)
      .run();
  }

  const arts: [number, string, string, string, number, number, string, string][] = [
    [
      1,
      "essai-qc-core",
      "fr",
      "1",
      1_000_000_000_000,
      1,
      "ga:l_i",
      "Perquisition civile ordinaire.",
    ],
    [
      2,
      "essai-qc-penal",
      "fr",
      "1",
      1_000_000_000_000,
      2,
      "ga:l_i",
      "Perquisition et constat d'infraction pénale provinciale.",
    ],
    [
      3,
      "essai-ca-core",
      "fr",
      "1",
      1_000_000_000_000,
      3,
      "fh1:1",
      "Perquisition documentaire civile fédérale.",
    ],
    [
      4,
      "essai-ca-penal",
      "fr",
      "1",
      1_000_000_000_000,
      4,
      "fh1:1",
      "Perquisition criminelle et mandat judiciaire.",
    ],
    [
      5,
      "essai-ca-penal",
      "fr",
      "2",
      2_000_000_000_000,
      4,
      "fh1:1",
      "Voies de fait armées exclusives au Code criminel.",
    ],
  ];
  for (const [id, lawId, lang, num, key, divId, path, text] of arts) {
    await d
      .prepare(
        "INSERT INTO articles (id, law_id, lang, number, sort_key, division_id, division_path, text) VALUES (?,?,?,?,?,?,?,?)",
      )
      .bind(id, lawId, lang, num, key, divId, path, text)
      .run();
  }
  await d.prepare("INSERT INTO articles_fts(articles_fts) VALUES('rebuild')").run();

  await d
    .prepare(
      "INSERT INTO subjects (id, label_fr, label_en, kind, description_fr, description_en, label_norm) VALUES (?,?,?,?,?,?,?)",
    )
    .bind(
      "sujet-penal-qc",
      "Procédure pénale",
      "Penal Procedure",
      "specialise",
      "poursuite penale constat",
      "penal proceeding ticket",
      "procedure penale",
    )
    .run();
  await d
    .prepare(
      "INSERT INTO subjects (id, label_fr, label_en, kind, description_fr, description_en, label_norm) VALUES (?,?,?,?,?,?,?)",
    )
    .bind(
      "sujet-criminel-ca",
      "Droit criminel",
      "Criminal Law",
      "specialise",
      "infractions criminelles mandat",
      "criminal offences warrant",
      "droit criminel",
    )
    .run();

  await d
    .prepare("INSERT INTO subject_map (subject_id, law_id, division_path) VALUES (?,?,?)")
    .bind("sujet-penal-qc", "essai-qc-penal", "ga:l_i")
    .run();
  await d
    .prepare("INSERT INTO subject_map (subject_id, law_id, division_path) VALUES (?,?,?)")
    .bind("sujet-criminel-ca", "essai-ca-penal", "fh1:1")
    .run();
  await d
    .prepare("INSERT INTO subject_map (subject_id, law_id, division_path) VALUES (?,?,?)")
    .bind("sujet-penal-qc", "essai-ca-penal", "fh1:1")
    .run();

  await d
    .prepare(
      "INSERT INTO law_relations (from_law_id, to_law_id, rel_type, source, weight, in_corpus, note) VALUES (?,?,?,?,?,?,?)",
    )
    .bind("essai-qc-penal", "essai-ca-penal", "renvoie-a", "cure", 5, 1, "Lien vers droit criminel")
    .run();
  await d
    .prepare(
      "INSERT INTO law_relations (from_law_id, to_law_id, rel_type, source, weight, in_corpus, note) VALUES (?,?,?,?,?,?,?)",
    )
    .bind("essai-ca-penal", "essai-ca-core", "renvoie-a", "cure", 5, 1, "Preuve fédérale liée")
    .run();
  await d
    .prepare(
      "INSERT INTO law_relations (from_law_id, to_law_id, rel_type, source, weight, in_corpus, note) VALUES (?,?,?,?,?,?,?)",
    )
    .bind("essai-qc-core", "hors-corpus-z", "renvoie-a", "auto", 2, 0, null)
    .run();
}

beforeAll(seedCorpus);

describe("CRIMINAL_CORPUS fermé ('0', undefined, 'true')", () => {
  for (const [label, crimVal] of [
    ['CRIMINAL_CORPUS="0"', "0"],
    ["CRIMINAL_CORPUS=undefined", undefined],
    ['CRIMINAL_CORPUS="true"', "true"],
  ] as const) {
    it(`cache ca+penal partout sous ${label} tout en servant qc+penal et ca+core`, async () => {
      const gateEnv = { FEDERAL_CORPUS: "1", PDF_CORPUS: "1", CRIMINAL_CORPUS: crimVal };
      const outils = makeRegistre(gateEnv);

      // 1) list_laws (domains=['all'], domains=['penal'], jurisdiction='ca')
      const llAll = await outils.list_laws({ domains: ["all"] } as never);
      const llAllSc = llAll.structuredContent as { count: number; laws: { id: string }[] };
      expect(llAllSc.count).toBe(3);
      expect(llAllSc.laws.map((l) => l.id).sort()).toEqual([
        "essai-ca-core",
        "essai-qc-core",
        "essai-qc-penal",
      ]);

      const llPenal = await outils.list_laws({ domains: ["penal"] } as never);
      expect(
        (llPenal.structuredContent as { laws: { id: string }[] }).laws.map((l) => l.id),
      ).toEqual(["essai-qc-penal"]);

      const caAll = await listLaws(db(), { jurisdiction: "ca" }, "fr", gateEnv);
      expect(caAll.map((l) => l.id)).toEqual(["essai-ca-core"]);

      // 2) get_article, get_articles, get_structure, get_division refusent essai-ca-penal sans fuiter son id
      const ga = await outils.get_article({ law: "essai-ca-penal", article: "1" } as never);
      expect(ga.isError).toBe(true);
      expect(ga.content[0].text).not.toContain("essai-ca-penal\n");
      expect(ga.content[0].text).toContain(
        "Lois disponibles : essai-ca-core, essai-qc-core, essai-qc-penal",
      );

      const gas = await outils.get_articles({
        law: "essai-ca-penal",
        from: "1",
        to: "2",
      } as never);
      expect(gas.isError).toBe(true);

      const gs = await outils.get_structure({ law: "essai-ca-penal" } as never);
      expect(gs.isError).toBe(true);

      const gd = await outils.get_division({ law: "essai-ca-penal", path: "fh1:1" } as never);
      expect(gd.isError).toBe(true);

      // qc+penal et ca+core restent accessibles directement
      expect(
        (await outils.get_article({ law: "essai-qc-penal", article: "1" } as never)).isError,
      ).toBeUndefined();
      expect(
        (await outils.get_article({ law: "essai-ca-core", article: "1" } as never)).isError,
      ).toBeUndefined();

      // 3) resolve_reference refuse L.R.C. (1985), ch. C-46 mais résout C-5
      const rrCrim = await outils.resolve_reference({
        citation: "L.R.C. (1985), ch. C-46, art. 1",
      } as never);
      expect(rrCrim.isError).toBe(true);
      const rrCore = await outils.resolve_reference({
        citation: "L.R.C. (1985), ch. C-5, art. 1",
      } as never);
      expect(rrCore.isError).toBeUndefined();

      // 4) related_laws masque l'arête vers essai-ca-penal et refuse essai-ca-penal
      const rlQcPenal = await outils.related_laws({ law: "essai-qc-penal" } as never);
      expect(rlQcPenal.isError).toBe(true);
      expect(rlQcPenal.content[0].text).not.toContain("essai-ca-penal");
      expect((await outils.related_laws({ law: "essai-ca-penal" } as never)).isError).toBe(true);

      // 5) list_subjects n'inclut pas essai-ca-penal dans les décomptes
      const ls = await outils.list_subjects({} as never);
      const subs = (
        ls.structuredContent as {
          subjects: { id: string; laws_count: number; divisions_count: number }[];
        }
      ).subjects;
      expect(subs.find((s) => s.id === "sujet-penal-qc")?.laws_count).toBe(1);
      expect(subs.find((s) => s.id === "sujet-criminel-ca")?.laws_count).toBe(0);

      // 6) find_relevant S1-S4 exclut essai-ca-penal même sous domains=['penal'] ou ['all']
      const frPenal = await outils.find_relevant({
        query: "poursuite penale",
        domains: ["penal"],
      } as never);
      const frPenalCands = (frPenal.structuredContent as { candidates: { law: string }[] })
        .candidates;
      expect(frPenalCands.some((c) => c.law === "essai-qc-penal")).toBe(true);
      expect(frPenalCands.some((c) => c.law === "essai-ca-penal")).toBe(false);

      const frCrim = await outils.find_relevant({
        query: "infractions criminelles",
        domains: ["all"],
      } as never);
      expect(frCrim.isError).toBe(true);

      // 7) search_text lexical exclut essai-ca-penal (dans penal, all, et targeted)
      const stExcl = await outils.search_text({
        query: "voies de fait",
        domains: ["all"],
      } as never);
      expect(stExcl.isError).toBe(true);

      const stAll = await outils.search_text({
        query: "perquisition",
        domains: ["all"],
      } as never);
      expect(
        (stAll.structuredContent as { results: { law_id: string }[] }).results
          .map((h) => h.law_id)
          .sort(),
      ).toEqual(["essai-ca-core", "essai-qc-core", "essai-qc-penal"]);

      const stTarget = await outils.search_text({
        query: "perquisition",
        law: "essai-ca-penal",
      } as never);
      expect(stTarget.isError).toBe(true);
    });
  }

  it("filtreVecteurs exclut ca+penal en recherche hybride ciblée et élargie", async () => {
    const outils = makeRegistre({
      FEDERAL_CORPUS: "1",
      PDF_CORPUS: "1",
      CRIMINAL_CORPUS: "0",
      HYBRID_SEARCH: "1",
    });

    const st = await outils.search_text({
      query: "perquisition",
      domains: ["all"],
    } as never);
    const stSc = st.structuredContent as {
      results: { law_id: string }[];
      divisions_semantiques: { law_id: string }[];
    };
    expect(stSc.results.some((r) => r.law_id === "essai-ca-penal")).toBe(false);
    expect(stSc.divisions_semantiques.some((d) => d.law_id === "essai-ca-penal")).toBe(false);
    expect(stSc.divisions_semantiques.some((d) => d.law_id === "essai-qc-penal")).toBe(true);
  });

  it("renderSite(db, env) omet ca+penal des décomptes, du tableau et des matières", async () => {
    const html = await renderSite(db(), {
      FEDERAL_CORPUS: "1",
      PDF_CORPUS: "1",
      CRIMINAL_CORPUS: "0",
    });
    expect(html).toContain('<tr data-law-id="essai-qc-core"');
    expect(html).toContain('<tr data-law-id="essai-qc-penal"');
    expect(html).toContain('<tr data-law-id="essai-ca-core"');
    expect(html).not.toContain('data-law-id="essai-ca-penal"');
    expect(html).toContain("<b>3</b>");
    expect(html).toContain("<b>3</b>");
    expect(html).toContain(
      'Droit criminel</span><span data-l="en" lang="en">Criminal Law</span> <span class="m">(0)</span>',
    );
  });
});

describe("CRIMINAL_CORPUS='1', quarantaine core et indépendance avec FEDERAL_CORPUS", () => {
  it("sert ca+penal dans domains=['penal'] et les outils directs, tout en le gardant hors de core par défaut", async () => {
    const gateEnv = {
      FEDERAL_CORPUS: "1",
      PDF_CORPUS: "1",
      CRIMINAL_CORPUS: "1",
      HYBRID_SEARCH: "1",
    };
    const outils = makeRegistre(gateEnv);

    // Par défaut (core), essai-ca-penal reste en quarantaine et ne paraît que dans other_domains
    const llDefault = await outils.list_laws({} as never);
    const llDefSc = llDefault.structuredContent as {
      laws: { id: string }[];
      other_domains: { domain: string; laws_count: number }[];
    };
    expect(llDefSc.laws.map((l) => l.id).sort()).toEqual(["essai-ca-core", "essai-qc-core"]);
    expect(llDefSc.other_domains).toEqual([{ domain: "penal", laws_count: 2 }]);

    const stDefault = await outils.search_text({ query: "perquisition" } as never);
    const stDefSc = stDefault.structuredContent as {
      results: { law_id: string }[];
      other_domains: { domain: string; lexical_hits: number }[];
    };
    expect(stDefSc.results.map((r) => r.law_id).sort()).toEqual(["essai-ca-core", "essai-qc-core"]);
    expect(stDefSc.other_domains).toEqual([{ domain: "penal", lexical_hits: 2 }]);

    // Avec domains=['penal'], essai-ca-penal est servi
    const llPenal = await outils.list_laws({ domains: ["penal"] } as never);
    expect(
      (llPenal.structuredContent as { laws: { id: string }[] }).laws.map((l) => l.id).sort(),
    ).toEqual(["essai-ca-penal", "essai-qc-penal"]);

    const ga = await outils.get_article({ law: "essai-ca-penal", article: "2" } as never);
    expect(ga.isError).toBeUndefined();
    expect((ga.structuredContent as { text: string }).text).toContain("Voies de fait armées");

    const rr = await outils.resolve_reference({
      citation: "L.R.C. (1985), ch. C-46, art. 2",
    } as never);
    expect(rr.isError).toBeUndefined();

    const rl = await outils.related_laws({ law: "essai-qc-penal" } as never);
    expect(
      (rl.structuredContent as { relations: { other_id: string }[] }).relations.map(
        (r) => r.other_id,
      ),
    ).toEqual(["essai-ca-penal"]);

    const fr = await outils.find_relevant({
      query: "infractions criminelles",
      domains: ["penal"],
    } as never);
    expect(
      (fr.structuredContent as { candidates: { law: string }[] }).candidates.some(
        (c) => c.law === "essai-ca-penal",
      ),
    ).toBe(true);

    const st = await outils.search_text({
      query: "voies de fait",
      domains: ["penal"],
    } as never);
    expect(
      (st.structuredContent as { results: { law_id: string }[] }).results.some(
        (r) => r.law_id === "essai-ca-penal",
      ),
    ).toBe(true);

    const html = await renderSite(db(), gateEnv);
    expect(html).toContain('<tr data-law-id="essai-ca-penal"');
    expect(html).toContain("<b>4</b>");
    expect(html).toContain("<b>5</b>");
    expect(html).toContain(
      'Droit criminel</span><span data-l="en" lang="en">Criminal Law</span> <span class="m">(1)</span>',
    );
  });

  it("garde essai-ca-penal caché si FEDERAL_CORPUS='0' même si CRIMINAL_CORPUS='1'", async () => {
    const outils = makeRegistre({
      FEDERAL_CORPUS: "0",
      PDF_CORPUS: "1",
      CRIMINAL_CORPUS: "1",
    });
    const llAll = await outils.list_laws({ domains: ["all"] } as never);
    expect(
      (llAll.structuredContent as { laws: { id: string }[] }).laws.map((l) => l.id).sort(),
    ).toEqual(["essai-qc-core", "essai-qc-penal"]);
    expect(
      (await outils.get_article({ law: "essai-ca-penal", article: "1" } as never)).isError,
    ).toBe(true);
  });
});
