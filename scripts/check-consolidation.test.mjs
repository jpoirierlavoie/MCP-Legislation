// Contrôles permanents du détecteur de veille (vitest, projet « node », sans réseau).
// Chaque cas verrouille un défaut trouvé par la revue adversariale du 2026-07-21 : ils ne
// doivent PLUS jamais réapparaître silencieusement.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import {
  agregeParSeau,
  classify,
  computeDrift,
  extractConsolidation,
  extractConsolidationFederale,
  NOM_PUBLIEUR,
  UNREACHABLE_ALERT_RATIO,
} from "./check-consolidation.mjs";

const RACINE = join(dirname(fileURLToPath(import.meta.url)), "..");

const banner = (d) => `<div class="text-end"> À jour au ${d} </div>`;

test("extractConsolidation : bannière canonique (avec <sup>er</sup>)", () => {
  assert.equal(
    extractConsolidation(`<div class="text-end"> À jour au 1<sup>er</sup> avril 2026 </div>`),
    "2026-04-01",
  );
  assert.equal(extractConsolidation(banner("3 mars 2025")), "2025-03-03");
});

test("extractConsolidation : ignore les dates d'historique HORS text-end (finding fidélité #6)", () => {
  // Une date d'historique AVANT la bannière ne doit pas être choisie.
  const html = `<p>en vigueur de la mise à jour au 1 janvier 1984</p>${banner("2 avril 2026")}`;
  assert.equal(extractConsolidation(html), "2026-04-02");
});

test("extractConsolidation : ignore le contenu des <script> (finding fidélité #8)", () => {
  const html = `<script>var x="jour au 9 mai 2010";</script>${banner("3 mars 2025")}`;
  assert.equal(extractConsolidation(html), "2025-03-03");
});

test("extractConsolidation : ne colle pas le texte d'éléments distincts (finding fidélité #8)", () => {
  // Hors text-end, un collage inter-éléments ne doit produire aucune date.
  const html = `<td>dernière mise à jour au</td><td>5 janvier 2024</td>`;
  assert.equal(extractConsolidation(html), null);
});

test("extractConsolidation : poursuit sur un mois invalide, retient la date valide (finding fidélité #7)", () => {
  const html = banner("5 foobar 2020") + banner("3 mars 2025");
  assert.equal(extractConsolidation(html), "2025-03-03");
});

test("extractConsolidation : page atteinte sans bannière -> null (=> illisible, pas silencieux)", () => {
  assert.equal(extractConsolidation(`<html><body>rien ici</body></html>`), null);
});

test("classify : une page 200 illisible n'est PAS rangée en injoignable (finding cardinal #1/#2)", () => {
  const { illisible, injoignable, retard } = classify([
    { status: "illisible", stored: "2026-04-01", live: null },
    { status: "injoignable", stored: "2026-04-01", live: null },
    { status: "ok", stored: "2026-04-01", live: "2026-04-02" },
  ]);
  assert.equal(illisible.length, 1);
  assert.equal(injoignable.length, 1);
  assert.equal(retard.length, 1);
});

test("classify : retard / anomalie / à jour / sans date stockée", () => {
  const { retard, anomalie, sansStockee } = classify([
    { status: "ok", stored: "2026-04-01", live: "2026-04-02" }, // retard
    { status: "ok", stored: "2026-04-02", live: "2026-04-01" }, // anomalie (D1 en avance)
    { status: "ok", stored: "2026-04-01", live: "2026-04-01" }, // à jour -> aucune catégorie
    { status: "ok", stored: null, live: "2026-04-01" }, // sans date stockée
  ]);
  assert.equal(retard.length, 1);
  assert.equal(anomalie.length, 1);
  assert.equal(sansStockee.length, 1);
});

test("computeDrift : une page illisible suffit à déclencher la dérive (finding cardinal)", () => {
  const d = computeDrift({
    retard: [],
    anomalie: [],
    sansStockee: [],
    illisible: [{}],
    sansLangue: [],
    injoignable: [],
    total: 10,
  });
  assert.equal(d.drift, true);
});

