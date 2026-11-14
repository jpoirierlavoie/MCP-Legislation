import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  debitAcceptable,
  methodeNonPermise,
  origineAutorisee,
  origineInterdite,
  origineRefusee,
  originesAdmises,
  ouvrir,
  refuser,
  tropDeRequetes,
} from "@poirierlavoie/socle-juridique";
import { McpAgent } from "agents/mcp";

import { gateMcp, PORTE } from "./auth";
import { handleBackfill } from "./backfill";
import { servirMcp } from "./routeur";
import { carteServeur, INSTRUCTIONS, SERVER_INFO } from "./serveur";
import { renderSite } from "./site";
import { construireOutils } from "./tools";

export { carteServeur };

/**
 * Serveur MCP « MCP Legislation » (paquet mcp-legislation).
 *
 * Expose les outils legislation_* (PLAN §3), en lecture seule sur D1. Transport HTTP
 * streamable sur POST /mcp.
 */

export class QclawMCP extends McpAgent {
  // Identité et texte d'orientation viennent de `src/serveur.ts` : le routeur du socle
  // doit rendre EXACTEMENT les mêmes, et un seul texte servi est la seule façon de s'en
  // assurer.
  server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });

  async init() {
    construireOutils(this.env, this.server);
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

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

/** Origines web Gemini ajoutées à `ORIGINES_PAR_DEFAUT` (`claude.ai`, `claude.com`). */
const ORIGINES_GEMINI = ["https://gemini.google.com", "https://aistudio.google.com"] as const;

function originesNavigateurAdmises(env: Env): string[] {
  const sup = (env as { ALLOWED_ORIGINS?: string }).ALLOWED_ORIGINS ?? "";
  return originesAdmises([...ORIGINES_GEMINI, sup].join(","));
}

/**
 * Réponse au pré-vol CORS sur `/mcp*` incluant les en-têtes MCP `2026-07-28`
 * (`Mcp-Method`, `Mcp-Name`, `Mcp-Session-Id`) et `Last-Event-ID`.
 */
function preflightMcp(origin: string): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id, Accept, Last-Event-ID",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    },
  });
}

function reponseCarteServeur(method: string): Response {
  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "Accept, Content-Type",
        "Access-Control-Max-Age": "86400",
      },
    });
  }
  if (method !== "GET" && method !== "HEAD") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: {
        ...JSON_HEADERS,
        Allow: "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/mcp-server-card+json; charset=utf-8",
    "Cache-Control": "public, max-age=600",
    "X-Content-Type-Options": "nosniff",
    "Access-Control-Allow-Origin": "*",
  };
  return method === "HEAD"
    ? new Response(null, { status: 200, headers })
    : new Response(JSON.stringify(carteServeur()), { status: 200, headers });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const admises = originesNavigateurAdmises(env);
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
      //    orthographiée ⇒ service ÉTEINT. Ne jamais l'écrire `=== "false"`, ce serait un
      //    garde ouvert par défaut sur un service destiné au multilocataire.
      if ((env as { MCP_ENABLED?: string }).MCP_ENABLED !== "true") {
        return refuser("404", origin);
      }

      if (url.pathname === "/health") {
        return new Response(JSON.stringify({ status: "ok" }), {
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      }

      // Fiche de découverte SEP-2127 (`/mcp/server-card`) : exception NOMMÉE et exacte
      // avant le contrôle d'origine et la porte d'accès `/mcp*`. Métadonnées publiques sans
      // secret, lisibles par tout catalogue ou client MCP, mais soumises au coupe-circuit.
      if (url.pathname === "/mcp/server-card") {
        return reponseCarteServeur(request.method);
      }

      // 2. ORIGINE, avant toute authentification : c'est la défense contre le
      //    ré-attachement DNS qu'exige la spécification. Sans en-tête CORS sur le refus.
      if (origineRefusee(request, admises)) return origineInterdite();

      // 3. PRÉ-VOL, avant l'authentification et JAMAIS limité en débit. Un navigateur émet
      //    `OPTIONS` sans porteur ; l'exiger casserait le connecteur sans rien protéger, et
      //    un 429 sur un pré-vol ne remonte que comme un échec CORS opaque.
      if (request.method === "OPTIONS" && origin) return preflightMcp(origin);

      // 4. DÉBIT. Clé = l'adresse vue par Cloudflare. Le jeton ne doit JAMAIS servir de clé :
      //    il finirait dans un compteur, donc dans des journaux. Échoue OUVERT — il protège
      //    un coût, il ne garde pas une porte.
      const ip = request.headers.get("CF-Connecting-IP") ?? "sans-ip";
      if (!(await debitAcceptable(env.RATE_LIMITER, ip))) return tropDeRequetes(60, origin);

      const surSocle = (env as { SOCLE?: string }).SOCLE === "true";

      // 5. IDENTITÉ. Échec : refus. Le chemin du socle emploie `ouvrir` (comparaison sur
      //    empreintes, élargissement des graphies) ; l'ancien garde `gateMcp`. Le drapeau
      //    bascule la chaîne ENTIÈRE, authentification comprise, pour qu'on observe un
      //    comportement et non un mélange.
      const autorise = surSocle
        ? await ouvrir(request, url, env as unknown as Record<string, unknown>, PORTE)
        : gateMcp(request, url, env);
      if (!autorise) return refuser("404", origin);

      // 6. MÉTHODE — APRÈS l'identité, et c'est délibéré. Un 405 servi à un anonyme lui
      //    apprend que le point d'entrée existe : exactement l'oracle que S8 refuse. Le
      //    connecteur claude.ai émet des `GET /mcp` sans porteur ; ils restent en refus.
      if (request.method !== "POST") return methodeNonPermise(origin);

      if (surSocle) return servirMcp(autorise, env, origin);
      return QclawMCP.serve("/mcp").fetch(autorise, env, ctx);
    }

    if (url.pathname === "/admin/backfill-vectors") {
      return handleBackfill(request, env);
    }
    return new Response("Not found", { status: 404 });
  },
};
