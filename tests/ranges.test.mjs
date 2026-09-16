// Gardes du mode PLAGE de legislation_get_articles — hors réseau, en CI.
//
// Pourquoi ce fichier existe. `articles.sort_key` n'est pas un ordre total : il empaquette
// `int(composante)` en base 1000, donc `int("01") === int("1")` et le zéro de tête est
// PERDU. Mesuré en production le 2026-09-07 : 8 collisions entre articles réels
// (ccq-r.8 `15.01`≡`15.1` et `15.02`≡`15.2` ; t-15.01 `31.01`≡`31.1` et `31.02`≡`31.2`,
// dans les deux langues), 15 inversions par rapport à l'ordre du document, et 178 articles
// portant une composante à zéro de tête. Défaut SERVI : `from='15.1' to='15.2'` rendait
// QUATRE articles au lieu de deux.
//
// Aucune arithmétique ne répare `sort_key` : le corpus exige à la fois `199.1 < 199.10`
// (lecture ordinale) et `1.022 < 1.03` (lecture fractionnaire, ordre du document de
// b-1.1-r.2). Une règle par composante ne peut pas servir les deux — mesuré : rembourrer
// la composante à droite fait passer les collisions de 8 à 484. Le correctif ne corrige
// donc PAS la clé, il cesse de lui demander ce qu'elle ne peut pas donner : une plage
// bornée par deux articles réels est résolue sur `articles.id`, qui EST l'ordre du document
// à l'intérieur d'un couple (law_id, lang).
//
// Ces contrôles lisent la SOURCE COMME DU TEXTE, à l'image de tests/catalogue.test.mjs et
// de tests/page-client.test.mjs : il n'existe aucune étape de compilation pour les tests
// (tsconfig `noEmit`, pas d'`allowJs`), donc un test ne peut pas importer src/lib.ts.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

const lire = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const LIB = lire("src/lib.ts");
const TOOLS = lire("src/tools.ts");
const BACKFILL = lire("src/backfill.ts");

// ---------------------------------------------------------------------------
// 1. Le mécanisme, reproduit tel qu'il était — pour que la RAISON du correctif
//    reste lisible même quand plus personne ne se souvient de l'incident.
// ---------------------------------------------------------------------------

/** L'ancienne règle, verbatim : empaquetage base 1000 de `int(composante)`. */
function ancienneCle(n) {
  const parts = n.split(".");
  if (!/^\d+$/.test(parts[0])) return 9_000_000_000_000_000;
  const comps = parts.slice(0, 5);
  let k = 0;
  for (const p of comps) k = k * 1000 + (/^\d+$/.test(p) ? parseInt(p, 10) : 0);
  for (let i = comps.length; i < 5; i++) k *= 1000;
  return k;
}

test("le mécanisme du défaut : le zéro de tête est perdu, donc deux articles collisionnent", () => {
  // Les quatre paires MESURÉES en production. Si l'une cessait de collisionner, c'est que
  // la clé a changé d'échelle — auquel cas l'invariant 2 est engagé et le correctif de
  // plage doit être relu, pas seulement ce test.
  for (const [a, b] of [
    ["15.01", "15.1"],
    ["15.02", "15.2"],
    ["31.01", "31.1"],
    ["31.02", "31.2"],
  ]) {
    assert.equal(ancienneCle(a), ancienneCle(b), `${a} et ${b} devraient partager une clé`);
  }
  assert.equal(parseInt("01", 10), parseInt("1", 10));
});

test("aucune lecture par composante ne satisfait les deux contraintes du corpus", () => {
  // Contrainte ordinale, observée partout : 199.1 précède 199.10.
  assert.ok(ancienneCle("199.1") < ancienneCle("199.10"));
  // Contrainte fractionnaire, observée dans l'ordre du document de b-1.1-r.2 :
  // 1.022 précède 1.03. L'ancienne règle l'INVERSE — et la lecture fractionnaire qui la
  // réparerait ferait collisionner 199.1 avec 199.10 (rembourrage à droite : 1 -> 100,
  // 10 -> 100). D'où le choix de ne pas toucher à la clé.
  assert.ok(ancienneCle("1.022") > ancienneCle("1.03"), "l'inversion mesurée doit être reproduite");
  const rembourre = (p) => parseInt(p.padEnd(3, "0").slice(0, 3), 10);
  assert.equal(rembourre("1"), rembourre("10"), "la lecture fractionnaire collisionne ailleurs");
});

