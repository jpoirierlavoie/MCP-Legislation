// Évals du routeur qclaw_find_relevant (plan-couche-decouverte §8) + fumée des outils
// de découverte. Tests de bout en bout : parlent MCP (HTTP streamable) au serveur réel.
//
//   npx wrangler dev            # dans un autre terminal (D1 local)
//   npm run evals               # ou : MCP_URL=https://…/mcp node tests/evals.mjs
//
// Sortie : une ligne par éval, code de sortie 1 si l'une échoue.

import { readFileSync } from "node:fs";
import { createMcpClient, parseBody, resolveClientToken, resolveMcpToken } from "../eval/mcp-client.mjs";

const MCP_URL = process.env.MCP_URL ?? "http://127.0.0.1:8787/mcp";

// Client MCP partagé avec le harnais d'évaluation (eval/mcp-client.mjs) —
// UNE session pour tous les appels.
const { connect, callTool } = createMcpClient(MCP_URL);

// --- évals du §8 --------------------------------------------------------------
//
// `top`     : le 1er candidat doit correspondre.
// `present` : chacun doit figurer dans les candidats retournés.
// `none`    : aucun rapprochement (message d'aide attendu).
// Une attente { law, pathPrefix? } matche un candidat de cette loi dont le
// division_path commence par pathPrefix (absent = n'importe quelle cible de la loi).

const EVALS = [
  {
    query: "vice caché",
    attendu: "ccq / obligations (Livre 5) en tête",
    top: { law: "ccq", pathPrefix: "ga:l_cinquieme" },
  },
  {
    query: "bail de logement",
    attendu: "bloc TAL + chapitre du louage du C.c.Q.",
    present: [
      { law: "ccq", pathPrefix: "ga:l_cinquieme-gb:l_deuxieme-gc:l_quatrieme" },
      { law: "t-15.01" },
    ],
  },
  {
    query: "congédiement",
    attendu: "n-1.1 + contrat de travail du C.c.Q.",
    present: [
      { law: "n-1.1" },
      { law: "ccq", pathPrefix: "ga:l_cinquieme-gb:l_deuxieme-gc:l_septieme" },
    ],
  },
  {
    query: "appel civil",
    attendu: "c-25.01-r.0.2.01 + cpc",
    present: [{ law: "c-25.01-r.0.2.01" }, { law: "cpc" }],
  },
  {
    query: "hypothèque légale construction",
    attendu: "ccq / sûretés (Livre 6)",
    present: [{ law: "ccq", pathPrefix: "ga:l_sixieme" }],
  },
  {
    // AMENDÉ le 2026-09-13, sur décision éditoriale de Jason — pas pour faire passer le test.
    //
    // `d-9.2` (Loi sur la distribution de produits et services financiers) a quitté la
    // matière `assurances` pour ne plus relever que du `secteur-financier` : elle régit des
    // INTERMÉDIAIRES, pas le contrat d'assurance. Sur « assurance responsabilité », la
    // réponse juste est donc le chapitre du C.c.Q., et `d-9.2` n'est plus attendue.
    //
    // Mesuré avant de trancher : le retrait fait tomber `d-9.2` hors du top 8, parce qu'elle
    // perdait DEUX choses à la fois — les points S1 d'`assurances`, et l'échappatoire au
    // plafond que procurait la double appartenance (`relevance.ts:325`, `matieres.every`).
    // Elle concourt désormais pour 3 places parmi les 12 entités du secteur financier.
    //
    // Une variante conservant `d-9.2` dans `assurances` a été éprouvée et passait ; elle a
    // été ÉCARTÉE parce qu'elle contredisait la décision, non parce qu'elle échouait.
    query: "assurance responsabilité",
    attendu: "chapitre des assurances du C.c.Q.",
    present: [
      { law: "ccq", pathPrefix: "ga:l_cinquieme-gb:l_deuxieme-gc:l_quinzieme" },
    ],
  },
  {
    query: "renseignements personnels fuite",
    attendu: "p-39.1",
    present: [{ law: "p-39.1" }],
  },
  {
    query: "procédure TAQ",
    attendu: "j-3 + j-3-r.3.01",
    present: [{ law: "j-3" }, { law: "j-3-r.3.01" }],
  },
  {
    query: "courtage immobilier",
    attendu: "c-73.2",
    present: [{ law: "c-73.2" }],
  },
  {
    query: "déontologie avocat",
    attendu: "b-1-r.3.1 (Code de déontologie) + droit professionnel",
    present: [{ law: "b-1-r.3.1" }],
  },
  // Miroirs ANGLAIS des évals françaises : le signal S1 (matière, +3) doit se déclencher
  // aussi en anglais. Sans label_en/description_en, il restait muet et le routeur anglais
  // perdait sa couche la plus utile — celle qui réunit un chapitre du C.c.Q. et les lois
  // spécialisées d'une même matière.
  {
    query: "residential lease",
    lang: "en",
    attendu: "miroir de « bail de logement » : bloc TAL + chapitre LEASE du C.c.Q.",
    present: [
      { law: "ccq", pathPrefix: "ga:l_five-gb:l_two-gc:l_iv" },
      { law: "t-15.01" },
    ],
  },
  {
    query: "latent defect",
    lang: "en",
    attendu: "miroir de « vice caché » : ccq / OBLIGATIONS (Book Five) en tête",
    top: { law: "ccq", pathPrefix: "ga:l_five" },
  },
  {
    query: "unfair dismissal",
    lang: "en",
    attendu: "miroir de « congédiement » : n-1.1 + contract of employment du C.c.Q.",
    present: [
      { law: "n-1.1" },
      { law: "ccq", pathPrefix: "ga:l_five-gb:l_two-gc:l_vii" },
    ],
  },
  // Régression du lot 3 (78 lois) : « fin » captait « financier » faute de plafond de
  // suffixe, et tout le bloc du secteur financier évinçait le chapitre du contrat de
  // travail. Cf. MAX_SUFFIX (src/relevance.ts).
  {
    query: "clause non-concurrence fin d'emploi",
    attendu: "contrat de travail du C.c.Q. présent ; le secteur financier n'est PAS capté par « fin »",
    present: [{ law: "ccq", pathPrefix: "ga:l_cinquieme-gb:l_deuxieme-gc:l_septieme" }],
    absent: [{ law: "d-9.2" }, { law: "d-9.2-r.20" }],
  },
  // Régression du lot 3 : « bâtiment et construction » compte 7 lois, qui remplissaient
  // le top 8 à elles seules. Cf. MAX_PER_SUBJECT (src/relevance.ts).
  {
    query: "perte de l'ouvrage cinq ans entrepreneur",
    attendu: "ouvrages immobiliers du C.c.Q. présents (la matière « bâtiment » ne se déclenche plus ici)",
    present: [{ law: "ccq", pathPrefix: "ga:l_cinquieme-gb:l_deuxieme-gc:l_huitieme" }],
  },
  {
    // LA GARDE DE L'INVARIANT 15 A ÉTÉ DÉPLACÉE ICI, le 2026-09-14, et ce n'est pas cosmétique.
    //
    // Elle vivait sur « perte de l'ouvrage cinq ans entrepreneur », où elle s'exerçait parce
    // que le mot « entrepreneur » figurait dans la description de la matière. Ce mot en a été
    // RETIRÉ (il déclenchait les 7 textes de la famille sur toute requête d'entrepreneur), et
    // plus aucun candidat de cette requête ne porte « matière : Bâtiment et construction ».
    //
    // La garde y serait donc devenue VIDE : la boucle ne compte rien et passe au vert sans
    // s'exercer — pire qu'une garde absente, parce qu'elle a l'air de veiller.
    //
    // Repointée après MESURE sur une requête où le plafond mord réellement : au 2026-09-14,
    // trois candidats y portent la matière (b-1.1-r.2, b-1.1, b-1.1-r.1), soit exactement
    // MAX_PER_SUBJECT, et le Code de construction sort premier par son nom.
    query: "licence d'entrepreneur en construction et cautionnement",
    attendu: "Code de construction en tête, et la matière « bâtiment » plafonnée à 3 candidats",
    present: [{ law: "b-1.1-r.2" }],
    maxParMatiere: 3,
  },
  {
    // LE DÉFAUT QUI A JUSTIFIÉ LA SCISSION DU SECTEUR FINANCIER, épinglé le 2026-09-14.
    //
    // Avant : `secteur-financier` portait 12 entités, toutes appariées au MÊME score par
    // « amf », aucune ne portant d'autre signal. MAX_PER_SUBJECT en laissait passer 3, et le
    // départage est ALPHABÉTIQUE (relevance.ts:315) : a-32.1, c-67.3, d-9.2. La Loi sur
    // l'encadrement du secteur financier — CELLE QUI CRÉE L'AUTORITÉ — arrivait neuvième
    // dans l'alphabet et était absente du classement entier.
    //
    // Aucun enrichissement de description ne pouvait corriger cela : ajouter des mots montait
    // les douze à égalité. Seule la réduction de la matière le fait.
    query: "pouvoirs de l'AMF",
    attendu: "e-6.1, la loi qui crée l'Autorité, présente — elle était ABSENTE avant la scission",
    present: [{ law: "e-6.1" }],
  },
  {
    // Miroir du précédent, côté distribution. Avant la scission, les trois premiers étaient
    // « Contrats publics » — l'Autorité des marchés PUBLICS captait « autorité » et
    // « marchés » là où `secteur-financier` écrivait seulement le sigle « AMF ». Les textes
    // justes arrivaient 5e, 6e et 8e.
    query: "plainte contre un représentant en épargne collective devant l'Autorité des marchés financiers",
    attendu: "les textes de la distribution en tête, devant la Loi sur l'Autorité des marchés PUBLICS",
    top: { law: "d-9.2-r.10" },
    present: [{ law: "d-9.2" }, { law: "d-9.2-r.2" }],
  },
  {
    query: "zzzzq wxyv",
    attendu: "aucun rapprochement, message d'aide",
    none: true,
  },
];