test("computeDrift : injoignables sous le seuil, sans autre signal -> pas de dérive", () => {
  const injoignable = Array.from({ length: 2 }, () => ({})); // 2/100 = 2 %
  const d = computeDrift({
    retard: [],
    anomalie: [],
    sansStockee: [],
    illisible: [],
    sansLangue: [],
    injoignable,
    total: 100,
  });
  assert.equal(d.drift, false);
});

test("computeDrift : blocage massif injoignable -> alerte réseau, SANS dérive corpus (séparation 2026-07-23)", () => {
  // Dérive résolue + 33 % de 502 tenait l'issue ouverte sous le titre « rafraîchissement
  // dû » — un titre qui mentait. Les deux signaux sont désormais séparés : le workflow
  // retitre en « vérification incomplète » et ne clôt que si les DEUX sont éteints.
  const injoignable = Array.from({ length: 30 }, () => ({})); // 30/100 = 30 % >= seuil
  const d = computeDrift({
    retard: [],
    anomalie: [],
    sansStockee: [],
    illisible: [],
    sansLangue: [],
    injoignable,
    total: 100,
  });
  assert.equal(d.unreachableRatio >= UNREACHABLE_ALERT_RATIO, true);
  assert.equal(d.unreachableAlert, true);
  assert.equal(d.drift, false);
});

test("computeDrift : blocage massif + retard réel -> les DEUX drapeaux levés (le blocage ne masque pas la dérive)", () => {
  const injoignable = Array.from({ length: 30 }, () => ({}));
  const d = computeDrift({
    retard: [{}],
    anomalie: [],
    sansStockee: [],
    illisible: [],
    sansLangue: [],
    injoignable,
    total: 100,
  });
  assert.equal(d.drift, true);
  assert.equal(d.unreachableAlert, true);
});

test("computeDrift : une loi sans langue déclarée est actionnable (finding #4/#5)", () => {
  const d = computeDrift({
    retard: [],
    anomalie: [],
    sansStockee: [],
    illisible: [],
    sansLangue: [{ id: "x" }],
    injoignable: [],
    total: 0,
  });
  assert.equal(d.drift, true);
});

// ---------------------------------------------------------------------------------------
// CORPUS FÉDÉRAL (2026-09-14). Le détecteur couvre DEUX publieurs depuis cette date.
//
// Défaut mesuré : `sources` n'était bâtie que sur `consolidation_source`, donc les 36
// contrôles fédéraux n'avaient AUCUNE URL, tombaient en `injoignable`, et — exclus
// d'`actionable` et noyés sous le seuil global de 25 % (36/194 = 18,6 %) — laissaient le
// job MENSUEL passer VERT pendant que 18 textes sur 97 n'étaient vérifiés par rien.
// ---------------------------------------------------------------------------------------

// Fragments RELEVÉS sur les pages réelles le 2026-09-14, entités HTML comprises. Le « à »
// arrive en entité sur les pages de lois et en littéral sur celles de règlements : un
// extracteur qui ne tiendrait qu'une des deux formes passerait la moitié du corpus sans
// rien dire. Chacun porte DEUX dates — « à jour » puis « dernière modification ».
const LOI_FR =
  "<div class='info'><p id='assentedDate'>Loi &agrave; jour 2026-07-21; " +
  "<a href='#hist'>derni&egrave;re modification</a> 2026-06-20 " +
  "<a href='PITIndex.html'>Versions antérieures</a></p></div>";
const LOI_EN =
  "<div class='info'><p id='assentedDate'>Act current to 2026-07-21 and " +
  "<a href='#hist'>last amended</a> on 2026-06-20. " +
  "<a href='PITIndex.html'>Previous Versions</a></p></div>";
const REGLEMENT_FR =
  "<div class='info'><p id='assentedDate'>Règlement à jour 2026-07-21; " +
  "<a href='#hist'>derni&egrave;re modification</a> 2025-12-21 " +
  "<a href='PITIndex.html'>Versions antérieures</a></p></div>";

test("extractConsolidationFederale : les trois libellés réels rendent la date « à jour »", () => {
  assert.equal(extractConsolidationFederale(LOI_FR), "2026-07-21");
  assert.equal(extractConsolidationFederale(LOI_EN), "2026-07-21");
  assert.equal(extractConsolidationFederale(REGLEMENT_FR), "2026-07-21");
});

