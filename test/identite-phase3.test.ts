import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { empreinte, frapperJeton, jourUtc, queueJeton } from "@poirierlavoie/mcp-socle";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import worker, { reinitialiserQuarantaineIpPourTests } from "../src/index";
import { sortKeyOf } from "../src/lib";

const HERITEE = "2025-06-18";
const MODERNE = "2026-07-28";

const dbCorpus = () => (env as unknown as { DB: D1Database }).DB;
const dbIdentite = () => (env as unknown as { DB_IDENTITE: D1Database }).DB_IDENTITE;

let compteurMembre = 10000;

async function insererTitulaireEtJeton(opts: {
  id: string;
  courriel: string;
  etat?: "en_attente" | "actif" | "surveille" | "limite" | "suspendu" | "revoque" | "refuse";
  hybridePermis?: 0 | 1;
  portee?: "les_deux" | "legislation" | "jurisprudence";
  revoqueLe?: string | null;
  expireLe?: string | null;
}): Promise<string> {
  const maintenant = "2026-11-18T12:00:00.000Z";
  compteurMembre += 1;
  const jetonClair = frapperJeton();
  const hashHex = await empreinte(jetonClair);
  const queue = queueJeton(jetonClair);

  await dbIdentite()
    .prepare(
      `INSERT INTO titulaire (
         id, cree_le, etat, nom, numero_membre, section, courriel,
         attestation_le, attestation_ver, cgu_ver, hybride_permis
       ) VALUES (?1, ?2, ?3, 'Me Test', ?4, 'Montréal', ?5, ?2, 'v1', 'v1', ?6)`,
    )
    .bind(
      opts.id,
      maintenant,
      opts.etat ?? "actif",
      `99${compteurMembre}-0`,
      opts.courriel,
      opts.hybridePermis ?? 1,
    )
    .run();

  await dbIdentite()
    .prepare(
      `INSERT INTO jeton (
         id, titulaire_id, empreinte, queue, libelle, portee, emis_le, expire_le, revoque_le
       ) VALUES (?1, ?2, ?3, ?4, 'poste', ?5, ?6, ?7, ?8)`,
    )
    .bind(
      `jet_${opts.id}`,
      opts.id,
      hashHex,
      queue,
      opts.portee ?? "les_deux",
      maintenant,
      opts.expireLe === undefined ? "2099-01-01T00:00:00.000Z" : opts.expireLe,
      opts.revoqueLe ?? null,
    )
    .run();

  return jetonClair;
}

