// Engendre `src/schemas.ts` depuis `fixtures/tools-list.reference.json`.
//
// POURQUOI ENGENDRER PLUTÔT QUE TRANSCRIRE. La marche 2 doit remplacer dix `inputSchema`
// écrits en Zod par leur équivalent JSON Schema. Les transcrire à la main, c'est parier que
// quarante-deux champs passent sans faute — et la faute y est silencieuse : un `required`
// de trop rend un refus dur sur tous les appels nominaux, un `default` inventé ment au
// modèle sans que rien n'échoue.
//
// Or la conversion est DÉJÀ FAITE, et par l'implémentation de référence : le SDK convertit
// Zod en JSON Schema pour publier `tools/list`, et `scripts/capturer-tools-list.mjs` a figé
// exactement ce qu'il publie. Il n'y a donc rien à transcrire — seulement à reprendre.
//
// Quatre questions ouvertes se règlent du même coup, sans arbitrage :
//   · `$schema` en draft-07  → conservé, puisqu'il est publié aujourd'hui ;
//   · `execution`            → conservé pour la même raison ;
//   · `additionalProperties` → reste ABSENT ; l'ajouter à `false` changerait le
//     comportement (Zod écarte les clefs inconnues en silence), ce qui est une décision
//     à prendre séparément, pas un effet de bord de la conversion ;
//   · ordre des clefs        → celui du SDK, reproduit tel quel.
//
//   node scripts/engendrer-schemas.mjs          # écrit src/schemas.ts

import { readFileSync, writeFileSync } from "node:fs";

const RACINE = new URL("..", import.meta.url);
const SOURCE = new URL("fixtures/tools-list.reference.json", RACINE);
const CIBLE = new URL("src/schemas.ts", RACINE);

const outils = JSON.parse(readFileSync(SOURCE, "utf8"));

const ENTETE = `// ⚠ FICHIER ENGENDRÉ — ne pas modifier à la main.
//
// Engendré par \`scripts/engendrer-schemas.mjs\` depuis
// \`fixtures/tools-list.reference.json\`, c'est-à-dire depuis la charge utile que
// \`tools/list\` publie RÉELLEMENT. Ce ne sont donc pas des schémas retranscrits : ce sont
// les schémas servis, repris tels quels — \`$schema\`, ordre des clefs et \`execution\`
// compris.
//
// Pour les régénérer : recapturer la référence (le SDK doit encore être là), puis
// \`node scripts/engendrer-schemas.mjs\`. \`tests/schemas-engendres.test.mjs\` échoue si
// ce fichier et la référence divergent.

import type { JsonSchema } from "@poirierlavoie/socle-juridique/protocole/valide";

/** Ce que \`tools/list\` publie pour un outil, hors gestionnaire. */
export interface DescripteurPublie {
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: Record<string, boolean>;
  execution?: Record<string, string>;
}

`;

const corps = outils
  .map((o) => {
    const cle = o.name.replace(/^legislation_/, "").toUpperCase();
    const publie = {
      title: o.title,
      description: o.description,
      inputSchema: o.inputSchema,
      annotations: o.annotations,
      ...(o.execution ? { execution: o.execution } : {}),
    };
    return `export const ${cle}: DescripteurPublie = ${JSON.stringify(publie, null, 2)};`;
  })
  .join("\n\n");

const table = `

/** Les dix descripteurs, dans l'ordre où \`tools/list\` les rend aujourd'hui. */
export const PUBLIES: Record<string, DescripteurPublie> = {
${outils.map((o) => `  ${o.name}: ${o.name.replace(/^legislation_/, "").toUpperCase()},`).join("\n")}
};
`;

const contenu = ENTETE + corps + table;

writeFileSync(CIBLE, contenu);
console.log(`src/schemas.ts engendré : ${outils.length} descripteurs.`);

// Pas de mode « --verifier » ici : le fichier engendré passe ensuite par Biome, qui le
// reformate, de sorte qu'une comparaison de TEXTE rougirait sur la mise en forme et non
// sur le fond. La garde est donc un test — tests/schemas-engendres.test.mjs — qui compare
// les VALEURS importées à la référence, et que la mise en forme n'atteint pas.
