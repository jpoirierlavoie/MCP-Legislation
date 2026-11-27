import type { JsonSchema } from "@poirierlavoie/mcp-socle/protocole/valide";
import catalogue from "../data/catalogue.json";

const titre = (nom: keyof typeof catalogue.tools): string => catalogue.tools[nom].title_fr;

export interface DescripteurPublie {
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: Record<string, boolean>;
  execution?: Record<string, string>;
}

export const LIST_LAWS: DescripteurPublie = {
  title: titre("list_laws"),
  description:
    "Carte du corpus : toutes les lois avec identifiant, noms FR/EN, citation RLRQ, langues, date de consolidation, nombre d'articles, et les attributs de découverte (domaine, juridiction, fonction, forum, matières, loi habilitante ; pour les grands codes, les Livres avec leur matière). Inclut les directives de cour et orientations AMF (source PDF). Filtres optionnels : domains (défaut ['core'], ou ['all']), jurisdiction ('qc'|'ca'), fonction, forum, subject. Point de départ pour explorer le corpus ; pour partir d'un problème concret, préférer find_relevant.",
  inputSchema: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    additionalProperties: false,
    properties: {
      domains: {
        description:
          "Domaines à inclure (défaut ['core'], ou ['all'] pour tout le corpus) : 'core', 'cours-federales', 'financier', 'construction-immobilier', 'municipal-environnement', 'travail', 'penal', 'propriete-intellectuelle', 'all'.",
        type: "array",
        items: {
          type: "string",
          enum: [
            "core",
            "cours-federales",
            "financier",
            "construction-immobilier",
            "municipal-environnement",
            "travail",
            "penal",
            "propriete-intellectuelle",
            "all",
          ],
        },
      },
      jurisdiction: {
        description: "Filtrer par ordre de gouvernement : 'qc' (Québec) ou 'ca' (fédéral).",
        type: "string",
        enum: ["qc", "ca"],
      },
      fonction: {
        description:
          "Filtrer par fonction : 'loi', 'regles-procedure', 'tarif', 'reglement', 'directive', 'orientation'.",
        type: "string",
      },
      forum: {
        description: "Filtrer par forum, ex. 'Tribunal administratif du logement', 'Cour d'appel'.",
        type: "string",
      },
      subject: {
        description:
          "Filtrer par identifiant de matière, ex. 'louage-residentiel' (cf. list_subjects).",
        type: "string",
      },
      structure: {
        default: true,
        description:
          "Inclure le plan profondeur 2 (Livres et leurs Titres) des grands codes (défaut true).",
        type: "boolean",
      },
      lang: {
        default: "fr",
        description: "Langue : 'fr' (défaut) ou 'en'.",
        type: "string",
        enum: ["fr", "en"],
      },
    },
  },
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  execution: {
    taskSupport: "forbidden",
  },
};

export const LIST_SUBJECTS: DescripteurPublie = {
  title: titre("list_subjects"),
  description:
    "Liste les matières de la taxonomie (droit privé du C.c.Q. et matières spécialisées) : identifiant, libellé, description, et nombre de lois / divisions rattachées. Sert à choisir un domaine, puis à filtrer list_laws (subject=…).",
  inputSchema: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    additionalProperties: false,
    properties: {
      lang: {
        default: "fr",
        description: "Langue : 'fr' (défaut) ou 'en'.",
        type: "string",
        enum: ["fr", "en"],
      },
    },
  },
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  execution: {
    taskSupport: "forbidden",
  },
};

export const RELATED_LAWS: DescripteurPublie = {
  title: titre("related_laws"),
  description:
    "Graphe d'interconnexion d'une loi : règlements pris sous son autorité, loi habilitante, renvois vers d'autres textes, et relations curées (met-en-oeuvre, applique, complète, preseance-sur, interprete…). Signale les cibles NON disponibles au corpus. Ex. : law='cpc' pour voir ses règlements de cour.",
  inputSchema: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    additionalProperties: false,
    properties: {
      law: {
        type: "string",
        description:
          "Identifiant COURT propre à ce corpus (ex. 'ccq', 'cpc', 'ca-b-3') — ce n'est ni le chapitre RLRQ ni le titre. Obtenu par list_laws.",
      },
      rel_type: {
        description:
          "Filtrer par type : 'reglement-de', 'renvoie-a', 'met-en-oeuvre', 'applique', 'complete', 'encadre-par', 'connexe', 'preseance-sur', 'interprete'.",
        type: "string",
      },
      direction: {
        default: "both",
        description: "'out' : depuis la loi ; 'in' : vers la loi ; 'both' (défaut).",
        type: "string",
        enum: ["out", "in", "both"],
      },
      limit: {
        description: "Max d'arêtes (défaut 50, max 200).",
        type: "integer",
        minimum: 1,
        maximum: 200,
      },
      lang: {
        default: "fr",
        description: "Langue : 'fr' (défaut) ou 'en'.",
        type: "string",
        enum: ["fr", "en"],
      },
    },
    required: ["law"],
  },
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  execution: {
    taskSupport: "forbidden",
  },
};

