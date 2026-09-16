// Garde de l'INTERRUPTEUR DU CORPUS FÉDÉRAL (`FEDERAL_CORPUS`, R8) — hors réseau, en CI.
//
// POURQUOI CETTE GARDE EXISTE. Mesuré en production le 2026-09-11, interrupteur FERMÉ, après
// l'ingestion du premier texte fédéral (`ca-i-15`) :
//
//     list_laws                            : 79 lois, 0 texte ca-*   <- correct
//     get_article(law='ca-i-15', art='2')  : SERVI                   <- FUITE
//     search_text                          : 3 résultats ca-*        <- FUITE
//
// J'avais posé le masque dans la carte du corpus et cru l'avoir posé partout. Un interrupteur
// qui ne ferme qu'une porte sur cinq est PIRE que pas d'interrupteur : il donne l'apparence du
// contrôle. Le défaut n'était donc pas une clause oubliée, c'était une VÉRIFICATION faite de
// mémoire — et c'est ça que ce fichier remplace.
//
// MÉTHODE : liste BLANCHE, comme la liste blanche de chaînes d'ancêtres du parseur LIMS. Toute
// lecture SQL d'une table du corpus doit être soit masquée, soit inscrite dans `TOLERES` avec
// une justification ÉCRITE. Une lecture neuve non masquée fait ROUGIR la CI ; elle ne passe
// pas en silence. Et `TOLERES` est vérifiée dans les DEUX SENS : une entrée qui ne correspond
// plus à aucune lecture est une erreur elle aussi, sinon la liste se remplirait de permissions
// périmées qui couvriraient un jour du code qu'on n'a jamais relu.
//
// CE QUE CETTE GARDE N'ATTRAPE PAS, et il faut le savoir : elle lit la SOURCE, donc elle voit
// une clause posée, pas une clause EFFICACE. Un masque sur la mauvaise colonne lui semblerait
// bon. La preuve d'efficacité reste la sonde bout-en-bout contre un serveur (`tests/evals.mjs`).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

const FICHIERS = ["src/lib.ts", "src/site.ts", "src/backfill.ts", "src/tools.ts"];

/** Tables portant une dimension `law_id` : ce sont celles que l'interrupteur doit masquer. */
const TABLES =
  /\b(?:FROM|JOIN)\s+(laws|articles|articles_fts|divisions|subject_map|law_relations|article_numbers)\b/;

/** Marqueurs d'un masque POSÉ, qu'il soit écrit dans la requête ou dans la ligne qui la nourrit. */
const MASQUE =
  /masqueLawId|masqueAutreBout|clauseJuridiction|jurisdiction\s*=\s*'qc'|jurisdiction\s*<>\s*'qc'/;

/** Déclarations de fonction de premier niveau — bornes de portée pour la résolution. */
const DECL_FN = /(?:^|\n)(?:export\s+)?(?:async\s+)?function\s+(\w+)/g;

/**
 * Extrait l'argument complet de chaque `.prepare(…)`, en sautant correctement les littéraux
 * de gabarit (y compris leurs `${}` imbriqués) et les chaînes. Un simple découpage par
 * parenthèses se ferait piéger par le `(${ids.map(() => "?").join(",")})` des requêtes `IN`.
 */
function requetes(src) {
  const out = [];
  let i = 0;
  for (;;) {
    const k = src.indexOf(".prepare(", i);
    if (k < 0) break;
    let j = k + ".prepare(".length;
    let depth = 1;
    const start = j;
    while (j < src.length && depth > 0) {
      const c = src[j];
      if (c === "`") {
        j++;
        let d2 = 0;
        while (j < src.length) {
          if (src[j] === "\\") {
            j += 2;
            continue;
          }
          if (src[j] === "$" && src[j + 1] === "{") {
            d2++;
            j += 2;
            continue;
          }
          if (src[j] === "}" && d2 > 0) {
            d2--;
            j++;
            continue;
          }
          if (src[j] === "`" && d2 === 0) break;
          j++;
        }
        j++;
        continue;
      }
      if (c === '"' || c === "'") {
        const q = c;
        j++;
        while (j < src.length && src[j] !== q) {
          if (src[j] === "\\") j++;
          j++;
        }
        j++;
        continue;
      }
      if (c === "(") depth++;
      if (c === ")") depth--;
      j++;
    }
    out.push({ pos: k, ligne: src.slice(0, k).split("\n").length, texte: src.slice(start, j - 1) });
    i = j;
  }
  return out;
}

