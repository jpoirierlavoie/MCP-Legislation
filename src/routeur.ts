/**
 * Routeur MCP bâti sur le socle — le chemin qui remplacera `McpAgent`.
 *
 * Il ne réimplémente rien : l'enveloppe JSON-RPC, le validateur et la chaîne intergicielle
 * viennent de `@poirierlavoie/socle-juridique`. Ce fichier ne porte que ce qui est PROPRE à
 * ce connecteur — son identité, ses descripteurs, et la normalisation ci-dessous.
 *
 * Tant que `SOCLE !== "true"`, il n'est pas atteint : `McpAgent` sert. Les deux chemins
 * appellent LES MÊMES gestionnaires (`construireOutils`), de sorte qu'il n'y a pas deux
 * comportements à tenir synchronisés — seulement deux façons d'y arriver.
 */

import {
  corsHeaders,
  err,
  errorResponse,
  INTERNAL_ERROR,
  INVALID_REQUEST,
  isNotification,
  JsonRpcError,
  type JsonRpcMessage,
  METHOD_NOT_FOUND,
  PARSE_ERROR,
  parseMessage,
  resultResponse,
  validateArgs,
} from "@poirierlavoie/socle-juridique";

import { PUBLIES } from "./schemas";
import { INSTRUCTIONS, SERVER_INFO, VERSIONS } from "./serveur";
import { construireOutils, type Registre } from "./tools";

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

/**
 * Champs que Zod CONVERTISSAIT et que le validateur du socle REFUSERAIT.
 *
 * `z.coerce.string()` acceptait `article: 1457` et en faisait `"1457"` ; le sous-ensemble
 * JSON Schema, lui, n'a pas de coercition et rejetterait l'entier. Or le schéma PUBLIÉ
 * annonce déjà `"type":"string"` sur ces quatre champs — la coercition n'y a jamais paru —
 * et les modèles envoient tout de même des nombres. Compter sur une description plus
 * impérative serait parier qu'une phrase réussit là où `"type":"string"` a échoué.
 *
 * On normalise donc AVANT de valider, ce qui préserve exactement le comportement de Zod.
 * La table est explicite : un champ ajouté ailleurs ne sera pas converti par surprise.
 */
const COERCITIONS: Record<string, readonly string[]> = {
  legislation_get_article: ["article"],
  legislation_get_articles: ["from", "to", "numbers"],
};

function normaliser(nom: string, args: Record<string, unknown>): Record<string, unknown> {
  const champs = COERCITIONS[nom];
  if (!champs) return args;
  const out = { ...args };
  for (const champ of champs) {
    const v = out[champ];
    if (v === undefined || v === null) continue;
    // `numbers` est un tableau de chaînes ; les autres sont scalaires.
    out[champ] = Array.isArray(v)
      ? v.map((x) => (typeof x === "string" ? x : String(x)))
      : typeof v === "string"
        ? v
        : String(v);
  }
  return out;
}

/** Descripteurs de `tools/list`, dans l'ordre publié. */
function descripteurs(): Array<Record<string, unknown>> {
  return Object.entries(PUBLIES).map(([name, d]) => ({
    name,
    title: d.title,
    description: d.description,
    inputSchema: d.inputSchema,
    annotations: d.annotations,
    ...(d.execution ? { execution: d.execution } : {}),
  }));
}

async function appeler(
  outils: Registre,
  message: JsonRpcMessage,
): Promise<Record<string, unknown>> {
  const params = message.params ?? {};
  const nom = typeof params.name === "string" ? params.name : "";
  const descripteur = PUBLIES[nom];
  const gestionnaire = outils[nom];

  if (!descripteur || !gestionnaire) {
    // Outil inconnu : erreur d'OUTIL, pas de protocole — le modèle doit pouvoir la lire et
    // se corriger, ce qu'une erreur de transport ne lui permet pas.
    return err(`Outil inconnu : ${nom || "(sans nom)"}.`) as unknown as Record<string, unknown>;
  }

  const args = normaliser(nom, (params.arguments ?? {}) as Record<string, unknown>);
  const fautes = validateArgs(descripteur.inputSchema, args);
  if (fautes.length > 0) {
    return err(`Arguments invalides pour ${nom} : ${fautes.join(" ")}`) as unknown as Record<
      string,
      unknown
    >;
  }

  return (await (gestionnaire as (a: unknown) => Promise<unknown>)(args)) as Record<
    string,
    unknown
  >;
}

/**
 * Sert une requête MCP déjà AUTHENTIFIÉE.
 *
 * L'origine, le pré-vol, le débit et l'identité sont traités en amont, dans `fetch` : ce
 * routeur ne voit que des appels admis.
 */
export async function servirMcp(
  request: Request,
  env: Env,
  origin: string | null,
): Promise<Response> {
  const repondre = (corps: unknown, status = 200) =>
    new Response(JSON.stringify(corps), {
      status,
      headers: { ...JSON_HEADERS, ...corsHeaders(origin) },
    });

  let message: JsonRpcMessage;
  try {
    message = parseMessage(await request.text());
  } catch (e) {
    const j = e as JsonRpcError;
    const code = j instanceof JsonRpcError ? j.code : PARSE_ERROR;
    const id = j instanceof JsonRpcError ? j.requestId : null;
    return repondre(errorResponse(id, code, j.message ?? "Requête illisible."));
  }

  // Une notification n'attend pas de réponse. `202` sans corps, quelle qu'elle soit :
  // `notifications/initialized` comme les autres.
  if (isNotification(message))
    return new Response(null, { status: 202, headers: corsHeaders(origin) });

  const id = message.id ?? null;
  const outils = construireOutils(env);

  try {
    switch (message.method) {
      case "initialize": {
        const demandee = (message.params?.protocolVersion ?? "") as string;
        const negociee = VERSIONS.includes(demandee as (typeof VERSIONS)[number])
          ? demandee
          : VERSIONS[0];
        return repondre(
          resultResponse(id, {
            protocolVersion: negociee,
            // `listChanged: false` — et non l'absence de la capacité : le serveur DÉCLARE
            // qu'il ne notifiera jamais, plutôt que de laisser le client le supposer. Sous
            // `2026-07-28`, l'annoncer `true` obligerait à servir `subscriptions/listen`.
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
            instructions: INSTRUCTIONS,
          }),
        );
      }
      case "ping":
        return repondre(resultResponse(id, {}));
      case "tools/list":
        return repondre(resultResponse(id, { tools: descripteurs() }));
      case "tools/call":
        return repondre(resultResponse(id, await appeler(outils, message)));
      default:
        return repondre(
          errorResponse(id, METHOD_NOT_FOUND, `Méthode inconnue : ${message.method}.`),
          404,
        );
    }
  } catch (e) {
    // Ni l'URL, ni le corps, ni les arguments : le jeton voyage dans le chemin et dans la
    // requête. On journalise la MÉTHODE et le NOM de l'erreur, rien d'autre.
    console.error(`mcp: ${message.method} a échoué (${(e as Error).name})`);
    return repondre(errorResponse(id, INTERNAL_ERROR, "Erreur interne."), 200);
  }
}

export { INVALID_REQUEST };
