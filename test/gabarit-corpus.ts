/**
 * Un corpus d'essai minimal mais COMPLET, partagé par les gardes de sortie.
 *
 * POURQUOI IL EXISTE. G5 — « toute charge servie valide contre son `outputSchema` » — n'a de
 * valeur que si la charge est réellement produite. Une base vide fait rendre `err(...)` à
 * chaque outil, et le test passe alors au vert sans avoir rien mesuré. Ce gabarit donne à
 * chaque outil de quoi rendre une charge PLEINE.
 *
 * CE QU'IL CONTIENT, ET POURQUOI CHAQUE PIÈCE Y EST :
 *   · deux lois, dont une avec loi habilitante — `parent_law_id` non nul est un cas servi ;
 *   · une loi SANS traduction de portée ni de forum — les `null` de colonne sont la moitié
 *     des défauts que le schéma doit attraper, et ils n'apparaissent que si on les sème ;
 *   · une hiérarchie sur trois niveaux (livre → titre → chapitre) — le plan de `list_laws`
 *     ne se remplit qu'à partir des LIVRES, et l'arbre de `get_structure` n'a de profondeur
 *     que si elle existe en base ;
 *   · des articles dont un ABROGÉ et un sans historique ;
 *   · deux matières, une arête de graphe dans le corpus et une HORS corpus (`in_corpus = 0`,
 *     le candidat d'acquisition) ;
 *   · l'index FTS5 reconstruit — table à contenu externe, elle ne se remplit pas seule.
 *
 * ⚠ CE N'EST PAS DU DROIT. Les lois s'appellent `essai-*`, les articles sont inventés et
 *   aucune citation ne renvoie à un texte officiel. C'est délibéré : aucune de ces lignes ne
 *   doit pouvoir être prise pour une donnée.
 */

/**
 * [id, name_fr, name_en, citation, fonction, forum, scope_fr, parent_law_id]
 *
 * ⚠ LA CITATION A LA FORME RLRQ, et ce n'est pas cosmétique : `parseCitation` reconnaît une
 *   loi en retirant le préfixe « RLRQ, c. » de `official_cite`, puis en cherchant le
 *   chapitre restant dans le texte. Une citation d'une autre forme n'apparie jamais, et
 *   `resolve_reference` devient intestable. Le chapitre « ESSAI-n » n'existe pas au recueil.
 */
const LOIS: Array<
  [string, string, string, string, string, string | null, string | null, string | null]
> = [
  [
    "essai-code",
    "Code d'essai",
    "Test Code",
    "RLRQ, c. ESSAI-1",
    "loi",
    "Cour d'essai",
    "Régit les rapports d'essai.",
    null,
  ],
  // Règlement : loi habilitante NON NULLE, et tout le reste à NULL — le cas où la charge
  // servie est pleine de nuls légitimes.
  [
    "essai-regl",
    "Règlement d'essai",
    "Test Regulation",
    "RLRQ, c. ESSAI-1, r. 1",
    "reglement",
    null,
    null,
    "essai-code",
  ],
];

/** [id, law_id, kind, number, heading, path, parent_id, sort_order] */
const DIVISIONS: Array<
  [number, string, string, string | null, string | null, string, number | null, number]
> = [
  [1, "essai-code", "livre", "PREMIER", "DES PERSONNES D'ESSAI", "ga:l_premier", null, 0],
  [2, "essai-code", "titre", "I", "De la capacité", "ga:l_premier-gb:t_i", 1, 1],
  [3, "essai-code", "chapitre", "I", "Dispositions", "ga:l_premier-gb:t_i-gc:c_i", 2, 2],
  // Division SANS intitulé ni numéro : trois cas réels au corpus, et deux `null` de plus.
  [4, "essai-code", "section", null, null, "ga:l_premier-gb:t_i-gc:c_i-gd:s_i", 3, 3],
  [5, "essai-regl", "chapitre", "I", "Application", "ga:c_i", null, 0],
];

/** [id, law_id, number, text, history, division_path, repealed] */
const ARTICLES: Array<[number, string, string, string, string | null, string, number]> = [
  [
    1,
    "essai-code",
    "1",
    "Toute personne d'essai possède la capacité d'essai.",
    "1991, c. 64",
    "ga:l_premier-gb:t_i-gc:c_i",
    0,
  ],
  // Sans historique : `history` nul est servi tel quel.
  [
    2,
    "essai-code",
    "2",
    "La capacité d'essai s'exerce sous réserve d'essai.",
    null,
    "ga:l_premier-gb:t_i-gc:c_i",
    0,
  ],
  // Abrogé : `repealed = 1`, et le texte reste servi.
  [3, "essai-code", "3", "(Abrogé).", "1999, c. 40", "ga:l_premier-gb:t_i-gc:c_i-gd:s_i", 1],
  [4, "essai-regl", "1", "Le présent règlement d'essai s'applique aux essais.", null, "ga:c_i", 0],
];

