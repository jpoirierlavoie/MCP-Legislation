export const ALL_DOMAINS = [
  "core",
  "cours-federales",
  "financier",
  "construction-immobilier",
  "municipal-environnement",
  "travail",
  "penal",
  "propriete-intellectuelle",
] as const;

export type LawDomain = (typeof ALL_DOMAINS)[number];

export const MARGINAL_NOTE_WEIGHT = 0.5;

export const WEIGHTS = {
  S1_SUBJECT: 3,
  S2_DIVISION_HEADING: 2,
  S3_LAW_NAME: 2,
  S4_GRAPH_NEIGHBOUR: 1,
} as const;

export const SPECIFIC_TOKEN_MAX_REACH = 4;
export const SPECIFIC_TOKEN_FACTOR = 2;

export const MAX_PER_SUBJECT = 3;

export const FONCTION_WEIGHTS: Record<string, number> = {
  loi: 1,
  reglement: 1,
  "regles-procedure": 1,
  tarif: 1,
  directive: 0.7,
  orientation: 0.65,
};

export function fonctionWeight(fonction?: string | null): number {
  if (!fonction) return 1;
  return FONCTION_WEIGHTS[fonction] ?? 1;
}

export const MAX_PER_FONCTION_SOUPLE = 2;
export const FONCTIONS_SOUPLES = new Set(["directive", "orientation"]);

function specificityFactor(reach: number): number {
  if (reach <= 0) return 1;
  return 1 + (SPECIFIC_TOKEN_FACTOR - 1) * Math.min(1, SPECIFIC_TOKEN_MAX_REACH / reach);
}

export const COVERAGE_FLOOR = 0.5;

export function coverageFactor(apparies: number, total: number): number {
  if (total <= 0) return 1;
  return COVERAGE_FLOOR + (1 - COVERAGE_FLOOR) * Math.min(1, apparies / total);
}

export const RELAX_MIN_LOO_TOTAL = 2;

export const RRF_K = 60;
export const VECTOR_TOP_K = 20;
export const DIVISION_MATCH_MIN_SCORE = 0.5;
export const DIVISION_MATCH_MAX = 2;
export const SEMANTIC_MIN_SCORE = 0.4;

const MIN_TOKEN_LENGTH = 3;
const MAX_TOKENS = 8;

const STOPWORDS = new Set([
  "les",
  "des",
  "une",
  "un",
  "le",
  "la",
  "de",
  "du",
  "au",
  "aux",
  "et",
  "ou",
  "en",
  "dans",
  "pour",
  "par",
  "sur",
  "avec",
  "sans",
  "sous",
  "chez",
  "vers",
  "entre",
  "que",
  "qui",
  "quoi",
  "dont",
  "mais",
  "donc",
  "car",
  "ne",
  "pas",
  "plus",
  "moins",
  "est",
  "sont",
  "etre",
  "ete",
  "avoir",
  "fait",
  "faire",
  "tout",
  "tous",
  "toute",
  "toutes",
  "cette",
  "ces",
  "ceux",
  "celle",
  "son",
  "sa",
  "ses",
  "leur",
  "leurs",
  "mon",
  "ma",
  "mes",
  "quel",
  "quelle",
  "quels",
  "quelles",
  "comment",
  "pourquoi",
  "quand",
  "loi",
  "lois",
  "article",
  "articles",
  "art",
  "code",
  "quebec",
  "droit",
  "droits",
  "clause",
  "clauses",
]);

export function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

export function normalize(s: string | null | undefined): string {
  if (!s) return "";
  return stripAccents(s).replace(/\s+/g, " ").trim().toLowerCase();
}

export function tokenize(query: string): string[] {
  const seen = new Set<string>();
  for (const raw of normalize(query).split(/[^a-z0-9]+/)) {
    if (raw.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(raw)) seen.add(raw);
    if (seen.size >= MAX_TOKENS) break;
  }
  return [...seen];
}

const PROPER_NOUN_ACCENTS = new Set([
  "quebec",
  "quebecois",
  "quebecoise",
  "montreal",
  "levis",
  "gaspe",
  "gaspesie",
  "jerome",
  "chateauguay",
  "becancour",
  "lanaudiere",
  "monteregie",
  "temiscamingue",
  "megantic",
  "charlevoix",
]);

