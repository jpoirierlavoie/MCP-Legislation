/**
 * Liaisons ajoutées PAR LES TESTS, absentes de `wrangler.jsonc` et donc du type engendré.
 *
 * Elles portent de quoi amorcer une vraie base D1 : l'état initial, la couche de découverte
 * et les migrations. Voir `test/amorcer-d1.ts` et `vitest.config.mts`.
 */
declare module "cloudflare:test" {
  interface ProvidedEnv {
    TEST_SCHEMA: string;
    TEST_DECOUVERTE: string;
    TEST_MIGRATIONS: D1Migration[];
  }
}