test("extractConsolidationFederale : l'ORDRE des deux dates ne décide rien", () => {
  // Sans ce témoin, un extracteur naïf qui prend la première date du bloc passerait les
  // trois cas ci-dessus — par ordre d'apparition, pas par lecture. Mesuré : il rend
  // 2026-06-20 ici.
  const inverse =
    "<p id='assentedDate'><a href='#hist'>derni&egrave;re modification</a> " +
    "2026-06-20 — Loi &agrave; jour 2026-07-21;</p>";
  assert.equal(extractConsolidationFederale(inverse), "2026-07-21");
});

test("extractConsolidationFederale : une date HORS du bloc est ignorée (portée bornée)", () => {
  // Une page porte d'autres dates (historique, versions antérieures). Les lire serait un
  // faux SERVI : on annoncerait une fraîcheur que le publieur n'affirme pas.
  const html =
    "<p class='hist'>à jour 1999-01-01</p>" +
    "<div class='info'><p id='assentedDate'>Loi &agrave; jour 2026-07-21;</p></div>" +
    "<p class='note'>à jour 2030-12-31</p>";
  assert.equal(extractConsolidationFederale(html), "2026-07-21");
});

test("extractConsolidationFederale : ignore le contenu des <script> (parité avec le miroir QC)", () => {
  const html =
    "<script>var x=\"<p id='assentedDate'>Loi à jour 1999-01-01;</p>\";</script>" +
    "<p id='assentedDate'>Loi &agrave; jour 2026-07-21;</p>";
  assert.equal(extractConsolidationFederale(html), "2026-07-21");
});

test("extractConsolidationFederale : bloc absent -> null (=> illisible, jamais « à jour »)", () => {
  assert.equal(
    extractConsolidationFederale("<html><body><p>Loi à jour 2026-07-21;</p></body></html>"),
    null,
  );
});

test("extractConsolidationFederale : libellé changé -> null, on refuse au lieu de deviner", () => {
  assert.equal(
    extractConsolidationFederale("<p id='assentedDate'>Consolidé le 2026-07-21.</p>"),
    null,
  );
  // Format littéral : si Justice Canada y passait, les DEUX moitiés du miroir seraient à
  // reprendre — et ce null le dit au lieu de le taire.
  assert.equal(
    extractConsolidationFederale("<p id='assentedDate'>Loi à jour 21 juillet 2026;</p>"),
    null,
  );
});

test("MIROIR : la regex fédérale est identique des deux côtés (JS ↔ Python)", () => {
  // Même discipline que tests/paths.test.mjs : on ne se fie pas à deux jeux de témoins
  // parallèles, on compare les SOURCES. Une divergence de miroir est du même ordre que
  // celle de sort_key <-> sortKeyOf (invariant 2), qui avait vidé en silence le mode
  // plage de 36 lois sur 38.
  const js = readFileSync(join(RACINE, "scripts/check-consolidation.mjs"), "utf8");
  const py = readFileSync(join(RACINE, "pipeline/ingest.py"), "utf8");

  const mJs = js.match(/const DATE_FEDERALE = \/([^/]+)\/i;/);
  assert.ok(mJs, "regex d'ancrage introuvable dans check-consolidation.mjs");

  const mPy = py.match(/_DATE_FEDERALE = re\.compile\(r"([^"]+)", re\.I\)/);
  assert.ok(mPy, "_DATE_FEDERALE introuvable dans pipeline/ingest.py");

  assert.equal(
    mJs[1],
    mPy[1],
    "les deux moitiés du miroir de date fédérale ont divergé : l'ingestion et la veille " +
      "liraient des dates différentes sur la même page, et les 36 contrôles fédéraux " +
      "seraient faux sans qu'aucun test ne rougisse.",
  );

  // L'identifiant du bloc borne la portée des deux côtés : le vérifier aussi.
  assert.ok(js.includes("assentedDate"), "portée du bloc absente côté JS");
  assert.ok(py.includes('find("p", id="assentedDate")'), "portée du bloc absente côté Python");
});

