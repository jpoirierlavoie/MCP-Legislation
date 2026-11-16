// Engendre `src/schemas.ts` depuis `fixtures/tools-list.reference.json`.
//
// POURQUOI ENGENDRER PLUTÔT QUE TRANSCRIRE. Le routeur du socle publie dix `inputSchema`
// au format JSON Schema. Les transcrire à la main ferait courir un risque de dérive
// silencieuse : un `required` de trop rend un refus dur sur tous les appels nominaux,
// un `default` inventé ment au modèle sans que rien n'échoue.
//
// `fixtures/tools-list.reference.json` fige exactement le contrat publié historiquement :
//   · `$schema` en draft-07  → conservé, puisqu'il est publié aujourd'hui ;
//   · `execution`            → conservé pour la même raison ;
//   · `additionalProperties` → verrouillé à `false` sur tous les schémas pour
//     rejeter les arguments surnuméraires inconnus (décision Milestone M1) ;
//   · ordre des clefs        → reproduit tel quel.
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
// \`fixtures/tools-list.reference.json\` et \`catalogue.json\` (source unique des titres).
// Ce sont les schémas servis par \`tools/list\`, repris tels quels — \`$schema\`,
// ordre des clefs et \`execution\` compris.
//
// Pour les régénérer : \`node scripts/engendrer-schemas.mjs\`.
// \`test/schemas-engendres.test.ts\` échoue si ce fichier et la référence divergent.

import type { JsonSchema } from "@poirierlavoie/mcp-socle/protocole/valide";
import catalogue from "../catalogue.json";

const titre = (nom: keyof typeof catalogue.tools): string => catalogue.tools[nom].title_fr;

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
    const cle = o.name.toUpperCase();
    const publie = {
      title: `__TITRE_${cle}__`,
      description: o.description,
      inputSchema: o.inputSchema,
      annotations: o.annotations,
      ...(o.execution ? { execution: o.execution } : {}),
    };
    const json = JSON.stringify(publie, null, 2).replace(
      `"__TITRE_${cle}__"`,
      `titre("${o.name}")`,
    );
    return `export const ${cle}: DescripteurPublie = ${json};`;
  })
  .join("\n\n");

const table = `

/** Les dix descripteurs, dans l'ordre où \`tools/list\` les rend aujourd'hui. */
export const PUBLIES: Record<string, DescripteurPublie> = {
${outils.map((o) => `  ${o.name}: ${o.name.toUpperCase()},`).join("\n")}
};
`;

const contenu = ENTETE + corps + table;

writeFileSync(CIBLE, contenu);
console.log(`src/schemas.ts engendré : ${outils.length} descripteurs.`);

// Pas de mode « --verifier » ici : le fichier engendré passe ensuite par Biome, qui le
// reformate, de sorte qu'une comparaison de TEXTE rougirait sur la mise en forme et non
// sur le fond. La garde est donc un test — tests/schemas-engendres.test.mjs — qui compare
// les VALEURS importées à la référence, et que la mise en forme n'atteint pas.
