/**
 * Routeur MCP bâti sur `@poirierlavoie/mcp-socle`.
 *
 * Il ne réimplémente rien : enveloppe JSON-RPC, validateur, négociation de version,
 * validation d'en-têtes, quotas journaliers et événements techniques sans contenu
 * viennent du socle. Ce fichier ne porte que ce qui est PROPRE à ce connecteur — son
 * identité, ses descripteurs (`PUBLIES`), la préférence `hybride_permis` (S19) et la
 * normalisation des arguments coercés.
 */

import {
  avecServerInfo,
  type ClasseOutil,
  type CodeErreurTechnique,
  type DescripteurOutil,
  ecrireEvenementTechniqueD1,
  err,
  erreurQuotaEpuise,
  formaterEvenementTechnique,
  type InfoClient,
  type IssueTechnique,
  incrementerCompteurJourD1,
  type JsonRpcMessage,
  lireCompteursJourD1,
  lireMeta,
  listToolDescriptors,
  type Principal,
  servirRequeteMcp,
  type ToolResult,
  validateArgs,
  verifierQuotaJour,
} from "@poirierlavoie/mcp-socle";

import { SERVICE_ID } from "./auth";
import { PUBLIES } from "./schemas";
import { CAPACITES, INSTRUCTIONS, SERVER_INFO, VERSIONS } from "./serveur";
import { construireOutils, estHybrideConfigure } from "./tools";

/** Une heure : le registre ne bouge qu'au déploiement. */
const TTL_LISTE = 3_600_000;

/**
 * Ce dépôt sert-il les clients antérieurs à `2025-06-18` ?
 *
 * OUI, et c'est COUPLÉ au fait que `2025-03-26` reste servie.
 * ⚠ NE PAS BASCULER CE DRAPEAU SANS RETIRER `2025-03-26` DE `VERSIONS`, ni l'inverse.
 */
const SERT_AVANT_2025_06_18 = true;

/**
 * Champs que Zod CONVERTISSAIT et que le validateur du socle REFUSERAIT.
 */
const COERCITIONS: Record<string, readonly string[]> = {
  get_article: ["article"],
  get_articles: ["from", "to", "numbers"],
};

const MOTIF_OUTIL_SUR = /^[A-Za-z0-9_.:-]{1,80}$/;

function normaliser(nom: string, args: Record<string, unknown>): Record<string, unknown> {
  const champs = Object.hasOwn(COERCITIONS, nom) ? COERCITIONS[nom] : undefined;
  if (!champs) return args;
  const out = { ...args };
  for (const champ of champs) {
    const v = out[champ];
    if (v === undefined || v === null) continue;
    out[champ] = Array.isArray(v)
      ? v.map((x) => (typeof x === "number" || typeof x === "bigint" ? String(x) : x))
      : typeof v === "number" || typeof v === "bigint"
        ? String(v)
        : v;
  }
  return out;
}

const descripteurs = () =>
  listToolDescriptors(PUBLIES as unknown as Record<string, DescripteurOutil>);

export interface ContexteAppelMcp {
  principal?: Principal;
  ctx?: Pick<ExecutionContext, "waitUntil">;
}

function extraireClientInfo(message?: JsonRpcMessage): InfoClient | undefined {
  return lireMeta(message?.params).clientInfo;
}

function classifierIssueOutil(resultat: ToolResult): {
  issue: IssueTechnique;
  code?: CodeErreurTechnique;
  estErreur: boolean;
  estIntrouvable: boolean;
} {
  if (!resultat.isError) {
    return { issue: "ok", estErreur: false, estIntrouvable: false };
  }
  const texte = resultat.content[0]?.text ?? "";
  if (
    /^(?:Recherche invalide|Aucun terme exploitable|Fournir (?:soit|path\b)|Modes INCOMPATIBLES|Aucun numéro d'article)/.test(
      texte,
    )
  ) {
    return {
      issue: "erreur_usager",
      code: "ARGUMENTS_INVALIDES",
      estErreur: true,
      estIntrouvable: false,
    };
  }
  return { issue: "introuvable", estErreur: false, estIntrouvable: true };
}

