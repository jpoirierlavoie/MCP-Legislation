// Garde anti-dérive de la documentation (R10). node --test, SANS réseau, SANS D1, SANS
// serveur : une incohérence de documentation doit faire rougir une PR, pas exiger une
// infrastructure. Même précédent que scripts/check-consolidation.test.mjs, et tourne en CI.
//
// Ce que ce garde attrape : un outil ajouté, retiré ou renommé sans que la page suive ;
// une prose orpheline ; un titre qui diverge ; une prose unilingue ; une valeur de
// calibration RECOPIÉE dans la prose au lieu d'être importée ; un compteur périmé dans
// le README.
//
// Ce qu'il n'attrape PAS, et qu'aucun mécanisme n'attrapera : une description reformulée
// dont la prose de page devient fausse sans qu'aucune clé ne bouge. Seule la relecture
// humaine l'attrape — d'où la règle R10 dans CLAUDE.md.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const lire = (p) => readFileSync(join(ROOT, p), "utf-8");
const json = (p) => JSON.parse(lire(p));

const catalogue = json("catalogue.json");
const laws = json("laws.config.json").laws;
// Ce que le serveur SERT réellement — distinct de ce qu'il ingère. Voir l'en-tête du
// fichier et le test des décomptes du README.
const served = json("pipeline/expected/served.json");
const taxonomy = json("taxonomy.json");
const toolsTs = lire("src/tools.ts");
const relevanceTs = lire("src/relevance.ts");
const readme = lire("README.md");
const authTs = lire("src/auth.ts");
const siteTs = lire("src/site.ts");

/**
 * Un jeton écrit dans de la documentation DOIT être un MARQUEUR, jamais une valeur.
 * Couvre `<jeton>`, `VOTRE_JETON`, `$MCP_TOKEN`, `${MCP_TOKEN}`, `…`.
 */
const MARQUEUR = /^(<[^>]+>|\$?\{?[A-Z][A-Z0-9_]{3,}\}?|…|\.\.\.)$/;

/** Noms de secrets légitimes hors du contrôle d'accès MCP, cités ailleurs dans le dépôt. */
const AUTRES_SECRETS = ["BACKFILL_TOKEN", "CLOUDFLARE_API_TOKEN", "GH_TOKEN"];

/**
 * Formes d'accès réellement servies, LUES dans src/auth.ts — rien n'est recopié ici :
 * c'est le code qui décide, le test qui constate (même convention que les constantes de
 * calibration, R10).
 */
function porteDAcces() {
  const mount = (authTs.match(/const MOUNT = '([^']+)'|const MOUNT = "([^"]+)"/) ?? [])
    .slice(1)
    .find(Boolean);
  const queryKey = (authTs.match(/const QUERY_KEY = '([^']+)'|const QUERY_KEY = "([^"]+)"/) ?? [])
    .slice(1)
    .find(Boolean);
  const secrets = [...authTs.matchAll(/e\.(MCP_TOKEN[A-Z0-9_]*)/g)].map((m) => m[1]);
  assert.ok(
    mount && queryKey && secrets.length >= 2,
    `MOUNT / QUERY_KEY / la liste de secrets sont introuvables dans src/auth.ts. Ce test les LIT pour ne pas les recopier (R10) : si leur forme a changé, mettre à jour l'extraction ci-dessus — ne pas la contourner, elle est la SEULE source de ce contrôle.`,
  );
  return { mount, queryKey, secrets: new Set(secrets) };
}

/** Retire la ponctuation de fin de phrase et le chevron d'autolien Markdown. */
const urlPropre = (b) => (b.includes("<") ? b : b.replace(/>$/, "")).replace(/[.,;:]$/, "");

const RAPPEL =
  "Toute modification d'outil ou d'aide au repérage se fait à TROIS endroits : " +
  "src/tools.ts, catalogue.json (donc la page publique) et README.md. Voir R10 dans CLAUDE.md.";

