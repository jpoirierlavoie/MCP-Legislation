// Classement de pertinence pour legislation_find_relevant (plan-couche-decouverte §4.4/§4.5).
//
// Entièrement DÉTERMINISTE : aucun appel de modèle. Le score d'un candidat est la somme des
// signaux S1–S4 déclenchés par les tokens de la requête normalisée.
//
// ⚠️ Les poids vivent ICI et nulle part ailleurs (§4.5) : ils se calibrent avec les évals
// (tests/evals.mjs), jamais en dur dans une requête SQL.

/** Poids des signaux (§4.4). Un seul point de vérité. */
export const WEIGHTS = {
  /** S1 — token dans le libellé / l'id / la description d'un sujet -> entités mappées. */
  S1_SUBJECT: 3,
  /** S2 — token dans l'intitulé normalisé d'une division. */
  S2_DIVISION_HEADING: 2,
  /** S3 — token dans le nom normalisé d'une loi. */
  S3_LAW_NAME: 2,
  /** S4 — voisin de graphe ('cure' ou 'reglement-de') d'une entité déjà retenue. */
  S4_GRAPH_NEIGHBOUR: 1,
} as const;

/**
 * Spécificité d'un token. Un token qui ne touche qu'une poignée d'entités est
 * DISCRIMINANT (« taq », « rdprm », « courtage ») ; un token générique dans un corpus
 * entièrement juridique (« procédure », « contrat ») en touche des dizaines et n'apprend
 * presque rien. Sans ce correctif, « procédure TAQ » noie j-3 sous les sept règlements de
 * procédure civile déclenchés par le seul mot « procédure ».
 *
 * ⚠️ La pondération est CONTINUE, pas un seuil. Une falaise (« ≤ 4 entités -> ×2, sinon
 * ×1 ») a une position qui dépend de la TAILLE DU CORPUS : en passant de 47 à 78 lois,
 * « récusation » est passé de 4 à 5 entités touchées, a perdu son facteur d'un coup, et le
 * chapitre de la récusation du C.p.c. s'est fait évincer du top 8 par des dizaines de
 * simples « juge ». Décroissance douce -> le classement ne bascule plus à l'ajout d'une loi.
 *
 *   facteur(portée) = 1 + (FACTOR - 1) × min(1, MAX_REACH / portée)
 *   portée ≤ 4 -> ×2,00   5 -> ×1,80   8 -> ×1,50   20 -> ×1,20   100 -> ×1,04
 */
export const SPECIFIC_TOKEN_MAX_REACH = 4;
export const SPECIFIC_TOKEN_FACTOR = 2;

/**
 * Plafond de candidats portés par UNE SEULE matière dans la liste rendue.
 *
 * Une matière est UNE preuve, mais elle injecte autant de candidats qu'elle a d'entités
 * mappées, tous au même score : « bâtiment et construction » compte 7 lois, qui
 * remplissaient à elles seules le top 8 de « perte de l'ouvrage cinq ans entrepreneur »
 * et en chassaient le C.c.Q. Les candidats qui portent AUSSI un autre signal (intitulé,
 * nom de loi, graphe) échappent au plafond ; les autres passent en file d'attente et ne
 * reviennent que s'il reste de la place.
 */
export const MAX_PER_SUBJECT = 3;

export function specificityFactor(reach: number): number {
  if (reach <= 0) return 1;
  return 1 + (SPECIFIC_TOKEN_FACTOR - 1) * Math.min(1, SPECIFIC_TOKEN_MAX_REACH / reach);
}

/**
 * Plancher du facteur de COUVERTURE : la fraction de son score qu'un candidat garde
 * lorsqu'il n'apparie qu'un seul token d'une requête qui en compte plusieurs.
 *
 * POURQUOI. La somme des signaux ne regardait pas du tout la question posée. Mesuré en
 * production le 2026-09-17 sur « bail commercial résiliation défaut de payer le loyer » :
 * la Loi sur la concurrence (ca-c-34) marquait 4,0909 pour le SEUL token « commercial »,
 * capté par le libellé « Pratiques commerciales restrictives » — exactement le même score
 * que sur la requête « bail commercial », où ce token est 1 des 2 et non 1 des 6. Le Code
 * de procédure pénale sortait de la même façon, sur le mot « défaut » présent dans sa
 * description de matière. Un candidat qui n'explique qu'un sixième de la question ne peut
 * pas primer un candidat qui en explique la moitié.
 *
 * ⚠️ CONTINU, pas un seuil — même raison qu'à `specificityFactor` ci-dessus (invariant 12) :
 * une falaise sur un décompte de tokens basculerait selon la longueur de la requête.
 * Une requête à UN token est inchangée (couverture 1/1 -> facteur 1).
 *
 *   facteur(appariés, total) = FLOOR + (1 - FLOOR) × min(1, appariés / total)
 *   1/6 -> ×0,583   2/6 -> ×0,667   1/2 -> ×0,750   2/3 -> ×0,833   1/1 -> ×1,00
 */
