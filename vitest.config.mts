import { readFileSync } from "node:fs";
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest(async () => {
            const racine = import.meta.dirname;
            return {
              wrangler: { configPath: "./wrangler.test.jsonc" },
              miniflare: {
                bindings: {
                  TEST_SCHEMA: readFileSync(path.join(racine, "data", "schema.sql"), "utf8"),
                  TEST_DECOUVERTE: readFileSync(
                    path.join(racine, "data", "schema-decouverte.sql"),
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
          include: ["test/**/*.test.mjs", "scripts/**/*.test.mjs"],
        },
      },
    ],
  },
});
