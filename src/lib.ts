import {
  depthOf,
  isFederalPath,
  isPdfPath,
  segmentsOf,
  subtreeBinds,
  subtreeClause,
  truncatePath,
} from "./paths";
import type { DivisionLite, LawLite, RelationLite, SubjectLite, SubjectMapLite } from "./relevance";
import {
  ALL_DOMAINS,
  DIVISION_MATCH_MAX,
  DIVISION_MATCH_MIN_SCORE,
  FONCTION_WEIGHTS,
  fonctionWeight,
  type LawDomain,
  MARGINAL_NOTE_WEIGHT,
  normalize,
  RELAX_MIN_LOO_TOTAL,
  RRF_K,
  SEMANTIC_MIN_SCORE,
  stripAccents,
  tokenize,
  VECTOR_TOP_K,
} from "./relevance";

export type LawSource = "epub" | "lims" | "pdf";

export type CorpusGateEnv = {
  FEDERAL_CORPUS?: string;
  PDF_CORPUS?: string;
  CRIMINAL_CORPUS?: string;
  DOMAIN_QUARANTINE?: string;
  VECTOR_DOMAIN_FILTER?: string;
};

export interface LawRow {
  id: string;
  name_fr: string;
  name_en: string;
  official_cite: string;
  official_cite_en?: string | null;
  consol_date_fr: string | null;
  consol_date_en: string | null;
  source?: LawSource;
  domain?: string | null;
  chapter?: string | null;
  jurisdiction?: string;
  in_force?: number;
  last_amended?: string | null;
  unit?: Unit | string | null;
  fonction: string | null;
  forum: string | null;
  scope_fr: string | null;
  parent_law_id: string | null;
  name_norm: string | null;
}

export interface DivisionRow {
  id: number;
  law_id: string;
  lang: string;
  kind: string;
  number: string | null;
  heading: string | null;
  history: string | null;
  path: string;
  repealed: number;
  parent_id: number | null;
  sort_order: number;
}

export interface ArticleLink {
  label: string;
  url: string;
}

export function parseLinks(raw: string | null | undefined): ArticleLink[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is ArticleLink =>
        !!x &&
        typeof x === "object" &&
        typeof (x as ArticleLink).label === "string" &&
        typeof (x as ArticleLink).url === "string",
    );
  } catch {
    return [];
  }
}

export interface ArticleRow {
  id: number;
  law_id: string;
  lang: string;
  number: string;
  division_path: string;
  text: string;
  history: string | null;
  repealed: number;
  links: string | null;
}

export type Lang = "fr" | "en";

export const DISPOSITION_SORT_BASE = 9_000_000_000_000_000;

const SORT_COMP_RE = /^(\d+)([A-Za-z]?)$/;
const SORT_BASES = [13_500, 2_700, 864] as const;
const SORT_MAX_NUMS = [9999, 499, 99, 31] as const;

export function sortKeyOf(article: string): number {
  if (
    article === "préliminaire" ||
    article === "preambule" ||
    article === "preamble" ||
    article === "note-preliminaire"
  )
    return 0;
  const parts = article.split(".");
  if (!SORT_COMP_RE.test(parts[0])) return DISPOSITION_SORT_BASE;
  const comps = parts.slice(0, 4);
  const vals: number[] = [];
  for (let i = 0; i < comps.length; i++) {
    const m = SORT_COMP_RE.exec(comps[i]);
    if (m) {
      const n = Math.min(parseInt(m[1], 10), SORT_MAX_NUMS[i]);
      const letCode = m[2] ? m[2].toUpperCase().charCodeAt(0) - 64 : 0;
      vals.push(n * 27 + letCode);
    } else {
      vals.push(0);
    }
  }
  while (vals.length < 4) vals.push(0);
  let key = vals[0];
  for (let i = 0; i < SORT_BASES.length; i++) key = key * SORT_BASES[i] + vals[i + 1];
  return key;
}

export type Unit = "article" | "regle" | "paragraphe";

const MOT_UNITE: Record<Unit, Record<Lang, string>> = {
  article: { fr: "art.", en: "s." },
  regle: { fr: "règle", en: "rule" },
  paragraphe: { fr: "par.", en: "para." },
};

export function unitLabel(unit: string | null | undefined, lang: Lang = "fr"): string {
  const u: Unit = unit === "regle" ? "regle" : unit === "paragraphe" ? "paragraphe" : "article";
  return MOT_UNITE[u][lang];
}

const MOT_PSEUDO: Record<string, Record<Lang, string>> = {
  préliminaire: { fr: "disposition préliminaire", en: "preliminary provision" },
  "note-preliminaire": { fr: "note préliminaire", en: "preliminary note" },
  finales: { fr: "dispositions finales", en: "final provisions" },
  preambule: { fr: "préambule", en: "preamble" },
  preamble: { fr: "préambule", en: "preamble" },
};

export function citationOf(
  law: Pick<LawRow, "official_cite" | "official_cite_en"> & { unit?: string | null },
  article: string,
  lang: Lang = "fr",
): string {
  const citeEn = lang === "en" ? law.official_cite_en : null;
  const langueDeSortie: Lang = citeEn ? "en" : "fr";
  const cite = citeEn || law.official_cite;
  const pseudo = MOT_PSEUDO[article];
  if (pseudo) return `${cite}, ${pseudo[langueDeSortie]}`;
  const unite: Unit =
    law.unit === "regle" ? "regle" : law.unit === "paragraphe" ? "paragraphe" : "article";
  return `${cite}, ${MOT_UNITE[unite][langueDeSortie]} ${article}`;
}

export function consolOf(law: LawRow | null, lang: Lang): string | null {
  if (!law) return null;
  return lang === "en" ? law.consol_date_en : law.consol_date_fr;
}

export interface Page {
  limit: number;
  offset: number;
}

export function paginate(limit?: number, offset?: number, def = 50, max = 200): Page {
  const l = Math.min(Math.max(1, Math.trunc(limit ?? def)), max);
  const o = Math.max(0, Math.trunc(offset ?? 0));
  return { limit: l, offset: o };
}

export async function getLaw(
  db: D1Database,
  lawId: string,
  env: CorpusGateEnv = {},
): Promise<LawRow | null> {
  const c = clauseCorpus(env, "");
  const masque = c ? ` AND ${c}` : "";
  return db.prepare(`SELECT * FROM laws WHERE id = ?${masque}`).bind(lawId).first<LawRow>();
}

export function masqueLawId(env: CorpusGateEnv, col: string): string {
  const c = clauseCorpus(env, "");
  return c ? `AND ${col} IN (SELECT id FROM laws WHERE ${c})` : "";
}

export function masqueAutreBout(env: CorpusGateEnv, col: string): string {
  const excl: string[] = [];
  if (!federalOuvert(env)) excl.push("jurisdiction <> 'qc'");
  if (!pdfOuvert(env)) excl.push("source = 'pdf'");
  if (!criminalOuvert(env)) excl.push("(jurisdiction = 'ca' AND domain = 'penal')");
  return excl.length
    ? `AND NOT EXISTS (SELECT 1 FROM laws WHERE id = ${col} AND (${excl.join(" OR ")}))`
    : "";
}

export interface MappedDivision {
  division_path: string;
  heading: string | null;
  subject: string;
}

export interface LawSummary extends LawRow {
  langs: string[];
  article_count: number;
  subjects: string[];
  mapped_divisions: MappedDivision[];
}

export interface LawFilters {
  domains?: readonly string[];
  fonction?: string;
  forum?: string;
  subject?: string;
  jurisdiction?: string;
}

function quarantaineDomaineActive(env: CorpusGateEnv): boolean {
  return env.DOMAIN_QUARANTINE !== "0";
}

function vectorDomainFilterActif(env: CorpusGateEnv): boolean {
  return env.VECTOR_DOMAIN_FILTER === "1";
}

const VALID_DOMAINS = new Set<string>(ALL_DOMAINS);

export function resolveActiveDomains(
  rawDomains: readonly string[] | undefined,
  env: CorpusGateEnv = {},
): { active: LawDomain[]; excluded: LawDomain[]; explicit: boolean; isAll: boolean } {
  const explicit = Boolean(rawDomains && rawDomains.length > 0);
  let active: LawDomain[];
  if (!explicit) {
    active = quarantaineDomaineActive(env) ? ["core"] : [...ALL_DOMAINS];
  } else if (rawDomains!.includes("all")) {
    active = [...ALL_DOMAINS];
  } else {
    const picked = new Set<LawDomain>();
    for (const d of rawDomains!) {
      if (VALID_DOMAINS.has(d)) picked.add(d as LawDomain);
    }
    active = picked.size > 0 ? ALL_DOMAINS.filter((d) => picked.has(d)) : ["core"];
  }
  const excluded = ALL_DOMAINS.filter((d) => !active.includes(d));
  return { active, excluded, explicit, isAll: excluded.length === 0 };
}

function matchesForumScope(
  lawForum: string | null | undefined,
  requestedForum: string | undefined,
): boolean {
  const req = requestedForum?.trim();
  if (!req) return true;
  if (!lawForum?.trim()) return true;
  const hay = normalize(lawForum);
  return hay.includes("transversal") || hay.includes(normalize(req));
}

function forumScopeSqlClause(alias = "l"): string {
  const p = alias ? `${alias}.` : "";
  return `(${p}forum IS NULL OR ${p}forum = '' OR ${p}forum LIKE '%Transversal%' OR ${p}forum LIKE ?)`;
}

export function federalOuvert(env: CorpusGateEnv): boolean {
  return env.FEDERAL_CORPUS === "1";
}

export function pdfOuvert(env: CorpusGateEnv): boolean {
  return env.PDF_CORPUS === "1";
}

export function criminalOuvert(env: CorpusGateEnv): boolean {
  return env.CRIMINAL_CORPUS === "1";
}

export function clauseCorpus(env: CorpusGateEnv, alias = "l"): string {
  const p = alias ? `${alias}.` : "";
  const conds: string[] = [];
  if (!federalOuvert(env)) conds.push(`${p}jurisdiction = 'qc'`);
  if (!pdfOuvert(env)) conds.push(`${p}source <> 'pdf'`);
  if (!criminalOuvert(env)) conds.push(`NOT (${p}jurisdiction = 'ca' AND ${p}domain = 'penal')`);
  return conds.join(" AND ");
}

export async function listLaws(
  db: D1Database,
  filters: LawFilters = {},
  lang: Lang = "fr",
  env: CorpusGateEnv = {},
): Promise<LawSummary[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  const masque = clauseCorpus(env);
  if (masque) where.push(masque);
  if (filters.jurisdiction) {
    where.push("l.jurisdiction = ?");
    binds.push(filters.jurisdiction);
  }
  if (
    filters.domains &&
    filters.domains.length > 0 &&
    filters.domains.length < ALL_DOMAINS.length
  ) {
    where.push(`l.domain IN (${filters.domains.map(() => "?").join(",")})`);
    binds.push(...filters.domains);
  }
  if (filters.fonction) {
    where.push("l.fonction = ?");
    binds.push(filters.fonction);
  }
  if (filters.forum) {
    where.push("l.forum LIKE ?");
    binds.push(`%${filters.forum}%`);
  }
  if (filters.subject) {
    where.push(
      "EXISTS (SELECT 1 FROM subject_map sm WHERE sm.law_id = l.id AND sm.subject_id = ?)",
    );
    binds.push(filters.subject);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const laws = (
    await db
      .prepare(`SELECT l.* FROM laws l ${clause} ORDER BY l.id`)
      .bind(...binds)
      .all<LawRow>()
  ).results;

  const counts = (
    await db
      .prepare("SELECT law_id, lang, COUNT(*) AS n FROM articles GROUP BY law_id, lang")
      .all<{ law_id: string; lang: string; n: number }>()
  ).results;
  const maps = (
    await db
      .prepare(
        `SELECT sm.law_id, sm.division_path, s.label_fr, s.label_en, d.heading
       FROM subject_map sm
       JOIN subjects s ON s.id = sm.subject_id
       LEFT JOIN divisions d ON d.law_id = sm.law_id AND d.path = sm.division_path AND d.lang = 'fr'
       ORDER BY sm.law_id, sm.division_path`,
      )
      .all<{
        law_id: string;
        division_path: string;
        label_fr: string;
        label_en: string | null;
        heading: string | null;
      }>()
  ).results;

  const traduits = new Map<string, Map<string, TranslatedPath>>();
  if (lang !== "fr") {
    for (const law of laws) {
      const paths = maps
        .filter((m) => m.law_id === law.id && m.division_path)
        .map((m) => m.division_path);
      if (paths.length) traduits.set(law.id, await translatePaths(db, law.id, lang, paths));
    }
  }

  const libelle = (m: { label_fr: string; label_en: string | null }) =>
    (lang === "en" ? m.label_en : m.label_fr) || m.label_fr;

  return laws.map((law) => {
    const mine = counts.filter((c) => c.law_id === law.id);
    const mapped = maps.filter((m) => m.law_id === law.id);
    return {
      ...law,
      langs: mine.map((r) => r.lang).sort(),
      article_count: mine.find((r) => r.lang === lang)?.n ?? Math.max(0, ...mine.map((r) => r.n)),
      subjects: [...new Set(mapped.map(libelle))],
      mapped_divisions: mapped
        .filter((m) => m.division_path)
        .map((m) => {
          const t = traduits.get(law.id)?.get(m.division_path);
          return {
            division_path: t?.path ?? m.division_path,
            heading: t ? t.heading : m.heading,
            subject: libelle(m),
          };
        }),
    };
  });
}

export async function countExcludedDomainLaws(
  db: D1Database,
  excludedDomains: readonly string[],
  filters: Omit<LawFilters, "domains"> = {},
  env: CorpusGateEnv = {},
): Promise<{ domain: string; laws_count: number }[]> {
  if (!excludedDomains.length) return [];
  const where: string[] = [];
  const binds: unknown[] = [];
  const masque = clauseCorpus(env);
  if (masque) where.push(masque);
  where.push(`l.domain IN (${excludedDomains.map(() => "?").join(",")})`);
  binds.push(...excludedDomains);
  if (filters.jurisdiction) {
    where.push("l.jurisdiction = ?");
    binds.push(filters.jurisdiction);
  }
  if (filters.fonction) {
    where.push("l.fonction = ?");
    binds.push(filters.fonction);
  }
  if (filters.forum) {
    where.push("l.forum LIKE ?");
    binds.push(`%${filters.forum}%`);
  }
  if (filters.subject) {
    where.push(
      "EXISTS (SELECT 1 FROM subject_map sm WHERE sm.law_id = l.id AND sm.subject_id = ?)",
    );
    binds.push(filters.subject);
  }
  const clause = where.join(" AND ");
  const rows = (
    await db
      .prepare(
        `SELECT l.domain AS domain, COUNT(*) AS n FROM laws l WHERE ${clause} GROUP BY l.domain ORDER BY n DESC, l.domain ASC`,
      )
      .bind(...binds)
      .all<{ domain: string; n: number }>()
  ).results;
  return rows.map((r) => ({ domain: r.domain, laws_count: r.n }));
}

export interface TranslatedPath {
  path: string;
  heading: string | null;
}

export async function translatePaths(
  db: D1Database,
  lawId: string,
  lang: Lang,
  frPaths: string[],
): Promise<Map<string, TranslatedPath>> {
  const out = new Map<string, TranslatedPath>();
  if (lang === "fr" || frPaths.length === 0) return out;

  const pairs = (
    await db
      .prepare(
        `SELECT afr.division_path AS fr_path, MIN(aen.division_path) AS other_path
       FROM articles afr
       JOIN articles aen ON aen.law_id = afr.law_id AND aen.number = afr.number AND aen.lang = ?
       WHERE afr.law_id = ? AND afr.lang = 'fr'
       GROUP BY afr.division_path`,
      )
      .bind(lang, lawId)
      .all<{ fr_path: string; other_path: string }>()
  ).results;

  const wanted = new Map<string, string>();
  for (const p of frPaths) {
    const hit = pairs.find((x) => x.fr_path === p || x.fr_path.startsWith(`${p}-`));
    if (!hit?.other_path) continue;
    const translated = truncatePath(hit.other_path, depthOf(p));
    if (translated) wanted.set(translated, p);
  }
  if (wanted.size === 0) return out;

  const keys = [...wanted.keys()];
  const rows = (
    await db
      .prepare(
        `SELECT path, heading FROM divisions
       WHERE law_id = ? AND lang = ? AND path IN (${keys.map(() => "?").join(",")})`,
      )
      .bind(lawId, lang, ...keys)
      .all<{ path: string; heading: string | null }>()
  ).results;
  for (const r of rows) {
    const fr = wanted.get(r.path);
    if (fr) out.set(fr, { path: r.path, heading: r.heading });
  }
  return out;
}

export async function translateDivisionPath(
  db: D1Database,
  lawId: string,
  path: string,
  toLang: Lang,
): Promise<{ path: string; heading: string | null } | null> {
  if (isFederalPath(path) || isPdfPath(path)) {
    return (
      (await db
        .prepare("SELECT path, heading FROM divisions WHERE law_id = ? AND lang = ? AND path = ?")
        .bind(lawId, toLang, path)
        .first<{ path: string; heading: string | null }>()) ?? null
    );
  }
  const fromLang: Lang = toLang === "fr" ? "en" : "fr";
  const bridge = await db
    .prepare(
      `SELECT a2.division_path AS p FROM articles a1
       JOIN articles a2 ON a2.law_id = a1.law_id AND a2.number = a1.number AND a2.lang = ?
       WHERE a1.law_id = ? AND a1.lang = ?
         AND (a1.division_path = ? OR (a1.division_path >= ? || '-' AND a1.division_path < ? || '.'))
       LIMIT 1`,
    )
    .bind(toLang, lawId, fromLang, path, path, path)
    .first<{ p: string }>();
  if (!bridge?.p) return null;
  const target = truncatePath(bridge.p, depthOf(path));
  const div = await db
    .prepare("SELECT path, heading FROM divisions WHERE law_id = ? AND lang = ? AND path = ?")
    .bind(lawId, toLang, target)
    .first<{ path: string; heading: string | null }>();
  return div ?? null;
}

export async function headingInOtherLang(
  db: D1Database,
  lawId: string,
  path: string,
  lang: Lang,
): Promise<string | null> {
  const other: Lang = lang === "fr" ? "en" : "fr";
  const t = await translateDivisionPath(db, lawId, path, other);
  return t?.heading ?? null;
}

export interface OutlineNode {
  kind: string;
  number: string | null;
  heading: string | null;
  path: string;
  children: Omit<OutlineNode, "children">[];
}

export async function lawOutlines(
  db: D1Database,
  lang: Lang,
  lawIds: string[],
): Promise<Map<string, OutlineNode[]>> {
  if (!lawIds.length) return new Map();
  const livres = (
    await db
      .prepare(
        `SELECT id, law_id, path, kind, number, heading FROM divisions
       WHERE lang = ? AND kind = 'livre' AND law_id IN (${lawIds.map(() => "?").join(",")})
       ORDER BY law_id, sort_order`,
      )
      .bind(lang, ...lawIds)
      .all<DivisionRow>()
  ).results;
  const out = new Map<string, OutlineNode[]>();
  if (!livres.length) return out;

  const byParent = new Map<number, Omit<OutlineNode, "children">[]>();
  const ids = livres.map((l) => l.id);
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const rows = (
      await db
        .prepare(
          `SELECT parent_id, path, kind, number, heading FROM divisions
         WHERE parent_id IN (${chunk.map(() => "?").join(",")}) ORDER BY sort_order`,
        )
        .bind(...chunk)
        .all<DivisionRow>()
    ).results;
    for (const r of rows) {
      const arr = byParent.get(r.parent_id!);
      const node = { kind: r.kind, number: r.number, heading: r.heading, path: r.path };
      if (arr) arr.push(node);
      else byParent.set(r.parent_id!, [node]);
    }
  }
  for (const l of livres) {
    const node: OutlineNode = {
      kind: l.kind,
      number: l.number,
      heading: l.heading,
      path: l.path,
      children: byParent.get(l.id) ?? [],
    };
    const arr = out.get(l.law_id);
    if (arr) arr.push(node);
    else out.set(l.law_id, [node]);
  }
  return out;
}