export const COVERAGE_FLOOR = 0.5;

export function coverageFactor(apparies: number, total: number): number {
  if (total <= 0) return 1;
  return COVERAGE_FLOOR + (1 - COVERAGE_FLOOR) * Math.min(1, apparies / total);
}

/**
 * Rendement minimal d'un barreau leave-one-out pour ARRÊTER l'échelle de recherche.
 *
 * POURQUOI. L'échelle s'arrêtait au premier barreau rendant au moins UN résultat, si bien
 * qu'une liste d'un seul article masquait le barreau OU suivant. Mesuré en production le
 * 2026-09-17 : « vice caché garantie qualité » rendait 1 résultat par leave-one-out
 * (p-40.1 art. 53.1, sur les automobiles gravement défectueuses) et s'arrêtait là, alors
 * que le OU met C.c.Q. 1726, 1728 et 1727 en tête — la garantie de qualité, soit la réponse.
 *
 * POURQUOI 2 ET NON 3. Le cas fondateur de l'échelle (art. 490 C.p.c., « signification hors
 * du Québec délai ») rend 8 résultats SUR LE CORPUS mais seulement **2** restreint au C.p.c.
 * — mesuré le 2026-09-17, en abaissant `limit` à 1 pour lire le rendement réel. Un plancher
 * à 3 le faisait donc basculer au OU : cpc 490 restait en tête, mais sa liste précise de
 * deux articles devenait une liste de 579. À 2, AUCUN cas mesuré ne se déplace et le défaut
 * est fermé quand même. Une valeur plus haute corrige davantage que ce qui est cassé.
 *
 * La marge est donc de UN, et c'est assumé : un leave-one-out qui rend un seul document ne
 * rend pas un ensemble de résultats mais une coïncidence — rien n'y corrobore rien. Deux
 * documents, si. C'est cette frontière-là qui est calibrée, pas une quantité.
 *
 * Les deux autres bornes de l'échelle (`RELAX_MIN_TERMS`, `RELAX_MAX_LOO_TERMS`) vivent
 * encore dans `src/lib.ts` : elles n'ont jamais été citées à la page publique, donc rien
 * ne les a tirées ici. Celle-ci l'est (catalogue.json, section « echelle »), et
 * `tests/catalogue.test.mjs` exige que toute constante citée se trouve DANS ce fichier.
 */
export const RELAX_MIN_LOO_TOTAL = 2;

/**
 * Fusion RRF de la recherche hybride (plan v2, 2.3) : score(d) = Σ 1/(k + rang_liste(d)).
 * k = 60 (valeur canonique du plan). La calibration vit ICI, avec les poids S1–S4.
 */
export const RRF_K = 60;
/** Profondeur des deux listes fusionnées (FTS et vecteurs). */
export const VECTOR_TOP_K = 20;
/** Correspondances de type 'division' : seuil de score cosine et plafond d'affichage. */
export const DIVISION_MATCH_MIN_SCORE = 0.5;
export const DIVISION_MATCH_MAX = 2;
/**
 * Plancher de score cosine des correspondances d'ARTICLES vectorielles. Vectorize rend
 * TOUJOURS ses topK, pertinents ou non : sans plancher, « zzz qqq » recevait les plus
 * proches voisins d'un embedding de charabia, présentés comme des résultats.
 */
export const SEMANTIC_MIN_SCORE = 0.4;
// Calibré par MESURE en production (2026-07-21) : requête réelle EN->FR (cas 19)
// cpc 490 @ 0,525 ; requête FR vague 0,47-0,49 ; charabia « zzz qqq » max 0,303.
// 0,40 sépare avec marge des deux côtés.

/** Longueur minimale d'un token retenu (« du », « la »… n'apportent rien). */
export const MIN_TOKEN_LENGTH = 3;
/** Plafond de tokens pris en compte (borne le nombre de requêtes et le score maximal). */
export const MAX_TOKENS = 8;