const EN_WORDS = new Set([
  "the",
  "and",
  "of",
  "for",
  "with",
  "without",
  "under",
  "between",
  "against",
  "within",
  "before",
  "after",
  "during",
  "upon",
  "from",
  "into",
  "about",
  "through",
  "unless",
  "until",
  "whether",
  "where",
  "when",
  "what",
  "which",
  "whose",
  "their",
  "there",
  "these",
  "those",
  "other",
  "another",
  "such",
  "must",
  "shall",
  "should",
  "would",
  "could",
  "cannot",
  "have",
  "has",
  "had",
  "been",
  "being",
  "were",
  "was",
  "does",
  "did",
  "not",
  "only",
  "outside",
  "breach",
  "damages",
  "damage",
  "landlord",
  "tenant",
  "tenants",
  "lease",
  "leases",
  "eviction",
  "liability",
  "liable",
  "contract",
  "contracts",
  "contractual",
  "shareholder",
  "shareholders",
  "director",
  "directors",
  "employment",
  "employee",
  "employees",
  "employer",
  "employers",
  "dismissal",
  "unfair",
  "wrongful",
  "termination",
  "severance",
  "negligence",
  "injury",
  "harm",
  "loss",
  "losses",
  "claim",
  "claims",
  "claimant",
  "lawsuit",
  "plaintiff",
  "defendant",
  "creditor",
  "creditors",
  "debtor",
  "debtors",
  "bankruptcy",
  "insolvency",
  "consumer",
  "warranty",
  "defect",
  "defects",
  "hidden",
  "ownership",
  "owner",
  "owners",
  "buyer",
  "seller",
  "purchaser",
  "purchase",
  "mortgage",
  "hypothec",
  "easement",
  "trustee",
  "fiduciary",
  "courts",
  "judge",
  "judges",
  "appeal",
  "appeals",
  "injunction",
  "seizure",
  "garnishment",
  "surety",
  "suretyship",
  "insurance",
  "coverage",
  "statute",
  "statutes",
  "bylaw",
  "bylaws",
  "law",
  "laws",
  "rule",
  "rules",
  "order",
  "orders",
  "time",
  "deadline",
  "deadlines",
  "hearing",
  "trial",
  "witness",
  "witnesses",
  "pleading",
  "pleadings",
  "defense",
  "defence",
  "counterclaim",
  "stay",
  "payment",
  "unpaid",
  "rent",
  "rental",
  "residential",
  "housing",
  "house",
  "building",
  "contractor",
  "subcontractor",
  "work",
  "worker",
  "workers",
  "wage",
  "wages",
  "overtime",
  "leave",
  "harassment",
  "privacy",
  "disclosure",
  "securities",
  "broker",
  "brokerage",
  "municipality",
  "tax",
  "taxes",
  "zoning",
  "indemnity",
  "remedy",
  "remedies",
  "cancellation",
  "nullity",
  "unenforceable",
  "settlement",
  "agreement",
  "agreements",
  "deed",
  "custody",
  "spousal",
  "child",
  "lawyer",
  "attorney",
  "counsel",
  "ethics",
  "conflict",
  "interest",
  "answer",
  "serving",
  "served",
  "jurisdiction",
  "provisional",
  "roll",
  "failure",
  "pay",
  "duty",
  "care",
  "rights",
  "right",
  "freedom",
  "freedoms",
  "charter",
  "misrepresentation",
  "fraud",
  "gift",
  "estate",
  "property",
  "goods",
]);

