import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

const lire = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const PATHS_TS = lire("src/paths.ts");
const PATHS_PY = lire("pipeline/paths.py");
const LIB = lire("src/lib.ts");
const BACKFILL = lire("src/backfill.ts");

function segSplitDeLaSource() {
  const m = PATHS_TS.match(/export const SEG_SPLIT = \/([^\n]+?)\/;/);
  assert.ok(m, "SEG_SPLIT doit être un littéral de regex exporté sur une seule ligne");
  return { source: m[1], re: new RegExp(m[1]) };
}

const segments = (p) => p.split(segSplitDeLaSource().re);

test("décompte de segments : les deux familles, et les valeurs à trait d'union", () => {
  const attendu = [
    ["fh1:3", 1],
    ["fh1:3-fh2:5", 2],
    ["fh1:3-fh2:5-fh3:1", 3],
    ["fh1:3-fh2:5-fh3:1-fh4:2", 4],
    ["fs:2", 1],
    ["fs:2-fh1:1", 2],
    ["fs:12-fh1:3-fh2:1", 3],
    ["ga:l_cinquieme", 1],
    ["ga:l_cinquieme-gb:l_premier", 2],
    ["ga:l_cinquieme-gb:l_premier-gc:l_troisieme-gd:l_i-ge:l_1", 5],
    ["gc:l_dix-septieme", 1],
    ["ga:l_x-gc:l_dix-septieme", 2],
    ["ga:l_ii__2", 1],
    ["ga:l_ii__2-gb:l_i", 2],
    ["disposition-preliminaire", 1],
    ["annexe-a", 1],
    ["repeal-schedules", 1],
    ["annexe-abrogative", 1],
  ];
  for (const [chemin, n] of attendu) {
    assert.equal(segments(chemin).length, n, `${chemin} devrait compter ${n} segment(s)`);
  }
});

test("la troncature rend un PRÉFIXE qui est lui-même un chemin valide", () => {
  const tronque = (p, d) => segments(p).slice(0, d).join("-");
  assert.equal(tronque("fh1:3-fh2:5", 1), "fh1:3");
  assert.equal(tronque("fh1:3-fh2:5-fh3:1", 2), "fh1:3-fh2:5");
  assert.equal(tronque("fs:2-fh1:1", 1), "fs:2");
  assert.equal(tronque("ga:l_x-gc:l_dix-septieme", 1), "ga:l_x");
  assert.equal(tronque("ga:l_ii__2-gb:l_i", 1), "ga:l_ii__2");
  assert.equal(tronque("annexe-a", 1), "annexe-a");
  assert.equal(tronque("repeal-schedules", 1), "repeal-schedules");
  assert.equal(tronque("gc:l_dix-septieme", 1), "gc:l_dix-septieme");
});

test("l'intervalle [p+'-', p+'.') ne capte pas un frère au préfixe commun", () => {
  const dansSousArbre = (p, c) => c === p || (c >= `${p}-` && c < `${p}.`);
  const cas = [
    ["fh1:3", "fh1:3", true],
    ["fh1:3", "fh1:3-fh2:1", true],
    ["fh1:3", "fh1:30", false],
    ["fh1:3", "fh1:30-fh2:1", false],
    ["fs:1", "fs:1-fh1:1", true],
    ["fs:1", "fs:10", false],
    ["fs:1", "fs:12-fh1:3", false],
    ["ga:l_x", "ga:l_x-gb:l_i", true],
    ["ga:l_x", "ga:l_xi", false],
    ["annexe-a", "annexe-a", true],
    ["annexe-a", "annexe-abrogative", false],
    ["ga:l_ii", "ga:l_ii-gb:l_i", true],
    ["ga:l_ii", "ga:l_ii__2", false],
    ["ga:l_ii", "ga:l_ii__2-gb:l_i", false],
    ["ga:l_ii__2", "ga:l_ii__2", true],
    ["ga:l_ii__2", "ga:l_ii__2-gb:l_i", true],
    ["ga:l_ii__2", "ga:l_ii-gb:l_i", false],
  ];
  for (const [p, c, attendu] of cas) {
    assert.equal(
      dansSousArbre(p, c),
      attendu,
      `${c} ${attendu ? "devrait" : "ne devrait pas"} être dans le sous-arbre de ${p}`,
    );
  }
  assert.ok("-".charCodeAt(0) < ".".charCodeAt(0), "0x2D doit précéder 0x2E");
  assert.ok(".".charCodeAt(0) < "0".charCodeAt(0), "0x2E doit précéder les chiffres");
});

