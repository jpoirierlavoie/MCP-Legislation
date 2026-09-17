import { readFileSync } from "node:fs";
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
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
          cloudflareTest(async () => {
            const racine = import.meta.dirname;
            return {
              // wrangler.test.jsonc, non wrangler.jsonc : `ai` et `vectorize` n'ont pas
              // d'émulation locale et feraient réclamer un CLOUDFLARE_API_TOKEN. Voir
              // scripts/wrangler-test-config.mjs.
              wrangler: { configPath: "./wrangler.test.jsonc" },
              miniflare: {
                // De quoi AMORCER une vraie base : l'état initial, la couche de découverte
                // — que le bootstrap de la CI n'applique pas — puis les migrations réelles.
                // Appliqués par test/amorcer-d1.ts, dans cet ordre, qui est celui de la
                // production et n'est pas interchangeable.
                bindings: {
                  TEST_SCHEMA: readFileSync(path.join(racine, "schema.sql"), "utf8"),
                  TEST_DECOUVERTE: readFileSync(
                    path.join(racine, "schema-decouverte.sql"),
                    "utf8",
                  ),
                  TEST_MIGRATIONS: await readD1Migrations(path.join(racine, "migrations")),
                },
              },
            };
          }),
        ],
        test: {
          name: "workerd",
          include: ["test/**/*.test.ts"],
          setupFiles: ["./test/amorcer-d1.ts"],
        },
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
