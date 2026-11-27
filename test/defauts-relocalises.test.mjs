import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { PUBLIES } from "../src/schemas.ts";

const SRC = readFileSync(new URL("../src/tools.ts", import.meta.url), "utf8");

function blocs() {
  const morceaux = SRC.split(/^ {2}const H_/m).slice(1);
  return morceaux.map((m) => {
    const nom = /^\s*outils\.([a-z_]+)\s*=/m.exec(m)?.[1] ?? "?";
    return { nom, texte: m };
  });
}

test("les dix outils sont découpés", () => {
  const b = blocs();
  assert.equal(b.length, 10, `${b.length} blocs extraits, 10 attendus`);
  for (const { nom } of b) assert.ok(Object.hasOwn(PUBLIES, nom), `nom inattendu : ${nom}`);
});

test("chaque défaut déclaré est relocalisé dans son gestionnaire", () => {
  const manquants = [];

  for (const { nom, texte } of blocs()) {
    const props = PUBLIES[nom]?.inputSchema.properties ?? {};
    const declares = Object.values(props).filter((v) => v.default !== undefined).length;

    const appliques = [...texte.matchAll(/\b(\w+)Arg\s*\?\?/g)].length;

    if (declares !== appliques) {
      manquants.push(`${nom} : ${declares} défaut(s) déclaré(s), ${appliques} appliqué(s)`);
    }
  }

  assert.deepEqual(
    manquants,
    [],
    "Un défaut déclaré dans src/schemas.ts mais non appliqué dans src/tools.ts :\n  " +
      manquants.join("\n  "),
  );
});

test("le compte total correspond aux treize défauts réellement publiés", () => {
  const total = blocs().reduce(
    (n, { texte }) => n + [...texte.matchAll(/\b\w+Arg\s*\?\?/g)].length,
    0,
  );
  assert.equal(total, 13, `${total} relocalisations, 13 attendues`);
});

test("aucun gestionnaire ne lit encore un champ défauté sans l'avoir relocalisé", () => {
  for (const { nom, texte } of blocs()) {
    for (const [, champ] of texte.matchAll(/(\w+):\s*(\w+)Arg\b/g)) {
      assert.ok(
        new RegExp(`const\\s+${champ}\\b`).test(texte),
        `${nom} : « ${champ} » est renommé en ${champ}Arg mais jamais réaffecté`,
      );
    }
  }
});
