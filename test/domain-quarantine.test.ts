import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { normalize } from "../src/relevance";
import { construireOutils, type Registre } from "../src/tools";

function db(): D1Database {
  return env.DB as unknown as D1Database;
}

function callTool(outils: Registre, name: keyof Registre, args: Record<string, unknown>) {
  return (outils[name] as (a: unknown) => ReturnType<Registre[string]>)(args);
}

function makeVectorMocks(
  hits: Array<{ id: string; score: number; metadata?: Record<string, unknown> }>,
) {
  const queries: Array<{ vector: number[]; opts: Record<string, unknown> | undefined }> = [];
  return {
    queries,
    AI: {
      async run() {
        return { data: [[0.1, 0.2, 0.3]] };
      },
    } as unknown as Ai,
    VECTORS: {
      async query(vector: number[], opts?: Record<string, unknown>) {
        queries.push({ vector, opts });
        return { matches: hits, count: hits.length };
      },
    } as unknown as VectorizeIndex,
  };
}

async function seedCorpus() {
  const d = db();
  await d.prepare("DELETE FROM subject_map").run();
  await d.prepare("DELETE FROM subjects").run();
  await d.prepare("DELETE FROM law_relations").run();
  await d.prepare("DELETE FROM vector_state").run();
  await d.prepare("DELETE FROM article_numbers").run();
  await d.prepare("DELETE FROM articles").run();
  await d.prepare("DELETE FROM divisions").run();
  await d.prepare("DELETE FROM laws").run();

  const laws = [
    [
      "ccq",
      "Code civil du Québec",
      "Civil Code of Québec",
      "RLRQ, c. CCQ-1991",
      "qc",
      "code",
      null,
      "core",
    ],
    [
      "cpc",
      "Code de procédure civile",
      "Code of Civil Procedure",
      "RLRQ, c. C-25.01",
      "qc",
      "code",
      null,
      "core",
    ],
    [
      "c-25.01-r.2",
      "Règlement de la Cour supérieure du Québec en matière civile",
      "Regulation of the Superior Court of Québec in civil matters",
      "RLRQ, c. C-25.01, r. 2",
      "qc",
      "reglement",
      "Cour supérieure",
      "core",
    ],
    [
      "c-25.01-r.0.2.01",
      "Règlement de la Cour du Québec",
      "Regulation of the Court of Québec",
      "RLRQ, c. C-25.01, r. 0.2.01",
      "qc",
      "reglement",
      "Cour du Québec",
      "core",
    ],
    [
      "ca-f-7",
      "Loi sur les Cours fédérales",
      "Federal Courts Act",
      "L.R.C. (1985), c. F-7",
      "ca",
      "loi",
      "Cour fédérale",
      "cours-federales",
    ],
    [
      "n-1.1",
      "Loi sur les normes du travail",
      "Act respecting labour standards",
      "RLRQ, c. N-1.1",
      "qc",
      "loi",
      null,
      "travail",
    ],
    [
      "c-25.1",
      "Code de procédure pénale",
      "Code of Penal Procedure",
      "RLRQ, c. C-25.1",
      "qc",
      "code",
      null,
      "penal",
    ],
    [
      "d-9.2",
      "Loi sur la distribution de produits et services financiers",
      "Act respecting the distribution of financial products and services",
      "RLRQ, c. D-9.2",
      "qc",
      "loi",
      null,
      "financier",
    ],
  ] as const;

  for (const l of laws) {
    await d
      .prepare(
        "INSERT INTO laws (id, name_fr, name_en, official_cite, jurisdiction, fonction, forum, domain, name_norm) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(...l, normalize(l[1]))
      .run();
  }

  await d
    .prepare(
      "INSERT INTO subjects (id, kind, label_fr, label_en, description_fr, description_en, label_norm) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      "travail",
      "specialise",
      "Droit du travail",
      "Labour law",
      "congédiement emploi salaire normes",
      "dismissal employment wages",
      "droit du travail",
    )
    .run();
  await d
    .prepare(
      "INSERT INTO subjects (id, kind, label_fr, label_en, description_fr, description_en, label_norm) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      "procedure-civile",
      "specialise",
      "Procédure civile",
      "Civil procedure",
      "requête audience jugement appel",
      "motion hearing judgment appeal",
      "procedure civile",
    )
    .run();

  const divs = [
    [
      1,
      "ccq",
      "fr",
      "chapitre",
      "VII",
      "DU CONTRAT DE TRAVAIL",
      "ga:l_cinquieme-gb:l_deuxieme-gc:l_septieme",
      1,
    ],
    [
      2,
      "n-1.1",
      "fr",
      "section",
      "III",
      "RECOURS À L'ENCONTRE D'UN CONGÉDIEMENT",
      "ga:l_v-gb:l_iii",
      1,
    ],
    [3, "cpc", "fr", "titre", "I", "DISPOSITIONS GÉNÉRALES", "ga:l_i", 1],
    [4, "c-25.01-r.2", "fr", "chapitre", "I", "MISE AU RÔLE COUR SUPÉRIEURE", "ga:l_i", 1],
    [5, "c-25.01-r.0.2.01", "fr", "chapitre", "I", "AUDIENCE COUR DU QUÉBEC", "ga:l_i", 1],
    [6, "ca-f-7", "fr", "partie", "I", "COMPÉTENCE EN CONTRÔLE JUDICIAIRE", "ga:p_i", 1],
    [7, "c-25.1", "fr", "chapitre", "I", "POURSUITE PÉNALE", "ga:l_i", 1],
    [8, "d-9.2", "fr", "chapitre", "I", "CABINETS FINANCIERS", "ga:l_i", 1],
  ] as const;

  for (const dv of divs) {
    await d
      .prepare(
        "INSERT INTO divisions (id, law_id, lang, kind, number, heading, path, repealed, parent_id, sort_order, heading_norm) VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)",
      )
      .bind(...dv, normalize(dv[5]))
      .run();
  }

  await d
    .prepare("INSERT INTO subject_map (subject_id, law_id, division_path) VALUES (?, ?, ?)")
    .bind("travail", "ccq", "ga:l_cinquieme-gb:l_deuxieme-gc:l_septieme")
    .run();
  await d
    .prepare("INSERT INTO subject_map (subject_id, law_id, division_path) VALUES (?, ?, ?)")
    .bind("travail", "n-1.1", "ga:l_v-gb:l_iii")
    .run();
  await d
    .prepare("INSERT INTO subject_map (subject_id, law_id, division_path) VALUES (?, ?, ?)")
    .bind("procedure-civile", "c-25.01-r.2", "ga:l_i")
    .run();

  const arts = [
    [
      101,
      "ccq",
      "fr",
      "2091",
      2091_000_000_000,
      1,
      "ga:l_cinquieme-gb:l_deuxieme-gc:l_septieme",
      null,
      "Chacune des parties à un contrat à durée indéterminée peut y mettre fin en donnant à l'autre un délai de congé raisonnable lors d'un congédiement.",
    ],
    [
      102,
      "n-1.1",
      "fr",
      "124",
      124_000_000_000,
      2,
      "ga:l_v-gb:l_iii",
      null,
      "Le salarié qui justifie de deux ans de service continu et qui croit avoir été victime d'un congédiement sans cause juste et suffisante peut soumettre une plainte.",
    ],
    [
      103,
      "n-1.1",
      "fr",
      "125",
      125_000_000_000,
      2,
      "ga:l_v-gb:l_iii",
      null,
      "La Commission tente d'amener les parties à régler la plainte par médiation.",
    ],
    [
      104,
      "c-25.01-r.2",
      "fr",
      "15",
      15_000_000_000,
      4,
      "ga:l_i",
      null,
      "La demande d'audience est déposée au greffe de la Cour supérieure avec l'attestation requise.",
    ],
    [
      105,
      "c-25.01-r.0.2.01",
      "fr",
      "22",
      22_000_000_000,
      5,
      "ga:l_i",
      null,
      "La demande d'audience est présentée devant un juge de la Cour du Québec.",
    ],
    [
      106,
      "ca-f-7",
      "fr",
      "18",
      18_000_000_000,
      6,
      "ga:p_i",
      "Recours extraordinaires exclusifs contre un office fédéral",
      "La Cour fédérale a compétence exclusive en première instance pour décerner une injonction ou un bref de mandamus.",
    ],
    [
      107,
      "ca-f-7",
      "fr",
      "18.1",
      18_001_000_000,
      6,
      "ga:p_i",
      "Demande de contrôle judiciaire",
      "Une demande de contrôle judiciaire peut être présentée par le procureur général du Canada.",
    ],
    [
      108,
      "c-25.1",
      "fr",
      "144",
      144_000_000_000,
      7,
      "ga:l_i",
      null,
      "Le constat d'infraction pénale doit indiquer l'amende minimale et le délai de comparution.",
    ],
    [
      109,
      "d-9.2",
      "fr",
      "70",
      70_000_000_000,
      8,
      "ga:l_i",
      null,
      "Un cabinet doit s'inscrire auprès de l'Autorité des marchés financiers pour offrir des produits financiers.",
    ],
  ] as const;

  for (const a of arts) {
    await d
      .prepare(
        "INSERT INTO articles (id, law_id, lang, number, sort_key, division_id, division_path, marginal_note, text, repealed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
      )
      .bind(...a)
      .run();
    await d
      .prepare(
        "INSERT INTO article_numbers (law_id, lang, number, article_id) VALUES (?, 'fr', ?, ?)",
      )
      .bind(a[1], a[3], a[0])
      .run();
  }

  await d
    .prepare(
      "INSERT INTO law_relations (from_law_id, to_law_id, rel_type, source, note) VALUES (?, ?, ?, 'auto', ?)",
    )
    .bind("c-25.01-r.2", "cpc", "reglement-de", "Règlement pris sous le C.p.c.")
    .run();

  await d.prepare("INSERT INTO articles_fts(articles_fts) VALUES('rebuild')").run();
}

function testEnv(overrides: Record<string, unknown> = {}): Env {
  return {
    ...env,
    DOMAIN_QUARANTINE: "1",
    VECTOR_DOMAIN_FILTER: "0",
    HYBRID_SEARCH: "0",
    RELAX_SEARCH: "1",
    FEDERAL_CORPUS: "1",
    PDF_CORPUS: "1",
    ...overrides,
  } as unknown as Env;
}

describe("Quarantaine par domaine (Phase 0)", () => {
  beforeEach(async () => {
    await seedCorpus();
  });

  it("list_laws isole core par défaut, expose other_domains, et supporte domains/jurisdiction/forum", async () => {
    const outils = construireOutils(testEnv());

    const defaut = await callTool(outils, "list_laws", {});
    const scDefaut = defaut.structuredContent as {
      count: number;
      laws: Array<{ id: string; domain: string }>;
      domains_active: string[];
      domains_excluded: string[];
      other_domains: Array<{ domain: string; laws_count: number }>;
    };
    expect(scDefaut.domains_active).toEqual(["core"]);
    expect(scDefaut.laws.map((l) => l.id).sort()).toEqual([
      "c-25.01-r.0.2.01",
      "c-25.01-r.2",
      "ccq",
      "cpc",
    ]);
    expect(scDefaut.domains_excluded).toContain("travail");
    expect(scDefaut.other_domains).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ domain: "travail", laws_count: 1 }),
        expect.objectContaining({ domain: "penal", laws_count: 1 }),
        expect.objectContaining({ domain: "financier", laws_count: 1 }),
        expect.objectContaining({ domain: "cours-federales", laws_count: 1 }),
      ]),
    );

    const all = await callTool(outils, "list_laws", { domains: ["all"] });
    expect((all.structuredContent as { count: number }).count).toBe(8);

    const plusTravail = await callTool(outils, "list_laws", { domains: ["core", "travail"] });
    expect(
      (plusTravail.structuredContent as { laws: Array<{ id: string }> }).laws.map((l) => l.id),
    ).toContain("n-1.1");

    const penalOnly = await callTool(outils, "list_laws", { domains: ["penal"] });
    expect(
      (penalOnly.structuredContent as { laws: Array<{ id: string }> }).laws.map((l) => l.id),
    ).toEqual(["c-25.1"]);

    const caOnly = await callTool(outils, "list_laws", { domains: ["all"], jurisdiction: "ca" });
    expect(
      (caOnly.structuredContent as { laws: Array<{ id: string }> }).laws.map((l) => l.id),
    ).toEqual(["ca-f-7"]);

    const csOnly = await callTool(outils, "list_laws", { forum: "Cour supérieure" });
    expect(
      (csOnly.structuredContent as { laws: Array<{ id: string }> }).laws.map((l) => l.id),
    ).toEqual(["c-25.01-r.2"]);
  });

  it("find_relevant isole core par défaut avec radar other_domains, puis ouvre travail et filtre par forum/jurisdiction", async () => {
    const outils = construireOutils(testEnv());

    const rCore = await callTool(outils, "find_relevant", { query: "congédiement" });
    const scCore = rCore.structuredContent as {
      candidates: Array<{ law: string }>;
      domains_active: string[];
      other_domains: Array<{ domain: string }>;
    };
    expect(scCore.domains_active).toEqual(["core"]);
    expect(scCore.candidates.some((c) => c.law === "ccq")).toBe(true);
    expect(scCore.candidates.some((c) => c.law === "n-1.1")).toBe(false);
    expect(scCore.other_domains).toEqual(
      expect.arrayContaining([expect.objectContaining({ domain: "travail" })]),
    );

    const rTravail = await callTool(outils, "find_relevant", {
      query: "congédiement",
      domains: ["core", "travail"],
    });
    expect(
      (rTravail.structuredContent as { candidates: Array<{ law: string }> }).candidates.some(
        (c) => c.law === "n-1.1",
      ),
    ).toBe(true);

    const rForum = await callTool(outils, "find_relevant", {
      query: "audience requête",
      forum: "Cour supérieure",
    });
    const candsForum = (rForum.structuredContent as { candidates: Array<{ law: string }> })
      .candidates;
    expect(candsForum.some((c) => c.law === "c-25.01-r.2")).toBe(true);
    expect(candsForum.some((c) => c.law === "c-25.01-r.0.2.01")).toBe(false);

    const rCa = await callTool(outils, "find_relevant", {
      query: "contrôle judiciaire",
      domains: ["all"],
      jurisdiction: "ca",
    });
    const candsCa = (rCa.structuredContent as { candidates: Array<{ law: string }> }).candidates;
    expect(candsCa.map((c) => c.law)).toEqual(["ca-f-7"]);
  });

  it("search_text isole core, émet le radar sur 0 ou >0 résultats, et préserve law= + élargissement borné", async () => {
    const outils = construireOutils(testEnv());

    const rZeroCore = await callTool(outils, "search_text", { query: "constat infraction pénale" });
    expect(rZeroCore.isError).toBe(true);
    expect(rZeroCore.content[0].text).toContain("penal");

    const rBoth = await callTool(outils, "search_text", { query: "congédiement" });
    const scBoth = rBoth.structuredContent as {
      results: Array<{ law_id: string }>;
      other_domains: Array<{ domain: string; lexical_hits: number }>;
    };
    expect(scBoth.results.map((r) => r.law_id)).toEqual(["ccq"]);
    expect(scBoth.other_domains).toEqual(
      expect.arrayContaining([expect.objectContaining({ domain: "travail", lexical_hits: 1 })]),
    );

    const rPenal = await callTool(outils, "search_text", {
      query: "constat infraction pénale",
      domains: ["penal"],
    });
    expect(
      (rPenal.structuredContent as { results: Array<{ law_id: string }> }).results.map(
        (r) => r.law_id,
      ),
    ).toEqual(["c-25.1"]);

    const rLawOpen = await callTool(outils, "search_text", {
      law: "n-1.1",
      query: "congédiement introuvable_xyz",
    });
    const scOpen = rLawOpen.structuredContent as {
      results: Array<{ law_id: string }>;
    };
    expect(scOpen.results.length).toBeGreaterThan(0);
    expect(scOpen.results.every((r) => r.law_id === "n-1.1")).toBe(true);

    const rForum = await callTool(outils, "search_text", {
      query: "demande audience",
      forum: "Cour supérieure",
    });
    const lawsForum = (
      rForum.structuredContent as { results: Array<{ law_id: string }> }
    ).results.map((r) => r.law_id);
    expect(lawsForum).toContain("c-25.01-r.2");
    expect(lawsForum).not.toContain("c-25.01-r.0.2.01");

    const rCa = await callTool(outils, "search_text", {
      query: "contrôle judiciaire",
      domains: ["all"],
      jurisdiction: "ca",
    });
    expect(
      (rCa.structuredContent as { results: Array<{ law_id: string }> }).results.map(
        (r) => r.law_id,
      ),
    ).toEqual(["ca-f-7"]);
  });

  it("search_text pondère marginal_note dans articles_fts et garde snippet sur la colonne texte", async () => {
    const outils = construireOutils(testEnv());

    const rNote = await callTool(outils, "search_text", {
      query: "extraordinaires exclusifs",
      domains: ["cours-federales"],
    });
    const scNote = rNote.structuredContent as {
      results: Array<{ law_id: string; number: string; snippet: string }>;
    };
    expect(scNote.results).toHaveLength(1);
    expect(scNote.results[0]).toMatchObject({ law_id: "ca-f-7", number: "18" });
    expect(scNote.results[0].snippet).toContain("Cour fédérale");
    expect(scNote.results[0].snippet).not.toContain("extraordinaires exclusifs");
  });

  it("search_text hybride/sémantique filtre Vectorize côté worker puis via métadonnées quand VECTOR_DOMAIN_FILTER='1'", async () => {
    const mocks = makeVectorMocks([
      {
        id: "art:n-1.1:124",
        score: 0.91,
        metadata: {
          type: "article",
          law: "n-1.1",
          article: "124",
          domain: "travail",
          jurisdiction: "qc",
        },
      },
      {
        id: "art:ccq:2091",
        score: 0.72,
        metadata: {
          type: "article",
          law: "ccq",
          article: "2091",
          domain: "core",
          jurisdiction: "qc",
        },
      },
    ]);

    const outilsOff = construireOutils(
      testEnv({
        HYBRID_SEARCH: "1",
        VECTOR_DOMAIN_FILTER: "0",
        AI: mocks.AI,
        VECTORS: mocks.VECTORS,
      }),
    );
    const rOff = await callTool(outilsOff, "search_text", { query: "rupture emploi sans motif" });
    const scOff = rOff.structuredContent as { results: Array<{ law_id: string }> };
    expect(scOff.results.map((r) => r.law_id)).toEqual(["ccq"]);
    expect(mocks.queries[0].opts?.filter).toBeUndefined();

    const outilsOn = construireOutils(
      testEnv({
        HYBRID_SEARCH: "1",
        VECTOR_DOMAIN_FILTER: "1",
        AI: mocks.AI,
        VECTORS: mocks.VECTORS,
      }),
    );
    await callTool(outilsOn, "search_text", {
      query: "rupture emploi sans motif",
      jurisdiction: "qc",
    });
    expect(mocks.queries[1].opts?.filter).toEqual({
      domain: "core",
      jurisdiction: "qc",
    });
  });

  it("laisse ouverts les outils d'extraction directe et supporte le rollback DOMAIN_QUARANTINE='0'", async () => {
    const outilsQuarantined = construireOutils(testEnv());
    const art = await callTool(outilsQuarantined, "get_article", { law: "n-1.1", article: "124" });
    expect(art.isError).not.toBe(true);
    expect(art.structuredContent).toMatchObject({ citation: expect.stringContaining("124") });

    const outilsRollback = construireOutils(testEnv({ DOMAIN_QUARANTINE: "0" }));
    const allLaws = await callTool(outilsRollback, "list_laws", {});
    expect((allLaws.structuredContent as { count: number }).count).toBe(8);
  });
});