/** Noms réellement enregistrés auprès du serveur MCP. */
const enregistres = [...toolsTs.matchAll(/registerTool\(\s*"(legislation_[a-z_]+)"/g)].map(
  (m) => m[1],
);

test("parité : outils enregistrés <-> catalogue (dans les DEUX sens)", () => {
  // Garde-fou de regex morte : R2 interdit d'ajouter un outil sans approbation, donc
  // l'ensemble ne rétrécit pas tout seul. Si la regex casse, elle rend [] et on tombe ici.
  assert.ok(
    enregistres.length >= 10,
    `seulement ${enregistres.length} outils extraits de src/tools.ts — la regex a-t-elle cassé ?`,
  );

  const docs = Object.keys(catalogue.tools);
  const manquants = enregistres.filter((n) => !docs.includes(n));
  const orphelins = docs.filter((n) => !enregistres.includes(n));
  assert.deepEqual(
    manquants,
    [],
    `outils SANS documentation de page : ${manquants.join(", ")}. ${RAPPEL}`,
  );
  assert.deepEqual(
    orphelins,
    [],
    `documentation SANS outil correspondant : ${orphelins.join(", ")}. ${RAPPEL}`,
  );
});

test("chaque outil du catalogue est complet et bilingue", () => {
  for (const [nom, t] of Object.entries(catalogue.tools)) {
    for (const champ of ["title_fr", "title_en", "groupe"]) {
      assert.ok(t[champ] && typeof t[champ] === "string", `${nom} : ${champ} manquant. ${RAPPEL}`);
    }
    assert.ok(
      ["orientation", "extraction"].includes(t.groupe),
      `${nom} : groupe inattendu « ${t.groupe} » (orientation | extraction).`,
    );
    for (const champ of ["page_fr", "page_en"]) {
      assert.ok(
        Array.isArray(t[champ]) && t[champ].length >= 2,
        `${nom} : ${champ} doit compter AU MOINS DEUX paragraphes — la consigne est ` +
          `« décrit en plusieurs phrases, pas une ligne ». ${RAPPEL}`,
      );
    }
    // Bilinguisme RÉEL : ni copie du français, ni traduction-croupion.
    const fr = t.page_fr.join(" "),
      en = t.page_en.join(" ");
    assert.notEqual(fr, en, `${nom} : page_en est identique au français (copier-coller ?).`);
    const ratio = en.length / fr.length;
    assert.ok(
      ratio > 0.5 && ratio < 2,
      `${nom} : page_en fait ${Math.round(ratio * 100)} % de la longueur du français — traduction incomplète ?`,
    );
  }
});

test("les titres servis par MCP sont ceux du catalogue (source unique)", () => {
  // src/tools.ts doit appeler titre("legislation_x") — jamais un littéral. Un littéral rétablirait
  // la copie que le catalogue existe précisément pour supprimer.
  const litteraux = [...toolsTs.matchAll(/title:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    litteraux,
    [],
    `titres écrits en dur dans src/tools.ts : ${litteraux.join(" | ")} — utiliser titre("legislation_…"). ${RAPPEL}`,
  );
  for (const nom of enregistres) {
    assert.ok(
      toolsTs.includes(`titre("${nom}")`),
      `${nom} : le titre n'est pas tiré du catalogue. ${RAPPEL}`,
    );
  }
});

test("les constantes de calibration citées existent et ne sont PAS recopiées", () => {
  const cites = Object.values(catalogue.retrieval)
    .filter((s) => s && Array.isArray(s.constantes))
    .flatMap((s) => s.constantes);
  assert.ok(
    cites.length > 0,
    "aucune constante citée — la section des aides au repérage a-t-elle été vidée ?",
  );

  for (const c of cites) {
    assert.ok(
      new RegExp(`(export const ${c}\\b|^\\s*${c}:)`, "m").test(relevanceTs),
      `${c} est citée dans catalogue.json mais introuvable dans src/relevance.ts — ` +
        "la page décrirait une calibration qui n'existe plus.",
    );
  }

  // R10 : la prose dit ce que la constante FAIT ; elle n'écrit jamais sa VALEUR — la page
  // l'importe de src/relevance.ts. Un nombre recopié ici deviendrait faux en silence.
  const prose = JSON.stringify(catalogue.retrieval);
  for (const interdit of ["0,40", "0.40", "k = 60", "k=60"]) {
    assert.ok(
      !prose.includes(interdit),
      `la prose contient la valeur « ${interdit} » : importer la constante depuis ` +
        "src/relevance.ts et la rendre, ne pas l'écrire à la main (R10).",
    );
  }
});

test("l'avertissement est complet et bilingue", () => {
  // `catalogue.avertissement` n'était vérifié NULLE PART, alors que c'est la seule clause
  // de non-conseil juridique du dépôt et que R4 en exige la visibilité. Depuis qu'il est
  // rendu en sous-section des aides au repérage, il n'a plus d'entrée au sommaire : rien
  // ne signalerait qu'on l'a vidé. Sur un outil juridique c'est le pire cas.
  const a = catalogue.avertissement;
  assert.ok(a, "catalogue.avertissement a disparu");
  for (const cle of ["titre_fr", "titre_en"]) {
    assert.ok(typeof a[cle] === "string" && a[cle].trim(), `avertissement.${cle} vide`);
  }
  for (const cle of ["corps_fr", "corps_en"]) {
    assert.ok(Array.isArray(a[cle]) && a[cle].length > 0, `avertissement.${cle} vide`);
    assert.ok(
      a[cle].every((p) => typeof p === "string" && p.trim().length > 20),
      `avertissement.${cle} contient un paragraphe vide ou tronqué`,
    );
  }
  assert.equal(
    a.corps_fr.length,
    a.corps_en.length,
    "les deux langues n'énoncent pas le même nombre de réserves",
  );

  // La substance, pas seulement la forme : une reformulation qui perdrait l'une de ces
  // trois réserves passerait tous les contrôles structurels ci-dessus.
  const fr = a.corps_fr.join(" ").toLowerCase();
  const en = a.corps_en.join(" ").toLowerCase();
  assert.ok(
    fr.includes("heuristique") && en.includes("heuristic"),
    "réserve sur le repérage perdue",
  );
  assert.ok(
    fr.includes("fait foi") && en.includes("authoritative"),
    "réserve sur le texte officiel perdue",
  );
  assert.ok(
    fr.includes("aucun conseil juridique") && en.includes("no legal advice"),
    "la clause de non-conseil juridique a disparu de l'avertissement",
  );
});

test("le catalogue ne contient aucune chaîne en forme de jeton", () => {
  // Paranoïa à coût nul : la page publique ne doit jamais transporter de secret.
  const brut = lire("catalogue.json");
  assert.ok(
    !/[0-9a-f]{32,}/i.test(brut),
    "chaîne hexadécimale de 32+ caractères dans catalogue.json.",
  );
  assert.ok(
    !/\bBearer\b|[?&]key=/.test(brut),
    "forme d'authentification écrite dans catalogue.json.",
  );
});

test("README : les décomptes dérivables des JSON versionnés sont exacts", () => {
  // Faits VIVANTS mais dérivables hors D1 : on les épingle. Reformuler la phrase oblige à
  // toucher ce test — friction assumée, même convention qu'ORDRE_ATTENDU côté pipeline.
  // ⚠️ LE DÉCOMPTE DE LOIS SE LIT DANS `served.json`, PAS DANS `laws.config.json`.
  //
  // Les deux ont longtemps été le même nombre. Ils divergent depuis l'arrivée du corpus
  // fédéral : `laws.config.json` décrit ce que le pipeline INGÈRE, `served.json` ce qu'un
  // usager peut RÉELLEMENT obtenir — les textes `ca-*` sont chargés en base mais invisibles
  // à tous les outils tant que l'interrupteur `FEDERAL_CORPUS` est fermé (R8).
  //
  // Épingler le README sur `laws.config.json` le forcerait à annoncer 97 textes dès l'ajout
  // des entrées de config, alors que la production en servirait 79 : la dérive R10 exacte,
  // et produite par un test épinglé. Le README parle à un LECTEUR, donc il dit ce qui est
  // servi.
  const attendus = [
    [/\*\*(\d+) lois et règlements\*\*/, served.ids.length, "nombre de lois SERVIES"],
    [
      /les (\d+) tarifs/,
      laws.filter((l) => l.fonction === "tarif" && served.ids.includes(l.id)).length,
      "nombre de tarifs",
    ],
    [/Les (\d+) matières/, taxonomy.subjects.length, "nombre de matières"],
  ];
  for (const [re, valeur, quoi] of attendus) {
    const m = readme.match(re);
    assert.ok(
      m,
      `${quoi} : la phrase attendue est introuvable dans README.md (reformulée ? ` +
        `mettre à jour tests/catalogue.test.mjs). Motif : ${re}`,
    );
    assert.equal(
      Number(m[1]),
      valeur,
      `${quoi} : le README dit ${m[1]}, les données versionnées disent ${valeur}. ${RAPPEL}`,
    );
  }
});

test("served.json est un SOUS-ENSEMBLE cohérent de laws.config.json", () => {
  // La distinction « ingéré » / « servi » n'a de valeur que si elle reste vérifiable. Deux
  // dérives possibles, toutes deux silencieuses sans ce contrôle : déclarer servi un texte
  // qui n'existe pas au corpus, ou laisser `served.json` prendre du retard sur un flip
  // d'interrupteur déjà fait.
  const idsConfig = new Set(laws.map((l) => l.id));
  const fantomes = served.ids.filter((id) => !idsConfig.has(id));
  assert.deepEqual(
    fantomes,
    [],
    "served.json déclare servis des textes absents de laws.config.json",
  );
  assert.equal(new Set(served.ids).size, served.ids.length, "doublon dans served.ids");
  assert.equal(
    served.flag,
    "FEDERAL_CORPUS",
    "l'interrupteur nommé par served.json doit être celui de wrangler.jsonc",
  );

  // Si TOUT le corpus est déclaré servi, l'interrupteur doit être ouvert — sinon le README
  // annonce plus que ce que la production rend.
  const federaux = laws.filter((l) => l.jurisdiction === "ca").map((l) => l.id);
  const federauxServis = federaux.filter((id) => served.ids.includes(id));
  if (federauxServis.length) {
    assert.equal(
      federauxServis.length,
      federaux.length,
      "servir une PARTIE du fédéral n'est pas un état prévu : l'interrupteur est global",
    );
  }
});

test("l'obligation des cinq surfaces est toujours inscrite (CLAUDE.md + README)", () => {
  // Une règle qui gouverne CHAQUE modification doit être elle-même protégée : sans ce
  // contrôle, elle pourrait disparaître d'un commit de nettoyage sans que rien ne bronche.
  const claude = lire("CLAUDE.md");
  assert.ok(
    /OBLIGATION PRÉALABLE À TOUTE MODIFICATION/.test(claude),
    "l'obligation préalable a disparu de CLAUDE.md — c'est la règle qui gouverne toute " +
      "modification du dépôt, elle ne se retire pas sans décision explicite de Jason.",
  );
  for (const surface of ["Outils MCP", "Descriptions", "Schéma", "README.md", "Page publique"]) {
    assert.ok(
      claude.includes(surface),
      `la surface « ${surface} » a disparu du tableau des cinq surfaces (CLAUDE.md).`,
    );
  }
  assert.ok(
    /tokens n['’]est JAMAIS une raison|tokens n['’]exempte de rien/.test(claude),
    "la mention « le coût en tokens n'exempte de rien » a disparu — c'est une consigne " +
      "explicite de Jason, elle est le cœur de la règle.",
  );
  assert.ok(
    /CINQ surfaces/.test(readme),
    "README.md ne rappelle plus l'obligation des cinq surfaces (section « Pour les développeurs »).",
  );
});

test("README : aucun décompte qui ne vit qu'en D1", () => {
  // Les comptes d'articles ne sont pas dérivables du dépôt : le README n'a pas le droit de
  // les énoncer (c'est ainsi qu'il a annoncé « ~46 000 articles » alors qu'il y en a 49 255).
  // Ils vivent sur la page publique, qui les calcule.
  const fautifs = [...readme.matchAll(/([~\d][\d\s {2}]{2,})\s*articles?\b/gi)].map((m) =>
    m[0].trim(),
  );
  assert.deepEqual(
    fautifs,
    [],
    `décompte d'articles écrit à la main dans README.md : « ${fautifs.join(" | ")} ». ` +
      "Ces chiffres ne vivent qu'en D1 : renvoyer à la page publique, qui les calcule (R10).",
  );
});

test("doc : toute URL /mcp citée est une forme réellement servie par src/auth.ts", () => {
  // MODE DE DÉFAUT VISÉ, DÉJÀ SURVENU : « le README publiait une configuration de connexion
  // qui renvoyait 404 » (CLAUDE.md). Pour un client MCP un 404 n'est pas « pas trouvé » mais
  // « ce serveur exige une authentification » : il part en découverte OAuth, échoue à
  // l'enregistrement dynamique, et peut s'y coincer IRRÉVERSIBLEMENT (2026-07-25). Une recette
  // fausse ne casse donc pas une tentative : elle casse un connecteur. Rien de tout cela
  // n'exige le réseau — la forme servie est entièrement dérivable de src/auth.ts.
  const { mount, queryKey } = porteDAcces();

  const defaut = (u) => {
    const chemin = u.pathname.replace(/\/+$/, "") || "/"; // slash final toléré (src/auth.ts)
    if (chemin !== mount && !chemin.startsWith(`${mount}/`)) {
      return `chemin « ${chemin} » : src/index.ts ne route que « ${mount} » et « ${mount}/… »`;
    }
    if (chemin !== mount && chemin.slice(mount.length + 1).includes("/")) {
      return `chemin « ${chemin} » : src/auth.ts n'accepte QU'UN seul segment après « ${mount} »`;
    }
    for (const cle of u.searchParams.keys()) {
      if (cle !== queryKey) {
        return `paramètre « ${cle} » : le seul porteur en chaîne de requête est « ${queryKey} »`;
      }
    }
    return null;
  };

  const fautifs = [];
  for (const [ou, texte] of [
    ["README.md", readme],
    ["src/site.ts", siteTs],
  ]) {
    for (const m of texte.matchAll(/https?:\/\/legislation\.poirierlavoie\.ca[^\s`)"']*/g)) {
      const u = new URL(urlPropre(m[0]));
      if (u.pathname !== mount && !u.pathname.startsWith(`${mount}/`)) continue;
      const pb = defaut(u);
      if (pb) fautifs.push(`${ou} : ${urlPropre(m[0])} — ${pb}`);
    }
  }
  assert.deepEqual(
    fautifs,
    [],
    `URL de connexion qui ne serait PAS servie : ${fautifs.join(" | ")}. ${RAPPEL}`,
  );

  assert.ok(
    readme.includes(`?${queryKey}=`),
    `README.md ne montre plus la forme « ?${queryKey}= ». C'est la forme MESURÉE du connecteur claude.ai — le segment de chemin, lui, a ÉCHOUÉ dans son formulaire alors qu'une session complète y passe en curl. Une recette qui ne la cite pas envoie le lecteur vers une forme qui ne marche pas chez lui.`,
  );
});

test("doc : aucune valeur de jeton en clair dans le README (marqueurs seulement)", () => {
  assert.ok(
    !/[0-9a-f]{32,}/i.test(readme),
    `chaîne hexadécimale de 32+ caractères dans README.md — une valeur de jeton s'y est-elle glissée en rédigeant la recette de connexion ?`,
  );

  const suspects = [
    ...[...readme.matchAll(/\bBearer\s+(\S+)/g)].map((m) => ["Bearer ", m[1]]),
    ...[...readme.matchAll(/[?&]key=([^\s`)"'&|]+)/g)].map((m) => ["key=", m[1]]),
  ];
  const fautifs = suspects
    .filter(([, v]) => !MARQUEUR.test(v.replace(/[.,;:`|)\]]+$/, "")))
    .map(([quoi, v]) => `${quoi}${v}`);
  assert.deepEqual(
    fautifs,
    [],
    `valeur écrite à la place d'un marqueur dans README.md : ${fautifs.join(" | ")}. Écrire « <jeton> » ou une VARIABLE — jamais une valeur : c'est aussi ce qui évite de laisser le jeton dans l'historique du shell du lecteur.`,
  );
});

test("doc : les noms de secrets cités existent dans src/auth.ts", () => {
  // Un nom hors liste se pose SANS ERREUR (`wrangler secret put ATHENA_MCP_TOKEN`) et n'ouvre
  // RIEN : le client reçoit 404 et on cherche du côté du client. C'est le seul endroit du
  // dépôt où ce défaut est attrapable sans réseau.
  const { secrets } = porteDAcces();
  const texte = readme.replace(/<[^>\s]+>/g, "MARQUEUR");
  const cites = new Set([
    ...[...texte.matchAll(/wrangler secret (?:put|delete)\s+([A-Za-z0-9_]+)/g)].map((m) => m[1]),
    ...[...texte.matchAll(/\b[A-Z][A-Z0-9_]*TOKEN[A-Z0-9_]*\b/g)].map((m) => m[0]),
  ]);
  assert.ok(
    cites.size > 0,
    `aucun nom de secret cité dans README.md — la recette de connexion a-t-elle disparu ?`,
  );
  const attendus = [...secrets].join(", ");
  const fautifs = [...cites].filter((n) => !secrets.has(n) && !AUTRES_SECRETS.includes(n));
  assert.deepEqual(
    fautifs,
    [],
    `nom(s) de secret hors contrat dans README.md : ${fautifs.join(", ")} — src/auth.ts n'accepte que ${attendus}. ${RAPPEL}`,
  );
});
