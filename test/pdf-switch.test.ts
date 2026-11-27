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
          id: "art-essai-pdf-2",
          score: 0.95,
          metadata: { type: "article", law: "essai-pdf", article: "2" },
        },
        {
          id: "art-essai-pdf-1",
          score: 0.91,
          metadata: { type: "article", law: "essai-pdf", article: "1" },
        },
        {
          id: "art-essai-epub-1",
          score: 0.85,
          metadata: { type: "article", law: "essai-epub", article: "1" },
        },
        {
          id: "div-essai-pdf-1",
          score: 0.92,
          metadata: {
            type: "division",
            law: "essai-pdf",
            path: "ph1:1",
            heading: "DIRECTIVE PARTICULIÈRE",
          },
        },
        {
          id: "div-essai-epub-1",
          score: 0.84,
          metadata: {
            type: "division",
            law: "essai-epub",
            path: "ga:l_i",
            heading: "PROCÉDURE",
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
  HYBRID_SEARCH?: string;
}) {
  const { AI, VECTORS } = makeVectorMocks();
  return construireOutils({
    DB: db(),
    RELAX_SEARCH: "1",
    HYBRID_SEARCH: flags.HYBRID_SEARCH ?? "0",
    FEDERAL_CORPUS: flags.FEDERAL_CORPUS,
    PDF_CORPUS: flags.PDF_CORPUS,
    AI,
    VECTORS,
  } as unknown as Parameters<typeof construireOutils>[0]);
}

