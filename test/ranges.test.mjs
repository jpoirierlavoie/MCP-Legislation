import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

const lire = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const LIB = lire("src/lib.ts");
const TOOLS = lire("src/tools.ts");
const BACKFILL = lire("src/backfill.ts");

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
  assert.ok(ancienneCle("199.1") < ancienneCle("199.10"));
  assert.ok(ancienneCle("1.022") > ancienneCle("1.03"), "l'inversion mesurée doit être reproduite");
  const rembourre = (p) => parseInt(p.padEnd(3, "0").slice(0, 3), 10);
  assert.equal(rembourre("1"), rembourre("10"), "la lecture fractionnaire collisionne ailleurs");
});

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
  assert.deepEqual(fautifs, []);
});

test("la résolution de borne rend l'id, et l'ancien boundKey a disparu", () => {
  assert.ok(LIB.includes("export async function boundRef("), "boundRef doit être exporté");
  assert.ok(!/export async function boundKey\(/.test(LIB), "boundKey ne doit plus exister");
  assert.ok(!/\bboundKey\b/.test(TOOLS), "src/tools.ts ne doit plus appeler boundKey");
  assert.match(LIB, /sort_key > 0 && row\.sort_key < DISPOSITION_SORT_BASE/);
});

test("le chemin exact existe et exclut les pseudo-articles de l'intervalle", () => {
  const i = LIB.indexOf("export async function articlesByRange(");
  assert.ok(i > 0, "articlesByRange doit exister");
  const corps = LIB.slice(i, i + 2600);
  assert.ok(corps.includes("ORDER BY id"), "le chemin document doit trier sur id");
  assert.match(corps, /id BETWEEN \? AND \?/);
  assert.match(corps, /sort_key > 0 AND sort_key < \$\{DISPOSITION_SORT_BASE\}/);
});

test("l'étiquette de résolution voyage dans structuredContent, toujours présente", () => {
  assert.match(LIB, /resolution: "document" \| "cle"/);
  assert.ok(TOOLS.includes("range_resolution: resolution"), "get_articles doit rendre l'étiquette");
  assert.match(TOOLS, /let resolution: "document" \| "cle" \| null = null/);
});
