import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { PUBLIES } from "../src/schemas.ts";
import { carteServeur, PACKAGE_NAME, PUBLIC_DESCRIPTION, SERVER_INFO } from "../src/serveur.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const lire = (p) => readFileSync(join(ROOT, p), "utf-8");
const json = (p) => JSON.parse(lire(p));

const catalogue = json("data/catalogue.json");
const laws = json("data/laws.config.json").laws;
const served = json("pipeline/expected/served.json");
const taxonomy = json("data/taxonomy.json");
const toolsTs = lire("src/tools.ts");
const schemasTs = lire("src/schemas.ts");
const relevanceTs = lire("src/relevance.ts");
const readme = lire("README.md");
const authTs = lire("src/auth.ts");
const siteTs = lire("src/site.ts");

const MARQUEUR = /^(<[^>]+>|\$?\{?[A-Z][A-Z0-9_]{3,}\}?|…|\.\.\.)$/;

const AUTRES_SECRETS = ["BACKFILL_TOKEN", "CLOUDFLARE_API_TOKEN", "GH_TOKEN"];

function porteDAcces() {
  const mount = (authTs.match(/const MOUNT = '([^']+)'|const MOUNT = "([^"]+)"/) ?? [])
    .slice(1)
    .find(Boolean);
  const queryKey = (authTs.match(/const QUERY_KEY = '([^']+)'|const QUERY_KEY = "([^"]+)"/) ?? [])
    .slice(1)
    .find(Boolean);
  const bloc = (authTs.match(/const NOMS_SECRETS = \[([^\]]+)\]/) ?? [])[1] ?? "";
  const secrets = [...bloc.matchAll(/"([A-Z0-9_]+)"/g)].map((m) => m[1]);
  assert.ok(
    mount && queryKey && secrets.length >= 2,
    `MOUNT / QUERY_KEY / la liste de secrets sont introuvables dans src/auth.ts. Ce test les LIT pour ne pas les recopier (R10) : si leur forme a changé, mettre à jour l'extraction ci-dessus — ne pas la contourner, elle est la SEULE source de ce contrôle.`,
  );
  return { mount, queryKey, secrets: new Set(secrets) };
}

const urlPropre = (b) => (b.includes("<") ? b : b.replace(/>$/, "")).replace(/[.,;:]$/, "");

const RAPPEL =
  "Toute modification d'outil ou d'aide au repérage se fait à TROIS endroits : " +
  "src/tools.ts, catalogue.json (donc la page publique) et README.md. Voir R10 dans CLAUDE.md.";

const enregistres = [...toolsTs.matchAll(/outils\.([a-z][a-z0-9_]*)\s*=/g)].map((m) => m[1]);