/** Fonction englobante d'une position, et l'offset de sa déclaration. */
function fonctionDe(src, pos) {
  let nom = "(module)";
  let debut = -1;
  for (const m of src.matchAll(DECL_FN)) {
    if (m.index < pos && m.index > debut) {
      debut = m.index;
      nom = m[1];
    }
  }
  return { nom, debut: debut < 0 ? 0 : debut };
}

/** Corps de la fonction englobante — la portée dans laquelle un masque compte. */
function portee(src, pos) {
  const { debut } = fonctionDe(src, pos);
  let fin = src.length;
  for (const m of src.matchAll(DECL_FN))
    if (m.index > pos) {
      fin = m.index;
      break;
    }
  return src.slice(debut, fin);
}

/**
 * Un masque peut être posé INDIRECTEMENT, par une variable interpolée. Trois formes vivent
 * réellement dans ce dépôt, et la résolution doit couvrir les trois :
 *
 *     `… WHERE id = ?${masque}`        <- const masque = … 'qc' …
 *     `… FROM laws l ${clause}`        <- clause <- where[] <- where.push(clauseJuridiction(…))
 *     `… FROM articles_fts ${where}`   <- where  <- clauses[] <- clauses.push(masqueLawId(…))
 *
 * D'où DEUX niveaux, et une recherche par LIGNE plutôt que par déclaration : un masque arrive
 * souvent par `push`, jamais par affectation. La portée est bornée à la fonction englobante —
 * à l'échelle du fichier, un `where` masqué ailleurs blanchirait un `where` qui ne l'est pas.
 *
 * Sans cette résolution la garde crierait sur du code correct, et une garde qui crie à tort
 * finit désarmée : c'est le pire des deux mondes.
 */
function masqueIndirect(src, pos, texte) {
  const lignes = portee(src, pos).split("\n");
  const nourrit = (id) => {
    const re = new RegExp(`\\b${id}\\b`);
    return lignes.some((l) => re.test(l) && MASQUE.test(l));
  };
  for (const m of texte.matchAll(/\$\{(\w+)\}/g)) {
    const id = m[1];
    if (nourrit(id)) return true;
    // 2e niveau : suivre les identifiants de la déclaration de `id` (p. ex. `clause` <- `where`).
    const decl = lignes.find((l) => new RegExp(`\\b(?:const|let)\\s+${id}\\b`).test(l));
    if (!decl) continue;
    for (const m2 of decl.matchAll(/\b([A-Za-z_]\w*)\b/g)) {
      if (m2[1] !== id && nourrit(m2[1])) return true;
    }
  }
  return false;
}

/**
 * Empreinte STABLE d'une requête : insensible aux déplacements de lignes, aux `${}` et aux
 * commentaires internes. Le nom de la fonction en fait partie — sans lui, `lawNames` et le
 * relevé de noms de `relatedLaws` auraient la MÊME empreinte (`SELECT id, name_fr, name_en
 * FROM laws WHERE id IN ()`), et une tolérance accordée à l'une couvrirait l'autre en silence.
 */
