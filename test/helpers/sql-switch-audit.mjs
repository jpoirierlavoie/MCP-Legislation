import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const FICHIERS = ["src/lib.ts", "src/site.ts", "src/backfill.ts", "src/tools.ts"];

const TABLES =
  /\b(?:FROM|JOIN)\s+(laws|articles|articles_fts|divisions|subject_map|law_relations|article_numbers)\b/;

const DECL_FN = /(?:^|\n)(?:export\s+)?(?:async\s+)?function\s+(\w+)/g;

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

function portee(src, pos) {
  const { debut } = fonctionDe(src, pos);
  let fin = src.length;
  for (const m of src.matchAll(DECL_FN)) {
    if (m.index > pos) {
      fin = m.index;
      break;
    }
  }
  return src.slice(debut, fin);
}

const JS_KW = new Set([
  "const",
  "let",
  "var",
  "if",
  "else",
  "return",
  "await",
  "async",
  "function",
  "true",
  "false",
  "null",
  "undefined",
  "new",
  "typeof",
  "in",
  "of",
  "for",
  "while",
]);

function declRhses(lignes, id) {
  const re = new RegExp(`^\\s*(?:(?:const|let|var)\\s+)?${id}(?:\\s*:[^=]+)?\\s*=(?![=>])(.+)$`);
  const out = [];
  for (const l of lignes) {
    const m = l.match(re);
    if (m) out.push(m[1]);
  }
  return out;
}

function masqueIndirect(src, pos, texte, masqueRegex) {
  const lignes = portee(src, pos).split("\n");
  const nourritDirect = (id) => declRhses(lignes, id).some((rhs) => masqueRegex.test(rhs));
  const nourrit = (id) => {
    if (nourritDirect(id)) return true;
    const rePush = new RegExp(`\\b${id}\\.push\\((.+)\\)`);
    for (const l of lignes) {
      const m = l.match(rePush);
      if (!m) continue;
      const arg = m[1].trim();
      if (masqueRegex.test(arg)) return true;
      for (const m2 of arg.matchAll(/\b([A-Za-z_]\w*)\b/g)) {
        if (!JS_KW.has(m2[1]) && nourritDirect(m2[1])) return true;
      }
    }
    return false;
  };
  for (const m of texte.matchAll(/\$\{(\w+)\}/g)) {
    const id = m[1];
    if (nourrit(id)) return true;
    for (const rhs of declRhses(lignes, id)) {
      for (const m2 of rhs.matchAll(/\b([A-Za-z_]\w*)\b/g)) {
        if (m2[1] !== id && !JS_KW.has(m2[1]) && nourrit(m2[1])) return true;
      }
    }
  }
  return false;
}

