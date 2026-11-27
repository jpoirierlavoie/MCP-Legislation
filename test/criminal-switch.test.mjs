import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { auditSqlSwitches } from "./helpers/sql-switch-audit.mjs";

const MASQUE_CRIMINAL =
  /masqueLawId|masqueAutreBout|clauseCorpus|domain\s*(?:<>|!=)\s*'penal'|domain\s*=\s*'penal'/;

test("toute lecture SQL du corpus est masquée pour CRIMINAL_CORPUS ou tolérée avec parité 34", () => {
  auditSqlSwitches({ masqueRegex: MASQUE_CRIMINAL, label: "CRIMINAL_CORPUS" });
});

test("criminalOuvert est fermé par défaut et exige exactement '1'", () => {
  const lib = readFileSync("src/lib.ts", "utf8");
  assert.match(
    lib,
    /export function criminalOuvert\([\s\S]*?return env\.CRIMINAL_CORPUS === "1";/,
    'criminalOuvert doit être une égalité stricte à "1"',
  );
});

test("les aides SQL composent CRIMINAL_CORPUS dans clauseCorpus, masqueLawId, masqueAutreBout, loadRelevanceData, listLaws et filtreVecteurs", () => {
  const lib = readFileSync("src/lib.ts", "utf8");

  const clauseFn = lib.match(/export function clauseCorpus\([\s\S]*?\n\}/);
  assert.ok(clauseFn, "clauseCorpus introuvable");
  assert.match(
    clauseFn[0],
    /!criminalOuvert\(env\)[\s\S]*jurisdiction = 'ca' AND \$\{p\}domain = 'penal'/,
  );

  const mLawFn = lib.match(/export function masqueLawId\([\s\S]*?\n\}/);
  assert.ok(mLawFn, "masqueLawId introuvable");
  assert.match(mLawFn[0], /clauseCorpus\(env,\s*""\)/);

  const mAutreFn = lib.match(/export function masqueAutreBout\([\s\S]*?\n\}/);
  assert.ok(mAutreFn, "masqueAutreBout introuvable");
  assert.match(mAutreFn[0], /!criminalOuvert\(env\)/);
  assert.match(mAutreFn[0], /\(jurisdiction = 'ca' AND domain = 'penal'\)/);

  const relFn = lib.match(/export async function loadRelevanceData\([\s\S]*?\n\}/);
  assert.ok(relFn, "loadRelevanceData introuvable");
  assert.match(relFn[0], /masqueAutreBout\(env,\s*"to_law_id"\)/);

  const listFn = lib.match(/export async function listLaws\([\s\S]*?const clause = /);
  assert.ok(listFn, "corps de listLaws introuvable");
  assert.match(listFn[0], /const masque = clauseCorpus\(env\);/);
  assert.ok(
    listFn[0].indexOf("if (masque)") < listFn[0].indexOf("filters.jurisdiction"),
    "le masque clauseCorpus doit précéder filters.jurisdiction dans listLaws",
  );

  const vecFn = lib.match(/async function filtreVecteurs\([\s\S]*?\n\}/);
  assert.ok(vecFn, "filtreVecteurs introuvable");
  assert.match(vecFn[0], /clauseCorpus\(env,\s*""\)/);
});
