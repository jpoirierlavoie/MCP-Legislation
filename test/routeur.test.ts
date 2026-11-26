// Le routeur du socle sert directement les outils et, sous `2026-07-28`, les habille
// de ce que la révision exige sans changer les contrats de `fixtures/tools-list.reference.json`.

import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import reference from "../fixtures/tools-list.reference.json";
import { PUBLIC_DESCRIPTION, SERVER_INFO, VERSIONS } from "../src/serveur";

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

  it("une requête SANS en-tête est traitée comme 2025-03-26, tant que celle-ci est servie", async () => {
    // REMPLACE un test qui exigeait un refus. La spécification n'ouvre que deux branches, et
    // le choix entre elles est COUPLÉ au maintien de `2025-03-26` : la refuser n'est permis
    // que si on l'a retirée. Nous ne l'avons pas retirée — son retrait attend la mesure de
    // `clientInfo` (phase 4). Avoir appliqué la conclusion de S3 sans sa prémisse a fait
    // rendre 400 à la veille mensuelle, qui n'envoie pas l'en-tête.
    const r = await appel(rpc("tools/list"));
    expect(r.status).toBe(200);
    // Traitée comme une révision HÉRITÉE : rien de moderne ne s'y glisse.
    const c = (await r.json()) as { result: Record<string, unknown> };
    expect(c.result.resultType).toBeUndefined();
  });

  it("une requête sans en-tête n'est JAMAIS promue en 2025-06-18", async () => {
    // Ce serait inventer une troisième branche que personne n'implémente en face.
    const r = await appel(rpc("tools/list"));
    const c = (await r.json()) as { result: Record<string, unknown> };
    expect(c.result.ttlMs).toBeUndefined();
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
        params: { name: "list_laws", arguments: {} },
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
      version: "2.2.1",
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
    const r = await heritee("tools/call", { name: "outil_inexistant", arguments: {} });
    const c = (await r.json()) as { result: { isError: boolean; content: { text: string }[] } };
    expect(c.result.isError).toBe(true);
    expect(c.result.content[0]?.text).toContain("Outil inconnu");
  });

  it("des arguments invalides sont lisibles par le modèle", async () => {
    const r = await heritee("tools/call", { name: "get_article", arguments: {} });
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
      name: "get_article",
      arguments: { law: "ccq", article: 1457 },
    });
    expect(await r.text()).not.toContain("doit être une cha");
  });

  it("un objet ou booléen pour un article n'est pas coercé et est rejeté par le validateur", async () => {
    const rObj = await heritee("tools/call", {
      name: "get_article",
      arguments: { law: "ccq", article: { evil: true } },
    });
    const cObj = (await rObj.json()) as {
      result: { isError: boolean; content: { text: string }[] };
    };
    expect(cObj.result.isError).toBe(true);
    expect(cObj.result.content[0]?.text).toContain("doit être une chaîne de caractères");

    const rBool = await heritee("tools/call", {
      name: "get_article",
      arguments: { law: "ccq", article: true },
    });
    const cBool = (await rBool.json()) as {
      result: { isError: boolean; content: { text: string }[] };
    };
    expect(cBool.result.isError).toBe(true);
    expect(cBool.result.content[0]?.text).toContain("doit être une chaîne de caractères");
  });
});

