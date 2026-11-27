import {
  CHEMIN_WELL_KNOWN_CARTE_SERVEUR,
  creerDepotJetonsD1,
  creerQuarantaineIpEchecs,
  drapeau,
  enregistrerEchecAuth,
  methodeNonPermise,
  origineAutorisee,
  origineInterdite,
  origineRefusee,
  originesAdmises,
  ouvrirPrincipal,
  porteursPresentes,
  preflight,
  refuser,
  repondreCarteServeur,
  repondreRessourceProtegee,
  reponseSante,
  tropDeRequetes,
  verifierDebitPreAuth,
  verifierDebitTitulaire,
} from "@poirierlavoie/mcp-socle";

import { PORTE, PORTE_OAUTH, SERVICE_ID } from "./auth";
import { handleBackfill } from "./backfill";
import { servirMcp } from "./routeur";
import {
  carteServeur,
  META_RESSOURCE_OAUTH_URL,
  ressourceProtegeeOAuth,
  SCOPE_OAUTH,
} from "./serveur";
import { estCheminDecouvertePublique, renderSite, repondreDecouvertePublique } from "./site";

export { carteServeur };

let quarantaine = creerQuarantaineIpEchecs();

export function reinitialiserQuarantaineIpPourTests(): void {
  quarantaine = creerQuarantaineIpEchecs();
}

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
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
        "img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
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

    if (url.pathname === "/") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
      }
      return servePage(request, env, ctx);
    }

    if (estCheminDecouvertePublique(url.pathname)) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
      }
      return repondreDecouvertePublique(url.pathname, request.method);
    }

    const estMetaOAuth = url.pathname === "/.well-known/oauth-protected-resource/mcp/oauth";
    const estCarteServeur =
      url.pathname === "/mcp/server-card" || url.pathname === CHEMIN_WELL_KNOWN_CARTE_SERVEUR;
    const estMcpOAuth = url.pathname === "/mcp/oauth" || url.pathname.startsWith("/mcp/oauth/");
    const estMcpDirect =
      !estMcpOAuth && (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/"));

    if (
      url.pathname === "/health" ||
      estMetaOAuth ||
      estCarteServeur ||
      estMcpOAuth ||
      estMcpDirect
    ) {
      if (!drapeau((env as { MCP_ENABLED?: string }).MCP_ENABLED, false)) {
        return refuser("404", origin);
      }

      if (url.pathname === "/health") {
        return reponseSante({ commit: (env as { COMMIT?: string }).COMMIT });
      }

      if (estMetaOAuth) {
        return repondreRessourceProtegee(
          request.method,
          ressourceProtegeeOAuth((env as { ORIGINE_PORTAIL?: string }).ORIGINE_PORTAIL),
        );
      }

      if (estCarteServeur) {
        return repondreCarteServeur(request.method, carteServeur());
      }

      if (origineRefusee(request, admises)) return origineInterdite();

      if (request.method === "OPTIONS" && origin) return preflight(origin);

      const porte = estMcpOAuth ? PORTE_OAUTH : PORTE;
      const refuserAcces = () =>
        estMcpOAuth
          ? refuser("401", origin, {
              resourceMetadata: META_RESSOURCE_OAUTH_URL,
              scope: SCOPE_OAUTH,
            })
          : refuser("404", origin);

      const ip = request.headers.get("CF-Connecting-IP") ?? "sans-ip";
      const candidatsJetons = porteursPresentes(request, url, porte);
      const preAuthOk = await verifierDebitPreAuth({
        ip,
        quarantaine,
        limiteurRafaleIp: env.RL_PRE_AUTH_IP,
        candidatsJetons,
      });
      if (!preAuthOk) {
        return estMcpOAuth ? tropDeRequetes(60, origin) : refuser("404", origin);
      }

      const depot = env.DB_IDENTITE ? creerDepotJetonsD1(env.DB_IDENTITE) : undefined;
      const autorise = await ouvrirPrincipal(
        request,
        url,
        env as unknown as Record<string, unknown>,
        porte,
        {
          depot,
          service: SERVICE_ID,
          planifierArrierePlan: (tache) => ctx.waitUntil(tache),
          surEmpreinteValide: (h) => quarantaine.marquerEmpreinteValide(h),
        },
      );
      if (!autorise) {
        await enregistrerEchecAuth({
          ip,
          quarantaine,
          limiteurEchecIp: env.RL_ECHEC_IP,
          limiteurEchecsGlobal: env.RL_ECHECS_GLOBAL,
          candidatsJetons,
        });
        return refuserAcces();
      }

      if (request.method !== "POST") return methodeNonPermise(origin);

      if (autorise.principal.type === "titulaire") {
        const refusDebit = await verifierDebitTitulaire({
          titulaireId: autorise.principal.titulaireId,
          etat: autorise.principal.etat,
          limiteurActif: env.RL_TITULAIRE,
          limiteurLimite: env.RL_TITULAIRE_LIMITE,
          origin,
        });
        if (refusDebit) return refusDebit;
      }

      return servirMcp(autorise.requete, env, origin, {
        principal: autorise.principal,
        ctx,
      });
    }

    if (url.pathname === "/admin/backfill-vectors") {
      return handleBackfill(request, env);
    }
    return new Response("Not found", { status: 404 });
  },
};