/**
 * Mots vides : grammaire française + quelques mots juridiques trop génériques pour
 * discriminer dans un corpus qui est ENTIÈREMENT du droit québécois (« loi », « code »,
 * « québec » n'y apprennent rien).
 */
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
  // trop génériques dans ce corpus précis
  "loi",
  "lois",
  "article",
  "articles",
  "art",
  "code",
  "quebec",
  "droit",
  "droits",
]);

/** Normalisation de référence — miroir exact de pipeline/norm.py (§2). */
export function normalize(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Tokens retenus d'une requête : normalisés, dédoublonnés, sans mots vides, plafonnés. */
export function tokenize(query: string): string[] {
  const seen = new Set<string>();
  for (const raw of normalize(query).split(/[^a-z0-9]+/)) {
    if (raw.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(raw)) seen.add(raw);
    if (seen.size >= MAX_TOKENS) break;
  }
  return [...seen];
}

/**
 * Suffixe toléré après un token, en caractères. Couvre la flexion française usuelle
 * (-s, -es, -aux, -ment, -tion) sans laisser un token court avaler un mot sans rapport :
 * « fin » captait « financier » (+6) et noyait une requête sur la fin d'emploi sous tout
 * le bloc du secteur financier. « hypotheque »->« hypotheques » (+1), « civil »->« civile »
 * (+1), « travail »->« travailleur » (+4) restent valides.
 */
export const MAX_SUFFIX = 4;

/**
 * Le token apparaît-il en DÉBUT DE MOT dans le texte normalisé, avec un suffixe borné ?
 *
 * On veut « hypotheque » ⊂ « hypothèques » et « civil » ⊂ « civile » (suffixes tolérés),
 * mais PAS « vice » ⊂ « services » : une correspondance en plein milieu d'un mot est du
 * bruit. D'où l'ancrage sur un début de mot plutôt qu'un simple `indexOf` — et le
 * plafond de suffixe, sans lequel un token de 3 lettres capte des mots de 9.
 */
export function wordMatch(haystackNorm: string, token: string): boolean {
  if (!haystackNorm || !token) return false;
  for (let i = haystackNorm.indexOf(token); i !== -1; i = haystackNorm.indexOf(token, i + 1)) {
    if (i > 0 && /[a-z0-9]/.test(haystackNorm[i - 1])) continue; // pas un début de mot
    let j = i + token.length;
    while (j < haystackNorm.length && /[a-z0-9]/.test(haystackNorm[j])) j++;
    if (j - (i + token.length) <= MAX_SUFFIX) return true;
  }
  return false;
}

// --- entrées du classement ----------------------------------------------------

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
  /** Divisions DÉJÀ préfiltrées en SQL (sous-chaîne) ; on affine ici au début de mot. */
  divisions: DivisionLite[];
  relations: RelationLite[];
  /**
   * Divisions citées par subject_map, clé `law_id|path_FR` -> cible dans la langue demandée.
   * subject_map ne stocke que des chemins FR, or les identifiants Irosoft sont propres à la
   * langue : sans cette table, une réponse EN renverrait des chemins inexploitables.
   */
  mappedHeadings: Map<string, { path: string; heading: string | null }>;
}

export interface Candidate {
  law_id: string;
  /** '' = la loi entière ; sinon path Irosoft d'une division. */
  division_path: string;
  heading: string | null;
  score: number;
  pourquoi: string[];
}

const keyOf = (lawId: string, path: string) => `${lawId}|${path}`;

/**
 * Classe les candidats. Un même candidat cumule les signaux ; un signal cumule aussi
 * par token distinct (une division dont l'intitulé contient « bail » ET « logement » est
 * plus pertinente pour « bail de logement » qu'une qui n'en contient qu'un).
 *
 * Deux rééchelonnages bornent ce cumul, tous deux CONTINUS (invariant 12) : la spécificité
 * de chaque token (`specificityFactor`) et la couverture de la requête par le candidat
 * (`coverageFactor`). Sans le second, un candidat n'appariant qu'un token sur six marquait
 * autant que sur une requête de deux tokens — le score ne dépendait pas de la question.
 */
