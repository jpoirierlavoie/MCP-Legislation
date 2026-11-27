import { readFileSync, writeFileSync } from "node:fs";

export const RETIREES = ["ai", "vectorize"];

const ENTETE = [
  "// ⚠ FICHIER ENGENDRÉ — ne pas modifier à la main.",
  "// Dérivé de wrangler.jsonc par scripts/wrangler-test-config.mjs.",
  "// Seules les liaisons `ai` et `vectorize` en sont retirées : elles n'ont pas",
  "// d'émulation locale et forceraient les tests à parler au réseau.",
  "",
].join("\n");

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
