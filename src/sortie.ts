/**
 * Ce qui accompagne toute sortie structurée de ce connecteur : son contexte et sa
 * provenance.
 *
 * Le socle porte l'enveloppe et la contrainte de non-vacuité des gardes ; ici vivent les
 * deux choses qu'il ne peut pas connaître — l'espace de noms du cabinet, et QUI fait foi
 * sur le texte servi.
 */

import type { Provenance } from "@poirierlavoie/socle-juridique";

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
