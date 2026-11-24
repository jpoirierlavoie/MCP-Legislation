// Page publique servie à la racine (R10) et fichiers publics de découverte (/robots.txt, /sitemap.xml, /llms.txt).
//
// PRINCIPE : la page ne RECOPIE rien. Les décomptes (lois, matières, articles, dates de
// consolidation) sont lus en D1 au rendu ; les titres d'outils viennent de catalogue.json
// (la même valeur que celle servie par tools/list) ; les valeurs de calibration sont
// importées de src/relevance.ts. C'est la réponse structurelle à la dérive constatée dans
// ce dépôt : un chiffre recopié dans de la prose devient faux en silence, sans qu'aucun
// test n'échoue.
//
// Le jeton d'accès n'apparaît JAMAIS ici, sous aucune forme : la page décrit un endpoint
// privé, elle ne le déverrouille pas. Elle n'appelle pas /mcp non plus — elle ne le
// pourrait pas, src/auth.ts refusant en 404 sans porteur.
//
// PIÈGE D'ÉCRITURE (cousin de l'invariant 11) : dans un littéral de gabarit NON balisé,
// `\d` devient `d` en silence. Le JS client est donc écrit en String.raw — et ne doit
// contenir aucun `${`, puisque String.raw interpole quand même.

import catalogue from "../catalogue.json";
import config from "../laws.config.json";
import {
  type CorpusGateEnv,
  citeOf,
  type LawSummary,
  listLaws,
  listSubjects,
  masqueLawId,
  pdfOuvert,
  type SubjectSummary,
} from "./lib";
import {
  FONCTION_WEIGHTS,
  MAX_PER_FONCTION_SOUPLE,
  MAX_PER_SUBJECT,
  MAX_SUFFIX,
  RRF_K,
  SEMANTIC_MIN_SCORE,
  SPECIFIC_TOKEN_FACTOR,
  SPECIFIC_TOKEN_MAX_REACH,
  VECTOR_TOP_K,
  WEIGHTS,
} from "./relevance";
import { PUBLIC_DESCRIPTION } from "./serveur";

const CONTACT = "jason@poirierlavoie.ca";
const ORIGINE_SITE = "https://legislation.poirierlavoie.ca";
const DEPOT = "https://github.com/jpoirierlavoie/MCP-Legislation";
const DEPOT_PLUGIN = "https://github.com/jpoirierlavoie/droit-civil-quebecois";
const LEGISQUEBEC = "https://www.legisquebec.gouv.qc.ca";

const SOURCES = new Map(
  config.laws.map((l) => [
    l.id,
    (l.consolidation_source ?? (l as { official_source?: unknown }).official_source) as
      | { fr?: string; en?: string }
      | undefined,
  ]),
);

/** Échappement HTML — obligatoire sur TOUT champ venu de D1 (intitulés à apostrophes). */
function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Bloc bilingue : les deux langues sont émises, le CSS n'en montre qu'une. */
function bi(fr: string, en: string): string {
  return `<span data-l="fr">${esc(fr)}</span><span data-l="en" lang="en">${esc(en)}</span>`;
}

/** Suite de paragraphes bilingues (avec lang="en" sur le bloc anglais pour lecteurs/indexeurs). */
function biP(fr: string[], en: string[]): string {
  return (
    `<div data-l="fr">${fr.map((p) => `<p>${esc(p)}</p>`).join("")}</div>\n` +
    `<div data-l="en" lang="en">${en.map((p) => `<p>${esc(p)}</p>`).join("")}</div>`
  );
}

const FONCTION: Record<string, [string, string]> = {
  loi: ["Loi", "Statute"],
  reglement: ["Règlement", "Regulation"],
  "regles-procedure": ["Règles de procédure", "Rules of procedure"],
  tarif: ["Tarif", "Tariff"],
  directive: ["Directive de pratique", "Practice directive"],
  orientation: ["Orientation (IG)", "Policy statement"],
};

const nb = (n: number) => n.toLocaleString("fr-CA").replace(/ /g, " ");

const SECTIONS = [
  { id: "outils", fr: "Les outils", en: "The tools" },
  { id: "reperage", fr: "Les aides au repérage", en: "Retrieval aids" },
  { id: "corpus", fr: "Le corpus", en: "The corpus" },
  { id: "matieres", fr: "Les matières", en: "Subject areas" },
  { id: "acces", fr: "Accès", en: "Access" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

function h2(id: SectionId): string {
  const s = SECTIONS.find((x) => x.id === id) as (typeof SECTIONS)[number];
  return `<h2 id="h-${id}">${bi(s.fr, s.en)}</h2>`;
}

function compacterBloc(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/^\s*\/\/.*$/, "").trim())
    .filter(Boolean)
    .join("\n");
}

function construireJsonLd(nLois: number, nMat: number, nArt: number, consol: string): string {
  const nomsOutils = Object.keys(catalogue.tools);
  const graphe = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebSite",
        "@id": `${ORIGINE_SITE}/#site`,
        url: `${ORIGINE_SITE}/`,
        name: [
          "MCP Législation — Lois du Québec et du Canada",
          "MCP Legislation — Laws of Québec and Canada",
        ],
        inLanguage: ["fr-CA", "en-CA"],
        isPartOf: {
          "@type": "SoftwareApplication",
          "@id": `${DEPOT_PLUGIN}#plugin`,
          name: "Droit civil québécois",
          url: DEPOT_PLUGIN,
        },
      },
      {
        "@type": "WebAPI",
        "@id": `${ORIGINE_SITE}/#api`,
        name: "MCP Législation (lois)",
        url: `${ORIGINE_SITE}/`,
        documentation: `${ORIGINE_SITE}/mcp/server-card`,
        termsOfService: "https://acces.poirierlavoie.ca/cgu",
        license: "https://www.apache.org/licenses/LICENSE-2.0",
        isAccessibleForFree: true,
        inLanguage: ["fr-CA", "en-CA"],
        description: PUBLIC_DESCRIPTION,
        featureList: nomsOutils,
      },
      {
        "@type": "Dataset",
        "@id": `${ORIGINE_SITE}/#corpus-dataset`,
        name: [
          "Corpus législatif consolidé du Québec et du Canada, directives judiciaires et textes AMF",
          "Consolidated Québec and federal legislative corpus, court directives, and AMF texts",
        ],
        description: `${nLois} instruments, ${nMat} subject areas, ${nArt} articles/provisions across official languages (most recent consolidation: ${consol}).`,
        url: `${ORIGINE_SITE}/#corpus`,
        inLanguage: ["fr-CA", "en-CA"],
        dateModified: consol !== "—" ? consol : undefined,
        isAccessibleForFree: true,
      },
    ],
  };
  return JSON.stringify(graphe).replace(/</g, "\\u003c");
}

