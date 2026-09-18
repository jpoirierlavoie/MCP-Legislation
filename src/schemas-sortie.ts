/**
 * Les `outputSchema` publiés, un par outil enveloppé.
 *
 * ⚠ POURQUOI CE FICHIER N'EST PAS `schemas.ts`. Celui-là est ENGENDRÉ depuis
 *   `fixtures/tools-list.reference.json`, c'est-à-dire depuis ce que le SDK publiait
 *   réellement ; y écrire à la main serait effacé à la prochaine régénération, et
 *   `tests/schemas-engendres.test.mjs` le dirait. Les `outputSchema`, eux, n'ont AUCUNE
 *   référence dont les tirer : le SDK n'en a jamais émis — la décision de ce dépôt était
 *   « `outputSchema` reste ABSENT à dessein ». Ils sont donc écrits, et ce fichier est le
 *   seul endroit où on le fait.
 *
 * LA DOCTRINE RENVERSÉE, EN TOUTES LETTRES. `CLAUDE.md` portait : « `outputSchema` reste
 * ABSENT à dessein » — le motif étant qu'un client qui reçoit un objet typé laisse tomber
 * la prose, et la mise en garde part avec elle. Le mode de panne est réel, il n'est pas
 * réfuté. Ce qui change, c'est la contrepartie : la réserve ne vit plus à côté de la
 * donnée, elle voyage DEDANS, et `gardes` ne peut pas être vide — par le type au moment
 * d'écrire le gestionnaire, par le constructeur `enveloppe()` à l'exécution, et par
 * `minItems: 1` sur le fil. Sans ces trois couches, la décision d'origine tenait toujours.
 *
 * ⚠ CE QUI EST PUBLIÉ EST UN CONTRAT. Retirer un champ, le renommer, ou resserrer un type
 *   est une rupture pour un tiers qui a bâti dessus. Élargir (`["string", "null"]`) ne
 *   l'est pas. La rupture passe par `/ns/v2`, jamais par une retouche ici.
 */

import { schemaEnveloppe } from "@poirierlavoie/socle-juridique";
import type { JsonSchema } from "@poirierlavoie/socle-juridique/protocole/valide";

/**
 * Une colonne D1 nullable rend `null`, pas `undefined` : `label_en` sans traduction arrive
 * `null` dans la charge. Le publier `{type:"string"}` mentirait, et le taire aussi.
 */
const TEXTE_OU_NUL: JsonSchema = { type: ["string", "null"] };

const MATIERE: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "Identifiant de la matière, ex. « louage-residentiel »." },
    label_fr: { type: "string" },
    label_en: TEXTE_OU_NUL,
    kind: { type: "string", description: "« prive-ccq » ou « specialise »." },
    label: { type: "string", description: "Le libellé dans la langue demandée." },
    description: { ...TEXTE_OU_NUL, description: "La description dans la langue demandée." },
    description_fr: TEXTE_OU_NUL,
    description_en: TEXTE_OU_NUL,
    laws_count: {
      type: "integer",
      minimum: 0,
      description:
        "Nombre de lois SERVABLES rattachées — masquage du corpus fédéral compris. " +
        "Peut valoir 0 pour une matière dont rien n'est servi ici.",
    },
    divisions_count: { type: "integer", minimum: 0 },
  },
  required: ["id", "label_fr", "kind", "label", "laws_count", "divisions_count"],
  additionalProperties: false,
};

const LISTE_MATIERES: JsonSchema = schemaEnveloppe({
  type: "object",
  properties: {
    count: { type: "integer", minimum: 0 },
    subjects: { type: "array", items: MATIERE },
  },
  required: ["count", "subjects"],
  additionalProperties: false,
});

/** Un nœud de plan, tel que `list_laws` le sert : deux niveaux, jamais davantage. */
const NOEUD_PLAN: JsonSchema = {
  type: "object",
  properties: {
    kind: { type: "string" },
    number: TEXTE_OU_NUL,
    heading: TEXTE_OU_NUL,
    path: { type: "string", description: "Chemin canonique, à passer à get_division." },
    children: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string" },
          number: TEXTE_OU_NUL,
          heading: TEXTE_OU_NUL,
          path: { type: "string" },
        },
        required: ["kind", "path"],
        additionalProperties: false,
      },
    },
  },
  required: ["kind", "path", "children"],
  additionalProperties: false,
};

