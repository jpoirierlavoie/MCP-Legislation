// Client MCP minimal (HTTP streamable) — extrait de tests/evals.mjs pour être partagé
// entre les contrôles de non-régression et le harnais d'évaluation (plan v2 §0.4).
//
// UNE session pour tous les appels : initialize -> notifications/initialized -> N tools/call.
// C'est important en volume — chaque session MCP coûte des écritures au Durable Object ;
// un processus par appel (patron Inspector CLI) a déjà épuisé un quota journalier.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RACINE = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Variable d'environnement d'abord (la CI n'a que ça), puis fichier gitignoré. */
function depuis(variable, fichier) {
  const fromEnv = process.env[variable]?.trim();
  if (fromEnv) return fromEnv;
  const file = join(RACINE, fichier);
  return existsSync(file) ? readFileSync(file, "utf-8").trim() || null : null;
}

// Jeton d'accès (src/auth.ts) : résolu ICI plutôt que chez chaque appelant, pour qu'aucun
// des trois (tests/evals.mjs, eval/run.mjs, scripts/check-consolidation.mjs) ne puisse être
// oublié. Ordre : option explicite -> MCP_TOKEN (la CI n'a que ça) -> mcp.token à la racine
// (gitignoré, même convention que backfill.token). Absent = aucun en-tête — et depuis le
// défaut FERMÉ, le serveur refuse alors TOUT, ce qui est exactement ce qu'on veut observer.
export function resolveMcpToken() {
  return depuis("MCP_TOKEN", "mcp.token");
}

/**
 * Jeton d'un client SECONDAIRE — les secrets `MCP_TOKEN_<CLIENT>` de src/auth.ts. Même
 * convention, décalée d'un cran : variable `MCP_TOKEN_<CLIENT>`, puis `mcp-<client>.token`
 * à la racine (couvert par `*.token` du .gitignore, comme mcp.token et backfill.token).
 *
 * Rend `null` si ce poste ne détient pas ce jeton — et c'est le cas NORMAL : le jeton d'un
 * autre client n'a aucune raison d'être partout. Les contrôles qui en dépendent se SAUTENT
 * bruyamment ; ils n'échouent pas, et surtout ils ne verdissent pas. Ne JAMAIS le poser en
 * secret GitHub : la veille CI a le sien (MCP_TOKEN), et un jeton détenu à trois endroits
 * n'est plus révocable seul — ce qui est tout l'objet du découpage par client.
 */
export function resolveClientToken(client) {
  return depuis(`MCP_TOKEN_${client.toUpperCase()}`, `mcp-${client.toLowerCase()}.token`);
}

/**
 * Le transport peut répondre en JSON ou en SSE (`event: message\ndata: {…}`) sur le MÊME
 * POST. Exporté : tests/evals.mjs sonde la porte avec des `fetch` bruts (hors session) et
 * doit lire les deux cadrages. Deux analyseurs séparés divergeraient en silence.
 */
export function parseBody(text, contentType) {
  if (contentType.includes("text/event-stream")) {
    const payloads = [];
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith("data:")) payloads.push(line.slice(5).trim());
    }
    if (!payloads.length) throw new Error(`SSE sans data: ${text.slice(0, 200)}`);
    return JSON.parse(payloads[payloads.length - 1]);
  }
  return JSON.parse(text);
}

export function createMcpClient(url, { token } = {}) {
  const auth = token?.trim() || resolveMcpToken();
  let sessionId = null;
  let nextId = 1;


  async function rpc(method, params, { notification = false } = {}) {
    const body = notification
      ? { jsonrpc: "2.0", method, params }
      : { jsonrpc: "2.0", id: nextId++, method, params };
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    if (auth) headers.Authorization = `Bearer ${auth}`;

    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    const sid = res.headers.get("mcp-session-id");
    if (sid) sessionId = sid;
    if (notification) return null;
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} sur ${method} : ${text.slice(0, 300)}`);
    const msg = parseBody(text, res.headers.get("content-type") ?? "");
    if (msg.error) throw new Error(`${method} : ${msg.error.message}`);
    return msg.result;
  }

  async function connect() {
    await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "qclaw-eval-client", version: "1.0.0" },
    });
    await rpc("notifications/initialized", {}, { notification: true });
  }

  const callTool = (name, args) => rpc("tools/call", { name, arguments: args });

  return { connect, callTool, rpc };
}