// ---------------------------------------------------------------------------------------
// AGRÉGATION PAR SEAU — ce que RIEN ne gardait avant le 2026-09-14.
// ---------------------------------------------------------------------------------------

const ctl = (publieur, status, extra = {}) => ({
  id: "x",
  lang: "fr",
  publieur,
  status,
  stored: "2026-01-01",
  live: "2026-01-01",
  ...extra,
});

test("agregeParSeau : un seau ENTIÈREMENT bloqué alerte, même si l'autre est propre", () => {
  // LE défaut d'origine, reproduit à l'échelle réelle : 36 fédéraux tous injoignables,
  // 158 québécois parfaitement sains.
  const checks = [
    ...Array.from({ length: 36 }, () => ctl("justice", "injoignable", { note: "réseau" })),
    ...Array.from({ length: 158 }, () => ctl("legisquebec", "ok")),
  ];
  const r = agregeParSeau(checks);
  assert.equal(r.unreachableAlert, true, "un blocage TOTAL du fédéral doit alerter");
  assert.deepEqual(r.bloquees, [NOM_PUBLIEUR.justice]);
  assert.equal(r.seaux.get("justice").unreachableRatio, 1);
  assert.equal(r.seaux.get("legisquebec").unreachableAlert, false);
});

test("agregeParSeau : le MÊME jeu agrégé globalement NE déclencherait PAS l'alerte", () => {
  // Le contre-témoin, et c'est lui qui prouve que le découpage sert à quelque chose.
  // 36/194 = 18,6 % < 25 % : sans les seaux, le job passait VERT.
  const injoignable = Array.from({ length: 36 }, () => ({}));
  const global = computeDrift({
    retard: [],
    anomalie: [],
    sansStockee: [],
    illisible: [],
    sansLangue: [],
    injoignable,
    total: 194,
  });
  assert.equal(global.unreachableAlert, false);
  assert.ok(global.unreachableRatio < UNREACHABLE_ALERT_RATIO);
});

test("agregeParSeau : la dérive d'UN seul seau suffit à faire parler le job (OU)", () => {
  const checks = [
    ctl("justice", "ok", { stored: "2026-01-01", live: "2026-07-21" }), // retard
    ctl("legisquebec", "ok"),
  ];
  const r = agregeParSeau(checks);
  assert.equal(r.drift, true);
  assert.equal(r.seaux.get("justice").drift, true);
  assert.equal(r.seaux.get("legisquebec").drift, false);
});

test("agregeParSeau : `bloquees` nomme les DEUX publieurs quand les deux bloquent", () => {
  // Le titre d'issue est bâti là-dessus : le nommer en dur ferait mentir le titre, défaut
  // déjà corrigé une fois dans ce dépôt (2026-07-23, « le titre mentait »).
  const checks = [
    ...Array.from({ length: 4 }, () => ctl("justice", "injoignable", { note: "réseau" })),
    ...Array.from({ length: 4 }, () => ctl("legisquebec", "injoignable", { note: "réseau" })),
  ];
  const r = agregeParSeau(checks);
  assert.deepEqual(r.bloquees.sort(), [NOM_PUBLIEUR.justice, NOM_PUBLIEUR.legisquebec].sort());
});

test("agregeParSeau : un seau VIDE est OMIS, jamais compté comme sain", () => {
  // Si le corpus perdait toutes ses entrées fédérales, un seau vide à zéro injoignable
  // rendrait « tout va bien » sur une surveillance qui ne surveille plus rien.
  const r = agregeParSeau([ctl("legisquebec", "ok")]);
  assert.equal(r.seaux.has("justice"), false);
  assert.equal(r.seaux.size, 1);
});

test("agregeParSeau : une loi sans langue reste actionnable, DANS SON seau", () => {
  const r = agregeParSeau([ctl("legisquebec", "ok")], [{ id: "ca-x", publieur: "justice" }]);
  assert.equal(r.drift, true);
  assert.equal(r.seaux.get("justice").drift, true);
  assert.equal(r.seaux.get("legisquebec").drift, false);
});