export interface SubjectSummary {
  id: string;
  label_fr: string;
  label_en: string | null;
  kind: string;
  description_fr: string | null;
  description_en: string | null;
  laws_count: number;
  divisions_count: number;
  domains: string[];
}

export async function listSubjects(
  db: D1Database,
  env: CorpusGateEnv = {},
): Promise<SubjectSummary[]> {
  const m = masqueLawId(env, "sm.law_id");
  const rows = (
    await db
      .prepare(
        `SELECT s.id, s.label_fr, s.label_en, s.kind, s.description_fr, s.description_en,
              COUNT(DISTINCT sm.law_id) AS laws_count,
              COALESCE(SUM(CASE WHEN sm.division_path <> '' THEN 1 ELSE 0 END), 0) AS divisions_count,
              GROUP_CONCAT(DISTINCT ls.domain) AS domains_csv
       FROM subjects s
       LEFT JOIN subject_map sm ON sm.subject_id = s.id ${m}
       LEFT JOIN laws ls ON ls.id = sm.law_id
       GROUP BY s.id, s.label_fr, s.label_en, s.kind, s.description_fr, s.description_en
       ORDER BY s.kind, s.id`,
      )
      .all<
        Omit<SubjectSummary, "domains"> & {
          domains_csv: string | null;
        }
      >()
  ).results;
  return rows.map(({ domains_csv, ...rest }) => ({
    ...rest,
    domains: domains_csv
      ? domains_csv
          .split(",")
          .filter(Boolean)
          .sort((a, b) => ALL_DOMAINS.indexOf(a as LawDomain) - ALL_DOMAINS.indexOf(b as LawDomain))
      : [],
  }));
}

export interface RelationRow {
  from_law_id: string;
  to_law_id: string;
  rel_type: string;
  source: string;
  weight: number;
  in_corpus: number;
  note: string | null;
}

export interface RelationEdge extends RelationRow {
  direction: "out" | "in";
  other_id: string;
  other_name: string | null;
}

export async function relatedLaws(
  db: D1Database,
  lawId: string,
  relType: string | undefined,
  direction: "out" | "in" | "both",
  lang: Lang = "fr",
  env: CorpusGateEnv = {},
): Promise<RelationEdge[]> {
  const typeClause = relType ? "AND rel_type = ?" : "";
  const edges: RelationEdge[] = [];
  if (direction === "out" || direction === "both") {
    const rows = (
      await db
        .prepare(
          `SELECT * FROM law_relations WHERE from_law_id = ? ${typeClause} ${masqueAutreBout(env, "to_law_id")}`,
        )
        .bind(...(relType ? [lawId, relType] : [lawId]))
        .all<RelationRow>()
    ).results;
    edges.push(
      ...rows.map((r) => ({
        ...r,
        direction: "out" as const,
        other_id: r.to_law_id,
        other_name: null,
      })),
    );
  }
  if (direction === "in" || direction === "both") {
    const rows = (
      await db
        .prepare(
          `SELECT * FROM law_relations WHERE to_law_id = ? ${typeClause} ${masqueAutreBout(env, "from_law_id")}`,
        )
        .bind(...(relType ? [lawId, relType] : [lawId]))
        .all<RelationRow>()
    ).results;
    edges.push(
      ...rows.map((r) => ({
        ...r,
        direction: "in" as const,
        other_id: r.from_law_id,
        other_name: null,
      })),
    );
  }
  const ids = [...new Set(edges.filter((e) => e.in_corpus).map((e) => e.other_id))];
  if (ids.length) {
    const rows = (
      await db
        .prepare(
          `SELECT id, name_fr, name_en FROM laws WHERE id IN (${ids.map(() => "?").join(",")}) ` +
            `${masqueLawId(env, "id")}`,
        )
        .bind(...ids)
        .all<{ id: string; name_fr: string; name_en: string | null }>()
    ).results;
    const byId = new Map(
      rows.map((r) => [r.id, (lang === "en" ? r.name_en : r.name_fr) || r.name_fr]),
    );
    for (const e of edges) e.other_name = byId.get(e.other_id) ?? null;
  }
  return edges.sort(
    (a, b) =>
      (a.source === "cure" ? 0 : 1) - (b.source === "cure" ? 0 : 1) ||
      b.weight - a.weight ||
      a.other_id.localeCompare(b.other_id),
  );
}

export interface ArticleJoined extends ArticleRow {
  d_kind: string | null;
  d_number: string | null;
  d_heading: string | null;
}

export async function getArticle(
  db: D1Database,
  lawId: string,
  lang: Lang,
  article: string,
): Promise<ArticleJoined | null> {
  return db
    .prepare(
      `SELECT ${ARTICLE_COLS.split(", ")
        .map((c) => `a.${c}`)
        .join(", ")},
              d.kind AS d_kind, d.number AS d_number, d.heading AS d_heading
       FROM articles a
       LEFT JOIN divisions d ON a.division_id = d.id
       WHERE a.law_id = ? AND a.lang = ? AND a.number = ?`,
    )
    .bind(lawId, lang, article)
    .first<ArticleJoined>();
}

function effectiveNearestSortKey(article: string, dbSortKey?: number): number {
  const sk = sortKeyOf(article);
  if (sk !== DISPOSITION_SORT_BASE) return sk;
  if (
    dbSortKey != null &&
    dbSortKey > 0 &&
    dbSortKey < DISPOSITION_SORT_BASE &&
    /^\d/.test(article)
  ) {
    const head = article.split("-")[0];
    const hsk = sortKeyOf(head);
    if (hsk < DISPOSITION_SORT_BASE) return hsk;
  }
  return sk;
}

function trailingIntOf(s: string): number | null {
  const m = /(\d+)$/.exec(s);
  return m ? parseInt(m[1], 10) : null;
}

export async function nearestArticles(
  db: D1Database,
  lawId: string,
  lang: Lang,
  target: number | string,
  limit = 5,
): Promise<string[]> {
  const targetKey = typeof target === "string" ? effectiveNearestSortKey(target) : target;
  const targetTrailing = typeof target === "string" ? trailingIntOf(target) : null;
  const rows = (
    await db
      .prepare(
        "SELECT number, sort_key FROM articles WHERE law_id = ? AND lang = ? ORDER BY sort_key, id",
      )
      .bind(lawId, lang)
      .all<{ number: string; sort_key: number }>()
  ).results;

  const isNonNumericTarget = typeof target === "string" && !/^\d/.test(target.trim());
  const foldedTarget = isNonNumericTarget ? normalize(target) : "";

  return rows
    .map((r) => {
      const k = effectiveNearestSortKey(r.number, r.sort_key);
      const dist = Math.abs(k - targetKey);
      const dispDist =
        targetKey === DISPOSITION_SORT_BASE &&
        k === DISPOSITION_SORT_BASE &&
        targetTrailing !== null
          ? Math.abs((trailingIntOf(r.number) ?? Number.MAX_SAFE_INTEGER) - targetTrailing)
          : 0;
      const isPseudo = r.sort_key === 0 || r.sort_key >= DISPOSITION_SORT_BASE ? 0 : 1;
      let textTier = 3;
      if (isNonNumericTarget && isPseudo === 0) {
        const fn = normalize(r.number);
        if (fn === foldedTarget) textTier = 0;
        else if (fn.startsWith(foldedTarget)) textTier = 1;
        else if (fn.includes(foldedTarget) || foldedTarget.includes(fn)) textTier = 2;
      }
      return { number: r.number, sortKey: r.sort_key, dist, dispDist, isPseudo, textTier };
    })
    .sort(
      (a, b) =>
        (isNonNumericTarget ? a.isPseudo - b.isPseudo || a.textTier - b.textTier : 0) ||
        a.dist - b.dist ||
        a.dispDist - b.dispDist ||
        a.sortKey - b.sortKey ||
        a.number.localeCompare(b.number),
    )
    .slice(0, limit)
    .map((r) => r.number);
}

export interface BoundRef {
  key: number;
  id: number | null;
  exists?: boolean;
}

function legacySortKeyOf(article: string): number {
  if (
    article === "préliminaire" ||
    article === "preambule" ||
    article === "preamble" ||
    article === "note-preliminaire"
  ) {
    return 0;
  }
  const parts = article.split(".");
  if (!SORT_COMP_RE.test(parts[0] ?? "")) return DISPOSITION_SORT_BASE;
  const comps = parts.slice(0, 5);
  let k = 0;
  for (const p of comps) {
    const m = /^(\d+)/.exec(p);
    k = k * 1000 + (m ? parseInt(m[1], 10) : 0);
  }
  for (let i = comps.length; i < 5; i++) k *= 1000;
  return Math.min(DISPOSITION_SORT_BASE - 1, k);
}

export async function boundRef(
  db: D1Database,
  lawId: string,
  lang: Lang,
  number: string,
): Promise<BoundRef> {
  const row = await db
    .prepare("SELECT sort_key, id FROM articles WHERE law_id=? AND lang=? AND number=?")
    .bind(lawId, lang, number)
    .first<{ sort_key: number; id: number }>();
  if (row) {
    const reel = row.sort_key > 0 && row.sort_key < DISPOSITION_SORT_BASE;
    return { key: row.sort_key, id: reel ? row.id : null, exists: true };
  }
  if (!SORT_COMP_RE.test(number.split(".")[0] ?? "")) {
    return { key: sortKeyOf(number), id: null, exists: false };
  }
  const sample = await db
    .prepare(
      `SELECT number, sort_key FROM articles
       WHERE law_id=? AND lang=? AND sort_key > 0 AND sort_key < ${DISPOSITION_SORT_BASE}
       LIMIT 1`,
    )
    .bind(lawId, lang)
    .first<{ number: string; sort_key: number }>();
  const usesLegacy = sample != null && sample.sort_key !== sortKeyOf(sample.number);
  return {
    key: usesLegacy ? legacySortKeyOf(number) : sortKeyOf(number),
    id: null,
    exists: false,
  };
}

const ARTICLE_COLS = "id, law_id, lang, number, division_path, text, history, repealed, links";

export async function articlesByRange(
  db: D1Database,
  lawId: string,
  lang: Lang,
  from: BoundRef,
  to: BoundRef,
  page: Page,
): Promise<{ rows: ArticleRow[]; total: number; resolution: "document" | "cle" }> {
  if (from.id != null && to.id != null) {
    const [lo, hi] = from.id <= to.id ? [from.id, to.id] : [to.id, from.id];
    const filtre =
      `law_id=? AND lang=? AND id BETWEEN ? AND ?` +
      ` AND sort_key > 0 AND sort_key < ${DISPOSITION_SORT_BASE}`;
    const total = (await db
      .prepare(`SELECT COUNT(*) AS n FROM articles WHERE ${filtre}`)
      .bind(lawId, lang, lo, hi)
      .first<{ n: number }>())!.n;
    const rows = (
      await db
        .prepare(
          `SELECT ${ARTICLE_COLS} FROM articles WHERE ${filtre} ORDER BY id LIMIT ? OFFSET ?`,
        )
        .bind(lawId, lang, lo, hi, page.limit, page.offset)
        .all<ArticleRow>()
    ).results;
    return { rows, total, resolution: "document" };
  }
  const [lo, hi] = from.key <= to.key ? [from.key, to.key] : [to.key, from.key];
  const total = (await db
    .prepare(
      "SELECT COUNT(*) AS n FROM articles WHERE law_id=? AND lang=? AND sort_key BETWEEN ? AND ?",
    )
    .bind(lawId, lang, lo, hi)
    .first<{ n: number }>())!.n;
  const rows = (
    await db
      .prepare(
        `SELECT ${ARTICLE_COLS} FROM articles WHERE law_id=? AND lang=? AND sort_key BETWEEN ? AND ?
       ORDER BY sort_key, id LIMIT ? OFFSET ?`,
      )
      .bind(lawId, lang, lo, hi, page.limit, page.offset)
      .all<ArticleRow>()
  ).results;
  return { rows, total, resolution: "cle" };
}

