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
 * ⚠ CETTE LISTE N'EST PAS ENCORE CELLE DE S3. La marche 3 y ajoutera `2026-07-28` et
 *   `2025-11-25`, derrière le pont de la §3.3 — « déployer le pont AVANT de retirer quoi
 *   que ce soit ». Pour l'heure elle reproduit ce que le SDK négocie, afin que la bascule
 *   vers le routeur du socle ne change pas de version au passage.
 */
export const VERSIONS = ["2025-06-18", "2025-03-26"] as const;

/**
 * Le nom porte la JURIDICTION, pas le transport : c'est la chaîne qu'un hôte affiche dans
 * son sélecteur, et celle que le connecteur jumeau désigne à ses modèles. Il disait
 * « employer le connecteur Législation du Québec » face à un serveur qui s'annonçait
 * « MCP Legislation », et le renvoi ne se faisait pas.
 */
export const SERVER_INFO = {
  name: "Législation du Québec et du Canada",
  version: "0.2.0",
} as const;

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