test("parité : outils enregistrés <-> schémas publiés <-> catalogue", () => {
  assert.ok(
    enregistres.length >= 10,
    `seulement ${enregistres.length} outils extraits de src/tools.ts — la regex a-t-elle cassé ?`,
  );

  const publies = Object.keys(PUBLIES);
  assert.deepEqual(
    publies.filter((n) => !enregistres.includes(n)),
    [],
    `descripteurs dans PUBLIES sans gestionnaire dans src/tools.ts`,
  );
  assert.deepEqual(
    enregistres.filter((n) => !publies.includes(n)),
    [],
    `gestionnaires dans src/tools.ts sans descripteur dans PUBLIES`,
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
  const litteraux = [...schemasTs.matchAll(/title:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    litteraux,
    [],
    `titres écrits en dur dans src/schemas.ts : ${litteraux.join(" | ")} — utiliser titre("…"). ${RAPPEL}`,
  );
  for (const nom of enregistres) {
    assert.ok(
      schemasTs.includes(`titre("${nom}")`),
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

  const prose = JSON.stringify(catalogue.retrieval);
  for (const interdit of ["0,40", "0.40", "k = 60", "k=60", "0,50", "0.50"]) {
    assert.ok(
      !prose.includes(interdit),
      `la prose contient la valeur « ${interdit} » : importer la constante depuis ` +
        "src/relevance.ts et la rendre, ne pas l'écrire à la main (R10).",
    );
  }
});

test("l'avertissement est complet et bilingue", () => {
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
  const brut = lire("data/catalogue.json");
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
  const attendus = [
    [/\*\*(\d+) lois, règlements et directives\*\*/, served.ids.length, "nombre de lois SERVIES"],
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
  const idsConfig = new Set(laws.map((l) => l.id));
  const fantomes = served.ids.filter((id) => !idsConfig.has(id));
  assert.deepEqual(
    fantomes,
    [],
    "served.json déclare servis des textes absents de laws.config.json",
  );
  assert.equal(new Set(served.ids).size, served.ids.length, "doublon dans served.ids");
  assert.ok(
    ["FEDERAL_CORPUS", "PDF_CORPUS", "CRIMINAL_CORPUS"].includes(served.flag),
    "l'interrupteur nommé par served.json doit être un drapeau de corpus reconnu de wrangler.jsonc",
  );

  const federaux = laws
    .filter((l) => l.jurisdiction === "ca" && l.domain !== "penal")
    .map((l) => l.id);
  const federauxServis = federaux.filter((id) => served.ids.includes(id));
  if (federauxServis.length) {
    assert.equal(
      federauxServis.length,
      federaux.length,
      "servir une PARTIE du fédéral hors silo criminel n'est pas un état prévu : l'interrupteur est global",
    );
  }

  const wranglerCfg = JSON.parse(
    lire("wrangler.jsonc")
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n"),
  );
  const criminels = laws
    .filter((l) => l.jurisdiction === "ca" && l.domain === "penal")
    .map((l) => l.id);
  const criminelsServis = criminels.filter((id) => served.ids.includes(id));
  const criminelAttendu = wranglerCfg.vars?.CRIMINAL_CORPUS === "1" ? criminels.length : 0;
  assert.equal(
    criminelsServis.length,
    criminelAttendu,
    "le silo criminel fédéral dans served.json doit concorder tout-ou-rien avec CRIMINAL_CORPUS dans wrangler.jsonc",
  );

  const pdfs = laws.filter((l) => l.source === "pdf").map((l) => l.id);
  const pdfsServis = pdfs.filter((id) => served.ids.includes(id));
  if (pdfsServis.length) {
    assert.equal(
      pdfsServis.length,
      pdfs.length,
      "servir une PARTIE du corpus PDF n'est pas un état prévu : l'interrupteur est global",
    );
  }
});

test("l'obligation des cinq surfaces est toujours inscrite (CLAUDE.md + README)", () => {
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
  const { mount, queryKey } = porteDAcces();

  const defaut = (u) => {
    if (u.pathname === `${mount}/server-card` && !u.search) {
      return null;
    }
    const chemin = u.pathname.replace(/\/+$/, "") || "/";
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

test("manifestes Antigravity / Gemini, version et description concordent partout", () => {
  const pkg = json("package.json");
  const plugin = json("plugin.json");
  const mcpConfigRaw = lire("mcp_config.json");
  const mcpConfig = JSON.parse(mcpConfigRaw);
  const geminiExtRaw = lire("gemini-extension.json");
  const geminiExt = JSON.parse(geminiExtRaw);
  const logoSvg = lire("assets/logo.svg");
  const geminiMd = lire("GEMINI.md");
  const card = carteServeur();

  assert.ok(pkg.version.length > 0);
  assert.equal(SERVER_INFO.version, pkg.version);
  assert.equal(plugin.version, pkg.version);
  assert.equal(geminiExt.version, pkg.version);
  assert.equal(card.version, pkg.version);

  assert.equal(pkg.name, PACKAGE_NAME);
  assert.equal(plugin.name, PACKAGE_NAME);
  assert.equal(geminiExt.name, PACKAGE_NAME);
  assert.equal(card.name, `ca.poirierlavoie.legislation/${PACKAGE_NAME}`);

  assert.equal(plugin.displayName, SERVER_INFO.name);
  assert.equal(card.title, SERVER_INFO.name);

  assert.equal(pkg.description, PUBLIC_DESCRIPTION);
  assert.equal(plugin.description, PUBLIC_DESCRIPTION);
  assert.equal(geminiExt.description, PUBLIC_DESCRIPTION);
  assert.equal(card.description, PUBLIC_DESCRIPTION);
  assert.ok(
    !/\b\d+\s*(lois|règlements|textes|matières|articles)\b/i.test(PUBLIC_DESCRIPTION),
    "PUBLIC_DESCRIPTION ne doit contenir aucun décompte vivant (R10).",
  );

  for (const brut of [mcpConfigRaw, geminiExtRaw]) {
    assert.ok(!/[0-9a-f]{32,}/i.test(brut), "chaîne hexadécimale suspecte dans un manifeste");
  }

  const agy = mcpConfig.mcpServers?.lois;
  assert.equal(agy?.url, "https://legislation.poirierlavoie.ca/mcp/oauth");
  assert.equal(agy?.headers, undefined);
  assert.equal(agy?.variables, undefined);
  assert.equal(agy?.eager, undefined);

  assert.deepEqual(geminiExt.contextFileName, []);
  const gcli = geminiExt.mcpServers?.lois;
  assert.equal(gcli?.type, "http");
  assert.equal(gcli?.url, "https://legislation.poirierlavoie.ca/mcp/oauth");
  assert.equal(gcli?.httpUrl, undefined);
  assert.equal(gcli?.headers, undefined);
  assert.deepEqual(geminiExt.settings, []);

  assert.equal(plugin.logo, "assets/logo.svg");
  assert.ok(logoSvg.includes("<svg") && logoSvg.includes('viewBox="0 0 128 128"'));
  assert.ok(
    Array.isArray(plugin.suggestedPrompts) &&
      plugin.suggestedPrompts.length === 3 &&
      plugin.suggestedPrompts.every((p) => typeof p === "string" && p.trim().length > 0),
    "plugin.json doit fournir 3 suggestedPrompts non vides",
  );

  const claudeMd = lire("CLAUDE.md");
  assert.equal(
    geminiMd,
    claudeMd,
    "GEMINI.md et CLAUDE.md doivent être identiques octet pour octet",
  );
  const octets = new TextEncoder().encode(geminiMd).byteLength;
  assert.ok(octets > 1_000 && octets < 24_000, `GEMINI.md fait ${octets} octets`);
  assert.ok(geminiMd.includes("CLAUDE.md"), "GEMINI.md doit renvoyer vers CLAUDE.md");
  assert.ok(!/[0-9a-f]{32,}/i.test(geminiMd), "chaîne hexadécimale suspecte dans GEMINI.md");

  const wranglerBrut = lire("wrangler.jsonc");
  const wranglerSansComm = wranglerBrut
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
  const wranglerCfg = JSON.parse(wranglerSansComm);
  assert.deepEqual(wranglerCfg.observability, {
    enabled: false,
    logs: { enabled: false, invocation_logs: false },
  });
  assert.ok(
    wranglerCfg.d1_databases?.some(
      (d) => d.binding === "DB_IDENTITE" && d.database_name === "mcp-identite",
    ),
    "wrangler.jsonc doit lier DB_IDENTITE (mcp-identite)",
  );
  assert.deepEqual(
    wranglerCfg.ratelimits?.map((r) => [r.name, r.namespace_id, r.simple.limit, r.simple.period]),
    [
      ["RL_PRE_AUTH_IP", "1011", 600, 60],
      ["RL_ECHEC_IP", "1012", 20, 60],
      ["RL_ECHECS_GLOBAL", "1013", 300, 60],
      ["RL_TITULAIRE", "1014", 300, 60],
      ["RL_TITULAIRE_LIMITE", "1015", 20, 60],
    ],
  );
  assert.ok(!schemasTs.includes("x-mcp-header"), "x-mcp-header interdit dans src/schemas.ts (G19)");
  for (const [nom, d] of Object.entries(PUBLIES)) {
    assert.equal(d.inputSchema.additionalProperties, false, `${nom} additionalProperties`);
    assert.deepEqual(
      d.annotations,
      {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      `${nom} annotations`,
    );
  }

  const siteSansCommentaires = siteTs
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
  assert.ok(
    !/Bearer\s|[?&]key=|[0-9a-f]{32,}/i.test(siteSansCommentaires),
    "motif d'authentification ou de jeton détecté dans src/site.ts",
  );
});
