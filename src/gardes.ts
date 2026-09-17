/**
 * Les codes de mise en garde de CE connecteur.
 *
 * ⚠ ILS VIVENT ICI, ET NON DANS LE SOCLE, contrairement à ce que dit la §8.4 de la
 *   spécification. Ces codes nomment du texte officiel, des lois et des corpus : la règle
 *   de frontière — « le socle ne connaît pas le droit », donnée comme la première de
 *   toutes — l'interdit là-bas. Le socle porte le MÉCANISME (le type d'une garde, sa
 *   sévérité, l'enveloppe, et la contrainte de non-vacuité) ; chaque connecteur porte ses
 *   codes. Divergence déclarée.
 *
 * LES TEXTES SONT PROMUS, NON RÉDIGÉS. Chacun reprend une réserve qui existait déjà et que
 * le praticien avait écrite — `GARDE_FOU` de `src/tools.ts`, et les trois paragraphes de
 * `catalogue.avertissement`. La promotion est mécanique : ce qui se lisait dans la prose
 * devient opposable, sans qu'un mot change de sens au passage. Rédiger ici une réserve
 * NEUVE serait une décision éditoriale, donc du ressort de l'avocat (invariant 16).
 */

import { declarerRegistre } from "@poirierlavoie/socle-juridique";

export type CodeGarde =
  | "REPERAGE_HEURISTIQUE"
  | "TEXTE_A_VERIFIER"
  | "LANGUE_DISCORDANTE"
  | "SERVI_DU_CACHE"
  | "REPLI_LEXICAL";

export const GARDES = declarerRegistre<CodeGarde>({
  /** Promu de `GARDE_FOU` (src/tools.ts), mot pour mot. */
  REPERAGE_HEURISTIQUE: {
    code: "REPERAGE_HEURISTIQUE",
    severite: "reserve",
    texte:
      "Aide heuristique au repérage de lois et de parties de lois candidates. " +
      "Ne détermine PAS le droit applicable : toujours vérifier en lisant le texte via " +
      "legislation_get_structure / legislation_get_division / legislation_get_article.",
  },

  /** Promu de `catalogue.avertissement`, paragraphes 2 et 3, condensés sans rien retirer. */
  TEXTE_A_VERIFIER: {
    code: "TEXTE_A_VERIFIER",
    severite: "reserve",
    texte:
      "Le texte est restitué verbatim, mais ce service n'est PAS une version officielle : " +
      "celle qui fait foi est publiée par l'Éditeur officiel du Québec, et pour le fédéral " +
      "par le ministre (art. 31 de la Loi sur la révision et la codification des textes " +
      "législatifs). Les dates de consolidation indiquent l'état du corpus chargé ici, " +
      "lequel peut accuser un retard sur la publication officielle.",
  },

  /**
   * La réserve que l'invariant 4 du dépôt appelait sans qu'elle existe : le correctif de
   * REPÉRAGE est livré et épinglé par une éval, la GARDE émise ne l'était pas.
   *
   * ⚠ N'a RIEN à voir avec l'affaire de l'article 490 C.p.c., qui était un échec de
   *   repérage, réglé, et qu'il ne faut pas rouvrir sous un code de langue.
   */
  LANGUE_DISCORDANTE: {
    code: "LANGUE_DISCORDANTE",
    severite: "avertissement",
    texte:
      "La langue de la requête ne correspond pas à celle du corpus interrogé. " +
      "Les résultats peuvent être incomplets : reformuler dans la langue visée, " +
      "ou préciser « lang ».",
  },

  SERVI_DU_CACHE: {
    code: "SERVI_DU_CACHE",
    severite: "information",
    texte:
      "Réponse servie depuis un cache local. Le corpus n'est rechargé que deux fois l'an ; " +
      "la date de consolidation ci-dessus dit l'état réellement servi.",
  },

  /**
   * Le repli de l'échelle de recherche, déjà étiqueté dans la sortie (R7 : « échouer
   * ouvert, mais le DIRE ») et journalisé. Ce code lui donne une forme opposable.
   */
  REPLI_LEXICAL: {
    code: "REPLI_LEXICAL",
    severite: "information",
    texte:
      "La recherche a dû élargir sa formulation pour rendre des résultats — élargissement " +
      "du corpus, retrait d'un terme, ou bascule lexicale. Les résultats répondent donc à " +
      "une question plus large que celle posée.",
  },
});
