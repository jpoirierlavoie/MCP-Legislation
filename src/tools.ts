// Gestionnaires des outils MCP « Lois du Québec et du Canada ». Tous en lecture seule.
import {
  type ArticleJoined,
  type ArticleLink,
  type ArticleRow,
  articlesByNumbers,
  articlesByRange,
  articlesInDivision,
  boundRef,
  breadcrumbChains,
  childDivisions,
  citationOf,
  citeOf,
  consolOf,
  getArticle,
  getDivision,
  getLaw,
  getStructure,
  headingInOtherLang,
  type Lang,
  type LawRow,
  type LawSummary,
  lawLangs,
  lawMetas,
  lawNames,
  lawOutlines,
  listLaws,
  listSubjects,
  loadRelevanceData,
  type NormativeRelation,
  nearestArticles,
  normativeRelations,
  paginate,
  parseCitation,
  parseLinks,
  relatedLaws,
  type StructureNode,
  searchText,
  translateDivisionPath,
  unitLabel,
} from "./lib";
import {
  detectLanguageMismatch,
  FONCTIONS_SOUPLES,
  MAX_PER_FONCTION_SOUPLE,
  rank,
  tokenize,
  WEIGHTS,
} from "./relevance";

/**
 * Garde-fou imposé par le plan (§4.4) — repris TEL QUEL, à ne pas reformuler.
 * Il rappelle que la découverte est heuristique et ne décide pas du droit applicable.
 */
const GARDE_FOU =
  "Aide heuristique au repérage de lois et de parties de lois candidates. " +
  "Ne détermine PAS le droit applicable : toujours vérifier en lisant le texte via " +
  "get_structure / get_division / get_article.";

// Libellés de type de division, par langue (l'anglais dit « Division » pour la « Section »).
const KIND_LABEL: Record<Lang, Record<string, string>> = {
  fr: {
    partie: "Partie",
    livre: "Livre",
    titre: "Titre",
    chapitre: "Chapitre",
    section: "Section",
    "sous-section": "Sous-section",
    niveau6: "Niveau",
    niveau7: "Niveau",
    niveau8: "Niveau",
    disposition: "Disposition",
    annexe: "Annexe",
  },
  en: {
    partie: "Part",
    livre: "Book",
    titre: "Title",
    chapitre: "Chapter",
    section: "Division",
    "sous-section": "Subsection",
    niveau6: "Level",
    niveau7: "Level",
    niveau8: "Level",
    disposition: "Provision",
    annexe: "Schedule",
  },
};

// Libellés de related_laws, par langue. Même motif que KIND_LABEL : l'outil
// déclarait `lang` sans l'honorer — un client qui demandait l'anglais recevait du français
// sans la moindre étiquette, ce qui est « faux, servi, silencieux ».
const REL_LABEL: Record<
  Lang,
  {
    inconnue: (l: string) => string;
    dispo: string;
    aucune: string;
    aucuneRel: (l: string) => string;
    deType: (t: string) => string;
    enDirection: (d: string) => string;
    essayez: string;
    horsCorpus: string;
    renvois: string;
    relations: string;
    affichees: (n: number) => string;
    dontHors: (n: number) => string;
  }
> = {
  fr: {
    inconnue: (l) => `Loi '${l}' inconnue.`,
    dispo: "Lois disponibles :",
    aucune: "aucune",
    aucuneRel: (l) => `Aucune relation pour '${l}'`,
    deType: (t) => ` de type '${t}'`,
    enDirection: (d) => ` en direction '${d}'`,
    essayez: "Essayez sans filtre, ou list_laws pour la carte du corpus.",
    horsCorpus: "NON disponible au corpus (candidat d'acquisition)",
    renvois: "renvoi(s)",
    relations: "relation(s) pour",
    affichees: (n) => ` (${n} affichées)`,
    dontHors: (n) => ` — dont ${n} hors corpus`,
  },
  en: {
    inconnue: (l) => `Unknown statute '${l}'.`,
    dispo: "Available statutes:",
    aucune: "none",
    aucuneRel: (l) => `No relation for '${l}'`,
    deType: (t) => ` of type '${t}'`,
    enDirection: (d) => ` in direction '${d}'`,
    essayez: "Try without a filter, or list_laws for the corpus map.",
    horsCorpus: "NOT available in the corpus (acquisition candidate)",
    renvois: "reference(s)",
    relations: "relation(s) for",
    affichees: (n) => ` (${n} shown)`,
    dontHors: (n) => ` — ${n} outside the corpus`,
  },
};

type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

const err = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });
const ok = (text: string, structured?: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text }],
  ...(structured ? { structuredContent: structured } : {}),
});

function divisionLabel(
  kind: string,
  number: string | null,
  heading: string | null,
  lang: Lang,
): string {
  const label = (KIND_LABEL[lang] ?? KIND_LABEL.fr)[kind] ?? kind;
  const parts = [label, number ?? ""].filter(Boolean).join(" ");
  return heading ? `${parts} — ${heading}` : parts;
}

function frOnlyError(lawId: string, lawRow?: LawRow | null): ToolResult {
  const cite = lawRow ? citeOf(lawRow) : "";
  return err(
    `Law '${lawId}'${cite ? ` (${cite})` : ""} is published in French only (langs: ['fr']). Re-run with lang='fr'.`,
  );
}

function normativeNote(law: Pick<LawRow, "fonction">, lang: Lang): string | null {
  if (law.fonction === "directive") {
    return lang === "en"
      ? "Normative status: court practice directive (non-legislative, non-binding, PDF source)."
      : "Statut normatif : directive de pratique judiciaire (texte non législatif, source PDF).";
  }
  if (law.fonction === "orientation") {
    return lang === "en"
      ? "Normative status: administrative policy statement (non-legislative, non-binding, no force of law, PDF source)."
      : "Statut normatif : document d'orientation administrative (texte non législatif, valeur indicative, sans force de loi, source PDF).";
  }
  return null;
}

function formatNormativeRelations(rels: NormativeRelation[], lang: Lang): string {
  if (!rels.length) return "";
  return rels
    .map((r) => {
      const target = `${r.other_id}${r.other_name ? ` (${r.other_name})` : ""}`;
      const note = r.note ? ` — ${r.note}${lang === "en" ? " [fr]" : ""}` : "";
      if (r.rel_type === "preseance-sur") {
        if (lang === "en") {
          return r.direction === "out"
            ? `Precedence (preseance-sur): ${target}${note}`
            : `Precedence (preseance-sur, linked text: ${target})${note}`;
        }
        return r.direction === "out"
          ? `Préséance (preseance-sur) : ${target}${note}`
          : `Préséance (preseance-sur, texte lié : ${target})${note}`;
      }
      if (lang === "en") {
        return r.direction === "out"
          ? `Interprets: ${target}${note}`
          : `Interpreted by: ${target}${note}`;
      }
      return r.direction === "out"
        ? `Interprète : ${target}${note}`
        : `Interprété par : ${target}${note}`;
    })
    .join("\n");
}

function formatLinksFooter(links: ArticleLink[], lang: Lang): string {
  if (!links.length) return "";
  const titre = lang === "en" ? "Links:" : "Liens :";
  return `\n\n${titre}\n${links.map((l) => `  • ${l.label} — ${l.url}`).join("\n")}`;
}

function renderArticle(
  a: ArticleJoined,
  loi: LawRow,
  consol: string | null,
  lang: Lang,
  rels: NormativeRelation[] = [],
  links: ArticleLink[] = [],
): string {
  const cite = citationOf(loi, a.number, lang);
  const loc = a.d_kind
    ? `\n${divisionLabel(a.d_kind, a.d_number, a.d_heading, lang)} [${a.division_path}]`
    : "";
  const head = `${cite}${consol ? ` (à jour au ${consol})` : ""}${a.repealed ? " — ABROGÉ" : ""}${loc}`;
  const note = normativeNote(loi, lang);
  const relsText = formatNormativeRelations(rels, lang);
  const normLines = [note, relsText].filter(Boolean).join("\n");
  const normBlock = normLines ? `\n${normLines}` : "";
  const hist = a.history ? `\n\nHistorique : ${a.history}` : "";
  const linksFooter = formatLinksFooter(links, lang);
  return `${head}${normBlock}\n\n${a.text}${hist}${linksFooter}`;
}