// ---------------------------------------------------------------------------
// 2. Gardes de source : ce qui ne doit pas être réintroduit.
// ---------------------------------------------------------------------------

test("tout ORDER BY sort_key porte un départage par id", () => {
  const fautifs = [];
  for (const [nom, src] of [
    ["src/lib.ts", LIB],
    ["src/tools.ts", TOOLS],
    ["src/backfill.ts", BACKFILL],
  ]) {
    for (const m of src.matchAll(/ORDER BY sort_key(?!\s*,\s*id)([^\n]*)/g)) {
      fautifs.push(`${nom} : ORDER BY sort_key${m[1]}`);
    }
  }
  // Sans départage, deux articles à clé identique s'ordonnent au hasard : la pagination
  // peut en sauter ou en répéter un, et le rattrapage de vecteurs embarquer deux fois le
  // même article — invisible depuis l'API, qui ne rend qu'un compte.
  assert.deepEqual(fautifs, []);
});

test("la résolution de borne rend l'id, et l'ancien boundKey a disparu", () => {
  assert.ok(LIB.includes("export async function boundRef("), "boundRef doit être exporté");
  assert.ok(!/export async function boundKey\(/.test(LIB), "boundKey ne doit plus exister");
  assert.ok(!/\bboundKey\b/.test(TOOLS), "src/tools.ts ne doit plus appeler boundKey");
  // La borne ne rend un id que pour un article RÉEL : un pseudo-article (préliminaire,
  // annexes) a un id qui ne suit PAS l'ordre du document, et une borne absente n'en a pas.
  assert.match(LIB, /sort_key > 0 && row\.sort_key < DISPOSITION_SORT_BASE/);
});

test("le chemin exact existe et exclut les pseudo-articles de l'intervalle", () => {
  const i = LIB.indexOf("export async function articlesByRange(");
  assert.ok(i > 0, "articlesByRange doit exister");
  const corps = LIB.slice(i, i + 2600);
  assert.ok(corps.includes("ORDER BY id"), "le chemin document doit trier sur id");
  assert.match(corps, /id BETWEEN \? AND \?/);
  // Un pseudo-article dont l'id tombe DANS l'intervalle doit être écarté : mesuré, dans
  // b-1-r.3.1 EN, `préliminaire` porte l'id de l'article 3 plus un.
  assert.match(corps, /sort_key > 0 AND sort_key < \$\{DISPOSITION_SORT_BASE\}/);
});

test("l'étiquette de résolution voyage dans structuredContent, toujours présente", () => {
  // R4, corollaire structuré (décision 001) : une étiquette qui BORNE un résultat est un
  // champ obligatoire de la sortie typée, jamais de la prose seule — `outputSchema` étant
  // absent à dessein, rien n'attraperait sa disparition.
  assert.match(LIB, /resolution: "document" \| "cle"/);
  assert.ok(TOOLS.includes("range_resolution: resolution"), "get_articles doit rendre l'étiquette");
  assert.match(TOOLS, /let resolution: "document" \| "cle" \| null = null/);
});

test("le commentaire d'échelle de schema.sql ne prétend plus à un ordre total", () => {
  const schema = lire("schema.sql");
  const i = schema.indexOf("sort_key      INTEGER NOT NULL");
  assert.ok(i > 0);
  const entete = schema.slice(Math.max(0, i - 1400), i);
  // Le fichier porte déjà l'avertissement d'une TROISIÈME échelle fantôme qui avait fait
  // conclure que les deux côtés du miroir étaient faux. Il doit maintenant dire aussi que
  // la clé n'ordonne pas totalement, sinon le prochain lecteur refera la même déduction.
  assert.match(entete, /pas un ordre total/i);
});
