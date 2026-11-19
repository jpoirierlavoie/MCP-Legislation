// Helpers et requêtes D1 (lecture seule) pour le serveur MCP « Lois du Québec ».
// Le schéma est décrit dans schema.sql / PLAN.md §2 et schema-decouverte.sql.

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
  DIVISION_MATCH_MAX,
  DIVISION_MATCH_MIN_SCORE,
  FONCTION_WEIGHTS,
  fonctionWeight,
  normalize,
  RELAX_MIN_LOO_TOTAL,
  RRF_K,
  SEMANTIC_MIN_SCORE,
  VECTOR_TOP_K,
} from "./relevance";

export type LawSource = "epub" | "lims" | "pdf";

export type LawFonction =
  | "loi"
  | "reglement"
  | "regles-procedure"
  | "tarif"
  | "directive"
  | "orientation";

export type CorpusGateEnv = { FEDERAL_CORPUS?: string; PDF_CORPUS?: string };

export interface LawRow {
  id: string;
  name_fr: string;
  name_en: string;
  /**
   * TOLÉRANCE DÉLIBÉRÉE ET TEMPORAIRE, le temps d'une migration.
   *
   * `laws.rlrq_cite` devient `official_cite` (le nom mentait dès qu'une citation fédérale
   * y entre). Or `getLaw` et `listLaws` lisent en `SELECT *` / `SELECT l.*` : la FORME de
   * l'objet JS suit la base, donc après la migration la propriété change de nom toute
   * seule — sans une ligne de SQL à corriger, et `tsc` ne peut rien y voir puisqu'il ne lit
   * pas le SQL (cf. l'avertissement au-dessus d'ARTICLE_COLS : `all<T>()` est une
   * ASSERTION, pas une vérification).
   *
   * Conséquences mesurées du demi-renommage, si le Worker n'était pas tolérant :
   * `get_article` et `resolve_reference` échouent BRUYAMMENT, mais `list_laws` échoue en
   * SILENCE — `JSON.stringify` efface une clé `undefined` — et la page publique rend une
   * colonne « citation » vide sur tout le corpus. Un `citationOf(undefined, '1457')`
   * rendrait « undefined, art. 1457 » comme citation officielle d'un article de droit.
   *
   * Les DEUX noms sont donc optionnels ici, et TOUT lecteur passe par `citeOf()`. Le
   * resserrement (`official_cite: string` obligatoire, `rlrq_cite` et `citeOf` supprimés)
   * est un commit SÉPARÉ, postérieur à la migration : `tsc` sert alors de liste de courses.
   */
  rlrq_cite?: string;
  official_cite?: string;
  /** Forme anglaise de la citation (« CQLR, c. … », « R.S.C. 1985, c. … »). */
  official_cite_en?: string | null;
  consol_date_fr: string | null;
  consol_date_en: string | null;
  /** Provenance d'ingestion ('epub' | 'lims' | 'pdf', migration 0007). */
  source?: LawSource;
  chapter?: string | null;
  jurisdiction?: string;
  in_force?: number;
  last_amended?: string | null;
  unit?: Unit | string | null;
  // colonnes de la couche découverte (schema-decouverte.sql)
  fonction: string | null;
  forum: string | null; // multi-valeurs jointes par ' ; '
  scope_fr: string | null; // repli d'affichage : name_fr
  parent_law_id: string | null; // loi habilitante d'un règlement
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

/**
 * Ce que le Worker LIT d'un article — pas ce que la table contient.
 *
 * `html` et `sort_key` existent en base mais ne sont projetées par AUCUNE requête d'ici
 * (voir ARTICLE_COLS) : les déclarer ferait mentir le type, car `all<T>()` est une
 * assertion que rien ne vérifie. `html` reste écrite par le pipeline ; `sort_key` sert aux
 * `ORDER BY` et aux bornes de plage, jamais à la sortie.
 */
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

// --- clés & citations ---------------------------------------------------------

/**
 * Base de tri des pseudo-articles de disposition — miroir de DISPOSITION_SORT_BASE
 * (pipeline/model.py) : ils se rangent APRÈS tout le corpus.
 */
export const DISPOSITION_SORT_BASE = 9_000_000_000_000_000;

const SORT_COMP_RE = /^(\d+)([A-Za-z]?)$/;
const SORT_BASES = [13_500, 2_700, 864] as const;
const SORT_MAX_NUMS = [9999, 499, 99, 31] as const;

/**
 * Clé de tri — MIROIR EXACT de sort_key() dans pipeline/model.py : packing mixte à 4 composantes
 * (c0..c3) avec suffixe lettre optionnel A–Z (27 états), strictement < DISPOSITION_SORT_BASE.
 *
 * ⚠️ Cette fonction et sa jumelle Python DOIVENT rester alignées : elles indexent la même
 * colonne `articles.sort_key`. Une divergence d'échelle rend les plages silencieusement
 * vides (le mode from/to ne trouve plus rien).
 * Max = 270000*13500*2700*864 - 1 = 8_503_055_999_999_999 < 9e15 < 2^53 : exact en nombre JS.
 */
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

/**
 * Citation officielle d'une loi, tolérante aux DEUX noms de colonne.
 *
 * Point de passage UNIQUE : aucun appelant ne doit lire `official_cite` ni `rlrq_cite`
 * directement, sinon la fenêtre entre la migration et le recyclage des Durable Objects
 * (30-60 s) rend « undefined » dans une citation. Le repli sur la chaîne vide est
 * volontairement le dernier recours — une citation vide est visible, « undefined » se
 * lit comme une valeur.
 */
export function citeOf(l: Pick<LawRow, "rlrq_cite" | "official_cite">): string {
  return l.official_cite ?? l.rlrq_cite ?? "";
}

/**
 * Unité de numérotation d'un texte. Les *Règles des Cours fédérales* se citent par
 * RÈGLE, les directives judiciaires par PARAGRAPHE (`par.` / `para.`), et le reste par ARTICLE.
 */
export type Unit = "article" | "regle" | "paragraphe";

/** Le mot d'unité, par langue. Table EXPLICITE : une règle de dérivation mentirait. */
const MOT_UNITE: Record<Unit, Record<Lang, string>> = {
  article: { fr: "art.", en: "s." },
  regle: { fr: "règle", en: "rule" },
  paragraphe: { fr: "par.", en: "para." },
};

export function unitLabel(unit: string | null | undefined, lang: Lang = "fr"): string {
  const u: Unit = unit === "regle" ? "regle" : unit === "paragraphe" ? "paragraphe" : "article";
  return MOT_UNITE[u][lang];
}

/** Pseudo-articles, par langue. Table explicite pour la même raison. */
const MOT_PSEUDO: Record<string, Record<Lang, string>> = {
  préliminaire: { fr: "disposition préliminaire", en: "preliminary provision" },
  "note-preliminaire": { fr: "note préliminaire", en: "preliminary note" },
  finales: { fr: "dispositions finales", en: "final provisions" },
  preambule: { fr: "préambule", en: "preamble" },
  preamble: { fr: "préambule", en: "preamble" },
};

/**
 * Citation d'un article : « <citation officielle>, art. N » — ou « règle N », ou « s. N ».
 *
 * Prend la LOI et non une chaîne, pour pouvoir choisir la forme anglaise (`official_cite_en`)
 * et l'unité (`laws.unit`). L'ancienne signature à deux chaînes ne pouvait faire ni l'un ni
 * l'autre : elle rendait « RLRQ, c. CCQ-1991, art. 1457 » MÊME en anglais, alors que la
 * compilation s'appelle « CQLR » en anglais et que « art. » s'y écrit « s. ».
 *
 * `official_cite_en` absente ⇒ repli sur la forme française. Elle est NULL sur les lignes
 * québécoises jusqu'à la passe qui les remplit : le repli est donc le comportement
 * d'origine, et non une régression.
 */
export function citationOf(
  law: Pick<LawRow, "rlrq_cite" | "official_cite" | "official_cite_en"> & { unit?: string | null },
  article: string,
  lang: Lang = "fr",
): string {
  // La forme anglaise est TOUT OU RIEN, et c'est délibéré. Sans `official_cite_en`, rendre
  // « RLRQ, c. CCQ-1991, s. 1457 » mêlerait le nom FRANÇAIS de la compilation au marqueur
  // ANGLAIS d'article — pire que l'un ou l'autre. Tant que la colonne n'est pas remplie, on
  // reste donc intégralement en français : comportement IDENTIQUE à l'actuel, ce qui est la
  // promesse de cette étape. La correction québécoise (« CQLR ») arrive avec la donnée.
  const citeEn = lang === "en" ? law.official_cite_en : null;
  const langueDeSortie: Lang = citeEn ? "en" : "fr";
  const cite = citeEn || citeOf(law);
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

// --- pagination ---------------------------------------------------------------

export interface Page {
  limit: number;
  offset: number;
}

export function paginate(limit?: number, offset?: number, def = 50, max = 200): Page {
  const l = Math.min(Math.max(1, Math.trunc(limit ?? def)), max);
  const o = Math.max(0, Math.trunc(offset ?? 0));
  return { limit: l, offset: o };
}

// --- chemins de divisions ------------------------------------------------------
//
// Le découpage, l'intervalle de sous-arbre et la reconnaissance de famille vivent dans
// `src/paths.ts`, module PUR et POINT DE VÉRITÉ UNIQUE. Ils étaient auparavant en TROIS
// copies incompatibles ici même — dont deux bornées à `/-(?=g[a-z]:)/`, qui voient un
// chemin fédéral `fh1:3-fh2:5` comme UN SEUL segment.

// --- requêtes -----------------------------------------------------------------

/**
 * Une loi par son id, MASQUE COMPRIS.
 *
 * C'est le POINT D'ÉTRANGLEMENT de l'interrupteur : presque tous les outils appellent
 * `getLaw` en garde et refusent « Loi inconnue » si elle rend `null`. Masquer ici ferme donc
 * d'un coup `get_article`, `get_articles`, `get_structure`, `get_division` et
 * `related_laws`.
 *
 * ⚠️ POURQUOI CE PARAMÈTRE EXISTE. Mesuré en production le 2026-09-11, juste après
 * l'ingestion du premier texte fédéral : le masque n'était posé que dans `listLaws`.
 * Résultat — `list_laws` rendait bien 79 lois et zéro texte `ca-*`, mais
 * `get_article(law='ca-i-15', article='2')` SERVAIT l'article, et `search_text` rendait
 * 3 résultats fédéraux. Un interrupteur qui ne ferme qu'une porte sur cinq est PIRE que pas
 * d'interrupteur : il donne l'apparence du contrôle. La carte du corpus disait 79 pendant
 * que quatre autres portes servaient du fédéral.
 */
export async function getLaw(
  db: D1Database,
  lawId: string,
  env: CorpusGateEnv = {},
): Promise<LawRow | null> {
  const c = clauseCorpus(env, "");
  const masque = c ? ` AND ${c}` : "";
  return db.prepare(`SELECT * FROM laws WHERE id = ?${masque}`).bind(lawId).first<LawRow>();
}

/**
 * Clause de masquage pour une colonne portant un `law_id` (FTS, subject_map, relations…).
 * Vide quand les deux interrupteurs sont ouverts.
 */
export function masqueLawId(env: CorpusGateEnv, col: string): string {
  const c = clauseCorpus(env, "");
  return c ? `AND ${col} IN (SELECT id FROM laws WHERE ${c})` : "";
}

/**
 * Masquage de l'AUTRE EXTRÉMITÉ d'une relation — et c'est un prédicat DIFFÉRENT de
 * `masqueLawId`, pas une variante de style.
 *
 * `law_relations` porte des arêtes vers des textes HORS corpus (`in_corpus = 0`), qui n'ont
 * aucune ligne dans `laws`. Le `IN (SELECT id FROM laws …)` de `masqueLawId` les supprimerait
 * toutes — ce serait une régression québécoise causée par l'interrupteur fédéral. On exige
 * donc l'inverse : on ne retire une arête que si son autre bout est une loi PRÉSENTE en base
 * et masquée (non québécoise ou source PDF quand l'interrupteur correspondant est fermé).
 *
 * Mesuré en production le 2026-09-11 : 0 arête concernée aujourd'hui, parce que
 * `discovery/relations.py` n'a pas encore été rejoué depuis l'ingestion d'`ca-i-15`. Ce
 * masque est donc bit pour bit neutre aujourd'hui, et c'est la PROCHAINE étape de la phase 4
 * qui l'arme. « Comme si le texte n'était pas chargé » veut dire ici que l'arête n'existe
 * pas : avant l'ingestion, aucune arête ne référençait un id `ca-*`.
 */
export function masqueAutreBout(env: CorpusGateEnv, col: string): string {
  const excl: string[] = [];
  if (!federalOuvert(env)) excl.push("jurisdiction <> 'qc'");
  if (!pdfOuvert(env)) excl.push("source = 'pdf'");
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
  /** Libellés des sujets rattachés (taxonomie). */
  subjects: string[];
  /** Divisions précises rattachées à un sujet (pour les grands codes : les Livres). */
  mapped_divisions: MappedDivision[];
}

export interface LawFilters {
  fonction?: string;
  forum?: string;
  subject?: string;
  /** Ordre de gouvernement : 'qc' | 'ca'. */
  jurisdiction?: string;
}

/**
 * Carte du corpus (§4.1) : lois enrichies (fonction, forum, sujets, portée, loi habilitante).
 * Trois requêtes agrégées au total — pas de N+1.
 */
/**
 * L'INTERRUPTEUR DU CORPUS FÉDÉRAL (R8 : « rollback = flip de variable, pas revert »).
 *
 * À « 0 » — ou non défini —, les textes `jurisdiction = 'ca'` sont INVISIBLES à tous les
 * outils, même chargés en base. On peut donc ingérer les 18 textes, les vérifier et
 * mesurer le repérage en production sans rien servir, puis ouvrir d'un flip — et refermer
 * de même si la qualité se dégrade. Le filet le plus utile du chantier, pour le coût d'une
 * clause WHERE.
 *
 * Fermé par défaut à dessein : un déploiement qui oublierait la variable ne sert rien de
 * neuf, au lieu de tout servir d'un coup.
 *
 * ⚠️ CE QUE L'INTERRUPTEUR NE PEUT PAS FAIRE — mesuré le 2026-09-11, à ne pas réapprendre.
 *
 * Il cache les DOCUMENTS fédéraux des résultats. Il ne défait PAS leur effet sur les
 * statistiques de `bm25()`, qui sont GLOBALES à l'index fts5 : nombre de documents et
 * longueur moyenne. Une clause WHERE filtre APRÈS le score, elle ne change pas les
 * statistiques qui l'ont produit. Donc ingérer un texte fédéral déplace, d'un cheveu, le
 * score de TOUTES les requêtes — y compris celles bornées à une loi québécoise.
 *
 * Constaté sur le cas d'éval 15 (« clause non-concurrence fin d'emploi », borné à `ccq`)
 * après l'ingestion d'`ca-i-15`, soit 22 documents de plus sur 49 255 (+0,045 %) : le 10e
 * rang est passé de `ccq|2402` à `ccq|2096`. Ces deux articles sont séparés de
 * **3,4 × 10⁻³**, soit 0,03 % de leur bm25 — une égalité de fait, que le moindre décalage
 * de statistiques fait basculer. Stable sur trois passes : ce n'est pas du bruit de mesure.
 *
 * CONSÉQUENCE POUR LA PORTE D'ÉVAL. « Identique bit pour bit à la baseline d'avant le
 * fédéral » devient INATTEIGNABLE dès la première ingestion, interrupteur fermé ou non. La
 * porte à tenir est donc : `recall_at_10`, `mrr`, `first_rank` et `must_found` inchangés cas
 * par cas — et les permutations de la QUEUE du top-10 entre scores quasi ex æquo examinées,
 * puis expliquées, jamais ignorées. Les 17 textes restants ajoutent ~6 800 articles (+13,8 %),
 * donc ces bascules seront plus fréquentes, pas moins.
 */
export function federalOuvert(env: CorpusGateEnv): boolean {
  return env.FEDERAL_CORPUS === "1";
}

/** L'interrupteur du corpus PDF (R8 : fermé par défaut tant qu'il ne vaut pas "1"). */
export function pdfOuvert(env: CorpusGateEnv): boolean {
  return env.PDF_CORPUS === "1";
}

/** Clause SQL de masquage combinée (fédéral + PDF), à coller dans un WHERE. Vide si tout ouvert. */
export function clauseCorpus(env: CorpusGateEnv, alias = "l"): string {
  const p = alias ? `${alias}.` : "";
  const conds: string[] = [];
  if (!federalOuvert(env)) conds.push(`${p}jurisdiction = 'qc'`);
  if (!pdfOuvert(env)) conds.push(`${p}source <> 'pdf'`);
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
  if (filters.fonction) {
    where.push("l.fonction = ?");
    binds.push(filters.fonction);
  }
  if (filters.forum) {
    // forum est multi-valué (' ; ') : on cherche l'occurrence
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

  // subject_map ne contient que des chemins FR : on les traduit si une autre langue est demandée
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
      // décompte de la LANGUE DEMANDÉE (jamais la somme, ni le maximum des deux : quelques
      // textes ont une division de plus d'un côté, ce qui surévaluait l'autre langue).
      article_count: mine.find((r) => r.lang === lang)?.n ?? Math.max(0, ...mine.map((r) => r.n)),
      // Libellé de matière DANS LA LANGUE DEMANDéE : listLaws reçoit lang et s'en sert
      // déjà pour les chemins et le décompte d'articles ; il rendait pourtant toujours le
      // libellé français. Repli sur le français, patron retenu pour list_subjects.
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

// --- pont entre les chemins de divisions FR et EN -----------------------------

export interface TranslatedPath {
  path: string;
  heading: string | null;
}

/**
 * Traduit des chemins de divisions FRANÇAIS vers la langue demandée.
 *
 * Les identifiants Irosoft sont PROPRES À LA LANGUE (`ga:l_cinquieme` / `ga:l_five`), or
 * `subject_map` ne stocke que des chemins français. Sans traduction, une réponse en anglais
 * renvoie des chemins que get_division(lang='en') refuse — la piste est alors inexploitable.
 *
 * Le pont se fait par les NUMÉROS D'ARTICLES, invariants d'une langue à l'autre : on relie
 * les divisions par un article qu'elles partagent, puis on tronque le chemin cible à la même
 * profondeur (un Livre est à la profondeur 1, un Titre à 2, etc.).
 */
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

  const wanted = new Map<string, string>(); // chemin traduit -> chemin FR d'origine
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

// --- pont de langue à l'ENTRÉE des outils (plan v2, 1.5) ----------------------

/**
 * Traduit UN chemin de division donné dans l'autre langue que celle demandée.
 *
 * Les identifiants Irosoft sont propres à la langue (`ga:l_cinquieme` FR / `ga:l_five` EN) ;
 * un agent qui tient un chemin d'une réponse FR et le passe avec lang='en' recevait
 * « Division introuvable ». Pont par les numéros d'articles (invariants), puis troncature
 * à la même profondeur. Retourne aussi le chemin source résolu — utile pour le repli
 * d'intitulé `[fr]` quand la cible n'en a pas.
 */
export async function translateDivisionPath(
  db: D1Database,
  lawId: string,
  path: string,
  toLang: Lang,
): Promise<{ path: string; heading: string | null } | null> {
  // Un chemin fédéral est POSITIONNEL, donc identique dans les deux langues (mesuré sur
  // les 19 textes : docs/phase0-structure-lims.md §3.1). Il n'y a RIEN à traduire, et le
  // pont par les numéros d'articles rendrait ici une division DESCENDANTE — une réponse
  // fausse, pas vide. Le no-op est donc EXPLICITE, au lieu d'être espéré d'une
  // segmentation juste.
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

/** Intitulé de la même division dans l'autre langue (repli `[fr]` du plan v2, 1.5). */
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

// --- plan profondeur 2 des grands codes (plan v2, 1.4) ------------------------

export interface OutlineNode {
  kind: string;
  number: string | null;
  heading: string | null;
  path: string;
  children: Omit<OutlineNode, "children">[];
}

/**
 * Plan profondeur 2 (Livres + leurs enfants directs) des lois qui ont des Livres.
 * Justification (post-mortem) : l'intitulé du Livre V C.p.c. ne porte aucun signal
 * (« LES RÈGLES APPLICABLES À CERTAINES MATIÈRES CIVILES ») — le signal est au Titre
 * (« LES DEMANDES INTÉRESSANT LE DROIT INTERNATIONAL PRIVÉ »). Les lois plates ne sont
 * pas concernées.
 */
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

// --- taxonomie & graphe -------------------------------------------------------

export interface SubjectSummary {
  id: string;
  label_fr: string;
  label_en: string | null;
  kind: string;
  description_fr: string | null;
  description_en: string | null;
  laws_count: number;
  divisions_count: number;
}

export async function listSubjects(
  db: D1Database,
  env: CorpusGateEnv = {},
): Promise<SubjectSummary[]> {
  // Le masque va dans le ON du LEFT JOIN, PAS dans le WHERE : au WHERE, une matière mappée
  // uniquement à des textes masqués DISPARAÎTRAIT de la taxonomie, alors qu'au ON elle reste
  // listée avec un décompte de 0 — ce qui est vrai (« rien de servable ici ») au lieu d'être
  // absent. `laws_count` est un fait VIVANT (R10) : non masqué, il annoncerait « 8 lois » pour
  // une matière dont `list_laws` n'en rend que 6, sans qu'aucun test ne le voie.
  const m = masqueLawId(env, "sm.law_id");
  return (
    await db
      .prepare(
        `SELECT s.id, s.label_fr, s.label_en, s.kind, s.description_fr, s.description_en,
              COUNT(DISTINCT sm.law_id) AS laws_count,
              COALESCE(SUM(CASE WHEN sm.division_path <> '' THEN 1 ELSE 0 END), 0) AS divisions_count
       FROM subjects s
       LEFT JOIN subject_map sm ON sm.subject_id = s.id ${m}
       GROUP BY s.id, s.label_fr, s.label_en, s.kind, s.description_fr, s.description_en
       ORDER BY s.kind, s.id`,
      )
      .all<SubjectSummary>()
  ).results;
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
  /** 'out' : law -> autre ; 'in' : autre -> law. */
  direction: "out" | "in";
  /** Id de l'autre extrémité. */
  other_id: string;
  /** Nom de l'autre extrémité si elle est au corpus. */
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
  // Le bout SUJET est déjà gardé : `related_laws` passe par `getLaw(db, law, env)` et
  // refuse avant d'arriver ici. C'est l'AUTRE bout qui fuyait — une arête vers un texte
  // fédéral serait rendue avec `in_corpus = 1` et son nom résolu, donc le modèle irait
  // appeler `get_article` dessus et se ferait refuser. Servir une piste qu'on refuse ensuite
  // est pire que ne pas la servir.
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
  // Noms des extrémités présentes au corpus, DANS LA LANGUE DEMANDÉE. `name_en` est
  // NOT NULL (schema.sql) ; le repli sur le français ne sert donc qu'en cas de ligne
  // anormale, mais il évite de rendre un nom vide si la base diverge du schéma.
  // Le masque est répété ici À DESSEIN : si une arête fédérale survivait au filtre ci-dessus,
  // son nom ne se résoudrait pas pour autant. Deux verrous coûtent une sous-requête ; un seul
  // verrou coûte un nom de loi servi par un outil qui la déclare invisible.
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
  // les plus significatives d'abord : curées, puis poids décroissant
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
      // Colonnes NOMMÉES, pas `a.*` : ce dernier ramenait `articles.html` — 651 o par
      // article en moyenne, 56 % du poids de la table — que le Worker ne lit nulle part.
      // Voir ARTICLE_COLS pour la liste et le piège.
      // La citation NE vient plus d'ici. C'était la SEULE occurrence littérale de la
      // colonne dans tout le SQL du Worker, donc la seule que la migration aurait cassée
      // bruyamment — et la jointure `laws` doublonnait un `getLaw` que les deux appelants
      // font déjà (src/tools.ts, get_article et resolve_reference). Ils passent désormais
      // la loi à `citationOf`, ce qui rend aussi la forme anglaise et l'unité accessibles.
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

/** Numéros d'articles voisins (par clé de tri) — pour les erreurs actionnables. */
export async function nearestArticles(
  db: D1Database,
  lawId: string,
  lang: Lang,
  key: number,
  limit = 5,
): Promise<string[]> {
  const rows = (
    await db
      .prepare(
        `SELECT number FROM articles WHERE law_id = ? AND lang = ?
       ORDER BY ABS(sort_key - ?) LIMIT ?`,
      )
      .bind(lawId, lang, key, limit)
      .all<{ number: string }>()
  ).results;
  return rows.map((r) => r.number);
}

/** Borne de plage résolue : la clé de tri, et l'`id` quand la borne est un article RÉEL. */
export interface BoundRef {
  key: number;
  id: number | null;
}

/**
 * Résout une borne de plage. On LIT la clé en base quand l'article existe, au lieu de la
 * recalculer : c'est la seule façon d'être insensible à un changement d'échelle de sort_key
 * (une divergence entre le pipeline et le serveur vidait silencieusement toutes les plages).
 * Repli sur le calcul si le numéro n'existe pas (borne ouverte, ex. to='9999').
 *
 * On rend AUSSI l'`id`, parce que `sort_key` N'EST PAS UN ORDRE TOTAL et que deux articles
 * distincts peuvent y collisionner — mesuré en production le 2026-09-07 : `15.01` et `15.1`
 * de ccq-r.8 partagent la clé 15001000000000, `15.02`/`15.2` la 15002000000000, idem
 * `31.01`/`31.1` et `31.02`/`31.2` dans t-15.01, dans les DEUX langues. Cause : `sort_key`
 * empaquette `int(composante)`, donc `int("01") === int("1")` — le zéro de tête est perdu.
 * Conséquence mesurée : `from='15.1' to='15.2'` rendait QUATRE articles, en y ajoutant en
 * silence 15.01 et 15.02, qui relèvent d'un tout autre chapitre.
 *
 * `id` est l'ordre du DOCUMENT à l'intérieur d'un couple (law_id, lang) : `load.prepare`
 * (pipeline/load.py) attribue `id_base + j` dans l'ordre d'émission du parseur. Vérifié
 * strictement croissant sur les 48 803 articles réels de la production.
 *
 * `id` reste NULL dans deux cas, où la plage retombe alors sur `sort_key` — le comportement
 * d'origine : (1) borne absente du corpus ; (2) PSEUDO-ARTICLE (préliminaire, annexes), dont
 * l'`id` ne suit PAS l'ordre du document, l'émission du parseur les plaçant hors de leur
 * position réelle et de façon variable d'une loi à l'autre (mesuré : dans ccq FR
 * `préliminaire` précède l'article 1, mais dans b-1-r.3.1 EN il porte l'id de l'article 3
 * plus un).
 */
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
  if (!row) return { key: sortKeyOf(number), id: null };
  const reel = row.sort_key > 0 && row.sort_key < DISPOSITION_SORT_BASE;
  return { key: row.sort_key, id: reel ? row.id : null };
}

/**
 * Colonnes d'`articles` que le Worker lit VRAIMENT. `html` n'y est PAS.
 *
 * Pourquoi ça vaut la peine : mesuré sur 48 673 lignes (98,8 % du corpus), `html` pèse
 * **651 o par article en moyenne, soit 56 % de la table** et 1,64 × `text` — et il n'est lu
 * nulle part (0 occurrence dans tools.ts, relevance.ts, site.ts ; backfill.ts vectorise sur
 * `text`). Un `SELECT *` sur `get_articles` à la borne de 200 articles déplaçait ~226 Kio
 * pour ~91 Kio utiles. Le pipeline continue de l'écrire ; la colonne reste en base.
 *
 * ⚠️ AUCUN FILET DE TYPAGE ICI. `D1PreparedStatement.all<T>()` est une ASSERTION, pas une
 * vérification : le compilateur ne lit pas le SQL. Retirer une colonne de cette liste
 * compile parfaitement et produit `undefined` à l'exécution — `text` manquant ferait rendre
 * « undefined » À LA PLACE DU TEXTE OFFICIEL, et `repealed` manquant ferait passer un
 * article ABROGÉ pour en vigueur (`!!undefined === false`). Le seul garde réel est du côté
 * des évals : trois contrôles de tests/evals.mjs inspectent la FORME de la sortie.
 */
const ARTICLE_COLS = "id, law_id, lang, number, division_path, text, history, repealed, links";

/**
 * Articles d'une plage. DEUX chemins, et la réponse DIT lequel a servi (`resolution`) —
 * une étiquette qui borne un résultat voyage dans la sortie typée, jamais en prose seule.
 *
 * - `"document"` : les deux bornes désignent des articles réels existants. L'étendue est
 *   celle du TEXTE, de la première borne à la seconde, sur `id`. EXACTE par construction :
 *   `id` est une clé primaire, donc aucune collision n'est possible — ce que `sort_key` ne
 *   peut pas garantir (cf. `boundRef`). C'est aussi la bonne sémantique : « de l'article
 *   15.1 à l'article 15.2 » désigne une étendue de texte, pas un intervalle numérique.
 * - `"cle"` : au moins une borne est ouverte ou désigne un pseudo-article. Intervalle sur
 *   `sort_key`, comportement d'origine inchangé. Ce chemin peut sur-inclure si une borne
 *   inexistante retombe par calcul sur une clé partagée ; c'est pourquoi il est ÉTIQUETÉ.
 */
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
    // Les pseudo-articles dont l'`id` tombe DANS l'intervalle sont exclus : leur position
    // d'émission n'est pas leur position dans le document (cf. `boundRef`). Sans ce filtre,
    // une plage 3..4 de b-1-r.3.1 EN ramasserait `préliminaire`.
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
        // `sort_key` n'est PAS projetée : SQLite trie sur une colonne non projetée sans
        // difficulté (même patron que articlesInDivision, plus bas). Départage par `id` :
        // sans lui, deux articles à clé identique s'ordonnent au hasard et la pagination
        // peut en sauter ou en répéter un.
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
  const placeholders = numbers.map(() => "?").join(",");
  const rows = (
    await db
      .prepare(
        // Départage par `id` : deux numéros demandés peuvent partager une clé de tri
        // (cf. `boundRef`), et sans départage leur ordre serait arbitraire.
        `SELECT ${ARTICLE_COLS} FROM articles WHERE law_id=? AND lang=? AND number IN (${placeholders})
       ORDER BY sort_key, id`,
      )
      .bind(lawId, lang, ...numbers)
      .all<ArticleRow>()
  ).results;
  return rows;
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

/** Articles d'une division ET de tout son sous-arbre (division_path = path ou descendant). */
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
        // Départage par `id` : la pagination doit être stable même quand deux articles
        // partagent une clé de tri (cf. `boundRef`).
        `SELECT ${cols} FROM articles WHERE law_id=? AND lang=? AND ${sub}
       ORDER BY sort_key, id LIMIT ? OFFSET ?`,
      )
      .bind(lawId, lang, ...subBinds, page.limit, page.offset)
      .all<Partial<ArticleRow>>()
  ).results;
  return { rows, total };
}

// --- arbre de structure -------------------------------------------------------

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
  // Les sept colonnes que l'arbre consomme, sur les douze de la table. `getStructure('ccq')`
  // sans root_path lit 802 divisions : les cinq non lues (law_id, lang, history, sort_order
  // et heading_norm — cette dernière n'étant même pas déclarée par DivisionRow) pèsent 38 %
  // des octets. `sort_order` sert au tri sans être projetée. PERDRE `parent_id` APLATIRAIT
  // L'ARBRE en silence — toutes les divisions deviendraient racines ; c'est ce que le
  // contrôle « l'arbre a plus d'un niveau » de tests/evals.mjs surveille.
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
      roots.push(node); // racine réelle, ou racine du sous-arbre demandé
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

// --- analyse d'une citation libre (resolve_reference) -------------------

export interface AmbiguousLaw {
  id: string;
  official_cite: string;
  name_fr: string;
}

export interface ParsedCitation {
  law: string | null;
  article: string | null;
  /** Comment la loi a été reconnue, pour l'expliquer dans la réponse. */
  law_source: "chapitre" | "abreviation" | "defaut" | null;
  /** Chapitre RLRQ cité explicitement mais absent du corpus (pour un refus circonstancié). */
  chapitre_inconnu: string | null;
  /**
   * Texte NOMMÉMENT hors corpus, reconnu comme tel plutôt que rabattu sur son successeur.
   * Aujourd'hui une seule valeur : « C-25 », l'ANCIEN Code de procédure civile.
   */
  hors_corpus: string | null;
  /** Candidats multiples quand la citation est ambiguë (ex. « Directives C.S. », « 45-106 »). */
  ambigu: AmbiguousLaw[] | null;
}

/**
 * Motif reconnaissant un chapitre RLRQ comme UNE UNITÉ COMPLÈTE dans une citation.
 *
 * Un simple `includes` est faux et dangereux : « B-1 » est contenu dans « B-1.1 », si bien
 * qu'une citation de la Loi sur le bâtiment (c. B-1.1, hors corpus) se résolvait
 * silencieusement en Loi sur le Barreau (c. B-1). D'où les garde-fous :
 *  - rien qui prolonge le chapitre avant ni après (lettre, chiffre, trait d'union) ;
 *  - ni un « . » SUIVI D'UN CHIFFRE après (c'est ce qui distingue B-1.1 de « c. B-1. ») ;
 *  - espaces libres à l'intérieur, pour accepter « C-25.01, r. 9 » comme « C-25.01,r.9 ».
 */
function chapterRegex(chapter: string): RegExp {
  const esc = [...chapter]
    .filter((c) => !/\s/.test(c))
    .map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s*");
  const regGuard = /,\s*r\./i.test(chapter) ? "" : "(?!\\s*(?:,|\\s)\\s*r\\.\\s*[0-9])";
  return new RegExp(`(?<![A-Za-z0-9-])${esc}(?![A-Za-z0-9-])(?!\\.\\d)${regGuard}`, "i");
}

/** Mention explicite de chapitre (« c. B-1.1 », « ch. B-3 », « chapitre T-16 »), pour refuser en le nommant. */
const CHAPITRE_EXPLICITE =
  /\b(?:c\.|ch\.|chapitres?|chapters?)\s*([A-Za-z]{1,6}-[0-9][0-9.]*(?:(?:\s*,\s*|\s+)r\.\s*[0-9][0-9.]*)?)/i;

/**
 * Numéro d'article/paragraphe/règle (y compris alphanumérique CSA/AMF : 2A.1, 4B.2),
 * introduit par un marqueur. « a. » est la forme courante au Québec, et « s. » la forme
 * anglaise — ancrées pour ne pas mordre sur « C.S. 115 ».
 */
const MARQUEUR_ARTICLE =
  /(?:(?:\barticles?\b|\barts?\.|\bparagraphes?\b|\bpara\.|\bpar\.|\bdir\.|\br[eè]gles?\b|\brules?\b|(?<![A-Za-zÀ-ÿ0-9.])a\.|(?<![A-Za-zÀ-ÿ0-9.])s\.)\s*|§\s*)(\d+[A-Za-z]?(?:\.\d+[A-Za-z]?)*(?![A-Za-z0-9]))/i;

const AMF_PAIRS: Record<string, { regId: string; igId: string }> = {
  "31-103": { regId: "v-1.1-r.10", igId: "amf-ig-31-103" },
  "45-106": { regId: "v-1.1-r.21", igId: "amf-ig-45-106" },
  "51-102": { regId: "v-1.1-r.24", igId: "amf-ig-51-102" },
};
const AMF_REG_IDS = new Set(Object.values(AMF_PAIRS).map((p) => p.regId));

/** Districts, villes et régions administratives du Québec non couverts par un texte QCCS/QCCQ ingéré. */
const AUTRES_DISTRICTS_QC =
  /\b(?:laval|longueuil|sherbrooke|gatineau|trois[- ]rivieres|rimouski|saguenay|chicoutimi|alma|terrebonne|joliette|saint[- ]jerome|st[- ]jerome|saint[- ]hyacinthe|st[- ]hyacinthe|drummond|drummondville|granby|victoriaville|shawinigan|valleyfield|salaberry|sorel|thetford(?:[- ]mines)?|roberval|sept[- ]iles|baie[- ]comeau|val[- ]d['’ ]?or|val[- ]dor|amos|rouyn(?:[- ]noranda)?|abitibi|outaouais|estrie|mauricie|laurentides|lanaudiere|monteregie|bas[- ]saint[- ]laurent|gaspe|gaspesie|bonaventure|charlevoix|beauce|frontenac|megantic|lac[- ]megantic|arthabaska|richelieu|iberville|bedford|saint[- ]francois|st[- ]francois|kamouraska|mingan|labelle|hull|pontiac|temiscamingue|chaudiere|appalaches|beauharnois|mont[- ]laurier|cowansville|la\s+malbaie|malbaie|perce|montmagny|riviere[- ]du[- ]loup|matane|chibougamau|amqui|new\s+carlisle|campbell['’]?s\s+bay|havre[- ]saint[- ]pierre|havre[- ]st[- ]pierre|sainte[- ]anne[- ]des[- ]monts|ste[- ]anne[- ]des[- ]monts|saint[- ]jean[- ]sur[- ]richelieu|st[- ]jean[- ]sur[- ]richelieu|saint[- ]joseph[- ]de[- ]beauce|st[- ]joseph[- ]de[- ]beauce|saint[- ]maurice|st[- ]maurice|la\s+tuque|ville[- ]marie|iles[- ]de[- ]la[- ]madeleine|chandler|dolbeau|jonquiere|brossard|repentigny|blainville|saint[- ]eustache|st[- ]eustache|magog)\b/i;

const DISTRICT_NON_MTL =
  /\bdistrict(?:\s+(?:judiciaire|judicial))?\s+(?:de\s+l['’]|de\s+la\s+|de\s+|du\s+|des\s+|d['’]|of\s+)(?!montreal\b|mtl\b)[a-z]/i;
const DIVISION_QCCS_NON_INGERE =
  /\bdivision\s+(?:de\s+l['’]|de\s+la\s+|de\s+|du\s+|des\s+|d['’]|of\s+)(?!montreal\b|mtl\b|quebec\b|qc\b|pratique\b|famille\b|civile?\b|criminel(?:le)?\b|commerciale?\b|faillite\b|administrat|appel\b|jeunesse\b)[a-z]/i;

/** Pseudo-articles / annexes nommés (captés avant l'extraction de chiffre nu). */
const PSEUDO_ANNEXE_TIRETS = /\b(annexe(?:-[a-z0-9]+)+|formulaire(?:-[a-z0-9]+)+)\b/i;
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
  return new RegExp(`\\b(annexe|schedule|formulaire)\\s+(${corps})\\b`, "i");
}
const PSEUDO_ANNEXE_ESPACE = buildPseudoAnnexeEspace(ANNEXE_STOP_MOTS);
const PSEUDO_ANNEXE_ESPACE_IG = buildPseudoAnnexeEspace(ANNEXE_STOP_MOTS_IG);
const PSEUDO_NOTE_PRELIM = /\bnote[- ]pr[ée]liminaire\b/i;
const PSEUDO_PRELIM = /\b(?:dispositions?\s+pr[ée]liminaires?|pr[ée]liminaire)\b/i;
const PSEUDO_FINALES = /\b(?:dispositions?\s+finales?|finales)\b/i;
const PSEUDO_PREAMBULE = /\b(pr[ée]ambule|preamble)\b/i;
const STRIP_PSEUDO_NORM = new RegExp(
  `\\b(?:(?:annexe|formulaire)(?:-[a-z0-9]+)+|${PSEUDO_ANNEXE_ESPACE.source}|note[- ]preliminaire|dispositions?[- ]preliminaires?|dispositions?[- ]finales?)\\b`,
  "gi",
);

function extractPseudoArticle(rest: string, isIG = false): string | null {
  const restNorm = rest.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const mTirets = restNorm.match(PSEUDO_ANNEXE_TIRETS);
  if (mTirets) return mTirets[1].toLowerCase();
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
  return null;
}

const STRIP_DATES_ET_SALLES = [
  /\b(?:(?:R\.?\s*L\.?\s*R\.?\s*Q\.?|L\.?\s*R\.?\s*Q\.?|R\.?\s*S\.?\s*Q\.?|C\.?\s*Q\.?\s*L\.?\s*R\.?|RLRQ|CQLR)(?:\s*,)?\s+)?(?:c\.|ch\.|chapitres?|chapters?)\s*[A-Za-z]{1,6}-[0-9][0-9.]*(?:(?:\s*,\s*|\s+)r\.\s*[0-9.]+)?/gi,
  /(?<![A-Za-z0-9-])(?:31-103|45-106|51-102)(?![A-Za-z0-9-])/gi,
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
  official_cite: citeOf(l),
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

/**
 * Analyse « art. 1457 C.c.Q. », « RLRQ, c. T-16, art. 12 », « Directives C.S. Montréal, par. 12 »,
 * « IG 45-106, art. 4B.2 »…
 *
 * Deux pièges que la version naïve (« premier nombre trouvé », « défaut ccq ») ne gérait
 * pas, et qui faisaient rendre SILENCIEUSEMENT le mauvais article de la mauvaise loi :
 *  1. le chapitre ou la directive contient des chiffres (« c. T-16 », « (2026) », « 45-106 ») :
 *     on retire d'abord la mention de texte reconnue et les années parenthésées ;
 *  2. toute citation non reconnue ou ambiguë (ex. « Directives C.S. » ou « 45-106 » nu) est
 *     refusée plutôt que devinée.
 */
export function parseCitation(citation: string, laws: LawRow[]): ParsedCitation {
  const norm = normalize(citation);
  const amfMatch = norm.match(/(?<![0-9-])(31-103|45-106|51-102)(?![0-9-])/);
  const isIG = citesInstructionGenerale(norm);
  const isReg =
    /\b(?:reglements?|regl\b\.?|regulations?|reg\b\.?|national\s+instruments?|multilateral\s+instruments?|normes?\s+(?:canadiennes?|multilaterales?)|ni|rlrq|cqlr|lrq|rsq)\b|\b(?:r\.?\s*l\.?\s*r\.?\s*q\.?|l\.?\s*r\.?\s*q\.?|r\.?\s*s\.?\s*q\.?|c\.?\s*q\.?\s*l\.?\s*r\.?|n\.?\s*i\.)(?=\s|,|\)|$)/i.test(
      norm,
    );
  const citesV11Act = /\b(?:loi\s+sur\s+les\s+valeurs\s+mobilieres|securities\s+act)\b/i.test(norm);

  // 1) Citation officielle (FR ou EN) la PLUS LONGUE présente comme unité complète
  let law: string | null = null;
  let lawSource: ParsedCitation["law_source"] = null;
  let bestLen = 0;
  let motif: RegExp | null = null;
  for (const l of laws) {
    // Une citation explicite d'Instruction générale / Policy Statement mentionnant entre
    // parenthèses le règlement d'accompagnement (« ... (RLRQ, c. V-1.1, r. 21) ») ne doit
    // pas être détournée par le chapitre RLRQ du règlement à l'étape 1.
    if (isIG && AMF_REG_IDS.has(l.id)) continue;
    // Une citation AMF explicite (« Règlement 45-106 … », « IG 45-106 … ») ou mentionnant
    // la loi habilitante (« RLRQ, c. V-1.1 », « c. V-1.1 », « (V-1.1) ») ne doit pas être
    // capturée par v-1.1 à l'étape 1, même si elle nomme la Loi sur les valeurs mobilières.
    if (amfMatch && (!citesV11Act || isIG || isReg) && l.id === "v-1.1") continue;
    const cands = [citeOf(l), l.official_cite_en ?? ""];
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
  // 2) L'ANCIEN Code de procédure civile (C-25) EST NOMMÉ, PAS RABATTU.
  const ancienCpc =
    !law &&
    /c\.?\s*p\.?\s*c\.?|\bcpc\b|code\s+de\s+proc[ée]dure\s+civile|code\s+of\s+civil\s+procedure|\bc\.?\s*c\.?\s*p\.?\b/i.test(
      citation,
    ) &&
    /\bancien(?:ne)?s?\b|\bold\b|\bformer\b|\b1965\b/i.test(citation);

  // 3) Abréviations usuelles & désambiguïsation dynamique sur `laws`
  let ambigu: AmbiguousLaw[] | null = null;
  let extraStrip: RegExp | null = null;
  if (!law && !ancienCpc) {
    const byId = new Map(laws.map((l) => [l.id, l]));

    let igFromRegCite: string | null = null;
    if (isIG && !amfMatch) {
      for (const pair of Object.values(AMF_PAIRS)) {
        const regRow = byId.get(pair.regId);
        if (!regRow) continue;
        for (const rawCite of [citeOf(regRow), regRow.official_cite_en ?? ""]) {
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
          // District/division explicite hors Montréal/Québec : refuser plutôt que rabattre
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
              /montreal|mtl/.test(normalize(`${l.id} ${l.name_fr} ${citeOf(l)}`)),
            );
          }
          if (hasQc) {
            cands = cands.filter((l) =>
              /quebec|\bqc\b/.test(normalize(`${l.id} ${l.name_fr} ${citeOf(l)}`)),
            );
          }
          if (hasDist) {
            cands = cands.filter((l) =>
              /district|\bdist\b/.test(normalize(`${l.id} ${l.name_fr} ${citeOf(l)}`)),
            );
          }
          if (hasDiv) {
            cands = cands.filter((l) =>
              /division|\bdiv\b/.test(normalize(`${l.id} ${l.name_fr} ${citeOf(l)}`)),
            );
          }
          if (hasJugeAssociee && !hasMtl) {
            cands = cands.filter((l) =>
              /juge\s+en\s+chef\s+associee/.test(normalize(`${l.id} ${l.name_fr} ${citeOf(l)}`)),
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
                normalize(`${l.id} ${l.name_fr} ${citeOf(l)}`).replace(
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
    } else if (/c\.?\s*c\.?\s*q\.?|ccq/i.test(citation)) {
      law = "ccq";
      lawSource = "abreviation";
    }
  }

  // 4) Extraction du numéro d'article/paragraphe après retrait du texte reconnu, dates et salles
  let rest = motif ? citation.replace(motif, " ") : citation;
  if (extraStrip) rest = rest.replace(extraStrip, " ");
  for (const stripRe of STRIP_DATES_ET_SALLES) rest = rest.replace(stripRe, " ");
  const article =
    rest.match(MARQUEUR_ARTICLE)?.[1] ??
    extractPseudoArticle(rest, isIG) ??
    rest.match(/(?<![A-Za-z0-9.-])(\d+[A-Za-z]?(?:\.\d+[A-Za-z]?)*(?![A-Za-z0-9-]))/)?.[1] ??
    null;

  // 5) Chapitre explicitement cité mais inconnu du corpus (jamais déclenché si ambigu)
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

  // Le chapitre C-25 cité SOUS N'IMPORTE QUELLE FORME
  const horsCorpus =
    law || ambigu ? null : ancienCpc || chapterRegex("C-25").test(citation) ? "C-25" : null;

  return {
    law,
    article,
    law_source: law ? lawSource : null,
    chapitre_inconnu: horsCorpus ? null : explicite,
    hors_corpus: horsCorpus,
    ambigu,
  };
}

// --- données de pertinence (find_relevant) ------------------------------

/** Plafond de divisions préfiltrées ramenées du SQL (le tri fin se fait en mémoire). */
const DIVISION_PREFILTER_LIMIT = 2000;

export interface RelevanceData {
  subjects: SubjectLite[];
  subjectMap: SubjectMapLite[];
  laws: LawLite[];
  divisions: DivisionLite[];
  relations: RelationLite[];
  /** Clé `law_id|path_FR` -> cible (chemin + intitulé) dans la langue demandée. */
  mappedHeadings: Map<string, { path: string; heading: string | null }>;
}

/**
 * Charge le nécessaire au classement. Les tables de découverte sont petites (quelques
 * dizaines de matières et de mappages, moins de deux cents lois) : on les lit en entier. Seules les divisions (5 000+) sont
 * PRÉFILTRÉES en SQL par sous-chaîne ; l'ancrage au début de mot se fait ensuite en mémoire.
 */
export async function loadRelevanceData(
  db: D1Database,
  tokens: string[],
  lang: Lang,
  env: CorpusGateEnv = {},
): Promise<RelevanceData> {
  // Le masque de l'interrupteur, posé sur CHAQUE source du routeur. `find_relevant` ne
  // passe par aucun `getLaw`, donc le point d'étranglement ne le couvre pas : mesuré, il
  // rendait des candidats fédéraux pendant que `list_laws` annonçait 79 lois.
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
    db.prepare(`SELECT id, name_fr, name_en, name_norm, fonction FROM laws ${mId}`).all<{
      id: string;
      name_fr: string;
      name_en: string;
      name_norm: string | null;
      fonction: string | null;
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

  // Cibles des divisions citées par subject_map (pour nommer et ADRESSER les candidats S1).
  // Les chemins de subject_map sont français ; en anglais il faut les traduire, sinon la
  // piste renvoyée n'est pas ouvrable avec get_division(lang='en').
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

  // En anglais, on apparie le NOM ANGLAIS (présent en base pour tout le corpus) : sinon le signal S3
  // était muet dès qu'une requête anglaise nommait la loi en anglais.
  const lawsLite: LawLite[] = laws.results.map((l) => ({
    id: l.id,
    name_fr: lang === "en" ? l.name_en || l.name_fr : l.name_fr,
    name_norm: lang === "en" ? normalize(l.name_en || l.name_fr) : l.name_norm,
    fonction: l.fonction,
  }));

  // S1 apparie le libellé ET la description : sans leur version anglaise, le signal le plus
  // lourd du routeur (+3) ne se déclenchait jamais sur une requête anglaise.
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

// --- fils d'Ariane (plan v2, 1.3) ---------------------------------------------

export interface CrumbNode {
  path: string;
  kind: string;
  number: string | null;
  heading: string | null;
}

/**
 * Chaînes d'ancêtres (racine -> feuille) pour un lot de (law_id, division_path) —
 * pour rendre les résultats de recherche AUTO-EXPLICATIFS (cause n° 3 du post-mortem :
 * un chemin opaque n'apprend rien ; « Livre V, Titre IV : … droit international privé »
 * permet de RECONNAÎTRE la pertinence). Une requête IN par loi représentée.
 */
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

/** Noms des lois pour les en-têtes de groupes de résultats. */
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
        `SELECT id, name_fr, name_en, source, fonction, unit FROM laws WHERE id IN (${ids.map(() => "?").join(",")}) ` +
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

// --- journal des recherches retiré à l'exécution (Phase 3 — S13, S14, G9) ---
// Aucune écriture dans `search_log` n'a plus lieu à l'exécution : seuls les compteurs agrégés
// (`compteur_jour`) et événements techniques sans contenu (`evenement_technique`) sont tenus
// dans `DB_IDENTITE`. La migration `0001_search_log.sql` reste conservée uniquement pour la
// reproductibilité de la chaîne historique D1.

// --- recherche plein texte (FTS5) --------------------------------------------

export interface SearchHit {
  law_id: string;
  number: string;
  division_path: string;
  snippet: string;
  /** Score bm25 (négatif : plus bas = plus pertinent). Présent sur les chemins relaxés. */
  score?: number;
  /** Résultat issu du seul chemin vectoriel (repérage sémantique). */
  semantic?: boolean;
  /** Fonction normative de la loi (pour pondération et plafond de diversité). */
  fonction?: string | null;
  /** Langue effective du brief matérialisé (ex. 'fr' en repli sur une requête 'en'). */
  hit_lang?: Lang;
}

/**
 * CE QUE FTS5 FAIT RÉELLEMENT SUR D1 — sondes exécutées contre la base DISTANTE le
 * 2026-07-20. Ce sont des faits sur la PLATEFORME, pas sur le corpus : ils ne vieillissent
 * pas quand le corpus grandit, contrairement à tout décompte. Les refaire coûte une
 * campagne de sondes en production, d'où leur place ici plutôt que dans un document daté.
 *
 * - **Tokenizer par défaut (`unicode61`), `remove_diacritics` ACTIF** : `MATCH 'extranéité'`
 *   ≡ `MATCH 'extraneite'` (3 = 3). Inutile donc de replier les accents avant d'interroger.
 * - **Aucun stemming français** : *signification* ≠ *signifiée* (94 vs 74 documents
 *   distincts au vocabulaire). C'est la raison d'être de l'appariement par préfixe borné de
 *   `src/relevance.ts` — FTS5 ne rapprochera jamais deux flexions tout seul.
 * - Disponibles et vérifiés : `bm25()`, `snippet()` (~30 tokens rendus correctement),
 *   `highlight()`, et `fts5vocab` (table sonde acceptée puis supprimée, 0 trace).
 * - **Une seule colonne indexée (`text`)** — cf. `schema.sql`. Une colonne headnotes
 *   pondérée exigerait de RECRÉER la table FTS : c'est une migration, pas un ALTER.
 *
 * CAS FONDATEUR, art. 490 C.p.c. — mesuré, et à l'origine de toute l'échelle de recherche :
 * | `signification hors du Québec délai`        | **0 résultat** — « hors » est absent du texte et tue le ET |
 * | `signification Québec délai` (leave-one-out) | cpc 490 en 1re position |
 * | `extranéité` (corpus entier)                 | ccq 3111, cpc 490, cpc 622 |
 *
 * Le Livre V du C.p.c. s'intitule « LES RÈGLES APPLICABLES À CERTAINES MATIÈRES CIVILES »
 * (aucun signal) ; le signal est au Titre IV, « LES DEMANDES INTÉRESSANT LE DROIT
 * INTERNATIONAL PRIVÉ » — d'où l'indexation des divisions en profondeur 2.
 */

/** Tokens FTS d'une requête (même découpage que toFtsQuery — un seul point de vérité). */
export function ftsTokens(query: string): string[] {
  return query.match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu) ?? [];
}

const quoteTok = (t: string) => `"${t.replace(/"/g, '""')}"`;

/**
 * Tokenise en requête FTS5 sûre : chaque mot en littéral quoté, combinés en ET.
 *
 * Cet ET implicite est la CAUSE Nº 1 de l'échec fondateur ci-dessus : un seul mot absent du
 * texte suffit à vider le résultat. Il est conservé — il donne des résultats justes quand
 * il en donne — et c'est l'échelle de relaxation qui le rattrape, en le DISANT (R7).
 */
export function toFtsQuery(query: string): string {
  return ftsTokens(query).map(quoteTok).join(" ");
}

/**
 * Issue d'une recherche : les résultats + le CHEMIN qui les a produits (plan v2, R7 :
 * fail open, toujours étiqueté). `elsewhere` couvre le cas du post-mortem que le seul
 * élargissement sur zéro ne couvre pas : une recherche RESTREINTE qui a des résultats
 * (« extranéité » sur ccq -> 3111) cachait ceux des autres lois (cpc 490).
 */
export interface SearchOutcome {
  hits: SearchHit[];
  total: number;
  /** null = exact dans la portée demandée ; 'semantic' = aucune correspondance lexicale. */
  fallback: null | "widened" | { loo: string } | "or_relax" | "semantic";
  /** Aperçu hors portée quand la recherche restreinte a des résultats ET que d'autres lois en ont. */
  elsewhere: { total: number; hits: SearchHit[] } | null;
  /** Correspondances de STRUCTURE (intitulés de divisions) par repérage sémantique. */
  divisions?: DivisionMatch[];
}

interface MatchScope {
  law?: string;
  notLaw?: string;
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
  // MATCH BORNÉ À LA COLONNE `text`, et c'est une décision de calibration, pas un détail.
  //
  // Depuis la migration 0004, `articles_fts` indexe AUSSI `marginal_note`. Or
  // `bm25(articles_fts)` est appelé sans poids de colonne (plus bas), donc une colonne
  // indexée de plus repondère TOUTE la recherche des 79 lois québécoises — et
  // `src/lib.ts` SOMME ces scores pour choisir quel terme le leave-one-out omet, ce qui
  // déplacerait jusqu'à l'étiquette `fallback` (R7) et le jeu rendu.
  //
  // Mesuré : à poids par défaut, une note marginale de trois mots est un « document » très
  // court, donc un signal disproportionné — une ligne fédérale a pris la 1re place devant
  // l'ancien 1er. On BORNE donc, ce qui préserve jeu et ordre à l'identique, et l'ouverture
  // de `marginal_note` en canal SÉPARÉ ET ÉTIQUETÉ reste à faire, avec des poids explicites
  // importés de src/relevance.ts et une mesure des 21 cas.
  const binds: unknown[] = [`{text} : (${match})`, lang];
  if (scope.law) {
    clauses.push("AND articles_fts.law_id = ?");
    binds.push(scope.law);
  }
  if (scope.notLaw) {
    clauses.push("AND articles_fts.law_id <> ?");
    binds.push(scope.notLaw);
  }
  // `articles_fts` ne porte PAS de colonne `jurisdiction` (et lui en ajouter une exigerait
  // de recréer la table), donc le masque passe par une sous-requête sur `laws`.
  //
  // POSÉ INCONDITIONNELLEMENT, y compris quand `scope.law` borne déjà la recherche — où il
  // est effectivement redondant, `src/tools.ts` ayant déjà fait `getLaw(db, law, env)`.
  //
  // J'ai essayé de ne le poser que sur les barreaux non bornés, en croyant qu'il déplaçait
  // l'ordre d'un cas d'éval. C'ÉTAIT FAUX, et la mesure l'a dit (voir ci-dessous). Il reste
  // donc entier : la fuite que ce masque referme était née exactement du raisonnement
  // « c'est déjà garanti en amont », et une sous-requête indexée ne se paie pas au prix
  // d'un second verrou dans un outil juridique.
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
  const weightedBm25 =
    `(CASE WHEN bm25(articles_fts) < 0 THEN bm25(articles_fts) * ${weightExpr} ` +
    `ELSE bm25(articles_fts) / ${weightExpr} END)`;
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

/** Bornes de l'échelle de relaxation (plan v2, 1.2). */
const RELAX_MIN_TERMS = 2;
const RELAX_MAX_LOO_TERMS = 6; // au-delà : sauter le leave-one-out, aller à l'étape OU

// --- couche sémantique (plan v2, 2.3) -----------------------------------------

/** Modèle d'embedding — multilingue (les requêtes EN atteignent les vecteurs FR). */
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

/** Embed la requête UNE fois (réutilisable entre la passe restreinte et l'élargie). */
async function embedQuery(v: VectorBackend, query: string): Promise<number[] | null> {
  try {
    const res = (await v.ai.run(EMBED_MODEL as Parameters<Ai["run"]>[0], {
      text: [query],
    })) as { data?: number[][] };
    return res?.data?.[0] ?? null;
  } catch {
    return null; // fail open : l'hybride se dégrade en FTS pur
  }
}

async function queryVectors(
  v: VectorBackend,
  values: number[],
  lawId: string | undefined,
): Promise<VectorHits | null> {
  try {
    const res = await v.index.query(values, {
      topK: VECTOR_TOP_K,
      returnMetadata: "all",
      ...(lawId ? { filter: { law: lawId } } : {}),
    });
    const out: VectorHits = { arts: [], divs: [] };
    for (const m of res.matches ?? []) {
      const md = (m.metadata ?? {}) as Record<string, string>;
      if (md.type === "article" && md.law && md.article) {
        if (m.score < SEMANTIC_MIN_SCORE) continue; // plancher anti-bruit
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
    return null; // fail open
  }
}

/**
 * L'INTERRUPTEUR APPLIQUÉ AU CANAL VECTORIEL — la porte que le masque D1 ne peut PAS fermer.
 *
 * `queryVectors` lit `md.law` dans les métadonnées de Vectorize, pas dans D1 : aucune clause
 * WHERE ne l'atteint. Et les deux sorties ne fuient pas de la même façon. `arts` est
 * rematérialisée en base, donc un masque en aval la rattraperait ; `divs` est servie
 * DIRECTEMENT (`law_id`, `path`, `heading` viennent des métadonnées) et n'est jamais
 * rematérialisée — un intitulé de division fédérale serait rendu tel quel.
 *
 * Filtrer ici plutôt qu'en aval a une seconde raison, moins visible : un résultat fédéral
 * qui entre dans la fusion RRF OCCUPE UN RANG, et déplace donc un résultat québécois même si
 * son texte n'est jamais rendu. Écarté après la fusion, il aurait dégradé le classement sans
 * apparaître nulle part.
 *
 * Aucun vecteur fédéral n'existe aujourd'hui (le backfill n'a pas tourné depuis l'ingestion
 * d'`ca-i-15`), donc ce filtre est neutre — mais c'est la phase 6 qui les posera, et la vraie
 * garde d'alors est l'index de métadonnées `jurisdiction` déclaré AVANT le premier upsert
 * (invariant 8 : ces index ne sont pas rétroactifs). Ce filtre-ci reste le filet du cas où
 * l'ordre serait manqué.
 *
 * Coût nul dans l'état visé : interrupteur ouvert, on rend `vec` sans toucher à D1.
 */
async function filtreVecteurs(
  db: D1Database,
  vec: VectorHits | null,
  env: CorpusGateEnv,
): Promise<VectorHits | null> {
  const c = clauseCorpus(env, "");
  if (!vec || !c) return vec;
  const ids = [...new Set([...vec.arts.map((a) => a.law), ...vec.divs.map((d) => d.law_id)])];
  if (!ids.length) return vec;
  const rows = (
    await db
      .prepare(`SELECT id FROM laws WHERE id IN (${ids.map(() => "?").join(",")}) AND ${c}`)
      .bind(...ids)
      .all<{ id: string }>()
  ).results;
  // Liste BLANCHE : un id absent de `laws` (vecteur périmé) est écarté lui aussi, plutôt que
  // toléré par défaut. C'est le même choix que la liste blanche d'ancêtres du parseur.
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

/** Matérialise des (law, number) en SearchHit dans la LANGUE DEMANDÉE (extrait ~240 car.). */
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

/**
 * Fusion RRF (k = RRF_K) des listes FTS et vectorielle, pondérée par `fonctionWeight`.
 * Les résultats absents du FTS sont matérialisés depuis D1 (avec repli `[fr]`) et marqués `semantic`.
 */
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
  // score cosine des correspondances vectorielles, pour l'observabilité (calibrage du plancher)
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

export async function searchText(
  db: D1Database,
  query: string,
  lang: Lang,
  lawId: string | undefined,
  page: Page,
  opts: { relax?: boolean; vector?: VectorBackend; env?: CorpusGateEnv } = {},
): Promise<SearchOutcome> {
  const env = opts.env ?? {};
  const match = toFtsQuery(query);
  if (!match) return { hits: [], total: 0, fallback: null, elsewhere: null };
  const scope: MatchScope = lawId ? { law: lawId } : {};

  // Hybride (plan v2, 2.3) : embed de la requête EN PARALLÈLE du FTS exact — une seule
  // fois, réutilisé par tous les barreaux. Pagination au-delà de la 1re page : FTS pur
  // (une liste fusionnée ne se pagine pas).
  const useVector = !!opts.vector && page.offset === 0;
  const [exact, qVec] = await Promise.all([
    runMatch(db, match, lang, scope, page, false, env),
    useVector ? embedQuery(opts.vector!, query) : Promise.resolve(null),
  ]);
  const vec = await filtreVecteurs(
    db,
    qVec ? await queryVectors(opts.vector!, qVec, lawId) : null,
    env,
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
  // vecteurs corpus entier (embedding réutilisé), pour les barreaux élargis — paresseux
  let vecWideCache: Awaited<ReturnType<typeof queryVectors>> | undefined;
  const vecWide = async () => {
    if (vecWideCache === undefined) {
      // Le barreau ELARGI repose le filtre : sans lawId, la requete Vectorize porte sur
      // tout l'index, donc c'est le chemin le PLUS expose au corpus federal.
      vecWideCache =
        lawId && qVec
          ? await filtreVecteurs(db, await queryVectors(opts.vector!, qVec, undefined), env)
          : vec;
    }
    return vecWideCache;
  };
  const fuse = async (
    fts: { hits: SearchHit[]; total: number },
    v: Awaited<ReturnType<typeof queryVectors>>,
  ) => (v?.arts.length ? await fuseHybrid(db, lang, fts, v, page.limit, env) : fts.hits);

  // ÉCHELLE (décision 2.4, tranchée par l'éval) : dérouler le LEXICAL jusqu'à sa meilleure
  // liste, PUIS fusionner avec les vecteurs. Le sémantique seul n'est que l'ultime barreau :
  // (a) des correspondances exactes ailleurs au corpus valent mieux que des voisins
  // sémantiques dans la loi demandée (« extranéité » restreinte à b-9) ; (b) deux voisins
  // au-dessus du plancher ne doivent pas court-circuiter l'étape OU qui trouve ccq 1726
  // (« vice caché maison recours » — régression attrapée par l'éval, corrigée ici).

  // 1) exact, portée demandée
  if (exact.total > 0) {
    let elsewhere: SearchOutcome["elsewhere"] = null;
    if (lawId) {
      const others = await runMatch(
        db,
        match,
        lang,
        { notLaw: lawId },
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
    };
  }

  // 2) élargissement automatique au corpus (plan v2, 1.1)
  if (lawId) {
    const wide = await runMatch(db, match, lang, {}, page, false, env);
    if (wide.total > 0) {
      return {
        hits: await fuse(wide, await vecWide()),
        total: wide.total,
        fallback: "widened",
        elsewhere: null,
        divisions: semDivs,
      };
    }
  }

  const tokens = ftsTokens(query);
  const relaxable = !!opts.relax && tokens.length >= RELAX_MIN_TERMS;

  // 3) leave-one-out (plan v2, 1.2), portée demandée — ≤ 6 SELECT
  if (relaxable && tokens.length <= RELAX_MAX_LOO_TERMS) {
    let best: { hits: SearchHit[]; total: number; omitted: string; sum: number } | null = null;
    for (let i = 0; i < tokens.length; i++) {
      const partial = tokens
        .filter((_, j) => j !== i)
        .map(quoteTok)
        .join(" ");
      const r = await runMatch(db, partial, lang, scope, page, true, env);
      if (r.total === 0) continue;
      const sum = r.hits.reduce((acc, h) => acc + (h.score ?? 0), 0);
      if (!best || sum < best.sum) best = { ...r, omitted: tokens[i], sum };
    }
    // Le rendement est une CONDITION D'ARRÊT, pas un filtre de résultats : une liste trop
    // maigre laisse l'échelle continuer vers le OU, qui apparie les flexions que l'ET ne
    // peut pas atteindre (FTS5 sur D1 n'a aucune racinisation française). Cf.
    // RELAX_MIN_LOO_TOTAL, dont le commentaire porte la mesure des deux cas limites.
    // Le `Math.min` évite de rejeter une liste qui remplit déjà la page demandée.
    if (best && best.total >= Math.min(RELAX_MIN_LOO_TOTAL, page.limit)) {
      return {
        hits: await fuse(best, vec),
        total: best.total,
        fallback: { loo: best.omitted },
        elsewhere: null,
        divisions: semDivs,
      };
    }
  }

  // 4) OU + bm25 (plan v2, 1.2) : portée demandée, puis corpus. Termes composés éclatés
  //    (« non-concurrence » -> non, concurrence).
  if (relaxable) {
    const orTerms = [
      ...new Set(tokens.flatMap((t) => t.split(/[-.'’]/)).filter((t) => t.length >= 2)),
    ];
    if (orTerms.length) {
      const matchOr = orTerms.map(quoteTok).join(" OR ");
      const scoped = await runMatch(db, matchOr, lang, scope, page, true, env);
      if (scoped.total > 0) {
        return {
          hits: await fuse(scoped, vec),
          total: scoped.total,
          fallback: "or_relax",
          elsewhere: null,
          divisions: semDivs,
        };
      }
      if (lawId) {
        const wideOr = await runMatch(db, matchOr, lang, {}, page, true, env);
        if (wideOr.total > 0) {
          return {
            hits: await fuse(wideOr, await vecWide()),
            total: wideOr.total,
            fallback: "or_relax",
            elsewhere: null,
            divisions: semDivs,
          };
        }
      }
    }
  }

  // 5) repérage sémantique SEUL (au-dessus du plancher) : portée demandée, puis corpus
  for (const v of [vec, lawId ? await vecWide() : null]) {
    if (v?.arts.length) {
      const hits = await fuseHybrid(db, lang, { hits: [], total: 0 }, v, page.limit, env);
      if (hits.length) {
        return {
          hits,
          // `total` compte les appariements LEXICAUX, et rien d'autre — ici il n'y en a
          // aucun, par construction. Il valait `hits.length` : le champ changeait donc de
          // NATURE selon le barreau (décompte de corpus non paginé aux barreaux 1-4, taille
          // de page ici), et nul ne pouvait l'interpréter sans lire `fallback`. Le nombre
          // réellement rendu est publié à part (`returned`, cf. src/tools.ts).
          total: 0,
          fallback: "semantic",
          elsewhere: null,
          divisions: semDivs,
        };
      }
    }
  }

  return { hits: [], total: 0, fallback: null, elsewhere: null, divisions: semDivs };
}