function empreinte(fichier, fn, texte) {
  const sql = texte
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    // Un niveau d'imbrication, parce que les requêtes `IN` en portent un :
    // `${ids.map(() => "?").join(",")}`. Sans lui, l'empreinte de `getArticle` sortait hachée.
    .replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, "")
    .replace(/[`"']/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    // Virgule finale de l'argument de `.prepare(…)`. Quand la requête tient sur sa propre
    // ligne, le formateur (virgules finales « all ») en ajoute une, qui se retrouvait dans
    // l'empreinte : `… IN () ,` cessait d'apparier `… IN ()` dans TOLERES, et la garde
    // rougissait sur une lecture inchangée. L'en-tête promet une empreinte insensible aux
    // déplacements de lignes ; elle ne l'était qu'à moitié.
    .replace(/[\s,]+$/, "")
    .slice(0, 70);
  return `${fichier} :: ${fn} :: ${sql}`;
}

/**
 * Lectures NON masquées et TOLÉRÉES, chacune avec son motif. Quatre familles seulement :
 *
 *   · « gardée en amont »   — l'outil passe par `getLaw(db, law, env)`, qui refuse un texte
 *                             masqué AVANT que cette requête ne soit atteinte. C'est le point
 *                             d'étranglement voulu ; le doubler partout coûterait une
 *                             sous-requête par appel sans rien fermer de plus.
 *   · « jointe en mémoire » — la requête ramène tout, mais son résultat n'est lu qu'à travers
 *                             une liste de lois DÉJÀ masquée ; une ligne fédérale n'est jamais
 *                             regardée. À VÉRIFIER À CHAQUE FOIS : aucun AGRÉGAT n'en est
 *                             tiré. C'est précisément là que la page publique fuyait — son
 *                             total d'articles, lui, sommait les deux ordres.
 *   · « dérivée d'un jeu masqué » — les identifiants viennent d'un tour précédent, masqué.
 *   · « hors surface servie » — route admin, pas un outil MCP.
 *
 * Une cinquième famille serait un défaut déguisé en tolérance : « ça n'arrive jamais ».
 */
const TOLERES = new Map(
  Object.entries({
    "src/lib.ts :: listLaws :: SELECT law_id, lang, COUNT(*) AS n FROM articles GROUP BY law_id, lang":
      "jointe en mémoire : `listLaws` ne lit ces décomptes qu'à travers `counts.filter((c) => " +
      "c.law_id === law.id)`, sur la liste de lois DÉJÀ masquée. Vérifié : aucune somme n'en " +
      "est tirée — c'est exactement ce qui distinguait ce cas de `renderSite`, dont le total " +
      "d'articles, lui, additionnait bel et bien les deux ordres de gouvernement.",

    "src/lib.ts :: listLaws :: SELECT sm.law_id, sm.division_path, s.label_fr, s.label_en, d.heading ":
      "jointe en mémoire : idem, lu par `maps.filter((m) => m.law_id === law.id)` sur la liste " +
      "masquée, et aucun décompte global n'en sort.",

    "src/lib.ts :: translatePaths :: SELECT afr.division_path AS fr_path, MIN(aen.division_path) AS other_p":
      "gardée en amont : pont des numéros d'articles (invariant 4), borné à `lawId`. Ses deux " +
      "appelants ont tranché avant — `listLaws` sur une loi de la liste masquée, `getDivision` " +
      "après `getLaw(db, law, env)`.",

    "src/lib.ts :: translatePaths :: SELECT path, heading FROM divisions WHERE law_id = ? AND lang = ? AND ":
      "gardée en amont : intitulés des chemins traduits, bornés au `lawId` déjà résolu.",

    "src/lib.ts :: translateDivisionPath :: SELECT path, heading FROM divisions WHERE law_id = ? AND lang = ? AND ":
      "gardée en amont : bornée au `lawId` déjà résolu par `getLaw`. Couvre les deux relevés " +
      "d'intitulé de la fonction (court-circuit fédéral et chemin traduit), au SQL identique.",

    "src/lib.ts :: translateDivisionPath :: SELECT a2.division_path AS p FROM articles a1 JOIN articles a2 ON a2.l":
      "gardée en amont : pont des numéros d'articles, borné au `lawId` déjà résolu.",

    "src/lib.ts :: lawOutlines :: SELECT id, law_id, path, kind, number, heading FROM divisions WHERE la":
      "gardée en amont, et doublement : `lawOutlines` borne à la constante `OUTLINE_LAWS`, " +
      "purement québécoise, ET filtre `kind = 'livre'`, qu'aucun texte fédéral ne portera. " +
      "Y ajouter une loi fédérale rendrait un plan VIDE sans erreur — c'est un défaut connu et " +
      "signalé, hors portée de l'interrupteur.",

    "src/lib.ts :: lawOutlines :: SELECT parent_id, path, kind, number, heading FROM divisions WHERE par":
      "dérivée d'un jeu masqué : enfants des divisions du tour `OUTLINE_LAWS` ci-dessus.",

    "src/lib.ts :: getArticle :: SELECT , d.kind AS d_kind, d.number AS d_number, d.heading AS d_headin":
      "gardée en amont : c'est LE point d'étranglement qui a été réparé. Chacun des appelants " +
      "de `getArticle` passe par `getLaw(db, law, env)` et refuse avant d'arriver ici ; la " +
      "fuite mesurée venait de ce que `getLaw` ne recevait pas `env`, pas de cette requête.",

    "src/lib.ts :: loadRelevanceData :: SELECT law_id, path, heading FROM divisions WHERE lang = fr AND path I":
      "dérivée d'un jeu masqué : intitulés des chemins retenus au tour précédent de " +
      "`loadRelevanceData`, dont le préfiltre de divisions porte le masque.",

    "src/lib.ts :: breadcrumbChains :: SELECT path, kind, number, heading FROM divisions WHERE law_id = ? AND":
      "dérivée d'un jeu masqué : fil d'Ariane des candidats déjà retenus par le repérage.",

    "src/lib.ts :: lawNames :: SELECT id, name_fr, name_en FROM laws WHERE id IN ()":
      "dérivée d'un jeu masqué : noms des lois candidates, toutes issues de " +
      "`loadRelevanceData`, dont les quatre sources (subject_map, laws, law_relations, " +
      "préfiltre de divisions) portent le masque.",

    "src/lib.ts :: articleBriefs :: SELECT law_id, number, division_path, substr(text, 1, 240) AS t, lengt":
      "dérivée d'un jeu masqué : `articleBriefs` matérialise des couples (loi, numéro) déjà " +
      "filtrés par `filtreVecteurs`, qui est LA garde du canal vectoriel — le masque D1 ne " +
      "peut pas l'atteindre, les identifiants venant des métadonnées de Vectorize.",

    "src/backfill.ts :: handleBackfillInner :: SELECT id, name_fr FROM laws WHERE id = ?":
      "hors surface servie : route ADMIN `/admin/backfill-vectors`, derrière un porteur " +
      "distinct (`backfill.token`), jamais un outil MCP. L'interrupteur borne ce qui est " +
      "SERVI, pas ce qui est indexé ; le filtre de juridiction des vecteurs est l'index de " +
      "métadonnées `jurisdiction` de la phase 6, posé AVANT le premier upsert (invariant 8).",

    "src/backfill.ts :: handleBackfillInner :: SELECT number, division_path, text FROM articles WHERE law_id = ? AND ":
      "hors surface servie : idem, la requête d'indexation de la même route admin.",
  }),
);

