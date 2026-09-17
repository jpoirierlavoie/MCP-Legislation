// Garde : tout défaut DÉCLARÉ dans un schéma doit être APPLIQUÉ dans son gestionnaire.
//
// POURQUOI CETTE GARDE EXISTE. Le validateur vers lequel on migre (sous-ensemble JSON
// Schema du socle) n'applique JAMAIS `default` : c'est un champ publié dans `tools/list`,
// jamais exécuté. Tant que Zod est là, le défaut arrive quand même et personne ne le voit.
// Le jour où Zod part, l'argument vaut `undefined` — et chaque panne est SILENCIEUSE :
//
//   · `lang` indéfini → `.bind(lawId, undefined, …)` → D1_TYPE_ERROR sur l'outil le plus
//     appelé du connecteur, qui n'a pas de try/catch ;
//   · `direction` indéfini → ne satisfait ni « out » ni « in » → « aucune relation » rendu
//     pour TOUTE loi du corpus ;
//   · `include_text` indéfini → falsy → le texte des articles cesse d'être servi ;
//   · `structure` indéfini → survit par chance, le test étant `=== false`.
//
// Et le schéma publié continue d'annoncer le défaut pendant que l'argument arrive vide :
// `tools/list` reste identique octet pour octet alors que le comportement s'est inversé.
// AUCUNE autre garde de ce dépôt ne voit cela.
//
// Ce test lit le TEXTE SOURCE, et c'est délibéré : il porte sur la PROVENANCE d'une valeur
// (« ce défaut est-il appliqué quelque part ? »), qu'aucun import ne peut observer.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

const SRC = readFileSync(new URL("../src/tools.ts", import.meta.url), "utf8");

/** Découpe la source en un bloc par outil enregistré. */
function blocs() {
  const morceaux = SRC.split("server.registerTool(").slice(1);
  return morceaux.map((m) => {
    const nom = /^\s*"([a-z_]+)"/.exec(m)?.[1] ?? "?";
    return { nom, texte: m };
  });
}

test("les dix outils sont découpés", () => {
  const b = blocs();
  assert.equal(b.length, 10, `${b.length} blocs extraits, 10 attendus`);
  for (const { nom } of b) assert.match(nom, /^legislation_[a-z_]+$/, `nom inattendu : ${nom}`);
});

test("chaque défaut déclaré est relocalisé dans son gestionnaire", () => {
  const manquants = [];

  for (const { nom, texte } of blocs()) {
    // Un défaut par `.default(x)` écrit dans le bloc, plus un par référence à la constante
    // LANG — qui porte `.default("fr")` hors du bloc, et que quatre champs sur dix
    // n'écrivent qu'en une chaîne multi-ligne (`z\n  .enum(...)`), invisible à un grep naïf.
    const directs = [...texte.matchAll(/\.default\(/g)].length;
    const viaLang = /\blang:\s*LANG\b/.test(texte) ? 1 : 0;
    const declares = directs + viaLang;

    // Une relocalisation se reconnaît à son paramètre renommé : `champ: champArg`, puis
    // `champArg ?? valeur`. Le renommage est ce qui rend la garde sûre — sans lui, un
    // `?? "fr"` posé n'importe où plus bas passerait pour une relocalisation.
    const appliques = [...texte.matchAll(/\b(\w+)Arg\s*\?\?/g)].length;

    if (declares !== appliques) {
      manquants.push(`${nom} : ${declares} défaut(s) déclaré(s), ${appliques} appliqué(s)`);
    }
  }

  assert.deepEqual(
    manquants,
    [],
    "Un défaut déclaré mais non appliqué disparaîtra EN SILENCE au retrait de Zod :\n  " +
      manquants.join("\n  "),
  );
});

test("le compte total correspond aux treize défauts réellement publiés", () => {
  // Treize, mesurés sur la charge utile que le SDK publie — cf.
  // fixtures/tools-list.reference.json et scripts/capturer-tools-list.mjs. Ce n'est pas un
  // nombre choisi : c'est le nombre constaté. S'il change, la fixture doit changer avec.
  const total = blocs().reduce(
    (n, { texte }) => n + [...texte.matchAll(/\b\w+Arg\s*\?\?/g)].length,
    0,
  );
  assert.equal(total, 13, `${total} relocalisations, 13 attendues`);
});

test("aucun gestionnaire ne lit encore un champ défauté sans l'avoir relocalisé", () => {
  // Contrôle croisé : si un bloc renomme `lang: langArg` mais oublie la ligne
  // `const lang = langArg ?? …`, le corps référencerait `lang` non déclaré — `tsc` le
  // verrait. En revanche l'inverse passe : relocaliser puis ne pas s'en servir. On épingle
  // donc que chaque renommage a bien son affectation.
  for (const { nom, texte } of blocs()) {
    for (const [, champ] of texte.matchAll(/(\w+):\s*(\w+)Arg\b/g)) {
      assert.ok(
        new RegExp(`const\\s+${champ}\\b`).test(texte),
        `${nom} : « ${champ} » est renommé en ${champ}Arg mais jamais réaffecté`,
      );
    }
  }
});