export const FIND_RELEVANT: DescripteurPublie = {
  title: titre("find_relevant"),
  description:
    "Aide heuristique au repérage de lois et de parties de lois candidates. Ne détermine PAS le droit applicable : toujours vérifier en lisant le texte via get_structure / get_division / get_article. Classement déterministe sur la matière (taxonomie), les intitulés de divisions, les noms de lois et le graphe d'interconnexion. Ex. : query='vice caché maison', 'congédiement', 'bail commercial'. Enchaîner ensuite avec get_structure / get_division. Par défaut, interroge le domaine 'core' (radar sur les silos sectoriels exclus) ; passer domains=['core', …], jurisdiction ou forum pour élargir ou cibler.",
  inputSchema: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    additionalProperties: false,
    properties: {
      query: {
        type: "string",
        description: "Thème ou description libre du problème, ex. « bail de logement ».",
      },
      domains: {
        description:
          "Domaines à interroger (défaut ['core'], ou ['all']) : 'core', 'cours-federales', 'financier', 'construction-immobilier', 'municipal-environnement', 'travail', 'penal', 'propriete-intellectuelle', 'all'.",
        type: "array",
        items: {
          type: "string",
          enum: [
            "core",
            "cours-federales",
            "financier",
            "construction-immobilier",
            "municipal-environnement",
            "travail",
            "penal",
            "propriete-intellectuelle",
            "all",
          ],
        },
      },
      jurisdiction: {
        description: "Restreindre à un ordre de gouvernement : 'qc' ou 'ca'.",
        type: "string",
        enum: ["qc", "ca"],
      },
      forum: {
        description:
          "Cibler un tribunal (ex. 'Cour supérieure', 'Cour du Québec', 'Cour d\\'appel') : conserve les lois générales/transversales et écarte les règles d'autres tribunaux.",
        type: "string",
      },
      limit: {
        description: "Nombre de candidats (défaut 8, max 50).",
        type: "integer",
        minimum: 1,
        maximum: 50,
      },
      lang: {
        default: "fr",
        description: "Langue : 'fr' (défaut) ou 'en'.",
        type: "string",
        enum: ["fr", "en"],
      },
    },
    required: ["query"],
  },
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  execution: {
    taskSupport: "forbidden",
  },
};

export const GET_ARTICLE: DescripteurPublie = {
  title: titre("get_article"),
  description:
    "Retourne le texte officiel verbatim d'un article, avec citation, chemin hiérarchique, date de consolidation et historique. Ex. : law='ccq', article='1457'. Les dispositions se demandent avec article='préliminaire' ou 'finales'. Couvre aussi les paragraphes de directives, sections alphanumériques ('2A.1') et annexes ('annexe-1') avec liens et statut normatif. Si la loi pertinente est inconnue, commencer par find_relevant.",
  inputSchema: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    additionalProperties: false,
    properties: {
      law: {
        type: "string",
        description:
          "Identifiant COURT propre à ce corpus (ex. 'ccq', 'cpc', 'ca-b-3') — ce n'est ni le chapitre RLRQ ni le titre. Obtenu par list_laws ou find_relevant.",
      },
      article: {
        type: "string",
        description: "Numéro d'article, ex. '1457', '2926.1', '132.0.1', '2A.1', 'annexe-1'.",
      },
      lang: {
        default: "fr",
        description: "Langue : 'fr' (défaut) ou 'en'.",
        type: "string",
        enum: ["fr", "en"],
      },
    },
    required: ["law", "article"],
  },
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  execution: {
    taskSupport: "forbidden",
  },
};

