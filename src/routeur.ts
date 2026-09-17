/**
 * Routeur MCP bâti sur le socle — le chemin qui remplacera `McpAgent`.
 *
 * Il ne réimplémente rien : enveloppe JSON-RPC, validateur, négociation de version,
 * validation d'en-têtes et indices de cache viennent de `@poirierlavoie/socle-juridique`.
 * Ce fichier ne porte que ce qui est PROPRE à ce connecteur — son identité, ses
 * descripteurs, et la normalisation des arguments coercés.
 *
 * Tant que `SOCLE !== "true"`, il n'est pas atteint. Les deux chemins appellent LES MÊMES
 * gestionnaires (`construireOutils`) : il n'y a pas deux comportements à tenir
 * synchronisés, seulement deux façons d'y arriver.
 */

import {
  avecCache,
  avecServerInfo,
  complet,
  corsHeaders,
  err,
  errorResponse,
  estModerne,
  HEADER_MISMATCH,
  INTERNAL_ERROR,
  isNotification,
  JsonRpcError,
  type JsonRpcMessage,
  lireMeta,
  METHOD_NOT_FOUND,
  negocier,
  PARSE_ERROR,
  parseMessage,
  resultatDecouverte,
  resultResponse,
  validateArgs,
  validerEntetes,
  versionAbsenteAdmise,
} from "@poirierlavoie/socle-juridique";

import { PUBLIES } from "./schemas";
import { CAPACITES, INSTRUCTIONS, SERVER_INFO, VERSIONS } from "./serveur";
import { construireOutils, type Registre } from "./tools";

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

/** Une heure : le registre ne bouge qu'au déploiement. */
const TTL_LISTE = 3_600_000;

/**
 * Ce dépôt sert-il les clients antérieurs à `2025-06-18` ?
 *
 * NON. La spécification n'ouvre que deux branches pour une requête sans en-tête de
 * version : la traiter comme `2025-03-26`, ou la refuser. On refuse — et surtout, on ne la
 * promeut JAMAIS en `2025-06-18`, ce serait inventer une troisième branche que personne
 * n'implémente en face. `initialize` reste exempté, voir `versionAbsenteAdmise`.
 */
const SERT_AVANT_2025_06_18 = false;