// --- document ----------------------------------------------------------------

export async function renderSite(db: D1Database, env: CorpusGateEnv = {}): Promise<string> {
  const [laws, subjects, map, counts] = await Promise.all([
    listLaws(db, {}, "fr", env),
    listSubjects(db, env),
    db
      .prepare(`SELECT subject_id, law_id FROM subject_map WHERE 1=1 ${masqueLawId(env, "law_id")}`)
      .all<{ subject_id: string; law_id: string }>(),
    db
      .prepare(
        `SELECT lang, COUNT(*) AS n FROM articles WHERE 1=1 ${masqueLawId(env, "law_id")} GROUP BY lang`,
      )
      .all<{ lang: string; n: number }>(),
  ]);

  const parMatiere = new Map<string, string[]>();
  for (const m of map.results) {
    const l = parMatiere.get(m.subject_id) ?? [];
    if (!l.includes(m.law_id)) l.push(m.law_id);
    parMatiere.set(m.subject_id, l);
  }
  const parId = new Map(laws.map((l) => [l.id, l]));
  const totalArticles = counts.results.reduce((n, r) => n + r.n, 0);
  const dates = laws
    .map((l) => l.consol_date_fr)
    .filter(Boolean)
    .sort();
  const consol = dates[dates.length - 1] ?? "—";

  const RENDU: Record<SectionId, () => string> = {
    outils: () => outils(),
    reperage: () => reperage(),
    corpus: () => corpus(laws, pdfOuvert(env)),
    matieres: () => matieres(subjects, parMatiere, parId),
    acces: () => acces(),
  };

  const corps = [
    entete(),
    chiffres(laws.length, subjects.length, totalArticles, consol),
    ...SECTIONS.map((s) => RENDU[s.id]()),
    pied(consol),
  ].join("\n");

  const titrePage = "MCP Législation — Lois du Québec et du Canada";
  const titrePageEn = "MCP Legislation — Laws of Québec and Canada";
  const descMeta =
    "Serveur MCP en lecture seule : texte officiel des lois et règlements du Québec et du Canada, directives judiciaires et orientations AMF.";

  return `<!doctype html>
<html lang="fr" class="l-fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title data-fr="${esc(titrePage)}" data-en="${esc(titrePageEn)}">${esc(titrePage)}</title>
<meta name="description" content="${esc(descMeta)}">
<link rel="canonical" href="${ORIGINE_SITE}/">
<link rel="alternate" type="application/mcp-server-card+json" href="${ORIGINE_SITE}/mcp/server-card">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(titrePage)}">
<meta property="og:description" content="${esc(descMeta)}">
<meta property="og:url" content="${ORIGINE_SITE}/">
<meta property="og:locale" content="fr_CA">
<meta property="og:locale:alternate" content="en_CA">
<style>${compacterBloc(CSS)}</style>
<script type="application/ld+json">${construireJsonLd(laws.length, subjects.length, totalArticles, consol)}</script>
<script>${compacterBloc(BOOT)}</script>
</head>
<body>
${sautContenu()}
<div class="wrap">
${tdm()}
<main id="contenu-principal" tabindex="-1">
${corps}
</main>
</div>
${haut()}
<script>${compacterBloc(jsClient())}</script>
</body>
</html>`;
}

// --- découverte publique (/robots.txt, /sitemap.xml, /llms.txt) --------------

export const CHEMINS_DECOUVERTE_PUBLIQUE = ["/robots.txt", "/sitemap.xml", "/llms.txt"] as const;
export type CheminDecouvertePublique = (typeof CHEMINS_DECOUVERTE_PUBLIQUE)[number];

export function estCheminDecouvertePublique(
  pathname: string,
): pathname is CheminDecouvertePublique {
  return (CHEMINS_DECOUVERTE_PUBLIQUE as readonly string[]).includes(pathname);
}

const ROBOTS_TXT = [
  "User-agent: *",
  "Allow: /",
  "Disallow: /mcp",
  "Disallow: /admin/",
  `Sitemap: ${ORIGINE_SITE}/sitemap.xml`,
  "",
].join("\n");

const SITEMAP_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  `  <url><loc>${ORIGINE_SITE}/</loc></url>`,
  "</urlset>",
  "",
].join("\n");

const LLMS_TXT = [
  "# MCP Législation (`lois`) — Lois du Québec et du Canada",
  "",
  `> ${PUBLIC_DESCRIPTION}`,
  "",
  "## Tools (10 read-only MCP tools, derived from catalogue.json)",
  "",
  ...Object.entries(catalogue.tools).map(
    ([nom, t]) => `- \`${nom}\` — ${t.title_fr} / ${t.title_en}`,
  ),
  "",
  "## Québec Civil Law MCP Suite (`droit-civil-quebecois`)",
  "",
  "- [MCP Accès (Admission & OAuth 2.1 Portal)](https://acces.poirierlavoie.ca/): Eligibility (active Barreau du Québec members), `/demande` application, and `/moi` console.",
  `- [MCP Législation (\`lois\`)](${ORIGINE_SITE}/): Official statutes, regulations, court practice directives, and AMF texts. Server Card: ${ORIGINE_SITE}/mcp/server-card`,
  "- [MCP Jurisprudence (`juris`)](https://jurisprudence.poirierlavoie.ca/): Case-law citation verification & CanLII metadata (BYOK CanLII). Server Card: https://jurisprudence.poirierlavoie.ca/mcp/server-card",
  "- [MCP Outils (`outils` — Public, no account required)](https://outils.poirierlavoie.ca/): C.C.P. deadlines, art. 1619 C.C.Q. interest, registries, courthouses, RQA addresses, and bijural terminology. Endpoint: `https://outils.poirierlavoie.ca/mcp`",
  `- [Umbrella Plugin Repository](${DEPOT_PLUGIN}) · [Connector Repository](${DEPOT})`,
  "",
].join("\n");