const FR_WORDS = new Set([
  "les",
  "des",
  "du",
  "au",
  "aux",
  "dans",
  "pour",
  "avec",
  "sans",
  "sous",
  "chez",
  "vers",
  "entre",
  "qui",
  "que",
  "quoi",
  "dont",
  "mais",
  "donc",
  "pas",
  "sont",
  "etre",
  "ete",
  "avoir",
  "faire",
  "tous",
  "toute",
  "toutes",
  "cette",
  "ces",
  "ceux",
  "celle",
  "celles",
  "leur",
  "leurs",
  "quel",
  "quelle",
  "quels",
  "quelles",
  "lors",
  "apres",
  "avant",
  "pendant",
  "depuis",
  "contre",
  "selon",
  "envers",
  "malgre",
  "responsabilite",
  "contrat",
  "contrats",
  "contractuel",
  "contractuelle",
  "delai",
  "delais",
  "demande",
  "demandes",
  "vice",
  "vices",
  "loyer",
  "locataire",
  "locateur",
  "proprietaire",
  "dommage",
  "dommages",
  "faute",
  "recours",
  "avocat",
  "juge",
  "cour",
  "preuve",
  "temoin",
  "temoins",
  "jugement",
  "injonction",
  "saisie",
  "cautionnement",
  "hypotheque",
  "hypothecaire",
  "congediement",
  "licenciement",
  "preavis",
  "travail",
  "employe",
  "employeur",
  "salaire",
  "faillite",
  "insolvabilite",
  "creancier",
  "creanciers",
  "debiteur",
  "debiteurs",
  "actionnaire",
  "actionnaires",
  "societe",
  "administrateur",
  "mandat",
  "mandataire",
  "notaire",
  "huissier",
  "greffe",
  "assignation",
  "defendeur",
  "demandeur",
  "requete",
  "appel",
  "appelant",
  "intime",
  "opposition",
  "retractation",
  "arret",
  "loi",
  "lois",
  "reglement",
  "reglements",
  "ordonnance",
  "directive",
  "entreprise",
  "consommateur",
  "consommateurs",
  "garantie",
  "vendeur",
  "acheteur",
  "vente",
  "achat",
  "immeuble",
  "logement",
  "habitation",
  "annulation",
  "nullite",
  "indemnite",
  "solidarite",
  "solidaire",
  "fideicommis",
  "mariage",
  "epoux",
  "conjoint",
  "pension",
  "alimentaire",
  "garde",
  "enfant",
  "mineur",
  "tutelle",
  "curatelle",
  "renseignement",
  "renseignements",
  "personnels",
  "confidentialite",
  "privee",
  "ouvrage",
  "perte",
  "assureur",
  "municipale",
  "concurrence",
  "droit",
  "droits",
  "civile",
  "penal",
  "penale",
  "criminel",
  "criminelle",
  "publique",
  "prive",
  "foncier",
  "fonciere",
  "enquete",
  "interrogatoire",
  "serment",
  "moyen",
  "moyens",
  "declinatoire",
  "juridiction",
  "litige",
  "proces",
  "audience",
  "delibere",
  "depens",
  "frais",
  "honoraires",
  "deontologie",
  "conflit",
  "etranger",
  "etrangere",
  "extraneite",
  "domicile",
  "consentement",
  "dol",
  "capacite",
  "mesure",
  "provisionnelle",
  "conservatoire",
  "delictuel",
  "delictuelle",
  "extracontractuel",
  "extracontractuelle",
  "inexecution",
  "demeure",
  "quittance",
  "cession",
  "caducite",
  "inopposabilite",
  "preteur",
  "emprunteur",
  "depositaire",
  "courtier",
  "courtage",
  "copropriete",
  "coproprietaire",
  "indivision",
  "usufruit",
  "emphyteose",
  "bornage",
  "empietement",
  "mitoyennete",
  "troubles",
  "voisinage",
]);

const FR_ACCENTED_ONLY_WORDS = new Set([
  "préjudice",
  "résiliation",
  "résolution",
  "exécution",
  "réparation",
  "compétence",
  "procédure",
  "rétractation",
  "caché",
  "cachée",
  "cachés",
  "cachées",
  "intérêt",
  "intérêts",
  "élément",
  "éléments",
  "étrangère",
  "étranger",
  "extranéité",
  "signifiée",
  "présumé",
  "présumée",
  "réputé",
  "réputée",
  "allégué",
  "alléguée",
  "décès",
  "héritier",
  "héritiers",
  "propriété",
  "sociétés",
]);

const FR_BLOCKER_MARKERS = new Set([
  "le",
  "la",
  "de",
  "et",
  "ou",
  "en",
  "par",
  "un",
  "une",
  "ce",
  "se",
  "ne",
  "il",
  "on",
  "est",
]);

const FR_ACCENT_RE = /[éèêëàâùûçîïôœ]/i;