test("SEG_SPLIT est identique en TypeScript et en Python", () => {
  const { source } = segSplitDeLaSource();
  const m = PATHS_PY.match(/SEG_SPLIT = re\.compile\(r"([^"]+)"\)/);
  assert.ok(m, "pipeline/paths.py doit exposer SEG_SPLIT en littéral brut");
  assert.equal(m[1], source, "les deux littéraux doivent être identiques CARACTÈRE POUR CARACTÈRE");
});

test("les deux familles sont reconnues par la regex, et rien d'autre", () => {
  const { re } = segSplitDeLaSource();
  assert.equal("xx:1-yy:2".split(re).length, 1, "un préfixe inconnu ne coupe pas");
  assert.equal("fh1:3-zz:4".split(re).length, 1);
});

const sansCommentaires = (s) =>
  s
    .split("\n")
    .filter((l) => {
      const q = l.trim();
      return !q.startsWith("//") && !q.startsWith("*") && !q.startsWith("/*");
    })
    .join("\n");

test("aucun découpeur borné à la seule famille Irosoft ne subsiste dans le CODE", () => {
  const fautifs = [];
  for (const [nom, src] of [
    ["src/lib.ts", LIB],
    ["src/backfill.ts", BACKFILL],
  ]) {
    for (const m of sansCommentaires(src).matchAll(/\/-\(\?=g\[a-z\]:\)\//g)) {
      fautifs.push(`${nom} : ${m[0]}`);
    }
  }
  assert.deepEqual(
    fautifs,
    [],
    "un découpeur borné à g[a-z]: voit un chemin fédéral comme UN segment, sans erreur",
  );
});

test("aucun split('-') sur un chemin ne subsiste", () => {
  const fautifs = [];
  for (const [nom, src] of [
    ["src/lib.ts", LIB],
    ["src/backfill.ts", BACKFILL],
  ]) {
    for (const m of src.matchAll(/\w*(?:path|Path)\w*\.split\("-"\)/g))
      fautifs.push(`${nom} : ${m[0]}`);
  }
  assert.deepEqual(
    fautifs,
    [],
    "découper un chemin sur CHAQUE tiret casse gc:l_dix-septieme et annexe-a",
  );
});

test("src/lib.ts et src/backfill.ts importent le module de chemins", () => {
  assert.match(LIB, /from "\.\/paths"/, "src/lib.ts doit importer ./paths");
  assert.ok(
    /from "\.\/paths"/.test(BACKFILL) || /breadcrumbChains/.test(BACKFILL),
    "src/backfill.ts doit passer par le découpeur unifié, directement ou via lib",
  );
});

test("src/paths.ts est un module PUR : aucun import", () => {
  const imports = [...PATHS_TS.matchAll(/^\s*import\s/gm)];
  assert.deepEqual(
    imports.map((m) => m[0].trim()),
    [],
  );
});

test("translateDivisionPath court-circuite EXPLICITEMENT sur un chemin fédéral", () => {
  const i = LIB.indexOf("export async function translateDivisionPath");
  assert.ok(i > 0, "translateDivisionPath doit exister");
  const corps = LIB.slice(i, i + 1800);
  assert.match(
    corps,
    /isFederalPath/,
    "le court-circuit doit être explicite, pas espéré d'une segmentation juste",
  );
  assert.ok(
    PATHS_TS.includes("export function isFederalPath"),
    "isFederalPath doit être exporté par src/paths.ts",
  );
});

test("isFederalPath reconnaît les préfixes LIMS et refuse les Irosoft", () => {
  const fed = PATHS_TS.match(/const FEDERAL = \/(.+?)\/;/);
  assert.ok(fed, "src/paths.ts doit définir FEDERAL en littéral de regex");
  assert.match(
    PATHS_TS,
    /return FEDERAL\.test\(path\);/,
    "isFederalPath doit s'appuyer sur FEDERAL",
  );
  const r = new RegExp(fed[1]);
  for (const p of ["fh1:3", "fh1:3-fh2:5", "fs:2", "fs:2-fh1:1", "fp:0"]) {
    assert.ok(r.test(p), `${p} est un chemin fédéral`);
  }
  for (const p of ["ga:l_cinquieme", "gc:l_dix-septieme", "annexe-a", "disposition-preliminaire"]) {
    assert.ok(!r.test(p), `${p} n'est PAS un chemin fédéral`);
  }
});
