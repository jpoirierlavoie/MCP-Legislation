import { applyD1Migrations, env } from "cloudflare:test";
import { construireSchemaIdentiteD1 } from "@poirierlavoie/mcp-socle";

interface EnvTest {
  DB: D1Database;
  DB_IDENTITE: D1Database;
  TEST_SCHEMA: string;
  TEST_DECOUVERTE: string;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const e = env as unknown as EnvTest;

function enonces(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 0)
    .map((s) => `${s};`)
    .join("\n");
}

await e.DB.exec(enonces(e.TEST_SCHEMA));
await e.DB.exec(enonces(e.TEST_DECOUVERTE));
await applyD1Migrations(e.DB, e.TEST_MIGRATIONS);
await e.DB_IDENTITE.exec(
  enonces(construireSchemaIdentiteD1(["legislation", "jurisprudence", "outils"])),
);
