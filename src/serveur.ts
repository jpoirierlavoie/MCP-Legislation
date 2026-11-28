import {
  construireCarteServeur,
  construireRessourceProtegee,
  PORTEE_UNIVERSELLE,
} from "@poirierlavoie/mcp-socle";

export const VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"] as const;

export const CAPACITES = { tools: { listChanged: false } } as const;

export const PACKAGE_NAME = "mcp-legislation";

export const SERVER_INFO = {
  name: "Législation du Québec et du Canada",
  version: "2.2.5",
} as const;

export const PUBLIC_DESCRIPTION =
  "Texte officiel en lecture seule de lois, règlements, directives de pratique et orientations AMF " +
  "du Québec et du Canada (français et anglais, certains PDF en français seulement), hiérarchie " +
  "complète des divisions et recherche hybride lexicale et sémantique.";

const ORIGINE_PORTAIL_DEFAUT = "https://acces.poirierlavoie.ca";
export const META_RESSOURCE_OAUTH_URL =
  "https://legislation.poirierlavoie.ca/.well-known/oauth-protected-resource/mcp/oauth";
export const SCOPE_OAUTH = "legislation tous";

export function carteServeur() {
  return construireCarteServeur({
    name: `ca.poirierlavoie.legislation/${PACKAGE_NAME}`,
    title: SERVER_INFO.name,
    version: SERVER_INFO.version,
    description: PUBLIC_DESCRIPTION,
    websiteUrl: "https://legislation.poirierlavoie.ca/",
    repositoryUrl: "https://github.com/jpoirierlavoie/MCP-Legislation",
    remoteUrl: "https://legislation.poirierlavoie.ca/mcp",
    oauthRemoteUrl: "https://legislation.poirierlavoie.ca/mcp/oauth",
    supportedProtocolVersions: VERSIONS,
    authDescription:
      "Jeton individuel de titulaire (« Bearer <jeton> ») ou connexion OAuth 2.1 sur /mcp/oauth via acces.poirierlavoie.ca.",
  });
}

export function ressourceProtegeeOAuth(originePortail?: string) {
  const serveur = (originePortail ?? "").trim() || ORIGINE_PORTAIL_DEFAUT;
  return construireRessourceProtegee({
    resource: "https://legislation.poirierlavoie.ca/mcp/oauth",
    authorizationServers: [serveur],
    scopesSupported: [PORTEE_UNIVERSELLE, "legislation"],
    resourceDocumentation: "https://legislation.poirierlavoie.ca/",
  });
}

export const INSTRUCTIONS =
  "Texte officiel de lois et règlements du QUÉBEC et du CANADA (fédéral) : codes, lois, " +
  "règles de procédure, tarifs, directives de pratique judiciaire (QCCS/QCCQ) et orientations " +
  "administratives (AMF ; non législatives et parfois en français seulement), en français et en anglais. " +
  "Pour partir d'un problème concret, commencer par find_relevant ; pour explorer " +
  "le corpus, list_laws. Cibler ensuite avec get_structure → " +
  "get_division / get_article. " +
  "Par défaut, list_laws, find_relevant et search_text interrogent le domaine 'core' tout en signalant " +
  "en radar les correspondances dans les 7 domaines sectoriels en quarantaine (ouvrables via domains=['core', …] ou ['all']), " +
  "tandis que les outils directs (get_article, resolve_reference…) couvrent toujours tout le corpus. " +
  "PORTÉE : le corpus est une SÉLECTION FERMÉE de textes, pas tout le droit applicable — il ne " +
  "contient ni jurisprudence, ni versions antérieures d'un article, ni l'ancien Code de " +
  "procédure civile (c. C-25). Une absence de résultat ne signifie donc JAMAIS qu'aucune règle " +
  "n'existe : elle signifie que le texte n'est pas dans ce corpus. " +
  "L'aide au repérage est heuristique et ne détermine pas le droit applicable ; seul le texte " +
  "officiel du publieur fait foi, les dates de consolidation peuvent accuser un retard sur lui, " +
  "et ce service ne fournit AUCUN conseil juridique.";
