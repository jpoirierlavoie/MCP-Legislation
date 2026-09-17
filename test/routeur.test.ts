// Le chemin du socle doit servir EXACTEMENT ce que servait `McpAgent` — et, sous
// `2026-07-28`, le servir habillé de ce que la révision exige, sans rien changer d'autre.
//
// C'est le contrôle qui décide des marches 2 et 3. Types verts et tests unitaires ne disent
// rien de ce qu'un client reçoit ; ceci le dit, en comparant la charge utile réelle à la
// référence capturée du SDK.

import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import reference from "../fixtures/tools-list.reference.json";

const URL_MCP = "https://legislation.test/mcp";
const JETON = "jeton-de-test";

/** Révision héritée : aucun en-tête `Mcp-Method` / `Mcp-Name` n'y est exigé. */
const HERITEE = "2025-06-18";
/** Révision moderne : en-têtes obligatoires, `resultType` et indices de cache attendus. */
const MODERNE = "2026-07-28";

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

/** Appel sous révision héritée : la version suffit, rien d'autre n'est exigé. */
const heritee = (method: string, params?: unknown) =>
  appel(rpc(method, params), { "MCP-Protocol-Version": HERITEE });

/** Appel sous révision moderne : les en-têtes miroirs sont obligatoires. */
const moderne = (method: string, params?: Record<string, unknown>) => {
  const entetes: Record<string, string> = {
    "MCP-Protocol-Version": MODERNE,
    "Mcp-Method": method,
  };
  const nom = params?.name ?? params?.uri;
  if (typeof nom === "string") entetes["Mcp-Name"] = nom;
  return appel(
    {
      jsonrpc: "2.0",
      id: 1,
      method,
      params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": MODERNE } },
    },
    entetes,
  );
};

const e = env as unknown as Record<string, unknown>;
e.MCP_TOKEN = JETON;
e.MCP_ENABLED = "true";
e.SOCLE = "true";

describe("le contrat publié est le même sous les deux ères", () => {
  it("sous une révision héritée, tools/list est EXACTEMENT la référence du SDK", async () => {
    const c = (await (await heritee("tools/list")).json()) as { result: Record<string, unknown> };
    expect(c.result.tools).toEqual(reference);
    // Rien de moderne ne doit s'y glisser : ces champs n'existent pas avant 2026-07-28.
    expect(c.result.resultType).toBeUndefined();
    expect(c.result.ttlMs).toBeUndefined();
  });

  it("sous 2026-07-28, les MÊMES outils, plus resultType et les indices de cache", async () => {
    const c = (await (await moderne("tools/list")).json()) as { result: Record<string, unknown> };
    expect(c.result.tools).toEqual(reference); // G4 : même ensemble, même ordre
    expect(c.result.resultType).toBe("complete");
    expect(c.result.ttlMs).toBe(3_600_000);
    expect(c.result.cacheScope).toBe("public");
  });
});

describe("négociation de version", () => {
  it("une version inconnue rend 400 et -32022, AVEC la liste des versions servies", async () => {
    const r = await appel(rpc("tools/list"), { "MCP-Protocol-Version": "1900-01-01" });
    expect(r.status).toBe(400);
    const c = (await r.json()) as { error: { code: number; data: { supported: string[] } } };
    expect(c.error.code).toBe(-32022);
    // Sans cette liste, un client ne peut que renoncer ; avec elle, il réessaie.
    expect(c.error.data.supported).toContain(MODERNE);
    expect(c.error.data.supported).toContain(HERITEE);
  });

  it("une requête SANS en-tête de version est refusée — jamais promue en silence", async () => {
    const r = await appel(rpc("tools/list"));
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { code: number } }).error.code).toBe(-32020);
  });

  it("`initialize` SANS en-tête passe — la poignée héritée n'en porte pas", async () => {
    // Sous 2025-06-18 l'en-tête n'est exigé qu'APRÈS l'initialisation. Le refuser
    // rejetterait la poignée de tout client conforme, connecteur claude.ai compris.
    const r = await appel(rpc("initialize", { protocolVersion: HERITEE }));
    expect(r.status).toBe(200);
    const c = (await r.json()) as { result: { protocolVersion: string } };
    expect(c.result.protocolVersion).toBe(HERITEE);
  });

  it("les quatre versions sont servies", async () => {
    for (const v of [MODERNE, "2025-11-25", HERITEE, "2025-03-26"]) {
      const r = await appel(rpc("initialize", { protocolVersion: v }), {
        "MCP-Protocol-Version": v,
      });
      expect(r.status, v).toBe(200);
    }
  });
});