export const GET_ARTICLES: DescripteurPublie = {
  title: titre("get_articles"),
  description:
    "Retourne plusieurs articles : soit une plage (from..to), soit une liste explicite (numbers). Paginé. Ex. : law='ccq', from='1457', to='1460' ; ou numbers=['1457','1590']. Si la loi pertinente est inconnue, commencer par find_relevant.",
  inputSchema: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    additionalProperties: false,
    properties: {
      law: {
        type: "string",
        description:
          "Identifiant COURT propre à ce corpus (ex. 'ccq', 'cpc', 'ca-b-3') — ce n'est ni le chapitre RLRQ ni le titre. Obtenu par list_laws ou find_relevant.",
      },
      from: {
        description: "Borne basse d'une plage, ex. '1457'.",
        type: "string",
      },
      to: {
        description: "Borne haute d'une plage, ex. '1460'.",
        type: "string",
      },
      numbers: {
        description: "Liste de numéros, ex. ['1457','1590'].",
        type: "array",
        items: {
          type: "string",
        },
      },
      lang: {
        default: "fr",
        description: "Langue : 'fr' (défaut) ou 'en'.",
        type: "string",
        enum: ["fr", "en"],
      },
      limit: {
        description: "Max d'articles (défaut 50, max 200).",
        type: "integer",
        minimum: 1,
        maximum: 200,
      },
      offset: {
        description: "Décalage de pagination (≥ 0).",
        type: "integer",
        minimum: 0,
        maximum: 9007199254740991,
      },
    },
    required: ["law"],
  },
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  execution: {
    taskSupport: "forbidden",
  },
};

export const GET_STRUCTURE: DescripteurPublie = {
  title: titre("get_structure"),
  description:
    "Arbre hiérarchique des divisions (Livre → Titre → Chapitre → Section → Sous-section), SANS texte d'article — pour explorer avant d'extraire. Chaque nœud donne kind, number, heading et son 'path' (à passer à get_division). Utiliser root_path pour un sous-arbre et depth pour limiter la profondeur (défaut 2 : livres et titres). Si la loi pertinente est inconnue, commencer par find_relevant.",
  inputSchema: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    additionalProperties: false,
    properties: {
      law: {
        type: "string",
        description:
          "Identifiant COURT propre à ce corpus (ex. 'ccq', 'cpc', 'ca-b-3') — ce n'est ni le chapitre RLRQ ni le titre. Obtenu par list_laws ou find_relevant.",
      },
      lang: {
        default: "fr",
        description: "Langue : 'fr' (défaut) ou 'en'.",
        type: "string",
        enum: ["fr", "en"],
      },
      root_path: {
        description: "Restreindre à ce sous-arbre (path d'une division).",
        type: "string",
      },
      depth: {
        description: "Profondeur affichée (défaut 2).",
        type: "integer",
        minimum: 1,
        maximum: 9,
      },
    },
    required: ["law"],
  },
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  execution: {
    taskSupport: "forbidden",
  },
};

export const GET_DIVISION: DescripteurPublie = {
  title: titre("get_division"),
  description:
    "Retourne une division (Livre/Titre/Chapitre/Section/…) : son intitulé, ses sous-divisions immédiates, et les articles qu'elle contient (tout le sous-arbre, paginés). Identifier par path (recommandé, via get_structure) ou division_id. include_text=false pour n'avoir que les numéros d'articles. Si la loi pertinente est inconnue, commencer par find_relevant.",
  inputSchema: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    additionalProperties: false,
    properties: {
      law: {
        type: "string",
        description:
          "Identifiant COURT propre à ce corpus (ex. 'ccq', 'cpc', 'ca-b-3') — ce n'est ni le chapitre RLRQ ni le titre. Obtenu par list_laws ou find_relevant.",
      },
      path: {
        description: "Chemin de la division (ex. 'ga:l_cinquieme-gb:l_premier').",
        type: "string",
      },
      division_id: {
        description: "Identifiant numérique de la division.",
        type: "integer",
        minimum: -9007199254740991,
        maximum: 9007199254740991,
      },
      lang: {
        default: "fr",
        description: "Langue : 'fr' (défaut) ou 'en'.",
        type: "string",
        enum: ["fr", "en"],
      },
      include_text: {
        default: true,
        description: "Inclure le texte des articles (défaut true).",
        type: "boolean",
      },
      limit: {
        description: "Max d'articles (défaut 50, max 200).",
        type: "integer",
        minimum: 1,
        maximum: 200,
      },
      offset: {
        description: "Décalage de pagination (≥ 0).",
        type: "integer",
        minimum: 0,
        maximum: 9007199254740991,
      },
    },
    required: ["law"],
  },
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  execution: {
    taskSupport: "forbidden",
  },
};