/** Un gestionnaire d'outil vu du registre : arguments déjà validés, résultat d'outil. */
export type Gestionnaire = (args: never) => Promise<ToolResult>;

/** Les gestionnaires par nom d'outil. Consommé par le routeur du socle. */
export type Registre = Record<string, Gestionnaire>;

/** Indique si le moteur vectoriel hybride est configuré et actif sur l'instance. */
export function estHybrideConfigure(env: Env): boolean {
  const flags = env as unknown as { HYBRID_SEARCH?: string };
  const brut = (flags.HYBRID_SEARCH ?? "").trim().toLowerCase();
  return (brut === "1" || brut === "true") && Boolean(env.AI && env.VECTORS);
}

function normalizeArticleToken(raw: string): string {
  const t = raw.trim().normalize("NFC");
  if (t.toLowerCase() === "preliminaire") return "préliminaire";
  if (/^1(?:er|\u1d49\u02b3|re|\u02b3\u1d49)$/i.test(t)) return "1";
  return t;
}

/** Construit les gestionnaires des dix outils publiés pour le routeur du socle. */
export function construireOutils(
  env: Env,
  options?: { hybridePermis?: boolean; surExecutionSemantique?: () => void },
): Registre {
  const db = env.DB;
  const hybridePermis = options?.hybridePermis ?? true;
  const outils: Registre = {};

  // 1) list_laws ---------------------------------------------------------
  //
  // Écart au plan v2 (1.4), consigné au rapport : le critère « toute loi dont les
  // divisions comportent le kind livre » rate sa cible — le parseur classe
  // POSITIONNELLEMENT (ga: = livre) — mesuré à 38 lois : 36 en avaient — et le plan
  // complet pèserait ~22 K tokens par appel. Le budget annoncé (+1,2–1,5 K) correspond
  // exactement à ccq + cpc (93 nœuds) : c'est l'intention. Liste extensible au besoin.
  const OUTLINE_LAWS = ["ccq", "cpc"];

  const renderOutline = (nodes: import("./lib").OutlineNode[], lang: Lang): string =>
    nodes
      .map((n) => {
        const lab = (KIND_LABEL[lang] ?? KIND_LABEL.fr)[n.kind] ?? n.kind;
        const head = `    ▸ ${lab}${n.number ? ` ${n.number}` : ""}${n.heading ? ` — ${n.heading}` : ""} [${n.path}]`;
        const kids = n.children.map((c) => {
          const cl = (KIND_LABEL[lang] ?? KIND_LABEL.fr)[c.kind] ?? c.kind;
          return `      · ${cl}${c.number ? ` ${c.number}` : ""}${c.heading ? ` — ${c.heading}` : ""} [${c.path}]`;
        });
        return [head, ...kids].join("\n");
      })
      .join("\n");

  const renderLaw = (
    l: LawSummary,
    outline?: import("./lib").OutlineNode[],
    lang: Lang = "fr",
  ): string => {
    const attrs = [
      l.fonction ? `fonction: ${l.fonction}` : null,
      l.forum ? `forum: ${l.forum}` : null,
      l.parent_law_id ? `loi habilitante: ${l.parent_law_id}` : null,
      l.subjects.length ? `matières: ${l.subjects.join(", ")}` : null,
    ]
      .filter(Boolean)
      .join(" ; ");
    const titlePair =
      l.name_en && l.name_en !== l.name_fr ? `${l.name_fr} / ${l.name_en}` : l.name_fr;
    const head =
      `• ${l.id} — ${titlePair} (${citeOf(l)}) ; ` +
      `langues: ${l.langs.join(", ") || "aucune"} ; ` +
      `à jour au ${l.consol_date_fr ?? "?"}${l.consol_date_en ? ` (en: ${l.consol_date_en})` : ""} ; ` +
      `${l.article_count} articles`;
    // portée : repli sur name_fr tant que la passe éditoriale scope_fr n'est pas faite (§5)
    const scope = l.scope_fr ? `\n    portée: ${l.scope_fr}` : "";
    // pour les grands codes : les divisions rattachées à une matière (les Livres du C.c.Q.)
    const divs = l.mapped_divisions.length
      ? "\n" +
        l.mapped_divisions
          .map((d) => `    ◦ ${d.heading ?? d.division_path} [${d.division_path}] — ${d.subject}`)
          .join("\n")
      : "";
    const plan = outline?.length ? `\n${renderOutline(outline, lang)}` : "";
    return `${head}${attrs ? `\n    ${attrs}` : ""}${scope}${divs}${plan}`;
  };

  const H_LIST_LAWS = async ({
    fonction,
    forum,
    subject,
    structure: structureArg,
    lang: langArg,
  }: {
    fonction?: string;
    forum?: string;
    subject?: string;
    structure?: boolean;
    lang?: "fr" | "en";
  }) => {
    // Défauts RELOCALISÉS depuis le schéma (le validateur cible ne les applique pas).
    const lang: Lang = (langArg ?? "fr") as Lang;
    const structure = structureArg ?? true;
    const laws = await listLaws(db, { fonction, forum, subject }, lang as Lang, env);
    // 1.4 : le signal de repérage est souvent au Titre, pas au Livre (post-mortem :
    // Livre V C.p.c. muet, Titre IV parlant) — plan profondeur 2 des lois à Livres.
    const outlines =
      structure === false
        ? new Map<string, import("./lib").OutlineNode[]>()
        : await lawOutlines(
            db,
            (lang ?? "fr") as Lang,
            laws.map((l) => l.id).filter((id) => OUTLINE_LAWS.includes(id)),
          );
    if (laws.length === 0) {
      const applied = [
        fonction ? `fonction='${fonction}'` : null,
        forum ? `forum='${forum}'` : null,
        subject ? `subject='${subject}'` : null,
      ]
        .filter(Boolean)
        .join(", ");
      return err(
        applied
          ? `Aucune loi pour ${applied}. Vérifiez les valeurs (list_subjects pour les matières) ` +
              "ou appelez list_laws sans filtre."
          : "Aucune loi chargée dans la base.",
      );
    }
    const header = `${laws.length} loi(s) au corpus :`;
    const body = laws
      .map((l) => renderLaw(l, outlines.get(l.id), (lang ?? "fr") as Lang))
      .join("\n");
    return ok(`${header}\n${body}`, {
      filters: { fonction: fonction ?? null, forum: forum ?? null, subject: subject ?? null },
      count: laws.length,
      laws: laws.map((l) => ({
        id: l.id,
        name_fr: l.name_fr,
        name_en: l.name_en,
        // Clé HISTORIQUE conservée le temps de la migration : la retirer ici serait
        // une rupture de contrat pour tout consommateur du champ typé. Le passage à
        // `official_cite` seul est un commit séparé, annoncé.
        rlrq_cite: citeOf(l),
        official_cite: citeOf(l),
        langs: l.langs,
        consol_date_fr: l.consol_date_fr,
        consol_date_en: l.consol_date_en,
        article_count: l.article_count,
        fonction: l.fonction,
        forum: l.forum,
        // PAS de repli sur name_fr : la portée éditoriale n'a jamais été rédigée (79 lois
        // sur 79 à NULL), et substituer le titre servait au client un champ VIDE AYANT
        // L'AIR PLEIN — sans rien qui dise que c'en était un repli. La sortie texte, elle,
        // omettait honnêtement la ligne (voir renderLaw) : les deux surfaces du même outil
        // se contredisaient. Corollaire structuré de R4, décision 001.
        scope: l.scope_fr,
        parent_law_id: l.parent_law_id,
        subjects: l.subjects,
        mapped_divisions: l.mapped_divisions,
        structure: outlines.get(l.id) ?? null,
      })),
    });
  };
  outils.list_laws = H_LIST_LAWS as Gestionnaire;

  // 1b) list_subjects ----------------------------------------------------
  const H_LIST_SUBJECTS = async ({ lang: langArg }: { lang?: "fr" | "en" }) => {
    // Défauts RELOCALISÉS depuis le schéma (le validateur cible ne les applique pas).
    const lang: Lang = (langArg ?? "fr") as Lang;
    const en = lang === "en";
    const subs = await listSubjects(db, env);
    if (subs.length === 0) return err("Aucune matière chargée (taxonomie absente).");
    const KIND: Record<string, string> = en
      ? { "prive-ccq": "Private law (C.C.Q.)", specialise: "Specialized areas" }
      : { "prive-ccq": "Droit privé (C.c.Q.)", specialise: "Matières spécialisées" };
    const libelle = (s: (typeof subs)[number]) => (en ? s.label_en || s.label_fr : s.label_fr);
    const descr = (s: (typeof subs)[number]) =>
      en ? s.description_en || s.description_fr : s.description_fr;
    const groups = new Map<string, typeof subs>();
    for (const s of subs) {
      const g = groups.get(s.kind);
      if (g) g.push(s);
      else groups.set(s.kind, [s]);
    }
    const body = [...groups.entries()]
      .map(
        ([kind, items]) =>
          `\n${KIND[kind] ?? kind} :\n` +
          items
            .map(
              (s) =>
                `  • ${s.id} — ${libelle(s)} (${s.laws_count} ${en ? "law(s)" : "loi(s)"}` +
                `${s.divisions_count ? `, ${s.divisions_count} division(s)` : ""})` +
                `${descr(s) ? `\n      ${descr(s)}` : ""}`,
            )
            .join("\n"),
      )
      .join("\n");
    return ok(`${subs.length} ${en ? "subject areas" : "matières"} :${body}`, {
      count: subs.length,
      subjects: subs.map((s) => ({
        id: s.id,
        label_fr: s.label_fr,
        label_en: s.label_en,
        kind: s.kind,
        label: libelle(s),
        description: descr(s),
        description_fr: s.description_fr,
        description_en: s.description_en,
        laws_count: s.laws_count,
        divisions_count: s.divisions_count,
      })),
    });
  };
  outils.list_subjects = H_LIST_SUBJECTS as Gestionnaire;

  // 1c) related_laws -----------------------------------------------------
  const H_RELATED_LAWS = async ({
    law: rawLaw,
    rel_type,
    direction: directionArg,
    limit,
    lang: langArg,
  }: {
    law: string;
    rel_type?: string;
    direction?: "out" | "in" | "both";
    limit?: number;
    lang?: "fr" | "en";
  }) => {
    const law = rawLaw.trim().toLowerCase();
    // Défauts RELOCALISÉS depuis le schéma (le validateur cible ne les applique pas).
    const lang: Lang = (langArg ?? "fr") as Lang;
    const direction = directionArg ?? "both";
    const L = REL_LABEL[lang as Lang] ?? REL_LABEL.fr;
    if (!(await getLaw(db, law, env))) {
      const all = (await listLaws(db, {}, "fr", env)).map((l) => l.id).join(", ");
      return err(`${L.inconnue(law)} ${L.dispo} ${all || L.aucune}.`);
    }
    const all = await relatedLaws(db, law, rel_type, direction, lang as Lang, env);
    if (all.length === 0) {
      return err(
        `${L.aucuneRel(law)}` +
          `${rel_type ? L.deType(rel_type) : ""}` +
          `${direction !== "both" ? L.enDirection(direction) : ""}. ${L.essayez}`,
      );
    }
    const page = paginate(limit, 0, 50, 200);
    const edges = all.slice(0, page.limit);
    const lines = edges.map((e) => {
      const arrow = e.direction === "out" ? "→" : "←";
      const dispo = e.in_corpus ? (e.other_name ? ` — ${e.other_name}` : "") : ` — ${L.horsCorpus}`;
      const w = e.rel_type === "renvoie-a" ? ` ; ${e.weight} ${L.renvois}` : "";
      // Les notes curées n'existent QU'EN FRANÇAIS (law_relations n'a pas de colonne
      // note_en) : sous lang='en' on les rend marquées [fr] plutôt que de laisser croire
      // à une traduction. Même motif que l'intitulé emprunté de get_division.
      const note = e.note ? `${e.note}${lang === "en" ? " [fr]" : ""}` : null;
      return (
        `  ${arrow} ${e.other_id} [${e.rel_type}, ${e.source}${w}]${dispo}` +
        `${note ? `\n      ${note}` : ""}`
      );
    });
    const hors = edges.filter((e) => !e.in_corpus).length;
    const head =
      `${all.length} ${L.relations} '${law}'` +
      `${edges.length < all.length ? L.affichees(edges.length) : ""}` +
      `${hors ? L.dontHors(hors) : ""} :`;
    return ok(`${head}\n${lines.join("\n")}`, {
      law,
      lang,
      rel_type: rel_type ?? null,
      direction,
      total: all.length,
      count: edges.length,
      relations: edges.map((e) => ({
        direction: e.direction,
        other_id: e.other_id,
        other_name: e.other_name,
        rel_type: e.rel_type,
        source: e.source,
        weight: e.weight,
        in_corpus: !!e.in_corpus,
        note: e.note,
        // La langue de la note est DANS la charge utile (corollaire structuré de R4) :
        // un client qui jette la prose garde l'information que la note n'est pas traduite.
        note_lang: e.note ? "fr" : null,
      })),
    });
  };
  outils.related_laws = H_RELATED_LAWS as Gestionnaire;

  // 1d) find_relevant ----------------------------------------------------
  const H_FIND_RELEVANT = async ({
    query,
    limit,
    lang: langArg,
  }: {
    query: string;
    limit?: number;
    lang?: "fr" | "en";
  }) => {
    // Défauts RELOCALISÉS depuis le schéma (le validateur cible ne les applique pas).
    const lang: Lang = (langArg ?? "fr") as Lang;
    const langWarn = detectLanguageMismatch(query, lang);
    const tokens = tokenize(query);
    const page = paginate(limit, 0, 8, 50);
    if (tokens.length === 0) {
      return err(
        "Aucun terme exploitable dans la requête. Reformulez avec des mots porteurs " +
          "(ex. « bail de logement », « congédiement »), ou consultez list_subjects.",
      );
    }
    const data = await loadRelevanceData(db, tokens, lang as Lang, env);
    const cands = rank({ tokens, ...data }, page.limit);
    if (cands.length === 0) {
      return err(
        `Aucun rapprochement trouvé (termes retenus : ${tokens.join(", ")}). ` +
          "Le corpus est une SÉLECTION FERMÉE de textes du Québec et du fédéral : une absence " +
          "ici ne dit rien de l'existence d'une règle ailleurs. " +
          "Voir les domaines avec list_subjects, ou chercher dans le texte avec search_text." +
          (langWarn ? `\n\n${langWarn}` : ""),
      );
    }
    const lines = cands.map((c, i) => {
      const cible = c.division_path
        ? `${c.law_id} › ${c.heading ?? c.division_path} [${c.division_path}]`
        : `${c.law_id} (loi entière)`;
      return `${i + 1}. ${cible}  — score ${c.score}\n     pourquoi : ${c.pourquoi.join(" ; ")}`;
    });
    const prefixeLangWarn = langWarn ? `${langWarn}\n\n` : "";
    return ok(
      `${prefixeLangWarn}${cands.length} piste(s) repérée(s) (termes : ${tokens.join(", ")}) :\n` +
        `${lines.join("\n")}\n\n${GARDE_FOU}`,
      {
        query,
        lang,
        ...(langWarn ? { avertissement_langue: langWarn } : {}),
        tokens,
        weights: WEIGHTS,
        count: cands.length,
        avertissement: GARDE_FOU,
        candidates: cands.map((c) => ({
          law: c.law_id,
          division_path: c.division_path || null,
          heading: c.heading,
          score: c.score,
          pourquoi: c.pourquoi,
        })),
      },
    );
  };
  outils.find_relevant = H_FIND_RELEVANT as Gestionnaire;

  // 2) get_article -------------------------------------------------------
  const H_GET_ARTICLE = async ({
    law: rawLaw,
    article: rawArticle,
    lang: langArg,
  }: {
    law: string;
    article: string;
    lang?: "fr" | "en";
  }) => {
    // Défauts RELOCALISÉS depuis le schéma (le validateur cible ne les applique pas).
    const lang: Lang = (langArg ?? "fr") as Lang;
    const law = rawLaw.trim().toLowerCase();
    const article = normalizeArticleToken(rawArticle);
    const lawRow = await getLaw(db, law, env);
    if (!lawRow) {
      const all = (await listLaws(db, {}, "fr", env)).map((l) => l.id).join(", ");
      return err(`Loi '${law}' inconnue. Lois disponibles : ${all || "aucune"}.`);
    }
    const [row, normRels] = await Promise.all([
      getArticle(db, law, lang as Lang, article),
      normativeRelations(db, [law], lang as Lang, env),
    ]);
    if (!row) {
      if (lang === "en") {
        const langs = await lawLangs(db, law, env);
        if (langs.length > 0 && !langs.includes("en") && langs.includes("fr")) {
          return frOnlyError(law, lawRow);
        }
      }
      const near = await nearestArticles(db, law, lang as Lang, article);
      return err(
        `Article ${article} introuvable dans ${law} (${lang}). ` +
          `Vérifiez le numéro et la langue. Articles proches : ${near.join(", ") || "aucun"}.`,
      );
    }
    const consol = consolOf(lawRow, lang as Lang);
    const rels = normRels.get(law) ?? [];
    const links = parseLinks(row.links);
    return ok(renderArticle(row, lawRow, consol, lang as Lang, rels, links), {
      law,
      number: row.number,
      lang,
      citation: citationOf(lawRow, row.number, lang as Lang),
      division_path: row.division_path,
      division: row.d_kind
        ? { kind: row.d_kind, number: row.d_number, heading: row.d_heading }
        : null,
      consolidation: consol,
      history: row.history,
      repealed: !!row.repealed,
      text: row.text,
      source: lawRow.source ?? "epub",
      fonction: lawRow.fonction ?? null,
      links,
      ...(rels.length ? { relations: rels } : {}),
    });
  };
  outils.get_article = H_GET_ARTICLE as Gestionnaire;

  // 3) get_articles ------------------------------------------------------
  const H_GET_ARTICLES = async ({
    law: rawLaw,
    from,
    to,
    numbers,
    lang: langArg,
    limit,
    offset,
  }: {
    law: string;
    from?: string;
    to?: string;
    numbers?: string[];
    lang?: "fr" | "en";
    limit?: number;
    offset?: number;
  }) => {
    // Défauts RELOCALISÉS depuis le schéma (le validateur cible ne les applique pas).
    const lang: Lang = (langArg ?? "fr") as Lang;
    const law = rawLaw.trim().toLowerCase();
    const lawRow = await getLaw(db, law, env);
    if (!lawRow) return err(`Loi '${law}' inconnue.`);
    const useRange = from != null && to != null;
    const rawNumsTrimmed = useRange ? [] : (numbers ?? []).map((n) => n.trim().normalize("NFC"));
    const hasBlankEntry = !useRange && rawNumsTrimmed.some((n) => n.length === 0);
    const requestedNumbers = useRange ? [] : [...new Set(rawNumsTrimmed.filter(Boolean))];
    if (!useRange && requestedNumbers.length === 0) {
      return err("Fournir soit (from ET to), soit numbers[].");
    }
    // LES DEUX MODES ENSEMBLE : on REFUSE au lieu de servir la moitié de la demande.
    // Mesuré en production le 2026-09-17 : { from:'1457', to:'1459', numbers:['1590'] }
    // rendait 1457-1459 et jetait le 1590 SANS RIEN DIRE — le mode plage gagnait en
    // silence. « Les art. 1457 à 1460, plus 1590 » est pourtant l'assemblage le plus
    // naturel qu'un modèle produise, et la réponse avait l'air complète.
    if (useRange && numbers?.length) {
      return err(
        "Modes INCOMPATIBLES : (from, to) et numbers[] ont été fournis ensemble. Ce serveur " +
          "refuse plutôt que d'en servir un et d'abandonner l'autre en silence. " +
          "Faire DEUX appels : un pour la plage, un pour la liste.",
      );
    }
    const page = paginate(limit, offset);
    let rows: Partial<ArticleRow>[];
    let total: number;
    let resolution: "document" | "cle" | null = null;
    let missing: string[] = [];
    const rangeNotes: string[] = [];
    if (useRange) {
      const fromNorm = normalizeArticleToken(from!);
      const toNorm = normalizeArticleToken(to!);
      // bornes LUES en base (insensible à l'échelle de sort_key) — cf. boundRef
      const [b1, b2] = await Promise.all([
        boundRef(db, law, lang as Lang, fromNorm),
        boundRef(db, law, lang as Lang, toNorm),
      ]);
      const badNonNumeric: string[] = [];
      if (!b1.exists && !/^\d/.test(fromNorm)) badNonNumeric.push(fromNorm);
      if (!b2.exists && !/^\d/.test(toNorm)) badNonNumeric.push(toNorm);
      if (badNonNumeric.length > 0) {
        if (lang === "en") {
          const langs = await lawLangs(db, law, env);
          if (langs.length > 0 && !langs.includes("en") && langs.includes("fr")) {
            return frOnlyError(law, lawRow);
          }
        }
        const near = await nearestArticles(db, law, lang as Lang, badNonNumeric[0]!);
        return err(
          lang === "en"
            ? `Unknown range bound(s) in ${law} (${lang}): ${badNonNumeric.join(", ")}. Nearest entries: ${near.join(", ") || "none"}.`
            : `Borne(s) de plage introuvable(s) dans ${law} (${lang}) : ${badNonNumeric.join(", ")}. Entrées proches : ${near.join(", ") || "aucune"}.`,
        );
      }
      const inverted = b1.id != null && b2.id != null ? b1.id > b2.id : b1.key > b2.key;
      const missingBounds = [
        !b1.exists ? fromNorm : null,
        !b2.exists && toNorm !== fromNorm ? toNorm : null,
      ].filter((x): x is string => x !== null);
      const r = await articlesByRange(db, law, lang as Lang, b1, b2, page);
      rows = r.rows;
      total = r.total;
      resolution = r.resolution;
      if (inverted && rows.length > 0) {
        rangeNotes.push(
          lang === "en"
            ? `Note: inverted bounds (${fromNorm} -> ${toNorm}) reordered ascending.`
            : `Note : bornes inversées (${fromNorm} → ${toNorm}) remises dans l'ordre croissant.`,
        );
      }
      if (missingBounds.length > 0 && rows.length > 0) {
        const firstNum = rows[0]?.number ?? "";
        const lastNum = rows.at(-1)?.number ?? "";
        rangeNotes.push(
          lang === "en"
            ? `Note: bound(s) not in text (${missingBounds.join(", ")}) — resolved to ${firstNum}..${lastNum}.`
            : `Note : borne(s) absente(s) du texte (${missingBounds.join(", ")}) — plage résolue sur ${firstNum} à ${lastNum}.`,
        );
      }
      if (rows.length > 0 && (total > rows.length || page.offset > 0)) {
        const nextOffset = page.offset + rows.length;
        const suite =
          nextOffset < total
            ? lang === "en"
              ? ` ; next: offset=${nextOffset}`
              : ` ; suite : offset=${nextOffset}`
            : "";
        rangeNotes.push(
          lang === "en"
            ? `Articles ${page.offset + 1}–${page.offset + rows.length} / ${total}${suite}.`
            : `Articles ${page.offset + 1}–${page.offset + rows.length} / ${total}${suite}.`,
        );
      }
    } else {
      rows = await articlesByNumbers(db, law, lang as Lang, requestedNumbers);
      total = rows.length;
      const foundSet = new Set(rows.map((r) => r.number));
      missing = requestedNumbers.filter((n) => !foundSet.has(n));
      if (hasBlankEntry) {
        missing.push(lang === "en" ? "(empty string)" : "(chaîne vide)");
      }
    }
    if (rows.length === 0) {
      if (lang === "en") {
        const langs = await lawLangs(db, law, env);
        if (langs.length > 0 && !langs.includes("en") && langs.includes("fr")) {
          return frOnlyError(law, lawRow);
        }
      }
      if (!useRange && missing.length > 0) {
        return err(
          lang === "en"
            ? `No requested article found in ${law} (${lang}). Not found: ${missing.join(", ")}.`
            : `Aucun article trouvé dans ${law} (${lang}). Introuvable(s) : ${missing.join(", ")}.`,
        );
      }
      return err(
        useRange && total > 0 && page.offset >= total
          ? lang === "en"
            ? `No articles at offset=${page.offset} (total in range: ${total}).`
            : `Aucun article à offset=${page.offset} (total dans la plage : ${total}).`
          : "Aucun article dans cette plage/liste.",
      );
    }
    const consol = consolOf(lawRow, lang as Lang);
    const normRels = await normativeRelations(db, [law], lang as Lang, env);
    const rels = normRels.get(law) ?? [];
    const ul = unitLabel(lawRow.unit, lang);
    const lawTitle = lang === "en" ? lawRow.name_en || lawRow.name_fr : lawRow.name_fr;
    const lawCite = (lang === "en" ? lawRow.official_cite_en : null) || citeOf(lawRow);
    const lawLabel =
      lawTitle && lawCite && lawTitle !== lawCite
        ? `${lawTitle} (${lawCite})`
        : lawTitle || lawCite || law;
    const consolPart = consol
      ? lang === "en"
        ? ` (updated to ${consol})`
        : ` (à jour au ${consol})`
      : "";
    const headerLine = `${lawLabel}${consolPart}`;
    const note = normativeNote(lawRow, lang);
    const relsText = formatNormativeRelations(rels, lang);
    const missingLine =
      !useRange && missing.length > 0
        ? lang === "en"
          ? `Not found in ${law} (${lang}): ${missing.join(", ")}.`
          : `Introuvable(s) dans ${law} (${lang}) : ${missing.join(", ")}.`
        : null;
    const headerLines = [headerLine, note, relsText, ...rangeNotes, missingLine]
      .filter(Boolean)
      .join("\n");
    const body =
      `${headerLines}\n\n` +
      rows
        .map(
          (a) =>
            `— ${ul} ${a.number}${a.repealed ? (lang === "en" ? " (repealed)" : " (abrogé)") : ""} —\n${a.text}${formatLinksFooter(parseLinks(a.links), lang)}`,
        )
        .join("\n\n");
    return ok(body, {
      law,
      lang,
      consolidation: consol,
      source: lawRow.source ?? "epub",
      fonction: lawRow.fonction ?? null,
      ...(rels.length ? { relations: rels } : {}),
      count: rows.length,
      total,
      pagination: useRange ? { limit: page.limit, offset: page.offset } : null,
      // Comment la plage a été bornée. Champ TOUJOURS présent (null hors mode plage) :
      // « absent » et « borné par le texte » ne doivent pas être confondus.
      //   'document' — étendue exacte, de la première borne à la seconde, dans l'ordre
      //                du texte officiel ;
      //   'cle'      — au moins une borne est ouverte ou désigne un pseudo-article : la
      //                plage est bornée par la clé de tri, qui n'est pas un ordre total
      //                et peut donc sur-inclure.
      range_resolution: resolution,
      ...(useRange ? {} : { missing_numbers: missing }),
      articles: rows.map((a) => ({
        number: a.number,
        text: a.text,
        history: a.history,
        division_path: a.division_path,
        repealed: !!a.repealed,
        links: parseLinks(a.links),
      })),
    });
  };
  outils.get_articles = H_GET_ARTICLES as Gestionnaire;

  // 4) get_structure -----------------------------------------------------
  const H_GET_STRUCTURE = async ({
    law: rawLaw,
    lang: langArg,
    root_path,
    depth,
  }: {
    law: string;
    lang?: "fr" | "en";
    root_path?: string;
    depth?: number;
  }) => {
    // Défauts RELOCALISÉS depuis le schéma (le validateur cible ne les applique pas).
    const lang: Lang = (langArg ?? "fr") as Lang;
    const law = rawLaw.trim().toLowerCase();
    const lawRow = await getLaw(db, law, env);
    if (!lawRow) return err(`Loi '${law}' inconnue.`);
    const d = depth ?? 2;
    let tree = await getStructure(db, law, lang as Lang, root_path, d);
    if (tree.length === 0 && root_path) {
      // 1.5 : les chemins Irosoft sont propres à la langue — un chemin venu de l'autre
      // langue est traduit par le pont des numéros d'articles, au lieu d'échouer.
      const t = await translateDivisionPath(db, law, root_path, lang as Lang);
      if (t) tree = await getStructure(db, law, lang as Lang, t.path, d);
    }
    if (tree.length === 0) {
      if (lang === "en") {
        const langs = await lawLangs(db, law, env);
        if (langs.length > 0 && !langs.includes("en") && langs.includes("fr")) {
          return frOnlyError(law, lawRow);
        }
      }
      if (!root_path) {
        const msg =
          lang === "en"
            ? `No structural divisions in '${law}' (flat text without headings) — read directly with get_articles(law='${law}', from='1', to='50').`
            : `Aucune division structurelle dans '${law}' (texte plat sans chapitres ni sections) — lire directement avec get_articles(law='${law}', from='1', to='50').`;
        return ok(msg, { law, lang, root_path: null, depth: d, tree: [] });
      }
      return err(`Aucune division sous '${root_path}'.`);
    }
    const render = (nodes: StructureNode[], level: number): string =>
      nodes
        .map(
          (n) =>
            `${"  ".repeat(level)}${divisionLabel(n.kind, n.number, n.heading, lang as Lang)}` +
            `${n.repealed ? (lang === "en" ? " (repealed)" : " (abrogé)") : ""}  [${n.path}]` +
            (n.children.length ? `\n${render(n.children, level + 1)}` : ""),
        )
        .join("\n");
    return ok(render(tree, 0), { law, lang, root_path: root_path ?? null, depth: d, tree });
  };
  outils.get_structure = H_GET_STRUCTURE as Gestionnaire;

  // 5) get_division ------------------------------------------------------
  const H_GET_DIVISION = async ({
    law: rawLaw,
    path,
    division_id,
    lang: langArg,
    include_text: includeTextArg,
    limit,
    offset,
  }: {
    law: string;
    path?: string;
    division_id?: number;
    lang?: "fr" | "en";
    include_text?: boolean;
    limit?: number;
    offset?: number;
  }) => {
    // Défauts RELOCALISÉS depuis le schéma (le validateur cible ne les applique pas).
    const lang: Lang = (langArg ?? "fr") as Lang;
    const law = rawLaw.trim().toLowerCase();
    const include_text = includeTextArg ?? true;
    const lawRow = await getLaw(db, law, env);
    if (!lawRow) return err(`Loi '${law}' inconnue.`);
    if (path == null && division_id == null) return err("Fournir path ou division_id.");
    let div = await getDivision(db, law, lang as Lang, { path, id: division_id });
    if (!div && path) {
      // 1.5 : chemin de l'autre langue -> pont par numéros d'articles.
      const t = await translateDivisionPath(db, law, path, lang as Lang);
      if (t) div = await getDivision(db, law, lang as Lang, { path: t.path });
    }
    if (!div) {
      if (lang === "en") {
        const langs = await lawLangs(db, law, env);
        if (langs.length > 0 && !langs.includes("en") && langs.includes("fr")) {
          return frOnlyError(law, lawRow);
        }
      }
      return err(`Division introuvable (${path ?? division_id}).`);
    }
    // repli d'intitulé : si la division n'en a pas dans la langue demandée, montrer
    // celui de l'autre langue, marqué (plan v2, 1.5).
    let headingShown = div.heading;
    if (!headingShown) {
      const other = await headingInOtherLang(db, law, div.path, lang as Lang);
      if (other) headingShown = `${other} [${lang === "fr" ? "en" : "fr"}]`;
    }
    const page = paginate(limit, offset);
    const [kids, { rows, total }, normRels] = await Promise.all([
      childDivisions(db, div.id),
      articlesInDivision(db, law, lang as Lang, div.path, page, include_text),
      normativeRelations(db, [law], lang as Lang, env),
    ]);
    const rels = normRels.get(law) ?? [];
    const ul = unitLabel(lawRow.unit, lang);
    const header = `${divisionLabel(div.kind, div.number, headingShown, lang as Lang)}${div.repealed ? (lang === "en" ? " (repealed)" : " (abrogé)") : ""} [${div.path}]`;
    const note = normativeNote(lawRow, lang);
    const relsText = formatNormativeRelations(rels, lang);
    const normLines = [note, relsText].filter(Boolean).join("\n");
    const normBlock = normLines ? `\n${normLines}` : "";
    const subs = kids.length
      ? `\n\nSous-divisions :\n` +
        kids
          .map((k) => `  • ${divisionLabel(k.kind, k.number, k.heading, lang as Lang)} [${k.path}]`)
          .join("\n")
      : "";
    const arts = rows.length
      ? `\n\nArticles (${page.offset + 1}–${page.offset + rows.length} / ${total}) :\n` +
        rows
          .map((a) => {
            const repTag = a.repealed ? (lang === "en" ? " (repealed)" : " (abrogé)") : "";
            return include_text
              ? `\n— ${ul} ${a.number}${repTag} —\n${a.text}${formatLinksFooter(parseLinks(a.links), lang)}`
              : `${ul} ${a.number}${repTag}`;
          })
          .join(include_text ? "\n" : ", ")
      : total > 0 && page.offset >= total
        ? `\n\n(aucun article à offset=${page.offset} ; total : ${total})`
        : "\n\n(aucun article)";
    return ok(`${header}${normBlock}${subs}${arts}`, {
      law,
      lang,
      source: lawRow.source ?? "epub",
      fonction: lawRow.fonction ?? null,
      ...(rels.length ? { relations: rels } : {}),
      division: {
        division_id: div.id,
        path: div.path,
        kind: div.kind,
        number: div.number,
        heading: div.heading,
        history: div.history,
        repealed: !!div.repealed,
      },
      children: kids.map((k) => ({
        division_id: k.id,
        path: k.path,
        kind: k.kind,
        number: k.number,
        heading: k.heading,
        repealed: !!k.repealed,
      })),
      articles: rows.map((a) => ({
        number: a.number,
        division_path: a.division_path,
        repealed: !!a.repealed,
        links: parseLinks(a.links),
        ...(include_text ? { text: a.text, history: a.history } : {}),
      })),
      pagination: { limit: page.limit, offset: page.offset, total },
    });
  };
  outils.get_division = H_GET_DIVISION as Gestionnaire;

  // 6) search_text -------------------------------------------------------
  const H_SEARCH_TEXT = async ({
    query,
    law: rawLaw,
    lang: langArg,
    limit,
    offset,
  }: {
    query: string;
    law?: string;
    lang?: "fr" | "en";
    limit?: number;
    offset?: number;
  }) => {
    // Défauts RELOCALISÉS depuis le schéma (le validateur cible ne les applique pas).
    const lang: Lang = (langArg ?? "fr") as Lang;
    const law = rawLaw !== undefined ? rawLaw.trim().toLowerCase() : undefined;
    const langWarn = detectLanguageMismatch(query, lang);
    const lawRow = law ? await getLaw(db, law, env) : null;
    if (law && !lawRow) return err(`Loi '${law}' inconnue.`);
    // Recherche corpus : viser 12-15 résultats (1.3) ; restreinte : 10 comme avant.
    const page = paginate(limit, offset, law ? 10 : 14, 50);
    let res;
    try {
      // Recherche corpus : sur-échantillonner (3×) pour pouvoir plafonner à 6 résultats
      // par loi sans se retrouver avec la seule loi dominante au classement bm25.
      const fetchPage = law ? page : { limit: Math.min(45, page.limit * 3), offset: page.offset };
      // RELAX_SEARCH / HYBRID_SEARCH (R8) + préférence du titulaire `hybride_permis` (S19)
      const flags = env as unknown as { RELAX_SEARCH?: string; HYBRID_SEARCH?: string };
      const vectorActif = hybridePermis && estHybrideConfigure(env);
      const aiObserve: Ai | undefined = vectorActif
        ? ({
            run: async (...params: Parameters<Ai["run"]>) => {
              options?.surExecutionSemantique?.();
              return await env.AI.run(...params);
            },
          } as Ai)
        : undefined;
      res = await searchText(db, query, lang as Lang, law, fetchPage, {
        relax: flags.RELAX_SEARCH !== "0",
        vector: vectorActif && aiObserve ? { ai: aiObserve, index: env.VECTORS } : undefined,
        // FEDERAL_CORPUS : sans ce passage, la recherche plein texte servait des
        // résultats fédéraux pendant que `list_laws` annonçait 79 lois — mesuré.
        env,
      });
      if (!law) {
        const distinctIds = [...new Set(res.hits.map((h) => h.law_id))];
        const metaMap = await lawMetas(db, distinctIds, env);
        const perLaw = new Map<string, number>();
        const perFonction = new Map<string, number>();
        const picked: typeof res.hits = [];
        const attente: typeof res.hits = [];
        const maxHardSouple = Math.min(3, Math.max(MAX_PER_FONCTION_SOUPLE, page.limit));
        for (const h of res.hits) {
          const fn = h.fonction ?? metaMap.get(h.law_id)?.fonction ?? null;
          const n = perLaw.get(h.law_id) ?? 0;
          if (n >= 6) continue;
          if (
            fn &&
            FONCTIONS_SOUPLES.has(fn) &&
            (perFonction.get(fn) ?? 0) >= MAX_PER_FONCTION_SOUPLE
          ) {
            attente.push(h);
            continue;
          }
          perLaw.set(h.law_id, n + 1);
          if (fn && FONCTIONS_SOUPLES.has(fn)) {
            perFonction.set(fn, (perFonction.get(fn) ?? 0) + 1);
          }
          picked.push(h);
          if (picked.length >= page.limit) break;
        }
        if (picked.length < page.limit && attente.length) {
          const hasHardNorm = picked.some((h) => {
            const fn = h.fonction ?? metaMap.get(h.law_id)?.fonction ?? null;
            return !fn || !FONCTIONS_SOUPLES.has(fn);
          });
          for (const h of attente) {
            if (picked.length >= page.limit) break;
            const n = perLaw.get(h.law_id) ?? 0;
            if (n >= 6) continue;
            const fn = h.fonction ?? metaMap.get(h.law_id)?.fonction ?? null;
            if (
              hasHardNorm &&
              fn &&
              FONCTIONS_SOUPLES.has(fn) &&
              (perFonction.get(fn) ?? 0) >= maxHardSouple
            ) {
              continue;
            }
            perLaw.set(h.law_id, n + 1);
            if (fn && FONCTIONS_SOUPLES.has(fn)) {
              perFonction.set(fn, (perFonction.get(fn) ?? 0) + 1);
            }
            picked.push(h);
          }
        }
        res = { ...res, hits: picked };
      }
    } catch {
      // L'exception n'est PAS liée, et c'est le correctif : on renvoyait `e.message`, qui
      // vient de SQLite/FTS5 et publiait au premier venu la syntaxe du moteur
      // (« fts5: syntax error near … »). Sans intérêt pour l'appelant, et c'est de
      // l'intérieur donné à voir une fois l'endpoint public.
      return err(
        "Recherche invalide : la requête contient des caractères que le moteur de recherche " +
          "réserve (guillemets, parenthèses, astérisque, NEAR/AND/OR). Réessayer avec des " +
          "mots simples séparés par des espaces.",
      );
    }
    const fallbackLog =
      res.fallback === null
        ? null
        : typeof res.fallback === "object"
          ? `loo:${res.fallback.loo}`
          : res.fallback;
    const noteHybrideDesactive = !hybridePermis
      ? lang === "en"
        ? "Note: hybrid vector search is disabled per account preference (lexical FTS5 search only)."
        : "Note : la recherche vectorielle hybride est désactivée selon la préférence du compte (recherche lexicale FTS5 uniquement)."
      : "";
    let frOnlyLawNotice = "";
    if (law && lang === "en" && res.hits.every((h) => h.law_id !== law)) {
      const langs = await lawLangs(db, law, env);
      if (langs.length > 0 && !langs.includes("en") && langs.includes("fr")) {
        const cite = lawRow ? citeOf(lawRow) : "";
        frOnlyLawNotice = `Law '${law}'${cite ? ` (${cite})` : ""} is published in French only (langs: ['fr']). Re-run with lang='fr'.`;
      }
    }
    // « Aucun résultat » DOIT dire dans quoi on a cherché. Sans ça, un modèle public lit
    // l'absence comme « aucune règle n'existe » et la relaie comme une réponse — une absence
    // présentée comme un fait. Deux causes dominent et se disent en une phrase : le corpus
    // est une sélection fermée, et l'appariement est LEXICAL (aucun stemming français,
    // mesuré : « congédiement » n'attrape pas « congédier »).
    if (res.hits.length === 0) {
      if (frOnlyLawNotice) {
        return err(
          `${frOnlyLawNotice}${noteHybrideDesactive ? ` ${noteHybrideDesactive}` : ""}${langWarn ? `\n\n${langWarn}` : ""}`,
        );
      }
      if (res.total > 0 && page.offset >= res.total) {
        return err(
          `Offset (${page.offset}) au-delà du total (${res.total} résultat(s) lexicaux). ` +
            `Réessayer avec un offset inférieur à ${res.total}.`,
        );
      }
      return err(
        `Aucun résultat trouvé (${lang}). Cela ne signifie pas qu'aucune règle ` +
          "n'existe : le corpus est une sélection fermée de textes, et l'appariement est " +
          "LEXICAL (pas de familles de mots — « congédiement » ne trouve pas « congédier »). " +
          "Essayer d'autres mots exacts du texte, ou find_relevant pour partir du " +
          "problème plutôt que des mots." +
          (noteHybrideDesactive ? ` ${noteHybrideDesactive}` : "") +
          (langWarn ? `\n\n${langWarn}` : ""),
      );
    }

    // 1.3 : fils d'Ariane (résultats auto-explicatifs) + regroupement par loi.
    const semDivRefs = (res.divisions ?? []).map((d) => ({
      law_id: d.law_id,
      division_path: d.path,
    }));
    const allRefs = [...res.hits, ...(res.elsewhere?.hits ?? []), ...semDivRefs];
    const distinctLawIds = [...new Set(allRefs.map((h) => h.law_id))];
    const [chains, names, metas, normRels] = await Promise.all([
      breadcrumbChains(db, lang as Lang, allRefs),
      lawNames(db, distinctLawIds),
      lawMetas(db, distinctLawIds, env),
      normativeRelations(db, distinctLawIds, lang as Lang, env),
    ]);
    const ABBREV: Record<string, string> = { ccq: "C.c.Q.", cpc: "C.p.c." };
    const crumbOf = (h: { law_id: string; division_path: string }): string => {
      const chain = chains.get(`${h.law_id}|${h.division_path}`) ?? [];
      // seuls les nœuds AVEC ordinal portent un repère utile (« Livre V, Titre IV ») ;
      // les autres produiraient des « Livre, Titre, » vides.
      const kinds = chain
        .filter((n) => n.number)
        .map((n) => `${(KIND_LABEL[lang as Lang] ?? KIND_LABEL.fr)[n.kind] ?? n.kind} ${n.number}`)
        .join(", ");
      const titled = [...chain].reverse().find((n) => n.heading);
      if (!kinds) return titled?.heading ?? "";
      return `${kinds}${titled ? ` : ${titled.heading}` : ""}`;
    };
    const conciseNormLine = (lawId: string): string | null => {
      const meta = metas.get(lawId);
      const rels = normRels.get(lawId) ?? [];
      const parts: string[] = [];
      if (meta?.fonction === "directive") {
        parts.push(
          lang === "en"
            ? "Practice directive (non-legislative, PDF source)"
            : "Directive de pratique judiciaire (non législatif, source PDF)",
        );
      } else if (meta?.fonction === "orientation") {
        parts.push(
          lang === "en"
            ? "Policy statement (non-legislative, non-binding, PDF source)"
            : "Orientation administrative (non législatif, valeur indicative, source PDF)",
        );
      }
      for (const r of rels) {
        parts.push(`${r.rel_type} : ${r.other_id}`);
      }
      return parts.length ? `   [${parts.join(" ; ")}]` : null;
    };
    const line = (h: (typeof res.hits)[number]) => {
      const crumb = crumbOf(h);
      const ul = unitLabel(metas.get(h.law_id)?.unit, lang as Lang);
      const frTag = h.hit_lang && h.hit_lang !== lang ? ` [${h.hit_lang}]` : "";
      return (
        `${ABBREV[h.law_id] ?? h.law_id}${crumb ? ` — ${crumb}` : ""} › ${ul} ${h.number}` +
        `${h.semantic ? " (repérage sémantique)" : ""}${frTag}  [${h.division_path}]\n` +
        `   « ${h.snippet} »`
      );
    };
    // corps : groupé par loi dès que les résultats en couvrent plusieurs (max 6 par loi)
    const lawsInHits = [...new Set(res.hits.map((h) => h.law_id))];
    let body: string;
    if (lawsInHits.length > 1) {
      const byLaw = new Map<string, typeof res.hits>();
      for (const h of res.hits) {
        const arr = byLaw.get(h.law_id);
        if (arr) arr.push(h);
        else byLaw.set(h.law_id, [h]);
      }
      body = [...byLaw.entries()]
        .map(([id, hs]) => {
          const nm = names.get(id);
          const title = nm ? (lang === "en" ? nm.name_en : nm.name_fr) : id;
          const shown = hs.slice(0, 6);
          const normLine = conciseNormLine(id);
          return (
            `— ${title} (${shown.length}${hs.length > shown.length ? ` / ${hs.length}` : ""} affiché(s)) —` +
            `${normLine ? `\n${normLine}` : ""}\n` +
            shown.map(line).join("\n")
          );
        })
        .join("\n\n");
    } else {
      const normLine = lawsInHits[0] ? conciseNormLine(lawsInHits[0]) : null;
      body = `${normLine ? `${normLine}\n` : ""}${res.hits.map(line).join("\n")}`;
    }
    // En-tête étiqueté selon le chemin qui a produit les résultats (R7 : fail open, dit)
    const nTerms = query.trim().split(/\s+/).length;
    const header =
      res.fallback === "widened"
        ? `Aucun résultat dans ${law} ; ${res.total} résultat(s) ailleurs dans le corpus :`
        : res.fallback !== null && typeof res.fallback === "object"
          ? `Correspondance exacte introuvable ; résultats approchés (terme ignoré : « ${res.fallback.loo} ») :`
          : res.fallback === "or_relax"
            ? `Résultats partiels (au moins un terme sur ${nTerms}) :`
            : res.fallback === "semantic"
              ? "Aucune correspondance lexicale ; repérage sémantique :"
              : `${res.total} résultat(s) trouvé(s) :`;
    // Recherche restreinte avec résultats : signaler ce que la restriction cache (post-mortem)
    const seenElsewhereNorm = new Set<string>();
    const elsewhere = res.elsewhere
      ? `\n\nAilleurs au corpus (${res.elsewhere.total} résultat(s) hors ${law}) — aperçu :\n` +
        res.elsewhere.hits
          .map((h) => {
            const nl = seenElsewhereNorm.has(h.law_id) ? null : conciseNormLine(h.law_id);
            seenElsewhereNorm.add(h.law_id);
            return nl ? `${nl}\n${line(h)}` : line(h);
          })
          .join("\n") +
        "\nRelancer sans `law` pour la vue complète."
      : "";
    const structures = res.divisions?.length
      ? "\n\nStructures pertinentes (repérage sémantique) :\n" +
        res.divisions
          .map((d) => {
            const crumb = crumbOf({ law_id: d.law_id, division_path: d.path });
            return `  • ${ABBREV[d.law_id] ?? d.law_id} — ${crumb || d.heading || d.path}  [${d.path}]`;
          })
          .join("\n")
      : "";
    const enrich = (h: (typeof res.hits)[number]) => {
      const meta = metas.get(h.law_id);
      const rels = normRels.get(h.law_id) ?? [];
      return {
        ...h,
        breadcrumb: crumbOf(h),
        source: meta?.source ?? null,
        fonction: h.fonction ?? meta?.fonction ?? null,
        hit_lang: h.hit_lang ?? lang,
        ...(rels.length
          ? {
              relations: rels.map((r) => ({
                direction: r.direction,
                rel_type: r.rel_type,
                other_id: r.other_id,
                other_name: r.other_name,
              })),
            }
          : {}),
      };
    };
    // Trois décomptes, trois sens distincts — parce qu'UN seul était servi et qu'il était
    // lu pour ce qu'il n'est pas. `total: 1` avec cinq résultats rendus n'est pas une
    // incohérence : c'est un appariement lexical plus quatre voisins sémantiques. Corollaire
    // structuré de R4 (décision 001) : ce qui BORNE un résultat voyage dans l'objet typé,
    // pas seulement dans la prose — un client peut jeter la prose et garder l'objet.
    //
    // ⚠️ `sources.lexical` compte « présent dans la liste FTS », NON « non influencé par les
    // vecteurs » : un article trouvé par les DEUX voies garde son SearchHit lexical et n'est
    // jamais marqué `semantic`, bien que la fusion RRF ait déplacé son rang.
    const nSem = res.hits.filter((h) => h.semantic).length;
    const suffixeHybride = noteHybrideDesactive ? `\n\n${noteHybrideDesactive}` : "";
    const prefixeLangWarn = langWarn ? `${langWarn}\n\n` : "";
    const prefixeFrOnly = frOnlyLawNotice ? `${frOnlyLawNotice}\n` : "";
    return ok(
      `${prefixeLangWarn}${prefixeFrOnly}${header}\n${body}${structures}${elsewhere}${suffixeHybride}`,
      {
        query,
        lang,
        law: law ?? null,
        ...(langWarn ? { avertissement_langue: langWarn } : {}),
        ...(frOnlyLawNotice ? { fr_only_law: true } : {}),
        /** Appariements LEXICAUX au corpus, non paginés. Vaut 0 sur un repli sémantique seul. */
        total: res.total,
        /** Taille de la page réellement rendue, toutes sources confondues. */
        returned: res.hits.length,
        sources: { lexical: res.hits.length - nSem, semantique: nSem },
        ...(hybridePermis ? {} : { hybride_desactive: true }),
        fallback: fallbackLog,
        elsewhere: res.elsewhere
          ? { total: res.elsewhere.total, results: res.elsewhere.hits.map(enrich) }
          : null,
        divisions_semantiques: res.divisions ?? [],
        pagination: { limit: page.limit, offset: page.offset },
        results: res.hits.map(enrich),
      },
    );
  };
  outils.search_text = H_SEARCH_TEXT as Gestionnaire;

  // 7) resolve_reference -------------------------------------------------
  const H_RESOLVE_REFERENCE = async ({
    citation,
    lang: langArg,
  }: {
    citation: string;
    lang?: "fr" | "en";
  }) => {
    // Défauts RELOCALISÉS depuis le schéma (le validateur cible ne les applique pas).
    const lang: Lang = (langArg ?? "fr") as Lang;
    const all = await listLaws(db, {}, "fr", env);
    const parsed = parseCitation(citation, all);
    if (parsed.ambigu?.length) {
      const cands = parsed.ambigu
        .map((c) => `  • ${c.id} — ${c.official_cite} (${c.name_fr})`)
        .join("\n");
      return err(
        `Citation ambiguë dans « ${citation} » — plusieurs textes correspondent :\n${cands}\n` +
          "Précisez le texte exact (ex. district/division ou « Règlement » vs « Instruction générale ») " +
          "ou appelez get_article avec le law= approprié.",
      );
    }
    if (!parsed.article) return err(`Aucun numéro d'article détecté dans « ${citation} ».`);
    if (!parsed.law) {
      // Refus NOMMÉ de l'ancien C.p.c. Il passe AVANT le refus générique parce qu'il dit la
      // seule chose qui compte pour un juriste : la numérotation a changé, donc l'article
      // du même numéro dans le code en vigueur n'est PAS l'équivalent.
      if (parsed.hors_corpus === "C-25") {
        return err(
          "L'ANCIEN Code de procédure civile (RLRQ, c. C-25) n'est pas au corpus : il a été " +
            "abrogé et remplacé le 1er janvier 2016 par le Code de procédure civile " +
            "(RLRQ, c. C-25.01), le seul des deux que ce serveur porte. " +
            "⚠️ La recodification a RENUMÉROTÉ le code : l'article " +
            `${parsed.article ?? "N"} de l'ancien C.p.c. n'est PAS l'article ${parsed.article ?? "N"} ` +
            "du code en vigueur, et aucune correspondance automatique n'est faite ici. " +
            "Pour le texte en vigueur, citer sans « ancien » (ex. « art. " +
            `${parsed.article ?? "N"} C.p.c. ») ; pour l'ancien, consulter une autre source.`,
        );
      }
      return err(
        parsed.chapitre_inconnu
          ? `Le chapitre « ${parsed.chapitre_inconnu} » n'est pas au corpus — aucune loi n'a été ` +
              "résolue (il n'est PAS rabattu sur un chapitre voisin). " +
              `Voir les ${all.length} textes disponibles avec list_laws. ` +
              `Article détecté : ${parsed.article ?? "aucun"}.`
          : `Loi non reconnue dans « ${citation} ». Précisez le chapitre RLRQ (ex. « RLRQ, c. T-16 ») ` +
              "ou une abréviation connue (C.c.Q., C.p.c., L.F.I., L.C.S.A.…), ou utilisez get_article avec law=… " +
              `(voir list_laws). Article détecté : ${parsed.article ?? "aucun"}.`,
      );
    }
    const law = parsed.law;
    const article = parsed.article;
    const [row, lawRow, normRels] = await Promise.all([
      getArticle(db, law, lang as Lang, article),
      getLaw(db, law, env),
      normativeRelations(db, [law], lang as Lang, env),
    ]);
    // `parseCitation` n'a reconnu `law` que parmi les lois LUES en base, donc lawRow
    // existe ; le garde est là pour le type, pas pour un cas réel.
    if (!lawRow) return err(`Loi '${law}' inconnue.`);
    const rels = normRels.get(law) ?? [];
    if (!row) {
      if (lang === "en") {
        const langs = await lawLangs(db, law, env);
        if (langs.length > 0 && !langs.includes("en") && langs.includes("fr")) {
          return frOnlyError(law, lawRow);
        }
      }
      const near = await nearestArticles(db, law, lang as Lang, article);
      const ul = unitLabel(lawRow.unit, lang);
      const partner = rels.find((r) => r.rel_type === "interprete" && r.in_corpus);
      let partnerHint = "";
      if (partner) {
        const partnerArt = await getArticle(db, partner.other_id, lang as Lang, article);
        partnerHint = partnerArt
          ? ` Texte apparié : ${partner.other_id} (${partner.other_name ?? partner.other_id}) contient ${ul} ${article}.`
          : ` Texte apparié : ${partner.other_id}${partner.other_name ? ` (${partner.other_name})` : ""}.`;
      }
      return err(
        `Référence « ${citation} » non résolue (loi ${law}, ${ul} ${article}). Proches : ${near.join(", ")}.${partnerHint}`,
      );
    }
    const consol = consolOf(lawRow, lang as Lang);
    const links = parseLinks(row.links);
    const resolveNotes: string[] = [];
    if (parsed.plage_fin) {
      resolveNotes.push(
        lang === "en"
          ? `Note: range detected (${article} to ${parsed.plage_fin}); only ${article} is returned here. Call get_articles(law='${law}', from='${article}', to='${parsed.plage_fin}') for the full range.`
          : `Note : plage détectée (${article} à ${parsed.plage_fin}) ; seul l'article ${article} est rendu ici. Appeler get_articles(law='${law}', from='${article}', to='${parsed.plage_fin}') pour la plage complète.`,
      );
    }
    if (parsed.alinea) {
      resolveNotes.push(
        lang === "en"
          ? `Note: sub-provision noted (${parsed.alinea}); full text of ${article} is displayed below.`
          : `Note : alinéa relevé (${parsed.alinea}) ; le texte intégral de l'article ${article} est affiché ci-dessous.`,
      );
    }
    const rendered = renderArticle(row, lawRow, consol, lang as Lang, rels, links);
    const prose = resolveNotes.length > 0 ? `${resolveNotes.join("\n")}\n\n${rendered}` : rendered;
    return ok(prose, {
      resolved: {
        law,
        number: row.number,
        lang,
        reconnue_par: parsed.law_source,
        ...(parsed.plage_fin ? { plage_fin: parsed.plage_fin } : {}),
        ...(parsed.alinea ? { alinea: parsed.alinea } : {}),
      },
      citation: citationOf(lawRow, row.number, lang as Lang),
      division_path: row.division_path,
      consolidation: consol,
      history: row.history,
      repealed: !!row.repealed,
      text: row.text,
      source: lawRow.source ?? "epub",
      fonction: lawRow.fonction ?? null,
      links,
      ...(rels.length ? { relations: rels } : {}),
    });
  };
  outils.resolve_reference = H_RESOLVE_REFERENCE as Gestionnaire;

  return outils;
}
