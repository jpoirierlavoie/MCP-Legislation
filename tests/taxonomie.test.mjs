// Garde de la TAXONOMIE des matières. vitest (projet « node »), SANS réseau, SANS D1 :
// `taxonomy.json` est lue comme une donnée, et une incohérence doit faire rougir une PR.
//
// POURQUOI CETTE GARDE EXISTE. Le chapitre « DU LOUAGE » du C.c.Q. — art. 1851 et suivants,
// dont les sections I à III sont le régime général applicable au BAIL COMMERCIAL — portait
// la matière « Louage résidentiel », et elle seule. Conséquences mesurées en production le
// 2026-09-17 : `legislation_find_relevant("bail commercial")` servait à un modèle le motif
// « matière : Louage résidentiel » pour du droit commercial, et le chapitre sortait derrière
// la Loi sur la concurrence. Rien ne rougissait : une étiquette fausse n'est pas une erreur
// de structure, et aucun test ne regardait la taxonomie.
//
// Ce que cette garde attrape : un Livre du C.c.Q. qui perd son rattachement ; une matière
// étroite qui se remet à revendiquer tout le louage ; une matière muette en anglais ; un
// mappage en doublon ou orphelin ; une matière qui franchit le seuil de l'invariant 15 sans
// qu'on l'ait décidé.
//
// Ce qu'elle n'attrape PAS : qu'un rattachement soit JURIDIQUEMENT juste. Aucun test ne
// remplace la passe éditoriale — la structure seule est gardable.
//
// L'invariant 13 (aucune mention contrastive dans une description, qui est une surface
// d'appariement) est gardé dans `test/repere-score.test.ts`, où la vraie fonction
// `normalize` de `src/relevance.ts` est disponible. La dupliquer ici recréerait le miroir
// dont la divergence est précisément le mode de défaut de ce dépôt.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const json = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf-8"));

const taxonomy = json("taxonomy.json");
const RAPPEL =
  "taxonomy.json est du contenu ÉDITORIAL (invariant 16) : toute évolution passe par Jason.";

const CHAPITRE_LOUAGE = "ga:l_cinquieme-gb:l_deuxieme-gc:l_quatrieme";
const SECTION_LOGEMENT = `${CHAPITRE_LOUAGE}-gd:l_iv`;

/** Les dix Livres du C.c.Q., par leur chemin Irosoft français. */
const LIVRES_CCQ = [
  "ga:l_premier",
  "ga:l_deuxieme",
  "ga:l_troisieme",
  "ga:l_quatrieme",
  "ga:l_cinquieme",
  "ga:l_sixieme",
  "ga:l_septieme",
  "ga:l_huitieme",
  "ga:l_neuvieme",
  "ga:l_dixieme",
];

/**
 * Matières portant PLUS de 5 entités mappées, épinglées.
 *
 * L'invariant 15 les désigne comme candidates au défaut de diversité : une matière injecte
 * un candidat par entité, tous au même score, et « Bâtiment et construction » (7 lois)
 * remplissait à elle seule le top 8 en évinçant le C.c.Q. `MAX_PER_SUBJECT` plafonne la
 * LISTE, il n'empêche pas la matière de grossir. Franchir le seuil doit donc être un acte
 * DÉLIBÉRÉ, vérifié à l'éval — pas une conséquence d'un mappage ajouté en passant.
 */
const GROSSES_MATIERES = ["batiment-construction", "procedure-civile"];

const entitesParMatiere = () => {
  const n = new Map();
  for (const m of taxonomy.mappings) n.set(m.subject, (n.get(m.subject) ?? 0) + 1);
  return n;
};

const divisionsDe = (law) =>
  taxonomy.mappings.filter((m) => m.law === law && m.division_path).map((m) => m.division_path);

test("chaque Livre du C.c.Q. porte une division mappée", () => {
  // Sans rattachement, un Livre entier est invisible au signal S1 : la matière ne peut pas
  // le proposer, et seul un intitulé de division (S2) pourrait le rattraper par hasard.
  const mappees = new Set(divisionsDe("ccq"));
  const manquants = LIVRES_CCQ.filter((p) => !mappees.has(p));
  assert.deepEqual(manquants, [], `Livres du C.c.Q. sans matière rattachée : ${RAPPEL}`);
});

test("le régime GÉNÉRAL du louage et la section du bail d'habitation sont mappés", () => {
  const mappees = new Set(divisionsDe("ccq"));
  assert.ok(
    mappees.has(CHAPITRE_LOUAGE),
    `le chapitre du louage (${CHAPITRE_LOUAGE}) n'est plus rattaché : le bail commercial ` +
      `redevient introuvable par find_relevant. ${RAPPEL}`,
  );
  assert.ok(
    mappees.has(SECTION_LOGEMENT),
    `la section du bail d'habitation (${SECTION_LOGEMENT}) n'est plus rattachée. ${RAPPEL}`,
  );
});

