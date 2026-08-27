// Contrôle d'accès de l'endpoint MCP — jetons partagés, vérifiés AVANT le Durable Object.
//
// TROIS porteurs acceptés, parce qu'aucun ne couvre tous les clients :
//   - `?key=<jeton>` — LA FORME DU CONNECTEUR claude.ai. Mesurée, pas supposée : le
//     segment de chemin a ÉCHOUÉ en pratique (« Impossible de joindre ») alors qu'une
//     session complète y passe en curl, tandis que `?key=` a fonctionné du premier coup ;
//   - `Authorization: Bearer <jeton>` — clients maîtrisés : Claude Code, évals, veille CI,
//     et tout backend qui ouvre LUI-MÊME sa session MCP (le clavardage de Pallas Athéna) ;
//   - segment de chemin `/mcp/<jeton>` — conservé et testé, mais la forme de PERSONNE
//     aujourd'hui. Le slash final DOIT rester toléré : son 404 a déjà poussé le
//     connecteur vers la découverte OAuth, où il s'est coincé irréversiblement.
// Le segment de chemin est retiré avant de servir : McpAgent.serve("/mcp") n'apparie
// que le chemin de montage exact.
//
// DEUX SECRETS, DES DROITS IDENTIQUES, ET UNE SEULE RAISON : LA RÉVOCATION.
// `MCP_TOKEN` sert le connecteur claude.ai ; `MCP_TOKEN_ATHENA` sert le clavardage de
// Pallas Athéna. Le second n'ouvre AUCUN outil de plus — les dix répondent aux deux. Ils
// sont distincts pour qu'un porteur se retire SEUL : faire tourner celui de claude.ai ne
// doit pas éteindre le cabinet, ni l'inverse. Même modèle que le connecteur jumeau
// (jurisprudence, §19 de sa spécification), et même discipline : on ne journalise ni ne
// renvoie JAMAIS lequel des deux a servi — les deux refus sont le même 404.
//
// FERMÉ PAR DÉFAUT (2026-08-27, aligné sur le jumeau). Aucun secret configuré ⇒ TOUT est
// refusé. La tentation serait de lire « rien à comparer, donc on laisse passer » : c'est le
// défaut ouvert par omission, et c'est le contrôle « POST sans jeton -> 404 » des évals qui
// l'interdit. CE QUE ÇA COÛTE, ET QU'IL FAUT SAVOIR AVANT D'EN AVOIR BESOIN :
//   - la soupape R8 n'est plus UNE commande. Rouvrir l'endpoint — le seul geste qui ait
//     débloqué le connecteur claude.ai irrémédiablement coincé du 2026-07-25 — c'est
//     désormais `npx wrangler secret list` PUIS supprimer TOUS les `MCP_TOKEN*`. En oublier
//     un seul laisse l'endpoint FERMÉ pendant qu'on croit l'avoir rouvert, et le connecteur
//     continue de creuser son trou OAuth pendant qu'on cherche ailleurs ;
//   - `npx wrangler dev` seul ne sert plus /mcp : il faut désormais
//     `npx wrangler dev --var MCP_TOKEN:… --var MCP_TOKEN_ATHENA:…` ;
//   - remède de niveau code, plus rapide que tout le reste : `npx wrangler rollback`.
//
// UN REFUS RÉPOND 404, JAMAIS 401 : un 401 (a fortiori avec `WWW-Authenticate`) annonce
// un serveur MCP et déclenche la découverte OAuth côté client. Ici on veut que l'endpoint
// n'existe pas pour qui n'a pas le jeton. Même posture que /admin/backfill-vectors.
// Ce fichier ne fabrique donc AUCUNE réponse : il rend `null`, et src/index.ts en fait un
// 404 nu. CONSÉQUENCE À CONNAÎTRE, et elle vaut pour tout client À ÉTAT : le transport rend
// lui aussi 404 sur une session qu'il ne détient plus, donc un 404 est AMBIGU — jeton
// refusé OU session périmée. Le client de Pallas Athéna purge sa session sur 404 ; un jeton
// révoqué s'y présentera donc comme un battement de session, visible mais mal diagnostiqué.
// Trancher au curl, jamais au jugé. (Le connecteur jumeau, lui, refuse en 401 et n'a pas
// cette ambiguïté — c'est la contrepartie assumée de la posture 404.)
//
// La vérification est faite dans le handler de module, donc AVANT toute instanciation du
// Durable Object : un appel non autorisé ne coûte ni session DO, ni D1, ni Workers AI.

interface EnvWithSecrets extends Env {
  MCP_TOKEN?: string;
  MCP_TOKEN_ATHENA?: string;
}

const MOUNT = "/mcp";
const PREFIX = `${MOUNT}/`;
/**
 * Paramètre de requête : c'est LA forme employée par le connecteur claude.ai en
 * production (les autres n'ont pas survécu à son formulaire). Retiré de l'URL avant de
 * servir. Ordre de bascule impératif : poser cette URL sur le connecteur AVANT d'armer
 * le secret (l'ordre inverse en a détruit un le 2026-07-25).
 */
const QUERY_KEY = "key";