export async function articlesByNumbers(
  db: D1Database,
  lawId: string,
  lang: Lang,
  numbers: string[],
): Promise<ArticleRow[]> {
  if (numbers.length === 0) return [];
  const allRows: Array<ArticleRow & { sort_key: number }> = [];
  for (let i = 0; i < numbers.length; i += 90) {
    const chunk = numbers.slice(i, i + 90);
    const placeholders = chunk.map(() => "?").join(",");
    const chunkRows = (
      await db
        .prepare(
          `SELECT ${ARTICLE_COLS}, sort_key FROM articles WHERE law_id=? AND lang=? AND number IN (${placeholders})
       ORDER BY sort_key, id`,
        )
        .bind(lawId, lang, ...chunk)
        .all<ArticleRow & { sort_key: number }>()
    ).results;
    allRows.push(...chunkRows);
  }
  allRows.sort((a, b) => a.sort_key - b.sort_key || a.id - b.id);
  return allRows.map(({ sort_key: _sk, ...rest }) => rest);
}

export async function getDivision(
  db: D1Database,
  lawId: string,
  lang: Lang,
  by: { path?: string; id?: number },
): Promise<DivisionRow | null> {
  if (by.id != null) {
    return db
      .prepare("SELECT * FROM divisions WHERE id=? AND law_id=? AND lang=?")
      .bind(by.id, lawId, lang)
      .first<DivisionRow>();
  }
  return db
    .prepare("SELECT * FROM divisions WHERE law_id=? AND lang=? AND path=?")
    .bind(lawId, lang, by.path ?? "")
    .first<DivisionRow>();
}

export async function childDivisions(db: D1Database, parentId: number): Promise<DivisionRow[]> {
  return (
    await db
      .prepare("SELECT * FROM divisions WHERE parent_id=? ORDER BY sort_order")
      .bind(parentId)
      .all<DivisionRow>()
  ).results;
}

export async function articlesInDivision(
  db: D1Database,
  lawId: string,
  lang: Lang,
  path: string,
  page: Page,
  includeText: boolean,
): Promise<{ rows: Partial<ArticleRow>[]; total: number }> {
  const sub = subtreeClause("division_path");
  const subBinds = subtreeBinds(path);
  const total = (await db
    .prepare(`SELECT COUNT(*) AS n FROM articles WHERE law_id=? AND lang=? AND ${sub}`)
    .bind(lawId, lang, ...subBinds)
    .first<{ n: number }>())!.n;
  const cols = includeText
    ? "number, division_path, text, history, repealed, links"
    : "number, division_path, repealed, links";
  const rows = (
    await db
      .prepare(
        `SELECT ${cols} FROM articles WHERE law_id=? AND lang=? AND ${sub}
       ORDER BY sort_key, id LIMIT ? OFFSET ?`,
      )
      .bind(lawId, lang, ...subBinds, page.limit, page.offset)
      .all<Partial<ArticleRow>>()
  ).results;
  return { rows, total };
}

export interface StructureNode {
  path: string;
  division_id: number;
  kind: string;
  number: string | null;
  heading: string | null;
  repealed: number;
  children: StructureNode[];
}