describe("validation en-tête contre corps, sous révision moderne SEULEMENT", () => {
  it("`Mcp-Method` manquant est refusé", async () => {
    const r = await appel(
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      { "MCP-Protocol-Version": MODERNE },
    );
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { code: number } }).error.code).toBe(-32020);
  });

  it("un `Mcp-Method` qui contredit le corps est refusé", async () => {
    const r = await appel(
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      { "MCP-Protocol-Version": MODERNE, "Mcp-Method": "tools/call" },
    );
    expect(r.status).toBe(400);
  });

  it("un `Mcp-Name` qui contredit le corps est refusé", async () => {
    const r = await appel(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "legislation_list_laws", arguments: {} },
      },
      { "MCP-Protocol-Version": MODERNE, "Mcp-Method": "tools/call", "Mcp-Name": "autre_outil" },
    );
    expect(r.status).toBe(400);
  });

  it("une révision HÉRITÉE n'exige aucun de ces en-têtes", async () => {
    // Les réclamer là-bas refuserait des clients parfaitement conformes.
    expect((await heritee("tools/list")).status).toBe(200);
  });
});

describe("server/discover", () => {
  it("rend versions, capacités, instructions, resultType et indices de cache", async () => {
    const c = (await (await moderne("server/discover")).json()) as {
      result: Record<string, unknown>;
    };
    expect(c.result.supportedVersions).toEqual([MODERNE, "2025-11-25", HERITEE, "2025-03-26"]);
    expect(c.result.resultType).toBe("complete");
    expect(c.result.ttlMs).toBe(3_600_000);
    expect(String(c.result.instructions)).toContain("SÉLECTION FERMÉE");
  });

  it("met serverInfo dans `_meta`, non à la racine", async () => {
    const c = (await (await moderne("server/discover")).json()) as {
      result: { _meta: Record<string, unknown>; serverInfo?: unknown };
    };
    expect(c.result.serverInfo).toBeUndefined();
    expect(c.result._meta["io.modelcontextprotocol/serverInfo"]).toEqual({
      name: "Législation du Québec et du Canada",
      version: "0.2.0",
    });
  });

  it("n'annonce PAS listChanged — subscriptions/listen n'est pas servi", async () => {
    const c = (await (await moderne("server/discover")).json()) as {
      result: { capabilities: { tools: { listChanged: boolean } } };
    };
    expect(c.result.capabilities.tools.listChanged).toBe(false);
  });
});