export function repondreDecouvertePublique(
  chemin: CheminDecouvertePublique,
  method: string,
): Response {
  const { corps, type } =
    chemin === "/robots.txt"
      ? { corps: ROBOTS_TXT, type: "text/plain; charset=utf-8" }
      : chemin === "/sitemap.xml"
        ? { corps: SITEMAP_XML, type: "application/xml; charset=utf-8" }
        : { corps: LLMS_TXT, type: "text/markdown; charset=utf-8" };

  const headers = {
    "Content-Type": type,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "public, max-age=600",
  };

  return method === "HEAD"
    ? new Response(null, { status: 200, headers })
    : new Response(corps, { status: 200, headers });
}

// --- sections ----------------------------------------------------------------

function sautContenu(): string {
  return `<a href="#contenu-principal" class="saut">${bi("Aller au contenu principal", "Skip to main content")}</a>`;
}

function barreSuite(): string {
  return `<nav class="suite" aria-labelledby="suite-t">
  <span id="suite-t" class="sr">${bi("Suite Droit civil québécois", "Québec Civil Law suite")}</span>
  <span class="suite-t">${bi("Droit civil québécois", "Québec Civil Law")}</span>
  <ul>
    <li><a href="https://acces.poirierlavoie.ca/">${bi("Accès", "Access")}</a></li>
    <li><a href="/" aria-current="page">${bi("Législation", "Legislation")}</a></li>
    <li><a href="https://jurisprudence.poirierlavoie.ca/">${bi("Jurisprudence", "Case Law")}</a></li>
    <li><a href="https://outils.poirierlavoie.ca/">${bi("Outils", "Tools")}</a></li>
  </ul>
</nav>`;
}

function tdm(): string {
  const items = SECTIONS.map((s) => `<li><a href="#${s.id}">${bi(s.fr, s.en)}</a></li>`).join("");
  return `<details class="tdm" open>
  <summary id="tdm-t">${bi("Sommaire", "Contents")}</summary>
  <nav aria-labelledby="tdm-t"><ul>${items}</ul></nav>
</details>`;
}

function haut(): string {
  return (
    `<a href="#top" class="haut"><span aria-hidden="true">${FLECHE}</span>` +
    `<span class="sr">${bi("Haut de page", "Back to top")}</span></a>`
  );
}

function etat(t: string, fr: string, en: string): string {
  return `<span data-t="${t}">${bi(fr, en)}</span>`;
}

const SOLEIL = "☀︎";
const FLECHE = "↑︎";
const FLECHE_BAS = "↓︎";

function entete(): string {
  return `<header>
  ${barreSuite()}
  <div class="bar">
    <h1>${bi("MCP Législation — Lois du Québec et du Canada", "MCP Legislation — Laws of Québec and Canada")}</h1>
    <div class="btns">
      <button id="theme" type="button" title="Thème / Theme">${etat(
        "auto",
        "◐ Auto",
        "◐ Auto",
      )}${etat("light", `${SOLEIL} Clair`, `${SOLEIL} Light`)}${etat(
        "dark",
        "☾ Sombre",
        "☾ Dark",
      )}</button>
      <button id="bascule" type="button" title="Français / English">FR&nbsp;·&nbsp;EN</button>
    </div>
  </div>
  ${biP(
    [
      "Serveur MCP donnant aux assistants IA un accès en lecture seule au texte officiel de la législation du Québec et des lois fédérales que le litige civil québécois convoque, ainsi qu'aux directives de pratique judiciaire et aux textes AMF. Les dispositions proviennent des EPUB officiels de LégisQuébec, des fichiers XML du ministère de la Justice du Canada et des PDF officiels des tribunaux du Québec (Cour supérieure, Cour du Québec) et de l'Autorité des marchés financiers (AMF — règlements et instructions générales, certains PDF en français seulement) ; le texte est restitué verbatim, sans altération.",
    ],
    [
      "An MCP server giving AI assistants read-only access to the official text of Québec legislation and the federal statutes that Québec civil litigation relies on, as well as court practice directives and AMF texts. Provision text comes from official LégisQuébec EPUBs, Department of Justice Canada XML files, and official PDFs published by Québec courts (Superior Court, Court of Québec) and the Autorité des marchés financiers (AMF — regulations and policy statements, some PDFs published in French only); text is returned verbatim without alteration.",
    ],
  )}
  <p class="btns">
    <span class="badge">${bi("Membres du Barreau du Québec · OAuth 2.1 / jeton", "Barreau du Québec members · OAuth 2.1 / token")}</span>
    <a class="btn" href="https://acces.poirierlavoie.ca/demande">${bi("Demander l'accès →", "Apply for access →")}</a>
    <a class="btn-sec" href="https://acces.poirierlavoie.ca/">${bi("Portail d'accès", "Access portal")}</a>
  </p>
</header>`;
}

function chiffres(nLois: number, nMat: number, nArt: number, consol: string): string {
  return `<section class="chiffres">
  <div><b>${nb(nLois)}</b>${bi("lois et règlements", "statutes and regulations")}</div>
  <div><b>${nb(nMat)}</b>${bi("matières", "subjects")}</div>
  <div><b>${nb(nArt)}</b>${bi("articles (deux langues)", "articles (both languages)")}</div>
  <div><b>${esc(consol)}</b>${bi("consolidation la plus récente", "most recent consolidation")}</div>
</section>`;
}

