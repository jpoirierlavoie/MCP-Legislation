import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * DEUX PROJETS, et ce n'est pas un choix de confort.
 *
 * « workerd » — le code qui touche D1, FTS5 ou `crypto.subtle.timingSafeEqual`. Seul
 *   workerd les fournit ; un test vert sous Node n'y prouverait rien.
 *
 * « node »    — les tests de PROVENANCE, qui lisent le TypeScript comme du texte avec
 *   `node:fs` (le catalogue est la source unique des titres, les littéraux SQL du
 *   commutateur fédéral, la porte d'accès analysée dans src/auth.ts…). Ils ne PEUVENT PAS
 *   tourner dans workerd, dont le shim `fs` ne sert pas l'arborescence du projet —
 *   mesuré, et non supposé. Aucun import ne voit une provenance : ces assertions restent
 *   sur le texte source, et c'est délibéré.
 *
 * L'extension est `.mts` : le paquet n'est pas `"type": "module"`, donc un `.ts` serait
 * chargé en CJS et le greffon, ESM pur, échouerait au chargement.
 */
export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          // wrangler.test.jsonc, non wrangler.jsonc : voir scripts/wrangler-test-config.mjs.
          cloudflareTest(() => ({ wrangler: { configPath: "./wrangler.test.jsonc" } })),
        ],
        test: { name: "workerd", include: ["test/**/*.test.ts"] },
      },
      {
        test: {
          name: "node",
          environment: "node",
          include: ["tests/**/*.test.mjs", "scripts/**/*.test.mjs"],
        },
      },
    ],
  },
});