/**
 * Slash final purement cosmétique : les clients en ajoutent (le connecteur claude.ai
 * normalise l'URL saisie). `/mcp/` et `/mcp/<jeton>/` DOIVENT se comporter comme leurs
 * formes sans slash — sinon le refus 404 pousse le client vers la découverte OAuth,
 * qui échoue ensuite sur l'enregistrement dynamique (constaté en production, 2026-07-23).
 */
function trimTrailingSlash(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}

/**
 * Comparaison à temps constant. `===` sur des chaînes sort au premier octet différent,
 * ce qui laisse fuir le préfixe correct octet par octet. La longueur, elle, fuit —
 * c'est le compromis habituel et il est sans portée sur des jetons de longueur fixe.
 * (Le jumeau compare des empreintes SHA-256, ce qui neutralise aussi la longueur ; l'adopter
 * ici rendrait `gateMcp` asynchrone et toucherait src/index.ts sur le chemin chaud. Suite
 * possible, pas une urgence : la longueur de ces jetons est fixe.)
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Jeton porté par l'en-tête Authorization, ou null. */
function bearerOf(request: Request): string | null {
  const raw = request.headers.get("Authorization");
  if (!raw) return null;
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return m ? m[1].trim() : null;
}

/**
 * `decodeURIComponent` LÈVE sur un pourcentage malformé (`/mcp/%zz`). Tant que la
 * comparaison court-circuitait, l'exception n'était atteinte que par intermittence et
 * remontait non rattrapée, donc en 500. La boucle sans court-circuit ci-dessous décode
 * désormais systématiquement : un refus doit rester un 404, le seul statut dont on ait
 * mesuré l'effet sur un client MCP.
 */
function decodeOrNull(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * Les secrets admis, dans l'ordre. Tableau LITTÉRAL, comme chez le jumeau : ajouter un
 * client est une ligne ici plus un `wrangler secret put`, et non une convention de nom
 * balayée sur `env` — un nom mal orthographié se poserait alors sans erreur et n'ouvrirait
 * rien, ce qui est exactement le genre de panne qu'on cherche du mauvais côté.
 *
 * `Env` est GÉNÉRÉ par wrangler à partir de wrangler.jsonc : les secrets n'y figurent pas,
 * d'où `EnvWithSecrets`.
 *
 * FERMÉ PAR DÉFAUT : liste vide ⇒ la boucle d'appariement ne trouve rien ⇒ tout est refusé.
 */
function secretsOf(env: Env): string[] {
  const e = env as EnvWithSecrets;
  return [e.MCP_TOKEN, e.MCP_TOKEN_ATHENA]
    .map((s) => s?.trim())
    .filter((s): s is string => s !== undefined && s.length > 0);
}

/**
 * Autorise (ou non) un appel sous /mcp.
 *
 * Retourne la requête à servir — URL normalisée sur le chemin de montage, segment-jeton
 * retiré, chaîne de requête préservée — ou `null` si l'appel doit repartir en 404.
 */
export function gateMcp(request: Request, url: URL, env: Env): Request | null {
  const attendus = secretsOf(env);
  const path = trimTrailingSlash(url.pathname);
  const onMount = path === MOUNT;
  // Un SEUL segment après le point de montage : /mcp/<jeton>, rien de plus profond.
  const segment =
    path.startsWith(PREFIX) && !path.slice(PREFIX.length).includes("/")
      ? path.slice(PREFIX.length)
      : null;

  const query = url.searchParams.get(QUERY_KEY);
  const presentes: (string | null)[] = [
    bearerOf(request),
    segment === null ? null : decodeOrNull(segment),
    query,
  ];

  // AUCUN COURT-CIRCUIT, c'est l'exigence centrale : la double boucle parcourt TOUS les
  // secrets et TOUS les porteurs même après un appariement. Un `.some()` ou une chaîne de
  // `||` sortirait au premier secret qui apparie, et le TEMPS DE RÉPONSE dirait alors LEQUEL
  // a été présenté — c'est-à-dire QUEL CLIENT ON EST, à un tiers qui sonde. La branche porte
  // sur la FORME DE LA REQUÊTE (ce porteur est-il présent ?), jamais sur le secret : elle ne
  // révèle rien de plus que ce que l'appelant a lui-même envoyé.
  let autorise = false;
  for (const attendu of attendus) {
    for (const presente of presentes) {
      if (presente !== null && safeEqual(presente, attendu)) autorise = true;
    }
  }
  if (!autorise) return null;

  // Normalisation : le point de montage exact, sans le jeton — McpAgent.serve("/mcp")
  // n'apparie que ce chemin, et le secret n'a rien à faire dans l'URL transmise ensuite.
  // La ligne suivante rend la requête ORIGINALE (chemin chaud : tout POST Bearer sur /mcp).
  // Ne pas la « nettoyer » : reconstruire un Request autour d'un flux de corps pour rien
  // est un changement de comportement sur le trajet de TOUS les clients.
  if (onMount && query === null) return request;
  const normalized = new URL(url);
  normalized.pathname = MOUNT;
  normalized.searchParams.delete(QUERY_KEY);
  return new Request(normalized.toString(), request);
}