export async function getStructure(
  db: D1Database,
  lawId: string,
  lang: Lang,
  rootPath?: string,
  depth?: number,
): Promise<StructureNode[]> {
  const COLS = "id, law_id, lang, path, kind, number, heading, repealed, parent_id";
  let rows: DivisionRow[];
  if (rootPath) {
    rows = (
      await db
        .prepare(
          `SELECT ${COLS} FROM divisions WHERE law_id=? AND lang=? AND ${subtreeClause("path")} ORDER BY sort_order`,
        )
        .bind(lawId, lang, ...subtreeBinds(rootPath))
        .all<DivisionRow>()
    ).results;
  } else {
    rows = (
      await db
        .prepare(`SELECT ${COLS} FROM divisions WHERE law_id=? AND lang=? ORDER BY sort_order`)
        .bind(lawId, lang)
        .all<DivisionRow>()
    ).results;
  }
  const byId = new Map<number, StructureNode>();
  for (const r of rows) {
    byId.set(r.id, {
      path: r.path,
      division_id: r.id,
      kind: r.kind,
      number: r.number,
      heading: r.heading,
      repealed: r.repealed,
      children: [],
    });
  }
  const roots: StructureNode[] = [];
  const inScope = new Set(rows.map((r) => r.id));
  for (const r of rows) {
    const node = byId.get(r.id)!;
    if (r.parent_id != null && inScope.has(r.parent_id)) {
      byId.get(r.parent_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  if (depth != null && depth >= 0) pruneDepth(roots, depth);
  return roots;
}

function pruneDepth(nodes: StructureNode[], depth: number): void {
  for (const n of nodes) {
    if (depth <= 1) n.children = [];
    else pruneDepth(n.children, depth - 1);
  }
}

export interface AmbiguousLaw {
  id: string;
  official_cite: string;
  name_fr: string;
}

export interface ParsedCitation {
  law: string | null;
  article: string | null;
  law_source: "chapitre" | "abreviation" | "defaut" | null;
  chapitre_inconnu: string | null;
  hors_corpus: string | null;
  ambigu: AmbiguousLaw[] | null;
  plage_fin?: string | null;
  alinea?: string | null;
}

function chapterRegex(chapter: string): RegExp {
  const esc = [...chapter]
    .filter((c) => !/\s/.test(c))
    .map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s*");
  const regGuard = /,\s*r\./i.test(chapter) ? "" : "(?!\\s*(?:,|\\s)\\s*r\\.\\s*[0-9])";
  return new RegExp(`(?<![A-Za-z0-9-])${esc}(?![A-Za-z0-9-])(?!\\.\\d)${regGuard}`, "i");
}

const CHAPITRE_EXPLICITE =
  /\b(?:c\.|ch\.|chapitres?|chapters?)\s*([A-Za-z]{1,6}-[0-9][0-9.]*(?:(?:\s*,\s*|\s+)r\.\s*[0-9][0-9.]*)?)/i;

const MARQUEUR_ARTICLE =
  /(?:(?:\barticles?\b|\barts?\.|\bparagraphes?\b|\bpara\.|\bpar\.|\bdir\.|\br[eè]gles?\b|\brules?\b|(?<![A-Za-zÀ-ÿ0-9.])a\.|(?<![A-Za-zÀ-ÿ0-9.])ss?\.)\s*|§\s*)(\d+[A-Za-z]?(?:\.\d+[A-Za-z]?)*(?![A-Za-z0-9]))/i;

const AMF_PAIRS: Record<string, { regId: string; igId: string }> = {
  "31-103": { regId: "v-1.1-r.10", igId: "amf-ig-31-103" },
  "45-106": { regId: "v-1.1-r.21", igId: "amf-ig-45-106" },
  "51-102": { regId: "v-1.1-r.24", igId: "amf-ig-51-102" },
};
const AMF_REG_IDS = new Set(Object.values(AMF_PAIRS).map((p) => p.regId));

const AUTRES_DISTRICTS_QC =
  /\b(?:laval|longueuil|sherbrooke|gatineau|trois[- ]rivieres|rimouski|saguenay|chicoutimi|alma|terrebonne|joliette|saint[- ]jerome|st[- ]jerome|saint[- ]hyacinthe|st[- ]hyacinthe|drummond|drummondville|granby|victoriaville|shawinigan|valleyfield|salaberry|sorel|thetford(?:[- ]mines)?|roberval|sept[- ]iles|baie[- ]comeau|val[- ]d['’ ]?or|val[- ]dor|amos|rouyn(?:[- ]noranda)?|abitibi|outaouais|estrie|mauricie|laurentides|lanaudiere|monteregie|bas[- ]saint[- ]laurent|gaspe|gaspesie|bonaventure|charlevoix|beauce|frontenac|megantic|lac[- ]megantic|arthabaska|richelieu|iberville|bedford|saint[- ]francois|st[- ]francois|kamouraska|mingan|labelle|hull|pontiac|temiscamingue|chaudiere|appalaches|beauharnois|mont[- ]laurier|cowansville|la\s+malbaie|malbaie|perce|montmagny|riviere[- ]du[- ]loup|matane|chibougamau|amqui|new\s+carlisle|campbell['’]?s\s+bay|havre[- ]saint[- ]pierre|havre[- ]st[- ]pierre|sainte[- ]anne[- ]des[- ]monts|ste[- ]anne[- ]des[- ]monts|saint[- ]jean[- ]sur[- ]richelieu|st[- ]jean[- ]sur[- ]richelieu|saint[- ]joseph[- ]de[- ]beauce|st[- ]joseph[- ]de[- ]beauce|saint[- ]maurice|st[- ]maurice|la\s+tuque|ville[- ]marie|iles[- ]de[- ]la[- ]madeleine|chandler|dolbeau|jonquiere|brossard|repentigny|blainville|saint[- ]eustache|st[- ]eustache|magog)\b/i;

const DISTRICT_NON_MTL =
  /\bdistrict(?:\s+(?:judiciaire|judicial))?\s+(?:de\s+l['’]|de\s+la\s+|de\s+|du\s+|des\s+|d['’]|of\s+)(?!montreal\b|mtl\b)[a-z]/i;
const DIVISION_QCCS_NON_INGERE =
  /\bdivision\s+(?:de\s+l['’]|de\s+la\s+|de\s+|du\s+|des\s+|d['’]|of\s+)(?!montreal\b|mtl\b|quebec\b|qc\b|pratique\b|famille\b|civile?\b|criminel(?:le)?\b|commerciale?\b|faillite\b|administrat|appel\b|jeunesse\b)[a-z]/i;

const PSEUDO_ANNEXE_TIRETS =
  /\b(annexe(?:-[a-z0-9]+)+|formulaire(?:-[a-z0-9]+)+|formule(?:-[a-z0-9]+)+|form(?:-[a-z0-9]+)+)\b/i;
const ANNEXE_PREPS = "(?:de|du|des|d['’]|au|aux|a|sur|la|le|les|l['’])";
const ANNEXE_LAW_NOUNS =
  "(?:loi|code|reglements?|regulations?|act|policy|directives?|mode|cour|court|qccs|qccq|qcca|rlrq|cqlr|lrq|rsq|lrc|cpc|ccq|c\\.|ch\\.|instruction\\s+generale|instructions?\\s+generales?\\s+(?:31-103|45-106|51-102|relati))";
const ANNEXE_STOP_COMMON = `(?:de|du|des|au|aux|a|sur)\\s+(?:la\\s+|le\\s+|les\\s+|l['’]\\s*)?${ANNEXE_LAW_NOUNS}|(?:de|du|des|d['’]|au|aux|a)\\s+l['’]\\s*(?:instruction|act|amf|article|annexe)|(?:la|le|les)\\s+${ANNEXE_LAW_NOUNS}|${ANNEXE_PREPS}(?=(?:\\s+${ANNEXE_PREPS})*\\s*(?:[,;.)\\]]|$))|d['’](?:instruction|act|amf|une?\\s+(?:loi|reglement|directive))|l['’](?:instruction|act|amf|autorite)|et|and|of|in|for|from|by|on|to|the|relati(?:f|ve)|pris|en|art|par|para|regle|rule|dir|sous|avec|dans|directives?|reglements?|regulations?|instruction\\s+generale|policy|mode|cour|court|qccs|qccq|partie|part|rubrique|item|appendice|appendix`;
const ANNEXE_STOP_MOTS = `${ANNEXE_STOP_COMMON}|instructions\\s+generales(?=\\s*(?:31-103|45-106|51-102|relati(?:f|ve)s?)\\b)`;
const ANNEXE_STOP_MOTS_IG = `${ANNEXE_STOP_COMMON}|instructions?\\s+generales?`;
const ANNEXE_MOT = "[a-z0-9]+(?:-[a-z0-9]+)*(?:['’][a-z0-9]+)?";
function buildPseudoAnnexeEspace(stopMots: string): RegExp {
  const stop = `(?:${stopMots})\\b`;
  const subdiv = `(?:(?:\\s*,\\s*|\\s+)(?:partie|part|rubrique|item|appendice|appendix)\\s+[a-z0-9]+|\\s*,\\s*(?:indications?|instructions?(?!\\s+generales?\\s*(?:31-103|45-106|51-102|relati)|\\s+generale\\b)(?:\\s+generales?)?)(?:\\s+(?:a\\s+l['’]\\s*)?(?!${stop})${ANNEXE_MOT})*(?:\\s+\\d+)?|\\s*,\\s*[a-z]\\.\\s+(?!c\\.|ch\\.|r\\.|${stop})[a-z]{2,}[a-z0-9]*(?:\\s+(?:[–—-]\\s+)?(?:a\\s+l['’]\\s*)?(?!${stop})${ANNEXE_MOT})*)*`;
  const corps = `(?:(?:division|district)\\s+[a-z0-9]+|${ANNEXE_MOT}(?:\\s+(?:a\\s+l['’]\\s*)?(?!${stop})${ANNEXE_MOT})*)${subdiv}`;
  return new RegExp(`\\b(annexe|schedule|formulaire|formule|form)\\s+(${corps})\\b`, "i");
}
const PSEUDO_ANNEXE_ESPACE = buildPseudoAnnexeEspace(ANNEXE_STOP_MOTS);
const PSEUDO_ANNEXE_ESPACE_IG = buildPseudoAnnexeEspace(ANNEXE_STOP_MOTS_IG);
const PSEUDO_NOTE_PRELIM = /\bnote[- ]pr[ée]liminaire\b/i;
const PSEUDO_PRELIM = /\b(?:dispositions?\s+pr[ée]liminaires?|pr[ée]liminaire)\b/i;
const PSEUDO_FINALES = /\b(?:dispositions?\s+finales?|finales)\b/i;
const PSEUDO_PREAMBULE = /\b(pr[ée]ambule|preamble)\b/i;
const STRIP_PSEUDO_NORM = new RegExp(
  `\\b(?:(?:annexe|formulaire|formule|form)(?:-[a-z0-9]+)+|${PSEUDO_ANNEXE_ESPACE.source}|note[- ]preliminaire|dispositions?[- ]preliminaires?|dispositions?[- ]finales?)\\b`,
  "gi",
);

function extractPseudoArticle(rest: string, isIG = false): string | null {
  const restNorm = stripAccents(rest);
  const mTirets = restNorm.match(PSEUDO_ANNEXE_TIRETS);
  if (mTirets) return mTirets[1].toLowerCase();
  const ORDRE_ANNEXE: Record<string, string> = {
    premiere: "1",
    first: "1",
    "1ere": "1",
    "1st": "1",
    deuxieme: "2",
    second: "2",
    "2e": "2",
    "2nd": "2",
    troisieme: "3",
    third: "3",
    "3e": "3",
    "3rd": "3",
    quatrieme: "4",
    fourth: "4",
    "4e": "4",
    "4th": "4",
    cinquieme: "5",
    fifth: "5",
    "5e": "5",
    "5th": "5",
    sixieme: "6",
    sixth: "6",
    "6e": "6",
    "6th": "6",
  };
  const mOrd = restNorm.match(
    /\b(premiere|first|1ere|1st|deuxieme|second|2e|2nd|troisieme|third|3e|3rd|quatrieme|fourth|4e|4th|cinquieme|fifth|5e|5th|sixieme|sixth|6e|6th)\s+(?:annexe|schedule)\b/i,
  );
  if (mOrd) return `annexe-${ORDRE_ANNEXE[mOrd[1].toLowerCase()]}`;
  if (
    /^\s*(?:[,;:\s]*)(?:annexe|schedule)(?:\s+(?:de(?:\s+(?:la|le|les|l['’]))?|du|des|to(?:\s+the)?|of(?:\s+the)?))+\s*(?:[,;.)\]]|$)/i.test(
      restNorm,
    )
  ) {
    return "annexe";
  }
  const mEspace = restNorm.match(isIG ? PSEUDO_ANNEXE_ESPACE_IG : PSEUDO_ANNEXE_ESPACE);
  if (mEspace) {
    const prefix = mEspace[1].toLowerCase() === "schedule" ? "annexe" : mEspace[1].toLowerCase();
    const corps = mEspace[2]
      .toLowerCase()
      .replace(/\ba\s+l['’]\s*/g, "")
      .replace(/\s*[–—]\s*/g, "-")
      .replace(/\.\s+/g, "-")
      .replace(/['’]/g, "-")
      .replace(/\s*,\s*/g, "-")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    return `${prefix}-${corps}`;
  }
  if (PSEUDO_NOTE_PRELIM.test(restNorm)) return "note-preliminaire";
  if (PSEUDO_PRELIM.test(restNorm)) return "préliminaire";
  if (PSEUDO_FINALES.test(restNorm)) return "finales";
  const mPreamb = restNorm.match(PSEUDO_PREAMBULE);
  if (mPreamb) return mPreamb[1].toLowerCase() === "preamble" ? "preamble" : "preambule";
  if (/\b(?:annexe|schedule)\b/i.test(restNorm)) return "annexe";
  return null;
}

const STRIP_DATES_ET_SALLES = [
  /\b(?:(?:R\.?\s*L\.?\s*R\.?\s*Q\.?|L\.?\s*R\.?\s*Q\.?|R\.?\s*S\.?\s*Q\.?|C\.?\s*Q\.?\s*L\.?\s*R\.?|RLRQ|CQLR)(?:\s*,)?\s+)?(?:c\.|ch\.|chapitres?|chapters?)\s*[A-Za-z]{1,6}-[0-9][0-9.]*(?:(?:\s*,\s*|\s+)r\.\s*[0-9.]+)?/gi,
  /(?<![A-Za-z0-9-])(?:31-103|45-106|51-102)(?![A-Za-z0-9-])/gi,
  /\b30\s*(?:&|et|and|-)\s*31\s*Vict\.?(?:\s*,\s*(?:c\.|ch\.)\s*3)?(?:\s*\(\s*(?:R\.-U\.|U\.K\.)\s*\))?/gi,
  /\b(?:Schedule\s+B\s+to\s+(?:the\s+)?Canada\s+Act\s+1982|Annexe\s+B\s+de\s+la\s+Loi\s+de\s+1982\s+sur\s+le\s+Canada)(?:\s*\(\s*(?:U\.K\.|R\.-U\.)\s*\))?/gi,
  /\b1982\s*,\s*(?:c\.|ch\.)\s*11\b(?:\s*\(\s*(?:U\.K\.|R\.-U\.)\s*\))?/gi,
  /\b(?:L\.?\s*R\.?\s*C\.?|R\.?\s*S\.?\s*C\.?)\s*,?\s*\(?\s*1985\s*\)?\s*,\s*app(?:endice|endix|\.)?\s*II\s*,\s*n(?:o|º|°)\.?\s*(?:5|44)\b/gi,
  /\(\s*(?:R\.-U\.|U\.K\.)\s*\)/gi,
  /\(\s*(?:Salles?|Rooms?)\s+\d+(?:\.\d+)?(?:(?:\s*,\s*|\s+(?:et|and)\s+)\d+(?:\.\d+)?)*\s*\)/gi,
  /\b(?:Salles|Rooms)\s+\d+(?:\.\d+)?(?:(?:\s*,\s*\d+(?:\.\d+)?)*\s+(?:et|and)\s+\d+(?:\.\d+)?|(?:\s*,\s*\d+(?:\.\d+)?)*(?=\s*(?:[,;—–-])\s*(?:\d|par|dir|art|r[eè]gle|rule|annexe|formulaire|schedule|§)))?/gi,
  /\b(?:Salle|Room)\s+\d+(?:\.\d+)?\b/gi,
  /\b\d{1,2}\s*(?:er|\u1d49\u02b3|re|\u02b3\u1d49|e|\u1d49)?\s+(?:janvier|f[ée]vrier|mars|avril|mai|juin|juillet|ao[ûu]t|septembre|octobre|novembre|d[ée]cembre)\s+(?:19|20)\d{2}\b/gi,
  /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:st|nd|rd|th)?,?\s*(?:19|20)\d{2}\b/gi,
  /\b(?:19|20)\d{2}-\d{2}-\d{2}\b/g,
  /\(\s*(?:19|20)\d{2}\s*\)/g,
];

const toAmbiguous = (l: LawRow): AmbiguousLaw => ({
  id: l.id,
  official_cite: l.official_cite,
  name_fr: l.name_fr,
});

function citesInstructionGenerale(norm: string): boolean {
  if (
    /\b(?:i\.?\s*g\.?|ig|policy\s+statements?|companion\s+polic(?:y|ies))\b/i.test(norm) ||
    /\b(?:31-103|45-106|51-102)\s*cp\b/i.test(norm)
  ) {
    return true;
  }
  const m = norm.match(/\binstructions?\s+generales?\b/i);
  if (!m || m.index === undefined) return false;
  const before = norm.slice(0, m.index);
  const after = norm.slice(m.index + m[0].length);
  if (!/\b(?:annexe|schedule|formulaire)\b/i.test(before)) return true;
  return (
    /(?:de\s+l['’]\s*|des\s+|l['’]\s*)$/i.test(before) ||
    /^\s*(?:31-103|45-106|51-102|relati(?:f|ve)s?)\b/i.test(after)
  );
}

export function parseCitation(citation: string, laws: LawRow[]): ParsedCitation {
  const norm = normalize(citation);
  const amfMatch = norm.match(/(?<![0-9-])(31-103|45-106|51-102)(?![0-9-])/);
  const isIG = citesInstructionGenerale(norm);
  const isReg =
    /\b(?:reglements?|regl\b\.?|regulations?|reg\b\.?|national\s+instruments?|multilateral\s+instruments?|normes?\s+(?:canadiennes?|multilaterales?)|ni|rlrq|cqlr|lrq|rsq)\b|\b(?:r\.?\s*l\.?\s*r\.?\s*q\.?|l\.?\s*r\.?\s*q\.?|r\.?\s*s\.?\s*q\.?|c\.?\s*q\.?\s*l\.?\s*r\.?|n\.?\s*i\.)(?=\s|,|\)|$)/i.test(
      norm,
    );
  const citesV11Act = /\b(?:loi\s+sur\s+les\s+valeurs\s+mobilieres|securities\s+act)\b/i.test(norm);

  let law: string | null = null;
  let lawSource: ParsedCitation["law_source"] = null;
  let bestLen = 0;
  let motif: RegExp | null = null;
  for (const l of laws) {
    if (isIG && AMF_REG_IDS.has(l.id)) continue;
    if (amfMatch && (!citesV11Act || isIG || isReg) && l.id === "v-1.1") continue;
    const cands = [l.official_cite, l.official_cite_en ?? ""];
    for (const rawCite of cands) {
      const chap = rawCite.replace(/^(?:RLRQ|CQLR),\s*c\.\s*/i, "").trim();
      if (!chap || chap.length <= bestLen) continue;
      const re = chapterRegex(chap);
      if (re.test(citation)) {
        bestLen = chap.length;
        law = l.id;
        lawSource = "chapitre";
        motif = re;
      }
    }
  }
  const ancienCpc =
    !law &&
    /c\.?\s*p\.?\s*c\.?|\bcpc\b|code\s+de\s+proc[ée]dure\s+civile|code\s+of\s+civil\s+procedure|\bc\.?\s*c\.?\s*p\.?\b/i.test(
      citation,
    ) &&
    /\bancien(?:ne)?s?\b|\bold\b|\bformer\b|\b1965\b/i.test(citation);

  let ambigu: AmbiguousLaw[] | null = null;
  let extraStrip: RegExp | null = null;
  if (!law && !ancienCpc) {
    const byId = new Map(laws.map((l) => [l.id, l]));

    let igFromRegCite: string | null = null;
    if (isIG && !amfMatch) {
      for (const pair of Object.values(AMF_PAIRS)) {
        const regRow = byId.get(pair.regId);
        if (!regRow) continue;
        for (const rawCite of [regRow.official_cite, regRow.official_cite_en ?? ""]) {
          const chap = rawCite.replace(/^(?:RLRQ|CQLR),\s*c\.\s*/i, "").trim();
          const re = chap ? chapterRegex(chap) : null;
          if (re?.test(citation)) {
            igFromRegCite = pair.igId;
            motif = re;
            break;
          }
        }
        if (igFromRegCite) break;
      }
    }

    if (amfMatch) {
      const pair = AMF_PAIRS[amfMatch[1]];
      extraStrip = /(?<![A-Za-z0-9-])(?:31-103|45-106|51-102)(?![A-Za-z0-9-])/gi;
      if (isIG) {
        if (byId.has(pair.igId)) {
          law = pair.igId;
          lawSource = "abreviation";
        }
      } else if (isReg) {
        if (byId.has(pair.regId)) {
          law = pair.regId;
          lawSource = "abreviation";
        }
      } else {
        const cands = [byId.get(pair.regId), byId.get(pair.igId)].filter((x): x is LawRow =>
          Boolean(x),
        );
        if (cands.length > 1) ambigu = cands.map(toAmbiguous);
        else if (cands.length === 1) {
          law = cands[0].id;
          lawSource = "abreviation";
        }
      }
    } else if (igFromRegCite) {
      if (byId.has(igFromRegCite)) {
        law = igFromRegCite;
        lawSource = "abreviation";
      }
    } else if (
      /\b(?:directives?\s+(?:de\s+la\s+)?(?:c\.?\s*s\.?|cour\s+superieure|juge\s+en\s+chef\s+associee)|directives?\s+(?:of\s+(?:the\s+)?)?superior\s+court|superior\s+court(?:\s+of\s+quebec)?\s+directives?|superior\s+court\s+of\s+quebec|dir\.?\s+c\.?\s*s\.?|s\.?\s*c\.?\s*directives?|directives?\s+(?:du\s+)?district\s+de\s+montreal|directives?\s+(?:de\s+la\s+)?division\s+de\s+(?:montreal|quebec)|qccs)\b/i.test(
        norm,
      )
    ) {
      const qccsLaws = laws.filter((l) => l.id.startsWith("qccs-"));
      if (qccsLaws.length > 0) {
        const normSansCour = norm
          .replace(STRIP_PSEUDO_NORM, " ")
          .replace(/\bcour\s+superieure\s+du\s+quebec\b/g, "cour superieure")
          .replace(/\bsuperior\s+court\s+of\s+quebec\b/g, "superior court")
          .replace(
            /\b(?:directives?\s+(?:of\s+(?:the\s+)?)?superior\s+court|superior\s+court\s+directives?)\b/g,
            " ",
          )
          .replace(/\bc\.?\s*s\.?\s+du\s+quebec\b/g, "c.s.")
          .replace(/\bs\.?\s*c\.?\s+of\s+quebec\b/g, "s.c.");
        if (
          AUTRES_DISTRICTS_QC.test(normSansCour) ||
          DISTRICT_NON_MTL.test(normSansCour) ||
          DIVISION_QCCS_NON_INGERE.test(normSansCour)
        ) {
          law = null;
        } else {
          const hasDist = /\bdistrict\b/.test(normSansCour);
          const hasDiv = /\bdivision\b/.test(normSansCour);
          const hasMtl = /\bmontreal\b|\bmtl\b/.test(normSansCour);
          const hasQc = /\bquebec\b|\bqc\b/.test(normSansCour);
          const hasJugeAssociee = /\bjuge\s+en\s+chef\s+associee\b/.test(normSansCour);
          let cands = qccsLaws;
          if (hasMtl) {
            cands = cands.filter((l) =>
              /montreal|mtl/.test(normalize(`${l.id} ${l.name_fr} ${l.official_cite}`)),
            );
          }
          if (hasQc) {
            cands = cands.filter((l) =>
              /quebec|\bqc\b/.test(normalize(`${l.id} ${l.name_fr} ${l.official_cite}`)),
            );
          }
          if (hasDist) {
            cands = cands.filter((l) =>
              /district|\bdist\b/.test(normalize(`${l.id} ${l.name_fr} ${l.official_cite}`)),
            );
          }
          if (hasDiv) {
            cands = cands.filter((l) =>
              /division|\bdiv\b/.test(normalize(`${l.id} ${l.name_fr} ${l.official_cite}`)),
            );
          }
          if (hasJugeAssociee && !hasMtl) {
            cands = cands.filter((l) =>
              /juge\s+en\s+chef\s+associee/.test(
                normalize(`${l.id} ${l.name_fr} ${l.official_cite}`),
              ),
            );
          }
          if (cands.length === 1) {
            law = cands[0].id;
            lawSource = "abreviation";
          } else if (cands.length > 1) {
            ambigu = cands.map(toAmbiguous);
          }
        }
      }
    } else if (
      /\b(?:(?:directives?|dir\.?)\s+(?:de\s+la\s+)?(?:c\.?\s*q\.?|cour\s+du\s+quebec)|mode\s+de\s+fonctionnement(?:\s+(?:de\s+la\s+)?(?:c\.?\s*q\.?|cour\s+du\s+quebec))?(?=.*(?:division\s+de\s+pratique|pratique\s+(?:civile|admin)|salles?\s+(?:2\.06|2\.02|13\.09)))|mode\s+de\s+fonctionnement\s+(?:de\s+la\s+)?(?:c\.?\s*q\.?|cour\s+du\s+quebec)|qccq|liste\s+commune\s+de\s+jurisprudence|(?:c\.?\s*q\.?\s+|cour\s+du\s+quebec\s+)?regles\s+simplifiees(?:\s+particulieres)?)\b/i.test(
        norm,
      )
    ) {
      const qccqLaws = laws.filter((l) => l.id.startsWith("qccq-"));
      if (qccqLaws.length > 0) {
        const normSansCourQccq = norm
          .replace(STRIP_PSEUDO_NORM, " ")
          .replace(/\bcour\s+du\s+quebec\b/g, "cour")
          .replace(/\bcourt\s+of\s+quebec\b/g, "court")
          .replace(/\bc\.?\s*q\.?\s+du\s+quebec\b/g, "c.q.")
          .replace(/\bc\.?\s*q\.?\s+of\s+quebec\b/g, "c.q.");
        if (AUTRES_DISTRICTS_QC.test(normSansCourQccq) || DISTRICT_NON_MTL.test(normSansCourQccq)) {
          law = null;
        } else {
          let cands = qccqLaws;
          const narrow = (re: RegExp) => {
            cands = cands.filter((l) =>
              re.test(
                normalize(`${l.id} ${l.name_fr} ${l.official_cite}`).replace(
                  /\bcour\s+du\s+quebec\b/g,
                  "cour",
                ),
              ),
            );
          };
          if (/regles\s+simplifiees|particulieres/.test(normSansCourQccq))
            narrow(/simplifiees|particulieres/);
          if (
            /daa|jurisprudence|liste\s+commune|division\s+administrative\s+et\s+d['’]?\s*appel/.test(
              normSansCourQccq,
            )
          )
            narrow(/daa|jurisprudence|division\s+administrative\s+et\s+d['’]?\s*appel/);
          if (/pratique\s+civile|prat\.?\s*civile|2\.06|2\.02/.test(normSansCourQccq))
            narrow(/prat.*civile|2\.06|2\.02/);
          if (/pratique\s+admin|prat\.?\s*admin|13\.09/.test(normSansCourQccq))
            narrow(/prat.*admin|13\.09/);
          if (/\bmontreal\b|\bmtl\b/.test(normSansCourQccq)) narrow(/montreal|mtl/);
          if (/\bquebec\b|\bqc\b/.test(normSansCourQccq)) narrow(/quebec|\bqc\b/);
          if (cands.length === 1) {
            law = cands[0].id;
            lawSource = "abreviation";
          } else if (cands.length > 1) {
            ambigu = cands.map(toAmbiguous);
          }
        }
      }
    } else if (/c\.?\s*p\.?\s*c\.?|cpc/i.test(citation)) {
      law = "cpc";
      lawSource = "abreviation";
    } else if (
      /c\.?\s*c\.?\s*q\.?|ccq|\b(?:code\s+civil\s+du\s+qu[ée]bec|civil\s+code\s+of\s+qu[ée]bec)\b/i.test(
        citation,
      )
    ) {
      law = "ccq";
      lawSource = "abreviation";
      motif = /\b(?:code\s+civil\s+du\s+qu[ée]bec|civil\s+code\s+of\s+qu[ée]bec)\b/i;
    } else if (
      /\b(?:l\.?\s*i\.?\s*(?:\(\s*(?:qu[ée]bec|qc)\s*\)|qu[ée]bec|qc)|loi\s+d['’]interpr[ée]tation\s+(?:du\s+qu[ée]bec|\(\s*qu[ée]bec\s*\))|qu[ée]bec\s+interpretation\s+act)(?![A-Za-zÀ-ÿ0-9])/i.test(
        citation,
      )
    ) {
      if (byId.has("i-16")) {
        law = "i-16";
        lawSource = "abreviation";
        motif =
          /\b(?:l\.?\s*i\.?\s*(?:\(\s*(?:qu[ée]bec|qc)\s*\)|qu[ée]bec|qc)|loi\s+d['’]interpr[ée]tation\s+(?:du\s+qu[ée]bec|\(\s*qu[ée]bec\s*\))|qu[ée]bec\s+interpretation\s+act)(?![A-Za-zÀ-ÿ0-9])/i;
      }
    } else if (
      /\b(?:l\.?\s*i\.?\s*(?:f[ée]d[ée]rale?|\(\s*(?:canada|ca|f[ée]d\.?)\s*\)|canada|ca|f[ée]d\.?)|loi\s+d['’]interpr[ée]tation\s+(?:f[ée]d[ée]rale|\(\s*canada\s*\))|federal\s+interpretation\s+act|interpretation\s+act\s*\(\s*canada\s*\))(?![A-Za-zÀ-ÿ0-9])/i.test(
        citation,
      )
    ) {
      if (byId.has("ca-i-21")) {
        law = "ca-i-21";
        lawSource = "abreviation";
        motif =
          /\b(?:l\.?\s*i\.?\s*(?:f[ée]d[ée]rale?|\(\s*(?:canada|ca|f[ée]d\.?)\s*\)|canada|ca|f[ée]d\.?)|loi\s+d['’]interpr[ée]tation\s+(?:f[ée]d[ée]rale|\(\s*canada\s*\))|federal\s+interpretation\s+act|interpretation\s+act\s*\(\s*canada\s*\))(?![A-Za-zÀ-ÿ0-9])/i;
      }
    } else if (
      /\b(?:lois\s+constitutionnelles\s+de\s+1867\s+[àa]\s+1982|constitution\s+acts\s*,?\s*1867\s+to\s+1982)\b/i.test(
        citation,
      )
    ) {
      const cands = [byId.get("ca-const-1867"), byId.get("ca-const-1982")].filter(
        (x): x is LawRow => Boolean(x),
      );
      if (cands.length > 1) {
        ambigu = cands.map(toAmbiguous);
      } else if (cands.length === 1) {
        law = cands[0].id;
        lawSource = "abreviation";
      }
      motif =
        /\b(?:lois\s+constitutionnelles\s+de\s+1867\s+[àa]\s+1982|constitution\s+acts\s*,?\s*1867\s+to\s+1982)\b/i;
    } else if (
      /\b(?:charte\s+canadienne(?:\s+des\s+droits(?:\s+et\s+libert[ée]s)?)?|canadian\s+charter(?:\s+of\s+rights(?:\s+and\s+freedoms)?)?|charter\s+of\s+rights(?:\s+and\s+freedoms)?|annexe\s+b\s+de\s+la\s+loi\s+de\s+1982\s+sur\s+le\s+canada|schedule\s+b\s+to\s+(?:the\s+)?canada\s+act\s+1982)\b|(?<![A-Za-zÀ-ÿ0-9.])(?:C\.?\s*c\.?\s*d\.?\s*l\.?|L\.?\s*C\.?\s*\(?\s*1982\s*\)?(?:\s*,\s*(?:c\.|ch\.)\s*11\b)?(?:\s*\(\s*(?:R\.-U\.|U\.K\.)\s*\))?(?!\s*,\s*(?:c\.|ch\.)\s*(?!11\b)\d))(?!\.?[A-Za-zÀ-ÿ0-9])|\b(?:L\.?\s*R\.?\s*C\.?|R\.?\s*S\.?\s*C\.?)\s*,?\s*\(?\s*1985\s*\)?\s*,\s*app(?:endice|endix|\.)?\s*II\s*,\s*n(?:o|º|°)\.?\s*44\b/i.test(
        citation,
      )
    ) {
      if (byId.has("ca-const-1982")) {
        law = "ca-const-1982";
        lawSource = "abreviation";
      }
      motif =
        /\b(?:charte\s+canadienne(?:\s+des\s+droits(?:\s+et\s+libert[ée]s)?)?|canadian\s+charter(?:\s+of\s+rights(?:\s+and\s+freedoms)?)?|charter\s+of\s+rights(?:\s+and\s+freedoms)?|annexe\s+b\s+de\s+la\s+loi\s+de\s+1982\s+sur\s+le\s+canada|schedule\s+b\s+to\s+(?:the\s+)?canada\s+act\s+1982)\b|(?<![A-Za-zÀ-ÿ0-9.])(?:C\.?\s*c\.?\s*d\.?\s*l\.?|L\.?\s*C\.?\s*\(?\s*1982\s*\)?(?:\s*,\s*(?:c\.|ch\.)\s*11\b)?(?:\s*\(\s*(?:R\.-U\.|U\.K\.)\s*\))?(?!\s*,\s*(?:c\.|ch\.)\s*(?!11\b)\d))(?!\.?[A-Za-zÀ-ÿ0-9])|\b(?:L\.?\s*R\.?\s*C\.?|R\.?\s*S\.?\s*C\.?)\s*,?\s*\(?\s*1985\s*\)?\s*,\s*app(?:endice|endix|\.)?\s*II\s*,\s*n(?:o|º|°)\.?\s*44\b/i;
    } else if (
      /\b(?:acte\s+de\s+l['’]am[ée]rique\s+du\s+nord\s+britannique(?:\s*,?\s*1867)?|british\s+north\s+america\s+act(?:\s*,?\s*1867)?|b\.?\s*n\.?\s*a\.?\s+act(?:\s*,?\s*1867)?)\b|(?<![A-Za-zÀ-ÿ0-9.])(?:A\.?\s*A\.?\s*N\.?\s*B\.?|B\.?\s*N\.?\s*A\.?|L\.?\s*C\.?\s*\(?\s*1867\s*\)?(?:\s*,\s*(?:c\.|ch\.)\s*3\b)?(?:\s*\(\s*(?:R\.-U\.|U\.K\.)\s*\))?(?!\s*,\s*(?:c\.|ch\.)\s*(?!3\b)\d))(?!\.?[A-Za-zÀ-ÿ0-9])|\b30\s*(?:&|et|and|-)\s*31\s*Vict\.?(?:\s*,\s*(?:c\.|ch\.)\s*3)?(?:\s*\(\s*(?:R\.-U\.|U\.K\.)\s*\))?|\b(?:L\.?\s*R\.?\s*C\.?|R\.?\s*S\.?\s*C\.?)\s*,?\s*\(?\s*1985\s*\)?\s*,\s*app(?:endice|endix|\.)?\s*II\s*,\s*n(?:o|º|°)\.?\s*5\b/i.test(
        citation,
      )
    ) {
      if (byId.has("ca-const-1867")) {
        law = "ca-const-1867";
        lawSource = "abreviation";
      }
      motif =
        /\b(?:acte\s+de\s+l['’]am[ée]rique\s+du\s+nord\s+britannique(?:\s*,?\s*1867)?|british\s+north\s+america\s+act(?:\s*,?\s*1867)?|b\.?\s*n\.?\s*a\.?\s+act(?:\s*,?\s*1867)?)\b|(?<![A-Za-zÀ-ÿ0-9.])(?:A\.?\s*A\.?\s*N\.?\s*B\.?|B\.?\s*N\.?\s*A\.?|L\.?\s*C\.?\s*\(?\s*1867\s*\)?(?:\s*,\s*(?:c\.|ch\.)\s*3\b)?(?:\s*\(\s*(?:R\.-U\.|U\.K\.)\s*\))?(?!\s*,\s*(?:c\.|ch\.)\s*(?!3\b)\d))(?!\.?[A-Za-zÀ-ÿ0-9])|\b30\s*(?:&|et|and|-)\s*31\s*Vict\.?(?:\s*,\s*(?:c\.|ch\.)\s*3)?(?:\s*\(\s*(?:R\.-U\.|U\.K\.)\s*\))?|\b(?:L\.?\s*R\.?\s*C\.?|R\.?\s*S\.?\s*C\.?)\s*,?\s*\(?\s*1985\s*\)?\s*,\s*app(?:endice|endix|\.)?\s*II\s*,\s*n(?:o|º|°)\.?\s*5\b/i;
    } else if (
      /\b(?:charte\s+(?:des\s+droits\s+et\s+libert[ée]s\s+de\s+la\s+personne|qu[ée]b[ée]coise(?:\s+des\s+droits(?:\s+et\s+libert[ée]s)?)?)|(?:qu[ée]bec\s+)?charter\s+of\s+human\s+rights(?:\s+and\s+freedoms)?|qu[ée]bec\s+charter)\b|(?<![A-Za-zÀ-ÿ0-9.])(?:L\.?\s*)?C\.?\s*d\.?\s*l\.?\s*p\.?(?!\.?[A-Za-zÀ-ÿ0-9])/i.test(
        citation,
      )
    ) {
      if (byId.has("c-12")) {
        law = "c-12";
        lawSource = "abreviation";
      }
      motif =
        /\b(?:charte\s+(?:des\s+droits\s+et\s+libert[ée]s\s+de\s+la\s+personne|qu[ée]b[ée]coise(?:\s+des\s+droits(?:\s+et\s+libert[ée]s)?)?)|(?:qu[ée]bec\s+)?charter\s+of\s+human\s+rights(?:\s+and\s+freedoms)?|qu[ée]bec\s+charter)\b|(?<![A-Za-zÀ-ÿ0-9.])(?:L\.?\s*)?C\.?\s*d\.?\s*l\.?\s*p\.?(?!\.?[A-Za-zÀ-ÿ0-9])/i;
    } else if (
      /\b(?:charte\s+de\s+la\s+langue\s+fran[çc]aise|charter\s+of\s+the\s+french\s+language|(?:loi|bill)\s+101)\b|(?<![A-Za-zÀ-ÿ0-9.])C\.?\s*l\.?\s*f\.?(?!\.?[A-Za-zÀ-ÿ0-9])/i.test(
        citation,
      )
    ) {
      if (byId.has("c-11")) {
        law = "c-11";
        lawSource = "abreviation";
      }
      motif =
        /\b(?:charte\s+de\s+la\s+langue\s+fran[çc]aise|charter\s+of\s+the\s+french\s+language|(?:loi|bill)\s+101)\b|(?<![A-Za-zÀ-ÿ0-9.])C\.?\s*l\.?\s*f\.?(?!\.?[A-Za-zÀ-ÿ0-9])/i;
    } else if (
      /\b(?:charte|charter)\b/i.test(norm) &&
      !/\b(?:charte\s+(?:de\s+la\s+(?:langue|ville)|municipale|des\s+droits\s+du\s+contribuable)|charter\s+of\s+(?:the\s+(?:french|city)|taxpayer))\b/i.test(
        norm,
      )
    ) {
      const cands = [byId.get("c-12"), byId.get("ca-const-1982")].filter((x): x is LawRow =>
        Boolean(x),
      );
      if (cands.length > 1) {
        ambigu = cands.map(toAmbiguous);
      } else if (cands.length === 1) {
        law = cands[0].id;
        lawSource = "abreviation";
      }
      motif = /\b(?:charte|charter)\b/i;
    } else if (
      /(?<![A-Za-zÀ-ÿ0-9.])L\.?\s*I\.?(?!\.?[A-Za-zÀ-ÿ0-9])|\bloi\s+d['’]interpr[ée]tation\b|\binterpretation\s+act\b/i.test(
        citation,
      )
    ) {
      const cands = [byId.get("i-16"), byId.get("ca-i-21")].filter((x): x is LawRow => Boolean(x));
      if (cands.length > 1) {
        ambigu = cands.map(toAmbiguous);
      } else if (cands.length === 1) {
        law = cands[0].id;
        lawSource = "abreviation";
      }
      motif =
        /(?<![A-Za-zÀ-ÿ0-9.])L\.?\s*I\.?(?!\.?[A-Za-zÀ-ÿ0-9])|\bloi\s+d['’]interpr[ée]tation\b|\binterpretation\s+act\b/i;
    } else {
      const FEDERAL_ABBREVS: ReadonlyArray<readonly [string, RegExp]> = [
        [
          "ca-c-50",
          /(?<![A-Za-zÀ-ÿ0-9.])(?:L\.?\s*R\.?\s*C\.?\s*E\.?\s*C\.?\s*A\.?|C\.?\s*L\.?\s*P\.?\s*A\.?)(?!\.?[A-Za-zÀ-ÿ0-9])/i,
        ],
        [
          "ca-p-8.6",
          /(?<![A-Za-zÀ-ÿ0-9.])(?:L\.?\s*P\.?\s*R\.?\s*P\.?\s*D\.?\s*E\.?|P\.?\s*I\.?\s*P\.?\s*E\.?\s*D\.?\s*A\.?)(?!\.?[A-Za-zÀ-ÿ0-9])/i,
        ],
        [
          "ca-c-7.75",
          /\b(?:loi\s+canadienne\s+sur\s+les\s+organisations\s+[àa]\s+but\s+non\s+lucratif|canada\s+not-?for-?profit\s+corporations?\s+act)\b|(?<![A-Za-zÀ-ÿ0-9.])(?:L\.?\s*C\.?\s*O\.?\s*B\.?\s*N\.?\s*L\.?|C\.?\s*N\.?\s*C\.?\s*A\.?)(?!\.?[A-Za-zÀ-ÿ0-9])|(?:c\.|ch\.|chapitres?|chapters?)\s*C-7\.75(?![0-9.-])/i,
        ],
        [
          "ca-c-38.8",
          /\b(?:loi\s+r[ée]glementant\s+certaines\s+drogues\s+et\s+autres\s+substances|controlled\s+drugs\s+and\s+substances\s+act)\b|(?<![A-Za-zÀ-ÿ0-9.])(?:L\.?\s*R\.?\s*C\.?\s*D\.?\s*A\.?\s*S\.?|C\.?\s*D\.?\s*S\.?\s*A\.?)(?!\.?[A-Za-zÀ-ÿ0-9])|(?:(?:L\.?\s*C\.?|S\.?\s*C\.?)[^,\n]*,\s*)?(?:c\.|ch\.|chapitres?|chapters?)\s*C-38\.8(?![0-9.-])/i,
        ],
        [
          "ca-y-1.5",
          /\b(?:loi\s+sur\s+le\s+syst[èe]me\s+de\s+justice\s+p[ée]nale\s+pour\s+les\s+adolescents|youth\s+criminal\s+justice\s+act)\b|(?<![A-Za-zÀ-ÿ0-9.])(?:L\.?\s*S\.?\s*J\.?\s*P\.?\s*A\.?|Y\.?\s*C\.?\s*J\.?\s*A\.?)(?!\.?[A-Za-zÀ-ÿ0-9])|(?:(?:L\.?\s*C\.?|S\.?\s*C\.?)[^,\n]*,\s*)?(?:c\.|ch\.|chapitres?|chapters?)\s*Y-1\.5(?![0-9.-])/i,
        ],
        [
          "ca-c-46",
          /\b(?:code\s+criminel(?:\s+du\s+canada)?|criminal\s+code(?:\s+of\s+canada)?)\b|(?<![A-Za-zÀ-ÿ0-9.])(?:C\.?\s*cr\.?|Cr\.?\s*C\.?)(?!\.?[A-Za-zÀ-ÿ0-9])|(?:(?:L\.?\s*R\.?\s*C\.?|R\.?\s*S\.?\s*C\.?)[^,\n]*,\s*)?(?:c\.|ch\.|chapitres?|chapters?)\s*C-46(?![0-9.-])/i,
        ],
        [
          "ca-dors-2002-156",
          /\b(?:r[èe]gles\s+de\s+la\s+cour\s+supr[êe]me\s+du\s+canada|rules\s+of\s+the\s+supreme\s+court\s+of\s+canada)\b|(?<![A-Za-zÀ-ÿ0-9.])(?:R\.?\s*C\.?\s*S\.?\s*C\.?|R\.?\s*S\.?\s*C\.?\s*C\.?)(?!\.?[A-Za-zÀ-ÿ0-9])/i,
        ],
        [
          "ca-c-44",
          /(?<![A-Za-zÀ-ÿ0-9.])(?:L\.?\s*C\.?\s*S\.?\s*A\.?|C\.?\s*B\.?\s*C\.?\s*A\.?)(?!\.?[A-Za-zÀ-ÿ0-9])/i,
        ],
        [
          "ca-c-36",
          /(?<![A-Za-zÀ-ÿ0-9.])(?:L\.?\s*A\.?\s*C\.?\s*C\.?|C\.?\s*C\.?\s*A\.?\s*A\.?)(?!\.?[A-Za-zÀ-ÿ0-9])/i,
        ],
        [
          "ca-crc-368",
          /(?<![A-Za-zÀ-ÿ0-9.])(?:R\.?\s*G\.?\s*F\.?\s*I\.?|B\.?\s*I\.?\s*G\.?\s*R\.?)(?!\.?[A-Za-zÀ-ÿ0-9])/i,
        ],
        [
          "ca-b-3",
          /(?<![A-Za-zÀ-ÿ0-9.])(?:L\.?\s*F\.?\s*I\.?|B\.?\s*I\.?\s*A\.?)(?!\.?[A-Za-zÀ-ÿ0-9])/i,
        ],
        ["ca-c-42", /(?<![A-Za-zÀ-ÿ0-9.])L\.?\s*D\.?\s*A\.?(?!\.?[A-Za-zÀ-ÿ0-9])/i],
        [
          "ca-p-4",
          /\b(?:loi\s+sur\s+les\s+brevets|patent\s+act)\b|(?:(?:L\.?\s*R\.?\s*C\.?|R\.?\s*S\.?\s*C\.?)[^,\n]*,\s*)?(?:c\.|ch\.|chapitres?|chapters?)\s*P-4(?![0-9.-])/i,
        ],
        [
          "ca-i-9",
          /\b(?:loi\s+sur\s+les\s+dessins\s+industriels|industrial\s+design\s+act)\b|(?:(?:L\.?\s*R\.?\s*C\.?|R\.?\s*S\.?\s*C\.?)[^,\n]*,\s*)?(?:c\.|ch\.|chapitres?|chapters?)\s*I-9(?![0-9.-])/i,
        ],
        [
          "ca-t-13",
          /(?<![A-Za-zÀ-ÿ0-9.])(?:L\.?\s*M\.?\s*C\.?|T\.?\s*M\.?\s*A\.?)(?!\.?[A-Za-zÀ-ÿ0-9])/i,
        ],
        [
          "ca-l-2",
          /\b(?:code\s+canadien\s+du\s+travail|canada\s+labour\s+code)\b|(?<![A-Za-zÀ-ÿ0-9.])(?:C\.?\s*c\.?\s*t\.?|C\.?\s*L\.?\s*C\.?)(?!\.?[A-Za-zÀ-ÿ0-9])/i,
        ],
        ["ca-c-5", /(?<![A-Za-zÀ-ÿ0-9.])C\.?\s*E\.?\s*A\.?(?!\.?[A-Za-zÀ-ÿ0-9])/i],
        [
          "ca-f-7",
          /(?<![A-Za-zÀ-ÿ0-9.])(?:L\.?\s*C\.?\s*F\.?|F\.?\s*C\.?\s*A\.?)(?!\.?[A-Za-zÀ-ÿ0-9])/i,
        ],
        [
          "ca-s-26",
          /(?<![A-Za-zÀ-ÿ0-9.])(?:L\.?\s*C\.?\s*S\.?|S\.?\s*C\.?\s*A\.?)(?!\.?[A-Za-zÀ-ÿ0-9])/i,
        ],
        [
          "ca-b-4",
          /(?<![A-Za-zÀ-ÿ0-9.])(?:L\.\s*L\.\s*C\.?|B\.?\s*E\.?\s*A\.?)(?!\.?[A-Za-zÀ-ÿ0-9])/i,
        ],
        [
          "ca-dors-98-106",
          /(?<![A-Za-zÀ-ÿ0-9.])(?:R\.?\s*C\.?\s*F\.?|F\.?\s*C\.?\s*R\.?)(?!\.?[A-Za-zÀ-ÿ0-9])/i,
        ],
        [
          "ca-d-3.4",
          /(?<![A-Za-zÀ-ÿ0-9.])L\.?\s*D\.?(?!\.?[A-Za-zÀ-ÿ0-9])(?!\s+[A-Za-z]\.(?!\s*\d))/i,
        ],
        [
          "a-3.001",
          /\bloi\s+sur\s+les\s+accidents\s+du\s+travail\s+et\s+les\s+maladies\s+professionnelles\b|(?<![A-Za-zÀ-ÿ0-9.])(?:L\.?\s*A\.?\s*T\.?\s*M\.?\s*P\.?|A\.?\s*I\.?\s*A\.?\s*O\.?\s*D\.?)(?!\.?[A-Za-zÀ-ÿ0-9])/i,
        ],
        [
          "p-41.1",
          /\bloi\s+sur\s+la\s+protection\s+du\s+territoire\s+et\s+des\s+activit[ée]s\s+agricoles\b|(?<![A-Za-zÀ-ÿ0-9.])L\.?\s*P\.?\s*T\.?\s*A\.?\s*A\.?(?!\.?[A-Za-zÀ-ÿ0-9])/i,
        ],
        [
          "t-15.1",
          /\bloi\s+instituant\s+le\s+tribunal\s+administratif\s+du\s+travail\b|(?<![A-Za-zÀ-ÿ0-9.])L\.?\s*I\.?\s*T\.?\s*A\.?\s*T\.?(?!\.?[A-Za-zÀ-ÿ0-9])/i,
        ],
        [
          "s-2.1",
          /\bloi\s+sur\s+la\s+sant[ée]\s+et\s+la\s+s[ée]curit[ée]\s+du\s+travail\b|(?<![A-Za-zÀ-ÿ0-9.])(?:L\.?\s*S\.?\s*S\.?\s*T\.?|A\.?\s*O\.?\s*H\.?\s*S\.?)(?!\.?[A-Za-zÀ-ÿ0-9])/i,
        ],
        [
          "a-25",
          /\b(?:loi\s+sur\s+l['’]assurance\s+automobile|automobile\s+insurance\s+act)\b|(?<![A-Za-zÀ-ÿ0-9.])L\.?\s*A\.?\s*A\.?(?!\.?[A-Za-zÀ-ÿ0-9])/i,
        ],
        [
          "q-2",
          /\b(?:loi\s+sur\s+la\s+qualit[ée]\s+de\s+l['’]environnement|environment\s+quality\s+act)\b|(?<![A-Za-zÀ-ÿ0-9.])(?:L\.?\s*Q\.?\s*E\.?|E\.?\s*Q\.?\s*A\.?)(?!\.?[A-Za-zÀ-ÿ0-9])/i,
        ],
        [
          "a-19.1",
          /\bloi\s+sur\s+l['’]am[ée]nagement\s+et\s+l['’]urbanisme\b|(?<![A-Za-zÀ-ÿ0-9.])L\.?\s*A\.?\s*U\.?(?!\.?[A-Za-zÀ-ÿ0-9])/i,
        ],
        [
          "c-47.1",
          /\b(?:loi\s+sur\s+les\s+comp[ée]tences\s+municipales|municipal\s+powers\s+act)\b|(?<![A-Za-zÀ-ÿ0-9.])L\.?\s*C\.?\s*M\.?(?!\.?[A-Za-zÀ-ÿ0-9])/i,
        ],
        [
          "c-27",
          /\b(?:code\s+du\s+travail(?:\s+du\s+qu[ée]bec)?|qu[ée]bec\s+labour\s+code)\b|(?<![A-Za-zÀ-ÿ0-9.])C\.?\s*t\.?(?!\.?[A-Za-zÀ-ÿ0-9])(?!\s*-)/i,
        ],
      ];
      for (const [id, re] of FEDERAL_ABBREVS) {
        if (re.test(citation)) {
          if (byId.has(id)) {
            law = id;
            lawSource = "abreviation";
            motif = re;
          }
          break;
        }
      }
    }
  }

  let rest = motif ? citation.replace(motif, " ") : citation;
  if (extraStrip) rest = rest.replace(extraStrip, " ");
  for (const stripRe of STRIP_DATES_ET_SALLES) rest = rest.replace(stripRe, " ");
  rest = rest.replace(
    /((?:\barticles?\b|\barts?\b\.?|\bparagraphes?\b|\bpara\.|\bpar\.|\bdir\.|\br[eè]gles?\b|\brules?\b|(?<![A-Za-zÀ-ÿ0-9.])a\.|(?<![A-Za-zÀ-ÿ0-9.])ss?\.|§)\s*)1(?:er|\u1d49\u02b3|re|\u02b3\u1d49)(?![A-Za-zÀ-ÿ0-9\u1d49\u02b3])/gi,
    "$11",
  );
  const rangeMatch =
    /(?:\b(?:articles?|arts?\.?|a\.|ss?\.)\s*)(\d+[A-Za-z]?(?:\.\d+[A-Za-z]?)*)\s*(?:[àa]|to|[–—-])\s*(\d+[A-Za-z]?(?:\.\d+[A-Za-z]?)*)\b|\b(\d+[A-Za-z]?(?:\.\d+[A-Za-z]?)*)\s+(?:[àa]|to)\s+(\d+[A-Za-z]?(?:\.\d+[A-Za-z]?)*)\b/i.exec(
      rest,
    );
  const plageFin = rangeMatch ? (rangeMatch[2] ?? rangeMatch[4] ?? null) : null;
  const alineaMatch =
    /(?:\b(?:articles?|arts?\.?|a\.|ss?\.)\s*\d+[A-Za-z]?(?:\.\d+[A-Za-z]?)*\s*,?\s*)\b(al\.?\s*\d+(?:\s*(?:et|[àa]|-)\s*\d+)?|alin[ée]as?\s+\d+|subpar\.?\s*\d+|par\.?\s*\d+°?)\b/i.exec(
      rest,
    );
  const alinea = alineaMatch?.[1]?.trim() ?? null;
  const article =
    rest.match(MARQUEUR_ARTICLE)?.[1] ??
    extractPseudoArticle(rest, isIG) ??
    rest.match(/(?<![A-Za-z0-9.-])(\d+[A-Za-z]?(?:\.\d+[A-Za-z]?)*(?![A-Za-z0-9-]))/)?.[1] ??
    null;

  let explicite = law || ambigu ? null : (citation.match(CHAPITRE_EXPLICITE)?.[1]?.trim() ?? null);
  if (
    amfMatch &&
    (!citesV11Act || isIG || isReg) &&
    explicite &&
    /^V-1\.1$/i.test(explicite) &&
    laws.some((l) => l.id === "v-1.1")
  ) {
    explicite = null;
  }

  const horsCorpus =
    law || ambigu ? null : ancienCpc || chapterRegex("C-25").test(citation) ? "C-25" : null;

  return {
    law,
    article,
    law_source: law ? lawSource : null,
    chapitre_inconnu: horsCorpus ? null : explicite,
    hors_corpus: horsCorpus,
    ambigu,
    plage_fin: plageFin,
    alinea,
  };
}

const DIVISION_PREFILTER_LIMIT = 2000;

export interface RelevanceData {
  subjects: SubjectLite[];
  subjectMap: SubjectMapLite[];
  laws: LawLite[];
  divisions: DivisionLite[];
  relations: RelationLite[];
  mappedHeadings: Map<string, { path: string; heading: string | null }>;
}

export async function loadRelevanceData(
  db: D1Database,
  tokens: string[],
  lang: Lang,
  env: CorpusGateEnv = {},
): Promise<RelevanceData> {
  const mLaw = masqueLawId(env, "law_id");
  const cLaws = clauseCorpus(env, "");
  const mId = cLaws ? `WHERE ${cLaws}` : "";
  const mFrom = masqueLawId(env, "from_law_id");
  const mTo = masqueAutreBout(env, "to_law_id");
  const [subjects, subjectMap, laws, relations] = await Promise.all([
    db
      .prepare(
        "SELECT id, label_fr, label_en, label_norm, description_fr, description_en FROM subjects",
      )
      .all<{
        id: string;
        label_fr: string;
        label_en: string | null;
        label_norm: string;
        description_fr: string | null;
        description_en: string | null;
      }>(),
    db
      .prepare(`SELECT subject_id, law_id, division_path FROM subject_map WHERE 1=1 ${mLaw}`)
      .all<SubjectMapLite>(),
    db
      .prepare(
        `SELECT id, name_fr, name_en, name_norm, fonction, domain, jurisdiction, forum FROM laws ${mId}`,
      )
      .all<{
        id: string;
        name_fr: string;
        name_en: string;
        name_norm: string | null;
        fonction: string | null;
        domain: string | null;
        jurisdiction: string | null;
        forum: string | null;
      }>(),
    db
      .prepare(
        `SELECT from_law_id, to_law_id, rel_type, source, in_corpus, note FROM law_relations ` +
          `WHERE (source = 'cure' OR rel_type = 'reglement-de') ${mFrom} ${mTo}`,
      )
      .all<RelationLite>(),
  ]);

  let divisions: DivisionLite[] = [];
  if (tokens.length) {
    const ors = tokens.map(() => "heading_norm LIKE ?").join(" OR ");
    divisions = (
      await db
        .prepare(
          `SELECT law_id, path, heading, heading_norm FROM divisions
         WHERE lang = ? AND heading_norm IS NOT NULL AND (${ors}) ${mLaw} LIMIT ?`,
        )
        .bind(lang, ...tokens.map((t) => `%${t}%`), DIVISION_PREFILTER_LIMIT)
        .all<DivisionLite>()
    ).results;
  }

  const mappedHeadings = new Map<string, { path: string; heading: string | null }>();
  const parLoi = new Map<string, string[]>();
  for (const m of subjectMap.results) {
    if (!m.division_path) continue;
    const arr = parLoi.get(m.law_id);
    if (arr) {
      if (!arr.includes(m.division_path)) arr.push(m.division_path);
    } else parLoi.set(m.law_id, [m.division_path]);
  }
  if (lang === "fr") {
    const paths = [...new Set([...parLoi.values()].flat())];
    if (paths.length) {
      const rows = (
        await db
          .prepare(
            `SELECT law_id, path, heading FROM divisions
           WHERE lang = 'fr' AND path IN (${paths.map(() => "?").join(",")})`,
          )
          .bind(...paths)
          .all<{ law_id: string; path: string; heading: string | null }>()
      ).results;
      for (const r of rows)
        mappedHeadings.set(`${r.law_id}|${r.path}`, { path: r.path, heading: r.heading });
    }
  } else {
    for (const [lawId, paths] of parLoi) {
      const t = await translatePaths(db, lawId, lang, paths);
      for (const [fr, cible] of t) mappedHeadings.set(`${lawId}|${fr}`, cible);
    }
  }

  const lawsLite: LawLite[] = laws.results.map((l) => ({
    id: l.id,
    name_fr: lang === "en" ? l.name_en || l.name_fr : l.name_fr,
    name_norm: lang === "en" ? normalize(l.name_en || l.name_fr) : l.name_norm,
    fonction: l.fonction,
    domain: l.domain ?? "core",
    jurisdiction: l.jurisdiction ?? "qc",
    forum: l.forum,
  }));

  const subjectsLite: SubjectLite[] = subjects.results.map((s) => ({
    id: s.id,
    label_fr: lang === "en" ? s.label_en || s.label_fr : s.label_fr,
    label_norm: lang === "en" ? normalize(s.label_en || s.label_fr) : s.label_norm,
    description_fr: lang === "en" ? s.description_en || s.description_fr : s.description_fr,
  }));

  return {
    subjects: subjectsLite,
    subjectMap: subjectMap.results,
    laws: lawsLite,
    divisions,
    relations: relations.results,
    mappedHeadings,
  };
}

export function scopeRelevanceData(
  data: RelevanceData,
  scope: { domains: readonly string[]; jurisdiction?: string; forum?: string },
): RelevanceData {
  const domainSet = new Set(scope.domains);
  const laws = data.laws.filter(
    (l) =>
      domainSet.has(l.domain ?? "core") &&
      (!scope.jurisdiction || (l.jurisdiction ?? "qc") === scope.jurisdiction) &&
      matchesForumScope(l.forum, scope.forum),
  );
  const allowedIds = new Set(laws.map((l) => l.id));
  return {
    subjects: data.subjects,
    subjectMap: data.subjectMap.filter((m) => allowedIds.has(m.law_id)),
    laws,
    divisions: data.divisions.filter((d) => allowedIds.has(d.law_id)),
    relations: data.relations.filter(
      (r) => allowedIds.has(r.from_law_id) && (!r.in_corpus || allowedIds.has(r.to_law_id)),
    ),
    mappedHeadings: data.mappedHeadings,
  };
}

export interface CrumbNode {
  path: string;
  kind: string;
  number: string | null;
  heading: string | null;
}

export async function breadcrumbChains(
  db: D1Database,
  lang: Lang,
  refs: { law_id: string; division_path: string }[],
): Promise<Map<string, CrumbNode[]>> {
  const byLaw = new Map<string, Set<string>>();
  for (const r of refs) {
    if (!r.division_path) continue;
    const segs = segmentsOf(r.division_path);
    let set = byLaw.get(r.law_id);
    if (!set) {
      set = new Set();
      byLaw.set(r.law_id, set);
    }
    for (let i = 1; i <= segs.length; i++) set.add(segs.slice(0, i).join("-"));
  }
  const nodes = new Map<string, CrumbNode>();
  for (const [law, paths] of byLaw) {
    const list = [...paths];
    for (let i = 0; i < list.length; i += 90) {
      const chunk = list.slice(i, i + 90);
      const rows = (
        await db
          .prepare(
            `SELECT path, kind, number, heading FROM divisions
           WHERE law_id = ? AND lang = ? AND path IN (${chunk.map(() => "?").join(",")})`,
          )
          .bind(law, lang, ...chunk)
          .all<CrumbNode>()
      ).results;
      for (const r of rows) nodes.set(`${law}|${r.path}`, r);
    }
    if (lang === "en") {
      const missing = list.filter((p) => !nodes.has(`${law}|${p}`));
      for (let i = 0; i < missing.length; i += 90) {
        const chunk = missing.slice(i, i + 90);
        const frRows = (
          await db
            .prepare(
              `SELECT path, kind, number, heading FROM divisions
             WHERE law_id = ? AND lang = ? AND path IN (${chunk.map(() => "?").join(",")})`,
            )
            .bind(law, "fr", ...chunk)
            .all<CrumbNode>()
        ).results;
        for (const r of frRows) nodes.set(`${law}|${r.path}`, r);
      }
    }
  }
  const out = new Map<string, CrumbNode[]>();
  for (const r of refs) {
    const segs = segmentsOf(r.division_path ?? "");
    const chain: CrumbNode[] = [];
    for (let i = 1; i <= segs.length; i++) {
      const n = nodes.get(`${r.law_id}|${segs.slice(0, i).join("-")}`);
      if (n) chain.push(n);
    }
    out.set(`${r.law_id}|${r.division_path}`, chain);
  }
  return out;
}

export async function lawNames(
  db: D1Database,
  ids: string[],
): Promise<Map<string, { name_fr: string; name_en: string }>> {
  if (!ids.length) return new Map();
  const rows = (
    await db
      .prepare(
        `SELECT id, name_fr, name_en FROM laws WHERE id IN (${ids.map(() => "?").join(",")})`,
      )
      .bind(...ids)
      .all<{ id: string; name_fr: string; name_en: string }>()
  ).results;
  return new Map(rows.map((r) => [r.id, { name_fr: r.name_fr, name_en: r.name_en }]));
}

export async function lawLangs(
  db: D1Database,
  lawId: string,
  env: CorpusGateEnv = {},
): Promise<Lang[]> {
  const rows = (
    await db
      .prepare(
        `SELECT DISTINCT lang FROM articles WHERE law_id = ? ${masqueLawId(env, "law_id")} ORDER BY lang`,
      )
      .bind(lawId)
      .all<{ lang: Lang }>()
  ).results;
  return rows.map((r) => r.lang);
}

export interface LawMeta {
  id: string;
  name_fr: string;
  name_en: string;
  source: LawSource;
  fonction: string | null;
  unit: string | null;
  domain?: string | null;
}

export async function lawMetas(
  db: D1Database,
  ids: string[],
  env: CorpusGateEnv = {},
): Promise<Map<string, LawMeta>> {
  if (!ids.length) return new Map();
  const rows = (
    await db
      .prepare(
        `SELECT id, name_fr, name_en, source, fonction, unit, domain FROM laws WHERE id IN (${ids.map(() => "?").join(",")}) ` +
          `${masqueLawId(env, "id")}`,
      )
      .bind(...ids)
      .all<LawMeta>()
  ).results;
  return new Map(rows.map((r) => [r.id, r]));
}

export interface NormativeRelation {
  direction: "out" | "in";
  other_id: string;
  other_name: string | null;
  rel_type: "preseance-sur" | "interprete";
  in_corpus: boolean;
  note: string | null;
  note_lang: "fr" | null;
}

export async function normativeRelations(
  db: D1Database,
  lawIds: string[],
  lang: Lang = "fr",
  env: CorpusGateEnv = {},
): Promise<Map<string, NormativeRelation[]>> {
  const out = new Map<string, NormativeRelation[]>();
  if (!lawIds.length) return out;
  const ph = lawIds.map(() => "?").join(",");
  const [outRows, inRows] = await Promise.all([
    db
      .prepare(
        `SELECT from_law_id, to_law_id, rel_type, in_corpus, note FROM law_relations ` +
          `WHERE rel_type IN ('preseance-sur', 'interprete') AND from_law_id IN (${ph}) ` +
          `${masqueLawId(env, "from_law_id")} ${masqueAutreBout(env, "to_law_id")}`,
      )
      .bind(...lawIds)
      .all<{
        from_law_id: string;
        to_law_id: string;
        rel_type: "preseance-sur" | "interprete";
        in_corpus: number;
        note: string | null;
      }>(),
    db
      .prepare(
        `SELECT from_law_id, to_law_id, rel_type, in_corpus, note FROM law_relations ` +
          `WHERE rel_type IN ('preseance-sur', 'interprete') AND to_law_id IN (${ph}) ` +
          `${masqueLawId(env, "to_law_id")} ${masqueAutreBout(env, "from_law_id")}`,
      )
      .bind(...lawIds)
      .all<{
        from_law_id: string;
        to_law_id: string;
        rel_type: "preseance-sur" | "interprete";
        in_corpus: number;
        note: string | null;
      }>(),
  ]);
  const otherIds = new Set<string>();
  for (const r of outRows.results) if (r.in_corpus) otherIds.add(r.to_law_id);
  for (const r of inRows.results) if (r.in_corpus) otherIds.add(r.from_law_id);
  const names = new Map<string, string>();
  if (otherIds.size) {
    const oids = [...otherIds];
    const nameRows = (
      await db
        .prepare(
          `SELECT id, name_fr, name_en FROM laws WHERE id IN (${oids.map(() => "?").join(",")}) ` +
            `${masqueLawId(env, "id")}`,
        )
        .bind(...oids)
        .all<{ id: string; name_fr: string; name_en: string | null }>()
    ).results;
    for (const r of nameRows) {
      names.set(r.id, (lang === "en" ? r.name_en : r.name_fr) || r.name_fr);
    }
  }
  const pushRel = (lawId: string, rel: NormativeRelation) => {
    const arr = out.get(lawId);
    if (arr) arr.push(rel);
    else out.set(lawId, [rel]);
  };
  for (const r of outRows.results) {
    pushRel(r.from_law_id, {
      direction: "out",
      other_id: r.to_law_id,
      other_name: names.get(r.to_law_id) ?? null,
      rel_type: r.rel_type,
      in_corpus: !!r.in_corpus,
      note: r.note,
      note_lang: r.note ? "fr" : null,
    });
  }
  for (const r of inRows.results) {
    pushRel(r.to_law_id, {
      direction: "in",
      other_id: r.from_law_id,
      other_name: names.get(r.from_law_id) ?? null,
      rel_type: r.rel_type,
      in_corpus: !!r.in_corpus,
      note: r.note,
      note_lang: r.note ? "fr" : null,
    });
  }
  return out;
}

export interface SearchHit {
  law_id: string;
  number: string;
  division_path: string;
  snippet: string;
  score?: number;
  semantic?: boolean;
  fonction?: string | null;
  hit_lang?: Lang;
}

export function ftsTokens(query: string): string[] {
  return query.normalize("NFC").match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu) ?? [];
}

function ligatureVariants(t: string): string[] {
  if (!/œ|æ|oe|ae/i.test(t)) return [t];
  const out = new Set<string>([t]);
  if (/œ|Œ/.test(t)) {
    out.add(t.replace(/œ/g, "oe").replace(/Œ/g, "OE"));
  }
  if (/oe/i.test(t)) {
    out.add(t.replace(/oe/g, "œ").replace(/OE/g, "Œ"));
  }
  if (/æ|Æ/.test(t)) {
    out.add(t.replace(/æ/g, "ae").replace(/Æ/g, "AE"));
  }
  if (/ae/i.test(t)) {
    out.add(t.replace(/ae/g, "æ").replace(/AE/g, "Æ"));
  }
  return [...out];
}

const quoteSingleTok = (t: string) => `"${t.replace(/"/g, '""')}"`;

const quoteTok = (t: string) => {
  const vars = ligatureVariants(t);
  if (vars.length === 1) return quoteSingleTok(vars[0]!);
  return `(${vars.map(quoteSingleTok).join(" OR ")})`;
};

const joinFtsTerms = (terms: string[]) =>
  terms.some((x) => x.startsWith("(")) ? terms.join(" AND ") : terms.join(" ");

export function toFtsQuery(query: string): string {
  return joinFtsTerms(ftsTokens(query).map(quoteTok));
}

export interface SearchOutcome {
  hits: SearchHit[];
  total: number;
  fallback: null | "widened" | { loo: string } | "or_relax" | "semantic";
  elsewhere: { total: number; hits: SearchHit[] } | null;
  divisions?: DivisionMatch[];
  otherDomains?: { domain: string; lexical_hits: number }[];
}

interface MatchScope {
  law?: string;
  notLaw?: string;
  domains?: readonly string[];
  jurisdiction?: string;
  forum?: string;
}

async function runMatch(
  db: D1Database,
  match: string,
  lang: Lang,
  scope: MatchScope,
  page: Page,
  withScore = false,
  env: CorpusGateEnv = {},
): Promise<{ hits: SearchHit[]; total: number }> {
  const clauses: string[] = [];
  const binds: unknown[] = [`{text marginal_note} : (${match})`, lang];
  if (scope.law) {
    clauses.push("AND articles_fts.law_id = ?");
    binds.push(scope.law);
  }
  if (scope.notLaw) {
    clauses.push("AND articles_fts.law_id <> ?");
    binds.push(scope.notLaw);
  }
  if (!scope.law) {
    const subConds: string[] = [];
    if (scope.domains && scope.domains.length > 0 && scope.domains.length < ALL_DOMAINS.length) {
      subConds.push(`lsub.domain IN (${scope.domains.map(() => "?").join(",")})`);
      binds.push(...scope.domains);
    }
    if (scope.jurisdiction) {
      subConds.push("lsub.jurisdiction = ?");
      binds.push(scope.jurisdiction);
    }
    if (scope.forum?.trim()) {
      subConds.push(forumScopeSqlClause("lsub"));
      binds.push(`%${scope.forum.trim()}%`);
    }
    if (subConds.length) {
      clauses.push(
        `AND articles_fts.law_id IN (SELECT lsub.id FROM laws lsub WHERE ${subConds.join(" AND ")})`,
      );
    }
  }
  const m = masqueLawId(env, "articles_fts.law_id");
  if (m) clauses.push(m);
  const where = `articles_fts MATCH ? AND articles_fts.lang = ? ${clauses.join(" ")}`;
  const totalRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM articles_fts WHERE ${where}`)
    .bind(...binds)
    .first<{ n: number }>();
  const weightExpr =
    `(CASE l.fonction WHEN 'directive' THEN ${FONCTION_WEIGHTS.directive} ` +
    `WHEN 'orientation' THEN ${FONCTION_WEIGHTS.orientation} ELSE 1.0 END)`;
  const bm25Expr = `bm25(articles_fts, 1.0, ${MARGINAL_NOTE_WEIGHT}, 0.0, 0.0, 0.0)`;
  const weightedBm25 =
    `(CASE WHEN ${bm25Expr} < 0 THEN ${bm25Expr} * ${weightExpr} ` +
    `ELSE ${bm25Expr} / ${weightExpr} END)`;
  const scoreCol = withScore ? `, ${weightedBm25} AS score` : "";
  const hits = (
    await db
      .prepare(
        `SELECT a.law_id, a.number, a.division_path, l.fonction AS fonction,
              snippet(articles_fts, 0, '[', ']', '…', 30) AS snippet${scoreCol}
       FROM articles_fts JOIN articles a ON a.id = articles_fts.rowid
       LEFT JOIN laws l ON l.id = a.law_id
       WHERE ${where}
       ORDER BY ${weightedBm25} LIMIT ? OFFSET ?`,
      )
      .bind(...binds, page.limit, page.offset)
      .all<SearchHit>()
  ).results;
  return { hits, total: totalRow?.n ?? 0 };
}

const RELAX_MIN_TERMS = 2;
const RELAX_MAX_LOO_TERMS = 6;

export const EMBED_MODEL = "@cf/baai/bge-m3";

export interface VectorBackend {
  ai: Ai;
  index: VectorizeIndex;
}

export interface DivisionMatch {
  law_id: string;
  path: string;
  heading: string | null;
  score: number;
}

interface VectorHits {
  arts: { law: string; number: string; score: number }[];
  divs: DivisionMatch[];
}

async function embedQuery(v: VectorBackend, query: string): Promise<number[] | null> {
  try {
    const res = (await v.ai.run(EMBED_MODEL as Parameters<Ai["run"]>[0], {
      text: [query.normalize("NFC").toLowerCase()],
    })) as { data?: number[][] };
    return res?.data?.[0] ?? null;
  } catch {
    return null;
  }
}

interface VectorQueryScope {
  lawId?: string;
  domains?: readonly string[];
  jurisdiction?: string;
  useMetadataDomainFilter?: boolean;
}

async function queryVectors(
  v: VectorBackend,
  values: number[],
  vecScope: VectorQueryScope,
): Promise<VectorHits | null> {
  try {
    let filter: VectorizeVectorMetadataFilter | undefined;
    if (vecScope.lawId) {
      filter = { law: vecScope.lawId };
    } else if (vecScope.useMetadataDomainFilter) {
      const f: VectorizeVectorMetadataFilter = {};
      if (
        vecScope.domains &&
        vecScope.domains.length > 0 &&
        vecScope.domains.length < ALL_DOMAINS.length
      ) {
        f.domain =
          vecScope.domains.length === 1 ? vecScope.domains[0] : { $in: [...vecScope.domains] };
      }
      if (vecScope.jurisdiction) {
        f.jurisdiction = vecScope.jurisdiction;
      }
      if (Object.keys(f).length > 0) filter = f;
    }
    const res = await v.index.query(values, {
      topK: VECTOR_TOP_K,
      returnMetadata: "all",
      ...(filter ? { filter } : {}),
    });
    const out: VectorHits = { arts: [], divs: [] };
    for (const m of res.matches ?? []) {
      const md = (m.metadata ?? {}) as Record<string, string>;
      if (md.type === "article" && md.law && md.article) {
        if (m.score < SEMANTIC_MIN_SCORE) continue;
        out.arts.push({ law: md.law, number: md.article, score: m.score });
      } else if (md.type === "division" && md.law && md.path) {
        out.divs.push({
          law_id: md.law,
          path: md.path,
          heading: md.heading || null,
          score: m.score,
        });
      }
    }
    return out;
  } catch {
    return null;
  }
}

async function filtreVecteurs(
  db: D1Database,
  vec: VectorHits | null,
  env: CorpusGateEnv,
  scope?: { domains?: readonly string[]; jurisdiction?: string; forum?: string },
): Promise<VectorHits | null> {
  const c = clauseCorpus(env, "");
  const extraConds: string[] = [];
  const extraBinds: unknown[] = [];
  if (scope?.domains && scope.domains.length > 0 && scope.domains.length < ALL_DOMAINS.length) {
    extraConds.push(`domain IN (${scope.domains.map(() => "?").join(",")})`);
    extraBinds.push(...scope.domains);
  }
  if (scope?.jurisdiction) {
    extraConds.push("jurisdiction = ?");
    extraBinds.push(scope.jurisdiction);
  }
  if (scope?.forum?.trim()) {
    extraConds.push(forumScopeSqlClause(""));
    extraBinds.push(`%${scope.forum.trim()}%`);
  }
  if (!vec || (!c && extraConds.length === 0)) return vec;
  const ids = [...new Set([...vec.arts.map((a) => a.law), ...vec.divs.map((d) => d.law_id)])];
  if (!ids.length) return vec;
  const extraSql = extraConds.length ? ` AND ${extraConds.join(" AND ")}` : "";
  const rows = (
    await db
      .prepare(
        `SELECT id FROM laws WHERE id IN (${ids.map(() => "?").join(",")})${c ? ` AND ${c}` : ""}${extraSql}`,
      )
      .bind(...ids, ...extraBinds)
      .all<{ id: string }>()
  ).results;
  const permis = new Set(rows.map((r) => r.id));
  return {
    arts: vec.arts.filter((a) => permis.has(a.law)),
    divs: vec.divs.filter((d) => permis.has(d.law_id)),
  };
}

async function loadLawFonctions(
  db: D1Database,
  ids: string[],
  env: CorpusGateEnv,
): Promise<Map<string, string | null>> {
  if (!ids.length) return new Map();
  const rows = (
    await db
      .prepare(
        `SELECT id, fonction FROM laws WHERE id IN (${ids.map(() => "?").join(",")}) ${masqueLawId(env, "id")}`,
      )
      .bind(...ids)
      .all<{ id: string; fonction: string | null }>()
  ).results;
  return new Map(rows.map((r) => [r.id, r.fonction]));
}

async function articleBriefs(
  db: D1Database,
  lang: Lang,
  keys: string[],
): Promise<Map<string, SearchHit>> {
  const byLaw = new Map<string, string[]>();
  for (const k of keys) {
    const [law, number] = k.split("|");
    const arr = byLaw.get(law);
    if (arr) arr.push(number);
    else byLaw.set(law, [number]);
  }
  const out = new Map<string, SearchHit>();
  for (const [law, numbers] of byLaw) {
    const rows = (
      await db
        .prepare(
          `SELECT law_id, number, division_path, substr(text, 1, 240) AS t, length(text) AS len
         FROM articles WHERE lang = ? AND law_id = ? AND number IN (${numbers.map(() => "?").join(",")})`,
        )
        .bind(lang, law, ...numbers)
        .all<{ law_id: string; number: string; division_path: string; t: string; len: number }>()
    ).results;
    for (const r of rows) {
      out.set(`${r.law_id}|${r.number}`, {
        law_id: r.law_id,
        number: r.number,
        division_path: r.division_path,
        snippet: r.len > 240 ? `${r.t}…` : r.t,
        semantic: true,
        hit_lang: lang,
      });
    }
    if (lang === "en") {
      const missing = numbers.filter((n) => !out.has(`${law}|${n}`));
      if (missing.length) {
        const frRows = (
          await db
            .prepare(
              `SELECT law_id, number, division_path, substr(text, 1, 240) AS t, length(text) AS len
             FROM articles WHERE lang = ? AND law_id = ? AND number IN (${missing.map(() => "?").join(",")})`,
            )
            .bind("fr", law, ...missing)
            .all<{
              law_id: string;
              number: string;
              division_path: string;
              t: string;
              len: number;
            }>()
        ).results;
        for (const r of frRows) {
          out.set(`${r.law_id}|${r.number}`, {
            law_id: r.law_id,
            number: r.number,
            division_path: r.division_path,
            snippet: r.len > 240 ? `${r.t}…` : r.t,
            semantic: true,
            hit_lang: "fr",
          });
        }
      }
    }
  }
  return out;
}

async function fuseHybrid(
  db: D1Database,
  lang: Lang,
  fts: { hits: SearchHit[]; total: number },
  vec: VectorHits,
  limit: number,
  env: CorpusGateEnv = {},
): Promise<SearchHit[]> {
  interface Entry {
    lawId: string;
    ftsRank?: number;
    vecRank?: number;
    hit?: SearchHit;
  }
  const entries = new Map<string, Entry>();
  const fonctionByLaw = new Map<string, string | null>();
  fts.hits.forEach((h, i) => {
    entries.set(`${h.law_id}|${h.number}`, { lawId: h.law_id, ftsRank: i + 1, hit: h });
    if (h.fonction !== undefined) fonctionByLaw.set(h.law_id, h.fonction);
  });
  vec.arts.forEach((a, i) => {
    const k = `${a.law}|${a.number}`;
    const e = entries.get(k) ?? { lawId: a.law };
    e.vecRank = i + 1;
    entries.set(k, e);
  });
  const missingLawIds = [...new Set(vec.arts.map((a) => a.law))].filter(
    (id) => !fonctionByLaw.has(id),
  );
  if (missingLawIds.length) {
    const loaded = await loadLawFonctions(db, missingLawIds, env);
    for (const [id, fn] of loaded) fonctionByLaw.set(id, fn);
  }
  const scored = [...entries.entries()]
    .map(([k, e]) => {
      const w = fonctionWeight(fonctionByLaw.get(e.lawId));
      const rrfWeight = 1 - 0.15 * (1 - w);
      return {
        k,
        e,
        score:
          ((e.ftsRank ? 1 / (RRF_K + e.ftsRank) : 0) + (e.vecRank ? 1 / (RRF_K + e.vecRank) : 0)) *
          rrfWeight,
      };
    })
    .sort((a, b) => b.score - a.score);
  const missing = scored.filter((s) => !s.e.hit).map((s) => s.k);
  const briefs = missing.length
    ? await articleBriefs(db, lang, missing)
    : new Map<string, SearchHit>();
  const cosOf = new Map(vec.arts.map((a) => [`${a.law}|${a.number}`, a.score]));
  const hits: SearchHit[] = [];
  for (const s of scored) {
    const h = s.e.hit ?? briefs.get(s.k);
    if (h) {
      const cos = cosOf.get(s.k);
      const fn = h.fonction ?? fonctionByLaw.get(h.law_id);
      const enriched = fn !== undefined ? { ...h, fonction: fn } : h;
      hits.push(cos !== undefined && h.semantic ? { ...enriched, score: cos } : enriched);
    }
    if (hits.length >= limit) break;
  }
  return hits;
}

async function countExcludedDomainsFts(
  db: D1Database,
  query: string,
  matchExact: string,
  lang: Lang,
  excludedDomains: readonly string[],
  scope: { jurisdiction?: string; forum?: string },
  relax: boolean,
  env: CorpusGateEnv,
): Promise<{ domain: string; lexical_hits: number }[]> {
  if (!excludedDomains.length) return [];
  const subClauses: string[] = [`l.domain IN (${excludedDomains.map(() => "?").join(",")})`];
  const subBinds: unknown[] = [...excludedDomains];
  if (scope.jurisdiction) {
    subClauses.push("l.jurisdiction = ?");
    subBinds.push(scope.jurisdiction);
  }
  if (scope.forum?.trim()) {
    subClauses.push(forumScopeSqlClause("l"));
    subBinds.push(`%${scope.forum.trim()}%`);
  }
  const m = masqueLawId(env, "articles_fts.law_id");
  const runRadar = async (expr: string) =>
    (
      await db
        .prepare(
          `SELECT l.domain AS domain, COUNT(*) AS n FROM articles_fts
           JOIN laws l ON l.id = articles_fts.law_id
           WHERE articles_fts MATCH ? AND articles_fts.lang = ? AND ${subClauses.join(" AND ")} ${m}
           GROUP BY l.domain ORDER BY n DESC, l.domain ASC`,
        )
        .bind(`{text marginal_note} : (${expr})`, lang, ...subBinds)
        .all<{ domain: string; n: number }>()
    ).results;

  let rows = await runRadar(matchExact);
  if (rows.length === 0 && relax) {
    const sigTokens = tokenize(query);
    if (sigTokens.length >= 2) {
      const orExpr = [...new Set(sigTokens.flatMap(ligatureVariants))]
        .map(quoteSingleTok)
        .join(" OR ");
      rows = await runRadar(orExpr);
    }
  }
  return rows.map((r) => ({ domain: r.domain, lexical_hits: r.n }));
}

export async function searchText(
  db: D1Database,
  query: string,
  lang: Lang,
  lawId: string | undefined,
  page: Page,
  opts: {
    relax?: boolean;
    vector?: VectorBackend;
    env?: CorpusGateEnv;
    domains?: readonly string[];
    explicitDomains?: boolean;
    lawDomain?: string;
    jurisdiction?: string;
    forum?: string;
  } = {},
): Promise<SearchOutcome> {
  const env = opts.env ?? {};
  const match = toFtsQuery(query);
  if (!match) return { hits: [], total: 0, fallback: null, elsewhere: null };
  const activeDomains = opts.domains ?? ALL_DOMAINS;
  const excludedDomains = lawId ? [] : ALL_DOMAINS.filter((d) => !activeDomains.includes(d));
  const scope: MatchScope = lawId
    ? { law: lawId }
    : { domains: activeDomains, jurisdiction: opts.jurisdiction, forum: opts.forum };
  const wideDomains = opts.explicitDomains
    ? activeDomains
    : opts.lawDomain
      ? [opts.lawDomain]
      : activeDomains;
  const wideScope: MatchScope = {
    domains: wideDomains,
    jurisdiction: opts.jurisdiction,
    forum: opts.forum,
  };

  const useVector = !!opts.vector && page.offset === 0;
  const activeVecScope: VectorQueryScope = lawId
    ? { lawId }
    : {
        domains: activeDomains,
        jurisdiction: opts.jurisdiction,
        useMetadataDomainFilter: vectorDomainFilterActif(env),
      };
  const activeFilterScope = lawId
    ? undefined
    : { domains: activeDomains, jurisdiction: opts.jurisdiction, forum: opts.forum };
  const [exact, qVec, otherDomains] = await Promise.all([
    runMatch(db, match, lang, scope, page, false, env),
    useVector ? embedQuery(opts.vector!, query) : Promise.resolve(null),
    excludedDomains.length
      ? countExcludedDomainsFts(
          db,
          query,
          match,
          lang,
          excludedDomains,
          { jurisdiction: opts.jurisdiction, forum: opts.forum },
          opts.relax !== false,
          env,
        )
      : Promise.resolve([]),
  ]);
  const vec = await filtreVecteurs(
    db,
    qVec ? await queryVectors(opts.vector!, qVec, activeVecScope) : null,
    env,
    activeFilterScope,
  );
  const rawSemDivs = (vec?.divs ?? []).filter((d) => d.score >= DIVISION_MATCH_MIN_SCORE);
  let semDivs = rawSemDivs;
  if (rawSemDivs.length > 1) {
    const divFns = await loadLawFonctions(db, [...new Set(rawSemDivs.map((d) => d.law_id))], env);
    semDivs = [...rawSemDivs].sort(
      (a, b) =>
        b.score * fonctionWeight(divFns.get(b.law_id)) -
        a.score * fonctionWeight(divFns.get(a.law_id)),
    );
  }
  semDivs = semDivs.slice(0, DIVISION_MATCH_MAX);
  const wideVecScope: VectorQueryScope = {
    domains: wideDomains,
    jurisdiction: opts.jurisdiction,
    useMetadataDomainFilter: vectorDomainFilterActif(env),
  };
  const wideFilterScope = {
    domains: wideDomains,
    jurisdiction: opts.jurisdiction,
    forum: opts.forum,
  };
  let vecWideCache: Awaited<ReturnType<typeof queryVectors>> | undefined;
  const vecWide = async () => {
    if (vecWideCache === undefined) {
      vecWideCache =
        lawId && qVec
          ? await filtreVecteurs(
              db,
              await queryVectors(opts.vector!, qVec, wideVecScope),
              env,
              wideFilterScope,
            )
          : vec;
    }
    return vecWideCache;
  };
  const fuse = async (
    fts: { hits: SearchHit[]; total: number },
    v: Awaited<ReturnType<typeof queryVectors>>,
  ) => (v?.arts.length ? await fuseHybrid(db, lang, fts, v, page.limit, env) : fts.hits);

  if (exact.total > 0) {
    let elsewhere: SearchOutcome["elsewhere"] = null;
    if (lawId) {
      const others = await runMatch(
        db,
        match,
        lang,
        { notLaw: lawId, ...wideScope },
        { limit: 3, offset: 0 },
        false,
        env,
      );
      if (others.total > 0) elsewhere = { total: others.total, hits: others.hits };
    }
    return {
      hits: await fuse(exact, vec),
      total: exact.total,
      fallback: null,
      elsewhere,
      divisions: semDivs,
      otherDomains,
    };
  }

  if (lawId) {
    const wide = await runMatch(db, match, lang, wideScope, page, false, env);
    if (wide.total > 0) {
      return {
        hits: await fuse(wide, await vecWide()),
        total: wide.total,
        fallback: "widened",
        elsewhere: null,
        divisions: semDivs,
        otherDomains,
      };
    }
  }

  const tokens = ftsTokens(query);
  const relaxable = !!opts.relax && tokens.length >= RELAX_MIN_TERMS;

  if (relaxable && tokens.length <= RELAX_MAX_LOO_TERMS) {
    let best: { hits: SearchHit[]; total: number; omitted: string; sum: number } | null = null;
    for (let i = 0; i < tokens.length; i++) {
      const partial = joinFtsTerms(tokens.filter((_, j) => j !== i).map(quoteTok));
      const r = await runMatch(db, partial, lang, scope, page, true, env);
      if (r.total === 0) continue;
      const sum = r.hits.reduce((acc, h) => acc + (h.score ?? 0), 0);
      if (!best || sum < best.sum) best = { ...r, omitted: tokens[i], sum };
    }
    if (best && best.total >= Math.min(RELAX_MIN_LOO_TOTAL, page.limit)) {
      return {
        hits: await fuse(best, vec),
        total: best.total,
        fallback: { loo: best.omitted },
        elsewhere: null,
        divisions: semDivs,
        otherDomains,
      };
    }
  }

  if (relaxable) {
    const orTerms = [
      ...new Set(tokens.flatMap((t) => t.split(/[-.'’]/)).filter((t) => t.length >= 2)),
    ];
    if (orTerms.length) {
      const matchOr = [...new Set(orTerms.flatMap(ligatureVariants))]
        .map(quoteSingleTok)
        .join(" OR ");
      const scoped = await runMatch(db, matchOr, lang, scope, page, true, env);
      if (scoped.total > 0) {
        return {
          hits: await fuse(scoped, vec),
          total: scoped.total,
          fallback: "or_relax",
          elsewhere: null,
          divisions: semDivs,
          otherDomains,
        };
      }
      if (lawId) {
        const wideOr = await runMatch(db, matchOr, lang, wideScope, page, true, env);
        if (wideOr.total > 0) {
          return {
            hits: await fuse(wideOr, await vecWide()),
            total: wideOr.total,
            fallback: "or_relax",
            elsewhere: null,
            divisions: semDivs,
            otherDomains,
          };
        }
      }
    }
  }

  for (const v of [vec, lawId ? await vecWide() : null]) {
    if (v?.arts.length) {
      const hits = await fuseHybrid(db, lang, { hits: [], total: 0 }, v, page.limit, env);
      if (hits.length) {
        return {
          hits,
          total: 0,
          fallback: "semantic",
          elsewhere: null,
          divisions: semDivs,
          otherDomains,
        };
      }
    }
  }

  return {
    hits: [],
    total: 0,
    fallback: null,
    elsewhere: null,
    divisions: semDivs,
    otherDomains,
  };
}