function corpus(laws: LawSummary[], pdfActive: boolean): string {
  const lignes = laws
    .map((l) => {
      const [ffr, fen] = FONCTION[l.fonction ?? ""] ?? [l.fonction ?? "", l.fonction ?? ""];
      const src = SOURCES.get(l.id);
      const lien = (u: string | undefined, t: string, lg: string) => {
        const attrLg = lg === "en" ? ' lang="en"' : "";
        return u
          ? `<a data-l="${lg}"${attrLg} href="${esc(u)}" rel="noopener">${esc(t)}</a>`
          : `<span data-l="${lg}"${attrLg}>${esc(t)}</span>`;
      };
      return `<tr data-law-id="${esc(l.id)}" data-f="${esc(l.fonction)}">
      <td class="cite">${esc(citeOf(l))}</td>
      <td>${lien(src?.fr, l.name_fr, "fr")}${lien(src?.en, l.name_en, "en")}</td>
      <td>${bi(ffr, fen)}</td>
      <td class="n">${nb(l.article_count ?? 0)}</td>
      <td class="n">${esc(l.consol_date_fr ?? "—")}</td>
    </tr>`;
    })
    .join("\n");

  return `<section id="corpus">
  ${h2("corpus")}
  ${biP(
    [
      "Les textes législatifs sont chargés dans les deux langues officielles avec leur hiérarchie complète et leur date de consolidation ; les PDF des directives de cour et de l'AMF ne sont chargés qu'en français lorsqu'aucune version anglaise officielle n'est publiée. Les chiffres de cette page sont lus en base au moment du rendu : ils ne peuvent pas dériver de ce qui est réellement servi. Chaque titre renvoie au texte officiel sur LégisQuébec, sur le site Web de la législation (Justice) du Canada, ou sur le site du tribunal ou de l'AMF compétent.",
    ],
    [
      "Legislative texts are loaded in both official languages with their full hierarchy and consolidation date; court directive and AMF PDFs are loaded in French only where no official English PDF is published. The figures on this page are read from the database at render time: they cannot drift from what is actually served. Each title links to the official text on LégisQuébec, the Justice Laws Website of Canada, or the competent court or AMF page.",
    ],
  )}
  <search class="ctl">
    <label class="sr" for="q">${bi("Filtrer les textes législatifs", "Filter legislative texts")}</label>
    <input id="q" type="search" placeholder="Filtrer / Filter">
    <label class="sr" for="f">${bi("Filtrer par fonction normative", "Filter by normative function")}</label>
    <select id="f">
      <option value="">Toutes fonctions · All functions</option>
      <option value="loi">Loi · Statute</option>
      <option value="reglement">Règlement · Regulation</option>
      <option value="regles-procedure">Règles de procédure · Rules</option>
      <option value="tarif">Tarif · Tariff</option>
      ${
        pdfActive
          ? `<option value="directive">Directive de pratique · Practice directive</option>
      <option value="orientation">Orientation · Policy statement</option>`
          : ""
      }
    </select>
    <span id="cpt" class="m" role="status" aria-live="polite"></span>
  </search>
  <div class="tw" tabindex="0" role="region" aria-labelledby="h-corpus"><table id="t">
    <thead><tr>
      <th scope="col"><button type="button" data-s="0">${bi("Citation", "Citation")}</button></th>
      <th scope="col"><button type="button" data-s="1">${bi("Titre", "Title")}</button></th>
      <th scope="col"><button type="button" data-s="2">${bi("Fonction", "Function")}</button></th>
      <th scope="col" class="n"><button type="button" data-s="3">${bi("Articles", "Articles")}</button></th>
      <th scope="col" class="n"><button type="button" data-s="4">${bi("À jour au", "As of")}</button></th>
    </tr></thead>
    <tbody>${lignes}</tbody>
  </table></div>
</section>`;
}

function matieres(
  subjects: SubjectSummary[],
  parMatiere: Map<string, string[]>,
  parId: Map<string, LawSummary>,
): string {
  const groupe = (kind: string, tfr: string, ten: string) => {
    const items = subjects
      .filter((s) => s.kind === kind)
      .map((s) => {
        const ids = parMatiere.get(s.id) ?? [];
        const lois = ids
          .map((id) => parId.get(id))
          .filter(Boolean)
          .map((x) => {
            const l = x as LawSummary;
            return `<li>${bi(l.name_fr, l.name_en)} <span class="m">${esc(citeOf(l))} · ${nb(
              l.article_count ?? 0,
            )}&nbsp;art.</span></li>`;
          })
          .join("");
        return `<details>
        <summary>${bi(s.label_fr, s.label_en || s.label_fr)} <span class="m">(${ids.length})</span></summary>
        ${biP([s.description_fr ?? ""], [s.description_en ?? ""])}
        <ul class="lois">${lois}</ul>
      </details>`;
      })
      .join("\n");
    return `<h3>${bi(tfr, ten)}</h3>${items}`;
  };

  return `<section id="matieres">
  ${h2("matieres")}
  ${biP(
    [
      "La taxonomie range les textes en matières de droit privé, calquées sur les Livres du Code civil, et en matières spécialisées. Un même texte peut relever de plusieurs matières.",
    ],
    [
      "The taxonomy sorts texts into private-law subjects, mapped onto the Books of the Civil Code, and specialized subjects. A single text may belong to several subjects.",
    ],
  )}
  ${groupe("prive-ccq", "Droit privé (C.c.Q.)", "Private law (C.C.Q.)")}
  ${groupe("specialise", "Matières spécialisées", "Specialized subjects")}
</section>`;
}