/**
 * Champs que Zod CONVERTISSAIT et que le validateur du socle REFUSERAIT.
 *
 * `z.coerce.string()` acceptait `article: 1457` et en faisait `"1457"`. Le schéma PUBLIÉ
 * annonce pourtant `"type":"string"` depuis toujours — la coercition n'y a jamais paru — et
 * les modèles envoient tout de même des nombres. Miser sur une description plus impérative
 * serait parier qu'une phrase réussit là où le type a échoué. On normalise donc avant de
 * valider, par une table EXPLICITE : rien n'est converti par surprise.
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
    out[champ] = Array.isArray(v)
      ? v.map((x) => (typeof x === "string" ? x : String(x)))
      : typeof v === "string"
        ? v
        : String(v);
  }
  return out;
}

/**
 * Descripteurs de `tools/list`.
 *
 * ⚠ L'ORDRE EST CELUI D'INSERTION, et c'est DÉLIBÉRÉMENT le seul tri appliqué. La révision
 *   `2026-07-28` recommande un ordre DÉTERMINISTE — ce que l'ordre d'insertion est déjà —
 *   et n'exige nulle part l'ordre alphabétique. Trier par nom déplacerait
 *   `legislation_find_relevant`, que les `INSTRUCTIONS` désignent comme point de départ, et
 *   ferait bouger la page publique qui dérive du même registre. On gagnerait un tri qui n'est
 *   demandé par personne, on perdrait la pédagogie de l'ordre.
 */
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
 * L'origine, le pré-vol, le débit et l'identité sont traités en amont, dans `fetch`.
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

  if (isNotification(message)) {
    return new Response(null, { status: 202, headers: corsHeaders(origin) });
  }

  const id = message.id ?? null;
  const meta = lireMeta(message.params);

  // ── Version ────────────────────────────────────────────────────────────────────────────
  const entete = request.headers.get("MCP-Protocol-Version");
  let version: string;

  if (entete === null) {
    if (!versionAbsenteAdmise(message.method, SERT_AVANT_2025_06_18)) {
      return repondre(
        errorResponse(id, HEADER_MISMATCH, "En-tête « MCP-Protocol-Version » manquant."),
        400,
      );
    }
    // Seul `initialize` arrive ici : il négocie par son corps, comme une poignée héritée.
    version = (message.params?.protocolVersion as string) ?? VERSIONS[0];
  } else {
    const n = negocier(entete, VERSIONS);
    if ("erreur" in n) return repondre({ jsonrpc: "2.0", id, error: n.erreur }, 400);
    version = n.version;
  }

  const moderne = estModerne(version);

  // Sous une révision moderne SEULEMENT : les en-têtes doivent refléter le corps. Les
  // révisions antérieures n'exigent ni `Mcp-Method` ni `Mcp-Name` ; les réclamer là-bas
  // refuserait des clients conformes.
  //
  // ⚠ `initialize` EN EST EXCLU, même sous un en-tête moderne. La révision `2026-07-28` a
  //   SUPPRIMÉ la poignée : un client qui l'appelle relève par définition de l'ère héritée,
  //   quelle que soit la version qu'il annonce. La spécification le dit d'ailleurs pour un
  //   serveur bi-ère : « an `initialize` request selects legacy semantics ». Lui réclamer
  //   `Mcp-Method` reviendrait à exiger d'une poignée héritée un en-tête que son ère ne
  //   connaît pas.
  if (moderne && message.method !== "initialize") {
    const faute = validerEntetes(request.headers, {
      method: message.method,
      params: message.params,
      versionMeta: meta.protocolVersion,
    });
    if (faute) return repondre(errorResponse(id, HEADER_MISMATCH, faute), 400);
  }

  /** N'habille de `resultType` et des indices de cache que sous une révision moderne. */
  const resultat = (brut: Record<string, unknown>, cachable?: { ttlMs: number }) => {
    if (!moderne) return resultResponse(id, brut);
    const avecType = complet(brut);
    return resultResponse(id, cachable ? avecCache(avecType, cachable.ttlMs, "public") : avecType);
  };

  const outils = construireOutils(env);

  try {
    switch (message.method) {
      case "server/discover":
        // Obligatoire sous `2026-07-28`. On le sert aussi aux révisions antérieures : elles
        // ne le demandent pas, mais le refuser n'apporterait rien à personne.
        return repondre(
          resultResponse(
            id,
            resultatDecouverte({
              supportedVersions: VERSIONS,
              capabilities: CAPACITES,
              serverInfo: SERVER_INFO,
              instructions: INSTRUCTIONS,
              ttlMs: TTL_LISTE,
            }),
          ),
        );

      case "initialize": {
        // Imitation de poignée : on répond comme avant, et on ne retient RIEN. Aucun état,
        // aucune session, aucun `Mcp-Session-Id` frappé ni renvoyé.
        const negociee = VERSIONS.includes(version as (typeof VERSIONS)[number])
          ? version
          : VERSIONS[0];
        return repondre(
          resultResponse(id, {
            protocolVersion: negociee,
            capabilities: CAPACITES,
            serverInfo: SERVER_INFO,
            instructions: INSTRUCTIONS,
          }),
        );
      }

      case "ping":
        return repondre(resultat({}));

      case "tools/list":
        return repondre(resultat({ tools: descripteurs() }, { ttlMs: TTL_LISTE }));

      case "tools/call": {
        const r = await appeler(outils, message);
        // Un résultat d'outil porte `resultType` sous une révision moderne, mais AUCUN
        // indice de cache : `tools/call` n'est pas cachable.
        return repondre(resultat(r));
      }

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

export { avecServerInfo };
