/**
 * Identité du serveur et versions servies — partagées par les DEUX chemins.
 *
 * `INSTRUCTIONS` et `SERVER_INFO` vivaient dans `src/index.ts`, où seul `McpAgent` les
 * lisait. Le routeur du socle doit rendre exactement les mêmes : les déplacer ici est ce
 * qui garantit qu'un seul texte est servi, quel que soit le chemin emprunté.
 */

/**
 * Versions du protocole servies, la plus élevée EN TÊTE.
 *
 * ⚠ `2025-03-26` EST ENCORE SERVIE, et son retrait attend une MESURE. S3 la retire, mais
 *   la §11 marche 3 subordonne ce retrait au constat qu'aucun client ne l'annonce — constat
 *   qui passe par `clientInfo` dans le plan technique, donc par la phase 4. Servir une
 *   version de trop ne coûte rien ; en retirer une que quelqu'un emploie casse un client.
 *
 * ⚠ Une requête SANS en-tête de version est REFUSÉE (sauf `initialize`), et non promue en
 *   `2025-03-26`. Les deux positions sont compatibles : on sert la révision à qui
 *   l'ANNONCE, sans la supposer chez qui se tait.
 */
export const VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"] as const;

/**
 * Capacités annoncées, à `initialize` comme à `server/discover`.
 *
 * ⚠ `listChanged` RESTE FAUX, et ce n'est pas une omission. Sous `2026-07-28`,
 *   `subscriptions/listen` est le SEUL véhicule des notifications de changement, et il
 *   n'est pas servi. Annoncer `true` promettrait un signal qui ne viendrait jamais ; le
 *   déclarer FAUX, plutôt que d'omettre la capacité, dit au client de ne pas l'attendre.
 */
export const CAPACITES = { tools: { listChanged: false } } as const;

/**
 * Le nom porte la JURIDICTION, pas le transport : c'est la chaîne qu'un hôte affiche dans
 * son sélecteur, et celle que le connecteur jumeau désigne à ses modèles. Il disait
 * « employer le connecteur Législation du Québec » face à un serveur qui s'annonçait
 * « MCP Legislation », et le renvoi ne se faisait pas.
 */
export const PACKAGE_NAME = "mcp-legislation";

export const SERVER_INFO = {
  name: "Législation du Québec et du Canada",
  version: "0.2.0",
} as const;

/**
 * Description publique canonique — partagée avec la fiche SEP-2127 (`/mcp/server-card`)
 * et épinglée contre `package.json`, `plugin.json` et `gemini-extension.json` dans
 * `tests/catalogue.test.mjs`. Aucun décompte vivant (R10).
 */
export const PUBLIC_DESCRIPTION =
  "Texte officiel en lecture seule de lois et règlements du Québec et du Canada " +
  "(en français et en anglais), hiérarchie complète des divisions et recherche hybride " +
  "lexicale et sémantique.";

/** URI canonique du schéma SEP-2127 (MCP Server Cards). */
export const SERVER_CARD_SCHEMA =
  "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json";

/**
 * Fiche de découverte HTTP MCP (SEP-2127) — PURE, sans accès à `env` ni à aucun secret.
 *
 * Toutes les valeurs d'identité et de protocole dérivent de `PACKAGE_NAME`, `SERVER_INFO`,
 * `PUBLIC_DESCRIPTION` et `VERSIONS` (R10 : aucune copie littérale).
 */
export function carteServeur() {
  return {
    $schema: SERVER_CARD_SCHEMA,
    name: `ca.poirierlavoie.legislation/${PACKAGE_NAME}`,
    title: SERVER_INFO.name,
    version: SERVER_INFO.version,
    description: PUBLIC_DESCRIPTION,
    websiteUrl: "https://legislation.poirierlavoie.ca/",
    repository: {
      url: "https://github.com/jpoirierlavoie/MCP-Legislation",
      source: "github",
    },
    remotes: [
      {
        type: "streamable-http",
        url: "https://legislation.poirierlavoie.ca/mcp",
        supportedProtocolVersions: [...VERSIONS],
        headers: [
          {
            name: "Authorization",
            description: "Jeton d'accès de l'instance (« Bearer <jeton> »).",
            isRequired: true,
            isSecret: true,
          },
        ],
      },
    ],
  };
}

/**
 * Orientation générale renvoyée à l'initialisation.
 *
 * CETTE CHAÎNE EST UNE SURFACE SERVIE, et elle n'est gardée par aucun test de parité : elle
 * ne vit ni dans `catalogue.json` ni dans `src/tools.ts`, donc R10 ne la voit pas. Trois
 * défauts mesurés le 2026-09-17, sur le point d'ouvrir l'endpoint au public, ont imposé sa
 * réécriture — chacun invisible parce qu'il produisait une NON-ACTION plutôt qu'une erreur :
 *
 *  1. elle annonçait « tarifs du Québec » et taisait les 18 textes FÉDÉRAUX servis. Un
 *     modèle interrogé sur la faillite écartait le serveur et répondait de mémoire ;
 *  2. elle envoyait vers `get_structure / get_division / get_article` — des noms qui
 *     N'EXISTENT PAS (tout est `legislation_*`). Avec plusieurs serveurs branchés, l'appel
 *     pouvait partir chez un voisin et rendre un texte étranger au corpus ;
 *  3. elle ne disait nulle part que le corpus est une SÉLECTION FERMÉE, ni que le service
 *     ne donne aucun conseil juridique — or l'avertissement du cabinet ne voyage que sur la
 *     page publique, jamais jusqu'au modèle.
 */
export const INSTRUCTIONS =
  "Texte officiel de lois et règlements du QUÉBEC et du CANADA (fédéral) : codes, lois, " +
  "règles de procédure et tarifs, en français et en anglais. " +
  "Pour partir d'un problème concret, commencer par legislation_find_relevant ; pour explorer " +
  "le corpus, legislation_list_laws. Cibler ensuite avec legislation_get_structure → " +
  "legislation_get_division / legislation_get_article. " +
  "PORTÉE : le corpus est une SÉLECTION FERMÉE de textes, pas tout le droit applicable — il ne " +
  "contient ni jurisprudence, ni versions antérieures d'un article, ni l'ancien Code de " +
  "procédure civile (c. C-25). Une absence de résultat ne signifie donc JAMAIS qu'aucune règle " +
  "n'existe : elle signifie que le texte n'est pas dans ce corpus. " +
  "L'aide au repérage est heuristique et ne détermine pas le droit applicable ; seul le texte " +
  "officiel du publieur fait foi, les dates de consolidation peuvent accuser un retard sur lui, " +
  "et ce service ne fournit AUCUN conseil juridique.";
