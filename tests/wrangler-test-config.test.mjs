// Garde de la configuration de test.
//
// `wrangler.test.jsonc` n'est PAS versionné : il est engendré avant chaque exécution
// (script `pretest`) à partir de `wrangler.jsonc`. La dérive est donc impossible par
// construction, et non simplement détectée. Ce que ces tests protègent est ce qui reste :
// que la dérivation sache encore où couper, et qu'elle ne coupe pas plus que prévu.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

import { deriver, RETIREES } from "../scripts/wrangler-test-config.mjs";

const lire = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("la dérivation trouve encore ses deux liaisons dans wrangler.jsonc", () => {
  // `deriver` LÈVE si une liaison retirée n'est plus sur une seule ligne. C'est le cas qui
  // compte : reformater wrangler.jsonc sur plusieurs lignes ferait passer `ai` dans la
  // configuration de test, et la suite réclamerait un jeton Cloudflare.
  assert.doesNotThrow(() => deriver(lire("wrangler.jsonc")));
});

test("les liaisons retirées sont exactement celles sans émulation locale", () => {
  // Si cette liste grossit, c'est une DÉCISION, pas un détail : chaque entrée est une
  // liaison de plus que les tests n'éprouvent pas.
  assert.deepEqual(RETIREES, ["ai", "vectorize"]);
});

test("aucune liaison retirée ne subsiste dans la dérivation", () => {
  const derive = deriver(lire("wrangler.jsonc"));
  for (const cle of RETIREES) {
    assert.ok(
      !new RegExp(`^[ \\t]*"${cle}":`, "m").test(derive),
      `la liaison "${cle}" a survécu : les tests exigeraient un jeton Cloudflare`,
    );
  }
});

test("la dérivation ne retire RIEN d'autre", () => {
  // Une coupe trop large passerait inaperçue : la suite continuerait de verdir sur une
  // configuration amputée. On compte les lignes, faute d'analyseur JSONC ici.
  const source = lire("wrangler.jsonc").split("\n").length;
  const derive = deriver(lire("wrangler.jsonc")).split("\n").length;
  const entete = 4; // les quatre lignes de bandeau engendré
  assert.equal(
    derive,
    source - RETIREES.length + entete,
    "la dérivation a retiré autre chose que les liaisons déclarées",
  );
});
