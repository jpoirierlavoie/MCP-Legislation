// Garde de PROVENANCE sur les textes de mise en garde.
//
// Ce que ce test protège n'est pas la forme du registre — `declarerRegistre` s'en charge —
// mais le fait que ses textes soient PROMUS et non RÉDIGÉS. Chaque réserve reprend une
// formulation que le praticien avait déjà écrite, dans `src/tools.ts` ou dans
// `catalogue.json`. En rédiger une neuve ici serait une décision éditoriale sur du contenu
// juridique, donc hors de portée (invariant 16 : proposer, jamais modifier seul).
//
// Le test lit le TEXTE SOURCE, comme les autres gardes de provenance : aucun import ne peut
// dire d'où vient une chaîne.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const RACINE = join(dirname(fileURLToPath(import.meta.url)), "..");
const lire = (p) => readFileSync(join(RACINE, p), "utf8");

const gardesTs = lire("src/gardes.ts");
const toolsTs = lire("src/tools.ts");
const catalogue = JSON.parse(lire("catalogue.json"));

/** Normalise pour comparer des chaînes découpées différemment dans la source. */
const plat = (s) => s.replace(/\s+/g, " ").trim();

test("REPERAGE_HEURISTIQUE reprend GARDE_FOU mot pour mot", () => {
  // GARDE_FOU est imposé « mot pour mot » par le plan, et CLAUDE.md interdit de le
  // reformuler. Si la garde s'en écarte, c'est la garde qui a tort.
  const gardeFou = plat((/const GARDE_FOU =\s*([\s\S]*?);\n/.exec(toolsTs) ?? [])[1] ?? "")
    .replace(/"\s*\+\s*"/g, "")
    .replace(/^"|"$/g, "");
  assert.ok(gardeFou.length > 50, "GARDE_FOU introuvable dans src/tools.ts");
  assert.ok(
    plat(gardesTs).includes(gardeFou.slice(0, 60)),
    "REPERAGE_HEURISTIQUE ne reprend plus le texte de GARDE_FOU",
  );
});

test("TEXTE_A_VERIFIER reprend les réserves du catalogue", () => {
  // Trois éléments substantiels du paragraphe officiel doivent survivre à la promotion.
  const g = plat(gardesTs);
  for (const attendu of [
    "Éditeur officiel du Québec",
    "art. 31",
    "n'est PAS une version officielle",
  ]) {
    assert.ok(g.includes(attendu), `TEXTE_A_VERIFIER a perdu « ${attendu} »`);
  }
  // Et la source doit toujours le dire, sinon c'est le catalogue qui a dérivé.
  const corps = plat((catalogue.avertissement.corps_fr ?? []).join(" "));
  assert.ok(corps.includes("Éditeur officiel du Québec"), "le catalogue ne le dit plus");
  assert.ok(corps.includes("art. 31"), "le catalogue ne cite plus l'art. 31");
});

test("chaque code apparaît une fois comme clef et une fois comme valeur", () => {
  const clefs = [...gardesTs.matchAll(/^ {2}([A-Z_]+): \{$/gm)].map((m) => m[1]);
  assert.equal(clefs.length, 5, `${clefs.length} gardes déclarées, 5 attendues`);
  for (const c of clefs) {
    assert.ok(gardesTs.includes(`code: "${c}"`), `la garde « ${c} » ne porte pas son propre code`);
  }
});

test("aucune sévérité hors des trois admises", () => {
  const sev = [...gardesTs.matchAll(/severite: "([a-z]+)"/g)].map((m) => m[1]);
  assert.equal(sev.length, 5);
  for (const s of sev) {
    assert.ok(["information", "reserve", "avertissement"].includes(s), `sévérité inconnue : ${s}`);
  }
});

test("LANGUE_DISCORDANTE ne parle PAS de l'article 490", () => {
  // L'affaire 490 C.p.c. était un échec de REPÉRAGE, réglé et épinglé par une éval. La
  // rouvrir sous un code de langue confondrait deux défauts distincts.
  const bloc = (/LANGUE_DISCORDANTE: \{([\s\S]*?)\n {2}\},/.exec(gardesTs) ?? [])[1] ?? "";
  assert.ok(!/\b490\b/.test(bloc), "LANGUE_DISCORDANTE mentionne l'article 490");
});
