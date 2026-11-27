import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { empreinte, frapperJeton, queueJeton } from "@poirierlavoie/mcp-socle";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleBackfill } from "../src/backfill";
import worker, { reinitialiserQuarantaineIpPourTests } from "../src/index";
import { DISPOSITION_SORT_BASE, sortKeyOf } from "../src/lib";
import { depthOf, segmentsOf, truncatePath } from "../src/paths";

const CACHE_KEY = "https://legislation.poirierlavoie.ca/__page";
const MCP_TOKEN = "e2e-pdf-token";
const BACKFILL_TOKEN = "e2e-pdf-backfill-token";
const DEEP_PATH = "ph1:1-ph2:1-ph3:1-ph4:1-ph5:1-ph6:1-ph7:1-ph8:1-ph9:1";

const db = () => (env as unknown as { DB: D1Database }).DB;
const dbIdentite = () => (env as unknown as { DB_IDENTITE: D1Database }).DB_IDENTITE;

let hasSourceCol = false;
let hasLinksCol = false;
let articleFtsColumns: Array<{ cid: number; name: string }> = [];

interface VectorMatchMock {
  id: string;
  score: number;
  metadata: Record<string, string>;
}

interface McpToolResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
}

function makeTestEnv(opts?: {
  pdfCorpus?: string;
  federalCorpus?: string;
  hybridSearch?: string;
  relaxSearch?: string;
  vectorMatches?: VectorMatchMock[];
  onAiRun?: (texts: string[]) => void;
  onVectorQuery?: () => void;
  upserted?: Array<{ id: string; values: number[]; metadata?: Record<string, unknown> }>;
  deleted?: string[];
}): Env {
  const matches = opts?.vectorMatches ?? [];
  const upserted = opts?.upserted ?? [];
  const deleted = opts?.deleted ?? [];

  const AI = {
    async run(_model: string, input: { text: string[] }) {
      opts?.onAiRun?.(input.text);
      return {
        data: input.text.map((_, idx) => [0.1 * (idx + 1), 0.2, 0.3, 0.4]),
      };
    },
  } as unknown as Ai;

  const VECTORS = {
    async query(_values: number[], qOpts?: { filter?: Record<string, string> }) {
      opts?.onVectorQuery?.();
      const lawFilter = qOpts?.filter?.law;
      const filtered = lawFilter ? matches.filter((m) => m.metadata?.law === lawFilter) : matches;
      return { matches: filtered };
    },
    async upsert(
      vectors: Array<{ id: string; values: number[]; metadata?: Record<string, unknown> }>,
    ) {
      upserted.push(...vectors);
      return { ids: vectors.map((v) => v.id), count: vectors.length };
    },
    async deleteByIds(ids: string[]) {
      deleted.push(...ids);
      return { ids, count: ids.length };
    },
  } as unknown as VectorizeIndex;

  const record: Record<string, unknown> = {
    ...(env as unknown as Record<string, unknown>),
    MCP_ENABLED: "true",
    MCP_TOKEN,
    BACKFILL_TOKEN,
    FEDERAL_CORPUS: opts?.federalCorpus ?? "1",
    RELAX_SEARCH: opts?.relaxSearch ?? "1",
    HYBRID_SEARCH: opts?.hybridSearch ?? "1",
    AI,
    VECTORS,
  };
  if (opts?.pdfCorpus === undefined) {
    delete record.PDF_CORPUS;
  } else {
    record.PDF_CORPUS = opts.pdfCorpus;
  }
  return record as unknown as Env;
}

async function callMcp(
  testEnv: Env,
  name: string,
  args: Record<string, unknown>,
  bearer: string = MCP_TOKEN,
): Promise<{ status: number; result: McpToolResult }> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request("https://legislation.test/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer}`,
        "MCP-Protocol-Version": "2025-06-18",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
    testEnv,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const body = (await res.json()) as { result: McpToolResult };
  return { status: res.status, result: body.result };
}

async function getHomePage(testEnv: Env): Promise<{ status: number; html: string }> {
  await caches.default.delete(CACHE_KEY);
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request("https://legislation.test/"), testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, html: await res.text() };
}

