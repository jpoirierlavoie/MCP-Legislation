// Garde de l'INTERRUPTEUR DU SILO CRIMINEL FÉDÉRAL (`CRIMINAL_CORPUS`, R8) — hors réseau, en CI.
//
// Miroir de `tests/pdf-switch.test.mjs` pour la Vague 3 (`jurisdiction = 'ca'` ET `domain = 'penal'`) :
// `MASQUE_CRIMINAL` refuse qu'un prédicat partiel (`jurisdiction = 'qc'` ou `source <> 'pdf'` seul)
// blanchisse une lecture SQL vis-à-vis de `CRIMINAL_CORPUS`, et vérifie que `clauseCorpus`,
// `masqueLawId`, `masqueAutreBout`, `loadRelevanceData`, `listLaws` et `filtreVecteurs`
// composent bien le verrou `CRIMINAL_CORPUS === "1"`.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

const FICHIERS = ["src/lib.ts", "src/site.ts", "src/backfill.ts", "src/tools.ts"];

const TABLES =
  /\b(?:FROM|JOIN)\s+(laws|articles|articles_fts|divisions|subject_map|law_relations|article_numbers)\b/;

/** Marqueurs d'un masque couvrant `CRIMINAL_CORPUS`. */
const MASQUE_CRIMINAL =
  /masqueLawId|masqueAutreBout|clauseCorpus|domain\s*(?:<>|!=)\s*'penal'|domain\s*=\s*'penal'/;

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
  for (const m of src.matchAll(DECL_FN))
    if (m.index > pos) {
      fin = m.index;
      break;
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

function masqueIndirect(src, pos, texte) {
  const lignes = portee(src, pos).split("\n");
  const nourritDirect = (id) => declRhses(lignes, id).some((rhs) => MASQUE_CRIMINAL.test(rhs));
  const nourrit = (id) => {
    if (nourritDirect(id)) return true;
    const rePush = new RegExp(`\\b${id}\\.push\\((.+)\\)`);
    for (const l of lignes) {
      const m = l.match(rePush);
      if (!m) continue;
      const arg = m[1].trim();
      if (MASQUE_CRIMINAL.test(arg)) return true;
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

const TOLERES = new Map(
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
      "hors surface servie : route ADMIN `/admin/backfill-vectors` ; l'indexation précède l'ouverture de `CRIMINAL_CORPUS`.",

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

test("toute lecture SQL du corpus est masquée pour CRIMINAL_CORPUS ou tolérée avec parité 19", () => {
  const nues = [];
  const vues = new Set();

  for (const f of FICHIERS) {
    const src = readFileSync(f, "utf8");
    for (const r of requetes(src)) {
      if (!TABLES.test(r.texte)) continue;
      if (MASQUE_CRIMINAL.test(r.texte) || masqueIndirect(src, r.pos, r.texte)) continue;
      const fn = fonctionDe(src, r.pos).nom;
      const emp = empreinte(f, fn, r.texte);
      vues.add(emp);
      if (!TOLERES.has(emp)) nues.push(`${f}:${r.ligne}\n      "${emp}":`);
    }
  }

  assert.deepEqual(
    nues,
    [],
    "Lecture(s) du corpus NI masquée(s) pour CRIMINAL_CORPUS NI tolérée(s) :\n\n" +
      nues.map((s) => `    · ${s}`).join("\n\n"),
  );

  const perimees = [...TOLERES.keys()].filter((k) => !vues.has(k));
  assert.deepEqual(
    perimees,
    [],
    "Tolérance(s) de TOLERES qui ne correspondent plus à aucune lecture :\n" +
      perimees.map((s) => `    · ${s}`).join("\n"),
  );
  assert.equal(TOLERES.size, 19);
});

test("criminalOuvert est fermé par défaut et exige exactement '1'", () => {
  const lib = readFileSync("src/lib.ts", "utf8");
  assert.match(
    lib,
    /export function criminalOuvert\([\s\S]*?return env\.CRIMINAL_CORPUS === "1";/,
    'criminalOuvert doit être une égalité stricte à "1"',
  );
});

test("les aides SQL composent CRIMINAL_CORPUS dans clauseCorpus, masqueLawId, masqueAutreBout, loadRelevanceData, listLaws et filtreVecteurs", () => {
  const lib = readFileSync("src/lib.ts", "utf8");

  const clauseFn = lib.match(/export function clauseCorpus\([\s\S]*?\n\}/);
  assert.ok(clauseFn, "clauseCorpus introuvable");
  assert.match(
    clauseFn[0],
    /!criminalOuvert\(env\)[\s\S]*jurisdiction = 'ca' AND \$\{p\}domain = 'penal'/,
  );

  const mLawFn = lib.match(/export function masqueLawId\([\s\S]*?\n\}/);
  assert.ok(mLawFn, "masqueLawId introuvable");
  assert.match(mLawFn[0], /clauseCorpus\(env,\s*""\)/);

  const mAutreFn = lib.match(/export function masqueAutreBout\([\s\S]*?\n\}/);
  assert.ok(mAutreFn, "masqueAutreBout introuvable");
  assert.match(mAutreFn[0], /!criminalOuvert\(env\)/);
  assert.match(mAutreFn[0], /\(jurisdiction = 'ca' AND domain = 'penal'\)/);

  const relFn = lib.match(/export async function loadRelevanceData\([\s\S]*?\n\}/);
  assert.ok(relFn, "loadRelevanceData introuvable");
  assert.match(relFn[0], /masqueAutreBout\(env,\s*"to_law_id"\)/);

  const listFn = lib.match(/export async function listLaws\([\s\S]*?const clause = /);
  assert.ok(listFn, "corps de listLaws introuvable");
  assert.match(listFn[0], /const masque = clauseCorpus\(env\);/);
  assert.ok(
    listFn[0].indexOf("if (masque)") < listFn[0].indexOf("filters.jurisdiction"),
    "le masque clauseCorpus doit précéder filters.jurisdiction dans listLaws",
  );

  const vecFn = lib.match(/async function filtreVecteurs\([\s\S]*?\n\}/);
  assert.ok(vecFn, "filtreVecteurs introuvable");
  assert.match(vecFn[0], /clauseCorpus\(env,\s*""\)/);
});
