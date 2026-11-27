import { readFileSync, writeFileSync } from "node:fs";

const RACINE = new URL("..", import.meta.url);
const SOURCE = new URL("data/tools-list.reference.json", RACINE);
const CIBLE = new URL("src/schemas.ts", RACINE);

const outils = JSON.parse(readFileSync(SOURCE, "utf8"));

const ENTETE = `import type { JsonSchema } from "@poirierlavoie/mcp-socle/protocole/valide";
import catalogue from "../data/catalogue.json";

const titre = (nom: keyof typeof catalogue.tools): string => catalogue.tools[nom].title_fr;

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

export const PUBLIES: Record<string, DescripteurPublie> = {
${outils.map((o) => `  ${o.name}: ${o.name.toUpperCase()},`).join("\n")}
};
`;

const contenu = ENTETE + corps + table;

writeFileSync(CIBLE, contenu);
console.log(`src/schemas.ts engendré : ${outils.length} descripteurs.`);
