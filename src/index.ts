import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";

import { gateMcp } from "./auth";
import { handleBackfill } from "./backfill";
import { renderSite } from "./site";
import { registerTools } from "./tools";

/**
 * Serveur MCP « MCP Legislation » (paquet mcp-legislation).
 *
 * Expose les outils legislation_* (PLAN §3), en lecture seule sur D1. Transport HTTP
 * streamable sur POST /mcp.
 */
/**
 * Orientation générale renvoyée à l'initialisation (plan-couche-decouverte §6.2).
 * Deuxième canal de fiabilité après les sorties d'outils : il énonce le patron en deux
 * temps (s'orienter, puis extraire) et le caractère heuristique du repérage.
 */
/**
 * CETTE CHAÎNE EST UNE SURFACE SERVIE, et elle n'est gardée par aucun test : elle ne vit ni
 * dans `catalogue.json` ni dans `src/tools.ts`, donc la parité R10 ne la voit pas. Trois
 * défauts mesurés le 2026-09-17, sur le point d'ouvrir l'endpoint au public, ont imposé sa
 * réécriture — chacun invisible parce qu'il produisait une NON-ACTION plutôt qu'une erreur :
 *
 *  1. elle annonçait « tarifs du Québec » et taisait les 18 textes FÉDÉRAUX servis. Un modèle
 *     interrogé sur la faillite écartait le serveur et répondait de mémoire ;
 *  2. elle envoyait vers `get_structure / get_division / get_article` — des noms qui
 *     N'EXISTENT PAS (tout est `legislation_*`). Avec plusieurs serveurs branchés, l'appel
 *     pouvait partir chez un voisin et rendre un texte étranger au corpus ;
 *  3. elle ne disait nulle part que le corpus est une SÉLECTION FERMÉE, ni que le service ne
 *     donne aucun conseil juridique — or l'avertissement du cabinet ne voyage que sur la page
 *     publique (`catalogue.avertissement`, lu par src/site.ts seul), jamais jusqu'au modèle.
 */
const INSTRUCTIONS =
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

export class QclawMCP extends McpAgent {
  server = new McpServer(
    // Le nom porte la JURIDICTION, pas le transport : c'est la chaîne qu'un hôte affiche dans
    // son sélecteur et que le connecteur jumeau (Jurisprudence du Canada) désigne à ses
    // modèles — il disait « employer le connecteur Législation du Québec » face à un serveur
    // qui s'annonçait « MCP Legislation », et le renvoi ne se faisait pas.
    { name: "Législation du Québec et du Canada", version: "0.2.0" },
    { instructions: INSTRUCTIONS },
  );

  async init() {
    registerTools(this.server, this.env);
  }
}

/**
 * Sert la page publique, avec cache d'arête.
 *
 * La CLÉ DE CACHE EST FIXE ET SYNTHÉTIQUE : sans cela, `/?utm_source=…` ou tout autre
 * paramètre arbitraire créerait une entrée distincte — donc un rendu D1 de plus — pour
 * chaque variante d'URL croisée par un robot. Le corpus ne bouge que deux fois l'an ;
 * le cache n'est pas un confort mais la protection du coût de lecture (le décompte
 * d'articles balaie toute la table).
 *
 * EN PRODUCTION, UN DÉPLOIEMENT NE RAFRAÎCHIT PAS LA PAGE : l'entrée d'arête vit sa
 * `s-maxage` (900 s) jusqu'au bout. Et `cf.token` n'a PAS le droit « Cache Purge »
 * (mesuré : l'API répond 10000 Authentication error), donc il n'existe aucun moyen de
 * forcer la main — on attend, c'est tout. Ne jamais conclure à un déploiement raté sur
 * une page inchangée : lire l'en-tête `Age:`, il dit exactement combien il reste.
 *
 * EN DÉVELOPPEMENT LOCAL, C'EST UN PIÈGE : miniflare persiste `caches.default` dans
 * `.wrangler/state/v3/cache`, et la clé étant fixe, une page mise en cache SURVIT aux
 * rechargements à chaud ET aux redémarrages de `wrangler dev`. On modifie src/site.ts,
 * le serveur recharge, et la page servie reste l'ancienne — sans aucun signal. Pour
 * itérer sur la page : arrêter `wrangler dev`, supprimer `.wrangler/state/v3/cache`
 * (JAMAIS `.../d1`, qui porte le corpus local), redémarrer.
 */
