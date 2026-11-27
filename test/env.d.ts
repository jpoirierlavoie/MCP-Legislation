declare module "cloudflare:test" {
  interface ProvidedEnv {
    TEST_SCHEMA: string;
    TEST_DECOUVERTE: string;
    TEST_MIGRATIONS: D1Migration[];
  }
}
