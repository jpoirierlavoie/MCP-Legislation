// Dérive `wrangler.test.jsonc` de `wrangler.jsonc`, en retirant les DEUX seules liaisons
// qui n'ont pas d'émulation locale : `ai` et `vectorize`.
//
// POURQUOI CE FICHIER EXISTE. `@cloudflare/vitest-pool-workers` lit le `wrangler.jsonc`
// pour monter les liaisons sous miniflare. Workers AI et Vectorize n'ont pas d'émulation
// locale : le greffon ouvre alors une « remote proxy session » et exige
// `CLOUDFLARE_API_TOKEN`. La suite cesserait d'être hors ligne — elle dépendrait d'un
// réseau, d'une clef et d'un quota, ce que la règle de ce dépôt interdit.
//
// POURQUOI UNE DÉRIVATION ET NON UNE COPIE. Une copie diverge en silence : on ajoute une
// liaison au vrai fichier, les tests continuent de passer sur l'ancienne configuration, et
// plus rien ne le signale. `tests/wrangler-test-config.test.mjs` recalcule la dérivation et
// échoue si le fichier versionné ne lui correspond plus. C'est la même discipline que
// « la page dérive des données » (R10).
//
// Régénérer :  node scripts/wrangler-test-config.mjs --ecrire

import { readFileSync, writeFileSync } from "node:fs";

/** Les clés retirées, et rien d'autre. Toute addition ici est une décision, pas un détail. */
export const RETIREES = ["ai", "vectorize"];

const ENTETE = [
  "// ⚠ FICHIER ENGENDRÉ — ne pas modifier à la main.",
  "// Dérivé de wrangler.jsonc par scripts/wrangler-test-config.mjs.",
  "// Seules les liaisons `ai` et `vectorize` en sont retirées : elles n'ont pas",
  "// d'émulation locale et forceraient les tests à parler au réseau.",
  "",
].join("\n");

/** Retire les liaisons sans émulation locale. Elles tiennent chacune sur UNE ligne. */
export function deriver(source) {
  let out = source;
  for (const cle of RETIREES) {
    const motif = new RegExp(`^[ \t]*"${cle}":.*\n`, "m");
    if (!motif.test(out)) {
      throw new Error(
        `wrangler.jsonc ne contient plus une liaison "${cle}" sur une seule ligne. ` +
          "La dérivation est devenue fausse : corriger scripts/wrangler-test-config.mjs.",
      );
    }
    out = out.replace(motif, "");
  }
  return ENTETE + out;
}

if (process.argv.includes("--ecrire")) {
  const src = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  writeFileSync(new URL("../wrangler.test.jsonc", import.meta.url), deriver(src));
  console.log("wrangler.test.jsonc engendré.");
}