test("ces deux divisions relèvent de matières DISTINCTES", () => {
  // Le défaut corrigé : une seule matière, « Louage résidentiel », couvrait les deux — donc
  // tout le louage commercial était servi sous une étiquette résidentielle.
  const sujetsDe = (path) =>
    taxonomy.mappings
      .filter((m) => m.law === "ccq" && m.division_path === path)
      .map((m) => m.subject);
  const general = sujetsDe(CHAPITRE_LOUAGE);
  const logement = sujetsDe(SECTION_LOGEMENT);
  const communs = general.filter((s) => logement.includes(s));
  assert.deepEqual(
    communs,
    [],
    "une même matière couvre le chapitre du louage ET la section du bail d'habitation : " +
      `le régime commercial serait de nouveau étiqueté résidentiel. ${RAPPEL}`,
  );
});

test("la matière du louage général ne restreint pas son libellé au résidentiel", () => {
  const [sujetId] = taxonomy.mappings
    .filter((m) => m.law === "ccq" && m.division_path === CHAPITRE_LOUAGE)
    .map((m) => m.subject);
  const sujet = taxonomy.subjects.find((s) => s.id === sujetId);
  assert.ok(sujet, `matière « ${sujetId} » déclarée par un mappage mais absente. ${RAPPEL}`);
  // Un libellé qui dit « résidentiel » ou « logement » devant le régime général est un motif
  // FAUX servi à un modèle — c'est le défaut mesuré, et il ne coûtait aucune erreur.
  const surface = `${sujet.label_fr} ${sujet.label_en}`.toLowerCase();
  const fautifs = ["residentiel", "résidentiel", "logement", "residential", "dwelling"].filter(
    (mot) => surface.includes(mot),
  );
  assert.deepEqual(
    fautifs,
    [],
    `le libellé de « ${sujetId} » restreint au résidentiel un chapitre qui régit aussi le ` +
      `bail commercial : le motif servi serait faux. ${RAPPEL}`,
  );
});

test("chaque matière est bilingue — sinon le routeur est muet en anglais", () => {
  // Miroir en CI de pipeline/discovery/load.py (validate) : là-bas l'absence ne se voit qu'au
  // chargement, donc après la revue. Le signal S1 apparie `description_en` en `lang='en'`.
  const fautifs = [];
  for (const s of taxonomy.subjects) {
    for (const champ of ["label_fr", "label_en", "description_fr", "description_en"]) {
      if (!s[champ] || !String(s[champ]).trim()) fautifs.push(`${s.id}.${champ}`);
    }
  }
  assert.deepEqual(fautifs, [], `champs de matière vides ou absents : ${RAPPEL}`);
});

test("aucun mappage en doublon, aucun orphelin dans les deux sens", () => {
  const ids = new Set(taxonomy.subjects.map((s) => s.id));
  assert.equal(ids.size, taxonomy.subjects.length, `identifiants de matière en doublon. ${RAPPEL}`);

  const vus = new Set();
  const doublons = [];
  for (const m of taxonomy.mappings) {
    const cle = `${m.subject}|${m.law}|${m.division_path ?? ""}`;
    if (vus.has(cle)) doublons.push(cle);
    vus.add(cle);
  }
  assert.deepEqual(doublons, [], `mappages en doublon : ${RAPPEL}`);

  const inconnues = [
    ...new Set(taxonomy.mappings.filter((m) => !ids.has(m.subject)).map((m) => m.subject)),
  ];
  assert.deepEqual(inconnues, [], `mappages vers une matière non déclarée : ${RAPPEL}`);

  const utilisees = new Set(taxonomy.mappings.map((m) => m.subject));
  const orphelines = taxonomy.subjects.filter((s) => !utilisees.has(s.id)).map((s) => s.id);
  assert.deepEqual(
    orphelines,
    [],
    `matières sans aucun mappage — invisibles au signal S1, donc inertes. ${RAPPEL}`,
  );
});

test("les matières qui franchissent le seuil de l'invariant 15 sont celles qu'on a décidées", () => {
  const n = entitesParMatiere();
  const grosses = [...n.entries()]
    .filter(([, c]) => c > 5)
    .map(([id]) => id)
    .sort();
  assert.deepEqual(
    grosses,
    [...GROSSES_MATIERES].sort(),
    "la liste des matières à plus de 5 entités mappées a changé. Une matière large injecte " +
      "un candidat par entité au même score et peut remplir la liste à elle seule " +
      `(invariant 15) : le vérifier à l'éval, pas au jugé. ${RAPPEL}`,
  );
});

test("chaque loi mappée par un chemin de division l'est par un chemin Irosoft ou LIMS", () => {
  // La résolution réelle du chemin contre `divisions` est faite par load.py (qui REFUSE un
  // chemin introuvable) et par verify.py. Ici : la forme seule, qui ne demande pas de base.
  const FORMES = /^(g[a-z]:|fh\d+:|annexe-|fs:|s_)/;
  const fautifs = taxonomy.mappings
    .filter((m) => m.division_path && !FORMES.test(m.division_path))
    .map((m) => `${m.subject} -> ${m.law}/${m.division_path}`);
  assert.deepEqual(fautifs, [], `chemins de division de forme inattendue : ${RAPPEL}`);
});