function outils(): string {
  const bloc = (g: string) =>
    Object.entries(catalogue.tools)
      .filter(([, t]) => t.groupe === g)
      .map(
        ([nom, t]) => `<article>
      <h4><code>${esc(nom)}</code></h4>
      <p class="titre">${bi(t.title_fr, t.title_en)}</p>
      ${biP(t.page_fr, t.page_en)}
    </article>`,
      )
      .join("\n");

  return `<section id="outils">
  ${h2("outils")}
  ${biP(
    [
      "Le patron d'usage est en deux temps : s'orienter, puis extraire. Les premiers outils servent à trouver où regarder ; les suivants rendent le texte officiel. Tous sont en lecture seule — aucun n'écrit quoi que ce soit.",
    ],
    [
      "The usage pattern has two beats: orient yourself, then extract. The first tools find where to look; the rest return the official text. All are read-only — none writes anything.",
    ],
  )}
  <h3>${bi("S'orienter", "Orient")}</h3>
  ${bloc("orientation")}
  <h3>${bi("Extraire", "Extract")}</h3>
  ${bloc("extraction")}
</section>`;
}

function reperage(): string {
  const r = catalogue.retrieval;
  const cal = `<ul class="cal">
    <li>${bi("matière", "subject")} <b>+${WEIGHTS.S1_SUBJECT}</b></li>
    <li>${bi("intitulé de division", "division heading")} <b>+${WEIGHTS.S2_DIVISION_HEADING}</b></li>
    <li>${bi("nom de loi", "statute name")} <b>+${WEIGHTS.S3_LAW_NAME}</b></li>
    <li>${bi("voisin de graphe", "graph neighbour")} <b>+${WEIGHTS.S4_GRAPH_NEIGHBOUR}</b></li>
    <li>${bi("candidats max par matière", "max candidates per subject")} <b>${MAX_PER_SUBJECT}</b></li>
    <li>${bi("suffixe max apparié", "max matched suffix")} <b>${MAX_SUFFIX}</b></li>
    <li>${bi("facteur de spécificité", "specificity factor")} <b>×${SPECIFIC_TOKEN_FACTOR}</b> ${bi(
      `jusqu'à ${SPECIFIC_TOKEN_MAX_REACH} textes`,
      `up to ${SPECIFIC_TOKEN_MAX_REACH} texts`,
    )}</li>
    <li>${bi("plancher sémantique", "semantic floor")} <b>${SEMANTIC_MIN_SCORE}</b></li>
    <li>${bi("fusion RRF", "RRF fusion")} <b>k&nbsp;=&nbsp;${RRF_K}</b>, ${bi(
      `profondeur ${VECTOR_TOP_K}`,
      `depth ${VECTOR_TOP_K}`,
    )}</li>
    <li>${bi("pondération normative", "normative weighting")} <b>directive ×${FONCTION_WEIGHTS.directive} · orientation ×${FONCTION_WEIGHTS.orientation}</b></li>
    <li>${bi("plafond fonction souple", "soft-function cap")} <b>${MAX_PER_FONCTION_SOUPLE}</b></li>
  </ul>`;

  const sec = (s: { titre_fr: string; titre_en: string; corps_fr: string[]; corps_en: string[] }) =>
    `<h3>${bi(s.titre_fr, s.titre_en)}</h3>${biP(s.corps_fr, s.corps_en)}`;

  return `<section id="reperage">
  ${h2("reperage")}
  ${biP(r.intro_fr, r.intro_en)}
  ${sec(r.signaux)}
  ${cal}
  ${sec(r.echelle)}
  ${sec(r.hybride)}
  ${limites()}
</section>`;
}

function limites(): string {
  const a = catalogue.avertissement;
  return `<section id="limites" class="avert">
  <h3>${bi(a.titre_fr, a.titre_en)}</h3>
  ${biP(a.corps_fr, a.corps_en)}
</section>`;
}

function acces(): string {
  return `<section id="acces">
  ${h2("acces")}
  ${biP(
    [
      `Ce serveur est réservé aux membres en règle du Barreau du Québec. Deux portes d'accès coexistent : le montage à jeton individuel direct https://legislation.poirierlavoie.ca/mcp (qui répond 404 sans corps à tout appel non authentifié afin de prévenir toute découverte OAuth non sollicitée) et le montage OAuth 2.1 https://legislation.poirierlavoie.ca/mcp/oauth (PKCE S256 via https://acces.poirierlavoie.ca). Les demandes d'accès et la gestion libre-service des jetons, de la préférence de recherche hybride et de la révocation s'effectuent sur https://acces.poirierlavoie.ca/demande et https://acces.poirierlavoie.ca/moi (ou en écrivant à ${CONTACT}).`,
      "Aucun texte de requête ni argument d'outil n'est journalisé (journaux d'invocation Cloudflare désactivés, zéro écriture dans search_log). Une fiche publique de découverte MCP (SEP-2127) sans secret est exposée sur https://legislation.poirierlavoie.ca/mcp/server-card ; le dépôt inclut les manifestes pour Google Antigravity (plugin.json, mcp_config.json) et Gemini CLI (gemini-extension.json).",
      "Le code source est libre et gratuit sous licence Apache-2.0 (voir LICENSE) ; le fichier NOTICE reconnaît les sources officielles sans revendication de droit d'auteur sur les textes servis (LégisQuébec, Justice Canada OGL-Canada, QCCS/QCCQ et AMF). Le corpus est reproductible : le pipeline d'ingestion, la taxonomie et les données de configuration sont tous versionnés.",
    ],
    [
      `This server is reserved for members in good standing of the Barreau du Québec. Two access mounts coexist: the direct per-holder token mount https://legislation.poirierlavoie.ca/mcp (which returns an empty 404 to any unauthenticated call so unsolicited OAuth discovery is never triggered) and the OAuth 2.1 mount https://legislation.poirierlavoie.ca/mcp/oauth (PKCE S256 via https://acces.poirierlavoie.ca). Access requests and self-service token, hybrid-search preference, and revocation management are available at https://acces.poirierlavoie.ca/demande and https://acces.poirierlavoie.ca/moi (or by writing to ${CONTACT}).`,
      "No query text or tool argument is ever logged (Cloudflare invocation logs disabled, zero runtime writes to search_log). A public MCP Server Card (SEP-2127) without secrets is published at https://legislation.poirierlavoie.ca/mcp/server-card; the repository ships manifests for Google Antigravity (plugin.json, mcp_config.json) and Gemini CLI (gemini-extension.json).",
      "The source code is free and open-source under Apache-2.0 (see LICENSE); the NOTICE file credits official publishers without claiming copyright over the served texts (LégisQuébec, Justice Canada OGL-Canada, QCCS/QCCQ, and AMF). The corpus is reproducible: the ingestion pipeline, the taxonomy and the configuration data are all version-controlled.",
    ],
  )}
  <p><a href="https://acces.poirierlavoie.ca/demande" rel="noopener">${bi("Demande d'accès (/demande)", "Apply for access (/demande)")}</a> · <a href="https://acces.poirierlavoie.ca/moi" rel="noopener">/moi</a> · <a href="https://jurisprudence.poirierlavoie.ca/" rel="noopener">${bi("Jurisprudence", "Case Law")}</a> · <a href="https://outils.poirierlavoie.ca/" rel="noopener">${bi("Outils (public)", "Tools (public)")}</a> · <a href="${DEPOT_PLUGIN}" rel="noopener">droit-civil-quebecois</a> · <a href="${DEPOT}" rel="noopener">${esc(DEPOT.replace("https://", ""))}</a></p>