/** [id, label_fr, label_en, label_norm, kind, description_fr, description_en] */
const MATIERES: Array<
  [string, string, string | null, string, string, string | null, string | null]
> = [
  [
    "essai-plein",
    "Matière d'essai",
    "Test subject",
    "matiere essai",
    "prive-ccq",
    "Description d'essai.",
    "Test description.",
  ],
  // Ni traduction ni description : le cas qui a fait entrer l'union de types dans le socle.
  [
    "essai-nu",
    "Matière sans traduction",
    null,
    "matiere sans traduction",
    "specialise",
    null,
    null,
  ],
];

/** [subject_id, law_id, division_path] */
const MAPPAGE: Array<[string, string, string]> = [
  ["essai-plein", "essai-code", ""],
  ["essai-plein", "essai-code", "ga:l_premier"],
  ["essai-nu", "essai-regl", ""],
];

/** [from, to, rel_type, source, weight, in_corpus, note] */
const RELATIONS: Array<[string, string, string, string, number, number, string | null]> = [
  ["essai-regl", "essai-code", "reglement-de", "cure", 1, 1, "Arête d'essai, relevée à la main."],
  // Cible HORS corpus : `in_corpus = 0`, et `other_name` retombe sur l'identifiant brut.
  ["essai-code", "E-99", "renvoie-a", "auto", 3, 0, null],
];

/**
 * Minuscules, sans accents — la forme des colonnes `*_norm`.
 *
 * ⚠ SANS ELLE, `find_relevant` N'APPARIE RIEN. Il ne lit ni `label_fr` ni `heading` mais
 *   `label_norm`, `name_norm` et `heading_norm` : semer des accents dans ces colonnes
 *   donnerait un corpus d'essai où le repérage échoue pour une raison qui n'existe pas en
 *   production, et ferait accuser l'outil.
 */
const norm = (t: string) =>
  t
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

export async function amorcerGabarit(db: D1Database): Promise<void> {
  for (const [id, fr, en, citation, fonction, forum, scope, parent] of LOIS) {
    await db
      .prepare(
        "INSERT OR IGNORE INTO laws (id, name_fr, name_en, official_cite, consol_date_fr," +
          " consol_date_en, fonction, forum, scope_fr, parent_law_id, name_norm)" +
          " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        id,
        fr,
        en,
        citation,
        "2026-01-01",
        "2026-01-01",
        fonction,
        forum,
        scope,
        parent,
        norm(fr),
      )
      .run();
  }

  for (const [id, law, kind, number, heading, path, parent, ordre] of DIVISIONS) {
    for (const lang of ["fr", "en"]) {
      await db
        .prepare(
          "INSERT OR IGNORE INTO divisions (id, law_id, lang, kind, number, heading," +
            " heading_norm, path, parent_id, sort_order) VALUES (?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          lang === "fr" ? id : id + 100,
          law,
          lang,
          kind,
          number,
          heading,
          heading ? norm(heading) : null,
          path,
          parent,
          ordre,
        )
        .run();
    }
  }

  for (const [id, law, number, text, history, path, repealed] of ARTICLES) {
    await db
      .prepare(
        "INSERT OR IGNORE INTO articles (id, law_id, lang, number, sort_key, division_path," +
          " text, history, repealed) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .bind(id, law, "fr", number, id * 1000, path, text, history, repealed)
      .run();
  }

  for (const [id, fr, en, norm, kind, dFr, dEn] of MATIERES) {
    await db
      .prepare(
        "INSERT OR IGNORE INTO subjects (id, label_fr, label_en, label_norm, kind," +
          " description_fr, description_en) VALUES (?,?,?,?,?,?,?)",
      )
      .bind(id, fr, en, norm, kind, dFr, dEn)
      .run();
  }

  for (const [sujet, loi, chemin] of MAPPAGE) {
    await db
      .prepare(
        "INSERT OR IGNORE INTO subject_map (subject_id, law_id, division_path) VALUES (?,?,?)",
      )
      .bind(sujet, loi, chemin)
      .run();
  }

  for (const [de, vers, type, source, poids, dansCorpus, note] of RELATIONS) {
    await db
      .prepare(
        "INSERT OR IGNORE INTO law_relations (from_law_id, to_law_id, rel_type, source, weight," +
          " in_corpus, note) VALUES (?,?,?,?,?,?,?)",
      )
      .bind(de, vers, type, source, poids, dansCorpus, note)
      .run();
  }

  // Table à CONTENU EXTERNE : elle ne se remplit pas toute seule (schema.sql, §recherche).
  await db.prepare("INSERT INTO articles_fts(articles_fts) VALUES('rebuild')").run();
}