export function detectLanguageMismatch(query: string, lang: "fr" | "en"): string | null {
  const origWords = query.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (origWords.length === 0) return null;

  const enHits = new Set<string>();
  const frWordHits = new Set<string>();
  const frAccentedOnlyHits = new Set<string>();
  const nonProperAccents: string[] = [];
  let hasFrBlocker = false;

  for (const orig of origWords) {
    const lower = orig.toLowerCase();
    const norm = stripAccents(lower);
    const hasAccent = FR_ACCENT_RE.test(lower);

    if (hasAccent && !PROPER_NOUN_ACCENTS.has(norm)) {
      nonProperAccents.push(orig);
    }
    if (!hasAccent && EN_WORDS.has(norm)) {
      enHits.add(norm);
    }
    if (FR_WORDS.has(norm)) {
      frWordHits.add(norm);
    }
    if (FR_ACCENTED_ONLY_WORDS.has(lower)) {
      frAccentedOnlyHits.add(lower);
    }
    if (FR_BLOCKER_MARKERS.has(norm)) {
      hasFrBlocker = true;
    }
  }

  if (lang === "fr") {
    if (
      nonProperAccents.length === 0 &&
      frWordHits.size === 0 &&
      frAccentedOnlyHits.size === 0 &&
      !hasFrBlocker &&
      enHits.size >= 2
    ) {
      return (
        "Avertissement : la requête semble rédigée en anglais alors que lang='fr' est actif (par défaut). " +
        "Relancez avec lang='en' pour interroger les textes, intitulés et matières en anglais."
      );
    }
    return null;
  }

  if (enHits.size > 0) return null;

  const clearFrench =
    frWordHits.size >= 2 ||
    frAccentedOnlyHits.size >= 1 ||
    (frWordHits.size >= 1 && nonProperAccents.length >= 1) ||
    nonProperAccents.length >= 2 ||
    (nonProperAccents.length === 1 && (/^[a-zà-öø-ÿ]/.test(nonProperAccents[0]) || hasFrBlocker));

  if (clearFrench) {
    return (
      "Warning: the query appears to be in French while lang='en' is selected. " +
      "Re-run with lang='fr' to search the French texts, headings, and subjects."
    );
  }
  return null;
}

export const MAX_SUFFIX = 4;

export function wordMatch(haystackNorm: string, token: string): boolean {
  if (!haystackNorm || !token) return false;
  for (let i = haystackNorm.indexOf(token); i !== -1; i = haystackNorm.indexOf(token, i + 1)) {
    if (i > 0 && /[a-z0-9]/.test(haystackNorm[i - 1])) continue;
    let j = i + token.length;
    while (j < haystackNorm.length && /[a-z0-9]/.test(haystackNorm[j])) j++;
    if (j - (i + token.length) <= MAX_SUFFIX) return true;
  }
  return false;
}

export interface SubjectLite {
  id: string;
  label_fr: string;
  label_norm: string;
  description_fr: string | null;
}
export interface SubjectMapLite {
  subject_id: string;
  law_id: string;
  division_path: string;
}
export interface LawLite {
  id: string;
  name_fr: string;
  name_norm: string | null;
  fonction?: string | null;
  domain?: string | null;
  jurisdiction?: string | null;
  forum?: string | null;
}
export interface DivisionLite {
  law_id: string;
  path: string;
  heading: string | null;
  heading_norm: string | null;
}
export interface RelationLite {
  from_law_id: string;
  to_law_id: string;
  rel_type: string;
  source: string;
  in_corpus: number;
  note: string | null;
}

export interface RelevanceInput {
  tokens: string[];
  subjects: SubjectLite[];
  subjectMap: SubjectMapLite[];
  laws: LawLite[];
  divisions: DivisionLite[];
  relations: RelationLite[];
  mappedHeadings: Map<string, { path: string; heading: string | null }>;
}

export interface Candidate {
  law_id: string;
  division_path: string;
  heading: string | null;
  score: number;
  pourquoi: string[];
}

const keyOf = (lawId: string, path: string) => `${lawId}|${path}`;