function planifier(
  ctx: Pick<ExecutionContext, "waitUntil"> | undefined,
  tache: Promise<unknown>,
): void {
  const sure = tache.catch(() => {});
  if (ctx) ctx.waitUntil(sure);
}

function enregistrerEvenementTitulaire(
  dbIdentite: D1Database,
  ctx: Pick<ExecutionContext, "waitUntil"> | undefined,
  principal: Extract<Principal, { type: "titulaire" }>,
  params: {
    outil: string;
    classe: ClasseOutil;
    issue: IssueTechnique;
    code?: CodeErreurTechnique;
    ms?: number;
    clientInfo?: InfoClient;
  },
): void {
  const outilSur = MOTIF_OUTIL_SUR.test(params.outil) ? params.outil : "outil_inconnu";
  planifier(
    ctx,
    ecrireEvenementTechniqueD1(
      dbIdentite,
      formaterEvenementTechnique({
        titulaireId: principal.titulaireId,
        jetonId: principal.jetonId,
        service: SERVICE_ID,
        outil: outilSur,
        classe: params.classe,
        issue: params.issue,
        code: params.code,
        ms: params.ms,
        clientInfo: params.clientInfo,
      }),
    ),
  );
}

async function appeler(
  env: Env,
  nomBrut: unknown,
  argsBruts: unknown,
  message?: JsonRpcMessage,
  contexte?: ContexteAppelMcp,
): Promise<ToolResult> {
  const nom = typeof nomBrut === "string" ? nomBrut : "";
  const descripteur = Object.hasOwn(PUBLIES, nom) ? PUBLIES[nom] : undefined;
  const principal = contexte?.principal;
  const clientInfo = extraireClientInfo(message);

  if (!descripteur) {
    if (principal?.type === "titulaire" && env.DB_IDENTITE) {
      enregistrerEvenementTitulaire(env.DB_IDENTITE, contexte?.ctx, principal, {
        outil: "outil_inconnu",
        classe: "local",
        issue: "erreur_usager",
        code: "OUTIL_INCONNU",
        ms: 0,
        clientInfo,
      });
    }
    return err(`Outil inconnu : ${nom || "(sans nom)"}.`);
  }

  const objet = argsBruts ?? {};
  if (typeof objet !== "object" || objet === null || Array.isArray(objet)) {
    if (principal?.type === "titulaire" && env.DB_IDENTITE) {
      enregistrerEvenementTitulaire(env.DB_IDENTITE, contexte?.ctx, principal, {
        outil: nom,
        classe: "local",
        issue: "erreur_usager",
        code: "ARGUMENTS_INVALIDES",
        ms: 0,
        clientInfo,
      });
    }
    return err("« arguments » doit être un objet.");
  }

  const args = normaliser(nom, objet as Record<string, unknown>);
  const fautes = validateArgs(descripteur.inputSchema, args);
  if (fautes.length > 0) {
    if (principal?.type === "titulaire" && env.DB_IDENTITE) {
      enregistrerEvenementTitulaire(env.DB_IDENTITE, contexte?.ctx, principal, {
        outil: nom,
        classe: "local",
        issue: "erreur_usager",
        code: "ARGUMENTS_INVALIDES",
        ms: 0,
        clientInfo,
      });
    }
    return err(`Arguments invalides pour ${nom} : ${fautes.join(" ")}`);
  }

  const hybridePermis = principal?.type === "titulaire" ? principal.hybridePermis : true;
  const offset = typeof args.offset === "number" ? args.offset : 0;
  const classeInitiale: ClasseOutil =
    nom === "search_text" && hybridePermis && estHybrideConfigure(env) && offset === 0
      ? "semantique"
      : "local";

  let verdictLocal: ReturnType<typeof verifierQuotaJour> | null = null;
  if (principal?.type === "titulaire") {
    if (!env.DB_IDENTITE) {
      return err("Service d'identité temporairement indisponible.");
    }
    let compteurs: Awaited<ReturnType<typeof lireCompteursJourD1>>;
    try {
      compteurs = await lireCompteursJourD1(env.DB_IDENTITE, principal.titulaireId);
    } catch {
      return err("Service d'identité temporairement indisponible.");
    }
    verdictLocal = verifierQuotaJour(compteurs, "local", principal.etat);
    const verdict =
      classeInitiale === "semantique"
        ? verifierQuotaJour(compteurs, "semantique", principal.etat)
        : verdictLocal;
    if (!verdict.autorise) {
      enregistrerEvenementTitulaire(env.DB_IDENTITE, contexte?.ctx, principal, {
        outil: nom,
        classe: classeInitiale,
        issue: "quota",
        code: "QUOTA_EPUISE",
        ms: 0,
        clientInfo,
      });
      return erreurQuotaEpuise(verdict.classe, verdict.plafond);
    }
  }

  let semantiqueExecute = false;
  const outils = construireOutils(env, {
    hybridePermis,
    surExecutionSemantique: () => {
      semantiqueExecute = true;
    },
  });
  const gestionnaire = outils[nom];
  if (!gestionnaire) {
    return err(`Outil inconnu : ${nom || "(sans nom)"}.`);
  }

  const debut = Date.now();
  try {
    const resultat = (await (gestionnaire as (a: unknown) => Promise<unknown>)(args)) as ToolResult;
    const ms = Date.now() - debut;
    const classeEffective: ClasseOutil = semantiqueExecute ? "semantique" : "local";
    if (principal?.type === "titulaire" && env.DB_IDENTITE) {
      const dbIdentite = env.DB_IDENTITE;
      if (classeEffective === "local" && verdictLocal && !verdictLocal.autorise) {
        enregistrerEvenementTitulaire(dbIdentite, contexte?.ctx, principal, {
          outil: nom,
          classe: "local",
          issue: "quota",
          code: "QUOTA_EPUISE",
          ms,
          clientInfo,
        });
        return erreurQuotaEpuise("local", verdictLocal.plafond);
      }
      const bilan = classifierIssueOutil(resultat);
      const evt = formaterEvenementTechnique({
        titulaireId: principal.titulaireId,
        jetonId: principal.jetonId,
        service: SERVICE_ID,
        outil: nom,
        classe: classeEffective,
        issue: bilan.issue,
        code: bilan.code,
        ms,
        clientInfo,
      });
      planifier(
        contexte?.ctx,
        Promise.all([
          incrementerCompteurJourD1(dbIdentite, {
            titulaireId: principal.titulaireId,
            classe: classeEffective,
            estErreur: bilan.estErreur,
            estIntrouvable: bilan.estIntrouvable,
          }),
          ecrireEvenementTechniqueD1(dbIdentite, evt),
        ]),
      );
    }
    return resultat;
  } catch (erreur) {
    const ms = Date.now() - debut;
    const classeEffective: ClasseOutil = semantiqueExecute ? "semantique" : "local";
    if (principal?.type === "titulaire" && env.DB_IDENTITE) {
      enregistrerEvenementTitulaire(env.DB_IDENTITE, contexte?.ctx, principal, {
        outil: nom,
        classe: classeEffective,
        issue: "refus",
        code: "ERREUR_INTERNE",
        ms,
        clientInfo,
      });
    }
    throw erreur;
  }
}

/**
 * Sert une requête MCP déjà AUTHENTIFIÉE.
 */
export async function servirMcp(
  request: Request,
  env: Env,
  origin: string | null,
  contexte?: ContexteAppelMcp,
): Promise<Response> {
  return await servirRequeteMcp(request, {
    versions: VERSIONS,
    capabilities: CAPACITES,
    serverInfo: SERVER_INFO,
    instructions: INSTRUCTIONS,
    descripteurs,
    appeler: (nom, args, message) => appeler(env, nom, args, message, contexte),
    origin,
    sertAvant2025_06_18: SERT_AVANT_2025_06_18,
    ttlListeMs: TTL_LISTE,
    surErreur: (methode, e) => {
      console.error(`mcp: ${methode} a échoué (${e instanceof Error ? e.name : "inconnu"})`);
    },
  });
}

export { avecServerInfo };
