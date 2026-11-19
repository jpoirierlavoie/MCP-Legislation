import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { DISPOSITION_SORT_BASE, sortKeyOf } from "../src/lib.ts";
import { PUBLIES } from "../src/schemas.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const lire = (p) => readFileSync(join(ROOT, p), "utf8");
const json = (p) => JSON.parse(lire(p));

// =============================================================================
// F9 Non-Duplicative Switch Check (Full SQL Audit Owned by tests/pdf-switch.test.mjs)
// =============================================================================

test("F9-S1: tests/pdf-switch.test.mjs existe et pdfOuvert(env) exige strictement env.PDF_CORPUS === '1'", () => {
  assert.ok(
    existsSync(join(ROOT, "tests", "pdf-switch.test.mjs")),
    "tests/pdf-switch.test.mjs doit exister comme source de vérité du garde PDF_CORPUS",
  );
  const lib = lire("src/lib.ts");
  const fnMatch = lib.match(/export function pdfOuvert\([\s\S]*?\n\}/);
  assert.ok(fnMatch, "export function pdfOuvert introuvable dans src/lib.ts");
  assert.match(
    fnMatch[0],
    /return env\.PDF_CORPUS === "1";/,
    'pdfOuvert(env) doit retourner strictement env.PDF_CORPUS === "1"',
  );
});

// =============================================================================
// Manifest, Schema & Provenance Contracts (F1, F4, F9)
// =============================================================================

test("F1-M1: migrations/0007_pdf_corpus.sql existe, reste additif sans reconstruire articles_fts", () => {
  const migPath = join(ROOT, "migrations", "0007_pdf_corpus.sql");
  assert.ok(existsSync(migPath), "migrations/0007_pdf_corpus.sql doit exister");
  const sql = readFileSync(migPath, "utf8");
  assert.match(sql, /ALTER TABLE laws ADD COLUMN source TEXT NOT NULL DEFAULT 'epub'/i);
  assert.match(sql, /ALTER TABLE articles ADD COLUMN links TEXT/i);
  assert.doesNotMatch(sql, /DROP TABLE.*articles_fts/i);
});

test("F9-M2: laws.config.json préserve l'ordre initial (invariant 1) et ajoute les entrées source='pdf' en queue", () => {
  const cfg = json("laws.config.json");
  const served = json("pipeline/expected/served.json");
  assert.ok(Array.isArray(cfg.laws) && cfg.laws.length >= 97);
  assert.ok(Array.isArray(served.ids) && served.ids.length >= 97);
  const initial97 = served.ids.slice(0, 97);
  assert.deepEqual(
    cfg.laws.slice(0, 97).map((l) => l.id),
    initial97,
    "Invariant 1 : les 97 lois initiales doivent rester en tête dans le même ordre exact",
  );

  const pdfEntries = cfg.laws.filter((l) => l.source === "pdf");
  assert.ok(
    pdfEntries.length > 0,
    "laws.config.json doit contenir au moins une entrée source='pdf' (attendu en M3)",
  );
  for (const [idx, l] of cfg.laws.entries()) {
    if (l.source === "pdf") {
      assert.ok(
        idx >= 97,
        `Invariant 1 : l'entrée PDF ${l.id} à l'index ${idx} doit être ajoutée après les 97 initiales`,
      );
      assert.ok(
        l.fonction === "directive" || l.fonction === "orientation" || l.fonction === "reglement",
        `fonction invalide pour ${l.id}: ${l.fonction}`,
      );
      assert.ok(l.consolidation_source?.fr, `consolidation_source.fr requis pour ${l.id}`);
    }
  }
});

test("F4-M3: relations.json et catalogue.json conservent la parité contractuelle et les arêtes PDF", () => {
  const rel = json("relations.json");
  assert.ok(Array.isArray(rel.relations));
  for (const r of rel.relations) {
    assert.ok(r.from && r.to && r.rel_type && r.note);
  }
  assert.ok(
    rel.relations.some((r) => r.rel_type === "preseance-sur"),
    "relations.json doit contenir au moins une arête 'preseance-sur' (attendu en M3)",
  );
  assert.ok(
    rel.relations.some((r) => r.rel_type === "interprete"),
    "relations.json doit contenir au moins une arête 'interprete' (attendu en M3)",
  );
  const cat = json("catalogue.json");
  assert.deepEqual(Object.keys(cat.tools).sort(), Object.keys(PUBLIES).sort());
  const served = json("pipeline/expected/served.json");
  assert.ok(Array.isArray(served.ids) && served.ids.length >= 97);
});