describe("méthodes et erreurs", () => {
  it("une notification rend 202 sans corps", async () => {
    const r = await appel(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { "MCP-Protocol-Version": HERITEE },
    );
    expect(r.status).toBe(202);
    expect(await r.text()).toBe("");
  });

  it("une méthode inconnue rend 404 AVEC un corps JSON-RPC", async () => {
    // Le corps distingue ce cas du 404 d'un serveur d'ancienne génération.
    const r = await heritee("nexiste/pas");
    expect(r.status).toBe(404);
    expect(((await r.json()) as { error: { code: number } }).error.code).toBe(-32601);
  });

  it("un JSON illisible rend une erreur d'analyse, pas un 500", async () => {
    const r = await SELF.fetch(URL_MCP, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${JETON}`,
        "MCP-Protocol-Version": HERITEE,
      },
      body: "{",
    });
    expect(((await r.json()) as { error: { code: number } }).error.code).toBe(-32700);
  });
});

describe("tools/call", () => {
  it("un outil inconnu est une erreur d'OUTIL, pas de protocole", async () => {
    const r = await heritee("tools/call", { name: "legislation_inexistant", arguments: {} });
    const c = (await r.json()) as { result: { isError: boolean; content: { text: string }[] } };
    expect(c.result.isError).toBe(true);
    expect(c.result.content[0]?.text).toContain("Outil inconnu");
  });

  it("des arguments invalides sont lisibles par le modèle", async () => {
    const r = await heritee("tools/call", { name: "legislation_get_article", arguments: {} });
    const c = (await r.json()) as { result: { isError: boolean; content: { text: string }[] } };
    expect(c.result.isError).toBe(true);
    expect(c.result.content[0]?.text).toContain("obligatoire");
  });

  it("un numéro d'article envoyé en NOMBRE est accepté — Zod le coercait", async () => {
    // Le schéma publié annonce `"type":"string"` depuis toujours et les modèles envoient
    // quand même des entiers. Sans la normalisation, le validateur refuserait et l'outil le
    // plus appelé tomberait. La base de test est vide : on éprouve la VALIDATION, pas le
    // résultat — un refus de type dirait « doit être une chaîne ».
    const r = await heritee("tools/call", {
      name: "legislation_get_article",
      arguments: { law: "ccq", article: 1457 },
    });
    expect(await r.text()).not.toContain("doit être une cha");
  });
});

describe("la chaîne intergicielle", () => {
  it("MCP_ENABLED absent ⇒ 404, et la page publique n'en souffre pas", async () => {
    e.MCP_ENABLED = undefined;
    try {
      expect((await heritee("tools/list")).status).toBe(404);
      expect((await SELF.fetch("https://legislation.test/health")).status).toBe(404);
      // La base de test n'a pas de schéma (aucune migration n'est appliquée), si bien que le
      // rendu échoue sur « no such table: laws ». Cet échec est justement la preuve cherchée :
      // le coupe-circuit aurait rendu 404 AVANT toute lecture D1. On accepte les deux issues,
      // pour que le test ne change pas de sens le jour où la base sera peuplée.
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
    expect(r.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("le pré-vol passe SANS porteur", async () => {
    const r = await SELF.fetch(URL_MCP, {
      method: "OPTIONS",
      headers: { Origin: "https://claude.ai" },
    });
    expect(r.status).toBe(204);
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("https://claude.ai");
  });

  it("un GET sans porteur rend 404, JAMAIS 405 — la méthode se juge après l'identité", async () => {
    expect((await SELF.fetch(URL_MCP, { method: "GET" })).status).toBe(404);
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
      expect((await heritee("tools/list")).status).toBe(404);
    } finally {
      e.MCP_TOKEN = garde;
    }
  });
});

describe("les deux chemins acceptent les MÊMES secrets", () => {
  it("le jeton de la VEILLE est admis par le routeur du socle", async () => {
    // Défaut réel, corrigé : `PORTE.nomsSecrets` recopiait la liste au lieu de la partager.
    // Elle nommait encore `MCP_TOKEN_ATHENA`, retiré le 2026-09-16, et ignorait
    // `MCP_TOKEN_VEILLE` — la veille mensuelle recevait donc 404 en production dès la
    // bascule. Une liste recopiée devient fausse sans que rien n'échoue.
    const garde = e.MCP_TOKEN;
    e.MCP_TOKEN = undefined;
    e.MCP_TOKEN_VEILLE = "jeton-de-veille";
    try {
      const r = await SELF.fetch(URL_MCP, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer jeton-de-veille",
          "MCP-Protocol-Version": HERITEE,
        },
        body: JSON.stringify(rpc("tools/list")),
      });
      expect(r.status).toBe(200);
    } finally {
      e.MCP_TOKEN = garde;
      e.MCP_TOKEN_VEILLE = undefined;
    }
  });

  it("un nom de secret hors liste n'ouvre rien", async () => {
    const garde = e.MCP_TOKEN;
    e.MCP_TOKEN = undefined;
    e.MCP_TOKEN_ATHENA = "jeton-retire";
    try {
      const r = await SELF.fetch(URL_MCP, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer jeton-retire",
          "MCP-Protocol-Version": HERITEE,
        },
        body: JSON.stringify(rpc("tools/list")),
      });
      expect(r.status).toBe(404);
    } finally {
      e.MCP_TOKEN = garde;
      e.MCP_TOKEN_ATHENA = undefined;
    }
  });
});
