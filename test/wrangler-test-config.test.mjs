import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

import { deriver, RETIREES } from "../scripts/wrangler-test-config.mjs";

const lire = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("la dérivation trouve encore ses deux liaisons dans wrangler.jsonc", () => {
  assert.doesNotThrow(() => deriver(lire("wrangler.jsonc")));
});

test("les liaisons retirées sont exactement celles sans émulation locale", () => {
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
  const source = lire("wrangler.jsonc").split("\n").length;
  const derive = deriver(lire("wrangler.jsonc")).split("\n").length;
  const entete = 4;
  assert.equal(
    derive,
    source - RETIREES.length + entete,
    "la dérivation a retiré autre chose que les liaisons déclarées",
  );
});