function empreinte(fichier, fn, texte) {
  const sql = texte
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, "")
    .replace(/[`"']/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s,]+$/, "")
    .slice(0, 70);
  return `${fichier} :: ${fn} :: ${sql}`;
}

export const TOLERES_COMMUNS = new Map(
  Object.entries({
    "src/lib.ts :: listLaws :: SELECT law_id, lang, COUNT(*) AS n FROM articles GROUP BY law_id, lang":
      "jointe en mémoire : `listLaws` ne lit ces décomptes qu'à travers `counts.filter((c) => " +
      "c.law_id === law.id)`, sur la liste de lois DÉJÀ masquée par `clauseCorpus`. Aucune somme globale.",

    "src/lib.ts :: listLaws :: SELECT sm.law_id, sm.division_path, s.label_fr, s.label_en, d.heading ":
      "jointe en mémoire : idem, lu par `maps.filter((m) => m.law_id === law.id)` sur la liste " +
      "masquée par `clauseCorpus`, et aucun décompte global n'en sort.",

    "src/lib.ts :: translatePaths :: SELECT afr.division_path AS fr_path, MIN(aen.division_path) AS other_p":
      "gardée en amont : pont des numéros d'articles borné à `lawId` déjà filtré par `listLaws` ou `getLaw`.",

    "src/lib.ts :: translatePaths :: SELECT path, heading FROM divisions WHERE law_id = ? AND lang = ? AND ":
      "gardée en amont : intitulés des chemins traduits, bornés au `lawId` déjà résolu.",

    "src/lib.ts :: translateDivisionPath :: SELECT path, heading FROM divisions WHERE law_id = ? AND lang = ? AND ":
      "gardée en amont : bornée au `lawId` déjà résolu par `getLaw`.",

    "src/lib.ts :: translateDivisionPath :: SELECT a2.division_path AS p FROM articles a1 JOIN articles a2 ON a2.l":
      "gardée en amont : pont des numéros d'articles, borné au `lawId` déjà résolu.",

    "src/lib.ts :: lawOutlines :: SELECT id, law_id, path, kind, number, heading FROM divisions WHERE la":
      "gardée en amont : `lawOutlines` filtre sur `laws` déjà masquée et `OUTLINE_LAWS` (`ccq`, `cpc`).",

    "src/lib.ts :: lawOutlines :: SELECT parent_id, path, kind, number, heading FROM divisions WHERE par":
      "dérivée d'un jeu masqué : enfants des divisions du tour `OUTLINE_LAWS` ci-dessus.",

    "src/lib.ts :: getArticle :: SELECT , d.kind AS d_kind, d.number AS d_number, d.heading AS d_headin":
      "gardée en amont : chacun des appelants de `getArticle` passe d'abord par `getLaw(db, law, env)`.",

    "src/lib.ts :: nearestArticles :: SELECT number, sort_key FROM articles WHERE law_id = ? AND lang = ? OR":
      "gardée en amont : chacun des appelants de `nearestArticles` passe d'abord par `getLaw(db, law, env)`.",

    "src/lib.ts :: boundRef :: SELECT sort_key, id FROM articles WHERE law_id=? AND lang=? AND number":
      "gardée en amont : chacun des appelants de `boundRef` passe d'abord par `getLaw(db, law, env)`.",

    "src/lib.ts :: boundRef :: SELECT number, sort_key FROM articles WHERE law_id=? AND lang=? AND so":
      "gardée en amont : repli sur première/dernière disposition de `boundRef`, après `getLaw(db, law, env)`.",

    "src/lib.ts :: articlesByRange :: SELECT COUNT(*) AS n FROM articles WHERE":
      "gardée en amont : décompte de `articlesByRange`, appelé uniquement après `getLaw(db, law, env)`.",

    "src/lib.ts :: articlesByRange :: SELECT FROM articles WHERE ORDER BY id LIMIT ? OFFSET ?":
      "gardée en amont : lecture de `articlesByRange` par identifiants de borne après `getLaw(db, law, env)`.",

    "src/lib.ts :: articlesByRange :: SELECT COUNT(*) AS n FROM articles WHERE law_id=? AND lang=? AND sort_":
      "gardée en amont : décompte par `sort_key` de `articlesByRange` après `getLaw(db, law, env)`.",

    "src/lib.ts :: articlesByRange :: SELECT FROM articles WHERE law_id=? AND lang=? AND sort_key BETWEEN ? ":
      "gardée en amont : lecture par `sort_key` de `articlesByRange` après `getLaw(db, law, env)`.",

    "src/lib.ts :: articlesByNumbers :: SELECT , sort_key FROM articles WHERE law_id=? AND lang=? AND number I":
      "gardée en amont : chacun des appelants de `articlesByNumbers` passe d'abord par `getLaw(db, law, env)`.",

    "src/lib.ts :: getDivision :: SELECT * FROM divisions WHERE id=? AND law_id=? AND lang=?":
      "gardée en amont : chacun des appelants de `getDivision` passe d'abord par `getLaw(db, law, env)`.",

    "src/lib.ts :: getDivision :: SELECT * FROM divisions WHERE law_id=? AND lang=? AND path=?":
      "gardée en amont : résolution par chemin de `getDivision` après `getLaw(db, law, env)`.",

    "src/lib.ts :: childDivisions :: SELECT * FROM divisions WHERE parent_id=? ORDER BY sort_order":
      "dérivée d'un jeu masqué : `childDivisions` reçoit `div.id` de `getDivision` après `getLaw(db, law, env)`.",

    "src/lib.ts :: articlesInDivision :: SELECT COUNT(*) AS n FROM articles WHERE law_id=? AND lang=? AND":
      "gardée en amont : décompte de `articlesInDivision` appelé uniquement après `getLaw(db, law, env)`.",

    "src/lib.ts :: articlesInDivision :: SELECT FROM articles WHERE law_id=? AND lang=? AND ORDER BY sort_key, ":
      "gardée en amont : lecture de `articlesInDivision` appelé uniquement après `getLaw(db, law, env)`.",

    "src/lib.ts :: getStructure :: SELECT FROM divisions WHERE law_id=? AND lang=? AND ORDER BY sort_orde":
      "gardée en amont : sous-arbre de `getStructure` appelé uniquement après `getLaw(db, law, env)`.",

    "src/lib.ts :: getStructure :: SELECT FROM divisions WHERE law_id=? AND lang=? ORDER BY sort_order":
      "gardée en amont : arbre complet de `getStructure` appelé uniquement après `getLaw(db, law, env)`.",

    "src/lib.ts :: loadRelevanceData :: SELECT law_id, path, heading FROM divisions WHERE lang = fr AND path I":
      "dérivée d'un jeu masqué : intitulés des chemins retenus depuis `subject_map` déjà masqué par `masqueLawId`.",

    "src/lib.ts :: breadcrumbChains :: SELECT path, kind, number, heading FROM divisions WHERE law_id = ? AND":
      "dérivée d'un jeu masqué : fil d'Ariane des candidats déjà retenus par le repérage ou la recherche.",

    "src/lib.ts :: lawNames :: SELECT id, name_fr, name_en FROM laws WHERE id IN ()":
      "dérivée d'un jeu masqué : noms des lois candidates déjà filtrées par `runMatch`, `filtreVecteurs` ou `loadRelevanceData`.",

    "src/lib.ts :: articleBriefs :: SELECT law_id, number, division_path, substr(text, 1, 240) AS t, lengt":
      "dérivée d'un jeu masqué : `articleBriefs` matérialise des couples déjà filtrés par `filtreVecteurs`.",

    "src/backfill.ts :: handleBackfillInner :: SELECT id FROM laws WHERE id = ?":
      "hors surface servie : sonde de présence de la route ADMIN `/admin/backfill-vectors` derrière `BACKFILL_TOKEN`.",

    "src/backfill.ts :: handleBackfillInner :: SELECT id, name_fr, domain, jurisdiction FROM laws WHERE id = ?":
      "hors surface servie : route ADMIN `/admin/backfill-vectors` derrière `BACKFILL_TOKEN` (jamais un outil MCP).",

    "src/backfill.ts :: chargerPageBackfill :: SELECT number, division_path, text, marginal_note FROM articles WHERE ":
      "hors surface servie : indexation paginée des articles de la route ADMIN `/admin/backfill-vectors`.",

    "src/backfill.ts :: chargerPageBackfill :: SELECT path, heading FROM divisions WHERE law_id = ? AND lang = fr ORD":
      "hors surface servie : indexation paginée des divisions FR de la route ADMIN `/admin/backfill-vectors`.",

    "src/backfill.ts :: pruneVectors :: SELECT number FROM articles WHERE law_id = ? AND lang = fr":
      "hors surface servie : purge des vecteurs orphelins de la route ADMIN `/admin/backfill-vectors`.",

    "src/backfill.ts :: pruneVectors :: SELECT path FROM divisions WHERE law_id = ? AND lang = fr":
      "hors surface servie : purge des vecteurs orphelins de divisions de la route ADMIN `/admin/backfill-vectors`.",
  }),
);