describe("Phase 3 — DB_IDENTITE, double montage /mcp + /mcp/oauth, quotas et opt-out hybride", () => {
  beforeAll(async () => {
    const d = dbCorpus();
    await d
      .prepare(
        "INSERT INTO laws (id, name_fr, name_en, official_cite, jurisdiction) VALUES (?,?,?,?,?)",
      )
      .bind("ccq", "Code civil du Québec", "Civil Code of Québec", "RLRQ, c. CCQ-1991", "qc")
      .run();
    for (const [id, lang, heading, path] of [
      [101, "fr", "DE LA RESPONSABILITÉ CIVILE", "ga:l_cinquieme"],
      [102, "en", "CIVIL LIABILITY", "ga:l_five"],
    ] as const) {
      await d
        .prepare(
          "INSERT INTO divisions (id, law_id, lang, kind, number, heading, path, sort_order) VALUES (?,?,?,?,?,?,?,?)",
        )
        .bind(id, "ccq", lang, "livre", "V", heading, path, 0)
        .run();
    }
    await d
      .prepare(
        "INSERT INTO articles (id, law_id, lang, number, sort_key, division_path, text) VALUES (?,?,?,?,?,?,?)",
      )
      .bind(
        1001,
        "ccq",
        "fr",
        "1457",
        sortKeyOf("1457"),
        "ga:l_cinquieme",
        "Toute personne a le devoir de respecter les règles de conduite et de réparer le préjudice causé par sa faute.",
      )
      .run();
    await d
      .prepare(
        "INSERT INTO articles (id, law_id, lang, number, sort_key, division_path, text) VALUES (?,?,?,?,?,?,?)",
      )
      .bind(
        1002,
        "ccq",
        "en",
        "1457",
        sortKeyOf("1457"),
        "ga:l_five",
        "Every person has a duty to abide by the rules of conduct and make reparation for bodily, moral or material injury.",
      )
      .run();
    await d.prepare("INSERT INTO articles_fts(articles_fts) VALUES('rebuild')").run();
  });

  beforeEach(async () => {
    reinitialiserQuarantaineIpPourTests();
    const e = env as unknown as Record<string, unknown>;
    e.MCP_ENABLED = "true";
    e.MCP_TOKEN = "secret-partage-transitoire";
    e.MCP_TOKEN_VEILLE = "secret-veille-transitoire";
    await dbIdentite().exec(
      "DELETE FROM evenement_technique;\nDELETE FROM compteur_jour;\nDELETE FROM jeton;\nDELETE FROM titulaire;",
    );
  });

  it("accepte les jetons individuels D1 (les_deux, legislation) sur /mcp sous les 3 porteurs et rejette hors portée / inactifs avec le même 404 (G7)", async () => {
    const jetonLesDeux = await insererTitulaireEtJeton({
      id: "tit_ld",
      courriel: "ld@exemple.qc.ca",
      portee: "les_deux",
    });
    const jetonLois = await insererTitulaireEtJeton({
      id: "tit_lois",
      courriel: "lois@exemple.qc.ca",
      portee: "legislation",
    });
    const jetonJuris = await insererTitulaireEtJeton({
      id: "tit_juris",
      courriel: "juris@exemple.qc.ca",
      portee: "jurisprudence",
    });
    const jetonSuspendu = await insererTitulaireEtJeton({
      id: "tit_susp",
      courriel: "susp@exemple.qc.ca",
      etat: "suspendu",
    });
    const jetonExpire = await insererTitulaireEtJeton({
      id: "tit_exp",
      courriel: "exp@exemple.qc.ca",
      expireLe: "2020-01-01T00:00:00.000Z",
    });
    const jetonRevoque = await insererTitulaireEtJeton({
      id: "tit_rev",
      courriel: "rev@exemple.qc.ca",
      revoqueLe: "2026-11-18T10:00:00.000Z",
    });

    const corps = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    for (const [url, headers] of [
      [
        "https://legislation.test/mcp",
        { Authorization: `Bearer ${jetonLesDeux}`, "MCP-Protocol-Version": HERITEE },
      ],
      [`https://legislation.test/mcp?key=${jetonLois}`, { "MCP-Protocol-Version": HERITEE }],
      [`https://legislation.test/mcp/${jetonLois}/`, { "MCP-Protocol-Version": HERITEE }],
    ] as const) {
      const res = await SELF.fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: corps,
      });
      expect(res.status, url).toBe(200);
    }

    const rAnonyme = await SELF.fetch("https://legislation.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "MCP-Protocol-Version": HERITEE },
      body: corps,
    });
    expect(rAnonyme.status).toBe(404);
    expect(await rAnonyme.text()).toBe("");
    expect(rAnonyme.headers.get("WWW-Authenticate")).toBeNull();

    for (const mauvais of [jetonJuris, jetonSuspendu, jetonExpire, jetonRevoque, frapperJeton()]) {
      const r = await SELF.fetch("https://legislation.test/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${mauvais}`,
          "MCP-Protocol-Version": HERITEE,
        },
        body: corps,
      });
      expect(r.status).toBe(404);
      expect(await r.text()).toBe("");
      expect(r.headers.get("WWW-Authenticate")).toBeNull();
    }
  });

  it("expose /mcp/oauth (Bearer seul, 401 RFC 9728, méthode jugée après auth) et /.well-known/oauth-protected-resource/mcp/oauth sans ouvrir la racine", async () => {
    expect(
      (await SELF.fetch("https://legislation.test/.well-known/oauth-protected-resource")).status,
    ).toBe(404);

    const metaRes = await SELF.fetch(
      "https://legislation.test/.well-known/oauth-protected-resource/mcp/oauth",
    );
    expect(metaRes.status).toBe(200);
    const meta = (await metaRes.json()) as {
      resource: string;
      authorization_servers: string[];
      scopes_supported: string[];
      bearer_methods_supported: string[];
    };
    expect(meta.resource).toBe("https://legislation.poirierlavoie.ca/mcp/oauth");
    expect(meta.authorization_servers).toEqual(["https://acces.poirierlavoie.ca"]);
    expect(meta.scopes_supported).toEqual(["les_deux", "legislation"]);
    expect(meta.bearer_methods_supported).toEqual(["header"]);

    const e = env as unknown as Record<string, unknown>;
    e.MCP_ENABLED = "false";
    expect(
      (await SELF.fetch("https://legislation.test/.well-known/oauth-protected-resource/mcp/oauth"))
        .status,
    ).toBe(404);
    e.MCP_ENABLED = "true";

    const jetonValide = await insererTitulaireEtJeton({
      id: "tit_oauth",
      courriel: "oauth@exemple.qc.ca",
      portee: "legislation",
    });

    const getAnon = await SELF.fetch("https://legislation.test/mcp/oauth", { method: "GET" });
    expect(getAnon.status).toBe(401);
    const wwwAnon = getAnon.headers.get("WWW-Authenticate") ?? "";
    expect(wwwAnon).toContain(
      'resource_metadata="https://legislation.poirierlavoie.ca/.well-known/oauth-protected-resource/mcp/oauth"',
    );
    expect(wwwAnon).toContain('scope="legislation les_deux"');

    const postInvalide = await SELF.fetch("https://legislation.test/mcp/oauth", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${frapperJeton()}`,
      },
      body: "{}",
    });
    expect(postInvalide.status).toBe(401);
    expect(postInvalide.headers.get("WWW-Authenticate")).toBe(wwwAnon);

    for (const req of [
      SELF.fetch("https://legislation.test/mcp/oauth", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer secret-partage-transitoire",
        },
        body: "{}",
      }),
      SELF.fetch(`https://legislation.test/mcp/oauth?key=${jetonValide}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
      SELF.fetch(`https://legislation.test/mcp/oauth/${jetonValide}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${jetonValide}`,
        },
        body: "{}",
      }),
    ]) {
      expect((await req).status).toBe(401);
    }

    const getAuth = await SELF.fetch("https://legislation.test/mcp/oauth", {
      method: "GET",
      headers: { Authorization: `Bearer ${jetonValide}` },
    });
    expect(getAuth.status).toBe(405);

    const postAuth = await SELF.fetch("https://legislation.test/mcp/oauth", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jetonValide}`,
        "MCP-Protocol-Version": HERITEE,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(postAuth.status).toBe(200);
  });

  it("quarantaine IP d'échecs n'évince jamais un titulaire au jeton déjà reconnu sur la même IP partagée (G32)", async () => {
    const jetonSain = await insererTitulaireEtJeton({
      id: "tit_ip_partagee",
      courriel: "ip@exemple.qc.ca",
    });
    const ipPartagee = "198.51.100.77";

    const envEchecStrict = {
      ...(env as unknown as Record<string, unknown>),
      RL_ECHEC_IP: { limit: async () => ({ success: false }) },
    } as unknown as Env;

    const ctx1 = createExecutionContext();
    const premier = await worker.fetch(
      new Request("https://legislation.test/mcp/oauth", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": ipPartagee,
          Authorization: `Bearer ${jetonSain}`,
          "MCP-Protocol-Version": HERITEE,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }),
      envEchecStrict,
      ctx1,
    );
    await waitOnExecutionContext(ctx1);
    expect(premier.status).toBe(200);

    const ctxEchec = createExecutionContext();
    const echec = await worker.fetch(
      new Request("https://legislation.test/mcp/oauth", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": ipPartagee,
          Authorization: `Bearer ${frapperJeton()}`,
        },
        body: "{}",
      }),
      envEchecStrict,
      ctxEchec,
    );
    await waitOnExecutionContext(ctxEchec);
    expect(echec.status).toBe(401);

    const sondeOAuth = await worker.fetch(
      new Request("https://legislation.test/mcp/oauth", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": ipPartagee,
          Authorization: `Bearer ${frapperJeton()}`,
        },
        body: "{}",
      }),
      envEchecStrict,
      createExecutionContext(),
    );
    expect(sondeOAuth.status).toBe(429);

    const sondeDirecte = await worker.fetch(
      new Request("https://legislation.test/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": ipPartagee,
          Authorization: `Bearer ${frapperJeton()}`,
        },
        body: "{}",
      }),
      envEchecStrict,
      createExecutionContext(),
    );
    expect(sondeDirecte.status).toBe(404);

    const ctxLegit = createExecutionContext();
    const legitime = await worker.fetch(
      new Request("https://legislation.test/mcp/oauth", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": ipPartagee,
          Authorization: `Bearer ${jetonSain}`,
          "MCP-Protocol-Version": HERITEE,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
      }),
      envEchecStrict,
      ctxLegit,
    );
    await waitOnExecutionContext(ctxLegit);
    expect(legitime.status).toBe(200);
  });

  it("applique hybride_permis = 0 en mode FTS5 lexical seul (zéro appel AI/Vectorize, classe local, mention explicite) vs hybride_permis = 1 (classe semantique) (S19)", async () => {
    const jetonLexical = await insererTitulaireEtJeton({
      id: "tit_lexical",
      courriel: "lex@exemple.qc.ca",
      hybridePermis: 0,
    });
    const jetonHybride = await insererTitulaireEtJeton({
      id: "tit_hybride",
      courriel: "hyb@exemple.qc.ca",
      hybridePermis: 1,
    });

    let appelsAi = 0;
    let appelsVectors = 0;
    const envAvecAi = {
      ...(env as unknown as Record<string, unknown>),
      HYBRID_SEARCH: "1",
      AI: {
        run: async () => {
          appelsAi += 1;
          return { data: [[0.1, 0.2, 0.3]] };
        },
      },
      VECTORS: {
        query: async () => {
          appelsVectors += 1;
          return { matches: [] };
        },
      },
    } as unknown as Env;

    const ctx1 = createExecutionContext();
    const resLex = await worker.fetch(
      new Request("https://legislation.test/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${jetonLexical}`,
          "MCP-Protocol-Version": MODERNE,
          "Mcp-Method": "tools/call",
          "Mcp-Name": "search_text",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "search_text",
            arguments: { query: "préjudice faute", lang: "fr" },
            _meta: {
              "io.modelcontextprotocol/protocolVersion": MODERNE,
              "io.modelcontextprotocol/clientInfo": { name: "claude-code", version: "2.1.0" },
            },
          },
        }),
      }),
      envAvecAi,
      ctx1,
    );
    await waitOnExecutionContext(ctx1);
    expect(resLex.status).toBe(200);
    expect(appelsAi).toBe(0);
    expect(appelsVectors).toBe(0);
    const jsonLex = (await resLex.json()) as {
      result: {
        isError?: boolean;
        content: Array<{ text: string }>;
        structuredContent: Record<string, unknown>;
      };
    };
    expect(jsonLex.result.isError).toBeUndefined();
    expect(jsonLex.result.content[0]?.text).toContain(
      "la recherche vectorielle hybride est désactivée selon la préférence du compte",
    );
    expect(jsonLex.result.structuredContent.hybride_desactive).toBe(true);

    const ctxVide = createExecutionContext();
    const resVide = await worker.fetch(
      new Request("https://legislation.test/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${jetonLexical}`,
          "MCP-Protocol-Version": HERITEE,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "search_text",
            arguments: { query: "termeinexistantxyz", lang: "en" },
          },
        }),
      }),
      envAvecAi,
      ctxVide,
    );
    await waitOnExecutionContext(ctxVide);
    const jsonVide = (await resVide.json()) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(jsonVide.result.isError).toBe(true);
    expect(jsonVide.result.content[0]?.text).toContain(
      "hybrid vector search is disabled per account preference",
    );
    expect(appelsAi).toBe(0);

    const { results: cptLex } = await dbIdentite()
      .prepare(
        "SELECT classe, appels, introuvables FROM compteur_jour WHERE titulaire_id = ?1 AND jour = ?2 ORDER BY classe",
      )
      .bind("tit_lexical", jourUtc())
      .all<{ classe: string; appels: number; introuvables: number }>();
    expect(cptLex).toEqual([{ classe: "local", appels: 2, introuvables: 1 }]);

    const ctx2 = createExecutionContext();
    const resHyb = await worker.fetch(
      new Request("https://legislation.test/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${jetonHybride}`,
          "MCP-Protocol-Version": HERITEE,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "search_text",
            arguments: { query: "préjudice faute", lang: "fr" },
          },
        }),
      }),
      envAvecAi,
      ctx2,
    );
    await waitOnExecutionContext(ctx2);
    expect(resHyb.status).toBe(200);
    expect(appelsAi).toBeGreaterThan(0);
    expect(appelsVectors).toBeGreaterThan(0);
    const jsonHyb = (await resHyb.json()) as {
      result: { content: Array<{ text: string }>; structuredContent: Record<string, unknown> };
    };
    expect(jsonHyb.result.content[0]?.text).not.toContain("désactivée selon la préférence");
    expect(jsonHyb.result.structuredContent.hybride_desactive).toBeUndefined();

    const { results: cptHyb } = await dbIdentite()
      .prepare(
        "SELECT classe, appels FROM compteur_jour WHERE titulaire_id = ?1 AND jour = ?2 ORDER BY classe",
      )
      .bind("tit_hybride", jourUtc())
      .all<{ classe: string; appels: number }>();
    expect(cptHyb).toEqual([{ classe: "semantique", appels: 1 }]);

    const ev = await dbIdentite()
      .prepare(
        "SELECT titulaire_id, service, outil, classe, issue, client FROM evenement_technique WHERE client = 'claude-code/2.1.0'",
      )
      .first<Record<string, unknown>>();
    expect(ev).toEqual({
      titulaire_id: "tit_lexical",
      service: "legislation",
      outil: "search_text",
      classe: "local",
      issue: "ok",
      client: "claude-code/2.1.0",
    });
  });

  it("bloque sur quota journalier épuisé (local et semantique) en HTTP 200 [QUOTA_EPUISE] et distingue le débit titulaire actif vs limite", async () => {
    const jetonLimite = await insererTitulaireEtJeton({
      id: "tit_limite",
      courriel: "lim@exemple.qc.ca",
      etat: "limite",
    });

    await dbIdentite()
      .prepare(
        `INSERT INTO compteur_jour (titulaire_id, jour, classe, appels, erreurs, introuvables, sortants)
         VALUES (?1, ?2, 'local', 150, 0, 0, 0)`,
      )
      .bind("tit_limite", jourUtc())
      .run();

    const ctxQuota = createExecutionContext();
    const rQuota = await worker.fetch(
      new Request("https://legislation.test/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${jetonLimite}`,
          "MCP-Protocol-Version": HERITEE,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "get_article", arguments: { law: "ccq", article: "1457" } },
        }),
      }),
      env,
      ctxQuota,
    );
    await waitOnExecutionContext(ctxQuota);
    expect(rQuota.status).toBe(200);
    const corpsQuota = (await rQuota.json()) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(corpsQuota.result.isError).toBe(true);
    expect(corpsQuota.result.content[0]?.text).toContain("[QUOTA_EPUISE]");
    expect(corpsQuota.result.content[0]?.text).toContain("150");

    await dbIdentite()
      .prepare(
        `INSERT INTO compteur_jour (titulaire_id, jour, classe, appels, erreurs, introuvables, sortants)
         VALUES (?1, ?2, 'semantique', 15, 0, 0, 0)`,
      )
      .bind("tit_limite", jourUtc())
      .run();
    const envAvecAi = {
      ...(env as unknown as Record<string, unknown>),
      HYBRID_SEARCH: "1",
      AI: { run: async () => ({ data: [[0.1]] }) },
      VECTORS: { query: async () => ({ matches: [] }) },
    } as unknown as Env;
    const ctxQuotaSem = createExecutionContext();
    const rQuotaSem = await worker.fetch(
      new Request("https://legislation.test/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${jetonLimite}`,
          "MCP-Protocol-Version": HERITEE,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "search_text", arguments: { query: "faute", lang: "fr" } },
        }),
      }),
      envAvecAi,
      ctxQuotaSem,
    );
    await waitOnExecutionContext(ctxQuotaSem);
    const corpsQuotaSem = (await rQuotaSem.json()) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(corpsQuotaSem.result.isError).toBe(true);
    expect(corpsQuotaSem.result.content[0]?.text).toContain("[QUOTA_EPUISE]");
    expect(corpsQuotaSem.result.content[0]?.text).toContain("semantique");

    const rListe = await SELF.fetch("https://legislation.test/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jetonLimite}`,
        "MCP-Protocol-Version": HERITEE,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
    });
    expect(rListe.status).toBe(200);

    const envDebit = {
      ...(env as unknown as Record<string, unknown>),
      RL_TITULAIRE_LIMITE: { limit: async () => ({ success: false }) },
      RL_TITULAIRE: { limit: async () => ({ success: true }) },
    } as unknown as Env;

    const r429 = await worker.fetch(
      new Request("https://legislation.test/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${jetonLimite}`,
          "MCP-Protocol-Version": HERITEE,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "ping" }),
      }),
      envDebit,
      createExecutionContext(),
    );
    expect(r429.status).toBe(429);
    expect(r429.headers.get("Retry-After")).toBe("300");
  });

  it("borne evenement_technique.outil aux noms fermés, ne facture semantique que si Workers AI s'exécute (HYBRID_SEARCH='1'|'true'), classe Modes INCOMPATIBLES / Fournir path en erreur_usager et échoue fermé sur panne DB_IDENTITE", async () => {
    const jeton = await insererTitulaireEtJeton({
      id: "tit_durcissement",
      courriel: "durcissement@exemple.qc.ca",
      hybridePermis: 1,
    });

    let appelsAi = 0;
    const envAvecAiTrue = {
      ...(env as unknown as Record<string, unknown>),
      HYBRID_SEARCH: "true",
      AI: {
        run: async () => {
          appelsAi += 1;
          return { data: [[0.1, 0.2, 0.3]] };
        },
      },
      VECTORS: {
        query: async () => ({ matches: [] }),
      },
    } as unknown as Env;

    const appelerOutil = async (name: string, args: unknown, envCible: Env = envAvecAiTrue) => {
      const ctx = createExecutionContext();
      const res = await worker.fetch(
        new Request("https://legislation.test/mcp", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${jeton}`,
            "MCP-Protocol-Version": HERITEE,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name, arguments: args },
          }),
        }),
        envCible,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return res;
    };

    await appelerOutil("Dupont_c_Tremblay_500-17-123456-261", {});
    const evtInconnu = await dbIdentite()
      .prepare(
        "SELECT outil, issue, code FROM evenement_technique WHERE titulaire_id = 'tit_durcissement'",
      )
      .first<{ outil: string; issue: string; code: string | null }>();
    expect(evtInconnu).toEqual({
      outil: "outil_inconnu",
      issue: "erreur_usager",
      code: "OUTIL_INCONNU",
    });

    await appelerOutil("search_text", { query: "faute", law: "loi_inexistante" });
    await appelerOutil("search_text", { query: "!!!" });
    expect(appelsAi).toBe(0);

    await appelerOutil("search_text", { query: "préjudice faute", lang: "fr" });
    expect(appelsAi).toBe(1);

    await appelerOutil("get_articles", {
      law: "ccq",
      from: "1457",
      to: "1458",
      numbers: ["1457"],
    });
    await appelerOutil("get_division", { law: "ccq" });

    const { results: cpts } = await dbIdentite()
      .prepare(
        "SELECT classe, appels, erreurs, introuvables FROM compteur_jour WHERE titulaire_id = 'tit_durcissement' AND jour = ?1 ORDER BY classe",
      )
      .bind(jourUtc())
      .all<{ classe: string; appels: number; erreurs: number; introuvables: number }>();
    expect(cpts).toEqual([
      { classe: "local", appels: 4, erreurs: 2, introuvables: 2 },
      { classe: "semantique", appels: 1, erreurs: 0, introuvables: 0 },
    ]);

    const dbIdentitePanne = {
      prepare(sql: string) {
        if (sql.includes("FROM jeton") || sql.includes("UPDATE jeton")) {
          return dbIdentite().prepare(sql);
        }
        return {
          bind() {
            return {
              async all() {
                throw new Error("D1 indisponible");
              },
              async first() {
                throw new Error("D1 indisponible");
              },
              async run() {
                throw new Error("D1 indisponible");
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    const envPanne = {
      ...(env as unknown as Record<string, unknown>),
      DB_IDENTITE: dbIdentitePanne,
    } as unknown as Env;
    const resPanne = await appelerOutil("get_article", { law: "ccq", article: "1457" }, envPanne);
    expect(resPanne.status).toBe(200);
    const corpsPanne = (await resPanne.json()) as {
      result?: { isError: boolean; content: Array<{ text: string }> };
      error?: unknown;
    };
    expect(corpsPanne.error).toBeUndefined();
    expect(corpsPanne.result?.isError).toBe(true);
    expect(corpsPanne.result?.content[0]?.text).toContain("indisponible");
  });
});