const LOI: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    name_fr: { type: "string" },
    name_en: { type: "string" },
    /**
     * Deux clefs, une seule valeur, le temps d'une migration — voir le commentaire de
     * `LawRow.rlrq_cite`. Le contrat les publie TOUTES DEUX parce que les deux sont
     * servies ; le retrait de `rlrq_cite` est un commit séparé, annoncé.
     */
    rlrq_cite: { type: "string" },
    official_cite: { type: "string" },
    langs: { type: "array", items: { type: "string" } },
    consol_date_fr: TEXTE_OU_NUL,
    consol_date_en: TEXTE_OU_NUL,
    article_count: { type: "integer", minimum: 0 },
    fonction: TEXTE_OU_NUL,
    forum: { ...TEXTE_OU_NUL, description: "Multi-valeurs jointes par « ; ». Nul si sans forum." },
    scope: {
      ...TEXTE_OU_NUL,
      description:
        "Portée éditoriale. NUL plutôt qu'un repli sur le titre : un repli servirait un " +
        "champ vide ayant l'air plein.",
    },
    parent_law_id: { ...TEXTE_OU_NUL, description: "Loi habilitante d'un règlement." },
    subjects: { type: "array", items: { type: "string" } },
    mapped_divisions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          division_path: { type: "string" },
          heading: TEXTE_OU_NUL,
          subject: { type: "string" },
        },
        required: ["division_path", "subject"],
        additionalProperties: false,
      },
    },
    structure: {
      type: ["array", "null"],
      items: NOEUD_PLAN,
      description: "Plan profondeur 2 des grands codes. Nul si la loi n'a pas de Livres.",
    },
  },
  required: [
    "id",
    "name_fr",
    "name_en",
    "rlrq_cite",
    "official_cite",
    "langs",
    "article_count",
    "subjects",
    "mapped_divisions",
  ],
  additionalProperties: false,
};

const CARTE_DU_CORPUS: JsonSchema = schemaEnveloppe({
  type: "object",
  properties: {
    filters: {
      type: "object",
      properties: { fonction: TEXTE_OU_NUL, forum: TEXTE_OU_NUL, subject: TEXTE_OU_NUL },
      required: ["fonction", "forum", "subject"],
      additionalProperties: false,
    },
    count: { type: "integer", minimum: 0 },
    laws: { type: "array", items: LOI },
  },
  required: ["filters", "count", "laws"],
  additionalProperties: false,
});

const ARETE: JsonSchema = {
  type: "object",
  properties: {
    direction: { type: "string", enum: ["out", "in"] },
    other_id: { type: "string", description: "Id au corpus, ou chapitre brut si hors corpus." },
    other_name: { ...TEXTE_OU_NUL, description: "Nul si l'autre extrémité n'est pas au corpus." },
    rel_type: { type: "string" },
    source: { type: "string", enum: ["auto", "cure"], description: "Relevé machine ou à la main." },
    weight: { type: "integer" },
    in_corpus: { type: "boolean" },
    note: TEXTE_OU_NUL,
    note_lang: {
      ...TEXTE_OU_NUL,
      description:
        "Langue de la note, DANS la charge : un client qui jette la prose garde " +
        "l'information que la note n'est pas traduite.",
    },
  },
  required: [
    "direction",
    "other_id",
    "other_name",
    "rel_type",
    "source",
    "weight",
    "in_corpus",
    "note_lang",
  ],
  additionalProperties: false,
};

const GRAPHE_DES_LOIS: JsonSchema = schemaEnveloppe({
  type: "object",
  properties: {
    law: { type: "string" },
    lang: { type: "string", enum: ["fr", "en"] },
    rel_type: TEXTE_OU_NUL,
    direction: { type: "string", enum: ["out", "in", "both"] },
    total: { type: "integer", minimum: 0, description: "Arêtes trouvées, avant pagination." },
    count: { type: "integer", minimum: 0, description: "Arêtes réellement rendues." },
    relations: { type: "array", items: ARETE },
  },
  required: ["law", "lang", "rel_type", "direction", "total", "count", "relations"],
  additionalProperties: false,
});

/**
 * Les outils dont la sortie est enveloppée, et eux seuls.
 *
 * ⚠ LE FAIT QU'UN OUTIL SOIT ABSENT EST LISIBLE, et c'est voulu : `tools/list` ne publie
 *   d'`outputSchema` que là où il y en a un. Publier une enveloppe pour un outil qui rend
 *   encore une charge plate serait le pire des deux mondes — un contrat que le serveur
 *   viole lui-même. La bascule se fait outil par outil ; ce tableau dit où elle en est.
 */
export const SORTIES: Record<string, JsonSchema> = {
  legislation_list_laws: CARTE_DU_CORPUS,
  legislation_list_subjects: LISTE_MATIERES,
  legislation_related_laws: GRAPHE_DES_LOIS,
};