async function postBackfill(
  testEnv: Env,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await handleBackfill(
    new Request("https://legislation.test/admin/backfill-vectors", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${BACKFILL_TOKEN}`,
      },
      body: JSON.stringify(body),
    }),
    testEnv,
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

interface LawSeed {
  id: string;
  name_fr: string;
  name_en: string;
  official_cite: string;
  official_cite_en: string | null;
  chapter: string | null;
  consol_date_fr: string | null;
  consol_date_en: string | null;
  fonction: string;
  forum: string | null;
  parent_law_id: string | null;
  jurisdiction: string;
  unit: string;
  source: "epub" | "lims" | "pdf";
}

interface DivisionSeed {
  id: number;
  law_id: string;
  lang: "fr" | "en";
  kind: string;
  number: string | null;
  heading: string | null;
  path: string;
  parent_id: number | null;
  sort_order: number;
}

interface ArticleSeed {
  id: number;
  law_id: string;
  lang: "fr" | "en";
  number: string;
  sort_key: number;
  division_id: number;
  division_path: string;
  text: string;
  history: string | null;
  repealed: number;
  links: string | null;
}

const LAWS: LawSeed[] = [
  {
    id: "cpc",
    name_fr: "Code de procédure civile",
    name_en: "Code of Civil Procedure",
    official_cite: "RLRQ, c. C-25.01",
    official_cite_en: "CQLR, c. C-25.01",
    chapter: "C-25.01",
    consol_date_fr: "2026-04-07",
    consol_date_en: "2026-04-07",
    fonction: "loi",
    forum: null,
    parent_law_id: null,
    jurisdiction: "qc",
    unit: "article",
    source: "epub",
  },
  {
    id: "ccq",
    name_fr: "Code civil du Québec",
    name_en: "Civil Code of Québec",
    official_cite: "RLRQ, c. CCQ-1991",
    official_cite_en: "CQLR, c. CCQ-1991",
    chapter: "CCQ-1991",
    consol_date_fr: "2026-04-07",
    consol_date_en: "2026-04-07",
    fonction: "loi",
    forum: null,
    parent_law_id: null,
    jurisdiction: "qc",
    unit: "article",
    source: "epub",
  },
  {
    id: "v-1.1",
    name_fr: "Loi sur les valeurs mobilières",
    name_en: "Securities Act",
    official_cite: "RLRQ, c. V-1.1",
    official_cite_en: "CQLR, c. V-1.1",
    chapter: "V-1.1",
    consol_date_fr: "2026-04-01",
    consol_date_en: "2026-04-01",
    fonction: "loi",
    forum: null,
    parent_law_id: null,
    jurisdiction: "qc",
    unit: "article",
    source: "epub",
  },
  {
    id: "v-1.1-r.21",
    name_fr: "Règlement 45-106 sur les dispenses de prospectus",
    name_en: "Regulation 45-106 respecting Prospectus Exemptions",
    official_cite: "RLRQ, c. V-1.1, r. 21",
    official_cite_en: "CQLR, c. V-1.1, r. 21",
    chapter: "V-1.1, r. 21",
    consol_date_fr: "2026-03-15",
    consol_date_en: "2026-03-15",
    fonction: "reglement",
    forum: "Autorité des marchés financiers",
    parent_law_id: "v-1.1",
    jurisdiction: "qc",
    unit: "article",
    source: "epub",
  },
  {
    id: "qccs-mtl-directives",
    name_fr: "Directives de la Cour supérieure — District de Montréal",
    name_en: "Directives of the Superior Court — District of Montréal",
    official_cite: "Directives C.S. Montréal",
    official_cite_en: "S.C. Directives Montréal",
    chapter: null,
    consol_date_fr: "2026-02-23",
    consol_date_en: "2026-02-23",
    fonction: "directive",
    forum: "Cour supérieure",
    parent_law_id: null,
    jurisdiction: "qc",
    unit: "paragraphe",
    source: "pdf",
  },
  {
    id: "qccs-qc-directives",
    name_fr: "Directives de la Cour supérieure — District de Québec",
    name_en: "Directives de la Cour supérieure — District de Québec",
    official_cite: "Directives C.S. Québec",
    official_cite_en: null,
    chapter: null,
    consol_date_fr: "2026-01-15",
    consol_date_en: null,
    fonction: "directive",
    forum: "Cour supérieure",
    parent_law_id: null,
    jurisdiction: "qc",
    unit: "paragraphe",
    source: "pdf",
  },
  {
    id: "qccq-civil",
    name_fr: "Directives de la Cour du Québec — Matière civile",
    name_en: "Directives de la Cour du Québec — Matière civile",
    official_cite: "Directives C.Q. (civil)",
    official_cite_en: null,
    chapter: null,
    consol_date_fr: "2026-02-01",
    consol_date_en: null,
    fonction: "directive",
    forum: "Cour du Québec",
    parent_law_id: null,
    jurisdiction: "qc",
    unit: "paragraphe",
    source: "pdf",
  },
  {
    id: "qcca-avis",
    name_fr: "Avis du greffier de la Cour d'appel du Québec",
    name_en: "Avis du greffier de la Cour d'appel du Québec",
    official_cite: "Avis du greffier C.A.",
    official_cite_en: null,
    chapter: null,
    consol_date_fr: "2026-03-01",
    consol_date_en: null,
    fonction: "directive",
    forum: "Cour d'appel",
    parent_law_id: null,
    jurisdiction: "qc",
    unit: "paragraphe",
    source: "pdf",
  },
  {
    id: "amf-ig-45-106",
    name_fr: "Instruction générale 45-106 relative aux dispenses de prospectus",
    name_en: "Policy Statement to Regulation 45-106 respecting Prospectus Exemptions",
    official_cite: "Instruction générale 45-106",
    official_cite_en: "Policy Statement 45-106",
    chapter: null,
    consol_date_fr: "2026-03-15",
    consol_date_en: "2026-03-15",
    fonction: "orientation",
    forum: "Autorité des marchés financiers",
    parent_law_id: null,
    jurisdiction: "qc",
    unit: "article",
    source: "pdf",
  },
];

function buildDivisions(): DivisionSeed[] {
  const rows: DivisionSeed[] = [
    {
      id: 10001,
      law_id: "cpc",
      lang: "fr",
      kind: "livre",
      number: "V",
      heading: "PROCÉDURE NON CONTENTIEUSE",
      path: "ga:l_v",
      parent_id: null,
      sort_order: 1,
    },
    {
      id: 10002,
      law_id: "cpc",
      lang: "fr",
      kind: "titre",
      number: "IV",
      heading: "DEMANDES CIVILES ET ASSIGNATION HORS DU QUÉBEC",
      path: "ga:l_v-gb:l_iv",
      parent_id: 10001,
      sort_order: 2,
    },
    {
      id: 15001,
      law_id: "cpc",
      lang: "en",
      kind: "livre",
      number: "V",
      heading: "NON-CONTENTIOUS PROCEEDINGS",
      path: "ga:l_five",
      parent_id: null,
      sort_order: 1,
    },
    {
      id: 15002,
      law_id: "cpc",
      lang: "en",
      kind: "titre",
      number: "IV",
      heading: "CIVIL MOTIONS AND SERVICE OUTSIDE QUÉBEC",
      path: "ga:l_five-gb:l_four",
      parent_id: 15001,
      sort_order: 2,
    },
    {
      id: 20001,
      law_id: "ccq",
      lang: "fr",
      kind: "livre",
      number: "V",
      heading: "DES OBLIGATIONS",
      path: "ga:l_cinquieme",
      parent_id: null,
      sort_order: 1,
    },
    {
      id: 20002,
      law_id: "ccq",
      lang: "fr",
      kind: "titre",
      number: "II",
      heading: "DES CONTRATS NOMMÉS",
      path: "ga:l_cinquieme-gb:l_deuxieme",
      parent_id: 20001,
      sort_order: 2,
    },
    {
      id: 20003,
      law_id: "ccq",
      lang: "fr",
      kind: "chapitre",
      number: "I",
      heading: "DE LA VENTE ET DU VICE CACHÉ",
      path: "ga:l_cinquieme-gb:l_deuxieme-gc:l_premier",
      parent_id: 20002,
      sort_order: 3,
    },
    {
      id: 25001,
      law_id: "ccq",
      lang: "en",
      kind: "livre",
      number: "V",
      heading: "OBLIGATIONS",
      path: "ga:l_five",
      parent_id: null,
      sort_order: 1,
    },
    {
      id: 25002,
      law_id: "ccq",
      lang: "en",
      kind: "titre",
      number: "II",
      heading: "NOMINATE CONTRACTS",
      path: "ga:l_five-gb:l_two",
      parent_id: 25001,
      sort_order: 2,
    },
    {
      id: 25003,
      law_id: "ccq",
      lang: "en",
      kind: "chapitre",
      number: "I",
      heading: "SALE AND LATENT DEFECT",
      path: "ga:l_five-gb:l_two-gc:l_one",
      parent_id: 25002,
      sort_order: 3,
    },
    {
      id: 30001,
      law_id: "v-1.1",
      lang: "fr",
      kind: "chapitre",
      number: "I",
      heading: "VALEURS MOBILIÈRES ET DISPENSES DE PROSPECTUS",
      path: "ga:l_i",
      parent_id: null,
      sort_order: 1,
    },
    {
      id: 35001,
      law_id: "v-1.1",
      lang: "en",
      kind: "chapitre",
      number: "I",
      heading: "SECURITIES AND PROSPECTUS EXEMPTIONS",
      path: "ga:l_i",
      parent_id: null,
      sort_order: 1,
    },
    {
      id: 40001,
      law_id: "v-1.1-r.21",
      lang: "fr",
      kind: "chapitre",
      number: "1",
      heading: "DÉFINITIONS ET DISPENSES DE PROSPECTUS",
      path: "ga:l_1",
      parent_id: null,
      sort_order: 1,
    },
    {
      id: 45001,
      law_id: "v-1.1-r.21",
      lang: "en",
      kind: "chapitre",
      number: "1",
      heading: "DEFINITIONS AND PROSPECTUS EXEMPTIONS",
      path: "ga:l_1",
      parent_id: null,
      sort_order: 1,
    },
    {
      id: 50001,
      law_id: "qccs-mtl-directives",
      lang: "fr",
      kind: "section",
      number: "1",
      heading: "DEMANDES CIVILES ET GESTION D'INSTANCE",
      path: "ph1:1",
      parent_id: null,
      sort_order: 1,
    },
    {
      id: 50002,
      law_id: "qccs-mtl-directives",
      lang: "fr",
      kind: "sous-section",
      number: "1.1",
      heading: "MONTAGE DU CAHIER D'AUDIENCE",
      path: "ph1:1-ph2:1",
      parent_id: 50001,
      sort_order: 2,
    },
    {
      id: 50003,
      law_id: "qccs-mtl-directives",
      lang: "fr",
      kind: "niveau6",
      number: "1.1.1",
      heading: "NIVEAU 3",
      path: "ph1:1-ph2:1-ph3:1",
      parent_id: 50002,
      sort_order: 3,
    },
    {
      id: 50004,
      law_id: "qccs-mtl-directives",
      lang: "fr",
      kind: "niveau6",
      number: "1.1.1.1",
      heading: "NIVEAU 4",
      path: "ph1:1-ph2:1-ph3:1-ph4:1",
      parent_id: 50003,
      sort_order: 4,
    },
    {
      id: 50005,
      law_id: "qccs-mtl-directives",
      lang: "fr",
      kind: "niveau6",
      number: "1.1.1.1.1",
      heading: "NIVEAU 5",
      path: "ph1:1-ph2:1-ph3:1-ph4:1-ph5:1",
      parent_id: 50004,
      sort_order: 5,
    },
    {
      id: 50006,
      law_id: "qccs-mtl-directives",
      lang: "fr",
      kind: "niveau6",
      number: "1.1.1.1.1.1",
      heading: "NIVEAU 6",
      path: "ph1:1-ph2:1-ph3:1-ph4:1-ph5:1-ph6:1",
      parent_id: 50005,
      sort_order: 6,
    },
    {
      id: 50007,
      law_id: "qccs-mtl-directives",
      lang: "fr",
      kind: "niveau7",
      number: "1.1.1.1.1.1.1",
      heading: "NIVEAU 7",
      path: "ph1:1-ph2:1-ph3:1-ph4:1-ph5:1-ph6:1-ph7:1",
      parent_id: 50006,
      sort_order: 7,
    },
    {
      id: 50008,
      law_id: "qccs-mtl-directives",
      lang: "fr",
      kind: "niveau8",
      number: "1.1.1.1.1.1.1.1",
      heading: "NIVEAU 8",
      path: "ph1:1-ph2:1-ph3:1-ph4:1-ph5:1-ph6:1-ph7:1-ph8:1",
      parent_id: 50007,
      sort_order: 8,
    },
    {
      id: 50009,
      law_id: "qccs-mtl-directives",
      lang: "fr",
      kind: "niveau8",
      number: "1.1.1.1.1.1.1.1.1",
      heading: "SOUS-DIVISIONS PROFONDES DE GESTION",
      path: DEEP_PATH,
      parent_id: 50008,
      sort_order: 9,
    },
    {
      id: 50010,
      law_id: "qccs-mtl-directives",
      lang: "fr",
      kind: "section",
      number: "10",
      heading: "GESTION PARTICULIÈRE DES DOSSIERS LONGS",
      path: "ph1:10",
      parent_id: null,
      sort_order: 10,
    },
    {
      id: 50011,
      law_id: "qccs-mtl-directives",
      lang: "fr",
      kind: "annexe",
      number: "1",
      heading: "ANNEXE 1 — FORMULAIRES DE MONTAGE",
      path: "ps:1",
      parent_id: null,
      sort_order: 11,
    },
    {
      id: 55001,
      law_id: "qccs-mtl-directives",
      lang: "en",
      kind: "section",
      number: "1",
      heading: "CIVIL MOTIONS AND CASE MANAGEMENT",
      path: "ph1:1",
      parent_id: null,
      sort_order: 1,
    },
    {
      id: 55002,
      law_id: "qccs-mtl-directives",
      lang: "en",
      kind: "sous-section",
      number: "1.1",
      heading: "HEARING BOOK ASSEMBLY",
      path: "ph1:1-ph2:1",
      parent_id: 55001,
      sort_order: 2,
    },
    {
      id: 55010,
      law_id: "qccs-mtl-directives",
      lang: "en",
      kind: "section",
      number: "10",
      heading: "SPECIAL MANAGEMENT OF LONG TRIALS",
      path: "ph1:10",
      parent_id: null,
      sort_order: 10,
    },
    {
      id: 55011,
      law_id: "qccs-mtl-directives",
      lang: "en",
      kind: "annexe",
      number: "1",
      heading: "SCHEDULE 1 — ASSEMBLY FORMS",
      path: "ps:1",
      parent_id: null,
      sort_order: 11,
    },
    {
      id: 60001,
      law_id: "qccs-qc-directives",
      lang: "fr",
      kind: "section",
      number: "1",
      heading: "AUDIENCES EN CHAMBRE DE PRATIQUE QUÉBEC",
      path: "ph1:1",
      parent_id: null,
      sort_order: 1,
    },
    {
      id: 70001,
      law_id: "qccq-civil",
      lang: "fr",
      kind: "section",
      number: "1",
      heading: "CHAMBRE CIVILE ET PETITES CRÉANCES",
      path: "ph1:1",
      parent_id: null,
      sort_order: 1,
    },
    {
      id: 80001,
      law_id: "qcca-avis",
      lang: "fr",
      kind: "section",
      number: "1",
      heading: "DÉPÔT ÉLECTRONIQUE DES MÉMOIRES EN APPEL",
      path: "ph1:1",
      parent_id: null,
      sort_order: 1,
    },
    {
      id: 80002,
      law_id: "qcca-avis",
      lang: "fr",
      kind: "annexe",
      number: "A",
      heading: "AIDE-MÉMOIRE DE DÉPÔT EN APPEL",
      path: "ps:1",
      parent_id: null,
      sort_order: 2,
    },
    {
      id: 90001,
      law_id: "amf-ig-45-106",
      lang: "fr",
      kind: "chapitre",
      number: "1",
      heading: "OBJET ET INTERPRÉTATION",
      path: "ph1:1",
      parent_id: null,
      sort_order: 1,
    },
    {
      id: 90002,
      law_id: "amf-ig-45-106",
      lang: "fr",
      kind: "chapitre",
      number: "2",
      heading: "DISPENSES DE PROSPECTUS ET INVESTISSEURS QUALIFIÉS",
      path: "ph1:2",
      parent_id: null,
      sort_order: 2,
    },
    {
      id: 90003,
      law_id: "amf-ig-45-106",
      lang: "fr",
      kind: "annexe",
      number: "A",
      heading: "ANNEXE A — FORMULAIRES DE DÉCLARATION",
      path: "ps:1",
      parent_id: null,
      sort_order: 3,
    },
    {
      id: 95001,
      law_id: "amf-ig-45-106",
      lang: "en",
      kind: "chapitre",
      number: "1",
      heading: "PURPOSE AND INTERPRETATION",
      path: "ph1:1",
      parent_id: null,
      sort_order: 1,
    },
    {
      id: 95002,
      law_id: "amf-ig-45-106",
      lang: "en",
      kind: "chapitre",
      number: "2",
      heading: "PROSPECTUS EXEMPTIONS AND ACCREDITED INVESTORS",
      path: "ph1:2",
      parent_id: null,
      sort_order: 2,
    },
    {
      id: 95003,
      law_id: "amf-ig-45-106",
      lang: "en",
      kind: "annexe",
      number: "A",
      heading: "SCHEDULE A — REPORT FORMS",
      path: "ps:1",
      parent_id: null,
      sort_order: 3,
    },
  ];
  return rows;
}

function buildArticles(): ArticleSeed[] {
  return [
    {
      id: 10001,
      law_id: "cpc",
      lang: "fr",
      number: "145",
      sort_key: sortKeyOf("145"),
      division_id: 10002,
      division_path: "ga:l_v-gb:l_iv",
      text: "La demande civile en justice est déposée au greffe et l'assignation hors du Québec respecte les délais prévus.",
      history: "2014, c. 1, a. 145.",
      repealed: 0,
      links: null,
    },
    {
      id: 10002,
      law_id: "cpc",
      lang: "fr",
      number: "490",
      sort_key: sortKeyOf("490"),
      division_id: 10002,
      division_path: "ga:l_v-gb:l_iv",
      text: "Le tribunal peut, lors d'une demande civile déposée au greffe, ordonner l'assignation hors du Québec et la mise en état du dossier.",
      history: "2014, c. 1, a. 490.",
      repealed: 0,
      links: null,
    },
    {
      id: 15001,
      law_id: "cpc",
      lang: "en",
      number: "145",
      sort_key: sortKeyOf("145"),
      division_id: 15002,
      division_path: "ga:l_five-gb:l_four",
      text: "A civil judicial application is filed at the court office and service outside Québec respects prescribed time limits.",
      history: "2014, c. 1, s. 145.",
      repealed: 0,
      links: null,
    },
    {
      id: 15002,
      law_id: "cpc",
      lang: "en",
      number: "490",
      sort_key: sortKeyOf("490"),
      division_id: 15002,
      division_path: "ga:l_five-gb:l_four",
      text: "The court may, on a civil application filed at the court office, order service outside Québec and case management measures.",
      history: "2014, c. 1, s. 490.",
      repealed: 0,
      links: null,
    },
    {
      id: 20001,
      law_id: "ccq",
      lang: "fr",
      number: "1457",
      sort_key: sortKeyOf("1457"),
      division_id: 20001,
      division_path: "ga:l_cinquieme",
      text: "Toute personne a le devoir de respecter les règles de conduite qui s'imposent à elle et de réparer le préjudice causé par sa faute.",
      history: "1991, c. 64, a. 1457.",
      repealed: 0,
      links: null,
    },
    {
      id: 20002,
      law_id: "ccq",
      lang: "fr",
      number: "1726",
      sort_key: sortKeyOf("1726"),
      division_id: 20003,
      division_path: "ga:l_cinquieme-gb:l_deuxieme-gc:l_premier",
      text: "Le vendeur est tenu de garantir à l'acheteur que le bien et ses accessoires sont exempts de vices cachés.",
      history: "1991, c. 64, a. 1726.",
      repealed: 0,
      links: null,
    },
    {
      id: 25001,
      law_id: "ccq",
      lang: "en",
      number: "1457",
      sort_key: sortKeyOf("1457"),
      division_id: 25001,
      division_path: "ga:l_five",
      text: "Every person has a duty to abide by the rules of conduct incumbent on him and make reparation for injury caused by his fault.",
      history: "1991, c. 64, s. 1457.",
      repealed: 0,
      links: null,
    },
    {
      id: 25002,
      law_id: "ccq",
      lang: "en",
      number: "1726",
      sort_key: sortKeyOf("1726"),
      division_id: 25003,
      division_path: "ga:l_five-gb:l_two-gc:l_one",
      text: "The seller is bound to warrant the buyer that the property and its accessories are free of latent defects.",
      history: "1991, c. 64, s. 1726.",
      repealed: 0,
      links: null,
    },
    {
      id: 30001,
      law_id: "v-1.1",
      lang: "fr",
      number: "11",
      sort_key: sortKeyOf("11"),
      division_id: 30001,
      division_path: "ga:l_i",
      text: "Toute personne qui entend procéder au placement d'une valeur mobilière doit établir un prospectus, sauf dispense de prospectus prévue par règlement.",
      history: "L.R.Q., c. V-1.1, a. 11.",
      repealed: 0,
      links: null,
    },
    {
      id: 30002,
      law_id: "v-1.1",
      lang: "fr",
      number: "41",
      sort_key: sortKeyOf("41"),
      division_id: 30001,
      division_path: "ga:l_i",
      text: "Est dispensé de prospectus le placement en valeurs mobilières effectué auprès d'un investisseur qualifié.",
      history: "L.R.Q., c. V-1.1, a. 41.",
      repealed: 0,
      links: null,
    },
    {
      id: 35001,
      law_id: "v-1.1",
      lang: "en",
      number: "11",
      sort_key: sortKeyOf("11"),
      division_id: 35001,
      division_path: "ga:l_i",
      text: "Every person intending to make a distribution of securities must prepare a prospectus, unless a prospectus exemption applies by regulation.",
      history: "R.S.Q., c. V-1.1, s. 11.",
      repealed: 0,
      links: null,
    },
    {
      id: 35002,
      law_id: "v-1.1",
      lang: "en",
      number: "41",
      sort_key: sortKeyOf("41"),
      division_id: 35001,
      division_path: "ga:l_i",
      text: "A distribution of securities made to an accredited investor is exempt from the prospectus requirement.",
      history: "R.S.Q., c. V-1.1, s. 41.",
      repealed: 0,
      links: null,
    },
    {
      id: 40001,
      law_id: "v-1.1-r.21",
      lang: "fr",
      number: "1.1",
      sort_key: sortKeyOf("1.1"),
      division_id: 40001,
      division_path: "ga:l_1",
      text: "Dans le présent règlement, on entend par investisseur qualifié la personne visée à l'article 2.3 pour les dispenses de prospectus en valeurs mobilières.",
      history: "A.M. 2005-22, a. 1.1.",
      repealed: 0,
      links: null,
    },
    {
      id: 40002,
      law_id: "v-1.1-r.21",
      lang: "fr",
      number: "2.3",
      sort_key: sortKeyOf("2.3"),
      division_id: 40001,
      division_path: "ga:l_1",
      text: "L'obligation d'établir un prospectus ne s'applique pas au placement d'un titre auprès d'un investisseur qualifié qui achète pour son propre compte.",
      history: "A.M. 2005-22, a. 2.3.",
      repealed: 0,
      links: null,
    },
    {
      id: 40003,
      law_id: "v-1.1-r.21",
      lang: "fr",
      number: "15.01",
      sort_key: sortKeyOf("15.01"),
      division_id: 40001,
      division_path: "ga:l_1",
      text: "Disposition transitoire 15.01 antérieure à 15.1 sur les valeurs mobilières.",
      history: "A.M. 2005-22, a. 15.01.",
      repealed: 0,
      links: null,
    },
    {
      id: 40004,
      law_id: "v-1.1-r.21",
      lang: "fr",
      number: "15.1",
      sort_key: sortKeyOf("15.1"),
      division_id: 40001,
      division_path: "ga:l_1",
      text: "Disposition complémentaire 15.1 suivant 15.01 sur les valeurs mobilières.",
      history: "A.M. 2005-22, a. 15.1.",
      repealed: 0,
      links: null,
    },
    {
      id: 45001,
      law_id: "v-1.1-r.21",
      lang: "en",
      number: "1.1",
      sort_key: sortKeyOf("1.1"),
      division_id: 45001,
      division_path: "ga:l_1",
      text: "In this Regulation, accredited investor means a person referred to in section 2.3 for securities prospectus exemptions.",
      history: "M.O. 2005-22, s. 1.1.",
      repealed: 0,
      links: null,
    },
    {
      id: 45002,
      law_id: "v-1.1-r.21",
      lang: "en",
      number: "2.3",
      sort_key: sortKeyOf("2.3"),
      division_id: 45001,
      division_path: "ga:l_1",
      text: "The prospectus requirement does not apply to a distribution of a security to an accredited investor purchasing as principal.",
      history: "M.O. 2005-22, s. 2.3.",
      repealed: 0,
      links: null,
    },
    {
      id: 50001,
      law_id: "qccs-mtl-directives",
      lang: "fr",
      number: "1",
      sort_key: sortKeyOf("1"),
      division_id: 50001,
      division_path: "ph1:1",
      text: "La présente directive encadre la demande civile au greffe de Montréal, sous réserve du Code de procédure civile.",
      history: null,
      repealed: 0,
      links: null,
    },
    {
      id: 50002,
      law_id: "qccs-mtl-directives",
      lang: "fr",
      number: "12",
      sort_key: sortKeyOf("12"),
      division_id: 50002,
      division_path: "ph1:1-ph2:1",
      text: "Le montage du cahier d'audience pour une demande civile déposée au greffe de Montréal comporte des onglets numérotés.",
      history: "Directive du 23 février 2026.",
      repealed: 0,
      links: null,
    },
    {
      id: 50003,
      law_id: "qccs-mtl-directives",
      lang: "fr",
      number: "12.1",
      sort_key: sortKeyOf("12.1"),
      division_id: 50009,
      division_path: DEEP_PATH,
      text: "Sous-paragraphe profond sur la pagination électronique et l'assignation hors du Québec au greffe.",
      history: null,
      repealed: 0,
      links: null,
    },
    {
      id: 50004,
      law_id: "qccs-mtl-directives",
      lang: "fr",
      number: "13",
      sort_key: sortKeyOf("13"),
      division_id: 50002,
      division_path: "ph1:1-ph2:1",
      text: "Abrogé.",
      history: "Directive du 1er janvier 2024; abrogée le 23 février 2026.",
      repealed: 1,
      links: null,
    },
    {
      id: 50005,
      law_id: "qccs-mtl-directives",
      lang: "fr",
      number: "45",
      sort_key: sortKeyOf("45"),
      division_id: 50010,
      division_path: "ph1:10",
      text: "Les dossiers longs de plus de cinq jours relèvent du juge coordonnateur de la section dix.",
      history: null,
      repealed: 0,
      links: null,
    },
    {
      id: 50006,
      law_id: "qccs-mtl-directives",
      lang: "fr",
      number: "annexe-1",
      sort_key: DISPOSITION_SORT_BASE,
      division_id: 50011,
      division_path: "ps:1",
      text: "Formulaire de déclaration commune et bordereau de montage du cahier des sources.",
      history: null,
      repealed: 0,
      links: JSON.stringify([
        {
          label: "Formulaire PDF officiel",
          url: "https://coursuperieureduquebec.ca/formulaire-montage.pdf",
        },
      ]),
    },
    {
      id: 55001,
      law_id: "qccs-mtl-directives",
      lang: "en",
      number: "1",
      sort_key: sortKeyOf("1"),
      division_id: 55001,
      division_path: "ph1:1",
      text: "This directive governs civil motions at the Montréal court office, subject to the Code of Civil Procedure.",
      history: null,
      repealed: 0,
      links: null,
    },
    {
      id: 55002,
      law_id: "qccs-mtl-directives",
      lang: "en",
      number: "12",
      sort_key: sortKeyOf("12"),
      division_id: 55002,
      division_path: "ph1:1-ph2:1",
      text: "Assembling the hearing book for a civil motion filed at the Montréal court office requires numbered tabs.",
      history: "Directive of February 23, 2026.",
      repealed: 0,
      links: null,
    },
    {
      id: 55004,
      law_id: "qccs-mtl-directives",
      lang: "en",
      number: "13",
      sort_key: sortKeyOf("13"),
      division_id: 55002,
      division_path: "ph1:1-ph2:1",
      text: "Repealed.",
      history: "Directive of January 1, 2024; repealed February 23, 2026.",
      repealed: 1,
      links: null,
    },
    {
      id: 55005,
      law_id: "qccs-mtl-directives",
      lang: "en",
      number: "45",
      sort_key: sortKeyOf("45"),
      division_id: 55010,
      division_path: "ph1:10",
      text: "Long trials exceeding five days are assigned by the coordinating judge under section ten.",
      history: null,
      repealed: 0,
      links: null,
    },
    {
      id: 55006,
      law_id: "qccs-mtl-directives",
      lang: "en",
      number: "annexe-1",
      sort_key: DISPOSITION_SORT_BASE,
      division_id: 55011,
      division_path: "ps:1",
      text: "Joint declaration form and assembly checklist for book of authorities.",
      history: null,
      repealed: 0,
      links: JSON.stringify([
        {
          label: "Official PDF Form",
          url: "https://coursuperieureduquebec.ca/formulaire-montage.pdf",
        },
      ]),
    },
    {
      id: 60001,
      law_id: "qccs-qc-directives",
      lang: "fr",
      number: "12",
      sort_key: sortKeyOf("12"),
      division_id: 60001,
      division_path: "ph1:1",
      text: "À Québec, le cahier d'audience pour une demande civile en chambre de pratique est transmis par voie numérique au greffe.",
      history: null,
      repealed: 0,
      links: "[]",
    },
    {
      id: 70001,
      law_id: "qccq-civil",
      lang: "fr",
      number: "5",
      sort_key: sortKeyOf("5"),
      division_id: 70001,
      division_path: "ph1:1",
      text: "À la Cour du Québec, la notification d'une demande civile au greffe s'effectue avant l'appel du rôle provisoire.",
      history: null,
      repealed: 0,
      links: null,
    },
    {
      id: 70002,
      law_id: "qccq-civil",
      lang: "fr",
      number: "6",
      sort_key: sortKeyOf("6"),
      division_id: 70001,
      division_path: "ph1:1",
      text: "[…]",
      history: "Modifié par la directive du 1er février 2026; paragraphe retranché.",
      repealed: 1,
      links: null,
    },
    {
      id: 80001,
      law_id: "qcca-avis",
      lang: "fr",
      number: "1",
      sort_key: sortKeyOf("1"),
      division_id: 80001,
      division_path: "ph1:1",
      text: "Le greffier rappelle les modalités pratiques de dépôt au greffe d'appel pour une demande civile.",
      history: null,
      repealed: 0,
      links: null,
    },
    {
      id: 80002,
      law_id: "qcca-avis",
      lang: "fr",
      number: "2",
      sort_key: sortKeyOf("2"),
      division_id: 80001,
      division_path: "ph1:1",
      text: "Abrogé.",
      history: "Remplacé par l'avis du 1er mars 2026.",
      repealed: 1,
      links: null,
    },
    {
      id: 80003,
      law_id: "qcca-avis",
      lang: "fr",
      number: "annexe-a",
      sort_key: DISPOSITION_SORT_BASE,
      division_id: 80002,
      division_path: "ps:1",
      text: "Liste de contrôle pour le dépôt du mémoire et des cahiers de sources en Cour d'appel.",
      history: null,
      repealed: 0,
      links: JSON.stringify([
        {
          label: "Aide-mémoire officiel C.A.",
          url: "https://courdappelduquebec.ca/aide-memoire.pdf",
        },
        {
          label: "Gabarit de mémoire",
          url: "https://courdappelduquebec.ca/gabarit.docx",
        },
      ]),
    },
    {
      id: 90001,
      law_id: "amf-ig-45-106",
      lang: "fr",
      number: "1.1",
      sort_key: sortKeyOf("1.1"),
      division_id: 90001,
      division_path: "ph1:1",
      text: "Objet de l'instruction générale 45-106 relative aux dispenses de prospectus.",
      history: null,
      repealed: 0,
      links: null,
    },
    {
      id: 90002,
      law_id: "amf-ig-45-106",
      lang: "fr",
      number: "2.1",
      sort_key: sortKeyOf("2.1"),
      division_id: 90002,
      division_path: "ph1:2",
      text: "Interprétation des conditions générales de dispense de prospectus.",
      history: null,
      repealed: 0,
      links: null,
    },
    {
      id: 90003,
      law_id: "amf-ig-45-106",
      lang: "fr",
      number: "2A.1",
      sort_key: sortKeyOf("2A.1"),
      division_id: 90002,
      division_path: "ph1:2",
      text: "Orientation administrative sur la dispense pour investisseur qualifié et vérification sous le Règlement 45-106.",
      history: "Instruction générale modifiée le 15 mars 2026.",
      repealed: 0,
      links: null,
    },
    {
      id: 90004,
      law_id: "amf-ig-45-106",
      lang: "fr",
      number: "4B.2",
      sort_key: sortKeyOf("4B.2"),
      division_id: 90002,
      division_path: "ph1:2",
      text: "Déclaration de placement avec dispense 4B.2 et dépôt électronique auprès de l'Autorité.",
      history: null,
      repealed: 0,
      links: null,
    },
    {
      id: 90005,
      law_id: "amf-ig-45-106",
      lang: "fr",
      number: "10.1",
      sort_key: sortKeyOf("10.1"),
      division_id: 90002,
      division_path: "ph1:2",
      text: "Dispositions transitoires et entrée en vigueur de l'instruction générale.",
      history: null,
      repealed: 0,
      links: null,
    },
    {
      id: 90006,
      law_id: "amf-ig-45-106",
      lang: "fr",
      number: "annexe-a",
      sort_key: DISPOSITION_SORT_BASE,
      division_id: 90003,
      division_path: "ps:1",
      text: "Annexe A — Formulaire 45-106A1 de déclaration de placement avec dispense.",
      history: null,
      repealed: 0,
      links: JSON.stringify([
        {
          label: "Formulaire 45-106A1 (PDF & paramètres)",
          url: "https://lautorite.qc.ca/formulaires/45-106a1.pdf?lang=fr&rev=2#page=3",
        },
      ]),
    },
    {
      id: 95001,
      law_id: "amf-ig-45-106",
      lang: "en",
      number: "1.1",
      sort_key: sortKeyOf("1.1"),
      division_id: 95001,
      division_path: "ph1:1",
      text: "Purpose of Policy Statement 45-106 respecting Prospectus Exemptions.",
      history: null,
      repealed: 0,
      links: null,
    },
    {
      id: 95002,
      law_id: "amf-ig-45-106",
      lang: "en",
      number: "2.1",
      sort_key: sortKeyOf("2.1"),
      division_id: 95002,
      division_path: "ph1:2",
      text: "Interpretation of general prospectus exemption conditions.",
      history: null,
      repealed: 0,
      links: null,
    },
    {
      id: 95003,
      law_id: "amf-ig-45-106",
      lang: "en",
      number: "2A.1",
      sort_key: sortKeyOf("2A.1"),
      division_id: 95002,
      division_path: "ph1:2",
      text: "Administrative guidance on the accredited investor exemption and verification under Regulation 45-106.",
      history: "Policy Statement amended March 15, 2026.",
      repealed: 0,
      links: null,
    },
    {
      id: 95004,
      law_id: "amf-ig-45-106",
      lang: "en",
      number: "4B.2",
      sort_key: sortKeyOf("4B.2"),
      division_id: 95002,
      division_path: "ph1:2",
      text: "Report of exempt distribution 4B.2 and electronic filing with the Authority.",
      history: null,
      repealed: 0,
      links: null,
    },
    {
      id: 95005,
      law_id: "amf-ig-45-106",
      lang: "en",
      number: "10.1",
      sort_key: sortKeyOf("10.1"),
      division_id: 95002,
      division_path: "ph1:2",
      text: "Transitional provisions and coming into force of the policy statement.",
      history: null,
      repealed: 0,
      links: null,
    },
    {
      id: 95006,
      law_id: "amf-ig-45-106",
      lang: "en",
      number: "annexe-a",
      sort_key: DISPOSITION_SORT_BASE,
      division_id: 95003,
      division_path: "ps:1",
      text: "Schedule A — Form 45-106F1 Report of Exempt Distribution.",
      history: null,
      repealed: 0,
      links: JSON.stringify([
        {
          label: "Form 45-106F1 (PDF & params)",
          url: "https://lautorite.qc.ca/formulaires/45-106a1.pdf?lang=en&rev=2#page=3",
        },
      ]),
    },
  ];
}

async function seedCorpus(): Promise<void> {
  const d = db();
  const lawCols = (await d.prepare("PRAGMA table_info(laws)").all<{ name: string }>()).results;
  hasSourceCol = lawCols.some((c) => c.name === "source");
  const artCols = (await d.prepare("PRAGMA table_info(articles)").all<{ name: string }>()).results;
  hasLinksCol = artCols.some((c) => c.name === "links");
  articleFtsColumns = (
    await d.prepare("PRAGMA table_info(articles_fts)").all<{ cid: number; name: string }>()
  ).results;

  for (const l of LAWS) {
    if (hasSourceCol) {
      await d
        .prepare(
          `INSERT INTO laws (
             id, name_fr, name_en, official_cite, official_cite_en, chapter,
             consol_date_fr, consol_date_en, fonction, forum, parent_law_id,
             name_norm, jurisdiction, unit, source
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          l.id,
          l.name_fr,
          l.name_en,
          l.official_cite,
          l.official_cite_en,
          l.chapter,
          l.consol_date_fr,
          l.consol_date_en,
          l.fonction,
          l.forum,
          l.parent_law_id,
          norm(l.name_fr),
          l.jurisdiction,
          l.unit,
          l.source,
        )
        .run();
    } else {
      await d
        .prepare(
          `INSERT INTO laws (
             id, name_fr, name_en, official_cite, official_cite_en, chapter,
             consol_date_fr, consol_date_en, fonction, forum, parent_law_id,
             name_norm, jurisdiction, unit
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          l.id,
          l.name_fr,
          l.name_en,
          l.official_cite,
          l.official_cite_en,
          l.chapter,
          l.consol_date_fr,
          l.consol_date_en,
          l.fonction,
          l.forum,
          l.parent_law_id,
          norm(l.name_fr),
          l.jurisdiction,
          l.unit,
        )
        .run();
    }
  }

  for (const dv of buildDivisions()) {
    await d
      .prepare(
        `INSERT INTO divisions (
           id, law_id, lang, kind, number, heading, path, repealed, parent_id, sort_order, heading_norm
         ) VALUES (?,?,?,?,?,?,?,0,?,?,?)`,
      )
      .bind(
        dv.id,
        dv.law_id,
        dv.lang,
        dv.kind,
        dv.number,
        dv.heading,
        dv.path,
        dv.parent_id,
        dv.sort_order,
        dv.heading ? norm(dv.heading) : null,
      )
      .run();
  }

  for (const a of buildArticles()) {
    if (hasLinksCol) {
      await d
        .prepare(
          `INSERT INTO articles (
             id, law_id, lang, number, sort_key, division_id, division_path,
             text, history, repealed, links
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          a.id,
          a.law_id,
          a.lang,
          a.number,
          a.sort_key,
          a.division_id,
          a.division_path,
          a.text,
          a.history,
          a.repealed,
          a.links,
        )
        .run();
    } else {
      await d
        .prepare(
          `INSERT INTO articles (
             id, law_id, lang, number, sort_key, division_id, division_path,
             text, history, repealed
           ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          a.id,
          a.law_id,
          a.lang,
          a.number,
          a.sort_key,
          a.division_id,
          a.division_path,
          a.text,
          a.history,
          a.repealed,
        )
        .run();
    }
    await d
      .prepare("INSERT INTO article_numbers (law_id, lang, number, article_id) VALUES (?,?,?,?)")
      .bind(a.law_id, a.lang, a.number, a.id)
      .run();
  }

  const subjects: Array<[string, string, string, string, string, string]> = [
    [
      "procedure-civile",
      "Procédure civile",
      "Civil Procedure",
      "specialise",
      "assignation hors du quebec demande civile moyen preliminaire greffe cahier audience",
      "service outside quebec civil motion preliminary exception court registry",
    ],
    [
      "valeurs-mobilieres",
      "Valeurs mobilières",
      "Securities",
      "specialise",
      "dispense prospectus investisseur qualifie valeurs mobilieres autorite marches financiers",
      "prospectus exemption accredited investor securities autorite marches financiers",
    ],
    [
      "obligations-contrats",
      "Obligations et vente",
      "Obligations and Sale",
      "prive-ccq",
      "responsabilite civile faute prejudice vice cache garantie bien",
      "civil liability fault injury latent defect warranty",
    ],
  ];
  for (const [id, lfr, len, kind, dfr, den] of subjects) {
    await d
      .prepare(
        `INSERT INTO subjects (
           id, label_fr, label_en, label_norm, kind, description_fr, description_en
         ) VALUES (?,?,?,?,?,?,?)`,
      )
      .bind(id, lfr, len, norm(lfr), kind, dfr, den)
      .run();
  }

  const subjectMaps: Array<[string, string, string]> = [
    ["procedure-civile", "cpc", "ga:l_v-gb:l_iv"],
    ["procedure-civile", "qccs-mtl-directives", ""],
    ["procedure-civile", "qccq-civil", ""],
    ["procedure-civile", "qcca-avis", ""],
    ["valeurs-mobilieres", "v-1.1", ""],
    ["valeurs-mobilieres", "v-1.1-r.21", ""],
    ["valeurs-mobilieres", "amf-ig-45-106", ""],
    ["obligations-contrats", "ccq", "ga:l_cinquieme"],
  ];
  for (const [sid, lid, path] of subjectMaps) {
    await d
      .prepare("INSERT INTO subject_map (subject_id, law_id, division_path) VALUES (?,?,?)")
      .bind(sid, lid, path)
      .run();
  }

  const relations: Array<[string, string, string, string, number, number, string | null]> = [
    [
      "qccs-mtl-directives",
      "cpc",
      "preseance-sur",
      "cure",
      1,
      1,
      "Les directives de la Cour supérieure ne prévalent pas sur le Code de procédure civile.",
    ],
    [
      "qccs-qc-directives",
      "cpc",
      "preseance-sur",
      "cure",
      1,
      1,
      "Les directives de la Cour supérieure ne prévalent pas sur le Code de procédure civile.",
    ],
    [
      "qccq-civil",
      "cpc",
      "preseance-sur",
      "cure",
      1,
      1,
      "Les directives de la Cour du Québec sont subordonnées au Code de procédure civile.",
    ],
    [
      "qcca-avis",
      "cpc",
      "preseance-sur",
      "cure",
      1,
      1,
      "Les avis du greffier complètent sans déroger au Code de procédure civile.",
    ],
    [
      "amf-ig-45-106",
      "v-1.1-r.21",
      "interprete",
      "cure",
      1,
      1,
      "L'Instruction générale 45-106 précise l'interprétation administrative du Règlement 45-106 sans force contraignante.",
    ],
    ["v-1.1-r.21", "v-1.1", "reglement-de", "auto", 1, 1, null],
  ];
  for (const [from, to, relType, source, weight, inCorpus, note] of relations) {
    await d
      .prepare(
        `INSERT INTO law_relations (
           from_law_id, to_law_id, rel_type, source, weight, in_corpus, note
         ) VALUES (?,?,?,?,?,?,?)`,
      )
      .bind(from, to, relType, source, weight, inCorpus, note)
      .run();
  }

  await d.prepare("INSERT INTO articles_fts(articles_fts) VALUES('rebuild')").run();
  await d
    .prepare("INSERT INTO articles_fts(articles_fts, rank) VALUES('integrity-check', 1)")
    .run();
}

beforeAll(seedCorpus);

beforeEach(() => {
  reinitialiserQuarantaineIpPourTests();
});

function proseOf(res: McpToolResult): string {
  return res.content.map((c) => c.text).join("\n");
}

describe("Tier 1 — F1: Schema 0007_pdf_corpus.sql & PDF_CORPUS Gate", () => {
  it("T1-F1.1: migrations add laws.source and articles.links while keeping articles_fts text at cid=0", () => {
    expect(hasSourceCol).toBe(true);
    expect(hasLinksCol).toBe(true);
    expect(articleFtsColumns.find((c) => c.name === "text")?.cid).toBe(0);
  });

  it("T1-F1.2: PDF_CORPUS='0' hides all source='pdf' laws from list_laws while PDF_CORPUS='1' exposes all 9", async () => {
    const rClosed = await callMcp(makeTestEnv({ pdfCorpus: "0" }), "list_laws", {});
    expect(rClosed.status).toBe(200);
    expect(rClosed.result.isError).toBeUndefined();
    const scClosed = rClosed.result.structuredContent as {
      count: number;
      laws: Array<{ id: string; source?: string }>;
    };
    expect(scClosed.count).toBe(4);
    expect(scClosed.laws.map((l) => l.id).sort()).toEqual(["ccq", "cpc", "v-1.1", "v-1.1-r.21"]);

    const rOpen = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "list_laws", {});
    expect(rOpen.status).toBe(200);
    const scOpen = rOpen.result.structuredContent as {
      count: number;
      laws: Array<{ id: string }>;
    };
    expect(scOpen.count).toBe(9);
    const openIds = scOpen.laws.map((l) => l.id);
    expect(openIds).toContain("qccs-mtl-directives");
    expect(openIds).toContain("qccs-qc-directives");
    expect(openIds).toContain("qccq-civil");
    expect(openIds).toContain("qcca-avis");
    expect(openIds).toContain("amf-ig-45-106");
    expect(openIds).toContain("v-1.1-r.21");
  });

  it("T1-F1.3: PDF_CORPUS='0' blocks get_article, get_articles, get_structure, and get_division on PDF laws", async () => {
    const env0 = makeTestEnv({ pdfCorpus: "0" });
    const artRes = await callMcp(env0, "get_article", {
      law: "qccs-mtl-directives",
      article: "12",
    });
    expect(artRes.result.isError).toBe(true);
    expect(proseOf(artRes.result)).not.toContain("onglets numérotés");

    const rangeRes = await callMcp(env0, "get_articles", {
      law: "amf-ig-45-106",
      from: "1.1",
      to: "10.1",
    });
    expect(rangeRes.result.isError).toBe(true);

    const structRes = await callMcp(env0, "get_structure", {
      law: "qccs-mtl-directives",
    });
    expect(structRes.result.isError).toBe(true);

    const divRes = await callMcp(env0, "get_division", {
      law: "qcca-avis",
      path: "ps:1",
    });
    expect(divRes.result.isError).toBe(true);
  });

  it("T1-F1.4: PDF_CORPUS='0' excludes PDF hits from search_text across both FTS5 and Vectorize", async () => {
    const vectorMatches: VectorMatchMock[] = [
      {
        id: "art:qccs-mtl-directives:12",
        score: 0.91,
        metadata: {
          type: "article",
          law: "qccs-mtl-directives",
          article: "12",
          path: "ph1:1-ph2:1",
          heading: "MONTAGE DU CAHIER D'AUDIENCE",
        },
      },
      {
        id: "div:amf-ig-45-106:abcd",
        score: 0.88,
        metadata: {
          type: "division",
          law: "amf-ig-45-106",
          path: "ph1:2",
          heading: "DISPENSES DE PROSPECTUS",
        },
      },
      {
        id: "art:cpc:490",
        score: 0.7,
        metadata: {
          type: "article",
          law: "cpc",
          article: "490",
          path: "ga:l_v-gb:l_iv",
          heading: "DEMANDES CIVILES",
        },
      },
    ];
    const rClosed = await callMcp(makeTestEnv({ pdfCorpus: "0", vectorMatches }), "search_text", {
      query: "demande civile greffe",
    });
    expect(rClosed.result.isError).toBeUndefined();
    const scClosed = rClosed.result.structuredContent as {
      results: Array<{ law_id: string }>;
      divisions_semantiques: Array<{ law_id: string }>;
    };
    expect(scClosed.results.every((h) => h.law_id !== "qccs-mtl-directives")).toBe(true);
    expect(scClosed.divisions_semantiques.every((d) => d.law_id !== "amf-ig-45-106")).toBe(true);

    const rOpen = await callMcp(makeTestEnv({ pdfCorpus: "1", vectorMatches }), "search_text", {
      query: "montage cahier audience greffe",
    });
    const scOpen = rOpen.result.structuredContent as {
      results: Array<{ law_id: string }>;
    };
    expect(scOpen.results.some((h) => h.law_id === "qccs-mtl-directives")).toBe(true);
  });

  it("T1-F1.5: PDF_CORPUS='0' excludes PDF laws from related_laws, find_relevant, and resolve_reference", async () => {
    const env0 = makeTestEnv({ pdfCorpus: "0" });
    const rel = await callMcp(env0, "related_laws", { law: "cpc" });
    if (!rel.result.isError) {
      const relSc = rel.result.structuredContent as {
        relations?: Array<{ other_id: string }>;
      };
      expect((relSc.relations ?? []).some((e) => e.other_id.startsWith("qcc"))).toBe(false);
    } else {
      expect(rel.result.isError).toBe(true);
    }

    const find = await callMcp(env0, "find_relevant", {
      query: "dispense prospectus investisseur qualifie",
    });
    const findSc = find.result.structuredContent as {
      candidates: Array<{ law: string }>;
    };
    expect(findSc.candidates.some((c) => c.law === "amf-ig-45-106")).toBe(false);
    expect(findSc.candidates.some((c) => c.law === "v-1.1-r.21")).toBe(true);

    const resRef = await callMcp(env0, "resolve_reference", {
      citation: "IG 45-106, art. 2A.1",
    });
    expect(resRef.result.isError).toBe(true);
  });

  it("T1-F1.6: GET / reflects PDF_CORPUS='0' (4 laws) vs '1' (9 laws) in live HTML counts and table rows", async () => {
    const p0 = await getHomePage(makeTestEnv({ pdfCorpus: "0" }));
    expect(p0.status).toBe(200);
    expect(p0.html).not.toContain('data-law-id="qccs-mtl-directives"');
    expect(p0.html).toContain('data-law-id="v-1.1-r.21"');
    expect((p0.html.match(/data-law-id="/g) ?? []).length).toBe(4);

    const p1 = await getHomePage(makeTestEnv({ pdfCorpus: "1" }));
    expect(p1.status).toBe(200);
    expect(p1.html).toContain('data-law-id="qccs-mtl-directives"');
    expect(p1.html).toContain('data-law-id="amf-ig-45-106"');
    expect((p1.html.match(/data-law-id="/g) ?? []).length).toBe(9);
  });
});

describe("Tier 1 — F2: source='pdf' & fonction ('directive'/'orientation') Rendering", () => {
  it("T1-F2.1: list_laws filters fonction='directive' (4 PDFs) and fonction='orientation' (amf-ig-45-106)", async () => {
    const env1 = makeTestEnv({ pdfCorpus: "1" });
    const dirRes = await callMcp(env1, "list_laws", { fonction: "directive" });
    expect(dirRes.result.isError).toBeUndefined();
    const dirSc = dirRes.result.structuredContent as {
      count: number;
      laws: Array<{ id: string; fonction: string }>;
    };
    expect(dirSc.count).toBe(4);
    expect(dirSc.laws.every((l) => l.fonction === "directive")).toBe(true);
    expect(dirSc.laws.map((l) => l.id).sort()).toEqual([
      "qcca-avis",
      "qccq-civil",
      "qccs-mtl-directives",
      "qccs-qc-directives",
    ]);

    const oriRes = await callMcp(env1, "list_laws", { fonction: "orientation" });
    expect(oriRes.result.isError).toBeUndefined();
    const oriSc = oriRes.result.structuredContent as {
      count: number;
      laws: Array<{ id: string; fonction: string }>;
    };
    expect(oriSc.count).toBe(1);
    expect(oriSc.laws[0]?.id).toBe("amf-ig-45-106");
    expect(oriSc.laws[0]?.fonction).toBe("orientation");
  });

  it("T1-F2.2: get_article formats directive unit='paragraphe' as par. in FR and para. in EN", async () => {
    const env1 = makeTestEnv({ pdfCorpus: "1" });
    const fr = await callMcp(env1, "get_article", {
      law: "qccs-mtl-directives",
      article: "12",
      lang: "fr",
    });
    expect(fr.result.isError).toBeUndefined();
    const frSc = fr.result.structuredContent as { citation: string };
    expect(frSc.citation).toMatch(/\bpar\.\s*12\b/);
    expect(proseOf(fr.result)).toMatch(/\bpar\.\s*12\b/);

    const en = await callMcp(env1, "get_article", {
      law: "qccs-mtl-directives",
      article: "12",
      lang: "en",
    });
    expect(en.result.isError).toBeUndefined();
    const enSc = en.result.structuredContent as { citation: string };
    expect(enSc.citation).toMatch(/\bpara\.\s*12\b/);
    expect(proseOf(en.result)).toMatch(/\bpara\.\s*12\b/);
  });

  it("T1-F2.3: get_article formats orientation unit='article' as art. in FR and s. in EN", async () => {
    const env1 = makeTestEnv({ pdfCorpus: "1" });
    const fr = await callMcp(env1, "get_article", {
      law: "amf-ig-45-106",
      article: "2A.1",
      lang: "fr",
    });
    expect(fr.result.isError).toBeUndefined();
    expect((fr.result.structuredContent as { citation: string }).citation).toMatch(
      /\bart\.\s*2A\.1\b/,
    );
    expect(proseOf(fr.result)).toMatch(/\bart\.\s*2A\.1\b/);

    const en = await callMcp(env1, "get_article", {
      law: "amf-ig-45-106",
      article: "2A.1",
      lang: "en",
    });
    expect(en.result.isError).toBeUndefined();
    expect((en.result.structuredContent as { citation: string }).citation).toMatch(
      /\bs\.\s*2A\.1\b/,
    );
    expect(proseOf(en.result)).toMatch(/\bs\.\s*2A\.1\b/);
  });

  it("T1-F2.4: get_article and get_division on PDF directive/orientation expose normative status in prose and structuredContent", async () => {
    const env1 = makeTestEnv({ pdfCorpus: "1" });
    const artRes = await callMcp(env1, "get_article", {
      law: "qccs-mtl-directives",
      article: "12",
    });
    const artSc = artRes.result.structuredContent as Record<string, unknown>;
    expect(artSc.source).toBe("pdf");
    expect(artSc.fonction).toBe("directive");
    expect(proseOf(artRes.result)).toMatch(
      /non[- ]?l[ée]gislati|non[- ]?contraignant|valeur (?:indicative|administrative)|pratique judiciaire|directive de pratique|sans force de loi|non[- ]?binding|no force of law/i,
    );

    const divRes = await callMcp(env1, "get_division", {
      law: "amf-ig-45-106",
      path: "ph1:2",
    });
    const divSc = divRes.result.structuredContent as Record<string, unknown>;
    expect(divSc.source).toBe("pdf");
    expect(divSc.fonction).toBe("orientation");
    expect(proseOf(divRes.result)).toMatch(
      /non[- ]?l[ée]gislati|non[- ]?contraignant|valeur (?:indicative|administrative)|pratique judiciaire|directive de pratique|sans force de loi|non[- ]?binding|no force of law/i,
    );
  });

  it("T1-F2.5: search_text surfaces normative status for PDF hits in both prose and structuredContent", async () => {
    const res = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "search_text", {
      query: "montage cahier audience",
    });
    expect(res.result.isError).toBeUndefined();
    const sc = res.result.structuredContent as {
      results: Array<Record<string, unknown>>;
    };
    const mtlHit = sc.results.find((r) => r.law_id === "qccs-mtl-directives");
    expect(mtlHit).toBeDefined();
    expect(mtlHit?.source).toBe("pdf");
    expect(mtlHit?.fonction).toBe("directive");
    expect(proseOf(res.result)).toMatch(
      /non[- ]?l[ée]gislati|non[- ]?contraignant|valeur (?:indicative|administrative)|pratique judiciaire|directive de pratique|sans force de loi|non[- ]?binding|no force of law/i,
    );
  });
});

describe("Tier 1 — F3: articles.links Rendering & kind='annexe' Pseudo-Articles", () => {
  it("T1-F3.1: get_article on qccs-mtl-directives annexe-1 renders links footer and structuredContent.links", async () => {
    const res = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "get_article", {
      law: "qccs-mtl-directives",
      article: "annexe-1",
    });
    expect(res.result.isError).toBeUndefined();
    const sc = res.result.structuredContent as {
      links?: Array<{ label: string; url: string }>;
    };
    expect(sc.links).toEqual([
      {
        label: "Formulaire PDF officiel",
        url: "https://coursuperieureduquebec.ca/formulaire-montage.pdf",
      },
    ]);
    const text = proseOf(res.result);
    expect(text).toContain("Formulaire PDF officiel");
    expect(text).toContain("https://coursuperieureduquebec.ca/formulaire-montage.pdf");
  });

  it("T1-F3.2: get_article on qcca-avis annexe-a renders multiple links in prose and structuredContent", async () => {
    const res = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "get_article", {
      law: "qcca-avis",
      article: "annexe-a",
    });
    expect(res.result.isError).toBeUndefined();
    const sc = res.result.structuredContent as {
      links?: Array<{ label: string; url: string }>;
    };
    expect(sc.links).toHaveLength(2);
    const text = proseOf(res.result);
    expect(text).toContain("Aide-mémoire officiel C.A.");
    expect(text).toContain("https://courdappelduquebec.ca/aide-memoire.pdf");
    expect(text).toContain("Gabarit de mémoire");
    expect(text).toContain("https://courdappelduquebec.ca/gabarit.docx");
  });

  it("T1-F3.3: get_division on ps:1 retrieves annexe pseudo-articles and surfaces links", async () => {
    const res = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "get_division", {
      law: "qcca-avis",
      path: "ps:1",
    });
    expect(res.result.isError).toBeUndefined();
    const sc = res.result.structuredContent as {
      division: { kind: string; path: string };
      articles: Array<{ number: string; links?: Array<{ label: string; url: string }> }>;
    };
    expect(sc.division.kind).toBe("annexe");
    expect(sc.division.path).toBe("ps:1");
    expect(sc.articles[0]?.number).toBe("annexe-a");
    expect(JSON.stringify(sc)).toContain("https://courdappelduquebec.ca/aide-memoire.pdf");
    expect(proseOf(res.result)).toContain("https://courdappelduquebec.ca/aide-memoire.pdf");
  });

  it("T1-F3.4: get_structure includes ps:1 annexe division alongside ph1:* body sections", async () => {
    const res = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "get_structure", {
      law: "qccs-mtl-directives",
      depth: 2,
    });
    expect(res.result.isError).toBeUndefined();
    const sc = res.result.structuredContent as {
      tree: Array<{ path: string; kind: string }>;
    };
    const paths = sc.tree.map((n) => n.path);
    expect(paths).toContain("ph1:1");
    expect(paths).toContain("ph1:10");
    expect(paths).toContain("ps:1");
    expect(sc.tree.find((n) => n.path === "ps:1")?.kind).toBe("annexe");
  });

  it("T1-F3.5: get_articles retrieves annexe-1 pseudo-article cleanly with sort_key >= DISPOSITION_SORT_BASE and links", async () => {
    expect(sortKeyOf("annexe-1")).toBeGreaterThanOrEqual(DISPOSITION_SORT_BASE);
    expect(sortKeyOf("annexe-a")).toBeGreaterThanOrEqual(DISPOSITION_SORT_BASE);
    const res = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "get_articles", {
      law: "qccs-mtl-directives",
      numbers: ["annexe-1"],
    });
    expect(res.result.isError).toBeUndefined();
    const sc = res.result.structuredContent as {
      articles: Array<{ number: string; links?: Array<{ label: string; url: string }> }>;
    };
    expect(sc.articles[0]?.number).toBe("annexe-1");
    expect(sc.articles[0]?.links).toEqual([
      {
        label: "Formulaire PDF officiel",
        url: "https://coursuperieureduquebec.ca/formulaire-montage.pdf",
      },
    ]);
    const text = proseOf(res.result);
    expect(text).toContain("Formulaire de déclaration commune");
    expect(text).toContain("https://coursuperieureduquebec.ca/formulaire-montage.pdf");
  });
});

describe("Tier 1 — F4: Precedence & Interpretation (preseance-sur / interprete)", () => {
  it("T1-F4.1: related_laws on qccs-mtl-directives exposes preseance-sur edge toward cpc", async () => {
    const res = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "related_laws", {
      law: "qccs-mtl-directives",
    });
    expect(res.result.isError).toBeUndefined();
    const sc = res.result.structuredContent as {
      relations: Array<{ other_id: string; rel_type: string; in_corpus: boolean }>;
    };
    expect(
      sc.relations.some(
        (r) => r.other_id === "cpc" && r.rel_type === "preseance-sur" && r.in_corpus,
      ),
    ).toBe(true);
  });

  it("T1-F4.2: related_laws on amf-ig-45-106 exposes interprete edge toward v-1.1-r.21", async () => {
    const res = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "related_laws", {
      law: "amf-ig-45-106",
    });
    expect(res.result.isError).toBeUndefined();
    const sc = res.result.structuredContent as {
      relations: Array<{ other_id: string; rel_type: string; in_corpus: boolean }>;
    };
    expect(
      sc.relations.some(
        (r) => r.other_id === "v-1.1-r.21" && r.rel_type === "interprete" && r.in_corpus,
      ),
    ).toBe(true);
  });

  it("T1-F4.3: get_article on qccs-mtl-directives surfaces active preseance-sur -> cpc pointer in prose and structuredContent", async () => {
    const res = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "get_article", {
      law: "qccs-mtl-directives",
      article: "12",
    });
    expect(res.result.isError).toBeUndefined();
    const scJson = JSON.stringify(res.result.structuredContent);
    expect(scJson).toContain("preseance-sur");
    expect(scJson).toContain("cpc");
    expect(proseOf(res.result)).toMatch(/cpc|Code de proc[ée]dure civile/i);
    expect(proseOf(res.result)).toMatch(/pr[ée]s[ée]ance|pr[ée]vaut|subordonn[ée]|d[ée]roge/i);
  });

  it("T1-F4.4: get_article and get_division on amf-ig-45-106 surface interprete -> v-1.1-r.21 pointer in prose and structuredContent", async () => {
    const env1 = makeTestEnv({ pdfCorpus: "1" });
    const art = await callMcp(env1, "get_article", {
      law: "amf-ig-45-106",
      article: "1.1",
    });
    expect(art.result.isError).toBeUndefined();
    expect(JSON.stringify(art.result.structuredContent)).toContain("interprete");
    expect(JSON.stringify(art.result.structuredContent)).toContain("v-1.1-r.21");
    expect(proseOf(art.result)).toMatch(/v-1\.1-r\.21|R[èe]glement 45-106/i);

    const div = await callMcp(env1, "get_division", {
      law: "amf-ig-45-106",
      path: "ph1:1",
    });
    expect(div.result.isError).toBeUndefined();
    expect(JSON.stringify(div.result.structuredContent)).toContain("interprete");
    expect(JSON.stringify(div.result.structuredContent)).toContain("v-1.1-r.21");
    expect(proseOf(div.result)).toMatch(/v-1\.1-r\.21|R[èe]glement 45-106/i);
  });

  it("T1-F4.5: search_text returning qccs-mtl-directives surfaces preseance-sur pointer in prose and structuredContent", async () => {
    const res = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "search_text", {
      query: "montage cahier audience",
    });
    expect(res.result.isError).toBeUndefined();
    const scJson = JSON.stringify(res.result.structuredContent);
    expect(scJson).toContain("preseance-sur");
    expect(scJson).toContain("cpc");
    expect(proseOf(res.result)).toMatch(/cpc|Code de proc[ée]dure civile/i);
  });
});

describe("Tier 1 — F5: fr-Only lang='en' Errors & Semantic [fr] Brief Fallback", () => {
  it("T1-F5.1: get_article on fr-only law with lang='en' returns explicit French-only error", async () => {
    const res = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "get_article", {
      law: "qccq-civil",
      article: "5",
      lang: "en",
    });
    expect(res.result.isError).toBe(true);
    expect(proseOf(res.result)).toMatch(/published in French only/i);
    expect(proseOf(res.result)).toMatch(/langs:\s*\['?fr'?\]|fr/i);
  });

  it("T1-F5.2: get_articles on fr-only law with lang='en' returns explicit French-only error", async () => {
    const res = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "get_articles", {
      law: "qcca-avis",
      numbers: ["1"],
      lang: "en",
    });
    expect(res.result.isError).toBe(true);
    expect(proseOf(res.result)).toMatch(/published in French only/i);
  });

  it("T1-F5.3: get_division on fr-only law with lang='en' returns explicit French-only error", async () => {
    const res = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "get_division", {
      law: "qccs-qc-directives",
      path: "ph1:1",
      lang: "en",
    });
    expect(res.result.isError).toBe(true);
    expect(proseOf(res.result)).toMatch(/published in French only/i);
  });

  it("T1-F5.4: get_structure on fr-only law with lang='en' returns explicit French-only error", async () => {
    const res = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "get_structure", {
      law: "qccq-civil",
      lang: "en",
    });
    expect(res.result.isError).toBe(true);
    expect(proseOf(res.result)).toMatch(/published in French only/i);
  });

  it("T1-F5.5: resolve_reference lang='en' on fr-only law errors explicitly, while semantic search_text tags [fr] brief", async () => {
    const envFrOnly = makeTestEnv({
      pdfCorpus: "1",
      vectorMatches: [
        {
          id: "art:qccq-civil:5",
          score: 0.78,
          metadata: {
            type: "article",
            law: "qccq-civil",
            article: "5",
            path: "ph1:1",
            heading: "CHAMBRE CIVILE ET PETITES CRÉANCES",
          },
        },
      ],
    });
    const refRes = await callMcp(envFrOnly, "resolve_reference", {
      citation: "Directives C.Q., par. 5",
      lang: "en",
    });
    expect(refRes.result.isError).toBe(true);
    expect(proseOf(refRes.result)).toMatch(/published in French only/i);

    const searchRes = await callMcp(envFrOnly, "search_text", {
      query: "provisional roll notice civil court",
      lang: "en",
    });
    expect(searchRes.result.isError).toBeUndefined();
    const sc = searchRes.result.structuredContent as {
      results: Array<{ law_id: string; number: string; snippet: string; semantic?: boolean }>;
    };
    const hit = sc.results.find((r) => r.law_id === "qccq-civil" && r.number === "5");
    expect(hit).toBeDefined();
    expect(hit?.semantic).toBe(true);
    expect(proseOf(searchRes.result)).toContain("[fr]");
  });
});

describe("Tier 1 — F6: resolve_reference Disambiguation", () => {
  it("T1-F6.1: resolve_reference resolves 'Directives C.S. Montréal (2026), par. 12' to qccs-mtl-directives", async () => {
    const res = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "resolve_reference", {
      citation: "Directives C.S. Montréal (2026), par. 12",
    });
    expect(res.result.isError).toBeUndefined();
    const sc = res.result.structuredContent as {
      resolved: { law: string; number: string };
      citation: string;
    };
    expect(sc.resolved.law).toBe("qccs-mtl-directives");
    expect(sc.resolved.number).toBe("12");
    expect(sc.citation).toMatch(/\bpar\.\s*12\b/);
    expect(proseOf(res.result)).toMatch(/\bpar\.\s*12\b/);
  });

  it("T1-F6.2: resolve_reference refuses ambiguous 'Directives C.S., par. 12' across Montréal & Québec", async () => {
    const res = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "resolve_reference", {
      citation: "Directives C.S., par. 12",
    });
    expect(res.result.isError).toBe(true);
    const text = proseOf(res.result);
    expect(text).toMatch(/ambigu|plusieurs|précis/i);
    expect(text).toMatch(/qccs-mtl-directives|Montréal/i);
    expect(text).toMatch(/qccs-qc-directives|Québec/i);
  });

  it("T1-F6.3: resolve_reference resolves 'Règlement 45-106, art. 2.3' strictly to EPUB v-1.1-r.21", async () => {
    const res = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "resolve_reference", {
      citation: "Règlement 45-106, art. 2.3",
    });
    expect(res.result.isError).toBeUndefined();
    const sc = res.result.structuredContent as {
      resolved: { law: string; number: string };
    };
    expect(sc.resolved.law).toBe("v-1.1-r.21");
    expect(sc.resolved.number).toBe("2.3");
  });

  it("T1-F6.4: resolve_reference resolves 'IG 45-106, art. 4B.2' strictly to amf-ig-45-106 with hint to v-1.1-r.21", async () => {
    const res = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "resolve_reference", {
      citation: "IG 45-106, art. 4B.2",
    });
    expect(res.result.isError).toBeUndefined();
    const sc = res.result.structuredContent as {
      resolved: { law: string; number: string };
    };
    expect(sc.resolved.law).toBe("amf-ig-45-106");
    expect(sc.resolved.number).toBe("4B.2");
    expect(proseOf(res.result)).toMatch(/v-1\.1-r\.21|R[èe]glement 45-106/i);
    expect(JSON.stringify(res.result.structuredContent)).toContain("v-1.1-r.21");
  });

  it("T1-F6.5: resolve_reference supports par./dir. notation for court directives", async () => {
    const res = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "resolve_reference", {
      citation: "dir. C.Q., par. 5",
    });
    expect(res.result.isError).toBeUndefined();
    const sc = res.result.structuredContent as {
      resolved: { law: string; number: string };
    };
    expect(sc.resolved.law).toBe("qccq-civil");
    expect(sc.resolved.number).toBe("5");
  });
});

describe("Tier 1 — F7: Alphanumeric sortKeyOf, Positional Paths & Vectorize <= 64B IDs", () => {
  it("T1-F7.1: sortKeyOf orders numeric and alphanumeric CSA/AMF sections strictly below DISPOSITION_SORT_BASE", () => {
    const keys = ["1.1", "1.1.1", "1.1.1A", "1.2", "2.1", "2A", "2A.1", "4B.2", "10.1"].map((n) =>
      sortKeyOf(n),
    );
    for (let i = 1; i < keys.length; i++) {
      expect(keys[i], `sortKeyOf order at index ${i}`).toBeGreaterThan(keys[i - 1]);
    }
    for (const k of keys) {
      expect(k).toBeLessThan(DISPOSITION_SORT_BASE);
    }
    expect(sortKeyOf("annexe-1")).toBeGreaterThanOrEqual(DISPOSITION_SORT_BASE);
    expect(sortKeyOf("annexe-a")).toBeGreaterThanOrEqual(DISPOSITION_SORT_BASE);
  });

  it("T1-F7.2: get_articles(from='2.1', to='4B.2') returns alphanumeric range in document order excluding annexe-a", async () => {
    const res = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "get_articles", {
      law: "amf-ig-45-106",
      from: "2.1",
      to: "4B.2",
    });
    expect(res.result.isError).toBeUndefined();
    const sc = res.result.structuredContent as {
      range_resolution: string;
      articles: Array<{ number: string }>;
    };
    expect(sc.range_resolution).toBe("document");
    expect(sc.articles.map((a) => a.number)).toEqual(["2.1", "2A.1", "4B.2"]);
  });

  it("T1-F7.3: get_division(path='ph1:1') captures ph1:1 subtree while isolating ph1:10 and ps:1", async () => {
    const res = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "get_division", {
      law: "qccs-mtl-directives",
      path: "ph1:1",
    });
    expect(res.result.isError).toBeUndefined();
    const sc = res.result.structuredContent as {
      articles: Array<{ number: string; division_path: string }>;
    };
    const nums = sc.articles.map((a) => a.number);
    expect(nums).toEqual(["1", "12", "12.1", "13"]);
    expect(nums).not.toContain("45");
    expect(nums).not.toContain("annexe-1");
  });

  it("T1-F7.4: handleBackfill divisions generates <= 64-byte hashed Vectorize IDs and embeds full ph1:1..ph9:1 ancestors", async () => {
    expect(new TextEncoder().encode(`div:qccs-mtl-directives:${DEEP_PATH}`).length).toBeGreaterThan(
      64,
    );
    const upserted: Array<{ id: string; values: number[]; metadata?: Record<string, unknown> }> =
      [];
    const embeddedTexts: string[] = [];
    const back = await postBackfill(
      makeTestEnv({
        pdfCorpus: "1",
        upserted,
        onAiRun: (texts) => embeddedTexts.push(...texts),
      }),
      {
        kind: "divisions",
        law: "qccs-mtl-directives",
      },
    );
    expect(back.status).toBe(200);
    expect(back.json.done).toBe(true);
    expect(upserted.length).toBeGreaterThanOrEqual(11);
    for (const v of upserted) {
      expect(new TextEncoder().encode(v.id).length).toBeLessThanOrEqual(64);
    }
    const deepIdx = upserted.findIndex((v) => v.metadata?.path === DEEP_PATH);
    expect(deepIdx).toBeGreaterThanOrEqual(0);
    const deepVec = upserted[deepIdx];
    expect(deepVec?.id).toMatch(/^div:qccs-mtl-directives:[0-9a-f]{24}$/);
    const deepText = embeddedTexts[deepIdx] ?? "";
    expect(deepText).toContain("DEMANDES CIVILES ET GESTION D'INSTANCE");
    expect(deepText).toContain("MONTAGE DU CAHIER D'AUDIENCE");
    expect(deepText).toContain("NIVEAU 3");
    expect(deepText).toContain("NIVEAU 8");
    expect(deepText).toContain("SOUS-DIVISIONS PROFONDES DE GESTION");
  });

  it("T1-F7.5: handleBackfill articles preserves alphanumeric numbers (2A.1, 4B.2) within <= 64-byte IDs", async () => {
    const upserted: Array<{ id: string; values: number[]; metadata?: Record<string, unknown> }> =
      [];
    const back = await postBackfill(makeTestEnv({ pdfCorpus: "1", upserted }), {
      kind: "articles",
      law: "amf-ig-45-106",
    });
    expect(back.status).toBe(200);
    const ids = upserted.map((v) => v.id);
    expect(ids).toContain("art:amf-ig-45-106:2A.1");
    expect(ids).toContain("art:amf-ig-45-106:4B.2");
    for (const id of ids) {
      expect(new TextEncoder().encode(id).length).toBeLessThanOrEqual(64);
    }
  });
});

describe("Tier 1 — F8: Search Calibration, Normative Weight & Repeals", () => {
  it("T1-F8.1: find_relevant ranks cpc strictly ahead of directive qccs-mtl-directives under equal token overlap via normative weight < 1.0", async () => {
    const res = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "find_relevant", {
      query: "greffe",
    });
    expect(res.result.isError).toBeUndefined();
    const sc = res.result.structuredContent as {
      candidates: Array<{ law: string; score: number }>;
    };
    const cpcCand = sc.candidates.find((c) => c.law === "cpc");
    const mtlCand = sc.candidates.find((c) => c.law === "qccs-mtl-directives");
    expect(cpcCand).toBeDefined();
    expect(mtlCand).toBeDefined();
    expect(cpcCand!.score).toBeGreaterThan(mtlCand!.score);
  });

  it("T1-F8.2: find_relevant ranks v-1.1 / v-1.1-r.21 ahead of orientation amf-ig-45-106", async () => {
    const res = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "find_relevant", {
      query: "dispense prospectus investisseur qualifie valeurs mobilieres",
    });
    expect(res.result.isError).toBeUndefined();
    const sc = res.result.structuredContent as {
      candidates: Array<{ law: string; score: number }>;
    };
    const regCand = sc.candidates.find((c) => c.law === "v-1.1-r.21");
    const igCand = sc.candidates.find((c) => c.law === "amf-ig-45-106");
    expect(regCand).toBeDefined();
    expect(igCand).toBeDefined();
    expect(regCand!.score).toBeGreaterThan(igCand!.score);
  });

  it("T1-F8.3: search_text applies per-fonction cap (<= 3 directives at limit=10) so directives do not displace cpc", async () => {
    const res = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "search_text", {
      query: "demande civile greffe",
      limit: 10,
    });
    expect(res.result.isError).toBeUndefined();
    const sc = res.result.structuredContent as {
      results: Array<{ law_id: string }>;
    };
    expect(sc.results[0]?.law_id).toBe("cpc");
    const directiveLaws = new Set([
      "qccs-mtl-directives",
      "qccs-qc-directives",
      "qccq-civil",
      "qcca-avis",
    ]);
    const directiveCount = sc.results.filter((r) => directiveLaws.has(r.law_id)).length;
    expect(directiveCount).toBeLessThanOrEqual(3);
  });

  it("T1-F8.4: repealed=1 directives ('Abrogé.' and '[…]') preserve verbatim text, repealed=true, and history", async () => {
    const env1 = makeTestEnv({ pdfCorpus: "1" });
    const rAbroge = await callMcp(env1, "get_article", {
      law: "qccs-mtl-directives",
      article: "13",
    });
    const scAbroge = rAbroge.result.structuredContent as {
      repealed: boolean;
      text: string;
      history: string | null;
    };
    expect(scAbroge.repealed).toBe(true);
    expect(scAbroge.text).toBe("Abrogé.");
    expect(scAbroge.history).toContain("abrogée le 23 février 2026");

    const rEllipsis = await callMcp(env1, "get_article", {
      law: "qccq-civil",
      article: "6",
    });
    const scEllipsis = rEllipsis.result.structuredContent as {
      repealed: boolean;
      text: string;
      history: string | null;
    };
    expect(scEllipsis.repealed).toBe(true);
    expect(scEllipsis.text).toBe("[…]");
    expect(scEllipsis.history).toContain("paragraphe retranché");
  });

  it("T1-F8.5: search_text on 'vice caché garantie' preserves ccq 1726 at rank #1 without PDF displacement", async () => {
    const res = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "search_text", {
      query: "vices cachés garantie",
    });
    expect(res.result.isError).toBeUndefined();
    const sc = res.result.structuredContent as {
      results: Array<{ law_id: string; number: string }>;
    };
    expect(sc.results[0]?.law_id).toBe("ccq");
    expect(sc.results[0]?.number).toBe("1726");
  });
});

describe("Tier 1 — F9: Public Site GET / Counts, FONCTION & Provenance", () => {
  it("T1-F9.1: GET / with PDF_CORPUS='0' renders 4 laws and EPUB-only article count in .chiffres", async () => {
    const { status, html } = await getHomePage(makeTestEnv({ pdfCorpus: "0" }));
    expect(status).toBe(200);
    expect(html).toMatch(/<section class="chiffres">[\s\S]*?<div><b>4<\/b>/);
    expect(html).toMatch(/<div><b>18<\/b><span data-l="fr">articles/);
  });

  it("T1-F9.2: GET / with PDF_CORPUS='1' renders 9 laws and full article count including PDFs", async () => {
    const { status, html } = await getHomePage(makeTestEnv({ pdfCorpus: "1" }));
    expect(status).toBe(200);
    expect(html).toMatch(/<section class="chiffres">[\s\S]*?<div><b>9<\/b>/);
    const totalSeededArticles = buildArticles().length;
    expect(html).toMatch(
      new RegExp(`<div><b>${totalSeededArticles}<\\/b><span data-l="fr">articles`),
    );
  });

  it("T1-F9.3: GET / <select id='f'> and FONCTION table expose localized directive and orientation labels", async () => {
    const { html } = await getHomePage(makeTestEnv({ pdfCorpus: "1" }));
    expect(html).toContain('<option value="directive">');
    expect(html).toContain('<option value="orientation">');

    const dirRow = html.match(/<tr data-law-id="qccs-mtl-directives"[^>]*>[\s\S]*?<\/tr>/)?.[0];
    expect(dirRow).toBeDefined();
    expect(dirRow).toContain('data-f="directive"');
    expect(dirRow).not.toContain(">directive<");
    expect(dirRow).toMatch(
      /<span data-l="fr">[^<]*(?:Directive|Pratique)[^<]*<\/span><span data-l="en" lang="en">[^<]*(?:Directive|Practice directive)[^<]*<\/span>/i,
    );

    const oriRow = html.match(/<tr data-law-id="amf-ig-45-106"[^>]*>[\s\S]*?<\/tr>/)?.[0];
    expect(oriRow).toBeDefined();
    expect(oriRow).toContain('data-f="orientation"');
    expect(oriRow).not.toContain(">orientation<");
    expect(oriRow).toMatch(
      /<span data-l="fr">[^<]*(?:Instruction g[ée]n[ée]rale|Orientation)[^<]*<\/span><span data-l="en" lang="en">[^<]*(?:Policy statement|Guidance|Orientation)[^<]*<\/span>/i,
    );
  });

  it("T1-F9.4: GET / renders calibration constants from relevance.ts and never leaks MCP_TOKEN", async () => {
    const { html } = await getHomePage(makeTestEnv({ pdfCorpus: "1" }));
    expect(html).not.toContain(MCP_TOKEN);
    expect(html).not.toContain(BACKFILL_TOKEN);
    expect(html).toContain('class="cal"');
    expect(html).toContain("<b>0.4</b>");
    expect(html).toContain("k&nbsp;=&nbsp;60");
  });

  it("T1-F9.5: GET / header and footer disclose PDF court/AMF sources alongside EPUB and LIMS", async () => {
    const { html } = await getHomePage(makeTestEnv({ pdfCorpus: "1" }));
    const header = html.match(/<header>[\s\S]*?<\/header>/)?.[0] ?? "";
    const footer = html.match(/<footer>[\s\S]*?<\/footer>/)?.[0] ?? "";
    expect(header.length).toBeGreaterThan(0);
    expect(footer.length).toBeGreaterThan(0);

    for (const section of [header, footer]) {
      expect(section).toMatch(/L[ée]gisQu[ée]bec/i);
      expect(section).toMatch(/Justice/i);
      expect(section).toMatch(
        /\bPDF\b|directives?|tribunaux|Cour sup[ée]rieure|cours? du Qu[ée]bec/i,
      );
      expect(section).toMatch(
        /AMF|Autorit[ée] des march[ée]s financiers|instructions? g[ée]n[ée]rales?/i,
      );
    }
  });
});

describe("Tier 2 — Boundary & Corner Cases (F1–F9)", () => {
  it("T2-F1.1: PDF_CORPUS unset, '0', 'false', and 'true' all stay closed; only '1' opens", async () => {
    for (const val of [undefined, "", "0", "false", "true"]) {
      const r = await callMcp(makeTestEnv({ pdfCorpus: val }), "list_laws", {});
      const sc = r.result.structuredContent as { count: number };
      expect(sc.count, `PDF_CORPUS=${String(val)} must stay closed`).toBe(4);
    }
    const rOpen = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "list_laws", {});
    expect((rOpen.result.structuredContent as { count: number }).count).toBe(9);
  });

  it("T2-F1.2: search_text with explicit law='qccs-mtl-directives' under PDF_CORPUS='0' refuses without widening", async () => {
    const r = await callMcp(makeTestEnv({ pdfCorpus: "0" }), "search_text", {
      query: "montage",
      law: "qccs-mtl-directives",
    });
    expect(r.result.isError).toBe(true);
    expect(proseOf(r.result)).toContain("inconnue");
  });

  it("T2-F1.3: PDF_CORPUS='0' filters out Vectorize division-only matches for PDF laws", async () => {
    const r = await callMcp(
      makeTestEnv({
        pdfCorpus: "0",
        vectorMatches: [
          {
            id: "div:qcca-avis:ps1",
            score: 0.92,
            metadata: {
              type: "division",
              law: "qcca-avis",
              path: "ps:1",
              heading: "AIDE-MÉMOIRE",
            },
          },
          {
            id: "art:cpc:145",
            score: 0.6,
            metadata: {
              type: "article",
              law: "cpc",
              article: "145",
              path: "ga:l_v-gb:l_iv",
              heading: "DEMANDES CIVILES",
            },
          },
        ],
      }),
      "search_text",
      { query: "demande civile greffe" },
    );
    const sc = r.result.structuredContent as {
      divisions_semantiques: Array<{ law_id: string }>;
    };
    expect(sc.divisions_semantiques).toEqual([]);
  });

  it("T2-F1.4: related_laws(law='cpc', direction='in') hides PDF preseance-sur edges when PDF_CORPUS='0'", async () => {
    const r = await callMcp(makeTestEnv({ pdfCorpus: "0" }), "related_laws", {
      law: "cpc",
      direction: "in",
    });
    if (!r.result.isError) {
      const sc = r.result.structuredContent as {
        relations: Array<{ other_id: string }>;
      };
      expect(sc.relations.some((e) => e.other_id.startsWith("qcc"))).toBe(false);
    } else {
      expect(r.result.isError).toBe(true);
    }
  });

  it("T2-F1.5: PDF_CORPUS='0' keeps paired EPUB v-1.1-r.21 resolvable while hiding amf-ig-45-106", async () => {
    const env0 = makeTestEnv({ pdfCorpus: "0" });
    const reg = await callMcp(env0, "resolve_reference", {
      citation: "RLRQ, c. V-1.1, r. 21, art. 2.3",
    });
    expect(reg.result.isError).toBeUndefined();
    expect((reg.result.structuredContent as { resolved: { law: string } }).resolved.law).toBe(
      "v-1.1-r.21",
    );
    const ig = await callMcp(env0, "resolve_reference", { citation: "IG 45-106, art. 2A.1" });
    expect(ig.result.isError).toBe(true);
  });

  it("T2-F2.1: list_laws with fonction='directive' and forum='Cour du Québec' narrows strictly to qccq-civil", async () => {
    const r = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "list_laws", {
      fonction: "directive",
      forum: "Cour du Québec",
    });
    expect(r.result.isError).toBeUndefined();
    const sc = r.result.structuredContent as { laws: Array<{ id: string }> };
    expect(sc.laws.map((l) => l.id)).toEqual(["qccq-civil"]);
  });

  it("T2-F2.2: list_laws with unknown fonction returns isError: true", async () => {
    const r = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "list_laws", {
      fonction: "circulaire-inexistante",
    });
    expect(r.result.isError).toBe(true);
  });

  it("T2-F2.3: get_article on EPUB loi (ccq 1457) emits no directive/orientation warning or links footer", async () => {
    const r = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "get_article", {
      law: "ccq",
      article: "1457",
    });
    expect(r.result.isError).toBeUndefined();
    const sc = r.result.structuredContent as Record<string, unknown>;
    expect(sc.links ?? []).toEqual([]);
    expect(proseOf(r.result)).not.toMatch(/Liens|Links|non[- ]?l[ée]gislati/i);
  });

  it("T2-F2.4: get_articles range on directive law formats paragraphs cleanly with par. in prose", async () => {
    const r = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "get_articles", {
      law: "qccs-mtl-directives",
      from: "1",
      to: "12",
    });
    expect(r.result.isError).toBeUndefined();
    const sc = r.result.structuredContent as { articles: Array<{ number: string }> };
    expect(sc.articles.map((a) => a.number)).toEqual(["1", "12"]);
    const text = proseOf(r.result);
    expect(text).toMatch(/\bpar\.\s*1\b/);
    expect(text).toMatch(/\bpar\.\s*12\b/);
    expect(text).not.toMatch(/\bart\.\s*(?:1|12)\b/);
  });

  it("T2-F2.5: bilingual directive citation in lang='en' uses official_cite_en + para. in prose and structuredContent", async () => {
    const r = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "get_article", {
      law: "qccs-mtl-directives",
      article: "12",
      lang: "en",
    });
    const sc = r.result.structuredContent as { citation: string };
    expect(sc.citation).toBe("S.C. Directives Montréal, para. 12");
    const text = proseOf(r.result);
    expect(text).toContain("S.C. Directives Montréal, para. 12");
    expect(text).not.toMatch(/\bpar\.\s*12\b/);
  });

  it("T2-F3.1: empty JSON array articles.links ('[]') emits no empty links footer", async () => {
    const r = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "get_article", {
      law: "qccs-qc-directives",
      article: "12",
    });
    expect(r.result.isError).toBeUndefined();
    const sc = r.result.structuredContent as { links?: unknown[] };
    expect(sc.links ?? []).toEqual([]);
    expect(proseOf(r.result)).not.toMatch(/\nLiens\s*:/i);
  });

  it("T2-F3.2: NULL articles.links handles cleanly without JSON.parse error or empty footer", async () => {
    const r = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "get_article", {
      law: "qccq-civil",
      article: "5",
    });
    expect(r.result.isError).toBeUndefined();
    const sc = r.result.structuredContent as { links?: unknown[] };
    expect(sc.links ?? []).toEqual([]);
  });

  it("T2-F3.3: articles.links preserves URL query parameters, fragments, and accented labels verbatim", async () => {
    const r = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "get_article", {
      law: "amf-ig-45-106",
      article: "annexe-a",
    });
    expect(r.result.isError).toBeUndefined();
    const sc = r.result.structuredContent as {
      links?: Array<{ label: string; url: string }>;
    };
    expect(sc.links).toEqual([
      {
        label: "Formulaire 45-106A1 (PDF & paramètres)",
        url: "https://lautorite.qc.ca/formulaires/45-106a1.pdf?lang=fr&rev=2#page=3",
      },
    ]);
    expect(proseOf(r.result)).toContain(
      "https://lautorite.qc.ca/formulaires/45-106a1.pdf?lang=fr&rev=2#page=3",
    );
  });

  it("T2-F3.4: missing annexe number returns isError: true with nearby articles instead of guessing", async () => {
    const r = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "get_article", {
      law: "qccs-mtl-directives",
      article: "annexe-99",
    });
    expect(r.result.isError).toBe(true);
    expect(proseOf(r.result)).toContain("introuvable");
  });

  it("T2-F3.5: get_division on ps:1 with include_text=false omits article text body", async () => {
    const r = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "get_division", {
      law: "qccs-mtl-directives",
      path: "ps:1",
      include_text: false,
    });
    expect(r.result.isError).toBeUndefined();
    const sc = r.result.structuredContent as {
      articles: Array<{ number: string; text?: string }>;
    };
    expect(sc.articles[0]?.number).toBe("annexe-1");
    expect(sc.articles[0]?.text).toBeUndefined();
  });

  it("T2-F4.1: related_laws(law='cpc', rel_type='preseance-sur', direction='in') returns all 4 PDF directives", async () => {
    const r = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "related_laws", {
      law: "cpc",
      rel_type: "preseance-sur",
      direction: "in",
    });
    expect(r.result.isError).toBeUndefined();
    const sc = r.result.structuredContent as {
      relations: Array<{ other_id: string }>;
    };
    expect(sc.relations.map((e) => e.other_id).sort()).toEqual([
      "qcca-avis",
      "qccq-civil",
      "qccs-mtl-directives",
      "qccs-qc-directives",
    ]);
  });

  it("T2-F4.2: related_laws(law='v-1.1-r.21', rel_type='interprete', direction='in') returns amf-ig-45-106", async () => {
    const r = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "related_laws", {
      law: "v-1.1-r.21",
      rel_type: "interprete",
      direction: "in",
    });
    expect(r.result.isError).toBeUndefined();
    const sc = r.result.structuredContent as {
      relations: Array<{ other_id: string }>;
    };
    expect(sc.relations.map((e) => e.other_id)).toEqual(["amf-ig-45-106"]);
  });

  it("T2-F4.3: related_laws(lang='en') marks French-only relation note with [fr] and note_lang='fr'", async () => {
    const r = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "related_laws", {
      law: "qccs-mtl-directives",
      lang: "en",
    });
    expect(r.result.isError).toBeUndefined();
    const sc = r.result.structuredContent as {
      relations: Array<{ note_lang: string | null }>;
    };
    expect(sc.relations[0]?.note_lang).toBe("fr");
    expect(proseOf(r.result)).toContain("[fr]");
  });

  it("T2-F4.4: get_article on ccq 1457 fabricates no preseance-sur or interprete pointer", async () => {
    const r = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "get_article", {
      law: "ccq",
      article: "1457",
    });
    const scJson = JSON.stringify(r.result.structuredContent);
    expect(scJson).not.toContain("preseance-sur");
    expect(scJson).not.toContain("interprete");
  });

  it("T2-F4.5: related_laws with non-matching rel_type filter returns isError: true", async () => {
    const r = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "related_laws", {
      law: "amf-ig-45-106",
      rel_type: "preseance-sur",
    });
    expect(r.result.isError).toBe(true);
  });

  it("T2-F5.1: bilingual PDF directive qccs-mtl-directives succeeds in lang='en'", async () => {
    const r = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "get_article", {
      law: "qccs-mtl-directives",
      article: "12",
      lang: "en",
    });
    expect(r.result.isError).toBeUndefined();
    expect(proseOf(r.result)).toContain("numbered tabs");
  });

  it("T2-F5.2: bilingual PDF orientation amf-ig-45-106 succeeds in lang='en'", async () => {
    const r = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "get_article", {
      law: "amf-ig-45-106",
      article: "2A.1",
      lang: "en",
    });
    expect(r.result.isError).toBeUndefined();
    expect(proseOf(r.result)).toContain("accredited investor exemption");
  });

  it("T2-F5.3: list_laws(lang='en') still reports fr-only PDFs with langs: ['fr']", async () => {
    const r = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "list_laws", { lang: "en" });
    const sc = r.result.structuredContent as {
      laws: Array<{ id: string; langs: string[] }>;
    };
    expect(sc.laws.find((l) => l.id === "qccq-civil")?.langs).toEqual(["fr"]);
    expect(sc.laws.find((l) => l.id === "qcca-avis")?.langs).toEqual(["fr"]);
  });

  it("T2-F5.4: scoped search_text(law='qccq-civil', lang='en') with semantic hit returns [fr] brief", async () => {
    const r = await callMcp(
      makeTestEnv({
        pdfCorpus: "1",
        vectorMatches: [
          {
            id: "art:qccq-civil:5",
            score: 0.72,
            metadata: {
              type: "article",
              law: "qccq-civil",
              article: "5",
              path: "ph1:1",
              heading: "CHAMBRE CIVILE",
            },
          },
        ],
      }),
      "search_text",
      { query: "provisional roll notice", law: "qccq-civil", lang: "en" },
    );
    expect(r.result.isError).toBeUndefined();
    const sc = r.result.structuredContent as {
      results: Array<{ law_id: string; number: string; semantic?: boolean }>;
    };
    expect(sc.results[0]?.law_id).toBe("qccq-civil");
    expect(sc.results[0]?.semantic).toBe(true);
    expect(proseOf(r.result)).toContain("[fr]");
  });

  it("T2-F5.5: get_article(law='qccq-civil', article='999', lang='en') returns French-only error before missing-article error", async () => {
    const r = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "get_article", {
      law: "qccq-civil",
      article: "999",
      lang: "en",
    });
    expect(r.result.isError).toBe(true);
    expect(proseOf(r.result)).toMatch(/published in French only/i);
  });

  it("T2-F6.1: resolve_reference handles full 'Instruction générale 45-106, art. 4B.2'", async () => {
    const r = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "resolve_reference", {
      citation: "Instruction générale 45-106, art. 4B.2",
    });
    expect(r.result.isError).toBeUndefined();
    const sc = r.result.structuredContent as { resolved: { law: string; number: string } };
    expect(sc.resolved.law).toBe("amf-ig-45-106");
    expect(sc.resolved.number).toBe("4B.2");
  });

  it("T2-F6.2: resolve_reference on repealed directive par. 13 returns repealed: true in prose and structuredContent", async () => {
    const r = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "resolve_reference", {
      citation: "Directives C.S. Montréal, par. 13",
    });
    expect(resIsOk(r.result)).toBe(true);
    const sc = r.result.structuredContent as { repealed: boolean; text: string; citation: string };
    expect(sc.repealed).toBe(true);
    expect(sc.text).toBe("Abrogé.");
    expect(sc.citation).toMatch(/\bpar\.\s*13\b/);
    const text = proseOf(r.result);
    expect(text).toMatch(/\bpar\.\s*13\b/);
    expect(text).toContain("ABROGÉ");
    expect(text).toContain("Abrogé.");
  });

  it("T2-F6.3: resolve_reference refuses unknown chapter RLRQ, c. Z-99 without fallback", async () => {
    const r = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "resolve_reference", {
      citation: "RLRQ, c. Z-99, art. 1",
    });
    expect(r.result.isError).toBe(true);
    expect(proseOf(r.result)).toContain("Z-99");
  });

  it("T2-F6.4: resolve_reference preserves explicit refusal of former C.p.c. (c. C-25)", async () => {
    const r = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "resolve_reference", {
      citation: "art. 2 ancien C.p.c.",
    });
    expect(r.result.isError).toBe(true);
    expect(proseOf(r.result)).toContain("C-25");
  });

  it("T2-F6.5: resolve_reference refuses unknown 'IG 99-999, art. 1' without falling back to amf-ig-45-106", async () => {
    const r = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "resolve_reference", {
      citation: "IG 99-999, art. 1",
    });
    expect(r.result.isError).toBe(true);
  });

  it("T2-F7.1: SEG_SPLIT handles 9-segment ph paths and ps:1 while preserving annexe-a", () => {
    expect(depthOf(DEEP_PATH)).toBe(9);
    expect(segmentsOf("ps:1-ph1:1")).toEqual(["ps:1", "ph1:1"]);
    expect(truncatePath("ph1:1-ph2:1-ph3:1", 2)).toBe("ph1:1-ph2:1");
    expect(segmentsOf("annexe-a")).toEqual(["annexe-a"]);
  });

  it("T2-F7.2: leading-zero sort_key collision (15.01 vs 15.1) tie-breaks cleanly via document id order", async () => {
    expect(sortKeyOf("15.01")).toBe(sortKeyOf("15.1"));
    const env1 = makeTestEnv({ pdfCorpus: "1" });
    const both = await callMcp(env1, "get_articles", {
      law: "v-1.1-r.21",
      from: "15.01",
      to: "15.1",
    });
    const scBoth = both.result.structuredContent as {
      range_resolution: string;
      articles: Array<{ number: string }>;
    };
    expect(scBoth.range_resolution).toBe("document");
    expect(scBoth.articles.map((a) => a.number)).toEqual(["15.01", "15.1"]);

    const single = await callMcp(env1, "get_articles", {
      law: "v-1.1-r.21",
      from: "15.1",
      to: "15.1",
    });
    expect(
      (single.result.structuredContent as { articles: Array<{ number: string }> }).articles.map(
        (a) => a.number,
      ),
    ).toEqual(["15.1"]);
  });

  it("T2-F7.3: get_articles refuses incompatible (from, to) + numbers[] together", async () => {
    const r = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "get_articles", {
      law: "amf-ig-45-106",
      from: "1.1",
      to: "10.1",
      numbers: ["2A.1"],
    });
    expect(r.result.isError).toBe(true);
    expect(proseOf(r.result)).toContain("Modes INCOMPATIBLES");
  });

  it("T2-F7.4: get_articles open bound (from='2.1', to='999') uses range_resolution='cle' excluding annexe-a, while to='annexe-a' includes it last", async () => {
    const env1 = makeTestEnv({ pdfCorpus: "1" });
    const openRes = await callMcp(env1, "get_articles", {
      law: "amf-ig-45-106",
      from: "2.1",
      to: "999",
    });
    expect(openRes.result.isError).toBeUndefined();
    const openSc = openRes.result.structuredContent as {
      range_resolution: string;
      articles: Array<{ number: string }>;
    };
    expect(openSc.range_resolution).toBe("cle");
    expect(openSc.articles.map((a) => a.number)).toEqual(["2.1", "2A.1", "4B.2", "10.1"]);
    expect(openSc.articles.map((a) => a.number)).not.toContain("annexe-a");

    const annexeRes = await callMcp(env1, "get_articles", {
      law: "amf-ig-45-106",
      from: "2.1",
      to: "annexe-a",
    });
    expect(annexeRes.result.isError).toBeUndefined();
    const annexeSc = annexeRes.result.structuredContent as {
      range_resolution: string;
      articles: Array<{ number: string }>;
    };
    expect(annexeSc.range_resolution).toBe("cle");
    expect(annexeSc.articles.at(-1)?.number).toBe("annexe-a");
  });

  it("T2-F7.5: search_text sanitizes malformed FTS syntax without leaking sqlite internals", async () => {
    const r = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "search_text", {
      query: '"" (( *** ))',
      law: "qccs-mtl-directives",
    });
    expect(r.result.isError).toBe(true);
    expect(proseOf(r.result)).not.toMatch(/fts5: syntax error/i);
  });

  it("T2-F8.1: search_text retrieves qccs-mtl-directives par. 12 on directive-specific vocabulary", async () => {
    const r = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "search_text", {
      query: "montage cahier onglets greffe",
    });
    expect(r.result.isError).toBeUndefined();
    const sc = r.result.structuredContent as {
      results: Array<{ law_id: string; number: string }>;
    };
    expect(sc.results.some((h) => h.law_id === "qccs-mtl-directives" && h.number === "12")).toBe(
      true,
    );
  });

  it("T2-F8.2: scoped search_text on amf-ig-45-106 retrieves alphanumeric 2A.1", async () => {
    const r = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "search_text", {
      query: "investisseur qualifié orientation",
      law: "amf-ig-45-106",
    });
    expect(r.result.isError).toBeUndefined();
    const sc = r.result.structuredContent as {
      results: Array<{ law_id: string; number: string }>;
    };
    expect(sc.results[0]?.law_id).toBe("amf-ig-45-106");
    expect(sc.results[0]?.number).toBe("2A.1");
  });

  it("T2-F8.3: get_article on repealed directive in lang='en' renders 'Repealed.' with repealed: true", async () => {
    const r = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "get_article", {
      law: "qccs-mtl-directives",
      article: "13",
      lang: "en",
    });
    expect(r.result.isError).toBeUndefined();
    const sc = r.result.structuredContent as { repealed: boolean; text: string };
    expect(sc.repealed).toBe(true);
    expect(sc.text).toBe("Repealed.");
  });

  it("T2-F8.4: find_relevant with stopwords-only query returns isError: true", async () => {
    const r = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "find_relevant", {
      query: "et le de la",
    });
    expect(r.result.isError).toBe(true);
  });

  it("T2-F8.5: search_text with nonexistent term returns closed-corpus lexical guidance error", async () => {
    const r = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "search_text", {
      query: "termeintrouvablexyz999",
    });
    expect(r.result.isError).toBe(true);
    expect(proseOf(r.result)).toContain("sélection fermée");
  });

  it("T2-F9.1: GET / with HEAD method returns empty body and 200 status", async () => {
    await caches.default.delete(CACHE_KEY);
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("https://legislation.test/", { method: "HEAD" }),
      makeTestEnv({ pdfCorpus: "1" }),
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("T2-F9.2: GET / stays accessible (200) even when MCP_ENABLED='false' while PDF_CORPUS='1'", async () => {
    const envDisabled = {
      ...(makeTestEnv({ pdfCorpus: "1" }) as unknown as Record<string, unknown>),
      MCP_ENABLED: "false",
    } as unknown as Env;
    const { status, html } = await getHomePage(envDisabled);
    expect(status).toBe(200);
    expect(html).toContain('data-law-id="qccs-mtl-directives"');
  });

  it("T2-F9.3: GET / serves cached response without cache delete, then updates after cache invalidation", async () => {
    const p1 = await getHomePage(makeTestEnv({ pdfCorpus: "1" }));
    expect(p1.html).toContain('data-law-id="qccs-mtl-directives"');

    const ctxCached = createExecutionContext();
    const resCached = await worker.fetch(
      new Request("https://legislation.test/"),
      makeTestEnv({ pdfCorpus: "0" }),
      ctxCached,
    );
    await waitOnExecutionContext(ctxCached);
    expect(await resCached.text()).toContain('data-law-id="qccs-mtl-directives"');

    const p0 = await getHomePage(makeTestEnv({ pdfCorpus: "0" }));
    expect(p0.html).not.toContain('data-law-id="qccs-mtl-directives"');
  });

  it("T2-F9.4: POST / returns 405 Allow: GET, HEAD while GET / with PDF_CORPUS='1' sets security headers", async () => {
    const ctxPost = createExecutionContext();
    const postRes = await worker.fetch(
      new Request("https://legislation.test/", { method: "POST" }),
      makeTestEnv({ pdfCorpus: "1" }),
      ctxPost,
    );
    await waitOnExecutionContext(ctxPost);
    expect(postRes.status).toBe(405);
    expect(postRes.headers.get("Allow")).toBe("GET, HEAD");

    await caches.default.delete(CACHE_KEY);
    const ctxGet = createExecutionContext();
    const getRes = await worker.fetch(
      new Request("https://legislation.test/"),
      makeTestEnv({ pdfCorpus: "1" }),
      ctxGet,
    );
    await waitOnExecutionContext(ctxGet);
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(getRes.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
  });

  it("T2-F9.5: GET / with PDF_CORPUS='1' preserves data-law-id parity with list_laws, bilingual spans, and zero secret leaks", async () => {
    const env1 = makeTestEnv({ pdfCorpus: "1" });
    const { status, html } = await getHomePage(env1);
    expect(status).toBe(200);
    const listRes = await callMcp(env1, "list_laws", {});
    const listIds = (listRes.result.structuredContent as { laws: Array<{ id: string }> }).laws
      .map((l) => l.id)
      .sort();
    const htmlIds = [...html.matchAll(/data-law-id="([^"]+)"/g)].map((m) => m[1]).sort();
    expect(htmlIds).toEqual(listIds);
    expect(html).toMatch(/<section id="corpus">[\s\S]*data-l="fr"[\s\S]*data-l="en"/);
    expect(html).toMatch(/<section id="matieres">[\s\S]*data-l="fr"[\s\S]*data-l="en"/);
    expect(html).not.toContain(MCP_TOKEN);
    expect(html).not.toContain(BACKFILL_TOKEN);
    expect(html).not.toContain("Bearer ");
  });
});

function resIsOk(r: McpToolResult): boolean {
  return !r.isError;
}

describe("Tier 3 — Cross-Feature Pairwise Combinations", () => {
  it("T3.1: PDF_CORPUS='1' + FEDERAL_CORPUS='0' vs '1' compose independently via SQL AND", async () => {
    const d = db();
    if (hasSourceCol) {
      await d
        .prepare(
          "INSERT INTO laws (id, name_fr, name_en, official_cite, jurisdiction, source) VALUES (?,?,?,?,?,?)",
        )
        .bind(
          "ca-l-2",
          "Code canadien du travail",
          "Canada Labour Code",
          "L.R.C. 1985, c. L-2",
          "ca",
          "lims",
        )
        .run();
    } else {
      await d
        .prepare(
          "INSERT INTO laws (id, name_fr, name_en, official_cite, jurisdiction) VALUES (?,?,?,?,?)",
        )
        .bind(
          "ca-l-2",
          "Code canadien du travail",
          "Canada Labour Code",
          "L.R.C. 1985, c. L-2",
          "ca",
        )
        .run();
    }
    try {
      const rPdfOnly = await callMcp(
        makeTestEnv({ pdfCorpus: "1", federalCorpus: "0" }),
        "list_laws",
        {},
      );
      const scPdfOnly = rPdfOnly.result.structuredContent as {
        count: number;
        laws: Array<{ id: string }>;
      };
      expect(scPdfOnly.count).toBe(9);
      expect(scPdfOnly.laws.some((l) => l.id === "ca-l-2")).toBe(false);
      expect(scPdfOnly.laws.some((l) => l.id === "qccs-mtl-directives")).toBe(true);

      const rBoth = await callMcp(
        makeTestEnv({ pdfCorpus: "1", federalCorpus: "1" }),
        "list_laws",
        {},
      );
      const scBoth = rBoth.result.structuredContent as {
        count: number;
        laws: Array<{ id: string }>;
      };
      expect(scBoth.count).toBe(10);
      expect(scBoth.laws.some((l) => l.id === "ca-l-2")).toBe(true);
      expect(scBoth.laws.some((l) => l.id === "qccs-mtl-directives")).toBe(true);
    } finally {
      await d.prepare("DELETE FROM laws WHERE id = 'ca-l-2'").run();
    }
  });

  it("T3.2: corpus-wide search_text (limit=10) enforces per-fonction diversity cap while preserving cpc/ccq/v-1.1 ranking", async () => {
    const env1 = makeTestEnv({ pdfCorpus: "1" });
    const civil = await callMcp(env1, "search_text", {
      query: "demande civile greffe",
      limit: 10,
    });
    const civilSc = civil.result.structuredContent as {
      results: Array<{ law_id: string }>;
    };
    expect(civilSc.results[0]?.law_id).toBe("cpc");
    const directiveLaws = new Set([
      "qccs-mtl-directives",
      "qccs-qc-directives",
      "qccq-civil",
      "qcca-avis",
    ]);
    const directiveCount = civilSc.results.filter((r) => directiveLaws.has(r.law_id)).length;
    expect(directiveCount).toBeLessThanOrEqual(3);

    const sec = await callMcp(env1, "search_text", {
      query: "dispense prospectus investisseur qualifié",
      limit: 10,
    });
    const secSc = sec.result.structuredContent as {
      results: Array<{ law_id: string }>;
    };
    const firstNonPdf = secSc.results.findIndex(
      (r) => r.law_id === "v-1.1" || r.law_id === "v-1.1-r.21",
    );
    expect(firstNonPdf).toBe(0);
  });

  it("T3.3: resolve_reference -> get_article -> related_laws(interprete) -> paired EPUB v-1.1-r.21", async () => {
    const env1 = makeTestEnv({ pdfCorpus: "1" });
    const ref = await callMcp(env1, "resolve_reference", { citation: "IG 45-106, art. 2A.1" });
    expect(ref.result.isError).toBeUndefined();
    const refLaw = (ref.result.structuredContent as { resolved: { law: string } }).resolved.law;
    expect(refLaw).toBe("amf-ig-45-106");

    const rel = await callMcp(env1, "related_laws", {
      law: refLaw,
      rel_type: "interprete",
    });
    const relTarget = (rel.result.structuredContent as { relations: Array<{ other_id: string }> })
      .relations[0]?.other_id;
    expect(relTarget).toBe("v-1.1-r.21");

    const epubArt = await callMcp(env1, "get_article", {
      law: relTarget!,
      article: "2.3",
    });
    expect(epubArt.result.isError).toBeUndefined();
    expect(proseOf(epubArt.result)).toContain("investisseur qualifié");
  });

  it("T3.4: DB_IDENTITE hybride_permis=0 opt-out + PDF_CORPUS='1' skips AI/VECTORS while serving lexical PDF hits", async () => {
    const token = frapperJeton();
    const hash = await empreinte(token);
    const queue = queueJeton(token);
    const now = "2026-11-18T12:00:00.000Z";
    await dbIdentite()
      .prepare(
        `INSERT INTO titulaire (
           id, cree_le, etat, nom, numero_membre, section, courriel,
           attestation_le, attestation_ver, cgu_ver, hybride_permis
         ) VALUES ('tit_pdf_lex', ?1, 'actif', 'Me Lex', '88001-0', 'Montréal', 'lex@pdf.test', ?1, 'v1', 'v1', 0)`,
      )
      .bind(now)
      .run();
    await dbIdentite()
      .prepare(
        `INSERT INTO jeton (
           id, titulaire_id, empreinte, queue, libelle, portee, emis_le, expire_le, revoque_le
         ) VALUES ('jet_pdf_lex', 'tit_pdf_lex', ?1, ?2, 'poste', 'legislation', ?3, '2099-01-01T00:00:00.000Z', NULL)`,
      )
      .bind(hash, queue, now)
      .run();

    try {
      let aiCalls = 0;
      let vecCalls = 0;
      const envLex = makeTestEnv({
        pdfCorpus: "1",
        onAiRun: () => {
          aiCalls += 1;
        },
        onVectorQuery: () => {
          vecCalls += 1;
        },
      });
      const r = await callMcp(envLex, "search_text", { query: "montage cahier audience" }, token);
      expect(r.result.isError).toBeUndefined();
      expect(aiCalls).toBe(0);
      expect(vecCalls).toBe(0);
      const sc = r.result.structuredContent as {
        hybride_desactive?: boolean;
        results: Array<{ law_id: string }>;
      };
      expect(sc.hybride_desactive).toBe(true);
      expect(sc.results.some((h) => h.law_id === "qccs-mtl-directives")).toBe(true);
    } finally {
      await dbIdentite().exec(
        "DELETE FROM evenement_technique;\nDELETE FROM compteur_jour;\nDELETE FROM jeton;\nDELETE FROM titulaire;",
      );
    }
  });

  it("T3.5: get_division(law='qcca-avis', path='ps:1') combines ps:1 path + links + preseance-sur cpc", async () => {
    const r = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "get_division", {
      law: "qcca-avis",
      path: "ps:1",
    });
    expect(r.result.isError).toBeUndefined();
    const scJson = JSON.stringify(r.result.structuredContent);
    expect(scJson).toContain("https://courdappelduquebec.ca/aide-memoire.pdf");
    expect(scJson).toContain("preseance-sur");
    expect(scJson).toContain("cpc");
    expect(proseOf(r.result)).toContain("Aide-mémoire officiel C.A.");
    expect(proseOf(r.result)).toMatch(/cpc|Code de proc[ée]dure civile/i);
  });

  it("T3.6: fr-only semantic [fr] hit -> lang='en' explicit error -> lang='fr' recovery", async () => {
    const envSem = makeTestEnv({
      pdfCorpus: "1",
      vectorMatches: [
        {
          id: "art:qccq-civil:5",
          score: 0.77,
          metadata: {
            type: "article",
            law: "qccq-civil",
            article: "5",
            path: "ph1:1",
            heading: "CHAMBRE CIVILE",
          },
        },
      ],
    });
    const s = await callMcp(envSem, "search_text", {
      query: "provisional roll notice",
      lang: "en",
    });
    expect(proseOf(s.result)).toContain("[fr]");
    const enErr = await callMcp(envSem, "get_article", {
      law: "qccq-civil",
      article: "5",
      lang: "en",
    });
    expect(enErr.result.isError).toBe(true);
    expect(proseOf(enErr.result)).toMatch(/published in French only/i);

    const frOk = await callMcp(envSem, "get_article", {
      law: "qccq-civil",
      article: "5",
      lang: "fr",
    });
    expect(frOk.result.isError).toBeUndefined();
    expect(proseOf(frOk.result)).toContain("rôle provisoire");
  });

  it("T3.7: find_relevant hides amf-ig-45-106 under PDF_CORPUS='0' and surfaces both under PDF_CORPUS='1'", async () => {
    const r0 = await callMcp(makeTestEnv({ pdfCorpus: "0" }), "find_relevant", {
      query: "dispense prospectus valeurs mobilieres",
    });
    const laws0 = (
      r0.result.structuredContent as { candidates: Array<{ law: string }> }
    ).candidates.map((c) => c.law);
    expect(laws0).toContain("v-1.1-r.21");
    expect(laws0).not.toContain("amf-ig-45-106");

    const r1 = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "find_relevant", {
      query: "dispense prospectus valeurs mobilieres",
    });
    const laws1 = (
      r1.result.structuredContent as { candidates: Array<{ law: string }> }
    ).candidates.map((c) => c.law);
    expect(laws1).toContain("v-1.1-r.21");
    expect(laws1).toContain("amf-ig-45-106");
  });

  it("T3.8: get_articles alphanumeric range (1.1..10.1) returns ordered body articles and excludes annexe-a", async () => {
    const r = await callMcp(makeTestEnv({ pdfCorpus: "1" }), "get_articles", {
      law: "amf-ig-45-106",
      from: "1.1",
      to: "10.1",
    });
    expect(r.result.isError).toBeUndefined();
    const sc = r.result.structuredContent as {
      range_resolution: string;
      articles: Array<{ number: string }>;
    };
    expect(sc.range_resolution).toBe("document");
    expect(sc.articles.map((a) => a.number)).toEqual(["1.1", "2.1", "2A.1", "4B.2", "10.1"]);
  });

  it("T3.9: GET / cache invalidation across PDF_CORPUS='0' -> '1' -> '0' matches /mcp list_laws count", async () => {
    for (const [flag, expectedCount] of [
      ["0", 4],
      ["1", 9],
      ["0", 4],
    ] as const) {
      const testEnv = makeTestEnv({ pdfCorpus: flag });
      const { html } = await getHomePage(testEnv);
      const { result } = await callMcp(testEnv, "list_laws", {});
      const listCount = (result.structuredContent as { count: number }).count;
      const htmlRows = (html.match(/data-law-id="/g) ?? []).length;
      expect(listCount).toBe(expectedCount);
      expect(htmlRows).toBe(expectedCount);
    }
  });
});

describe("Tier 4 — Real-World Legal Application Scenarios", () => {
  it("T4.1: Québec civil motion procedure — C.p.c. art. 490 + QCCS Montréal directive + preseance-sur", async () => {
    const env1 = makeTestEnv({ pdfCorpus: "1" });
    const cpcRef = await callMcp(env1, "resolve_reference", { citation: "art. 490 C.p.c." });
    expect((cpcRef.result.structuredContent as { resolved: { law: string } }).resolved.law).toBe(
      "cpc",
    );

    const search = await callMcp(env1, "search_text", {
      query: "assignation hors du québec demande civile",
    });
    const hits = (search.result.structuredContent as { results: Array<{ law_id: string }> })
      .results;
    const cpcPos = hits.findIndex((h) => h.law_id === "cpc");
    expect(cpcPos).toBe(0);

    const dirArt = await callMcp(env1, "get_article", {
      law: "qccs-mtl-directives",
      article: "12",
    });
    expect((dirArt.result.structuredContent as { citation: string }).citation).toMatch(
      /\bpar\.\s*12\b/,
    );
    expect(JSON.stringify(dirArt.result.structuredContent)).toContain("preseance-sur");
    expect(proseOf(dirArt.result)).toMatch(/cpc|Code de proc[ée]dure civile/i);
  });

  it("T4.2: Securities prospectus exemption — Règlement 45-106 vs IG 45-106 + interprete + alphanumeric range", async () => {
    const env1 = makeTestEnv({ pdfCorpus: "1" });
    const reg = await callMcp(env1, "resolve_reference", {
      citation: "Règlement 45-106, art. 2.3",
    });
    expect((reg.result.structuredContent as { resolved: { law: string } }).resolved.law).toBe(
      "v-1.1-r.21",
    );

    const ig = await callMcp(env1, "resolve_reference", {
      citation: "IG 45-106, art. 2A.1",
    });
    expect((ig.result.structuredContent as { resolved: { law: string } }).resolved.law).toBe(
      "amf-ig-45-106",
    );

    const rel = await callMcp(env1, "related_laws", { law: "amf-ig-45-106" });
    expect(
      (
        rel.result.structuredContent as {
          relations: Array<{ other_id: string; rel_type: string }>;
        }
      ).relations.some((e) => e.other_id === "v-1.1-r.21" && e.rel_type === "interprete"),
    ).toBe(true);

    const range = await callMcp(env1, "get_articles", {
      law: "amf-ig-45-106",
      from: "2.1",
      to: "4B.2",
    });
    expect(
      (range.result.structuredContent as { articles: Array<{ number: string }> }).articles.map(
        (a) => a.number,
      ),
    ).toEqual(["2.1", "2A.1", "4B.2"]);
  });

  it("T4.3: Court of Appeal filing checklist — qcca-avis structure, ps:1, annexe-a links & cpc override", async () => {
    const env1 = makeTestEnv({ pdfCorpus: "1" });
    const struct = await callMcp(env1, "get_structure", { law: "qcca-avis" });
    expect(
      (struct.result.structuredContent as { tree: Array<{ path: string }> }).tree.map(
        (t) => t.path,
      ),
    ).toContain("ps:1");

    const div = await callMcp(env1, "get_division", { law: "qcca-avis", path: "ps:1" });
    expect(div.result.isError).toBeUndefined();

    const annexe = await callMcp(env1, "get_article", {
      law: "qcca-avis",
      article: "annexe-a",
    });
    const sc = annexe.result.structuredContent as {
      links?: Array<{ label: string; url: string }>;
    };
    expect(sc.links).toHaveLength(2);
    expect(proseOf(annexe.result)).toContain("https://courdappelduquebec.ca/aide-memoire.pdf");
    expect(JSON.stringify(annexe.result.structuredContent)).toContain("preseance-sur");
  });

  it("T4.4: English counsel researching qccq-civil — semantic [fr] -> lang='en' error -> lang='fr' recovery", async () => {
    const envSem = makeTestEnv({
      pdfCorpus: "1",
      vectorMatches: [
        {
          id: "art:qccq-civil:5",
          score: 0.81,
          metadata: {
            type: "article",
            law: "qccq-civil",
            article: "5",
            path: "ph1:1",
            heading: "CHAMBRE CIVILE ET PETITES CRÉANCES",
          },
        },
      ],
    });
    const search = await callMcp(envSem, "search_text", {
      query: "Court of Québec civil notice provisional roll",
      lang: "en",
    });
    expect(proseOf(search.result)).toContain("[fr]");

    const enArt = await callMcp(envSem, "get_article", {
      law: "qccq-civil",
      article: "5",
      lang: "en",
    });
    expect(enArt.result.isError).toBe(true);
    expect(proseOf(enArt.result)).toMatch(/published in French only/i);

    const frArt = await callMcp(envSem, "get_article", {
      law: "qccq-civil",
      article: "5",
      lang: "fr",
    });
    expect(frArt.result.isError).toBeUndefined();
    expect(proseOf(frArt.result)).toContain("appel du rôle provisoire");
  });

  it("T4.5: Ambiguous citation recovery — 'Directives C.S., par. 12' refusal -> list_laws -> Montréal par. 12", async () => {
    const env1 = makeTestEnv({ pdfCorpus: "1" });
    const ambig = await callMcp(env1, "resolve_reference", {
      citation: "Directives C.S., par. 12",
    });
    expect(ambig.result.isError).toBe(true);
    expect(proseOf(ambig.result)).toMatch(/ambigu|plusieurs|précis/i);
    expect(proseOf(ambig.result)).toMatch(/qccs-mtl-directives|Montréal/i);
    expect(proseOf(ambig.result)).toMatch(/qccs-qc-directives|Québec/i);

    const list = await callMcp(env1, "list_laws", { fonction: "directive" });
    const mtl = (list.result.structuredContent as { laws: Array<{ id: string }> }).laws.find(
      (l) => l.id === "qccs-mtl-directives",
    );
    expect(mtl).toBeDefined();

    const target = await callMcp(env1, "get_article", {
      law: mtl!.id,
      article: "12",
    });
    expect(target.result.isError).toBeUndefined();
    expect(proseOf(target.result)).toContain("onglets numérotés");
  });

  it("T4.6: Production gate & site parity across PDF_CORPUS='0' and '1' with FEDERAL_CORPUS='1'", async () => {
    const envClosed = makeTestEnv({ pdfCorpus: "0", federalCorpus: "1" });
    const homeClosed = await getHomePage(envClosed);
    const listClosed = await callMcp(envClosed, "list_laws", {});
    expect((homeClosed.html.match(/data-law-id="/g) ?? []).length).toBe(4);
    expect((listClosed.result.structuredContent as { count: number }).count).toBe(4);

    const envOpen = makeTestEnv({ pdfCorpus: "1", federalCorpus: "1" });
    const homeOpen = await getHomePage(envOpen);
    const listOpen = await callMcp(envOpen, "list_laws", {});
    expect((homeOpen.html.match(/data-law-id="/g) ?? []).length).toBe(9);
    expect((listOpen.result.structuredContent as { count: number }).count).toBe(9);
    expect(homeOpen.html).toContain('<option value="directive">');
    expect(homeOpen.html).toContain('<option value="orientation">');
  });
});