const matches = (cand, exp) =>
  cand.law === exp.law &&
  (!exp.pathPrefix || (cand.division_path ?? "").startsWith(exp.pathPrefix));

const fmt = (c) => `${c.law}${c.division_path ? `›${c.division_path}` : ""}(${c.score})`;

async function runEval(e) {
  const res = await callTool("qclaw_find_relevant",
    e.lang ? { query: e.query, lang: e.lang } : { query: e.query });
  const cands = res.structuredContent?.candidates ?? [];
  const failures = [];

  if (e.none) {
    if (!res.isError) failures.push(`attendu aucun rapprochement, obtenu ${cands.length} candidat(s)`);
    const txt = res.content?.[0]?.text ?? "";
    if (!/list_subjects/.test(txt)) failures.push("le message n'oriente pas vers qclaw_list_subjects");
    return { failures, cands };
  }

  if (res.isError) {
    failures.push(`erreur inattendue : ${res.content?.[0]?.text ?? "?"}`);
    return { failures, cands };
  }
  if (e.top && !matches(cands[0] ?? {}, e.top)) {
    failures.push(`en tête : attendu ${e.top.law}${e.top.pathPrefix ? `›${e.top.pathPrefix}…` : ""}, obtenu ${cands[0] ? fmt(cands[0]) : "rien"}`);
  }
  for (const exp of e.present ?? []) {
    if (!cands.some((c) => matches(c, exp))) {
      failures.push(`absent : ${exp.law}${exp.pathPrefix ? `›${exp.pathPrefix}…` : ""}`);
    }
  }
  for (const exp of e.absent ?? []) {
    const parasite = cands.find((c) => matches(c, exp));
    if (parasite) failures.push(`présent à tort : ${fmt(parasite)}`);
  }
  if (e.maxParMatiere) {
    const parMatiere = new Map();
    for (const c of cands) {
      for (const m of (c.pourquoi ?? []).filter((x) => x.startsWith("matière : "))) {
        parMatiere.set(m, (parMatiere.get(m) ?? 0) + 1);
      }
    }
    for (const [m, n] of parMatiere) {
      if (n > e.maxParMatiere) failures.push(`matière trop représentée : ${m} × ${n}`);
    }
  }
  return { failures, cands };
}

// --- fumée des autres outils de découverte ------------------------------------