export function rank(input: RelevanceInput, limit: number): Candidate[] {
  const { tokens } = input;

  /** Un déclenchement de signal, avant pondération par la spécificité du token. */
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

  // S1 — sujets. Surface d'appariement : libellé + id + description. La description est
  // l'endroit où le juriste dépose le vocabulaire du domaine (taxonomy.json, §3.1) : c'est
  // le levier de calibrage éditorial du routeur.
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
        // ⚠️ REPLI SILENCIEUX CONNU, non corrigé, et c'est délibéré (relevé le 2026-09-17).
        // Les chemins de `subject_map` sont FRANÇAIS ; en anglais ils passent par le pont des
        // numéros d'articles (`translatePaths`). Si la traduction manque, la ligne ci-dessous
        // retombe sur le chemin français avec un intitulé nul — une piste que
        // `get_division(lang='en')` n'ouvre pas, servie comme si elle était ouvrable.
        // POURQUOI ON N'Y TOUCHE PAS ICI : retomber sur la LOI ENTIÈRE serait honnête, mais
        // ferait FUSIONNER sur `law_id|''` tous les candidats de toutes les matières mappant
        // cette loi, en cumulant leurs scores — un super-candidat au comportement non mesuré,
        // pour réparer une panne qui ne se produit pas (les miroirs anglais de
        // `tests/evals.mjs` passent). L'asymétrie de risque est mauvaise. La condition
        // nécessaire est gardée par `pipeline/discovery/verify.py` (§2bis) ; le chantier
        // propre est de faire ÉCHOUER la traduction bruyamment, avec son propre avant/après.
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

  // S2 — intitulés de divisions (préfiltrés en SQL, affinés au début de mot ici).
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

  // S3 — noms de lois.
  for (const l of input.laws) {
    for (const t of tokens) {
      if (!wordMatch(l.name_norm ?? "", t)) continue;
      hit(t, l.id, "", null, WEIGHTS.S3_LAW_NAME, `loi : ${l.name_fr}`);
    }
  }

  // Portée de chaque token = nombre d'entités distinctes qu'il touche. Les tokens à faible
  // portée sont discriminants et pèsent davantage (cf. SPECIFIC_TOKEN_FACTOR).
  //
  // Le MÊME balayage rend le tableau croisé : quels tokens chaque candidat apparie. C'est
  // la base du facteur de couverture (cf. COVERAGE_FLOOR) — les deux lectures de `hits`
  // sont symétriques, l'une par token, l'autre par candidat.
  const reach = new Map<string, Set<string>>();
  const tokensOf = new Map<string, Set<string>>();
  for (const h of hits) {
    const k = keyOf(h.lawId, h.path);
    const set = reach.get(h.token) ?? new Set<string>();
    set.add(k);
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

  // Couverture : rééchelonnage par la part de la REQUÊTE que le candidat explique. Appliqué
  // ici, donc APRÈS la sommation S1–S3 et AVANT S4 — l'appoint de graphe n'est pas
  // rééchelonné, cohérent avec le fait qu'il échappe déjà au facteur de spécificité (il ne
  // vient d'aucun token, il n'a donc pas de couverture à mesurer).
  for (const [k, c] of cands) {
    c.score *= coverageFactor(tokensOf.get(k)?.size ?? 0, tokens.length);
  }

  // S4 — voisinage de graphe, UN SEUL saut depuis les entités déjà retenues (S1–S3), et
  // AU PLUS une fois par candidat : sans ce plafond, une loi à nombreux règlements (cpc)
  // récolterait un bonus proportionnel à sa popularité plutôt qu'à sa pertinence.
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

  const tries = [...cands.values()].sort(
    (a, b) =>
      b.score - a.score ||
      // départage stable : une cible précise (division) avant la loi entière, puis l'id
      (a.division_path ? 0 : 1) - (b.division_path ? 0 : 1) ||
      a.law_id.localeCompare(b.law_id) ||
      a.division_path.localeCompare(b.division_path),
  );

  // Sélection avec plafond de diversité par matière (cf. MAX_PER_SUBJECT).
  const parMatiere = new Map<string, number>();
  const retenus: Candidate[] = [];
  const attente: Candidate[] = [];
  for (const c of tries) {
    const matieres = c.pourquoi.filter((p) => p.startsWith("matière : "));
    const autreSignal = c.pourquoi.length > matieres.length;
    const sature =
      !autreSignal &&
      matieres.length > 0 &&
      matieres.every((m) => (parMatiere.get(m) ?? 0) >= MAX_PER_SUBJECT);
    if (sature) {
      attente.push(c);
      continue;
    }
    for (const m of matieres) parMatiere.set(m, (parMatiere.get(m) ?? 0) + 1);
    retenus.push(c);
    if (retenus.length >= limit) return retenus;
  }
  // la diversité n'a pas rempli la liste : on complète par la file d'attente (ordre de score)
  for (const c of attente) {
    if (retenus.length >= limit) break;
    retenus.push(c);
  }
  return retenus;
}