</section>`;
}

function pied(consol: string): string {
  return `<footer>
  <p><b>Jason Poirier Lavoie</b>, ${bi("avocat", "attorney")} · <a href="mailto:${CONTACT}">${CONTACT}</a></p>
  ${biP(
    [
      `Données : EPUB officiels de LégisQuébec (Éditeur officiel du Québec), XML du ministère de la Justice du Canada (Licence du gouvernement ouvert – Canada), ainsi que PDF officiels des tribunaux du Québec (Cour supérieure, Cour du Québec — directives de pratique) et de l'Autorité des marchés financiers (AMF — règlements et instructions générales sans force de loi) ; consolidation la plus récente chargée : ${consol}. La version officielle fait foi : celle de l'Éditeur officiel du Québec, celle publiée par le ministre pour le fédéral (art. 31 de la Loi sur la révision et la codification des textes législatifs), ou celle du tribunal ou de l'AMF compétent. Ce site n'est pas une version officielle. Aucun conseil juridique.`,
    ],
    [
      `Data: official LégisQuébec EPUBs (Québec Official Publisher), Department of Justice Canada XML (Open Government Licence – Canada), and official PDFs from Québec courts (Superior Court, Court of Québec — practice directives) and the Autorité des marchés financiers (AMF — regulations and non-binding policy statements); most recent consolidation loaded: ${consol}. The official version prevails: that of the Québec Official Publisher, that published by the Minister for federal texts (s. 31, Legislation Revision and Consolidation Act), or that of the competent court or the AMF. This is not an official version. No legal advice.`,
    ],
  )}
  <p><a href="${LEGISQUEBEC}" rel="noopener">legisquebec.gouv.qc.ca</a> · <a href="https://acces.poirierlavoie.ca/" rel="noopener">acces.poirierlavoie.ca</a> · <a href="${DEPOT}" rel="noopener">GitHub</a></p>
</footer>`;
}

// --- CSS / JS ----------------------------------------------------------------

const CLAIR =
  "color-scheme:light;--f:#0f172a;--m:#475569;--b:#cbd5e1;--bi:#64748b;--a:#1d4ed8;--bg:#f8fafc;--card:#fff;" +
  "--th:#f1f5f9;--code:#e2e8f0;--hover:#f1f5f9;--avert-bg:#eff6ff;--avert-b:#93c5fd";
const SOMBRE =
  "color-scheme:dark;--f:#f1f5f9;--m:#94a3b8;--b:#334155;--bi:#64748b;--a:#60a5fa;--bg:#0b1120;--card:#111827;" +
  "--th:#1e293b;--code:#1e293b;--hover:#1e293b;--avert-bg:#172554;--avert-b:#1d4ed8";

const LARGE = "78rem";

const CSS = `
:root{${CLAIR}}
@media(prefers-color-scheme:dark){:root{${SOMBRE}}}
html.t-light{${CLAIR}}
html.t-dark{${SOMBRE}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--f);font-family:system-ui,-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;font-size:1rem;line-height:1.6;-webkit-font-smoothing:antialiased}
.wrap{max-width:${LARGE};margin:0 auto;padding:2rem 1.25rem 4rem;display:grid;gap:1rem}
main{min-width:0;max-width:60rem;width:100%;justify-self:center}
section[id]{scroll-margin-top:1.5rem}
#corpus,#matieres{content-visibility:auto;contain-intrinsic-size:auto 40rem}
h1{font-size:clamp(1.45rem,1.2rem + 1vw,1.85rem);line-height:1.25;letter-spacing:-.02em;margin:0;text-wrap:balance}
h2{font-size:1.28rem;line-height:1.3;letter-spacing:-.015em;margin:2.75rem 0 .8rem;padding-bottom:.4rem;border-bottom:1px solid var(--b);text-wrap:balance}
h3{font-size:1.08rem;line-height:1.35;letter-spacing:-.01em;margin:1.75rem 0 .45rem;text-wrap:balance}
h4{font-size:.98rem;line-height:1.4;margin:1.2rem 0 .25rem}
p{margin:.6rem 0;text-wrap:pretty;overflow-wrap:break-word}
li{text-wrap:pretty;overflow-wrap:break-word}
a{color:var(--a);text-underline-offset:.18em;text-decoration-thickness:1px}
a:hover{text-decoration-thickness:2px}
code{font:.88em ui-monospace,'SF Mono','Cascadia Code',Menlo,Consolas,monospace;background:var(--code);padding:.12em .38em;border-radius:4px}
:where(a,button,input,select,summary,[tabindex]):focus-visible{outline:2px solid var(--a);outline-offset:2px}
.saut{position:fixed;left:1rem;top:1rem;z-index:20;padding:.45rem .85rem;background:var(--card);
  color:var(--a);border:2px solid var(--a);border-radius:8px;font-weight:700;text-decoration:none}
.saut:not(:focus-visible){position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;
  clip-path:inset(50%);white-space:nowrap;border:0}
