// Le chemin du socle doit servir EXACTEMENT ce que servait `McpAgent`.
//
// C'est le contrôle qui décide de la marche 2. Le reste — types verts, tests unitaires —
// ne dit rien de ce qu'un client reçoit ; ceci le dit, en comparant la charge utile réelle
// à la référence capturée du SDK.

import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import reference from "../fixtures/tools-list.reference.json";

const URL_MCP = "https://legislation.test/mcp";
const JETON = "jeton-de-test";

/** Un POST JSON-RPC sur le point d'entrée, porteur en en-tête. */
const appel = (corps: unknown, entetes: Record<string, string> = {}) =>
  SELF.fetch(URL_MCP, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${JETON}`,
      ...entetes,
    },
    body: JSON.stringify(corps),
  });

const rpc = (method: string, params?: unknown) => ({ jsonrpc: "2.0", id: 1, method, params });

// Les liaisons viennent de wrangler.test.jsonc ; les secrets et drapeaux sont posés ici,
// car ils n'y figurent pas (et ne doivent pas y figurer).
const e = env as unknown as Record<string, unknown>;
e.MCP_TOKEN = JETON;
e.MCP_ENABLED = "true";
e.SOCLE = "true";

describe("le chemin du socle sert le contrat publié", () => {
  it("tools/list rend EXACTEMENT la référence capturée du SDK", async () => {
    const r = await appel(rpc("tools/list"));
    expect(r.status).toBe(200);
    const corps = (await r.json()) as { result: { tools: unknown[] } };
    // Égalité PROFONDE sur les dix descripteurs : noms, titres, descriptions, schémas,
    // annotations, `execution`. Si l'un bouge, le contrat a bougé.
    expect(corps.result.tools).toEqual(reference);
  });

  it("initialize rend l'identité et les instructions", async () => {
    const r = await appel(rpc("initialize", { protocolVersion: "2025-06-18" }));
    const c = (await r.json()) as { result: Record<string, unknown> };
    expect(c.result.protocolVersion).toBe("2025-06-18");
    expect(c.result.serverInfo).toEqual({
      name: "Législation du Québec et du Canada",
      version: "0.2.0",
    });
    expect(String(c.result.instructions)).toContain("SÉLECTION FERMÉE");
  });

  it("une version inconnue retombe sur la plus élevée servie", async () => {
    const r = await appel(rpc("initialize", { protocolVersion: "1900-01-01" }));
    const c = (await r.json()) as { result: { protocolVersion: string } };
    expect(c.result.protocolVersion).toBe("2025-06-18");
  });

  it("une notification rend 202 sans corps", async () => {
    const r = await appel({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(r.status).toBe(202);
    expect(await r.text()).toBe("");
  });

  it("une méthode inconnue rend 404 AVEC un corps JSON-RPC", async () => {
    // Le corps est ce qui distingue ce cas du 404 d'un serveur d'ancienne génération.
    const r = await appel(rpc("nexiste/pas"));
    expect(r.status).toBe(404);
    const c = (await r.json()) as { error: { code: number } };
    expect(c.error.code).toBe(-32601);
  });

  it("un JSON illisible rend une erreur d'analyse, pas un 500", async () => {
    const r = await SELF.fetch(URL_MCP, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${JETON}` },
      body: "{",
    });
    const c = (await r.json()) as { error: { code: number } };
    expect(c.error.code).toBe(-32700);
  });
});

