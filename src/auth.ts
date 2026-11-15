// Contrôle d'accès de l'endpoint MCP — jetons partagés, vérifiés avant le routage MCP.
//
// TROIS porteurs acceptés, parce qu'aucun ne couvre tous les clients :
//   - `?key=<jeton>` — LA FORME DU CONNECTEUR claude.ai. Mesurée, pas supposée : le
//     segment de chemin a ÉCHOUÉ en pratique (« Impossible de joindre ») alors qu'une
//     session complète y passe en curl, tandis que `?key=` a fonctionné du premier coup ;
//   - `Authorization: Bearer <jeton>` — clients maîtrisés : Claude Code, évals, veille CI,
//     et tout backend compatible ;
//   - segment de chemin `/mcp/<jeton>` — conservé et testé, mais la forme de PERSONNE
//     aujourd'hui. Le slash final DOIT rester toléré : son 404 a déjà poussé le
//     connecteur vers la découverte OAuth, où il s'est coincé irréversiblement.
// Le segment de chemin est retiré avant de servir.
//
// DEUX SECRETS, DES DROITS IDENTIQUES, ET UNE SEULE RAISON : LA RÉVOCATION.
// `MCP_TOKEN` sert le connecteur claude.ai ; `MCP_TOKEN_VEILLE` sert la veille de
// consolidation en CI. Le second n'ouvre AUCUN outil de plus — les dix répondent aux deux.
// Ils sont distincts pour qu'un porteur se retire SEUL : faire tourner celui de claude.ai
// ne doit pas éteindre la surveillance mensuelle du corpus, ni l'inverse. Même modèle que
// le connecteur jumeau (jurisprudence, §19 de sa spécification), et même discipline : on ne
// journalise ni ne renvoie JAMAIS lequel des deux a servi — les deux refus sont le même 404.
//
// CHAQUE JETON A DEUX PORTEURS, ET PAS TROIS (2026-09-16). La CI a désormais SON jeton
// (secret GitHub + fichier local), et `MCP_TOKEN` est redescendu à deux porteurs (fichier
// local + URL du connecteur).
// `MCP_TOKEN_ATHENA` l'a précédé et a été RETIRÉ le 2026-09-16 : le clavardage de Pallas
// Athéna, son unique destinataire, avait été supprimé le 2026-09-02 (le cabinet est passé à
// un compte Claude for Work sous DPA).
//
// FERMÉ PAR DÉFAUT (2026-08-27, aligné sur le jumeau). Aucun secret configuré ⇒ `secretsAdmis`
// rend une liste vide et `ouvrir` rend `null` — donc 404 sur tout.
//
// Autre conséquence du défaut fermé :
//   - `npx wrangler dev` seul ne sert plus /mcp : il faut désormais
//     `npx wrangler dev --var MCP_TOKEN:… --var MCP_TOKEN_VEILLE:…`.
//
// UN REFUS RÉPOND 404, JAMAIS 401 : un 401 (a fortiori avec `WWW-Authenticate`) annonce
// un serveur MCP et déclenche la découverte OAuth côté client. Ici on veut que l'endpoint
// n'existe pas pour qui n'a pas le jeton. Même posture que /admin/backfill-vectors.

const MOUNT = "/mcp";
/**
 * Paramètre de requête : c'est LA forme employée par le connecteur claude.ai en
 * production (les autres n'ont pas survécu à son formulaire). Retiré de l'URL avant de
 * servir. Ordre de bascule impératif : poser cette URL sur le connecteur AVANT d'armer
 * le secret (l'ordre inverse en a détruit un le 2026-07-25).
 */
const QUERY_KEY = "key";

/**
 * Les secrets admis, dans l'ordre. Tableau LITTÉRAL, comme chez le jumeau : ajouter un
 * client est une ligne ici plus un `wrangler secret put`, et non une convention de nom
 * balayée sur `env` — un nom mal orthographié se poserait alors sans erreur et n'ouvrirait
 * rien, ce qui est exactement le genre de panne qu'on cherche du mauvais côté.
 *
 * FERMÉ PAR DÉFAUT : liste vide ⇒ `ouvrir` refuse tout en 404.
 */
export const NOMS_SECRETS = ["MCP_TOKEN", "MCP_TOKEN_VEILLE"] as const;

/**
 * La porte d'accès, DÉCLARÉE UNE FOIS, employée par le routeur du socle (`ouvrir`) ET par les tests.
 *
 * `tests/catalogue.test.mjs` lit `MOUNT`, `QUERY_KEY` et `NOMS_SECRETS` directement ici pour
 * ne pas dupliquer la liste. Un même littéral pilote désormais le runtime et la vérification.
 */
export const PORTE = {
  mount: MOUNT,
  queryKey: QUERY_KEY,
  nomsSecrets: NOMS_SECRETS,
  segmentBorne: true,
} as const;
