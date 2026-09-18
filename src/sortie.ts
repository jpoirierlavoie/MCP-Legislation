/**
 * Ce qui accompagne toute sortie structurée de ce connecteur : son contexte et sa
 * provenance.
 *
 * Le socle porte l'enveloppe et la contrainte de non-vacuité des gardes ; ici vivent les
 * deux choses qu'il ne peut pas connaître — l'espace de noms du cabinet, et QUI fait foi
 * sur le texte servi.
 */

import {
  enveloppe,
  type GardesObligatoires,
  type Provenance,
} from "@poirierlavoie/socle-juridique";

import { type CodeGarde, GARDES } from "./gardes";

/**
 * L'espace de noms des données servies.
 *
 * ⚠ IMMUABLE. Toute rupture de contrat passe par `/ns/v2` — un tiers qui a bâti sur `v1`
 *   ne doit pas voir sa lecture changer de sens parce qu'on a « amélioré » un champ.
 */
export const CONTEXTE = "https://legislation.poirierlavoie.ca/ns/v1";

/**
 * La provenance du corpus législatif.
 *
 * L'autorité N'EST PAS ce service : elle est l'Éditeur officiel du Québec, et pour les
 * textes fédéraux le ministre de la Justice. Le dire dans chaque réponse est ce qui rend
 * une sortie citable — et ce qui empêche un tiers de prendre cette copie pour la source.
 *
 * `corpus_version` reste à remplir par appel, quand la loi servie est connue : c'est
 * l'EXPRESSION au sens FRBR, la date de consolidation du texte lu. Une valeur globale
 * mentirait, le corpus étant consolidé loi par loi.
 */
export function provenanceCorpus(corpusVersion?: string): Provenance {
  return {
    source: "legisquebec",
    autorite: "Éditeur officiel du Québec",
    ...(corpusVersion ? { corpus_version: corpusVersion } : {}),
    cache: "aucun",
  };
}

/**
 * Enveloppe une charge, pour un outil de CE connecteur.
 *
 * ⚠ `obligatoires` EST EN DEUXIÈME POSITION, ET C'EST VOULU. Il se lit collé au type, avant
 *   la charge — qui, elle, fait souvent trente lignes. Un paramètre de réserve rejeté en
 *   queue d'appel se relit mal, et une réserve qu'on relit mal est une réserve qu'on finit
 *   par ne plus relire du tout.
 *
 * ⚠ IL N'A PAS DE VALEUR PAR DÉFAUT, ET IL NE DOIT JAMAIS EN AVOIR. Toute la contrainte de
 *   la marche 4 tient à ce que l'auteur du gestionnaire ÉCRIVE ce que son outil réserve —
 *   ou écrive `AUCUNE_RESERVE`, qui se grep. Un défaut ici les rendrait toutes silencieuses
 *   d'un coup, et le socle n'aurait plus rien à garantir.
 */
export function envelopper<T>(
  type: string,
  obligatoires: GardesObligatoires<CodeGarde>,
  donnees: T,
  extra?: {
    supplementaires?: readonly CodeGarde[];
    pagination?: { offset: number; limite: number; total?: number };
    /** La date de consolidation du texte servi, quand l'appel en connaît une. */
    corpusVersion?: string;
  },
): Record<string, unknown> {
  return enveloppe({
    contexte: CONTEXTE,
    type,
    donnees,
    provenance: provenanceCorpus(extra?.corpusVersion),
    registre: GARDES,
    obligatoires,
    ...(extra?.supplementaires ? { supplementaires: extra.supplementaires } : {}),
    ...(extra?.pagination ? { pagination: extra.pagination } : {}),
  }) as unknown as Record<string, unknown>;
}
