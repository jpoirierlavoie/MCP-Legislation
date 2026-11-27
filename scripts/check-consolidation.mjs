import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createMcpClient } from "../eval/mcp-client.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const MCP_URL = process.env.MCP_URL || "https://legislation.poirierlavoie.ca/mcp";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
const CONCURRENCY = 8;
const TIMEOUT_MS = 20_000;
export const UNREACHABLE_ALERT_RATIO = 0.25;

export const FR_MONTHS = {
  janvier: 1,
  février: 2,
  mars: 3,
  avril: 4,
  mai: 5,
  juin: 6,
  juillet: 7,
  août: 8,
  septembre: 9,
  octobre: 10,
  novembre: 11,
  décembre: 12,
};

export function extractConsolidation(html) {
  const cleaned = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const textEnd = /<div[^>]*class="[^"]*\btext-end\b[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
  let block;
  while ((block = textEnd.exec(cleaned)) !== null) {
    const text = block[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const m = text.match(/jour au\s*(\d{1,2})\s*(?:er)?\s*([A-Za-zÀ-ÿ]+)\s*(\d{4})/i);
    if (m && FR_MONTHS[m[2].toLowerCase()]) {
      const mm = String(FR_MONTHS[m[2].toLowerCase()]).padStart(2, "0");
      const dd = String(Number(m[1])).padStart(2, "0");
      return `${m[3]}-${mm}-${dd}`;
    }
  }
  return null;
}

const DATE_FEDERALE = /(?:jour|current\s+to)\s*(\d{4}-\d{2}-\d{2})/i;

export function extractConsolidationFederale(html) {
  const cleaned = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const bloc = cleaned.match(/<p[^>]*\bid=['"]assentedDate['"][^>]*>([\s\S]*?)<\/p>/i);
  if (!bloc) return null;
  const text = bloc[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const m = text.match(DATE_FEDERALE);
  return m ? m[1] : null;
}

async function fetchLiveDate(url, extracteur) {
  if (!url)
    return { status: "injoignable", note: "URL de consolidation absente de laws.config.json" };
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { status: "injoignable", note: `HTTP ${res.status}` };
    const date = extracteur(await res.text());
    if (date) return { status: "ok", date };
    return { status: "illisible", note: "page atteinte (200) mais date « À jour au » introuvable" };
  } catch (e) {
    return { status: "injoignable", note: e.name === "TimeoutError" ? "délai dépassé" : "réseau" };
  }
}

export function isCloudflare403(status, headers, bodyText = "") {
  if (status !== 403) return false;
  const cfMitigated = headers?.get?.("cf-mitigated") ?? headers?.["cf-mitigated"] ?? "";
  if (String(cfMitigated).toLowerCase() === "challenge") return true;
  return /Just a moment|cf-browser-verification|_cf_chl_opt|cType:\s*['"]managed['"]/i.test(
    bodyText,
  );
}

export function sha256HexBytes(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

export function parsePdfHeader(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const head = Buffer.from(bytes.subarray(0, 16)).toString("latin1");
  if (!head.startsWith("%PDF-")) return { valid: false, modDate: null };
  const text = Buffer.from(bytes).toString("latin1");
  const m = text.match(/\/ModDate\s*\(D:(\d{4})(\d{2})(\d{2})/i);
  const modDate = m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  return { valid: true, modDate };
}

export function extractPdfIndexDrift(html, { expectedFilename, baseUrl } = {}) {
  const cleaned = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const links = [];
  const anchorRe = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = anchorRe.exec(cleaned)) !== null) {
    const rawHref = m[1].trim();
    if (!/\.pdf(?:[?#].*)?$/i.test(rawHref)) continue;
    let resolved = rawHref;
    if (baseUrl) {
      try {
        resolved = new URL(rawHref, baseUrl).href;
      } catch {}
    }
    links.push(resolved);
  }
  const plain = cleaned.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const dm = plain.match(/jour au\s*(\d{1,2})\s*(?:er)?\s*([A-Za-zÀ-ÿ]+)\s*(\d{4})/i);
  let liveDate = null;
  if (dm && FR_MONTHS[dm[2].toLowerCase()]) {
    const mm = String(FR_MONTHS[dm[2].toLowerCase()]).padStart(2, "0");
    const dd = String(Number(dm[1])).padStart(2, "0");
    liveDate = `${dm[3]}-${mm}-${dd}`;
  }
  if (links.length === 0) {
    return {
      status: "illisible",
      links,
      matchedUrl: null,
      liveDate,
      note: "page d'index atteinte (200) mais aucun lien .pdf trouvé",
    };
  }
  if (expectedFilename) {
    const cible = expectedFilename.toLowerCase();
    const cleanPaths = links.map((u) => {
      const rawPath = u.split(/[?#]/)[0];
      let decoded;
      try {
        decoded = decodeURIComponent(rawPath);
      } catch {
        decoded = rawPath;
      }
      return {
        u,
        cleanPath: decoded.toLowerCase(),
      };
    });
    const matchedUrl =
      cleanPaths.find(({ cleanPath }) => cleanPath.endsWith(`/${cible}`) || cleanPath === cible)
        ?.u ??
      cleanPaths.find(({ cleanPath }) => cleanPath.includes(cible))?.u ??
      null;
    if (!matchedUrl) {
      return {
        status: "ok",
        shaDrift: true,
        links,
        matchedUrl: links[0],
        liveDate,
        note: `lien PDF attendu (${expectedFilename}) absent ou remplacé sur la page d'index`,
      };
    }
    return { status: "ok", shaDrift: false, links, matchedUrl, liveDate };
  }
  return { status: "ok", shaDrift: false, links, matchedUrl: links[0], liveDate };
}

export function checkPdfBuffer(buf, { expectedSha256, storedDate } = {}) {
  const { valid, modDate } = parsePdfHeader(buf);
  if (!valid) {
    return { status: "illisible", note: "réponse 200 non-PDF (en-tête %PDF- absent)" };
  }
  if (!expectedSha256) {
    return {
      status: "illisible",
      date: storedDate ?? null,
      shaDrift: false,
      note: "empreinte SHA-256 attendue absente du profil PDF",
    };
  }
  const actual = sha256HexBytes(buf);
  if (actual !== expectedSha256.toLowerCase()) {
    return {
      status: "ok",
      date: storedDate ?? null,
      shaDrift: true,
      note: `empreinte SHA-256 modifiée (${actual.slice(0, 12)}… ≠ ${expectedSha256.slice(0, 12)}…)`,
    };
  }
  return {
    status: "ok",
    date: storedDate ?? null,
    shaDrift: false,
    note: modDate ? `ModDate PDF : ${modDate}` : null,
  };
}

export function loadPdfProfilePins(root = ROOT) {
  const dir = join(root, "pipeline", "pdf_profiles");
  const pins = new Map();
  if (!existsSync(dir)) return pins;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const prof = JSON.parse(readFileSync(join(dir, name), "utf8"));
    if (prof?.law_id && prof?.files) pins.set(prof.law_id, prof.files);
  }
  return pins;
}

export async function fetchLivePdf(url, pin, storedDate, fetchImpl = fetch, _depth = 0) {
  if (!url)
    return { status: "injoignable", note: "URL de consolidation absente de laws.config.json" };
  try {
    const res = await fetchImpl(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 403) {
      const bodyText = await res.text().catch(() => "");
      const cf = isCloudflare403(res.status, res.headers, bodyText);
      return {
        status: "injoignable",
        note: cf ? "Cloudflare 403 (challenge WAF — vérification manuelle requise)" : "HTTP 403",
      };
    }
    if (!res.ok) return { status: "injoignable", note: `HTTP ${res.status}` };
    const buf = new Uint8Array(await res.arrayBuffer());
    const ct = (res.headers?.get?.("content-type") ?? "").toLowerCase();
    const looksHtml =
      ct.includes("text/html") ||
      (!url.toLowerCase().split(/[?#]/)[0].endsWith(".pdf") &&
        !Buffer.from(buf.subarray(0, 8)).toString("latin1").startsWith("%PDF-"));
    if (looksHtml) {
      if (_depth >= 1) {
        return {
          status: "illisible",
          note: "réponse 200 HTML/non-PDF après suivi de lien d'index (en-tête %PDF- absent)",
        };
      }
      const html = Buffer.from(buf).toString("utf8");
      const idx = extractPdfIndexDrift(html, {
        expectedFilename: pin?.filename,
        baseUrl: url,
      });
      if (idx.status !== "ok" || idx.shaDrift) {
        return {
          status: idx.status,
          date: storedDate ?? null,
          shaDrift: Boolean(idx.shaDrift),
          note: idx.note ?? null,
        };
      }
      if (idx.matchedUrl) {
        return await fetchLivePdf(idx.matchedUrl, pin, storedDate, fetchImpl, _depth + 1);
      }
    }
    return checkPdfBuffer(buf, { expectedSha256: pin?.sha256, storedDate });
  } catch (e) {
    return { status: "injoignable", note: e.name === "TimeoutError" ? "délai dépassé" : "réseau" };
  }
}

export function classify(checks) {
  const retard = [],
    anomalie = [],
    sansStockee = [],
    illisible = [],
    injoignable = [];
  for (const c of checks) {
    if (c.status === "injoignable") {
      injoignable.push(c);
      continue;
    }
    if (c.status === "illisible") {
      illisible.push(c);
      continue;
    }
    if (c.shaDrift) {
      retard.push(c);
      continue;
    }
    if (c.stored == null) {
      sansStockee.push(c);
      continue;
    }
    if (c.live > c.stored) retard.push(c);
    else if (c.live < c.stored) anomalie.push(c);
  }
  return { retard, anomalie, sansStockee, illisible, injoignable };
}

export function computeDrift({
  retard,
  anomalie,
  sansStockee,
  illisible,
  sansLangue,
  injoignable,
  total,
}) {
  const unreachableRatio = total ? injoignable.length / total : 0;
  const unreachableAlert = unreachableRatio >= UNREACHABLE_ALERT_RATIO;
  const actionable =
    retard.length + anomalie.length + sansStockee.length + illisible.length + sansLangue.length;
  return { drift: actionable > 0, unreachableRatio, unreachableAlert };
}

async function pool(items, size, worker) {
  let i = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx]);
    }
  });
  await Promise.all(runners);
}

const EXTRACTEURS = {
  legisquebec: extractConsolidation,
  justice: extractConsolidationFederale,
  pdf: checkPdfBuffer,
};
export const NOM_PUBLIEUR = {
  legisquebec: "LégisQuébec",
  justice: "Justice Canada",
  pdf: "Sources PDF (QCCS/QCCQ/AMF)",
};

export function agregeParSeau(checks, sansLangue = []) {
  const seaux = new Map();
  for (const nom of Object.keys(EXTRACTEURS)) {
    const lot = checks.filter((c) => c.publieur === nom);
    const lotSansLangue = sansLangue.filter((c) => c.publieur === nom);
    if (!lot.length && !lotSansLangue.length) continue;
    const parts = classify(lot);
    const arg = { ...parts, sansLangue: lotSansLangue, total: lot.length };
    seaux.set(nom, { ...arg, ...computeDrift(arg) });
  }
  const vals = [...seaux.values()];
  return {
    seaux,
    drift: vals.some((s) => s.drift),
    unreachableAlert: vals.some((s) => s.unreachableAlert),
    bloquees: [...seaux.entries()]
      .filter(([, s]) => s.unreachableAlert)
      .map(([nom]) => NOM_PUBLIEUR[nom]),
  };
}

async function main() {
  const config = JSON.parse(readFileSync(join(ROOT, "data", "laws.config.json"), "utf8"));

  const sources = new Map(
    config.laws.map((l) => [
      l.id,
      l.source === "pdf"
        ? { urls: l.consolidation_source || {}, publieur: "pdf" }
        : l.consolidation_source
          ? { urls: l.consolidation_source, publieur: "legisquebec" }
          : { urls: l.official_source || {}, publieur: "justice" },
    ]),
  );
  const pdfPins = loadPdfProfilePins(ROOT);

  const mcp = createMcpClient(MCP_URL);
  await mcp.connect();
  const res = await mcp.callTool("list_laws", { domains: ["all"] });
  const laws = res?.structuredContent?.laws;
  if (!Array.isArray(laws) || laws.length === 0) {
    throw new Error(`list_laws n'a renvoyé aucune loi (endpoint ${MCP_URL} injoignable ?)`);
  }

  const checks = [];
  const sansLangue = [];
  for (const law of laws) {
    const src = sources.get(law.id) || { urls: {}, publieur: "legisquebec" };
    const langs = Array.isArray(law.langs) ? law.langs : [];
    if (langs.length === 0) {
      sansLangue.push({
        id: law.id,
        name: law.name_fr || law.name_en || law.id,
        publieur: src.publieur,
      });
      continue;
    }
    for (const lang of langs) {
      checks.push({
        id: law.id,
        name: law.name_fr || law.name_en || law.id,
        lang,
        stored: law[`consol_date_${lang}`] ?? null,
        url: src.urls[lang] ?? null,
        publieur: src.publieur,
      });
    }
  }
  if (checks.length === 0 && sansLangue.length === 0) {
    throw new Error("aucun couple (loi, langue) construit — forme de list_laws inattendue ?");
  }

  await pool(checks, CONCURRENCY, async (c) => {
    const res =
      c.publieur === "pdf"
        ? await fetchLivePdf(c.url, pdfPins.get(c.id)?.[c.lang], c.stored)
        : await fetchLiveDate(c.url, EXTRACTEURS[c.publieur]);
    c.status = res.status;
    c.live = res.date ?? null;
    c.note = res.note ?? null;
    if (res.shaDrift) c.shaDrift = true;
  });

  const { seaux, drift, unreachableAlert, bloquees } = agregeParSeau(checks, sansLangue);

  const cat = (cle) => [...seaux.values()].flatMap((s) => s[cle]);
  const retard = cat("retard"),
    anomalie = cat("anomalie"),
    sansStockee = cat("sansStockee");
  const illisible = cat("illisible"),
    injoignable = cat("injoignable");
  const total = checks.length;
  const unreachableRatio = total ? injoignable.length / total : 0;

  const report = buildReport({
    total,
    laws: laws.length,
    retard,
    anomalie,
    sansStockee,
    illisible,
    sansLangue,
    injoignable,
    unreachableRatio,
    unreachableAlert,
    seaux,
  });
  writeFileSync(join(ROOT, "consolidation-report.md"), report, "utf8");

  console.log(`Vérifié : ${laws.length} lois, ${total} couples (loi, langue).`);
  console.log(`  en retard          : ${retard.length}`);
  console.log(`  anomalies          : ${anomalie.length}`);
  console.log(`  sans date stockée  : ${sansStockee.length}`);
  console.log(`  page illisible     : ${illisible.length}`);
  console.log(`  loi sans langue    : ${sansLangue.length}`);
  console.log(
    `  injoignables réseau: ${injoignable.length} (${(unreachableRatio * 100).toFixed(0)} %)`,
  );
  for (const [nom, s] of seaux) {
    console.log(
      `  — ${NOM_PUBLIEUR[nom]} : ${s.total} couples, ` +
        `${s.injoignable.length} injoignables (${(s.unreachableRatio * 100).toFixed(0)} %), ` +
        `dérive ${s.drift ? "OUI" : "non"}, alerte réseau ${s.unreachableAlert ? "OUI" : "non"}`,
    );
  }
  console.log(`  => dérive corpus   : ${drift ? "OUI" : "non"}`);
  console.log(
    `  => alerte réseau   : ${unreachableAlert ? "OUI" : "non"}` +
      (bloquees.length ? ` (${bloquees.join(" et ")})` : ""),
  );
  for (const c of retard)
    console.log(`    RETARD ${c.id}/${c.lang} : D1 ${c.stored} < live ${c.live}`);
  for (const c of illisible) console.log(`    ILLISIBLE ${c.id}/${c.lang} : ${c.note}`);

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `drift=${drift}\nunreachable=${unreachableAlert}\n` +
        `sources_bloquees=${bloquees.join(" et ")}\n`,
    );
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
  }
}

function buildReport(d) {
  const {
    total,
    laws,
    retard,
    anomalie,
    sansStockee,
    illisible,
    sansLangue,
    injoignable,
    unreachableRatio,
    unreachableAlert,
    seaux,
  } = d;
  const stamp = `${new Date().toISOString().replace("T", " ").slice(0, 16)} UTC`;
  const pub = (c) => NOM_PUBLIEUR[c.publieur] ?? "?";
  const rows = (list) =>
    list
      .map(
        (c) =>
          `| ${c.id} | ${c.lang} | ${pub(c)} | ${c.stored ?? "—"} | ${c.live ?? "—"} | ${(c.name || "").replace(/\|/g, "/")} |`,
      )
      .join("\n");
  const dateTable = (title, list) =>
    list.length
      ? `\n### ${title}\n\n| Loi | Langue | Publieur | D1 (chargé) | Source (live) | Titre |\n|---|---|---|---|---|---|\n${rows(list)}\n`
      : "";

  let md = `# Veille de consolidation — ${stamp}\n\n`;
  md += `Détecteur **en lecture seule** : ${laws} lois, ${total} couples (loi, langue) comparés `;
  md += `entre les dates chargées en D1 (via \`list_laws\`) et les sources officielles `;
  md += `— LégisQuébec pour le Québec, Justice Canada pour le fédéral et les sources PDF `;
  md += `(QCCS, QCCQ, AMF).\n\n`;

  if (seaux && seaux.size > 1) {
    md += `| Publieur | Couples | Retard | Injoignables | Dérive | Alerte réseau |\n`;
    md += `|---|---|---|---|---|---|\n`;
    for (const [nom, s] of seaux) {
      md += `| ${NOM_PUBLIEUR[nom]} | ${s.total} | ${s.retard.length} | `;
      md += `${s.injoignable.length} (${(s.unreachableRatio * 100).toFixed(0)} %) | `;
      md += `${s.drift ? "**OUI**" : "non"} | ${s.unreachableAlert ? "**OUI**" : "non"} |\n`;
    }
    md += `\n`;
  }
  md += `- en retard (rafraîchissement dû) : **${retard.length}**\n`;
  md += `- en avance / anomalie : **${anomalie.length}**\n`;
  md += `- sans date stockée : **${sansStockee.length}**\n`;
  md += `- pages atteintes mais date illisible : **${illisible.length}**\n`;
  md += `- lois sans langue déclarée : **${sansLangue.length}**\n`;
  md += `- injoignables réseau : **${injoignable.length}** (${(unreachableRatio * 100).toFixed(0)} %)\n`;

  md += dateTable("Rafraîchissement dû — D1 en retard sur la source officielle", retard);
  md += dateTable("Anomalie — D1 EN AVANCE sur la source officielle (à investiguer)", anomalie);
  md += dateTable("Date de consolidation absente en D1", sansStockee);

  if (illisible.length) {
    md += `\n### Pages atteintes mais date « À jour au » introuvable\n\n`;
    md += `> ⚠️ Ces pages répondent (HTTP 200) mais le parseur n'y trouve pas la date. `;
    md += `Cause probable : le publieur a changé le libellé ou le format de la bannière — le `;
    md += `miroir correspondant est à mettre à jour, DANS SES DEUX MOITIÉS `;
    md += `(\`extractConsolidation\` ↔ \`fetch_consolidation\` pour LégisQuébec ; `;
    md += `\`extractConsolidationFederale\` ↔ \`extrait_consolidation_federale\` pour Justice `;
    md += `Canada ; \`checkPdfBuffer\` / \`extractPdfIndexDrift\` pour les sources PDF). Ce n'est PAS un problème réseau.\n\n`;
    md += `| Loi | Langue | Publieur | Détail |\n|---|---|---|---|\n`;
    md +=
      illisible.map((c) => `| ${c.id} | ${c.lang} | ${pub(c)} | ${c.note ?? "?"} |`).join("\n") +
      "\n";
  }

  if (sansLangue.length) {
    md += `\n### Lois sans langue déclarée en D1\n\n`;
    md += `> ⚠️ Aucune langue servie par \`list_laws\` : ligne \`laws\` sans article ? `;
    md += `(ingestion incomplète). À vérifier.\n\n`;
    md += `| Loi | Titre |\n|---|---|\n`;
    md +=
      sansLangue.map((c) => `| ${c.id} | ${(c.name || "").replace(/\|/g, "/")} |`).join("\n") +
      "\n";
  }

  if (injoignable.length) {
    md += `\n### Pages injoignables (réseau)\n\n`;
    if (unreachableAlert) {
      const bloquees = [...(seaux ?? new Map()).entries()]
        .filter(([, s]) => s.unreachableAlert)
        .map(([nom, s]) => `**${NOM_PUBLIEUR[nom]}** (${(s.unreachableRatio * 100).toFixed(0)} %)`);
      md += `> ⚠️ Le seuil de joignabilité est franchi chez ${bloquees.join(" et ") || "un publieur"}. `;
      md += `Il s'applique PAR PUBLIEUR : agrégé sur tout le corpus, un blocage total de l'un `;
      md += `des deux se diluerait sous les 25 % et ce rapport passerait vert. `;
      md += `Un blocage massif (WAF, filtrage des IP de centre de données) est possible — il `;
      md += `conditionnerait aussi toute ingestion automatisée. À vérifier hors CI.\n\n`;
    }
    md += `| Loi | Langue | Publieur | Motif |\n|---|---|---|---|\n`;
    md +=
      injoignable.map((c) => `| ${c.id} | ${c.lang} | ${pub(c)} | ${c.note ?? "?"} |`).join("\n") +
      "\n";
  }

  md += `\n---\n`;
  md += `Pour rafraîchir : exécuter le flux **\`rafraichir-corpus\`** (\`mode=preparer\` puis `;
  md += `\`mode=appliquer\` après revue du diff) ou suivre la procédure \`pipeline.refresh\` `;
  md += `de \`CLAUDE.md\` (staging→bascule incrémentale, découverte, backfill incrémental des `;
  md += `vecteurs, porte \`eval:gate\`). Ce job ne fait que détecter ; il n'écrit jamais en base.\n`;
  return md;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => {
    console.error("Échec du détecteur :", e.message);
    process.exit(1);
  });
}
