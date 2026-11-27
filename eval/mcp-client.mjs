import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RACINE = join(dirname(fileURLToPath(import.meta.url)), "..");

function depuis(variable, fichier) {
  const fromEnv = process.env[variable]?.trim();
  if (fromEnv) return fromEnv;
  const file = join(RACINE, fichier);
  return existsSync(file) ? readFileSync(file, "utf-8").trim() || null : null;
}

export function resolveMcpToken() {
  return depuis("MCP_TOKEN", "mcp.token");
}

export function resolveClientToken(client) {
  return depuis(`MCP_TOKEN_${client.toUpperCase()}`, `mcp-${client.toLowerCase()}.token`);
}

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
      clientInfo: { name: "legislation-eval-client", version: "1.0.0" },
    });
    await rpc("notifications/initialized", {}, { notification: true });
  }

  const callTool = (name, args) => rpc("tools/call", { name, arguments: args });

  return { connect, callTool, rpc };
}
