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
  avecServerInfo,
  type DescripteurOutil,
  err,
  listToolDescriptors,
  servirRequeteMcp,
  type ToolResult,
  validateArgs,
} from "@poirierlavoie/socle-juridique";

import { PUBLIES } from "./schemas";
import { CAPACITES, INSTRUCTIONS, SERVER_INFO, VERSIONS } from "./serveur";
import { construireOutils } from "./tools";

/** Une heure : le registre ne bouge qu'au déploiement. */
const TTL_LISTE = 3_600_000;

/**
 * Ce dépôt sert-il les clients antérieurs à `2025-06-18` ?
 *
 * OUI, et c'est COUPLÉ au fait que `2025-03-26` reste servie. La spécification n'ouvre que
 * deux branches pour une requête sans en-tête de version : la traiter comme `2025-03-26`
 * — permis seulement si l'on sert ces clients-là — ou la refuser, ce que S3 prescrit PARCE
 * QU'ELLE RETIRE `2025-03-26`.
 *
 * ⚠ NE PAS BASCULER CE DRAPEAU SANS RETIRER `2025-03-26` DE `VERSIONS`, ni l'inverse. Les
 *   deux vont ensemble. Les avoir découplés a fait rendre 400 à la veille mensuelle, qui
 *   n'envoie pas l'en-tête — deux fois dans la même journée, et la seconde fois pour ce
 *   motif-ci. Le retrait de `2025-03-26` attend de toute façon la mesure de `clientInfo`
 *   (phase 4) : c'est à ce moment-là que les deux basculeront, ensemble.
 *
 * Ce qu'on ne fait JAMAIS, dans les deux cas : promouvoir silencieusement l'absence
 * d'en-tête en `2025-06-18`. Ce serait inventer une troisième branche que personne
 * n'implémente en face.
 */
const SERT_AVANT_2025_06_18 = true;

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
  const champs = Object.hasOwn(COERCITIONS, nom) ? COERCITIONS[nom] : undefined;
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
const descripteurs = () =>
  listToolDescriptors(PUBLIES as unknown as Record<string, DescripteurOutil>);

async function appeler(env: Env, nomBrut: unknown, argsBruts: unknown): Promise<ToolResult> {
  const nom = typeof nomBrut === "string" ? nomBrut : "";
  const descripteur = Object.hasOwn(PUBLIES, nom) ? PUBLIES[nom] : undefined;
  const outils = construireOutils(env);
  const gestionnaire = Object.hasOwn(outils, nom) ? outils[nom] : undefined;

  if (!descripteur || !gestionnaire) {
    // Outil inconnu : erreur d'OUTIL, pas de protocole — le modèle doit pouvoir la lire et
    // se corriger, ce qu'une erreur de transport ne lui permet pas.
    return err(`Outil inconnu : ${nom || "(sans nom)"}.`);
  }

  const objet = argsBruts ?? {};
  if (typeof objet !== "object" || objet === null || Array.isArray(objet)) {
    return err("« arguments » doit être un objet.");
  }

  const args = normaliser(nom, objet as Record<string, unknown>);
  const fautes = validateArgs(descripteur.inputSchema, args);
  if (fautes.length > 0) {
    return err(`Arguments invalides pour ${nom} : ${fautes.join(" ")}`);
  }

  return (await (gestionnaire as (a: unknown) => Promise<unknown>)(args)) as ToolResult;
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
  return await servirRequeteMcp(request, {
    versions: VERSIONS,
    capabilities: CAPACITES,
    serverInfo: SERVER_INFO,
    instructions: INSTRUCTIONS,
    descripteurs,
    appeler: (nom, args) => appeler(env, nom, args),
    origin,
    sertAvant2025_06_18: SERT_AVANT_2025_06_18,
    ttlListeMs: TTL_LISTE,
    surErreur: (methode, e) => {
      // Ni l'URL, ni le corps, ni les arguments : le jeton voyage dans le chemin et dans la
      // requête. On journalise la MÉTHODE et le NOM de l'erreur, rien d'autre.
      console.error(`mcp: ${methode} a échoué (${e instanceof Error ? e.name : "inconnu"})`);
    },
  });
}

export { avecServerInfo };