.suite{display:flex;align-items:center;justify-content:space-between;gap:.5rem 1rem;flex-wrap:wrap;
  margin:0 0 1.1rem;padding:0 0 .7rem;border-bottom:1px solid var(--b);font-size:.875rem}
.suite-t{font-weight:600;color:var(--f);letter-spacing:-.01em}
.suite ul{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:.35rem}
.suite a{display:inline-block;padding:.3rem .72rem;border:1px solid transparent;border-radius:999px;
  color:var(--m);font-weight:500;text-decoration:none;min-height:1.75rem}
.suite a:hover{color:var(--a);border-color:var(--b);background:var(--card)}
.suite a[aria-current=page]{color:var(--a);font-weight:600;border-color:var(--a);background:var(--card)}
.bar{display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap}
.btns{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center}
#bascule,#theme,.btn-sec{font:inherit;font-size:.82rem;font-weight:500;letter-spacing:.01em;background:var(--card);border:1px solid var(--bi);
  border-radius:999px;padding:.35rem .9rem;cursor:pointer;color:var(--f);text-decoration:none;white-space:nowrap;display:inline-block}
#bascule:hover,#theme:hover,.btn-sec:hover{border-color:var(--a);color:var(--a)}
#theme{min-width:6.5rem;text-align:center}
#theme [data-t]{display:none}
html:not(.t-light):not(.t-dark) #theme [data-t=auto],
html.t-light #theme [data-t=light],
html.t-dark #theme [data-t=dark]{display:inline}
.btn{font:inherit;font-size:.86rem;font-weight:600;background:var(--a);color:var(--bg);
  border:1px solid var(--a);border-radius:8px;padding:.4rem 1rem;text-decoration:none;white-space:nowrap;display:inline-block}
.btn:hover{opacity:.92}
.badge{display:inline-block;font-size:.78rem;font-weight:500;padding:.2rem .65rem;border-radius:999px;
  border:1px solid var(--avert-b);background:var(--avert-bg);color:var(--f)}
.chiffres{display:grid;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));gap:1rem;
  margin:2rem 0;padding:1.25rem;background:var(--card);border:1px solid var(--b);border-radius:8px}
.chiffres div{text-align:center}
.chiffres b{display:block;font-size:1.5rem;line-height:1.2;font-variant-numeric:tabular-nums}
.chiffres span{font-size:.8rem;color:var(--m)}
.ctl{display:flex;gap:.6rem;align-items:center;flex-wrap:wrap;margin:1rem 0}
.ctl input,.ctl select{font:inherit;font-size:.9rem;padding:.42rem .65rem;border:1px solid var(--bi);
  border-radius:6px;background:var(--card);color:var(--f)}
.ctl input{flex:1;min-width:10rem}
.m{color:var(--m);font-size:.875rem}
.tw{overflow-x:auto;border:1px solid var(--b);border-radius:8px;background:var(--card)}
table{border-collapse:collapse;width:100%;font-size:.875rem}
th,td{padding:.55rem .75rem;text-align:left;border-bottom:1px solid var(--b);vertical-align:top}
th{background:var(--th);position:sticky;top:0;font-weight:600;text-wrap:balance}
th button{font:inherit;font-weight:600;background:none;border:0;padding:.25rem .15rem;cursor:pointer;color:inherit;min-height:1.75rem}
th[aria-sort=ascending] button::after{content:" ${FLECHE}"}
th[aria-sort=descending] button::after{content:" ${FLECHE_BAS}"}
td.n,th.n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
td.cite{white-space:nowrap;font-size:.85em;color:var(--m)}
tbody tr:hover{background:var(--hover)}
details{border:1px solid var(--b);border-radius:8px;background:var(--card);margin:.5rem 0;padding:.65rem .95rem}
summary{cursor:pointer;font-weight:600}
.lois{margin:.5rem 0 0;padding-left:1.2rem}
.lois li{margin:.2rem 0}
.tdm{max-width:60rem;width:100%;justify-self:center}
.tdm ul{list-style:none;margin:.5rem 0 0;padding:0;font-size:.85rem}
.tdm li{margin:.15rem 0}
.tdm a{display:block;padding:.28rem .65rem;border-left:2px solid var(--b);
  color:var(--m);text-decoration:none}
.tdm a:hover,.tdm a.on{color:var(--a);border-left-color:var(--a)}
.tdm a.on{font-weight:600}
#outils article{border-left:3px solid var(--b);padding-left:1rem;margin:1.5rem 0}
#outils .titre{color:var(--m);font-style:italic;margin:.1rem 0 .5rem}
.cal{list-style:none;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));
  gap:.45rem;margin:1rem 0;font-size:.88rem;font-variant-numeric:tabular-nums}
.cal li{background:var(--card);border:1px solid var(--b);border-radius:6px;padding:.45rem .75rem;
  display:flex;justify-content:space-between;gap:.5rem}
.avert{background:var(--avert-bg);border:1px solid var(--avert-b);border-radius:8px;padding:.35rem 1.25rem 1rem}
footer{margin-top:3.5rem;padding-top:1.25rem;border-top:1px solid var(--b);font-size:.875rem;color:var(--m)}
.sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;
  clip-path:inset(50%);white-space:nowrap;border:0}
.haut{position:fixed;right:1.25rem;bottom:1.25rem;z-index:10;width:2.6rem;height:2.6rem;
  display:flex;align-items:center;justify-content:center;text-decoration:none;font-size:1.1rem;
  background:var(--card);color:var(--f);border:1px solid var(--bi);border-radius:999px}
