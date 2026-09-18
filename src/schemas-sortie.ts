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

/** Les deux langues servies. Publié partout où `lang` revient dans la charge. */
const LANGUE: JsonSchema = { type: "string", enum: ["fr", "en"] };

/**
 * Un nœud de l'arbre des divisions, jusqu'à `niveaux` de profondeur.
 *
 * ⚠ LE SOUS-ENSEMBLE N'A PAS DE `$ref`, donc pas de récursion. L'arbre, lui, descend
 *   jusqu'à `depth` (max 9). Publier neuf copies du nœud coûterait environ deux kilo-octets
 *   sur CHAQUE `tools/list` — le « coût récurrent » que la doctrine d'origine nommait, et
 *   qui reste un vrai coût même une fois la doctrine amendée.
 *
 *   Le partage : trois niveaux CONTRAINTS, puis `children` cesse de contraindre ses
 *   éléments. Le schéma ne ment pas — il décrit exactement la forme du nœud, et arrête de
 *   l'imposer plus bas. Un consommateur y lit tout ce dont il a besoin.
 */
function noeudDivision(niveaux: number): JsonSchema {
  const enfants: JsonSchema =
    niveaux <= 1
      ? {
          type: "array",
          description:
            "Sous-divisions, de la même forme que ce nœud. Non contraintes au-delà du " +
            "troisième niveau : le sous-ensemble JSON Schema employé ici n'a pas de $ref.",
        }
      : { type: "array", items: noeudDivision(niveaux - 1) };
  return {
    type: "object",
    properties: {
      path: { type: "string", description: "Chemin canonique, à passer à get_division." },
      division_id: { type: "integer" },
      kind: { type: "string" },
      number: TEXTE_OU_NUL,
      heading: TEXTE_OU_NUL,
      repealed: { type: "integer", description: "1 si la division est abrogée." },
      children: enfants,
    },
    required: ["path", "division_id", "kind", "repealed", "children"],
    additionalProperties: false,
  };
}

const PLAN_DE_LOI: JsonSchema = schemaEnveloppe({
  type: "object",
  properties: {
    law: { type: "string" },
    lang: LANGUE,
    root_path: TEXTE_OU_NUL,
    depth: { type: "integer", minimum: 1, maximum: 9 },
    tree: { type: "array", items: noeudDivision(3) },
  },
  required: ["law", "lang", "root_path", "depth", "tree"],
  additionalProperties: false,
});

const ARTICLE: JsonSchema = schemaEnveloppe({
  type: "object",
  properties: {
    law: { type: "string" },
    number: { type: "string" },
    lang: LANGUE,
    citation: { type: "string", description: "Citation formée, prête à coller." },
    division_path: { type: "string" },
    division: {
      type: ["object", "null"],
      properties: { kind: { type: "string" }, number: TEXTE_OU_NUL, heading: TEXTE_OU_NUL },
      required: ["kind"],
      additionalProperties: false,
      description: "La division qui porte l'article. Nulle si l'article n'en a pas.",
    },
    consolidation: {
      ...TEXTE_OU_NUL,
      description: "Date de consolidation du texte servi. La même valeur qu'en provenance.",
    },
    history: TEXTE_OU_NUL,
    repealed: { type: "boolean" },
    text: { type: "string", description: "Le texte, verbatim. NON officiel — voir gardes." },
  },
  required: [
    "law",
    "number",
    "lang",
    "citation",
    "division_path",
    "division",
    "consolidation",
    "history",
    "repealed",
    "text",
  ],
  additionalProperties: false,
});

const ARTICLES: JsonSchema = schemaEnveloppe({
  type: "object",
  properties: {
    law: { type: "string" },
    lang: LANGUE,
    count: { type: "integer", minimum: 0, description: "Articles réellement rendus." },
    total: { type: "integer", minimum: 0 },
    pagination: {
      type: ["object", "null"],
      properties: {
        limit: { type: "integer", minimum: 1 },
        offset: { type: "integer", minimum: 0 },
      },
      required: ["limit", "offset"],
      additionalProperties: false,
      description: "Nulle hors mode plage.",
    },
    range_resolution: {
      type: ["string", "null"],
      enum: ["document", "cle", null],
      description:
        "Comment la plage a été bornée. TOUJOURS présent (nul hors mode plage) : " +
        "« absent » et « borné par le texte » ne doivent pas être confondus. " +
        "'document' — étendue exacte, dans l'ordre du texte officiel ; " +
        "'cle' — bornée par la clé de tri, qui n'est pas un ordre total et peut sur-inclure.",
    },
    articles: {
      type: "array",
      items: {
        type: "object",
        properties: {
          number: { type: "string" },
          text: { type: "string" },
          history: TEXTE_OU_NUL,
          division_path: { type: "string" },
          repealed: { type: "boolean" },
        },
        required: ["number", "text", "history", "division_path", "repealed"],
        additionalProperties: false,
      },
    },
  },
  required: ["law", "lang", "count", "total", "pagination", "range_resolution", "articles"],
  additionalProperties: false,
});

