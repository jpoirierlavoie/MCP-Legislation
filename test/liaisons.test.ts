import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Éprouve le HARNAIS, non le domaine : que les liaisons du wrangler.test.jsonc montent
// bien sous miniflare, hors ligne, sans jeton Cloudflare.
describe("harnais workerd", () => {
  it("expose les deux bases D1 locales (`DB` et `DB_IDENTITE`), et elles répondent", async () => {
    const { DB, DB_IDENTITE } = env as unknown as {
      DB: D1Database;
      DB_IDENTITE: D1Database;
    };
    const r = await DB.prepare("select 1 as n").first<{ n: number }>();
    expect(r?.n).toBe(1);
    const id = await DB_IDENTITE.prepare("select count(*) as n from titulaire").first<{
      n: number;
    }>();
    expect(id?.n).toBe(0);
  });

  it("expose les cinq limiteurs de débit à deux niveaux (G34)", () => {
    const e = env as unknown as Record<string, unknown>;
    for (const nom of [
      "RL_PRE_AUTH_IP",
      "RL_ECHEC_IP",
      "RL_ECHECS_GLOBAL",
      "RL_TITULAIRE",
      "RL_TITULAIRE_LIMITE",
    ]) {
      expect(e[nom], nom).toBeDefined();
    }
  });

  it("n'expose NI AI NI VECTORS — c'est le prix de la suite hors ligne", () => {
    const e = env as unknown as Record<string, unknown>;
    expect(e.AI).toBeUndefined();
    expect(e.VECTORS).toBeUndefined();
  });
});