test("toute lecture SQL du corpus est masquée, ou tolérée avec un motif écrit", () => {
  const nues = [];
  const vues = new Set();

  for (const f of FICHIERS) {
    const src = readFileSync(f, "utf8");
    for (const r of requetes(src)) {
      if (!TABLES.test(r.texte)) continue;
      if (MASQUE.test(r.texte) || masqueIndirect(src, r.pos, r.texte)) continue;
      const fn = fonctionDe(src, r.pos).nom;
      const emp = empreinte(f, fn, r.texte);
      vues.add(emp);
      if (!TOLERES.has(emp)) nues.push(`${f}:${r.ligne}\n      "${emp}":`);
    }
  }

  assert.deepEqual(
    nues,
    [],
    "Lecture(s) du corpus NI masquée(s) NI tolérée(s) — l'interrupteur FEDERAL_CORPUS y fuit.\n" +
      "    Poser un masque (masqueLawId / clauseJuridiction / masqueAutreBout), ou inscrire\n" +
      "    l'empreinte dans TOLERES avec un motif écrit :\n\n" +
      nues.map((s) => `    · ${s}`).join("\n\n"),
  );

  // Dans l'AUTRE SENS : une tolérance périmée est une permission qui couvrirait du code neuf.
  const perimees = [...TOLERES.keys()].filter((k) => !vues.has(k));
  assert.deepEqual(
    perimees,
    [],
    "Tolérance(s) de TOLERES qui ne correspondent plus à aucune lecture — à retirer :\n" +
      perimees.map((s) => `    · ${s}`).join("\n"),
  );
});

test("chaque motif de tolérance nomme sa famille, et n'est pas un laissez-passer", () => {
  for (const [k, v] of TOLERES) {
    assert.ok(v.length >= 60, `motif trop court pour ${k}`);
    assert.match(
      v,
      /gardée en amont|jointe en mémoire|dérivée d'un jeu masqué|hors surface servie/,
      `le motif de ${k} doit nommer sa famille (cf. l'en-tête de TOLERES)`,
    );
  }
});

test("les outils MCP transmettent `env` aux lectures masquables", () => {
  const src = readFileSync("src/tools.ts", "utf8");
  // Ces fonctions portent le masque ; les appeler sans `env` le désarme SILENCIEUSEMENT,
  // parce que le paramètre a une valeur par défaut (`{}` = interrupteur fermé) — donc aucune
  // erreur de compilation. C'est exactement ainsi que la fuite mesurée est passée.
  for (const fn of ["getLaw", "listLaws", "listSubjects", "relatedLaws", "loadRelevanceData"]) {
    const appels = [...src.matchAll(new RegExp(`\\b${fn}\\(([^;]*?)\\)`, "gs"))];
    assert.ok(appels.length > 0, `aucun appel de ${fn} trouvé dans src/tools.ts`);
    for (const a of appels) {
      assert.match(
        a[1],
        /\benv\b/,
        `appel de ${fn} sans \`env\` dans src/tools.ts : « ${a[0].replace(/\s+/g, " ")} »`,
      );
    }
  }
});

