import { readFileSync } from "node:fs";
import { createMcpClient, parseBody, resolveClientToken, resolveMcpToken } from "./mcp-client.mjs";

const MCP_URL = process.env.MCP_URL ?? "http://127.0.0.1:8787/mcp";

const { connect, callTool } = createMcpClient(MCP_URL);

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
    domains: ["core", "travail"],
    attendu: "n-1.1 + contrat de travail du C.c.Q.",
    present: [
      { law: "n-1.1" },
      { law: "ccq", pathPrefix: "ga:l_cinquieme-gb:l_deuxieme-gc:l_septieme" },
    ],
  },
  {
    query: "congédiement",
    attendu: "par défaut (core), contrat de travail du C.c.Q. + radar travail",
    present: [{ law: "ccq", pathPrefix: "ga:l_cinquieme-gb:l_deuxieme-gc:l_septieme" }],
    expectRadar: ["travail"],
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
    query: "assurance responsabilité",
    attendu: "chapitre des assurances du C.c.Q.",
    present: [{ law: "ccq", pathPrefix: "ga:l_cinquieme-gb:l_deuxieme-gc:l_quinzieme" }],
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
    domains: ["core", "construction-immobilier"],
    attendu: "c-73.2",
    present: [{ law: "c-73.2" }],
  },
  {
    query: "déontologie avocat",
    attendu: "b-1-r.3.1 (Code de déontologie) + droit professionnel",
    present: [{ law: "b-1-r.3.1" }],
  },
  {
    query: "residential lease",
    lang: "en",
    attendu: "miroir de « bail de logement » : bloc TAL + chapitre LEASE du C.c.Q.",
    present: [{ law: "ccq", pathPrefix: "ga:l_five-gb:l_two-gc:l_iv" }, { law: "t-15.01" }],
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
    domains: ["core", "travail"],
    attendu: "miroir de « congédiement » : n-1.1 + contract of employment du C.c.Q.",
    present: [{ law: "n-1.1" }, { law: "ccq", pathPrefix: "ga:l_five-gb:l_two-gc:l_vii" }],
  },
  {
    query: "clause non-concurrence fin d'emploi",
    attendu:
      "contrat de travail du C.c.Q. présent ; le secteur financier n'est PAS capté par « fin »",
    present: [{ law: "ccq", pathPrefix: "ga:l_cinquieme-gb:l_deuxieme-gc:l_septieme" }],
    absent: [{ law: "d-9.2" }, { law: "d-9.2-r.20" }],
  },
  {
    query: "perte de l'ouvrage cinq ans entrepreneur",
    attendu:
      "ouvrages immobiliers du C.c.Q. présents (la matière « bâtiment » ne se déclenche plus ici)",
    present: [{ law: "ccq", pathPrefix: "ga:l_cinquieme-gb:l_deuxieme-gc:l_huitieme" }],
  },
  {
    query: "licence d'entrepreneur en construction et cautionnement",
    domains: ["core", "construction-immobilier"],
    attendu: "Code de construction en tête, et la matière « bâtiment » plafonnée à 3 candidats",
    present: [{ law: "b-1.1-r.2" }],
    maxParMatiere: 3,
  },
  {
    query: "pouvoirs de l'AMF",
    domains: ["core", "financier"],
    attendu: "e-6.1, la loi qui crée l'Autorité, présente — elle était ABSENTE avant la scission",
    present: [{ law: "e-6.1" }],
  },
  {
    query: "pouvoirs de l'AMF",
    attendu: "par défaut (core), radar financier signale le coffre financier",
    expectRadar: ["financier"],
  },
  {
    query:
      "plainte contre un représentant en épargne collective devant l'Autorité des marchés financiers",
    domains: ["core", "financier"],
    attendu:
      "les textes de la distribution en tête, devant la Loi sur l'Autorité des marchés PUBLICS",
    top: { law: "d-9.2-r.10" },
    present: [{ law: "d-9.2" }, { law: "d-9.2-r.2" }],
  },
  {
    query: "bail commercial résiliation défaut de payer le loyer",
    attendu:
      "le chapitre GÉNÉRAL du louage en tête ; les lois pénales et la Loi sur la concurrence reculent",
    top: { law: "ccq", pathPrefix: "ga:l_cinquieme-gb:l_deuxieme-gc:l_quatrieme" },
    reculent: [{ law: "c-25.1" }, { law: "c-52.2" }, { law: "ca-c-34" }],
  },
  {
    query: "bail commercial",
    attendu: "le chapitre du louage en tête, devant la Loi sur la concurrence",
    top: { law: "ccq", pathPrefix: "ga:l_cinquieme-gb:l_deuxieme-gc:l_quatrieme" },
    reculent: [{ law: "ca-c-34" }],
  },
  {
    query: "commercial lease resiliation failure to pay rent",
    lang: "en",
    attendu: "miroir de « bail commercial » : le chapitre LEASE du C.c.Q. en tête",
    top: { law: "ccq", pathPrefix: "ga:l_five-gb:l_two-gc:l_iv" },
  },
  {
    query: "prescription trois ans",
    attendu: "ccq / prescription (Livre 8) en tête — « ans » seul ne doit rien emporter",
    top: { law: "ccq", pathPrefix: "ga:l_huitieme" },
  },
  {
    query: "congédiement sans cause juste et suffisante",
    domains: ["core", "travail"],
    attendu: "n-1.1, le recours lui-même, en tête (quatre tokens dans son intitulé)",
    top: { law: "n-1.1", pathPrefix: "ga:l_v-gb:l_iii" },
  },
  {
    query: "hypothèque légale de la construction",
    attendu:
      "le chapitre de l'hypothèque légale présent (cf. la note : il n'est pas encore en tête)",
    present: [{ law: "ccq", pathPrefix: "ga:l_sixieme-gb:l_troisieme-gc:l_troisieme" }],
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
  const args = { query: e.query };
  if (e.lang) args.lang = e.lang;
  if (e.domains) args.domains = e.domains;
  if (e.jurisdiction) args.jurisdiction = e.jurisdiction;
  if (e.forum) args.forum = e.forum;
  const res = await callTool("find_relevant", args);
  const cands = res.structuredContent?.candidates ?? [];
  const failures = [];

  if (e.none) {
    if (!res.isError)
      failures.push(`attendu aucun rapprochement, obtenu ${cands.length} candidat(s)`);
    const txt = res.content?.[0]?.text ?? "";
    if (!/list_subjects/.test(txt)) failures.push("le message n'oriente pas vers list_subjects");
    return { failures, cands };
  }

  if (res.isError) {
    failures.push(`erreur inattendue : ${res.content?.[0]?.text ?? "?"}`);
    return { failures, cands };
  }
  if (e.top && !matches(cands[0] ?? {}, e.top)) {
    failures.push(
      `en tête : attendu ${e.top.law}${e.top.pathPrefix ? `›${e.top.pathPrefix}…` : ""}, obtenu ${cands[0] ? fmt(cands[0]) : "rien"}`,
    );
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
  for (const exp of e.reculent ?? []) {
    const c = cands.find((x) => matches(x, exp));
    const tete = cands[0]?.score ?? 0;
    if (c && c.score >= tete / 2) {
      failures.push(`ne recule pas : ${fmt(c)} contre une tête à ${tete}`);
    }
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
  for (const dom of e.expectRadar ?? []) {
    const radar = res.structuredContent?.other_domains ?? [];
    if (!radar.some((r) => r.domain === dom)) {
      failures.push(`radar attendu pour domaine '${dom}', obtenu ${JSON.stringify(radar)}`);
    }
  }
  return { failures, cands };
}

async function smokeTests() {
  const checks = [];
  const add = (nom, ok, detail = "") => checks.push({ nom, ok, detail });
  const skip = (nom, pourquoi) => checks.push({ nom, ok: true, saute: true, detail: pourquoi });

  const servis = JSON.parse(
    readFileSync(new URL("../pipeline/expected/served.json", import.meta.url), "utf8"),
  ).ids.length;
  const coreLaws = await callTool("list_laws", {});
  const coreCount = coreLaws.structuredContent?.count ?? 0;
  const otherSum = (coreLaws.structuredContent?.other_domains ?? []).reduce(
    (s, r) => s + (r.laws_count ?? r.count ?? 0),
    0,
  );
  add(
    "list_laws : quarantaine core par défaut + radar other_domains",
    coreLaws.structuredContent?.domains_active?.join(",") === "core" &&
      coreCount > 0 &&
      coreCount + otherSum === servis,
    `core=${coreCount}, other=${otherSum}, déclaré=${servis}`,
  );

  const laws = await callTool("list_laws", { domains: ["all"] });
  add(
    `list_laws : ${servis} lois servies (domains=['all'])`,
    laws.structuredContent?.count === servis,
    `count=${laws.structuredContent?.count}, déclaré=${servis}`,
  );
  const ccq = laws.structuredContent?.laws?.find((l) => l.id === "ccq");
  add(
    "list_laws : ccq porte ses Livres (matières)",
    (ccq?.mapped_divisions?.length ?? 0) >= 10,
    `${ccq?.mapped_divisions?.length ?? 0} division(s) mappée(s)`,
  );

  const filtered = await callTool("list_laws", { fonction: "tarif", domains: ["all"] });
  add(
    "list_laws : filtre fonction='tarif'",
    filtered.structuredContent?.count === 4,
    `count=${filtered.structuredContent?.count}`,
  );

  const bySubject = await callTool("list_laws", { subject: "louage-residentiel" });
  add(
    "list_laws : filtre subject='louage-residentiel'",
    (bySubject.structuredContent?.count ?? 0) >= 3,
    `count=${bySubject.structuredContent?.count}`,
  );

  const matieres = JSON.parse(
    readFileSync(new URL("../data/taxonomy.json", import.meta.url), "utf8"),
  ).subjects.length;
  const subs = await callTool("list_subjects", {});
  add(
    `list_subjects : ${matieres} matières (taxonomy.json chargée en base)`,
    subs.structuredContent?.count === matieres,
    `count=${subs.structuredContent?.count}, taxonomy.json=${matieres}` +
      (subs.structuredContent?.count === matieres
        ? ""
        : " — `discovery/load.py --target cloud` a-t-il été rejoué ?"),
  );

  const subsEn = await callTool("list_subjects", { lang: "en" });
  const sansEn = (subsEn.structuredContent?.subjects ?? [])
    .filter((s) => !s.label_en || !s.description_en)
    .map((s) => s.id);
  add(
    `list_subjects (lang=en) : les ${matieres} matières traduites`,
    sansEn.length === 0,
    sansEn.length ? `sans traduction : ${sansEn.slice(0, 5).join(", ")}…` : "",
  );
  const texteEn = subsEn.content?.[0]?.text ?? "";
  const ligneFr = texteEn
    .split("\n")
    .find((l) => /^\s+•/.test(l) && /— (Biens|Personnes|Famille|Preuve|Assurances)\b/.test(l));
  add(
    "list_subjects (lang=en) : les ENTRÉES rendues en anglais",
    !ligneFr && /— Property\b/.test(texteEn) && /law\(s\)/.test(texteEn),
    ligneFr ? `entrée restée en français : ${ligneFr.trim().slice(0, 60)}` : "",
  );
  add(
    "list_subjects (lang=en) : descriptions rendues en anglais",
    /Ownership, co-ownership/.test(texteEn) && !/Propriété, copropriété/.test(texteEn),
  );
  add(
    "list_subjects (lang=en) : en-têtes de groupe en anglais",
    /Private law|Specialized areas/.test(texteEn) && !/Matières spécialisées/.test(texteEn),
  );

  const texteFr = subs.content?.[0]?.text ?? "";
  add(
    "list_subjects (lang=fr) : rendu toujours en français",
    /— Biens\b/.test(texteFr) &&
      /Matières spécialisées/.test(texteFr) &&
      !/— Property\b/.test(texteFr),
  );

  const rel = await callTool("related_laws", { law: "cpc", rel_type: "reglement-de" });
  add(
    "related_laws : cpc a 6 règlements",
    rel.structuredContent?.total === 6,
    `total=${rel.structuredContent?.total}`,
  );

  const bad = await callTool("related_laws", { law: "inexistante" });
  add(
    "related_laws : erreur actionnable si loi inconnue",
    bad.isError === true && /Lois disponibles/.test(bad.content?.[0]?.text ?? ""),
  );

  const relEn = await callTool("related_laws", { law: "c-27.1", lang: "en" });
  const relsEn = relEn.structuredContent?.relations ?? [];
  const c19 = relsEn.find((r) => r.other_id === "c-19");
  add(
    "related_laws (lang=en) : nom de loi en ANGLAIS",
    c19?.other_name === "Cities and Towns Act",
    `other_name=${c19?.other_name}`,
  );
  add(
    "related_laws (lang=en) : note curée marquée [fr] en prose ET en données",
    /\[fr\]/.test(relEn.content?.[0]?.text ?? "") && c19?.note_lang === "fr",
    `note_lang=${c19?.note_lang}`,
  );
  add(
    "related_laws (lang=en) : ossature de la réponse en anglais",
    /relation\(s\) for/.test(relEn.content?.[0]?.text ?? ""),
    (relEn.content?.[0]?.text ?? "").slice(0, 60),
  );
  const relFr = await callTool("related_laws", { law: "c-27.1" });
  add(
    "related_laws (défaut fr) : nom de loi en français, aucune marque [fr]",
    (relFr.structuredContent?.relations ?? []).find((r) => r.other_id === "c-19")?.other_name ===
      "Loi sur les cités et villes" && !/\[fr\]/.test(relFr.content?.[0]?.text ?? ""),
  );

  const lawsEn = await callTool("list_laws", { lang: "en", structure: false, domains: ["all"] });
  const cmEn = lawsEn.structuredContent?.laws?.find((l) => l.id === "c-27.1");
  add(
    "list_laws (lang=en) : libellés de matières en ANGLAIS",
    (cmEn?.subjects ?? []).includes("Municipal Law"),
    `subjects=${JSON.stringify(cmEn?.subjects)}`,
  );
  const lawsFr = await callTool("list_laws", { lang: "fr", structure: false, domains: ["all"] });
  add(
    "list_laws (lang=fr) : libellés de matières en français",
    (lawsFr.structuredContent?.laws?.find((l) => l.id === "c-27.1")?.subjects ?? []).includes(
      "Droit municipal",
    ),
  );

  const toutes = laws.structuredContent?.laws ?? [];
  const cassees = [];
  for (const l of toutes) {
    const r = await callTool("get_articles", { law: l.id, from: "1", to: "3" });
    if (r.isError) cassees.push(l.id);
  }
  add(
    `get_articles : mode plage opérant sur les ${servis} lois servies`,
    cassees.length === 0,
    cassees.length ? `échec sur ${cassees.length} : ${cassees.slice(0, 6).join(", ")}…` : "",
  );

  {
    const r = await callTool("get_articles", { law: "ccq", from: "1", to: "5" });
    const a = r.structuredContent?.articles?.[0];
    add(
      "get_articles : chaque article porte number, text, division_path, repealed",
      !!a &&
        typeof a.number === "string" &&
        a.number.length > 0 &&
        typeof a.text === "string" &&
        a.text.length > 0 &&
        typeof a.division_path === "string" &&
        a.division_path.length > 0 &&
        typeof a.repealed === "boolean",
      `number=${typeof a?.number} text=${typeof a?.text}(${a?.text?.length ?? 0}) ` +
        `path=${typeof a?.division_path} repealed=${typeof a?.repealed}`,
    );
  }

  for (const [law, a, b] of [
    ["ccq-r.8", "15.1", "15.2"],
    ["t-15.01", "31.1", "31.2"],
  ]) {
    for (const lang of ["fr", "en"]) {
      const r = await callTool("get_articles", { law, from: a, to: b, lang });
      const nums = (r.structuredContent?.articles ?? []).map((x) => x.number);
      add(
        `get_articles : plage ${law} ${a}..${b} (${lang}) exacte, sans les voisins à clé partagée`,
        nums.length === 2 && nums[0] === a && nums[1] === b,
        `rendu : [${nums.join(", ")}]`,
      );
      add(
        `get_articles : plage ${law} ${a}..${b} (${lang}) étiquetée 'document'`,
        r.structuredContent?.range_resolution === "document",
        `range_resolution=${r.structuredContent?.range_resolution}`,
      );
    }
  }

  {
    const n = await callTool("get_articles", { law: "ccq", numbers: ["1457", "1590"] });
    add(
      "get_articles : range_resolution présent et null en mode numbers[]",
      "range_resolution" in (n.structuredContent ?? {}) &&
        n.structuredContent.range_resolution === null,
      `range_resolution=${JSON.stringify(n.structuredContent?.range_resolution)}`,
    );
    const o = await callTool("get_articles", { law: "ccq", from: "1", to: "9999" });
    add(
      "get_articles : borne ouverte étiquetée 'cle' (repli sur la clé de tri)",
      o.structuredContent?.range_resolution === "cle",
      `range_resolution=${o.structuredContent?.range_resolution}`,
    );
    const p = await callTool("get_articles", {
      law: "ccq",
      from: "préliminaire",
      to: "3",
    });
    add(
      "get_articles : pseudo-article en borne étiqueté 'cle'",
      p.structuredContent?.range_resolution === "cle",
      `range_resolution=${p.structuredContent?.range_resolution}`,
    );
  }

  {
    const one = await callTool("get_article", { law: "a-2.1", article: "26" });
    add(
      "get_article : un article abrogé est marqué abrogé, en données ET en prose",
      one.structuredContent?.repealed === true && /abrog/i.test(one.content?.[0]?.text ?? ""),
      `a-2.1 art. 26 : repealed=${one.structuredContent?.repealed} ` +
        `prose=${/abrog/i.test(one.content?.[0]?.text ?? "")}`,
    );
  }

  {
    const st = await callTool("get_structure", { law: "ccq" });
    const tree = st.structuredContent?.tree;
    const profondeur = (ns, d = 1) =>
      ns.reduce((m, n) => Math.max(m, n.children?.length ? profondeur(n.children, d + 1) : d), 0);
    const ok2 = Array.isArray(tree) && tree.length > 0 && profondeur(tree) > 1;
    add(
      "get_structure : l'arbre a plus d'un niveau (parent_id non perdu)",
      ok2,
      `racines=${Array.isArray(tree) ? tree.length : "?"} profondeur=${
        Array.isArray(tree) ? profondeur(tree) : "?"
      }`,
    );
  }

  const profond = "ga:l_cinquieme-gb:l_premier-gc:l_troisieme-gd:l_i-ge:l_1";
  const div = await callTool("get_division", { law: "ccq", path: profond });
  add(
    "get_division : chemin profond (55 car.) sans erreur D1",
    div.isError !== true,
    div.isError ? (div.content?.[0]?.text ?? "").slice(0, 90) : "",
  );
  const stru = await callTool("get_structure", { law: "ccq", root_path: profond });
  add(
    "get_structure : root_path profond sans erreur D1",
    stru.isError !== true,
    stru.isError ? (stru.content?.[0]?.text ?? "").slice(0, 90) : "",
  );

  const t16 = await callTool("resolve_reference", {
    citation: "RLRQ, c. T-16, art. 12",
  });
  add(
    "resolve_reference : chapitre RLRQ correctement reconnu",
    t16.structuredContent?.resolved?.law === "t-16" &&
      t16.structuredContent?.resolved?.number === "12",
    `obtenu ${t16.structuredContent?.resolved?.law}/${t16.structuredContent?.resolved?.number}`,
  );
  const ccqRef = await callTool("resolve_reference", { citation: "art. 1457 C.c.Q." });
  add(
    "resolve_reference : abréviation C.c.Q. toujours reconnue",
    ccqRef.structuredContent?.resolved?.law === "ccq" &&
      ccqRef.structuredContent?.resolved?.number === "1457",
    `obtenu ${ccqRef.structuredContent?.resolved?.law}/${ccqRef.structuredContent?.resolved?.number}`,
  );

  const sansDate = toutes.filter((l) => !l.consol_date_fr).map((l) => l.id);
  add(
    `list_laws : date de consolidation sur les ${servis} lois servies`,
    sansDate.length === 0,
    sansDate.length ? `manquante sur ${sansDate.length} : ${sansDate.slice(0, 5).join(", ")}…` : "",
  );

  const enLaws = await callTool("list_laws", { lang: "en" });
  const ccqEn = enLaws.structuredContent?.laws?.find((l) => l.id === "ccq");
  const premier = ccqEn?.mapped_divisions?.[0];
  const ouvrable = premier
    ? await callTool("get_division", {
        law: "ccq",
        lang: "en",
        path: premier.division_path,
        include_text: false,
      })
    : { isError: true };
  add(
    "list_laws (lang=en) : chemins de divisions ouvrables en anglais",
    ouvrable.isError !== true && !!premier?.heading,
    premier ? `${premier.division_path} / ${premier.heading}` : "aucune division mappée",
  );

  const horsCorpus = await callTool("resolve_reference", {
    citation: "RLRQ, c. C-73.3, art. 5",
  });
  add(
    "resolve_reference : chapitre hors corpus refusé, pas rabattu sur un voisin",
    horsCorpus.isError === true,
    horsCorpus.isError ? "" : `résolu à tort en ${horsCorpus.structuredContent?.resolved?.law}`,
  );

  for (const [cite, attendu] of [
    ["RLRQ, c. B-1.1, art. 5", "b-1.1"],
    ["RLRQ, c. B-1, art. 5", "b-1"],
    ["RLRQ, c. E-6.1, art. 1", "e-6.1"],
    ["RLRQ, c. E-6, art. 1", "e-6"],
    ["RLRQ, c. C-65.1, art. 1", "c-65.1"],
    ["RLRQ, c. C-65.01, art. 1", "c-65.01"],
  ]) {
    const r = await callTool("resolve_reference", { citation: cite });
    add(
      `resolve_reference : « ${cite.replace("RLRQ, c. ", "")} » -> ${attendu}`,
      r.structuredContent?.resolved?.law === attendu,
      `obtenu ${r.structuredContent?.resolved?.law ?? "(refus)"}`,
    );
  }

  const marqueurA = await callTool("resolve_reference", {
    citation: "Loi sur les tribunaux judiciaires (chapitre T-16), a. 12",
  });
  add(
    "resolve_reference : marqueur « a. » et chapitre non confondu avec l'article",
    marqueurA.structuredContent?.resolved?.law === "t-16" &&
      marqueurA.structuredContent?.resolved?.number === "12",
    `obtenu ${marqueurA.structuredContent?.resolved?.law}/${marqueurA.structuredContent?.resolved?.number}`,
  );

  const frEn = await callTool("find_relevant", {
    query: "residential lease",
    lang: "en",
  });
  const s1 = (frEn.structuredContent?.candidates ?? []).find((c) => c.division_path);
  add(
    "find_relevant (lang=en) : pas de chemin français dans une réponse anglaise",
    !s1 || !/l_(premier|deuxieme|troisieme|quatrieme|cinquieme|sixieme)/.test(s1.division_path),
    s1 ? s1.division_path : "aucun candidat de division",
  );

  const widen = await callTool("search_text", { query: "extranéité", law: "b-9" });
  add(
    "v2 1.1 : élargissement corpus sur zéro résultat (étiqueté)",
    widen.isError !== true &&
      /Aucun résultat dans b-9/.test(widen.content?.[0]?.text ?? "") &&
      (widen.structuredContent?.results ?? []).some(
        (r) => r.law_id === "cpc" && r.number === "490",
      ),
    (widen.content?.[0]?.text ?? "").slice(0, 60),
  );

  const scoped = await callTool("search_text", { query: "extranéité", law: "ccq" });
  add(
    "v2 1.1 : aperçu « ailleurs au corpus » sur recherche restreinte avec résultats",
    scoped.structuredContent?.fallback === null &&
      (scoped.structuredContent?.results ?? []).every((r) => r.law_id === "ccq") &&
      (scoped.structuredContent?.elsewhere?.results ?? []).some(
        (r) => r.law_id === "cpc" && r.number === "490",
      ),
  );

  const fond = await callTool("search_text", {
    query: "signification hors du Québec délai",
    law: "cpc",
  });
  const fondTop5 = (fond.structuredContent?.results ?? []).slice(0, 5);
  add(
    "v2 1.2/2.4 : cas fondateur — cpc 490 top 5, chemin étiqueté (LOO ou sémantique)",
    (/terme ignoré : « hors »/.test(fond.content?.[0]?.text ?? "") ||
      /repérage sémantique/.test(fond.content?.[0]?.text ?? "")) &&
      fondTop5.some((r) => r.law_id === "cpc" && r.number === "490"),
    fondTop5.map((r) => `${r.law_id}|${r.number}`).join(", "),
  );

  const flexion = await callTool("search_text", {
    query: "vice caché garantie qualité",
    limit: 5,
  });
  const flexTop3 = (flexion.structuredContent?.results ?? []).slice(0, 3);
  add(
    "repérage : un leave-one-out d'un seul résultat ne masque plus le OU (ccq 1726 top 3)",
    flexion.structuredContent?.fallback === "or_relax" &&
      flexTop3.some((r) => r.law_id === "ccq" && r.number === "1726"),
    `${flexion.structuredContent?.fallback} — ${flexTop3.map((r) => `${r.law_id}|${r.number}`).join(", ")}`,
  );

  const sc = flexion.structuredContent ?? {};
  add(
    "repérage : `returned` et `sources` rendent `total` interprétable",
    sc.returned === (sc.results ?? []).length &&
      sc.sources?.lexical + sc.sources?.semantique === sc.returned,
    `total=${sc.total} returned=${sc.returned} sources=${JSON.stringify(sc.sources)}`,
  );

  const absurde = await callTool("search_text", { query: "zzz qqq" });
  add("v2 1.2 : requête absurde échoue proprement", absurde.isError === true);

  const presc = await callTool("search_text", { query: "prescription" });
  const prescText = presc.content?.[0]?.text ?? "";
  add(
    "v2 1.3 : fil d'Ariane + ID machine dans les résultats",
    /C\.c\.Q\. — Livre HUITIÈME/.test(prescText) && /\[ga:l_huitieme/.test(prescText),
  );
  add(
    "v2 1.3 : recherche corpus groupée par loi (≥ 2 groupes)",
    (prescText.match(/^— .+ \(\d+/gm) ?? []).length >= 2,
    `${(prescText.match(/^— .+ \(\d+/gm) ?? []).length} groupe(s)`,
  );
  const unSnippet = (presc.structuredContent?.results ?? [])[0]?.snippet ?? "";
  add(
    "v2 1.3 : extraits élargis (≥ 25 tokens)",
    unSnippet.split(/\s+/).length >= 25,
    `${unSnippet.split(/\s+/).length} tokens`,
  );

  const lls = await callTool("list_laws", {});
  add(
    "v2 1.4 : list_laws expose Livre V + Titre IV (droit international privé) du cpc",
    /LES DEMANDES INTÉRESSANT LE DROIT INTERNATIONAL PRIVÉ \[ga:l_v-gb:l_iv\]/.test(
      lls.content?.[0]?.text ?? "",
    ),
  );
  const llsSans = await callTool("list_laws", { structure: false });
  add("v2 1.4 : structure=false coupe le plan", !/▸ Livre/.test(llsSans.content?.[0]?.text ?? ""));

  const pont = await callTool("get_division", {
    law: "ccq",
    path: "ga:l_cinquieme-gb:l_deuxieme-gc:l_septieme",
    lang: "en",
    include_text: false,
  });
  add(
    "v2 1.5 : chemin FR accepté sous lang=en (CONTRACT OF EMPLOYMENT)",
    pont.isError !== true && /CONTRACT OF EMPLOYMENT/.test(pont.content?.[0]?.text ?? ""),
  );

  const sem = await callTool("search_text", {
    query: "defendant outside Quebec time to answer",
  });
  add(
    "v2 2.3 : cas 19 — requête EN trouve cpc 490 (pont sémantique)",
    (sem.structuredContent?.results ?? []).some((r) => r.law_id === "cpc" && r.number === "490"),
    (sem.structuredContent?.results ?? [])
      .slice(0, 5)
      .map((r) => `${r.law_id}|${r.number}`)
      .join(", "),
  );
  add(
    "v2 2.3 : chemin sémantique étiqueté (R7 : fail open, dit)",
    /repérage sémantique/.test(sem.content?.[0]?.text ?? "") ||
      sem.structuredContent?.fallback === "semantic",
  );

  const lex = await callTool("search_text", { query: "extranéité" });
  add(
    "v2 2.3 : requête lexicale — le 1er résultat reste la correspondance exacte",
    (lex.structuredContent?.results ?? [])[0]?.number !== undefined &&
      ["3111", "490", "622"].includes((lex.structuredContent?.results ?? [])[0]?.number),
  );

  const jeton = resolveMcpToken();
  const jetonVeille = resolveClientToken("veille");
  if (jeton) {
    const bare = new URL(MCP_URL);
    bare.pathname = "/mcp";
    bare.search = "";
    const INIT = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "gate", version: "1" },
      },
    };
    const sonder = async (u, entetes) => {
      const res = await fetch(u, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...entetes,
        },
        body: JSON.stringify(INIT),
      });
      await res.text().catch(() => "");
      return res.status;
    };
    const probe = (u, auth) => sonder(u, auth ? { Authorization: `Bearer ${jeton}` } : {});
    const probeBearer = (u, porteur) => sonder(u, { Authorization: `Bearer ${porteur}` });

    const refus = await probe(bare, false);
    add("accès : POST sans jeton -> 404 (pas 401)", refus === 404, `status=${refus}`);

    for (const [nom, u, auth] of [
      ["en-tête Bearer", `${bare}`, true],
      ["segment de chemin", `${bare}/${jeton}`, false],
      ["segment + slash final", `${bare}/${jeton}/`, false],
      ["paramètre ?key=", `${bare}?key=${jeton}`, false],
    ]) {
      const code = await probe(u, auth);
      add(`accès : ${nom} -> 200`, code === 200, `status=${code}`);
    }

    {
      const code = await probeBearer(`${bare}/`, jeton);
      add(
        "accès : /mcp/ nu + Bearer -> 200 (slash final toléré PARTOUT)",
        code === 200,
        `status=${code}`,
      );
    }

    {
      const faux = jeton.slice(0, -1) + (jeton.endsWith("0") ? "1" : "0");
      const code = await probe(`${bare}?key=${faux}`, false);
      add(
        "accès : jeton FAUX (même longueur, un octet près) -> 404",
        code === 404,
        `status=${code}`,
      );
    }

    if (jetonVeille) {
      for (const [nom, u, auth] of [
        ["en-tête Bearer", `${bare}`, jetonVeille],
        ["paramètre ?key=", `${bare}?key=${jetonVeille}`, null],
      ]) {
        const code = auth ? await probeBearer(u, auth) : await probe(u, false);
        add(`accès : 2e jeton (veille) par ${nom} -> 200`, code === 200, `status=${code}`);
      }
    } else {
      skip(
        "accès : 2e jeton (veille) -> 200",
        "aucun jeton de client secondaire ici (ni MCP_TOKEN_VEILLE, ni mcp-veille.token)",
      );
    }

    {
      const porteur = jetonVeille ?? jeton;
      const quel = jetonVeille ? "jeton veille" : "jeton principal, faute de mieux";
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
      add(
        `état (${quel}) : initialize -> 200, et AUCUNE session ouverte`,
        ini.status === 200 && !sid,
        `status=${ini.status} session=${sid ? `ÉMISE (${sid}) — le transport a repris un état` : "aucune, comme attendu"}`,
      );

      const msgIni =
        ini.status === 200 ? parseBody(txtIni, ini.headers.get("content-type") ?? "") : null;
      add(
        "état : initialize rend un résultat JSON-RPC nommant le serveur",
        !!msgIni?.result?.serverInfo?.name,
        `serverInfo=${JSON.stringify(msgIni?.result?.serverInfo ?? null)}`,
      );

      const notif = await post(
        { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
        sid,
      );
      await notif.text().catch(() => "");
      add(
        "état : notifications/initialized -> 2xx",
        notif.status >= 200 && notif.status < 300,
        `status=${notif.status}`,
      );

      let getCode;
      try {
        const g = await fetch(`${bare}?_cb=${Date.now()}`, {
          method: "GET",
          headers: entetes(sid),
          signal: AbortSignal.timeout(5000),
        });
        getCode = g.status;
        await g.body?.cancel();
      } catch (e) {
        getCode = `abandon (${e.name})`;
      }
      add(
        "état : GET /mcp porteur n'est PAS refusé par la porte (ni 404 ni 401)",
        getCode !== 404 && getCode !== 401 && typeof getCode === "number",
        `status=${getCode}`,
      );

      const del = await fetch(bare, { method: "DELETE", headers: entetes(sid) });
      await del.text().catch(() => "");
      add(
        "état : DELETE /mcp (fermeture) n'est PAS refusé par la porte (ni 404 ni 401)",
        del.status !== 404 && del.status !== 401,
        `status=${del.status}`,
      );
      console.log(
        `      (transport : GET -> ${getCode}, DELETE -> ${del.status} — mesure, ` +
          "pas exigence : c'est le routeur du socle qui répond)",
      );
    }

    {
      const code = await fetch(bare, {
        method: "GET",
        headers: { Accept: "text/event-stream" },
        signal: AbortSignal.timeout(5000),
      })
        .then((r) => {
          r.body?.cancel();
          return r.status;
        })
        .catch((e) => `abandon (${e.name})`);
      add(
        "accès : GET sans jeton -> 404 (comportement VOULU, cf. CLAUDE.md)",
        code === 404,
        `status=${code}`,
      );
    }
  } else {
    skip("accès : bloc entier", "aucun jeton résolu ici (ni MCP_TOKEN, ni mcp.token)");
  }

  {
    const racine = new URL(MCP_URL);
    racine.pathname = "/";
    racine.search = "";
    const res = await fetch(racine, { headers: { Accept: "text/html" } });
    const html = await res.text();
    add(
      "page : GET / -> 200 text/html",
      res.status === 200 && /text\/html/.test(res.headers.get("content-type") ?? ""),
      `status=${res.status} type=${res.headers.get("content-type")}`,
    );

    const rows = (html.match(/data-law-id="/g) ?? []).length;
    add(
      "page : autant de lois affichées que list_laws en déclare",
      rows === laws.structuredContent?.count,
      `page=${rows} list_laws=${laws.structuredContent?.count}`,
    );

    add(
      "page : aucune forme de jeton dans le HTML",
      !/Bearer\s|[?&]key=|[0-9a-f]{32,}/i.test(html),
      "motif de jeton détecté dans la page publique",
    );

    const ancres = [...html.matchAll(/href="#([a-z]+)"/g)]
      .map((m) => m[1])
      .filter((a) => a !== "top");
    const sections = [...html.matchAll(/<section id="([a-z]+)"/g)].map((m) => m[1]);
    const orphelines = ancres.filter((a) => !sections.includes(a));
    add(
      "page : chaque entrée du sommaire pointe vers une section qui existe",
      ancres.length > 0 && orphelines.length === 0,
      `ancres=${ancres.length} sans cible=[${orphelines}]`,
    );

    const dansLOrdre = sections.filter((s) => ancres.includes(s));
    add(
      "page : l'ordre du sommaire est celui du document",
      JSON.stringify(ancres) === JSON.stringify(dansLOrdre),
      `sommaire=[${ancres}] document=[${dansLOrdre}]`,
    );

    add(
      "page : l'avertissement et la clause de non-conseil sont rendus",
      /<section id="limites"/.test(html) &&
        /Aucun conseil juridique/.test(html) &&
        /No legal advice/.test(html),
      "avertissement ou clause de non-conseil absent du HTML servi",
    );
  }

  return checks;
}

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
  if (/HTTP 404/.test(e.message) && !resolveMcpToken()) {
    console.error("Aucun jeton résolu (ni MCP_TOKEN, ni mcp.token) — et /mcp est FERMÉ");
    console.error("par défaut : sans jeton, un serveur en parfait état répond 404.");
    console.error("  local  : npx wrangler dev --var MCP_TOKEN:… --var MCP_TOKEN_VEILLE:…");
    console.error("           puis MCP_TOKEN=… npm run evals");
    console.error("  distant: poser mcp.token à la racine, ou exporter MCP_TOKEN.");
  } else {
    console.error("Le serveur est-il démarré ? (npx wrangler dev)");
  }
  process.exit(1);
});