describe("la chaîne intergicielle", () => {
  it("MCP_ENABLED absent ⇒ 404, et la page publique n'en souffre pas", async () => {
    e.MCP_ENABLED = undefined;
    try {
      const mcpCoupe = await heritee("tools/list");
      expect(mcpCoupe.status).toBe(404);
      expect(mcpCoupe.headers.get("Cache-Control")).toBe("no-store");
      const santeCoupe = await SELF.fetch("https://legislation.test/health");
      expect(santeCoupe.status).toBe(404);
      expect(santeCoupe.headers.get("Cache-Control")).toBe("no-store");
      expect((await SELF.fetch("https://legislation.test/mcp/server-card")).status).toBe(404);
      for (const dec of ["/robots.txt", "/sitemap.xml", "/llms.txt"]) {
        const rDec = await SELF.fetch(`https://legislation.test${dec}`);
        expect(rDec.status, dec).toBe(200);
        expect(rDec.headers.get("Access-Control-Allow-Origin"), dec).toBeNull();
      }
      expect(
        (await SELF.fetch("https://legislation.test/robots.txt", { method: "POST" })).status,
      ).toBe(405);
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

  it("/health répond avec le commit annoncé quand le service est armé", async () => {
    const r = await SELF.fetch("https://legislation.test/health");
    expect(r.status).toBe(200);
    expect(r.headers.get("Cache-Control")).toBe("no-store");
    expect(await r.json()).toEqual({ status: "ok", commit: "inconnu" });

    const precedent = e.COMMIT;
    e.COMMIT = "abc1234";
    try {
      const r2 = await SELF.fetch("https://legislation.test/health");
      expect(r2.status).toBe(200);
      expect(await r2.json()).toEqual({ status: "ok", commit: "abc1234" });
    } finally {
      e.COMMIT = precedent;
    }
  });

  it("une origine de navigateur inconnue est refusée AVANT l'authentification", async () => {
    const r = await SELF.fetch(URL_MCP, {
      method: "POST",
      headers: { Origin: "https://mechant.test", Authorization: `Bearer ${JETON}` },
      body: "{}",
    });
    expect(r.status).toBe(403);
    expect(r.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(r.headers.get("Cache-Control")).toBe("no-store");
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
    const r = await SELF.fetch(URL_MCP, { method: "GET" });
    expect(r.status).toBe(404);
    expect(r.headers.get("Cache-Control")).toBe("no-store");

    const postAnon = await SELF.fetch(URL_MCP, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rpc("tools/list")),
    });
    expect(postAnon.status).toBe(404);
    expect(postAnon.headers.get("Cache-Control")).toBe("no-store");

    const oauthAnon = await SELF.fetch("https://legislation.test/mcp/oauth", { method: "GET" });
    expect(oauthAnon.status).toBe(401);
    expect(oauthAnon.headers.get("Cache-Control")).toBe("no-store");
  });

  it("un GET AVEC porteur valide rend 405 — là, le refus n'apprend rien", async () => {
    const r = await SELF.fetch(URL_MCP, {
      method: "GET",
      headers: { Authorization: `Bearer ${JETON}` },
    });
    expect(r.status).toBe(405);
    expect(r.headers.get("Cache-Control")).toBe("no-store");
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

describe("CORS Gemini web, pré-vol 2026-07-28 et ALLOWED_ORIGINS", () => {
  it("admet les origines web Gemini et les en-têtes MCP 2026-07-28 en pré-vol", async () => {
    for (const origin of ["https://gemini.google.com", "https://aistudio.google.com"]) {
      const pre = await SELF.fetch(URL_MCP, {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers":
            "authorization, mcp-protocol-version, mcp-method, mcp-name, mcp-session-id",
        },
      });
      expect(pre.status, origin).toBe(204);
      expect(pre.headers.get("Access-Control-Allow-Origin"), origin).toBe(origin);
      expect(pre.headers.get("Vary"), origin).toBe("Origin");
      const allows = (pre.headers.get("Access-Control-Allow-Headers") ?? "").toLowerCase();
      for (const h of [
        "authorization",
        "mcp-protocol-version",
        "mcp-method",
        "mcp-name",
        "mcp-session-id",
        "last-event-id",
      ]) {
        expect(allows, `${origin} ${h}`).toContain(h);
      }

      const post = await SELF.fetch(URL_MCP, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${JETON}`,
          "MCP-Protocol-Version": HERITEE,
          Origin: origin,
        },
        body: JSON.stringify(rpc("ping")),
      });
      expect(post.status, origin).toBe(200);
      expect(post.headers.get("Access-Control-Allow-Origin"), origin).toBe(origin);
    }
  });

  it("ALLOWED_ORIGINS s'ajoute aux origines par défaut sans les remplacer", async () => {
    const garde = e.ALLOWED_ORIGINS;
    e.ALLOWED_ORIGINS = "https://client.exemple";
    try {
      for (const origin of [
        "https://claude.ai",
        "https://gemini.google.com",
        "https://client.exemple",
      ]) {
        const pre = await SELF.fetch(URL_MCP, {
          method: "OPTIONS",
          headers: { Origin: origin },
        });
        expect(pre.status, origin).toBe(204);
        expect(pre.headers.get("Access-Control-Allow-Origin"), origin).toBe(origin);
      }
    } finally {
      e.ALLOWED_ORIGINS = garde;
    }
  });
});

describe("SEP-2127 — fiche de découverte /mcp/server-card", () => {
  it("GET /mcp/server-card rend 200 en application/mcp-server-card+json, dérivé sans secret", async () => {
    const res = await SELF.fetch("https://legislation.test/mcp/server-card", {
      headers: { Origin: "https://exemple.invalide" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/mcp-server-card+json; charset=utf-8");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const cc = res.headers.get("Cache-Control") ?? "";
    expect(cc).toContain("max-age=600");
    expect(cc).not.toContain("s-maxage");

    const brut = await res.text();
    expect(brut).not.toContain(JETON);
    expect(brut).not.toMatch(/[0-9a-f]{32,}/i);

    const card = JSON.parse(brut) as {
      $schema: string;
      name: string;
      title: string;
      version: string;
      description: string;
      websiteUrl: string;
      repository: { url: string; source: string };
      remotes: Array<{
        type: string;
        url: string;
        supportedProtocolVersions: string[];
        headers: Array<{ name: string; isRequired: boolean; isSecret: boolean }>;
      }>;
    };
    expect(card.$schema).toBe(
      "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
    );
    expect(card.name).toBe("ca.poirierlavoie.legislation/mcp-legislation");
    expect(card.title).toBe(SERVER_INFO.name);
    expect(card.version).toBe(SERVER_INFO.version);
    expect(card.description).toBe(PUBLIC_DESCRIPTION);
    expect(card.websiteUrl).toBe("https://legislation.poirierlavoie.ca/");
    expect(card.repository).toEqual({
      url: "https://github.com/jpoirierlavoie/MCP-Legislation",
      source: "github",
    });
    expect(card.remotes).toHaveLength(1);
    expect(card.remotes[0]).toMatchObject({
      type: "streamable-http",
      url: "https://legislation.poirierlavoie.ca/mcp",
      supportedProtocolVersions: [...VERSIONS],
    });
    expect(card.remotes[0]!.headers[0]).toMatchObject({
      name: "Authorization",
      isRequired: true,
      isSecret: true,
    });
  });

  it("HEAD et OPTIONS répondent sans corps, POST et DELETE rendent 405", async () => {
    const head = await SELF.fetch("https://legislation.test/mcp/server-card", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Type")).toBe(
      "application/mcp-server-card+json; charset=utf-8",
    );
    expect(await head.text()).toBe("");

    const opt = await SELF.fetch("https://legislation.test/mcp/server-card", {
      method: "OPTIONS",
    });
    expect(opt.status).toBe(204);
    expect(opt.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(opt.headers.get("Access-Control-Allow-Methods")).toContain("GET");

    for (const m of ["POST", "DELETE"]) {
      const r = await SELF.fetch("https://legislation.test/mcp/server-card", { method: m });
      expect(r.status, m).toBe(405);
      expect(r.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
      expect(r.headers.get("Access-Control-Allow-Origin")).toBe("*");
    }
  });

  it("les chemins de découverte hors exactitude et MCP_ENABLED=false rendent 404", async () => {
    for (const chemin of ["/server-card", "/.well-known/mcp.json", "/mcp/server-card/"]) {
      expect((await SELF.fetch(`https://legislation.test${chemin}`)).status, chemin).toBe(404);
    }

    e.MCP_ENABLED = "false";
    try {
      expect((await SELF.fetch("https://legislation.test/mcp/server-card")).status).toBe(404);
      for (const dec of ["/robots.txt", "/sitemap.xml", "/llms.txt"]) {
        const rDec = await SELF.fetch(`https://legislation.test${dec}`);
        expect(rDec.status, dec).toBe(200);
        expect(rDec.headers.get("Access-Control-Allow-Origin"), dec).toBeNull();
      }
      expect(
        (await SELF.fetch("https://legislation.test/robots.txt", { method: "POST" })).status,
      ).toBe(405);
    } finally {
      e.MCP_ENABLED = "true";
    }
  });
});

describe("zéro écriture dans search_log à l'exécution (S13, S14, G9)", () => {
  it("find_relevant et search_text n'insèrent jamais aucune ligne dans search_log, même sur requête sensible", async () => {
    const db = (env as unknown as { DB: D1Database }).DB;
    await db.prepare("DELETE FROM search_log").run();

    const requeteSensible =
      "dossier 500-17-123456-241 client@exemple.ca vice caché art. 1726 C.c.Q.";

    const r1 = await heritee("tools/call", {
      name: "find_relevant",
      arguments: { query: requeteSensible },
    });
    expect(r1.status).toBe(200);

    const r2 = await heritee("tools/call", {
      name: "search_text",
      arguments: { query: requeteSensible },
    });
    expect(r2.status).toBe(200);

    const compte = await db.prepare("SELECT COUNT(*) AS n FROM search_log").first<{ n: number }>();
    expect(compte?.n).toBe(0);
  });
});