export const SEARCH_TEXT: DescripteurPublie = {
  title: titre("search_text"),
  description:
    "Recherche plein texte (FTS5) dans le texte des articles. Retourne les correspondances classées par pertinence avec un extrait surligné. Ex. : query='prescription action', law='ccq' (défaut : domaine 'core'). Si la loi pertinente est inconnue, commencer par find_relevant. Omettre `law` sauf raison précise de restreindre ; une recherche restreinte sans résultat est automatiquement élargie à son domaine. Sans `law`, interroge 'core' par défaut avec radar sur les domaines exclus (filtres domains, jurisdiction, forum).",
  inputSchema: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    additionalProperties: false,
    properties: {
      query: {
        type: "string",
        description: "Termes à rechercher, ex. 'responsabilité préjudice'.",
      },
      law: {
        description:
          "Restreindre à une loi par son identifiant court de corpus (ex. 'ccq') ; défaut : domaines actifs.",
        type: "string",
      },
      domains: {
        description:
          "Domaines à interroger sans `law` (défaut ['core'], ou ['all']) : 'core', 'cours-federales', 'financier', 'construction-immobilier', 'municipal-environnement', 'travail', 'penal', 'propriete-intellectuelle', 'all'.",
        type: "array",
        items: {
          type: "string",
          enum: [
            "core",
            "cours-federales",
            "financier",
            "construction-immobilier",
            "municipal-environnement",
            "travail",
            "penal",
            "propriete-intellectuelle",
            "all",
          ],
        },
      },
      jurisdiction: {
        description: "Restreindre à un ordre de gouvernement : 'qc' ou 'ca'.",
        type: "string",
        enum: ["qc", "ca"],
      },
      forum: {
        description:
          "Cibler un tribunal (ex. 'Cour supérieure', 'Cour du Québec', 'Cour d\\'appel') : conserve les lois générales/transversales et écarte les règles d'autres tribunaux.",
        type: "string",
      },
      lang: {
        default: "fr",
        description: "Langue : 'fr' (défaut) ou 'en'.",
        type: "string",
        enum: ["fr", "en"],
      },
      limit: {
        description: "Max de résultats (défaut 10, max 50).",
        type: "integer",
        minimum: 1,
        maximum: 50,
      },
      offset: {
        description: "Décalage de pagination (≥ 0).",
        type: "integer",
        minimum: 0,
        maximum: 9007199254740991,
      },
    },
    required: ["query"],
  },
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  execution: {
    taskSupport: "forbidden",
  },
};

export const RESOLVE_REFERENCE: DescripteurPublie = {
  title: titre("resolve_reference"),
  description:
    "Résout une citation en texte libre (ex. « art. 1457 C.c.Q. », « RLRQ, c. T-16, art. 12 », « art. 69.3 L.F.I. ») vers l'article officiel. Reconnaît le chapitre RLRQ de n'importe quelle loi du corpus, ainsi que les abréviations usuelles (C.c.Q., C.p.c., L.F.I./B.I.A., L.C.S.A./C.B.C.A., L.A.C.C./C.C.A.A., L.D.…). Reconnaît aussi par./dir. (directives C.S./C.Q.) et les instructions générales AMF (« IG 45-106, art. 2A.1 »), en refusant toute citation ambiguë. Si la loi pertinente est inconnue, commencer par find_relevant.",
  inputSchema: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    additionalProperties: false,
    properties: {
      citation: {
        type: "string",
        description: "Citation libre, ex. « article 1457 C.c.Q. ».",
      },
      lang: {
        default: "fr",
        description: "Langue : 'fr' (défaut) ou 'en'.",
        type: "string",
        enum: ["fr", "en"],
      },
    },
    required: ["citation"],
  },
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  execution: {
    taskSupport: "forbidden",
  },
};

export const PUBLIES: Record<string, DescripteurPublie> = {
  list_laws: LIST_LAWS,
  list_subjects: LIST_SUBJECTS,
  related_laws: RELATED_LAWS,
  find_relevant: FIND_RELEVANT,
  get_article: GET_ARTICLE,
  get_articles: GET_ARTICLES,
  get_structure: GET_STRUCTURE,
  get_division: GET_DIVISION,
  search_text: SEARCH_TEXT,
  resolve_reference: RESOLVE_REFERENCE,
};
