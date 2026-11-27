import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { auditSqlSwitches, TOLERES_COMMUNS } from "./helpers/sql-switch-audit.mjs";

const MASQUE =
  /masqueLawId|masqueAutreBout|clauseCorpus|clauseJuridiction|jurisdiction\s*=\s*'qc'|jurisdiction\s*<>\s*'qc'/;

test("toute lecture SQL du corpus est masquée, ou tolérée avec un motif écrit", () => {
  auditSqlSwitches({ masqueRegex: MASQUE, label: "FEDERAL_CORPUS" });
});

test("chaque motif de tolérance nomme sa famille, et n'est pas un laissez-passer", () => {
  for (const [k, v] of TOLERES_COMMUNS) {
    assert.ok(v.length >= 60, `motif trop court pour ${k}`);
    assert.match(
      v,
      /gardée en amont|jointe en mémoire|dérivée d'un jeu masqué|hors surface servie/,
      `le motif de ${k} doit nommer sa famille (cf. l'en-tête de TOLERES)`,
    );
  }
});

test("les outils MCP transmettent `env` aux lectures masquables", () => {
  const src = readFileSync("src/tools.ts", "utf8");
  for (const fn of ["getLaw", "listLaws", "listSubjects", "relatedLaws", "loadRelevanceData"]) {
    const appels = [...src.matchAll(new RegExp(`\\b${fn}\\(([^;]*?)\\)`, "gs"))];
    assert.ok(appels.length > 0, `aucun appel de ${fn} trouvé dans src/tools.ts`);
    for (const a of appels) {
      assert.match(
        a[1],
        /\benv\b/,
        `appel de ${fn} sans \`env\` dans src/tools.ts : « ${a[0].replace(/\s+/g, " ")} »`,
      );
    }
  }
});

test("searchText transmet `env`, et le canal vectoriel est filtré aux DEUX barreaux", () => {
  const tools = readFileSync("src/tools.ts", "utf8");
  const lib = readFileSync("src/lib.ts", "utf8");

  const appel = tools.match(/searchText\([^;]*?\);/s);
  assert.ok(appel, "appel de searchText introuvable dans src/tools.ts");
  assert.match(appel[0], /\benv\b/, "searchText appelé sans `env` : la recherche fuirait");

  assert.equal(
    [...lib.matchAll(/filtreVecteurs\(/g)].length,
    3,
    "attendu : 1 définition + 2 appels (barreau cible et barreau élargi) de filtreVecteurs",
  );
  assert.match(
    lib,
    /vecWideCache\s*=\s*lawId && qVec\s*\n?\s*\?\s*await filtreVecteurs\(/,
    "le barreau ÉLARGI doit filtrer : sans lawId, il interroge TOUT l'index Vectorize",
  );

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

test("le futur paramètre `jurisdiction` ne peut pas ÉCRASER le masque", () => {
  const lib = readFileSync("src/lib.ts", "utf8");
  const bloc = lib.match(/export async function listLaws\([\s\S]*?const clause = /);
  assert.ok(bloc, "corps de listLaws introuvable");
  assert.match(
    bloc[0],
    /where\.push\([^)]*masque[^)]*\)|if \(masque\) where\.push\(masque\)/,
    "le masque doit être POUSSÉ dans `where` comme les autres clauses (donc ANDé)",
  );
  assert.match(
    bloc[0],
    /filters\.jurisdiction[\s\S]*where\.push\("l\.jurisdiction = \?"\)/,
    "le filtre de juridiction doit être une clause SUPPLÉMENTAIRE, jamais un remplacement",
  );
  assert.ok(
    bloc[0].indexOf("if (masque)") < bloc[0].indexOf("filters.jurisdiction"),
    "le masque est posé AVANT le filtre : un lecteur doit voir qu'il n'est pas conditionnel",
  );
});

test("la page publique reçoit `env` — ses décomptes sont des faits vivants (R10)", () => {
  const index = readFileSync("src/index.ts", "utf8");
  assert.match(
    index,
    /renderSite\(env\.DB,\s*env\)/,
    "renderSite doit recevoir `env` : sans lui, la page annonçait 79 lois ET 49 277 articles, " +
      "dont 22 d'un texte qu'elle ne liste pas — et sous-déclarerait 79 sur 97 au premier flip",
  );
});

test("l'interrupteur est FERMÉ par défaut, et sur une valeur exacte", () => {
  const lib = readFileSync("src/lib.ts", "utf8");
  assert.match(
    lib,
    /return env\.FEDERAL_CORPUS === "1";/,
    'federalOuvert doit être une égalité stricte à "1" (donc fermé par défaut)',
  );
});