export function auditSqlSwitches({
  masqueRegex,
  label,
  tolerances = TOLERES_COMMUNS,
  expectedCount = 34,
}) {
  const nues = [];
  const vues = new Set();

  for (const f of FICHIERS) {
    const src = readFileSync(f, "utf8");
    for (const r of requetes(src)) {
      if (!TABLES.test(r.texte)) continue;
      if (masqueRegex.test(r.texte) || masqueIndirect(src, r.pos, r.texte, masqueRegex)) continue;
      const fn = fonctionDe(src, r.pos).nom;
      const emp = empreinte(f, fn, r.texte);
      vues.add(emp);
      if (!tolerances.has(emp)) nues.push(`${f}:${r.ligne}\n      "${emp}":`);
    }
  }

  assert.deepEqual(
    nues,
    [],
    `Lecture(s) du corpus NI masquée(s) pour ${label} NI tolérée(s) :\n\n` +
      nues.map((s) => `    · ${s}`).join("\n\n"),
  );

  const perimees = [...tolerances.keys()].filter((k) => !vues.has(k));
  assert.deepEqual(
    perimees,
    [],
    "Tolérance(s) de TOLERES qui ne correspondent plus à aucune lecture :\n" +
      perimees.map((s) => `    · ${s}`).join("\n"),
  );

  if (expectedCount !== undefined) {
    assert.equal(tolerances.size, expectedCount);
  }
}
