import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { auditSqlSwitches } from "./helpers/sql-switch-audit.mjs";

const MASQUE_PDF =
  /masqueLawId|masqueAutreBout|clauseCorpus|source\s*<>\s*'pdf'|source\s*=\s*'pdf'/;

test("toute lecture SQL du corpus est masquée pour PDF_CORPUS ou tolérée avec parité 34", () => {
  auditSqlSwitches({ masqueRegex: MASQUE_PDF, label: "PDF_CORPUS" });
});

test("pdfOuvert est fermé par défaut et exige exactement '1'", () => {
  const lib = readFileSync("src/lib.ts", "utf8");
  assert.match(
    lib,
    /export function pdfOuvert\([\s\S]*?return env\.PDF_CORPUS === "1";/,
    'pdfOuvert doit être une égalité stricte à "1"',
  );
});

test("les aides SQL composent PDF_CORPUS dans clauseCorpus, masqueLawId, masqueAutreBout, loadRelevanceData, listLaws et filtreVecteurs", () => {
  const lib = readFileSync("src/lib.ts", "utf8");

  const clauseFn = lib.match(/export function clauseCorpus\([\s\S]*?\n\}/);
  assert.ok(clauseFn, "clauseCorpus introuvable");
  assert.match(clauseFn[0], /!federalOuvert\(env\)[\s\S]*jurisdiction = 'qc'/);
  assert.match(clauseFn[0], /!pdfOuvert\(env\)[\s\S]*source <> 'pdf'/);

  const mLawFn = lib.match(/export function masqueLawId\([\s\S]*?\n\}/);
  assert.ok(mLawFn, "masqueLawId introuvable");
  assert.match(mLawFn[0], /clauseCorpus\(env,\s*""\)/);

  const mAutreFn = lib.match(/export function masqueAutreBout\([\s\S]*?\n\}/);
  assert.ok(mAutreFn, "masqueAutreBout introuvable");
  assert.match(mAutreFn[0], /!pdfOuvert\(env\)/);
  assert.match(mAutreFn[0], /source = 'pdf'/);

  const relFn = lib.match(/export async function loadRelevanceData\([\s\S]*?\n\}/);
  assert.ok(relFn, "loadRelevanceData introuvable");
  assert.match(relFn[0], /masqueAutreBout\(env,\s*"to_law_id"\)/);
  assert.match(relFn[0], /FROM law_relations[\s\S]*?\$\{mTo\}/);

  const listFn = lib.match(/export async function listLaws\([\s\S]*?const clause = /);
  assert.ok(listFn, "corps de listLaws introuvable");
  assert.match(listFn[0], /const masque = clauseCorpus\(env\);/);
  assert.match(
    listFn[0],
    /where\.push\([^)]*masque[^)]*\)|if \(masque\) where\.push\(masque\)/,
    "le masque doit être POUSSÉ dans `where` comme les autres clauses (donc ANDé)",
  );
  assert.match(
    listFn[0],
    /filters\.jurisdiction[\s\S]*where\.push\("l\.jurisdiction = \?"\)/,
    "le filtre de juridiction doit être une clause SUPPLÉMENTAIRE, jamais un remplacement",
  );
  assert.ok(
    listFn[0].indexOf("if (masque)") < listFn[0].indexOf("filters.jurisdiction"),
    "le masque clauseCorpus doit précéder filters.jurisdiction dans listLaws",
  );

  const vecFn = lib.match(/async function filtreVecteurs\([\s\S]*?\n\}/);
  assert.ok(vecFn, "filtreVecteurs introuvable");
  assert.doesNotMatch(
    vecFn[0],
    /if\s*\(\s*!vec\s*\|\|\s*federalOuvert\(/,
    "filtreVecteurs ne doit pas court-circuiter sur le seul federalOuvert(env)",
  );
  assert.match(vecFn[0], /clauseCorpus\(env,\s*""\)/);
  assert.match(vecFn[0], /AND \$\{c\}/);
});

test("wrangler.jsonc ouvre PDF_CORPUS en production et tools/index propagent env", () => {
  const wranglerBrut = readFileSync("wrangler.jsonc", "utf8");
  const wranglerCfg = JSON.parse(
    wranglerBrut
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n"),
  );
  assert.equal(wranglerCfg.vars.PDF_CORPUS, "1");

  const tools = readFileSync("src/tools.ts", "utf8");
  for (const fn of ["getLaw", "listLaws", "listSubjects", "relatedLaws", "loadRelevanceData"]) {
    const appels = [...tools.matchAll(new RegExp(`\\b${fn}\\(([^;]*?)\\)`, "gs"))];
    assert.ok(appels.length > 0, `aucun appel de ${fn} dans src/tools.ts`);
    for (const a of appels) {
      assert.match(a[1], /\benv\b/, `appel de ${fn} sans env`);
    }
  }
  const appelSearch = tools.match(/searchText\([^;]*?\);/s);
  assert.ok(appelSearch, "appel de searchText introuvable");
  assert.match(appelSearch[0], /\benv\b/);

  const index = readFileSync("src/index.ts", "utf8");
  assert.match(index, /renderSite\(env\.DB,\s*env\)/);
});

test("tous les appels à runMatch dans src/lib.ts passent `env`", () => {
  const lib = readFileSync("src/lib.ts", "utf8");
  const appelsMatch = [...lib.matchAll(/\brunMatch\(([^;]*?)\)[,;)\s]/gs)].filter(
    (m) => !m[1].includes("db: D1Database"),
  );
  assert.ok(appelsMatch.length >= 6, `attendu >= 6 appels de runMatch, vu ${appelsMatch.length}`);
  for (const a of appelsMatch) {
    assert.match(
      a[1],
      /\benv\b/,
      `appel de runMatch sans \`env\` : « ${a[0].replace(/\s+/g, " ")} »`,
    );
  }
});