// =============================================================================
// Python <-> TypeScript Mirror Parity (F7: sort_key & SEG_SPLIT)
// =============================================================================

test("F7-P1: SEG_SPLIT identique entre src/paths.ts et pipeline/paths.py et inclut ph\\d+: et ps:", () => {
  const pathsTs = lire("src/paths.ts");
  const pathsPy = lire("pipeline/paths.py");
  const mTs = pathsTs.match(/export const SEG_SPLIT = \/([^\n]+?)\/;/);
  const mPy = pathsPy.match(/SEG_SPLIT = re\.compile\(r"([^"]+)"\)/);
  assert.ok(mTs && mPy, "SEG_SPLIT doit exister dans src/paths.ts et pipeline/paths.py");
  assert.equal(
    mPy[1],
    mTs[1],
    "SEG_SPLIT TS et Python doivent être identiques caractère pour caractère",
  );

  const re = new RegExp(mTs[1]);
  assert.deepEqual("ph1:1-ph2:1-ph3:1".split(re), ["ph1:1", "ph2:1", "ph3:1"]);
  assert.deepEqual("ps:1-ph1:1".split(re), ["ps:1", "ph1:1"]);
  assert.deepEqual("annexe-a".split(re), ["annexe-a"]);
});

function resolvePythonExe() {
  for (const candidate of [
    join(ROOT, ".venv", "Scripts", "python.exe"),
    join(ROOT, ".venv", "bin", "python"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  for (const cmd of ["python3", "python"]) {
    try {
      execFileSync(cmd, ["--version"], { stdio: "ignore" });
      return cmd;
    } catch {
      // ignore missing executable
    }
  }
  return null;
}

test("F7-P2: pipeline/model.py::sort_key() et src/lib.ts::sortKeyOf() sont un miroir exact pour les numéros alphanumériques", () => {
  const pyExe = resolvePythonExe();
  assert.ok(
    pyExe,
    "Python (.venv ou python3/python dans PATH) requis pour vérifier le miroir sort_key <-> sortKeyOf",
  );

  const samples = [
    "préliminaire",
    "preambule",
    "preamble",
    "note-preliminaire",
    "1",
    "1.1",
    "1.1.1",
    "1.1.1A",
    "1.2",
    "2.1",
    "2A",
    "2A.1",
    "4B.2",
    "10.1",
    "15.01",
    "15.1",
    "132.0.1",
    "annexe-1",
    "annexe-a",
  ];
  const pyOut = execFileSync(
    pyExe,
    [
      "-c",
      `import json, sys; sys.path.insert(0, 'pipeline'); from model import sort_key; print(json.dumps({s: sort_key(s) for s in json.loads(sys.argv[1])}))`,
      JSON.stringify(samples),
    ],
    { cwd: ROOT, env: { ...process.env, PYTHONUTF8: "1" }, encoding: "utf8" },
  );
  const pyKeys = JSON.parse(pyOut);
  for (const s of samples) {
    assert.equal(
      sortKeyOf(s),
      pyKeys[s],
      `Divergence sortKeyOf(${s})=${sortKeyOf(s)} vs Python sort_key(${s})=${pyKeys[s]}`,
    );
  }
  assert.ok(sortKeyOf("1.1") < sortKeyOf("1.1.1"), "1.1 doit précéder 1.1.1");
  assert.ok(sortKeyOf("1.1.1") < sortKeyOf("1.1.1A"), "1.1.1 doit précéder 1.1.1A");
  assert.ok(sortKeyOf("1.1.1A") < sortKeyOf("1.2"), "1.1.1A doit précéder 1.2");
  assert.ok(sortKeyOf("1.2") < sortKeyOf("2.1"), "1.2 doit précéder 2.1");
  assert.ok(sortKeyOf("2.1") < sortKeyOf("2A"), "2.1 doit précéder 2A");
  assert.ok(sortKeyOf("2A") < sortKeyOf("2A.1"), "2A doit précéder 2A.1");
  assert.ok(sortKeyOf("2A.1") < sortKeyOf("4B.2"), "2A.1 doit précéder 4B.2");
  assert.ok(sortKeyOf("4B.2") < sortKeyOf("10.1"), "4B.2 doit précéder 10.1");
  assert.ok(sortKeyOf("10.1") < DISPOSITION_SORT_BASE, "10.1 doit être < DISPOSITION_SORT_BASE");
  assert.ok(
    sortKeyOf("annexe-1") >= DISPOSITION_SORT_BASE,
    "annexe-1 doit être >= DISPOSITION_SORT_BASE",
  );
});
