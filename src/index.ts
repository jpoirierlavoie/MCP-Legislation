import {
  debitAcceptable,
  drapeau,
  methodeNonPermise,
  origineAutorisee,
  origineInterdite,
  origineRefusee,
  originesAdmises,
  ouvrir,
  preflight,
  refuser,
  repondreCarteServeur,
  reponseSante,
  tropDeRequetes,
} from "@poirierlavoie/mcp-socle";

import { PORTE } from "./auth";
import { handleBackfill } from "./backfill";
import { servirMcp } from "./routeur";
import { carteServeur } from "./serveur";
import { renderSite } from "./site";

export { carteServeur };

/**
 * Serveur MCP « MCP Legislation » (paquet mcp-legislation).
 *
 * Expose les 10 outils de législation (PLAN §3), en lecture seule sur D1. Transport HTTP
 * streamable sans état sur POST /mcp.
 */

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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const admises = originesAdmises((env as { ALLOWED_ORIGINS?: string }).ALLOWED_ORIGINS);
    const origin = origineAutorisee(request, admises);

    // La page publique passe AVANT le coupe-circuit, et hors du bloc /mcp. C'est
    // précisément quand le connecteur est coupé qu'un confrère doit pouvoir lire pourquoi.
    // Elle ne porte ni secret ni donnée vivante, et n'émet AUCUN en-tête CORS : en émettre
    // ferait d'elle un oracle.
    if (url.pathname === "/") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
      }
      return servePage(request, env, ctx);
    }

    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/") || url.pathname === "/health") {
      // 1. COUPE-CIRCUIT. La polarité est celle du dépôt : variable absente, vide ou mal
      //    orthographiée ⇒ service ÉTEINT. Fermé par défaut sur un service destiné au
      //    multilocataire.
      if (!drapeau((env as { MCP_ENABLED?: string }).MCP_ENABLED, false)) {
        return refuser("404", origin);
      }

      if (url.pathname === "/health") {
        const sante = reponseSante({ commit: (env as { COMMIT?: string }).COMMIT });
        const headers = new Headers(sante.headers);
        headers.set("Cache-Control", "no-store");
        return new Response(sante.body, { status: sante.status, headers });
      }

      // Fiche de découverte SEP-2127 (`/mcp/server-card`) : exception NOMMÉE et exacte
      // avant le contrôle d'origine et la porte d'accès `/mcp*`. Métadonnées publiques sans
      // secret, lisibles par tout catalogue ou client MCP, mais soumises au coupe-circuit.
      if (url.pathname === "/mcp/server-card") {
        return repondreCarteServeur(request.method, carteServeur());
      }

      // 2. ORIGINE, avant toute authentification : c'est la défense contre le
      //    ré-attachement DNS qu'exige la spécification. Sans en-tête CORS sur le refus.
      if (origineRefusee(request, admises)) return origineInterdite();

      // 3. PRÉ-VOL, avant l'authentification et JAMAIS limité en débit. Un navigateur émet
      //    `OPTIONS` sans porteur ; l'exiger casserait le connecteur sans rien protéger, et
      //    un 429 sur un pré-vol ne remonte que comme un échec CORS opaque.
      if (request.method === "OPTIONS" && origin) return preflight(origin);

      // 4. DÉBIT. Clé = l'adresse vue par Cloudflare. Le jeton ne doit JAMAIS servir de clé :
      //    il finirait dans un compteur, donc dans des journaux. Échoue OUVERT — il protège
      //    un coût, il ne garde pas une porte.
      const ip = request.headers.get("CF-Connecting-IP") ?? "sans-ip";
      if (!(await debitAcceptable(env.RATE_LIMITER, ip))) return tropDeRequetes(60, origin);

      // 5. IDENTITÉ. Échec : refus (comparaison sur empreintes, élargissement des graphies).
      const autorise = await ouvrir(request, url, env as unknown as Record<string, unknown>, PORTE);
      if (!autorise) return refuser("404", origin);

      // 6. MÉTHODE — APRÈS l'identité, et c'est délibéré. Un 405 servi à un anonyme lui
      //    apprend que le point d'entrée existe : exactement l'oracle que S8 refuse. Le
      //    connecteur claude.ai émet des `GET /mcp` sans porteur ; ils restent en refus.
      if (request.method !== "POST") return methodeNonPermise(origin);

      return servirMcp(autorise, env, origin);
    }

    if (url.pathname === "/admin/backfill-vectors") {
      return handleBackfill(request, env);
    }
    return new Response("Not found", { status: 404 });
  },
};