.haut:hover{color:var(--a);border-color:var(--a)}
html.js .haut{opacity:0;visibility:hidden}
html.js .haut.on{opacity:1;visibility:visible}
@media(prefers-reduced-motion:no-preference){
  html{scroll-behavior:smooth}
  .haut{transition:opacity .2s,visibility .2s,color .2s,border-color .2s}
}
@media(forced-colors:active){
  .suite a[aria-current=page],.tdm a.on,.btn{outline:2px solid Highlight}
}
html.l-fr [data-l=en],html.l-en [data-l=fr]{display:none}
@media(min-width:${LARGE}){
  .wrap{grid-template-columns:13rem minmax(0,60rem);gap:2.5rem;align-items:start}
  main,.tdm{max-width:none}
  .tdm{position:sticky;top:2rem;border:0;background:none;margin:0;padding:0;
    max-height:calc(100vh - 4rem);overflow:auto}
  .tdm>summary{display:none}
}
`;

const BOOT = String.raw`
try{
  var r=document.documentElement, c=[];
  var p=localStorage.getItem('qclawLang')||(navigator.language||'fr').slice(0,2);
  c.push(p==='en'?'l-en':'l-fr'); r.lang=(p==='en'?'en':'fr');
  var t=localStorage.getItem('qclawTheme');
  if(t==='light'||t==='dark') c.push('t-'+t);
  r.className=c.join(' ');
  var ti=document.querySelector&&document.querySelector('title[data-en]');
  if(ti&&p==='en') document.title=ti.getAttribute('data-en');
}catch(e){}
`;

const JS = String.raw`
(function(){
  var d=document, h=d.documentElement;
  var b=d.getElementById('bascule');
  if(b) b.addEventListener('click',function(){
    var nv=h.classList.contains('l-en')?'fr':'en';
    h.classList.toggle('l-fr',nv==='fr'); h.classList.toggle('l-en',nv==='en');
    h.lang=nv;
    var ti=d.querySelector('title[data-en]');
    if(ti) d.title=ti.getAttribute(nv==='en'?'data-en':'data-fr')||d.title;
    try{localStorage.setItem('qclawLang',nv);}catch(e){}
  });

  var tb=d.getElementById('theme');
  if(tb) tb.addEventListener('click',function(){
    var cur=h.classList.contains('t-light')?'light'
           :h.classList.contains('t-dark')?'dark':'auto';
    var nx=cur==='auto'?'light':cur==='light'?'dark':'auto';
    h.classList.remove('t-light'); h.classList.remove('t-dark');
    if(nx!=='auto') h.classList.add('t-'+nx);
    try{
      if(nx==='auto') localStorage.removeItem('qclawTheme');
      else localStorage.setItem('qclawTheme',nx);
    }catch(e){}
  });

  var td=d.querySelector('.tdm');
  if(td){
    try{
      var mq=matchMedia('(min-width:LARGEUR)');
      var sync=function(){td.open=mq.matches;};
      sync();
      if(mq.addEventListener) mq.addEventListener('change',sync);
      else if(mq.addListener) mq.addListener(sync);
    }catch(e){}
    try{
      var liens=[].slice.call(td.querySelectorAll('a'));
      var cibles=liens.map(function(a){return d.getElementById(a.getAttribute('href').slice(1));});
      var io=new IntersectionObserver(function(es){
        for(var n=0;n<es.length;n++){
          if(!es[n].isIntersecting) continue;
          var k=cibles.indexOf(es[n].target); if(k<0) continue;
          for(var j=0;j<liens.length;j++) liens[j].classList.remove('on');
          liens[k].classList.add('on');
        }
      },{rootMargin:'0px 0px -70% 0px'});
      for(var n=0;n<cibles.length;n++) if(cibles[n]) io.observe(cibles[n]);
    }catch(e){}
  }

  var ht=d.querySelector('.haut');
  if(ht){
    try{
      h.classList.add('js');
      var seuil=function(){return (window.innerHeight||600)*0.8;};
      var maj=function(){
        var y=window.pageYOffset||d.documentElement.scrollTop||0;
        if(y>seuil()) ht.classList.add('on'); else ht.classList.remove('on');
      };
      maj();
      window.addEventListener('scroll',maj,{passive:true});
    }catch(e){}
  }

  var t=d.getElementById('t'); if(!t) return;
  var body=t.tBodies[0], rows=[].slice.call(body.rows);
  var q=d.getElementById('q'), f=d.getElementById('f'), cpt=d.getElementById('cpt');

  function fold(s){
    s=s.toLowerCase().normalize('NFD');
    var o='';
    for(var i=0;i<s.length;i++){var c=s.charCodeAt(i);if(c<768||c>879)o+=s[i];}
    return o;
  }
  var idx=new WeakMap();
  for(var r0=0;r0<rows.length;r0++) idx.set(rows[r0],fold(rows[r0].textContent));

  function filtre(){
    var needle=fold(q?q.value:''), fonction=f?f.value:'', n=0;
    for(var i=0;i<rows.length;i++){
      var r=rows[i];
      var ok=(!fonction||r.getAttribute('data-f')===fonction) &&
             (!needle||(idx.get(r)||'').indexOf(needle)>-1);
      r.hidden=!ok; if(ok)n++;
    }
    if(cpt) cpt.textContent=n+' / '+rows.length;
  }
  if(q) q.addEventListener('input',filtre);
  if(f) f.addEventListener('change',filtre);
  filtre();

  var ths=t.tHead.rows[0].cells;
  [].forEach.call(t.querySelectorAll('th button'),function(btn){
    btn.addEventListener('click',function(){
      var i=+btn.getAttribute('data-s'), th=ths[i];
      var asc=th.getAttribute('aria-sort')!=='ascending';
      for(var m=0;m<ths.length;m++) ths[m].removeAttribute('aria-sort');
      th.setAttribute('aria-sort',asc?'ascending':'descending');
      var num=(i===3);
      rows.sort(function(a,c){
        var x=a.cells[i].textContent.trim(), y=c.cells[i].textContent.trim();
        var v=num?(parseInt(x.replace(/[^0-9]/g,''),10)||0)-(parseInt(y.replace(/[^0-9]/g,''),10)||0)
                 :x.localeCompare(y,'fr');
        return asc?v:-v;
      });
      for(var k=0;k<rows.length;k++) body.appendChild(rows[k]);
    });
  });
})();
`;

function jsClient(): string {
  if (!JS.includes("LARGEUR")) throw new Error("jeton LARGEUR absent du JS client");
  return JS.replace("LARGEUR", LARGE);
}