describe("tools/call", () => {
  it("un outil inconnu est une erreur d'OUTIL, pas de protocole", async () => {
    const r = await appel(rpc("tools/call", { name: "legislation_inexistant", arguments: {} }));
    const c = (await r.json()) as { result: { isError: boolean; content: { text: string }[] } };
    expect(c.result.isError).toBe(true);
    expect(c.result.content[0]?.text).toContain("Outil inconnu");
  });

  it("des arguments invalides sont une erreur d'outil lisible par le modèle", async () => {
    const r = await appel(rpc("tools/call", { name: "legislation_get_article", arguments: {} }));
    const c = (await r.json()) as { result: { isError: boolean; content: { text: string }[] } };
    expect(c.result.isError).toBe(true);
    expect(c.result.content[0]?.text).toContain("obligatoire");
  });

  it("un numéro d'article envoyé en NOMBRE est accepté — Zod le coercait", async () => {
    // Le schéma publié annonce `"type":"string"` depuis toujours, et les modèles envoient
    // quand même des entiers. La normalisation du routeur préserve ce que Zod faisait ;
    // sans elle, le validateur du socle refuserait et l'outil le plus appelé tomberait.
    const r = await appel(
      rpc("tools/call", {
        name: "legislation_get_article",
        arguments: { law: "ccq", article: 1457 },
      }),
    );
    // La base de test est VIDE : le gestionnaire échoue ensuite, et c'est sans importance
    // ici. Ce qu'on éprouve est la VALIDATION — si elle avait refusé l'entier, la réponse
    // porterait « doit être une chaîne ». On regarde donc le corps entier, quelle que soit
    // sa forme (résultat d'outil ou erreur interne).
    expect(await r.text()).not.toContain("doit être une cha");
  });
});

describe("la chaîne intergicielle", () => {
  it("MCP_ENABLED absent ⇒ 404, et la page publique répond QUAND MÊME", async () => {
    e.MCP_ENABLED = undefined;
    try {
      expect((await appel(rpc("tools/list"))).status).toBe(404);
      expect((await SELF.fetch("https://legislation.test/health")).status).toBe(404);
      // C'est précisément quand le connecteur est coupé qu'un confrère doit pouvoir lire
      // pourquoi : la page ne tombe JAMAIS avec lui.
      //
      // La base de test n'a PAS de schéma (cf. vitest.config.mts : aucune migration n'y est
      // appliquée), si bien que le rendu échoue sur « no such table: laws ». Cet échec est
      // justement la PREUVE recherchée : le coupe-circuit aurait rendu 404 AVANT toute
      // lecture D1. On accepte donc les deux issues, et le jour où la base sera peuplée la
      // seconde branche prendra le relais sans que le test change de sens.
      const page = await SELF.fetch("https://legislation.test/").catch((x) => x as Error);
      if (page instanceof Error) expect(page.message).toMatch(/laws/);
      else expect(page.status).not.toBe(404);
    } finally {
      e.MCP_ENABLED = "true";
    }
  });

  it("/health répond quand le service est armé", async () => {
    const r = await SELF.fetch("https://legislation.test/health");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: "ok" });
  });

  it("une origine de navigateur inconnue est refusée AVANT l'authentification", async () => {
    const r = await SELF.fetch(URL_MCP, {
      method: "POST",
      headers: { Origin: "https://mechant.test", Authorization: `Bearer ${JETON}` },
      body: "{}",
    });
    expect(r.status).toBe(403);
    // Sans en-tête CORS : sinon le refus lui-même deviendrait lisible, donc un oracle.
    expect(r.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("le pré-vol passe SANS porteur, et porte les en-têtes attendus", async () => {
    const r = await SELF.fetch(URL_MCP, {
      method: "OPTIONS",
      headers: { Origin: "https://claude.ai" },
    });
    expect(r.status).toBe(204);
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("https://claude.ai");
  });

  it("un GET sans porteur rend 404, JAMAIS 405 — la méthode se juge après l'identité", async () => {
    const r = await SELF.fetch(URL_MCP, { method: "GET" });
    expect(r.status).toBe(404);
  });

  it("un GET AVEC porteur valide rend 405 — là, le refus n'apprend rien", async () => {
    const r = await SELF.fetch(URL_MCP, {
      method: "GET",
      headers: { Authorization: `Bearer ${JETON}` },
    });
    expect(r.status).toBe(405);
  });

  it("aucun secret configuré ⇒ tout est refusé, même le bon jeton", async () => {
    const garde = e.MCP_TOKEN;
    e.MCP_TOKEN = undefined;
    try {
      expect((await appel(rpc("tools/list"))).status).toBe(404);
    } finally {
      e.MCP_TOKEN = garde;
    }
  });
});