const DIVISION: JsonSchema = schemaEnveloppe({
  type: "object",
  properties: {
    law: { type: "string" },
    lang: LANGUE,
    division: {
      type: "object",
      properties: {
        division_id: { type: "integer" },
        path: { type: "string" },
        kind: { type: "string" },
        number: TEXTE_OU_NUL,
        heading: TEXTE_OU_NUL,
        history: TEXTE_OU_NUL,
        repealed: { type: "boolean" },
      },
      required: ["division_id", "path", "kind", "repealed"],
      additionalProperties: false,
    },
    children: {
      type: "array",
      items: {
        type: "object",
        properties: {
          division_id: { type: "integer" },
          path: { type: "string" },
          kind: { type: "string" },
          number: TEXTE_OU_NUL,
          heading: TEXTE_OU_NUL,
          repealed: { type: "boolean" },
        },
        required: ["division_id", "path", "kind", "repealed"],
        additionalProperties: false,
      },
    },
    articles: {
      type: "array",
      items: {
        type: "object",
        properties: {
          number: { type: "string" },
          division_path: { type: "string" },
          repealed: { type: "boolean" },
          // ABSENTS quand include_text vaut false — donc hors de `required`. Le schéma dit
          // ainsi la vérité dans les deux modes, plutôt que d'exiger un champ qu'un mode
          // légitime ne sert pas.
          text: { type: "string" },
          history: TEXTE_OU_NUL,
        },
        required: ["number", "division_path", "repealed"],
        additionalProperties: false,
      },
    },
    pagination: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1 },
        offset: { type: "integer", minimum: 0 },
        total: { type: "integer", minimum: 0 },
      },
      required: ["limit", "offset", "total"],
      additionalProperties: false,
    },
  },
  required: ["law", "lang", "division", "children", "articles", "pagination"],
  additionalProperties: false,
});

const REFERENCE_RESOLUE: JsonSchema = schemaEnveloppe({
  type: "object",
  properties: {
    resolved: {
      type: "object",
      properties: {
        law: { type: "string" },
        number: { type: "string" },
        lang: LANGUE,
        reconnue_par: {
          type: ["string", "null"],
          enum: ["chapitre", "abreviation", "defaut", null],
          description:
            "Comment la loi a été reconnue dans la citation. 'defaut' signale un REPLI : " +
            "aucune loi n'était nommée, le C.c.Q. a été supposé.",
        },
      },
      required: ["law", "number", "lang", "reconnue_par"],
      additionalProperties: false,
    },
    citation: { type: "string" },
    division_path: { type: "string" },
    consolidation: TEXTE_OU_NUL,
    history: TEXTE_OU_NUL,
    repealed: { type: "boolean" },
    text: { type: "string", description: "Le texte, verbatim. NON officiel — voir gardes." },
  },
  required: [
    "resolved",
    "citation",
    "division_path",
    "consolidation",
    "history",
    "repealed",
    "text",
  ],
  additionalProperties: false,
});

const PISTES_DE_RECHERCHE: JsonSchema = schemaEnveloppe({
  type: "object",
  properties: {
    query: { type: "string" },
    lang: LANGUE,
    tokens: { type: "array", items: { type: "string" }, description: "Termes réellement pesés." },
    weights: {
      type: "object",
      properties: {
        S1_SUBJECT: { type: "integer" },
        S2_DIVISION_HEADING: { type: "integer" },
        S3_LAW_NAME: { type: "integer" },
        S4_GRAPH_NEIGHBOUR: { type: "integer" },
      },
      required: ["S1_SUBJECT", "S2_DIVISION_HEADING", "S3_LAW_NAME", "S4_GRAPH_NEIGHBOUR"],
      additionalProperties: false,
      description: "Le barème, servi AVEC le résultat : un score sans son barème ne se lit pas.",
    },
    count: { type: "integer", minimum: 0 },
    avertissement: {
      type: "string",
      description:
        "Le garde-fou en prose. DOUBLE la réserve REPERAGE_HEURISTIQUE, dont il est la " +
        "source : champ conservé le temps d'une migration, son retrait sera annoncé.",
    },
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          law: { type: "string" },
          division_path: { ...TEXTE_OU_NUL, description: "Nul quand la piste vise TOUTE la loi." },
          heading: TEXTE_OU_NUL,
          score: { type: "number" },
          pourquoi: {
            type: "array",
            items: { type: "string" },
            description: "Les signaux qui ont fait retenir la piste, en toutes lettres.",
          },
        },
        required: ["law", "division_path", "heading", "score", "pourquoi"],
        additionalProperties: false,
      },
    },
  },
  required: ["query", "lang", "tokens", "weights", "count", "avertissement", "candidates"],
  additionalProperties: false,
});