async function seedCorpus(): Promise<void> {
  const d = db();
  await d
    .prepare(
      `INSERT INTO laws (id, name_fr, name_en, official_cite, consol_date_fr, consol_date_en, jurisdiction, source, fonction, name_norm)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      "essai-epub",
      "Loi d'essai EPUB",
      "Test EPUB Act",
      "RLRQ, c. E-10",
      "2026-09-01",
      "2026-09-01",
      "qc",
      "epub",
      "loi",
      "loi d essai epub",
    )
    .run();

  await d
    .prepare(
      `INSERT INTO laws (id, name_fr, name_en, official_cite, consol_date_fr, consol_date_en, jurisdiction, source, fonction, name_norm)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      "essai-ca",
      "Loi d'essai fédérale",
      "Test Federal Act",
      "L.R.C. (1985), c. C-1",
      "2026-09-02",
      "2026-09-02",
      "ca",
      "lims",
      "loi",
      "loi d essai federale",
    )
    .run();

  await d
    .prepare(
      `INSERT INTO laws (id, name_fr, name_en, official_cite, consol_date_fr, consol_date_en, jurisdiction, source, fonction, name_norm)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      "essai-pdf",
      "Directive d'essai PDF",
      "Test PDF Directive",
      "Directive P-1",
      "2026-10-01",
      "2026-10-01",
      "qc",
      "pdf",
      "regles-procedure",
      "directive d essai pdf",
    )
    .run();

  const divs: [number, string, string, string, string, string, string, string][] = [
    [1, "essai-epub", "fr", "chapitre", "I", "PROCÉDURE", "procedure", "ga:l_i"],
    [2, "essai-ca", "fr", "chapitre", "I", "COMPÉTENCE", "competence", "fh1:1"],
    [
      3,
      "essai-pdf",
      "fr",
      "chapitre",
      "I",
      "DIRECTIVE PARTICULIÈRE",
      "directive particuliere",
      "ph1:1",
    ],
    [4, "essai-epub", "en", "chapitre", "I", "PROCEDURE", "procedure", "ga:l_i"],
    [5, "essai-ca", "en", "chapitre", "I", "JURISDICTION", "jurisdiction", "fh1:1"],
    [6, "essai-pdf", "en", "chapitre", "I", "SPECIAL DIRECTIVE", "special directive", "ph1:1"],
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
      "essai-epub",
      "fr",
      "1",
      1_000_000_000_000,
      1,
      "ga:l_i",
      "Règle civile générale sur le cautionnement.",
    ],
    [
      2,
      "essai-epub",
      "fr",
      "2",
      2_000_000_000_000,
      1,
      "ga:l_i",
      "Deuxième règle civile sur la preuve.",
    ],
    [
      3,
      "essai-ca",
      "fr",
      "1",
      1_000_000_000_000,
      2,
      "fh1:1",
      "Règle fédérale générale sur le cautionnement.",
    ],
    [
      4,
      "essai-pdf",
      "fr",
      "1",
      1_000_000_000_000,
      3,
      "ph1:1",
      "Directive PDF spéciale sur le cautionnement et l'audience.",
    ],
    [
      5,
      "essai-pdf",
      "fr",
      "2",
      2_000_000_000_000,
      3,
      "ph1:1",
      "Modalité PDF exclusive pour l'inscription.",
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
      "sujet-partage",
      "Cautionnement partagé",
      "Shared suretyship",
      "specialise",
      "cautionnement",
      "suretyship",
      "cautionnement partage",
    )
    .run();
  await d
    .prepare(
      "INSERT INTO subjects (id, label_fr, label_en, kind, description_fr, description_en, label_norm) VALUES (?,?,?,?,?,?,?)",
    )
    .bind(
      "sujet-pdf",
      "Pratique PDF",
      "PDF Practice",
      "specialise",
      "audience directive",
      "directive hearing",
      "pratique pdf",
    )
    .run();

  await d
    .prepare("INSERT INTO subject_map (subject_id, law_id, division_path) VALUES (?,?,?)")
    .bind("sujet-partage", "essai-epub", "ga:l_i")
    .run();
  await d
    .prepare("INSERT INTO subject_map (subject_id, law_id, division_path) VALUES (?,?,?)")
    .bind("sujet-partage", "essai-pdf", "ph1:1")
    .run();
  await d
    .prepare("INSERT INTO subject_map (subject_id, law_id, division_path) VALUES (?,?,?)")
    .bind("sujet-pdf", "essai-pdf", "ph1:1")
    .run();

  await d
    .prepare(
      "INSERT INTO law_relations (from_law_id, to_law_id, rel_type, source, weight, in_corpus, note) VALUES (?,?,?,?,?,?,?)",
    )
    .bind("essai-epub", "essai-pdf", "renvoie-a", "cure", 5, 1, "Directive PDF liée")
    .run();
  await d
    .prepare(
      "INSERT INTO law_relations (from_law_id, to_law_id, rel_type, source, weight, in_corpus, note) VALUES (?,?,?,?,?,?,?)",
    )
    .bind("essai-pdf", "essai-epub", "renvoie-a", "cure", 5, 1, "Loi EPUB liée")
    .run();
  await d
    .prepare(
      "INSERT INTO law_relations (from_law_id, to_law_id, rel_type, source, weight, in_corpus, note) VALUES (?,?,?,?,?,?,?)",
    )
    .bind("essai-epub", "hors-corpus-z", "renvoie-a", "auto", 2, 0, null)
    .run();
}

beforeAll(seedCorpus);

describe("PDF_CORPUS fermé ('0', undefined, 'true')", () => {
  for (const [label, pdfVal] of [
    ['PDF_CORPUS="0"', "0"],
    ["PDF_CORPUS=undefined", undefined],
    ['PDF_CORPUS="true"', "true"],
  ] as const) {
    it(`cache source='pdf' dans tous les outils MCP et listLaws sous ${label}`, async () => {
      const gateEnv = { FEDERAL_CORPUS: "1", PDF_CORPUS: pdfVal };
      const outils = makeRegistre(gateEnv);

      const ll = await outils.list_laws({} as never);
      const llSc = ll.structuredContent as { count: number; laws: { id: string }[] };
      expect(llSc.count).toBe(2);
      expect(llSc.laws.map((l) => l.id).sort()).toEqual(["essai-ca", "essai-epub"]);

      const qcOnly = await listLaws(db(), { jurisdiction: "qc" }, "fr", gateEnv);
      expect(qcOnly.map((l) => l.id)).toEqual(["essai-epub"]);

      const ga = await outils.get_article({ law: "essai-pdf", article: "1" } as never);
      expect(ga.isError).toBe(true);
      expect(ga.content[0].text).not.toContain("essai-pdf\n");
      expect(ga.content[0].text).not.toContain(
        "Lois disponibles : essai-ca, essai-epub, essai-pdf",
      );

      const gas = await outils.get_articles({ law: "essai-pdf", from: "1", to: "2" } as never);
      expect(gas.isError).toBe(true);

      const gs = await outils.get_structure({ law: "essai-pdf" } as never);
      expect(gs.isError).toBe(true);

      const gd = await outils.get_division({ law: "essai-pdf", path: "ph1:1" } as never);
      expect(gd.isError).toBe(true);

      const rr = await outils.resolve_reference({ citation: "Directive P-1, art. 1" } as never);
      expect(rr.isError).toBe(true);

      const rlEpub = await outils.related_laws({ law: "essai-epub" } as never);
      expect(rlEpub.isError).toBeUndefined();
      const rlSc = rlEpub.structuredContent as {
        relations: { other_id: string; in_corpus: boolean }[];
      };
      expect(rlSc.relations.map((r) => r.other_id)).toEqual(["hors-corpus-z"]);
      expect(rlSc.relations[0].in_corpus).toBe(false);

      const rlPdf = await outils.related_laws({ law: "essai-pdf" } as never);
      expect(rlPdf.isError).toBe(true);

      const ls = await outils.list_subjects({} as never);
      const subs = (
        ls.structuredContent as {
          subjects: { id: string; laws_count: number; divisions_count: number }[];
        }
      ).subjects;
      const partage = subs.find((s) => s.id === "sujet-partage");
      const pdfSub = subs.find((s) => s.id === "sujet-pdf");
      expect(partage?.laws_count).toBe(1);
      expect(partage?.divisions_count).toBe(1);
      expect(pdfSub?.laws_count).toBe(0);
      expect(pdfSub?.divisions_count).toBe(0);

      const fr1 = await outils.find_relevant({ query: "cautionnement" } as never);
      const fr1Cands = (fr1.structuredContent as { candidates: { law: string }[] }).candidates;
      expect(fr1Cands.some((c) => c.law === "essai-epub")).toBe(true);
      expect(fr1Cands.some((c) => c.law === "essai-pdf")).toBe(false);

      const fr2 = await outils.find_relevant({ query: "directive particuliere" } as never);
      expect(fr2.isError).toBe(true);

      const stExcl = await outils.search_text({ query: "inscription" } as never);
      expect(stExcl.isError).toBe(true);
      const stShared = await outils.search_text({ query: "cautionnement" } as never);
      const stSharedHits = (stShared.structuredContent as { results: { law_id: string }[] })
        .results;
      expect(stSharedHits.map((h) => h.law_id).sort()).toEqual(["essai-ca", "essai-epub"]);

      const stPdfTarget = await outils.search_text({
        query: "inscription",
        law: "essai-pdf",
      } as never);
      expect(stPdfTarget.isError).toBe(true);
    });
  }

  it("filtreVecteurs exclut les articles et divisions PDF en recherche hybride ciblée et élargie", async () => {
    const outils = makeRegistre({ FEDERAL_CORPUS: "1", PDF_CORPUS: "0", HYBRID_SEARCH: "1" });

    const wide = await outils.search_text({ query: "cautionnement" } as never);
    const wideSc = wide.structuredContent as {
      results: { law_id: string }[];
      divisions_semantiques: { law_id: string }[];
    };
    expect(wideSc.results.some((r) => r.law_id === "essai-pdf")).toBe(false);
    expect(wideSc.divisions_semantiques.some((d) => d.law_id === "essai-pdf")).toBe(false);
    expect(wideSc.divisions_semantiques.some((d) => d.law_id === "essai-epub")).toBe(true);

    const widened = await outils.search_text({ query: "inscription", law: "essai-epub" } as never);
    const widenedSc = widened.structuredContent as {
      results: { law_id: string }[];
      divisions_semantiques: { law_id: string }[];
    };
    expect(widenedSc.results.some((r) => r.law_id === "essai-pdf")).toBe(false);
    expect(widenedSc.divisions_semantiques.some((d) => d.law_id === "essai-pdf")).toBe(false);
  });

  it("renderSite(db, env) omet essai-pdf des décomptes, du tableau et des matières", async () => {
    const html = await renderSite(db(), { FEDERAL_CORPUS: "1", PDF_CORPUS: "0" });
    expect(html).toContain('<tr data-law-id="essai-epub"');
    expect(html).toContain('<tr data-law-id="essai-ca"');
    expect(html).not.toContain('data-law-id="essai-pdf"');
    expect(html).toContain("<b>2</b>");
    expect(html).toContain("<b>3</b>");
    expect(html).toContain(
      'Pratique PDF</span><span data-l="en" lang="en">PDF Practice</span> <span class="m">(0)</span>',
    );
    expect(html).toContain(
      'Cautionnement partagé</span><span data-l="en" lang="en">Shared suretyship</span> <span class="m">(1)</span>',
    );
  });
});

describe("PDF_CORPUS='1' et indépendance avec FEDERAL_CORPUS", () => {
  it("sert essai-pdf partout lorsque PDF_CORPUS='1' et FEDERAL_CORPUS='1'", async () => {
    const gateEnv = { FEDERAL_CORPUS: "1", PDF_CORPUS: "1", HYBRID_SEARCH: "1" };
    const outils = makeRegistre(gateEnv);

    const ll = await outils.list_laws({} as never);
    const llSc = ll.structuredContent as { count: number; laws: { id: string }[] };
    expect(llSc.count).toBe(3);
    expect(llSc.laws.map((l) => l.id).sort()).toEqual(["essai-ca", "essai-epub", "essai-pdf"]);

    const ga = await outils.get_article({ law: "essai-pdf", article: "1" } as never);
    expect(ga.isError).toBeUndefined();
    expect((ga.structuredContent as { text: string }).text).toContain("Directive PDF spéciale");

    const gas = await outils.get_articles({ law: "essai-pdf", from: "1", to: "2" } as never);
    expect(gas.isError).toBeUndefined();

    const gs = await outils.get_structure({ law: "essai-pdf" } as never);
    expect(gs.isError).toBeUndefined();

    const gd = await outils.get_division({ law: "essai-pdf", path: "ph1:1" } as never);
    expect(gd.isError).toBeUndefined();

    const rr = await outils.resolve_reference({ citation: "Directive P-1, art. 1" } as never);
    expect(rr.isError).toBeUndefined();

    const rl = await outils.related_laws({ law: "essai-epub" } as never);
    const rlIds = (rl.structuredContent as { relations: { other_id: string }[] }).relations.map(
      (r) => r.other_id,
    );
    expect(rlIds.sort()).toEqual(["essai-pdf", "essai-pdf", "hors-corpus-z"]);

    const ls = await outils.list_subjects({} as never);
    const subs = (ls.structuredContent as { subjects: { id: string; laws_count: number }[] })
      .subjects;
    expect(subs.find((s) => s.id === "sujet-partage")?.laws_count).toBe(2);
    expect(subs.find((s) => s.id === "sujet-pdf")?.laws_count).toBe(1);

    const fr = await outils.find_relevant({ query: "directive particuliere" } as never);
    expect(fr.isError).toBeUndefined();
    expect(
      (fr.structuredContent as { candidates: { law: string }[] }).candidates.some(
        (c) => c.law === "essai-pdf",
      ),
    ).toBe(true);

    const st = await outils.search_text({ query: "inscription" } as never);
    const stSc = st.structuredContent as {
      results: { law_id: string }[];
      divisions_semantiques: { law_id: string }[];
    };
    expect(stSc.results.some((r) => r.law_id === "essai-pdf")).toBe(true);
    expect(stSc.divisions_semantiques.some((d) => d.law_id === "essai-pdf")).toBe(true);

    const html = await renderSite(db(), gateEnv);
    expect(html).toContain('<tr data-law-id="essai-pdf"');
    expect(html).toContain("<b>5</b>");
    expect(html).toContain(
      'Pratique PDF</span><span data-l="en" lang="en">PDF Practice</span> <span class="m">(1)</span>',
    );
    expect(html).toContain(
      'Cautionnement partagé</span><span data-l="en" lang="en">Shared suretyship</span> <span class="m">(2)</span>',
    );
  });

  it("garde FEDERAL_CORPUS='0' isolé quand PDF_CORPUS='1'", async () => {
    const gateEnv = { FEDERAL_CORPUS: "0", PDF_CORPUS: "1", HYBRID_SEARCH: "1" };
    const outils = makeRegistre(gateEnv);

    const ll = await outils.list_laws({} as never);
    const llIds = (ll.structuredContent as { laws: { id: string }[] }).laws.map((l) => l.id);
    expect(llIds.sort()).toEqual(["essai-epub", "essai-pdf"]);
    expect(llIds).not.toContain("essai-ca");

    const gaCa = await outils.get_article({ law: "essai-ca", article: "1" } as never);
    expect(gaCa.isError).toBe(true);

    const st = await outils.search_text({ query: "cautionnement" } as never);
    const stIds = (st.structuredContent as { results: { law_id: string }[] }).results.map(
      (r) => r.law_id,
    );
    expect(stIds).toContain("essai-epub");
    expect(stIds).toContain("essai-pdf");
    expect(stIds).not.toContain("essai-ca");

    const html = await renderSite(db(), gateEnv);
    expect(html).toContain('<tr data-law-id="essai-pdf"');
    expect(html).not.toContain('data-law-id="essai-ca"');
    expect(html).toContain("<b>2</b>");
    expect(html).toContain("<b>4</b>");
  });

  it("cache essai-ca et essai-pdf quand FEDERAL_CORPUS='0' et PDF_CORPUS='0'", async () => {
    const gateEnv = { FEDERAL_CORPUS: "0", PDF_CORPUS: "0", HYBRID_SEARCH: "1" };
    const outils = makeRegistre(gateEnv);

    const ll = await outils.list_laws({} as never);
    const llSc = ll.structuredContent as { count: number; laws: { id: string }[] };
    expect(llSc.count).toBe(1);
    expect(llSc.laws.map((l) => l.id)).toEqual(["essai-epub"]);

    const gaCa = await outils.get_article({ law: "essai-ca", article: "1" } as never);
    expect(gaCa.isError).toBe(true);
    const gaPdf = await outils.get_article({ law: "essai-pdf", article: "1" } as never);
    expect(gaPdf.isError).toBe(true);

    const rl = await outils.related_laws({ law: "essai-epub" } as never);
    expect(rl.isError).toBeUndefined();
    const rlSc = rl.structuredContent as {
      relations: { other_id: string; in_corpus: boolean }[];
    };
    expect(rlSc.relations.map((r) => r.other_id)).toEqual(["hors-corpus-z"]);
    expect(rlSc.relations[0].in_corpus).toBe(false);

    const st = await outils.search_text({ query: "cautionnement" } as never);
    const stSc = st.structuredContent as {
      results: { law_id: string }[];
      divisions_semantiques: { law_id: string }[];
    };
    expect(stSc.results.map((r) => r.law_id)).toEqual(["essai-epub"]);
    expect(stSc.divisions_semantiques.some((d) => d.law_id === "essai-pdf")).toBe(false);
    expect(stSc.divisions_semantiques.some((d) => d.law_id === "essai-epub")).toBe(true);

    const html = await renderSite(db(), gateEnv);
    expect(html).toContain('<tr data-law-id="essai-epub"');
    expect(html).not.toContain('data-law-id="essai-ca"');
    expect(html).not.toContain('data-law-id="essai-pdf"');
    expect(html).toContain("<b>1</b>");
    expect(html).toContain("<b>2</b>");
    expect(html).toContain(
      'Pratique PDF</span><span data-l="en" lang="en">PDF Practice</span> <span class="m">(0)</span>',
    );
    expect(html).toContain(
      'Cautionnement partagé</span><span data-l="en" lang="en">Shared suretyship</span> <span class="m">(1)</span>',
    );
  });
});
