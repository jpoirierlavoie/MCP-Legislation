import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Éprouve le HARNAIS, non le domaine : que les liaisons du wrangler.test.jsonc montent
// bien sous miniflare, hors ligne, sans jeton Cloudflare. Si ce fichier tombe, c'est la
// configuration de test qui a glissé — pas le code de qclaw.
describe("harnais workerd", () => {
  it("expose la D1 locale, et elle répond", async () => {
    const { DB } = env as unknown as { DB: D1Database };
    const r = await DB.prepare("select 1 as n").first<{ n: number }>();
    expect(r?.n).toBe(1);
  });

  it("expose le limiteur de débit", () => {
    expect((env as unknown as Record<string, unknown>).RATE_LIMITER).toBeDefined();
  });

  it("n'expose NI AI NI VECTORS — c'est le prix de la suite hors ligne", () => {
    const e = env as unknown as Record<string, unknown>;
    expect(e.AI).toBeUndefined();
    expect(e.VECTORS).toBeUndefined();
  });
});