/** Un appariement d'article, tel que la recherche le rend. */
const RESULTAT: JsonSchema = {
  type: "object",
  properties: {
    law_id: { type: "string" },
    number: { type: "string" },
    division_path: { type: "string" },
    snippet: { type: "string", description: "Extrait, avec la correspondance en évidence." },
    score: { type: "number", description: "bm25 — NÉGATIF : plus bas = plus pertinent." },
    semantic: { type: "boolean", description: "Issu du seul chemin vectoriel." },
    breadcrumb: { type: "string", description: "Le fil d'Ariane des divisions parentes." },
  },
  required: ["law_id", "number", "division_path", "snippet", "breadcrumb"],
  additionalProperties: false,
};

const RESULTATS_DE_RECHERCHE: JsonSchema = schemaEnveloppe({
  type: "object",
  properties: {
    query: { type: "string" },
    lang: LANGUE,
    law: { ...TEXTE_OU_NUL, description: "La loi à laquelle la recherche était bornée." },
    total: {
      type: "integer",
      minimum: 0,
      description: "Appariements LEXICAUX au corpus, non paginés. Vaut 0 sur un repli sémantique.",
    },
    returned: {
      type: "integer",
      minimum: 0,
      description: "Taille de la page rendue, toutes sources confondues.",
    },
    sources: {
      type: "object",
      properties: {
        lexical: { type: "integer", minimum: 0 },
        semantique: { type: "integer", minimum: 0 },
      },
      required: ["lexical", "semantique"],
      additionalProperties: false,
      description:
        "TROIS décomptes, trois sens : « total: 1 » avec cinq résultats n'est pas une " +
        "incohérence, c'est un appariement lexical plus quatre voisins sémantiques. " +
        "`lexical` compte « présent dans la liste FTS », NON « non influencé par les vecteurs ».",
    },
    fallback: {
      type: ["string", "null"],
      description:
        "Comment la recherche a dû s'élargir. Nul = exacte dans la portée demandée. " +
        "'widened' — hors de la loi demandée ; 'loo:<terme>' — un terme retiré ; " +
        "'or_relax' — passage au OU ; 'semantic' — aucune correspondance lexicale. " +
        "Quand ce champ n'est pas nul, la réserve REPLI_LEXICAL accompagne la réponse.",
    },
    elsewhere: {
      type: ["object", "null"],
      properties: {
        total: { type: "integer", minimum: 0 },
        results: { type: "array", items: RESULTAT },
      },
      required: ["total", "results"],
      additionalProperties: false,
      description: "Aperçu HORS de la portée demandée, quand elle en avait aussi.",
    },
    divisions_semantiques: {
      type: "array",
      items: {
        type: "object",
        properties: {
          law_id: { type: "string" },
          path: { type: "string" },
          heading: TEXTE_OU_NUL,
          score: { type: "number" },
        },
        required: ["law_id", "path", "score"],
        additionalProperties: false,
      },
      description: "Correspondances de STRUCTURE — des intitulés de division, non des articles.",
    },
    pagination: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1 },
        offset: { type: "integer", minimum: 0 },
      },
      required: ["limit", "offset"],
      additionalProperties: false,
    },
    results: { type: "array", items: RESULTAT },
  },
  required: [
    "query",
    "lang",
    "law",
    "total",
    "returned",
    "sources",
    "fallback",
    "elsewhere",
    "divisions_semantiques",
    "pagination",
    "results",
  ],
  additionalProperties: false,
});

/**
 * Les outils dont la sortie est enveloppée, et eux seuls.
 *
 * ⚠ LES DIX Y SONT, depuis le 2026-09-17. Le mécanisme reste néanmoins conditionnel :
 *   `tools/list` ne publie d'`outputSchema` que pour les outils listés ici. Un outil
 *   NEUF ne doit donc pas y entrer avant que son gestionnaire n'enveloppe réellement —
 *   publier une enveloppe pour une charge plate serait un contrat que le serveur viole
 *   lui-même. `test/sortie.test.ts` exige en outre un gabarit d'appel par entrée.
 */
export const SORTIES: Record<string, JsonSchema> = {
  legislation_list_laws: CARTE_DU_CORPUS,
  legislation_list_subjects: LISTE_MATIERES,
  legislation_related_laws: GRAPHE_DES_LOIS,
  legislation_get_article: ARTICLE,
  legislation_get_articles: ARTICLES,
  legislation_get_structure: PLAN_DE_LOI,
  legislation_get_division: DIVISION,
  legislation_resolve_reference: REFERENCE_RESOLUE,
  legislation_find_relevant: PISTES_DE_RECHERCHE,
  legislation_search_text: RESULTATS_DE_RECHERCHE,
};