async function smokeTests() {
  const checks = [];
  const add = (nom, ok, detail = "") => checks.push({ nom, ok, detail });
  // Un contrôle SAUTÉ doit se VOIR. Le rendre vert serait exactement le « faux, servi,
  // silencieux » que ce dépôt refuse ; le rendre rouge ferait crier un poste qui n'a
  // légitimement pas le jeton d'un AUTRE client. D'où un troisième état, imprimé ⊘.
  const skip = (nom, pourquoi) => checks.push({ nom, ok: true, saute: true, detail: pourquoi });

  // Le décompte est DÉRIVÉ, plus écrit en dur. Motif : pendant l'ingestion fédérale
  // texte par texte, un littéral `=== 79` rougit dès le premier texte basculé et reste
  // rouge pendant les dix-sept suivants — on perdrait le harnais au moment précis où il
  // sert le plus. `served.json` déclare ce que le serveur SERT (interrupteur compris), donc
  // le contrôle reste vert à chaque cran et rouge dès qu'une ingestion diverge du déclaré.
  const servis = JSON.parse(
    readFileSync(new URL("../pipeline/expected/served.json", import.meta.url), "utf8"),
  ).ids.length;
  const laws = await callTool("qclaw_list_laws", {});
  add(`list_laws : ${servis} lois servies`, laws.structuredContent?.count === servis,
    `count=${laws.structuredContent?.count}, déclaré=${servis}`);
  const ccq = laws.structuredContent?.laws?.find((l) => l.id === "ccq");
  add("list_laws : ccq porte ses Livres (matières)", (ccq?.mapped_divisions?.length ?? 0) >= 10,
    `${ccq?.mapped_divisions?.length ?? 0} division(s) mappée(s)`);

  const filtered = await callTool("qclaw_list_laws", { fonction: "tarif" });
  add("list_laws : filtre fonction='tarif'", filtered.structuredContent?.count === 4,
    `count=${filtered.structuredContent?.count}`);

  const bySubject = await callTool("qclaw_list_laws", { subject: "louage-residentiel" });
  add("list_laws : filtre subject='louage-residentiel'",
    (bySubject.structuredContent?.count ?? 0) >= 3,
    `count=${bySubject.structuredContent?.count}`);

  const subs = await callTool("qclaw_list_subjects", {});
  add("list_subjects : 42 matières", subs.structuredContent?.count === 42,
    `count=${subs.structuredContent?.count}`);

  // Les 42 matières doivent être traduites : c'est la surface d'appariement du signal S1,
  // sans quoi le routeur reste muet en anglais.
  const subsEn = await callTool("qclaw_list_subjects", { lang: "en" });
  const sansEn = (subsEn.structuredContent?.subjects ?? [])
    .filter((s) => !s.label_en || !s.description_en).map((s) => s.id);
  add("list_subjects (lang=en) : les 42 matières traduites", sansEn.length === 0,
    sansEn.length ? `sans traduction : ${sansEn.slice(0, 5).join(", ")}…` : "");
  // Contrôler les ENTRÉES, pas seulement les en-têtes de groupe : une première version
  // traduisait « Private law (C.C.Q.) » tout en listant « biens — Biens » et sa description
  // française, et l'éval passait quand même.
  const texteEn = subsEn.content?.[0]?.text ?? "";
  // Marqueurs choisis parmi les libellés qui DIFFÈRENT réellement d'une langue à l'autre :
  // « Successions » et « Prescription » s'écrivent pareil en anglais et donneraient un faux positif.
  const ligneFr = texteEn.split("\n").find((l) =>
    /^\s+•/.test(l) && /— (Biens|Personnes|Famille|Preuve|Assurances)\b/.test(l));
  add("list_subjects (lang=en) : les ENTRÉES rendues en anglais",
    !ligneFr && /— Property\b/.test(texteEn) && /law\(s\)/.test(texteEn),
    ligneFr ? `entrée restée en français : ${ligneFr.trim().slice(0, 60)}` : "");
  add("list_subjects (lang=en) : descriptions rendues en anglais",
    /Ownership, co-ownership/.test(texteEn) && !/Propriété, copropriété/.test(texteEn));
  add("list_subjects (lang=en) : en-têtes de groupe en anglais",
    /Private law|Specialized areas/.test(texteEn) && !/Matières spécialisées/.test(texteEn));

  // Non-régression FR : la version française ne doit pas avoir basculé en anglais.
  const texteFr = subs.content?.[0]?.text ?? "";
  add("list_subjects (lang=fr) : rendu toujours en français",
    /— Biens\b/.test(texteFr) && /Matières spécialisées/.test(texteFr) && !/— Property\b/.test(texteFr));

  // 6 règlements de cour sous le chapitre C-25.01 (sur les 13 arêtes 'reglement-de' du corpus)
  const rel = await callTool("qclaw_related_laws", { law: "cpc", rel_type: "reglement-de" });
  add("related_laws : cpc a 6 règlements", rel.structuredContent?.total === 6,
    `total=${rel.structuredContent?.total}`);

  const bad = await callTool("qclaw_related_laws", { law: "inexistante" });
  add("related_laws : erreur actionnable si loi inconnue",
    bad.isError === true && /Lois disponibles/.test(bad.content?.[0]?.text ?? ""));

  // L'outil DÉCLARAIT `lang` sans jamais le lire : un client demandant l'anglais recevait
  // noms de lois ET notes curées en français, sans étiquette — « faux, servi, silencieux ».
  const relEn = await callTool("qclaw_related_laws", { law: "c-27.1", lang: "en" });
  const relsEn = relEn.structuredContent?.relations ?? [];
  const c19 = relsEn.find((r) => r.other_id === "c-19");
  add("related_laws (lang=en) : nom de loi en ANGLAIS",
    c19?.other_name === "Cities and Towns Act", `other_name=${c19?.other_name}`);
  // Les notes curées n'existent qu'en français (pas de colonne note_en) : elles doivent être
  // MARQUÉES, pas maquillées. L'étiquette voyage aussi dans la charge utile (R4/décision 001).
  add("related_laws (lang=en) : note curée marquée [fr] en prose ET en données",
    /\[fr\]/.test(relEn.content?.[0]?.text ?? "") && c19?.note_lang === "fr",
    `note_lang=${c19?.note_lang}`);
  add("related_laws (lang=en) : ossature de la réponse en anglais",
    /relation\(s\) for/.test(relEn.content?.[0]?.text ?? ""),
    (relEn.content?.[0]?.text ?? "").slice(0, 60));
  const relFr = await callTool("qclaw_related_laws", { law: "c-27.1" });
  add("related_laws (défaut fr) : nom de loi en français, aucune marque [fr]",
    (relFr.structuredContent?.relations ?? []).find((r) => r.other_id === "c-19")?.other_name
      === "Loi sur les cités et villes" && !/\[fr\]/.test(relFr.content?.[0]?.text ?? ""));

  // list_laws rendait les libellés de MATIÈRES toujours en français, même sous lang='en',
  // alors que label_en est peuplé sur les 42 matières. Contrôler les ENTRÉES, pas l'en-tête :
  // c'est la leçon déjà tirée pour list_subjects et jamais reportée ici.
  const lawsEn = await callTool("qclaw_list_laws", { lang: "en", structure: false });
  const cmEn = lawsEn.structuredContent?.laws?.find((l) => l.id === "c-27.1");
  add("list_laws (lang=en) : libellés de matières en ANGLAIS",
    (cmEn?.subjects ?? []).includes("Municipal Law"), `subjects=${JSON.stringify(cmEn?.subjects)}`);
  const lawsFr = await callTool("qclaw_list_laws", { lang: "fr", structure: false });
  add("list_laws (lang=fr) : libellés de matières en français",
    (lawsFr.structuredContent?.laws?.find((l) => l.id === "c-27.1")?.subjects ?? [])
      .includes("Droit municipal"));

  // --- extraction : garde-fous contre les régressions trouvées en phase E ---

  // Le mode plage (from/to) dépend de l'échelle de articles.sort_key. Une divergence entre
  // le pipeline (Python) et le serveur (TS) l'avait vidé silencieusement sur 36 lois sur 38
  // — mesuré à l'époque où le corpus comptait 38 textes.
  // On l'exerce donc sur TOUTES les lois, pas seulement sur ccq.
  const toutes = laws.structuredContent?.laws ?? [];
  const cassees = [];
  for (const l of toutes) {
    const r = await callTool("qclaw_get_articles", { law: l.id, from: "1", to: "3" });
    if (r.isError) cassees.push(l.id);
  }
  add(`get_articles : mode plage opérant sur les ${servis} lois servies`, cassees.length === 0,
    cassees.length ? `échec sur ${cassees.length} : ${cassees.slice(0, 6).join(", ")}…` : "");

  // Le contrôle ci-dessus ne regarde que `isError`. Il resterait VERT si une colonne
  // disparaissait de la projection SQL : `structuredContent.articles[].text` vaudrait
  // `undefined`, et la prose rendrait « undefined » À LA PLACE DU TEXTE OFFICIEL. `tsc` ne
  // peut rien y voir — la signature D1 `all<T>()` est une ASSERTION, pas une vérification :
  // le compilateur ne lit pas le SQL. D'où ces contrôles sur la FORME de la sortie.
  {
    const r = await callTool("qclaw_get_articles", { law: "ccq", from: "1", to: "5" });
    const a = r.structuredContent?.articles?.[0];
    add("get_articles : chaque article porte number, text, division_path, repealed",
      !!a && typeof a.number === "string" && a.number.length > 0 &&
      typeof a.text === "string" && a.text.length > 0 &&
      typeof a.division_path === "string" && a.division_path.length > 0 &&
      typeof a.repealed === "boolean",
      `number=${typeof a?.number} text=${typeof a?.text}(${a?.text?.length ?? 0}) ` +
      `path=${typeof a?.division_path} repealed=${typeof a?.repealed}`);
  }

  // RÉGRESSION mesurée EN PRODUCTION le 2026-09-07 : `articles.sort_key` n'est PAS un ordre
  // total. Il empaquette `int(composante)`, donc `int("01") === int("1")` — le zéro de tête
  // est PERDU. Mesuré : `15.01` et `15.1` de ccq-r.8 partageaient la clé 15001000000000,
  // `15.02`/`15.2` la 15002000000000, et `31.01`/`31.1`, `31.02`/`31.2` de t-15.01 de même,
  // dans les DEUX langues. Défaut SERVI : `from='15.1' to='15.2'` rendait QUATRE articles,
  // en y ajoutant 15.01 et 15.02 — qui relèvent d'un tout autre chapitre — sans un mot.
  // Les plages bornées par deux articles réels passent désormais par l'ordre du DOCUMENT.
  for (const [law, a, b] of [["ccq-r.8", "15.1", "15.2"], ["t-15.01", "31.1", "31.2"]]) {
    for (const lang of ["fr", "en"]) {
      const r = await callTool("qclaw_get_articles", { law, from: a, to: b, lang });
      const nums = (r.structuredContent?.articles ?? []).map((x) => x.number);
      add(`get_articles : plage ${law} ${a}..${b} (${lang}) exacte, sans les voisins à clé partagée`,
        nums.length === 2 && nums[0] === a && nums[1] === b,
        `rendu : [${nums.join(", ")}]`);
      add(`get_articles : plage ${law} ${a}..${b} (${lang}) étiquetée 'document'`,
        r.structuredContent?.range_resolution === "document",
        `range_resolution=${r.structuredContent?.range_resolution}`);
    }
  }

  // L'étiquette borne le résultat, donc elle voyage dans structuredContent en champ
  // TOUJOURS présent (R4, corollaire structuré, décision 001) : « absent » et « borné par
  // le texte » ne doivent pas être confondus.
  {
    const n = await callTool("qclaw_get_articles", { law: "ccq", numbers: ["1457", "1590"] });
    add("get_articles : range_resolution présent et null en mode numbers[]",
      "range_resolution" in (n.structuredContent ?? {}) && n.structuredContent.range_resolution === null,
      `range_resolution=${JSON.stringify(n.structuredContent?.range_resolution)}`);
    const o = await callTool("qclaw_get_articles", { law: "ccq", from: "1", to: "9999" });
    add("get_articles : borne ouverte étiquetée 'cle' (repli sur la clé de tri)",
      o.structuredContent?.range_resolution === "cle",
      `range_resolution=${o.structuredContent?.range_resolution}`);
    // Un pseudo-article comme borne retombe aussi sur la clé : son `id` ne suit pas
    // l'ordre du document (l'émission du parseur le place hors de sa position réelle).
    const p = await callTool("qclaw_get_articles", { law: "ccq", from: "préliminaire", to: "3" });
    add("get_articles : pseudo-article en borne étiqueté 'cle'",
      p.structuredContent?.range_resolution === "cle",
      `range_resolution=${p.structuredContent?.range_resolution}`);
  }

  // Un article ABROGÉ rendu comme en vigueur est le pire défaut possible ici, et il serait
  // parfaitement silencieux : `!!undefined === false`, donc une colonne `repealed` perdue
  // ferait disparaître la mention sans erreur. On l'exerce sur un article réellement abrogé.
  // Fixture ÉPINGLÉE, et pas une sonde : une première version cherchait un article abrogé
  // par recherche plein texte sur « abrogé » dans le C.c.Q. — qui n'en contient AUCUN. Le
  // contrôle passait au vert sans jamais s'exercer, ce qui est pire que pas de contrôle.
  // a-2.1 art. 26 est abrogé en base (22 articles abrogés dans cette loi). Si ce n'est plus
  // vrai après une réingestion, ce contrôle DOIT rougir : c'est un fait de corpus qui change.
  {
    const one = await callTool("qclaw_get_article", { law: "a-2.1", article: "26" });
    add("get_article : un article abrogé est marqué abrogé, en données ET en prose",
      one.structuredContent?.repealed === true && /abrog/i.test(one.content?.[0]?.text ?? ""),
      `a-2.1 art. 26 : repealed=${one.structuredContent?.repealed} ` +
      `prose=${/abrog/i.test(one.content?.[0]?.text ?? "")}`);
  }

  // getStructure sans parent_id APLATIT l'arbre : toutes les divisions deviennent racines.
  // Le contrôle voisin ne teste que l'absence d'erreur — il passerait.
  {
    const st = await callTool("qclaw_get_structure", { law: "ccq" });
    const tree = st.structuredContent?.tree;
    const profondeur = (ns, d = 1) => ns.reduce(
      (m, n) => Math.max(m, n.children?.length ? profondeur(n.children, d + 1) : d), 0);
    const ok2 = Array.isArray(tree) && tree.length > 0 && profondeur(tree) > 1;
    add("get_structure : l'arbre a plus d'un niveau (parent_id non perdu)", ok2,
      `racines=${Array.isArray(tree) ? tree.length : "?"} profondeur=${
        Array.isArray(tree) ? profondeur(tree) : "?"}`);
  }

  // D1 plafonne la complexité des motifs LIKE/GLOB : les chemins profonds du C.c.Q. le
  // dépassaient et faisaient échouer get_division / get_structure(root_path).
  const profond = "ga:l_cinquieme-gb:l_premier-gc:l_troisieme-gd:l_i-ge:l_1";
  const div = await callTool("qclaw_get_division", { law: "ccq", path: profond });
  add("get_division : chemin profond (55 car.) sans erreur D1", div.isError !== true,
    div.isError ? (div.content?.[0]?.text ?? "").slice(0, 90) : "");
  const stru = await callTool("qclaw_get_structure", { law: "ccq", root_path: profond });
  add("get_structure : root_path profond sans erreur D1", stru.isError !== true,
    stru.isError ? (stru.content?.[0]?.text ?? "").slice(0, 90) : "");

  // resolve_reference rendait silencieusement le MAUVAIS article de la MAUVAISE loi :
  // « c. T-16 » lui donnait l'article 16 du C.c.Q.
  const t16 = await callTool("qclaw_resolve_reference", { citation: "RLRQ, c. T-16, art. 12" });
  add("resolve_reference : chapitre RLRQ correctement reconnu",
    t16.structuredContent?.resolved?.law === "t-16" &&
    t16.structuredContent?.resolved?.number === "12",
    `obtenu ${t16.structuredContent?.resolved?.law}/${t16.structuredContent?.resolved?.number}`);
  const ccqRef = await callTool("qclaw_resolve_reference", { citation: "art. 1457 C.c.Q." });
  add("resolve_reference : abréviation C.c.Q. toujours reconnue",
    ccqRef.structuredContent?.resolved?.law === "ccq" &&
    ccqRef.structuredContent?.resolved?.number === "1457",
    `obtenu ${ccqRef.structuredContent?.resolved?.law}/${ccqRef.structuredContent?.resolved?.number}`);

  // Une source juridique sans date de consolidation n'est pas citable : les 78 doivent l'avoir.
  const sansDate = toutes.filter((l) => !l.consol_date_fr).map((l) => l.id);
  add(`list_laws : date de consolidation sur les ${servis} lois servies`, sansDate.length === 0,
    sansDate.length ? `manquante sur ${sansDate.length} : ${sansDate.slice(0, 5).join(", ")}…` : "");

  // Les identifiants Irosoft sont propres à la langue : une piste rendue en anglais doit
  // porter un chemin ANGLAIS, sinon get_division(lang='en') la refuse.
  const enLaws = await callTool("qclaw_list_laws", { lang: "en" });
  const ccqEn = enLaws.structuredContent?.laws?.find((l) => l.id === "ccq");
  const premier = ccqEn?.mapped_divisions?.[0];
  const ouvrable = premier
    ? await callTool("qclaw_get_division",
        { law: "ccq", lang: "en", path: premier.division_path, include_text: false })
    : { isError: true };
  add("list_laws (lang=en) : chemins de divisions ouvrables en anglais",
    ouvrable.isError !== true && !!premier?.heading,
    premier ? `${premier.division_path} / ${premier.heading}` : "aucune division mappée");

  // Un chapitre HORS corpus dont un chapitre du corpus est préfixe ne doit pas être avalé.
  // (« B-1.1 » jouait ce rôle jusqu'à son entrée au corpus — voir le contrôle suivant ;
  // « C-73.3 » le remplace : absent, mais préfixé par c-73.2 qui est présent.)
  const horsCorpus = await callTool("qclaw_resolve_reference", { citation: "RLRQ, c. C-73.3, art. 5" });
  add("resolve_reference : chapitre hors corpus refusé, pas rabattu sur un voisin",
    horsCorpus.isError === true,
    horsCorpus.isError ? "" : `résolu à tort en ${horsCorpus.structuredContent?.resolved?.law}`);

  // DEUX chapitres du corpus dont l'un préfixe l'autre : le plus long doit gagner.
  // b-1 = Loi sur le Barreau ; b-1.1 = Loi sur le bâtiment. e-6 = employés publics ;
  // e-6.1 = encadrement du secteur financier. Confondre les deux serait un faux silencieux.
  for (const [cite, attendu] of [
    ["RLRQ, c. B-1.1, art. 5", "b-1.1"], ["RLRQ, c. B-1, art. 5", "b-1"],
    ["RLRQ, c. E-6.1, art. 1", "e-6.1"], ["RLRQ, c. E-6, art. 1", "e-6"],
    ["RLRQ, c. C-65.1, art. 1", "c-65.1"], ["RLRQ, c. C-65.01, art. 1", "c-65.01"],
  ]) {
    const r = await callTool("qclaw_resolve_reference", { citation: cite });
    add(`resolve_reference : « ${cite.replace("RLRQ, c. ", "")} » -> ${attendu}`,
      r.structuredContent?.resolved?.law === attendu,
      `obtenu ${r.structuredContent?.resolved?.law ?? "(refus)"}`);
  }

  // Marqueur « a. » (forme québécoise usuelle) : sans lui, le numéro du CHAPITRE était pris
  // pour l'article — « (chapitre T-16), a. 12 » rendait l'article 16.
  const marqueurA = await callTool("qclaw_resolve_reference",
    { citation: "Loi sur les tribunaux judiciaires (chapitre T-16), a. 12" });
  add("resolve_reference : marqueur « a. » et chapitre non confondu avec l'article",
    marqueurA.structuredContent?.resolved?.law === "t-16" &&
    marqueurA.structuredContent?.resolved?.number === "12",
    `obtenu ${marqueurA.structuredContent?.resolved?.law}/${marqueurA.structuredContent?.resolved?.number}`);

  const frEn = await callTool("qclaw_find_relevant", { query: "residential lease", lang: "en" });
  const s1 = (frEn.structuredContent?.candidates ?? []).find((c) => c.division_path);
  add("find_relevant (lang=en) : pas de chemin français dans une réponse anglaise",
    !s1 || !/l_(premier|deuxieme|troisieme|quatrieme|cinquieme|sixieme)/.test(s1.division_path),
    s1 ? s1.division_path : "aucun candidat de division");

  // --- phase 1 (Discovery v2) : tests d'acceptation devenus permanents ---

  // 1.1 : restreinte sans résultat -> élargissement corpus étiqueté
  const widen = await callTool("qclaw_search_text", { query: "extranéité", law: "b-9" });
  add("v2 1.1 : élargissement corpus sur zéro résultat (étiqueté)",
    widen.isError !== true &&
    /Aucun résultat dans b-9/.test(widen.content?.[0]?.text ?? "") &&
    (widen.structuredContent?.results ?? []).some((r) => r.law_id === "cpc" && r.number === "490"),
    (widen.content?.[0]?.text ?? "").slice(0, 60));

  // 1.1 : restreinte AVEC résultats -> résultats inchangés + aperçu ailleurs (post-mortem)
  const scoped = await callTool("qclaw_search_text", { query: "extranéité", law: "ccq" });
  add("v2 1.1 : aperçu « ailleurs au corpus » sur recherche restreinte avec résultats",
    scoped.structuredContent?.fallback === null &&
    (scoped.structuredContent?.results ?? []).every((r) => r.law_id === "ccq") &&
    (scoped.structuredContent?.elsewhere?.results ?? []).some((r) => r.law_id === "cpc" && r.number === "490"));

  // 1.2/2.4 : LE CAS FONDATEUR — cpc 490 dans le top 5, par un chemin ÉTIQUETÉ.
  // Depuis la phase 2, le repérage sémantique répond AVANT le leave-one-out (décision
  // 2.4) ; les deux chemins sont légitimes, l'exigence est le résultat + l'étiquette.
  const fond = await callTool("qclaw_search_text",
    { query: "signification hors du Québec délai", law: "cpc" });
  const fondTop5 = (fond.structuredContent?.results ?? []).slice(0, 5);
  add("v2 1.2/2.4 : cas fondateur — cpc 490 top 5, chemin étiqueté (LOO ou sémantique)",
    (/terme ignoré : « hors »/.test(fond.content?.[0]?.text ?? "") ||
     /repérage sémantique/.test(fond.content?.[0]?.text ?? "")) &&
    fondTop5.some((r) => r.law_id === "cpc" && r.number === "490"),
    fondTop5.map((r) => `${r.law_id}|${r.number}`).join(", "));

  // 1.2 : requête absurde -> échec propre
  const absurde = await callTool("qclaw_search_text", { query: "zzz qqq" });
  add("v2 1.2 : requête absurde échoue proprement", absurde.isError === true);

  // 1.3 : fils d'Ariane lisibles + ID machine + extraits élargis + groupes par loi
  const presc = await callTool("qclaw_search_text", { query: "prescription" });
  const prescText = presc.content?.[0]?.text ?? "";
  add("v2 1.3 : fil d'Ariane + ID machine dans les résultats",
    /C\.c\.Q\. — Livre HUITIÈME/.test(prescText) && /\[ga:l_huitieme/.test(prescText));
  add("v2 1.3 : recherche corpus groupée par loi (≥ 2 groupes)",
    (prescText.match(/^— .+ \(\d+/gm) ?? []).length >= 2,
    `${(prescText.match(/^— .+ \(\d+/gm) ?? []).length} groupe(s)`);
  const unSnippet = (presc.structuredContent?.results ?? [])[0]?.snippet ?? "";
  add("v2 1.3 : extraits élargis (≥ 25 tokens)", unSnippet.split(/\s+/).length >= 25,
    `${unSnippet.split(/\s+/).length} tokens`);

  // 1.4 : plan profondeur 2 — le Titre IV du Livre V cpc est visible dans list_laws
  const lls = await callTool("qclaw_list_laws", {});
  add("v2 1.4 : list_laws expose Livre V + Titre IV (droit international privé) du cpc",
    /LES DEMANDES INTÉRESSANT LE DROIT INTERNATIONAL PRIVÉ \[ga:l_v-gb:l_iv\]/.test(lls.content?.[0]?.text ?? ""));
  const llsSans = await callTool("qclaw_list_laws", { structure: false });
  add("v2 1.4 : structure=false coupe le plan",
    !/▸ Livre/.test(llsSans.content?.[0]?.text ?? ""));

  // 1.5 : chemin FR sous lang=en -> pont par numéros d'articles
  const pont = await callTool("qclaw_get_division",
    { law: "ccq", path: "ga:l_cinquieme-gb:l_deuxieme-gc:l_septieme", lang: "en", include_text: false });
  add("v2 1.5 : chemin FR accepté sous lang=en (CONTRACT OF EMPLOYMENT)",
    pont.isError !== true && /CONTRACT OF EMPLOYMENT/.test(pont.content?.[0]?.text ?? ""));

  // --- phase 2 : hybride sémantique (exigent HYBRID_SEARCH=1 + index rempli) ---

  // Cas 19 du plan (acceptation de la phase 2) : requête ANGLAISE -> texte FRANÇAIS.
  // Aucun terme lexical commun ; seul le pont sémantique multilingue (bge-m3) y arrive.
  const sem = await callTool("qclaw_search_text", { query: "defendant outside Quebec time to answer" });
  add("v2 2.3 : cas 19 — requête EN trouve cpc 490 (pont sémantique)",
    (sem.structuredContent?.results ?? []).some((r) => r.law_id === "cpc" && r.number === "490"),
    (sem.structuredContent?.results ?? []).slice(0, 5).map((r) => `${r.law_id}|${r.number}`).join(", "));
  add("v2 2.3 : chemin sémantique étiqueté (R7 : fail open, dit)",
    /repérage sémantique/.test(sem.content?.[0]?.text ?? "") ||
    sem.structuredContent?.fallback === "semantic");

  // Une requête lexicalement servie reste lexicale (pas de bruit sémantique en tête).
  const lex = await callTool("qclaw_search_text", { query: "extranéité" });
  add("v2 2.3 : requête lexicale — le 1er résultat reste la correspondance exacte",
    (lex.structuredContent?.results ?? [])[0]?.number !== undefined &&
    ["3111", "490", "622"].includes((lex.structuredContent?.results ?? [])[0]?.number));

  // Contrôle d'accès (src/auth.ts). Depuis le défaut FERMÉ, il n'existe plus d'état où
  // l'endpoint serait légitimement ouvert : un POST nu DOIT recevoir 404, toujours.
  // On vise le point de montage nu, jamais MCP_URL : celle-ci peut déjà porter /mcp/<jeton>.
  const jeton = resolveMcpToken();
  const jetonAthena = resolveClientToken("athena");
  if (jeton) {
    const bare = new URL(MCP_URL);
    bare.pathname = "/mcp";
    bare.search = "";
    const INIT = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "gate", version: "1" } },
    };
    const sonder = async (u, entetes) => {
      const res = await fetch(u, {
        method: "POST",
        headers: { "Content-Type": "application/json",
          Accept: "application/json, text/event-stream", ...entetes },
        body: JSON.stringify(INIT),
      });
      // Consommer le corps : une réponse SSE laissée ouverte retient le processus.
      await res.text().catch(() => "");
      return res.status;
    };
    const probe = (u, auth) => sonder(u, auth ? { Authorization: `Bearer ${jeton}` } : {});
    const probeBearer = (u, porteur) => sonder(u, { Authorization: `Bearer ${porteur}` });

    // 404 et pas 401 : un 401 annoncerait un serveur MCP et lancerait la découverte OAuth.
    const refus = await probe(bare, false);
    add("accès : POST sans jeton -> 404 (pas 401)", refus === 404, `status=${refus}`);

    // Les trois porteurs acceptés. Le SLASH FINAL est le cas qui a réellement cassé le
    // connecteur claude.ai (2026-07-23) : son 404 poussait le client vers la découverte
    // OAuth, qui échouait ensuite sur l'enregistrement dynamique.
    for (const [nom, u, auth] of [
      ["en-tête Bearer", `${bare}`, true],
      ["segment de chemin", `${bare}/${jeton}`, false],
      ["segment + slash final", `${bare}/${jeton}/`, false],
      ["paramètre ?key=", `${bare}?key=${jeton}`, false],
    ]) {
      const code = await probe(u, auth);
      add(`accès : ${nom} -> 200`, code === 200, `status=${code}`);
    }

    // Le slash final sur le point de montage NU : la porte l'autorisait, mais la requête
    // repartait sans normalisation et le transport rendait 404 (mesuré le 2026-08-27).
    // C'est la forme qu'un client en Bearer produit s'il normalise son URL — et un 404
    // est lu par un client MCP comme « ce serveur exige une authentification ».
    {
      const code = await probeBearer(`${bare}/`, jeton);
      add("accès : /mcp/ nu + Bearer -> 200 (slash final toléré PARTOUT)",
        code === 200, `status=${code}`);
    }

    // Jeton FAUX de MÊME LONGUEUR, DÉRIVÉ du vrai : il traverse la boucle d'octets de
    // safeEqual au lieu de sortir au contrôle de longueur. Si quelqu'un remplaçait un jour
    // la comparaison par un startsWith ou un préfixe, CE contrôle rougirait — et lui seul.
    // Jamais écrit dans le dépôt : il est calculé.
    {
      const faux = jeton.slice(0, -1) + (jeton.endsWith("0") ? "1" : "0");
      const code = await probe(`${bare}?key=${faux}`, false);
      add("accès : jeton FAUX (même longueur, un octet près) -> 404", code === 404,
        `status=${code}`);
    }

    // SECOND PORTEUR (Pallas Athéna). Ce qui est vérifié n'est pas un privilège mais une
    // INDÉPENDANCE : il ouvre par les mêmes formes, aux mêmes droits. La révocation SÉPARÉE
    // (retirer l'un laisse l'autre debout) ne s'éprouve qu'en faisant varier l'env du
    // Worker : elle ne peut pas se tester ici, seulement par deux `wrangler dev --var`
    // distincts — c'est écrit dans le plan, et ce n'est PAS couvert par la CI.
    if (jetonAthena) {
      for (const [nom, u, auth] of [
        ["en-tête Bearer", `${bare}`, jetonAthena],
        ["paramètre ?key=", `${bare}?key=${jetonAthena}`, null],
      ]) {
        const code = auth ? await probeBearer(u, auth) : await probe(u, false);
        add(`accès : 2e jeton (athena) par ${nom} -> 200`, code === 200, `status=${code}`);
      }
    } else {
      skip("accès : 2e jeton (athena) -> 200",
        "aucun jeton de client secondaire ici (ni MCP_TOKEN_ATHENA, ni mcp-athena.token)");
    }

    // Le connecteur claude.ai émet des GET NUS (mesuré au wrangler tail) : refusés en 404,
    // il retombe en POST seul, sans perte pour les 10 outils. Ne PAS « réparer » ça
    // (CLAUDE.md) — donc l'épingler, sinon quelqu'un le réparera.
    {
      const code = await fetch(bare, { method: "GET", headers: { Accept: "text/event-stream" },
        signal: AbortSignal.timeout(5000) })
        .then((r) => { r.body?.cancel(); return r.status; })
        .catch((e) => `abandon (${e.name})`);
      add("accès : GET sans jeton -> 404 (comportement VOULU, cf. CLAUDE.md)",
        code === 404, `status=${code}`);
    }

    // --- compatibilité « client à état » ------------------------------------------
    // Vise le second consommateur : un backend qui ouvre LUI-MÊME sa session et parle donc
    // le cycle de vie complet, FERMETURE COMPRISE — ce qu'aucun de nos clients ne faisait.
    // UNE SEULE session supplémentaire pour tout le bloc (invariant 10), refermée à la fin.
    // On éprouve le TRANSPORT et la PORTE, pas le corpus : le contenu est le rôle de la fumée.
    {
      const porteur = jetonAthena ?? jeton;
      const quel = jetonAthena ? "jeton athena" : "jeton principal, faute de mieux";
      const entetes = (sid) => ({
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${porteur}`,
        ...(sid ? { "mcp-session-id": sid } : {}),
      });
      const post = (corps, sid) =>
        fetch(bare, { method: "POST", headers: entetes(sid), body: JSON.stringify(corps) });

      const ini = await post(INIT);
      const sid = ini.headers.get("mcp-session-id");
      const txtIni = await ini.text();
      add(`état (${quel}) : initialize -> 200 + en-tête mcp-session-id`,
        ini.status === 200 && !!sid,
        `status=${ini.status} session=${sid ? "reçue" : "ABSENTE"}`);

      const msgIni = ini.status === 200
        ? parseBody(txtIni, ini.headers.get("content-type") ?? "") : null;
      add("état : initialize rend un résultat JSON-RPC nommant le serveur",
        !!msgIni?.result?.serverInfo?.name,
        `serverInfo=${JSON.stringify(msgIni?.result?.serverInfo ?? null)}`);
      // CE QU'ON N'AFFIRME PAS : la version de protocole négociée ni celle du serveur —
      // elles bougeront, et un client tiers n'a pas à s'y accrocher.

      const notif = await post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, sid);
      await notif.text().catch(() => "");
      add("état : notifications/initialized -> 2xx",
        notif.status >= 200 && notif.status < 300, `status=${notif.status}`);
      // 200 OU 202 : le transport a le droit d'accuser réception d'une notification par 202.
      // Épingler « === 200 » ferait rougir une mise à jour du SDK sans qu'aucun client ne
      // soit cassé — un faux échec, donc un test qu'on désapprend à lire.

      // GET et DELETE PORTEURS, sur la session déjà ouverte (aucune session de plus).
      // CE QU'ON AFFIRME : la PORTE ne refuse pas une requête pourtant porteuse.
      // CE QU'ON N'AFFIRME PAS : que le paquet `agents` serve ces verbes. S'il ne les gère
      // pas il répondra 405 ou 400 — une réponse du TRANSPORT, pas un refus d'accès, et le
      // contrôle doit rester vert. Seuls 404 et 401 sont des échecs ici.
      let getCode;
      try {
        const g = await fetch(bare, { method: "GET", headers: entetes(sid),
          signal: AbortSignal.timeout(5000) });
        getCode = g.status;
        await g.body?.cancel();
      } catch (e) {
        getCode = `abandon (${e.name})`;
      }
      add("état : GET /mcp porteur n'est PAS refusé par la porte (ni 404 ni 401)",
        getCode !== 404 && getCode !== 401 && typeof getCode === "number", `status=${getCode}`);

      const del = await fetch(bare, { method: "DELETE", headers: entetes(sid) });
      await del.text().catch(() => "");
      add("état : DELETE /mcp (fermeture) n'est PAS refusé par la porte (ni 404 ni 401)",
        del.status !== 404 && del.status !== 401, `status=${del.status}`);
      console.log(`      (transport : GET -> ${getCode}, DELETE -> ${del.status} — mesure, `
        + "pas exigence : c'est le paquet `agents` qui répond)");
    }
  } else {
    skip("accès : bloc entier", "aucun jeton résolu ici (ni MCP_TOKEN, ni mcp.token)");
  }

  // --- page publique (R10) ---------------------------------------------------
  // Ces trois contrôles opposent la PAGE et l'OUTIL sur le serveur réel. Le deuxième est
  // le plus profond du lot : il aurait attrapé « 38 textes » servis pendant que le corpus
  // en comptait 79. Requêtes brutes, aucune session MCP supplémentaire (invariant 10).
  {
    const racine = new URL(MCP_URL);
    racine.pathname = "/";
    racine.search = "";
    const res = await fetch(racine, { headers: { Accept: "text/html" } });
    const html = await res.text();
    add("page : GET / -> 200 text/html",
      res.status === 200 && /text\/html/.test(res.headers.get("content-type") ?? ""),
      `status=${res.status} type=${res.headers.get("content-type")}`);

    // Parité page <-> outil : autant de lignes de loi que qclaw_list_laws n'annonce de lois.
    const rows = (html.match(/data-law-id="/g) ?? []).length;
    add("page : autant de lois affichées que list_laws en déclare",
      rows === laws.structuredContent?.count,
      `page=${rows} list_laws=${laws.structuredContent?.count}`);

    // Le HTML public ne doit transporter AUCUN secret. Testé par MOTIF, jamais par
    // comparaison au jeton — le contrôle doit valoir même sans jeton sous la main.
    add("page : aucune forme de jeton dans le HTML",
      !/Bearer\s|[?&]key=|[0-9a-f]{32,}/i.test(html),
      "motif de jeton détecté dans la page publique");

    // Sommaire <-> document, sur le HTML RÉELLEMENT SERVI. Les gardes de
    // tests/page-client.test.mjs scannent le TEXTE de src/site.ts : ils ne peuvent pas voir
    // un mauvais aiguillage (une entrée du sommaire câblée sur le rendu d'une autre
    // section), une section rendue deux fois, ni un sommaire qui ment sur l'ORDRE. Ici,
    // c'est la page finale qu'on interroge. `top` est l'ancre de la pastille de retour en
    // haut, pas une section : elle est exclue.
    const ancres = [...html.matchAll(/href="#([a-z]+)"/g)].map((m) => m[1])
      .filter((a) => a !== "top");
    const sections = [...html.matchAll(/<section id="([a-z]+)"/g)].map((m) => m[1]);
    const orphelines = ancres.filter((a) => !sections.includes(a));
    add("page : chaque entrée du sommaire pointe vers une section qui existe",
      ancres.length > 0 && orphelines.length === 0,
      `ancres=${ancres.length} sans cible=[${orphelines}]`);

    const dansLOrdre = sections.filter((s) => ancres.includes(s));
    add("page : l'ordre du sommaire est celui du document",
      JSON.stringify(ancres) === JSON.stringify(dansLOrdre),
      `sommaire=[${ancres}] document=[${dansLOrdre}]`);

    // L'avertissement a perdu son entrée de sommaire en devenant une sous-section : plus
    // rien d'autre ne signalerait sa disparition de la page.
    add("page : l'avertissement et la clause de non-conseil sont rendus",
      /<section id="limites"/.test(html) &&
      /Aucun conseil juridique/.test(html) && /No legal advice/.test(html),
      "avertissement ou clause de non-conseil absent du HTML servi");
  }

  return checks;
}

// --- exécution ----------------------------------------------------------------

async function main() {
  console.log(`MCP : ${MCP_URL}\n`);
  await connect();

  let failed = 0;

  console.log("— Fumée des outils de découverte —");
  for (const c of await smokeTests()) {
    const marque = c.saute ? "⊘" : c.ok ? "✓" : "✗";
    const detail = c.detail && (c.saute || !c.ok) ? `  (${c.detail})` : "";
    console.log(`  ${marque} ${c.nom}${detail}`);
    if (!c.ok) failed++;
  }

  console.log(`\n— Évals du routeur (${EVALS.length}) —`);
  for (const e of EVALS) {
    const { failures, cands } = await runEval(e);
    if (failures.length) {
      failed++;
      console.log(`  ✗ « ${e.query} » — ${e.attendu}`);
      for (const f of failures) console.log(`      ${f}`);
      console.log(`      obtenu : ${cands.map(fmt).join(", ") || "(aucun)"}`);
    } else {
      console.log(`  ✓ « ${e.query} » — ${e.attendu}`);
      if (cands.length) console.log(`      ${cands.slice(0, 4).map(fmt).join(", ")}`);
    }
  }

  console.log(failed ? `\n❌ ${failed} échec(s).` : "\n✅ Tout passe.");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`\n❌ ${e.message}`);
  // DEUX causes produisent le MÊME 404, et les confondre coûte du temps : le serveur
  // absent, et le jeton absent. Depuis le défaut FERMÉ (2026-08-27), un harnais sans
  // jeton reçoit 404 d'un serveur parfaitement vivant — et l'ancien message accusait
  // alors le serveur. On dit laquelle des deux on peut écarter.
  if (/HTTP 404/.test(e.message) && !resolveMcpToken()) {
    console.error("Aucun jeton résolu (ni MCP_TOKEN, ni mcp.token) — et /mcp est FERMÉ");
    console.error("par défaut : sans jeton, un serveur en parfait état répond 404.");
    console.error("  local  : npx wrangler dev --var MCP_TOKEN:… --var MCP_TOKEN_ATHENA:…");
    console.error("           puis MCP_TOKEN=… npm run evals");
    console.error("  distant: poser mcp.token à la racine, ou exporter MCP_TOKEN.");
  } else {
    console.error("Le serveur est-il démarré ? (npx wrangler dev)");
  }
  process.exit(1);
});