test("searchText transmet `env`, et le canal vectoriel est filtré aux DEUX barreaux", () => {
  const tools = readFileSync("src/tools.ts", "utf8");
  const lib = readFileSync("src/lib.ts", "utf8");

  const appel = tools.match(/searchText\([^;]*?\);/s);
  assert.ok(appel, "appel de searchText introuvable dans src/tools.ts");
  assert.match(appel[0], /\benv\b/, "searchText appelé sans `env` : la recherche fuirait");

  // Le masque D1 ne peut PAS atteindre Vectorize : `queryVectors` lit `md.law` dans les
  // métadonnées. Et `divs` n'est jamais rematérialisée en base — elle est servie telle quelle.
  assert.equal(
    [...lib.matchAll(/filtreVecteurs\(/g)].length,
    3,
    "attendu : 1 définition + 2 appels (barreau cible et barreau élargi) de filtreVecteurs",
  );
  assert.match(
    lib,
    /vecWideCache\s*=\s*lawId && qVec\s*\n?\s*\?\s*await filtreVecteurs\(/,
    "le barreau ÉLARGI doit filtrer : sans lawId, il interroge TOUT l'index Vectorize",
  );

  // `runMatch` porte le masque sur `articles_fts` ; chacun de ses appels doit passer `env`.
  const appelsMatch = [...lib.matchAll(/\brunMatch\(([^;]*?)\)[,;)\s]/gs)].filter(
    (m) => !m[1].includes("db: D1Database"),
  );
  assert.ok(appelsMatch.length >= 6, `attendu >= 6 appels de runMatch, vu ${appelsMatch.length}`);
  for (const a of appelsMatch) {
    assert.match(
      a[1],
      /\benv\b/,
      `appel de runMatch sans \`env\` : « ${a[0].replace(/\s+/g, " ")} »`,
    );
  }
});

test("le futur paramètre `jurisdiction` ne peut pas ÉCRASER le masque", () => {
  const lib = readFileSync("src/lib.ts", "utf8");
  // La phase 5 implémentera `jurisdiction` sur `legislation_list_laws` (décision de Jason). Le
  // piège serait qu'il REMPLACE le masque au lieu de s'y ajouter : `jurisdiction='ca'`
  // deviendrait alors la porte de service de l'interrupteur — la seule requête du corpus
  // qui le contourne, et par un paramètre documenté.
  //
  // Épinglé AVANT que le paramètre n'existe, parce que c'est en l'écrivant qu'on sera tenté.
  const bloc = lib.match(/export async function listLaws\([\s\S]*?const clause = /);
  assert.ok(bloc, "corps de listLaws introuvable");
  assert.match(
    bloc[0],
    /where\.push\([^)]*masque[^)]*\)|if \(masque\) where\.push\(masque\)/,
    "le masque doit être POUSSÉ dans `where` comme les autres clauses (donc ANDé)",
  );
  assert.match(
    bloc[0],
    /filters\.jurisdiction[\s\S]*where\.push\("l\.jurisdiction = \?"\)/,
    "le filtre de juridiction doit être une clause SUPPLÉMENTAIRE, jamais un remplacement",
  );
  // L'ordre compte pour la lecture, pas pour le SQL : les deux sont ANDés, donc
  // `jurisdiction='ca'` + masque 'qc' se contredisent et rendent 0 ligne. C'est le
  // comportement voulu — refuser vaut mieux que servir.
  assert.ok(
    bloc[0].indexOf("if (masque)") < bloc[0].indexOf("filters.jurisdiction"),
    "le masque est posé AVANT le filtre : un lecteur doit voir qu'il n'est pas conditionnel",
  );
});

test("la page publique reçoit `env` — ses décomptes sont des faits vivants (R10)", () => {
  const index = readFileSync("src/index.ts", "utf8");
  assert.match(
    index,
    /renderSite\(env\.DB,\s*env\)/,
    "renderSite doit recevoir `env` : sans lui, la page annonçait 79 lois ET 49 277 articles, " +
      "dont 22 d'un texte qu'elle ne liste pas — et sous-déclarerait 79 sur 97 au premier flip",
  );
});

test("l'interrupteur est FERMÉ par défaut, et sur une valeur exacte", () => {
  const lib = readFileSync("src/lib.ts", "utf8");
  // Un déploiement qui oublie la variable ne doit rien servir de neuf, au lieu de tout servir
  // d'un coup. Et la comparaison est une ÉGALITÉ à "1" : un test de véracité ferait de
  // FEDERAL_CORPUS="0" un interrupteur OUVERT, la chaîne "0" étant vraie en JS.
  assert.match(
    lib,
    /return env\.FEDERAL_CORPUS === "1";/,
    'federalOuvert doit être une égalité stricte à "1" (donc fermé par défaut)',
  );
});
