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

/**
 * Quarantaine IP en mémoire d'isolat pour échecs d'authentification répétés (G32).
 * Les jetons déjà reconnus valides contournent la quarantaine afin de ne jamais couper
 * les autres usagers partageant la même passerelle NAT ou infonuagique.
 */
let quarantaine = creerQuarantaineIpEchecs();

export function reinitialiserQuarantaineIpPourTests(): void {
  quarantaine = creerQuarantaineIpEchecs();
}

/**
 * Sert la page publique, avec cache d'arête à clé synthétique fixe.
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

    // La page publique et ses fichiers de découverte passent AVANT le coupe-circuit, et hors du bloc /mcp (G22).
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
      // 1. COUPE-CIRCUIT (`!== "true"` ⇒ 404). Fermé par défaut.
      if (!drapeau((env as { MCP_ENABLED?: string }).MCP_ENABLED, false)) {
        return refuser("404", origin);
      }

      if (url.pathname === "/health") {
        return reponseSante({ commit: (env as { COMMIT?: string }).COMMIT });
      }

      // Métadonnées RFC 9728 propres au sous-chemin `/mcp/oauth` (la racine
      // `/.well-known/oauth-protected-resource` reste en 404 pour préserver `/mcp`).
      if (estMetaOAuth) {
        return repondreRessourceProtegee(
          request.method,
          ressourceProtegeeOAuth((env as { ORIGINE_PORTAIL?: string }).ORIGINE_PORTAIL),
        );
      }

      // Fiche de découverte SEP-2127 interceptée AVANT `/mcp/<jeton>`.
      if (estCarteServeur) {
        return repondreCarteServeur(request.method, carteServeur());
      }

      // 2. ORIGINE, avant toute authentification (défense contre le ré-attachement DNS, G6).
      if (origineRefusee(request, admises)) return origineInterdite();

      // 3. PRÉ-VOL, avant l'authentification et JAMAIS limité en débit (G6).
      if (request.method === "OPTIONS" && origin) return preflight(origin);

      const porte = estMcpOAuth ? PORTE_OAUTH : PORTE;
      const refuserAcces = () =>
        estMcpOAuth
          ? refuser("401", origin, {
              resourceMetadata: META_RESSOURCE_OAUTH_URL,
              scope: SCOPE_OAUTH,
            })
          : refuser("404", origin);

      // 4. DÉBIT PRÉ-AUTH par IP + quarantaine d'échecs (contournée par un jeton déjà connu).
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

      // 5. IDENTITÉ (`DB_IDENTITE` jetons individuels + secrets partagés transitoires sur `/mcp`).
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

      // 6. MÉTHODE — APRÈS l'identité, sur `/mcp` comme sur `/mcp/oauth` (G23).
      if (request.method !== "POST") return methodeNonPermise(origin);

      // 7. DÉBIT PAR TITULAIRE (`300/min` en régime `actif`, `20/min` en régime `limite`).
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

      // 8–12. Compteurs journaliers, enveloppe MCP 64 Kio, quotas par classe et exécution.
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
