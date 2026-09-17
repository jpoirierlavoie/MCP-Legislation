// Capture la charge utile EXACTE que `tools/list` publie aujourd'hui, SDK compris.
//
// POURQUOI. La marche 2 remplace `McpAgent` et le SDK par le routeur du socle, ce qui
// oblige à réécrire les dix `inputSchema` de Zod vers du JSON Schema. Les réécrire À LA
// MAIN, c'est parier que quarante-deux champs seront transcrits sans faute — et une faute
// y est silencieuse : un `required` de trop rend un refus dur sur tous les appels
// nominaux, un `default` inventé ment au modèle sans que rien n'échoue.
//
// La seule référence qui ne se discute pas est ce que le serveur publie AUJOURD'HUI. Ce
// script la fige. Après bascule, `tools/list` doit rendre la même chose, octet pour octet.
//
//   node scripts/capturer-tools-list.mjs > fixtures/tools-list.reference.json
//
// ⚠ À RELANCER AVANT la bascule, jamais après : une fois le SDK retiré, la référence n'est
//   plus reproductible et ce script ne s'exécute plus. C'est voulu — il sera supprimé avec
//   la dépendance, et la fixture restera comme trace de ce qui était servi.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { registerTools } from "../src/tools.ts";

// `tools/list` ne touche aucune liaison : un environnement creux suffit. Les drapeaux sont
// posés à leur valeur de production pour le cas où un descripteur en dépendrait.
const env = {
  DB: null,
  AI: null,
  VECTORS: null,
  RATE_LIMITER: null,
  RELAX_SEARCH: "1",
  HYBRID_SEARCH: "1",
  FEDERAL_CORPUS: "1",
};

const server = new McpServer(
  { name: "qclaw-mcp", version: "0.2.0" },
  { instructions: "capture" },
);
registerTools(server, env);

// On passe par le gestionnaire réel plutôt que par une lecture des internes : c'est le même
// chemin que celui qu'emprunte un client, conversion Zod -> JSON Schema comprise.
const handler = server.server._requestHandlers.get(ListToolsRequestSchema.shape.method.value);
if (!handler) throw new Error("gestionnaire tools/list introuvable");

const res = await handler({ method: "tools/list", params: {} }, { signal: new AbortController().signal });

process.stdout.write(`${JSON.stringify(res.tools, null, 2)}\n`);