export function rank(input: RelevanceInput, limit: number): Candidate[] {
  const { tokens } = input;

  interface Hit {
    token: string;
    lawId: string;
    path: string;
    heading: string | null;
    weight: number;
    why: string;
  }
  const hits: Hit[] = [];
  const hit = (
    token: string,
    lawId: string,
    path: string,
    heading: string | null,
    weight: number,
    why: string,
  ) => hits.push({ token, lawId, path, heading, weight, why });

  const bySubject = new Map<string, SubjectMapLite[]>();
  for (const m of input.subjectMap) {
    const arr = bySubject.get(m.subject_id);
    if (arr) arr.push(m);
    else bySubject.set(m.subject_id, [m]);
  }
  for (const s of input.subjects) {
    const hay = `${s.label_norm} ${normalize(s.id.replace(/-/g, " "))} ${normalize(s.description_fr)}`;
    for (const t of tokens) {
      if (!wordMatch(hay, t)) continue;
      for (const m of bySubject.get(s.id) ?? []) {
        const cible = m.division_path
          ? input.mappedHeadings.get(keyOf(m.law_id, m.division_path))
          : undefined;
        hit(
          t,
          m.law_id,
          cible?.path ?? m.division_path,
          cible?.heading ?? null,
          WEIGHTS.S1_SUBJECT,
          `matière : ${s.label_fr}`,
        );
      }
    }
  }

  for (const d of input.divisions) {
    for (const t of tokens) {
      if (!wordMatch(d.heading_norm ?? "", t)) continue;
      hit(
        t,
        d.law_id,
        d.path,
        d.heading,
        WEIGHTS.S2_DIVISION_HEADING,
        `intitulé : ${d.heading ?? d.path}`,
      );
    }
  }

  for (const l of input.laws) {
    for (const t of tokens) {
      if (!wordMatch(l.name_norm ?? "", t)) continue;
      hit(t, l.id, "", null, WEIGHTS.S3_LAW_NAME, `loi : ${l.name_fr}`);
    }
  }

  const reach = new Map<string, Set<string>>();
  const tokensOf = new Map<string, Set<string>>();
  for (const h of hits) {
    const k = keyOf(h.lawId, h.path);
    const set = reach.get(h.token) ?? new Set<string>();
    set.add(h.lawId);
    reach.set(h.token, set);
    const toks = tokensOf.get(k) ?? new Set<string>();
    toks.add(h.token);
    tokensOf.set(k, toks);
  }
  const factorOf = (t: string) => specificityFactor(reach.get(t)?.size ?? 0);

  const cands = new Map<string, Candidate>();
  const add = (lawId: string, path: string, heading: string | null, pts: number, why: string) => {
    const k = keyOf(lawId, path);
    let c = cands.get(k);
    if (!c) {
      c = { law_id: lawId, division_path: path, heading, score: 0, pourquoi: [] };
      cands.set(k, c);
    }
    if (heading && !c.heading) c.heading = heading;
    c.score += pts;
    if (!c.pourquoi.includes(why)) c.pourquoi.push(why);
  };
  for (const h of hits) {
    add(h.lawId, h.path, h.heading, h.weight * factorOf(h.token), h.why);
  }

  for (const [k, c] of cands) {
    c.score *= coverageFactor(tokensOf.get(k)?.size ?? 0, tokens.length);
  }

  const seedLaws = new Set([...cands.values()].map((c) => c.law_id));
  const gotS4 = new Set<string>();
  for (const r of input.relations) {
    if (r.source !== "cure" && r.rel_type !== "reglement-de") continue;
    if (!r.in_corpus) continue;
    const link = (target: string, other: string) => {
      if (seedLaws.has(target) || gotS4.has(target)) return;
      gotS4.add(target);
      add(target, "", null, WEIGHTS.S4_GRAPH_NEIGHBOUR, `connexe à ${other} (${r.rel_type})`);
    };
    if (seedLaws.has(r.from_law_id)) link(r.to_law_id, r.from_law_id);
    if (seedLaws.has(r.to_law_id)) link(r.from_law_id, r.to_law_id);
  }

  const fonctionOf = new Map(input.laws.map((l) => [l.id, l.fonction ?? null]));
  for (const c of cands.values()) {
    c.score *= fonctionWeight(fonctionOf.get(c.law_id));
  }

  const tries = [...cands.values()].sort(
    (a, b) =>
      b.score - a.score ||
      (a.division_path ? 0 : 1) - (b.division_path ? 0 : 1) ||
      a.law_id.localeCompare(b.law_id) ||
      a.division_path.localeCompare(b.division_path),
  );

  const parMatiere = new Map<string, number>();
  const parFonction = new Map<string, number>();
  const retenus: Candidate[] = [];
  const attente: Candidate[] = [];
  for (const c of tries) {
    const matieres = c.pourquoi.filter((p) => p.startsWith("matière : "));
    const autreSignal = c.pourquoi.length > matieres.length;
    const satureMatiere =
      !autreSignal &&
      matieres.length > 0 &&
      matieres.every((m) => (parMatiere.get(m) ?? 0) >= MAX_PER_SUBJECT);
    const f = fonctionOf.get(c.law_id) ?? null;
    const satureFonction =
      f !== null &&
      FONCTIONS_SOUPLES.has(f) &&
      (parFonction.get(f) ?? 0) >= MAX_PER_FONCTION_SOUPLE;
    if (satureMatiere || satureFonction) {
      attente.push(c);
      continue;
    }
    for (const m of matieres) parMatiere.set(m, (parMatiere.get(m) ?? 0) + 1);
    if (f !== null && FONCTIONS_SOUPLES.has(f)) parFonction.set(f, (parFonction.get(f) ?? 0) + 1);
    retenus.push(c);
    if (retenus.length >= limit) return retenus;
  }
  for (const c of attente) {
    if (retenus.length >= limit) break;
    retenus.push(c);
  }
  return retenus;
}