const CACHE_KEY = "https://legislation.poirierlavoie.ca/__page";

async function servePage(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const cache = caches.default;
  const cached = await cache.match(CACHE_KEY);
  if (cached) {
    return request.method === "HEAD"
      ? new Response(null, { status: cached.status, headers: cached.headers })
      : cached;
  }
  const html = await renderSite(env.DB, env);
  const res = new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=900, stale-while-revalidate=3600",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      // Rien n'est chargé depuis un tiers : CSS et JS sont en ligne, aucune police, aucun CDN.
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
        "img-src data:; base-uri 'none'; form-action 'none'",
    },
  });
  ctx.waitUntil(cache.put(CACHE_KEY, res.clone()));
  return request.method === "HEAD"
    ? new Response(null, { status: res.status, headers: res.headers })
    : res;
}

/**
 * Limitation de débit, DANS le Worker (le WAF de zone n'est pas atteignable — même constat
 * que le connecteur jumeau). Appliquée AVANT le contrôle d'accès, donc un flot non
 * authentifié est coupé lui aussi.
 *
 * FAIL OPEN DÉLIBÉRÉ, et l'asymétrie est le point : l'AUTHENTIFICATION échoue FERMÉE
 * (aucun secret configuré => tout est refusé), tandis que la limitation ne protège que le
 * COÛT. Échouer fermé sur un compteur indisponible rendrait le serveur inutilisable pour
 * préserver une facture : le mauvais arbitrage. Sans le binding (wrangler dev), on passe.
 */
async function debitAcceptable(request: Request, env: Env): Promise<boolean> {
  // Typé par wrangler types depuis wrangler.jsonc. La garde de nullité reste : en local
  // (wrangler dev) le binding n'est pas fourni, et le type ne le dit pas.
  const limiteur = env.RATE_LIMITER;
  if (!limiteur) return true;
  // L'IP vue par Cloudflare. Clé imparfaite — deux clients derrière une même sortie NAT
  // partagent le budget — mais c'est la seule disponible sans plan Business, et le jeton
  // ne doit JAMAIS servir de clé : il finirait dans un compteur, donc dans des journaux.
  const ip = request.headers.get("CF-Connecting-IP") ?? "sans-ip";
  try {
    const { success } = await limiteur.limit({ key: ip });
    return success;
  } catch {
    return true;
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      // Page publique (src/site.ts). Posture assumée : elle décrit le corpus, les outils
      // et les aides au repérage. Elle ne contient JAMAIS le jeton et n'appelle jamais
      // /mcp — elle ne le pourrait pas, src/auth.ts refusant en 404 sans porteur.
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
      }
      return servePage(request, env, ctx);
    }
    // Accès sous jeton partagé (src/auth.ts). Vérifié ICI, donc avant toute instanciation
    // du Durable Object : un appel non autorisé ne coûte ni session DO, ni D1, ni Workers AI.
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      // Avant la porte : un flot non authentifié est coupé lui aussi. 429 et non 404 —
      // ici on ne cache pas l'endpoint, on refuse une cadence, et un client doit pouvoir
      // distinguer les deux : « trop vite » se réessaie, « pas trouvé » non.
      if (!(await debitAcceptable(request, env))) {
        return new Response("Too many requests", {
          status: 429,
          headers: { "Retry-After": "60" },
        });
      }
      const authorized = gateMcp(request, url, env);
      if (!authorized) return new Response("Not found", { status: 404 });
      return QclawMCP.serve("/mcp").fetch(authorized, env, ctx);
    }
    // Administration (plan v2, 2.2) : rattrapage des vecteurs. HORS MCP ; inerte sans
    // le secret BACKFILL_TOKEN, et exige l'Authorization Bearer correspondante.
    if (url.pathname === "/admin/backfill-vectors") {
      return handleBackfill(request, env);
    }
    return new Response("Not found", { status: 404 });
  },
};
