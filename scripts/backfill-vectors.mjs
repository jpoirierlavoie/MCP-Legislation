import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import lawsConfig from "../data/laws.config.json" with { type: "json" };

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BASE = "https://legislation.poirierlavoie.ca";
const PROGRESS = join(HERE, ".backfill-progress.json");

const PACE_MS = 500;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) legislation-backfill";
const MODES_VALIDES = new Set(["full", "incremental", "seed", "prune", "ping"]);

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

export function parseBackfillArgs(argv) {
  const arg = (name, def) => {
    const i = argv.indexOf(`--${name}`);
    return i > -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
  };
  let mode = arg("mode", "");
  if (!mode && argv.includes("--incremental")) mode = "incremental";
  if (!mode) mode = "full";
  if (!MODES_VALIDES.has(mode)) {
    throw new Error(`Mode invalide '${mode}' (attendu : full|incremental|seed|prune|ping).`);
  }
  const lawsRaw = arg("laws", "");
  const kindsRaw = arg("kind", "articles,divisions");
  return {
    mode,
    laws: lawsRaw ? lawsRaw.split(",").filter(Boolean) : null,
    kinds: kindsRaw.split(",").filter(Boolean),
    prune: argv.includes("--prune"),
    seedIfEmpty: argv.includes("--seed-if-empty"),
    resume: argv.includes("--resume"),
  };
}

export function resolveBackfillToken(env = process.env) {
  const fromEnv = env.BACKFILL_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  throw new Error(
    "BACKFILL_TOKEN absent de l'environnement " +
      "(PowerShell: $env:BACKFILL_TOKEN=(Get-Content backfill.token -Raw).Trim() | bash: export BACKFILL_TOKEN=\"$(tr -d ' \\t\\r\\n' < backfill.token)\").",
  );
}

export async function runBackfill({
  baseUrl = process.env.BACKFILL_URL ?? DEFAULT_BASE,
  token,
  laws,
  kinds = ["articles", "divisions"],
  mode = "full",
  prune = false,
  seedIfEmpty = false,
  resume = false,
  progressPath = PROGRESS,
  paceMs = PACE_MS,
  retryBaseMs = 2000,
  fetchImpl = fetch,
  log = console.log,
  write = (s) => process.stdout.write(s),
}) {
  if (!MODES_VALIDES.has(mode)) {
    throw new Error(`Mode invalide '${mode}'.`);
  }
  let rawProgress = {};
  if (mode === "full" && resume && progressPath) {
    try {
      rawProgress = JSON.parse(readFileSync(progressPath, "utf-8"));
    } catch (e) {
      if (e?.code !== "ENOENT") throw e;
    }
  }
  const savedProgress = {};

  async function post(body, attempt = 1) {
    await sleep(paceMs);
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/admin/backfill-vectors`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": UA,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 120).replace(/\s+/g, " ");
      if (attempt < 7) {
        const wait = Math.min(60_000, retryBaseMs * 2 ** (attempt - 1));
        log(`\n   retry ${attempt} dans ${wait / 1000}s (HTTP ${res.status}: ${text})`);
        await sleep(wait);
        return post(body, attempt + 1);
      }
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    return res.json();
  }

  const t0 = Date.now();
  let totalScanned = 0;
  let totalEmbedded = 0;
  let totalSkipped = 0;
  let totalSeeded = 0;
  let totalDeleted = 0;
  let totalOverruns = 0;

  for (const kind of kinds) {
    for (const law of laws) {
      if (mode === "ping" || mode === "prune") {
        const r = await post({ kind, law, mode });
        if (mode === "prune") {
          totalDeleted += r.deleted ?? 0;
          log(`${kind}|${law} [prune]: ${r.deleted ?? 0} supprimé(s)`);
        } else {
          log(`${kind}|${law} [ping]: ok=${r.ok}, suivis=${r.tracked ?? 0}`);
        }
        continue;
      }

      let effectiveMode = mode;
      if (seedIfEmpty) {
        const p = await post({ kind, law, mode: "ping" });
        if ((p.tracked ?? 0) === 0) {
          effectiveMode = "seed";
          log(`${kind}|${law}: vector_state vide -> amorçage (mode=seed) sans ré-embedding.`);
        }
      }

      const key = `${kind}|${law}`;
      if (effectiveMode === "full" && rawProgress[key] === "done") {
        savedProgress[key] = "done";
        log(`— ${key} déjà fait —`);
        continue;
      }
      let offset =
        effectiveMode === "full" && typeof rawProgress[key] === "number"
          ? Math.max(0, Number.parseInt(String(rawProgress[key]), 10) || 0)
          : 0;
      for (;;) {
        const r = await post({ kind, law, mode: effectiveMode, offset });
        totalScanned += r.scanned ?? r.embedded ?? 0;
        totalEmbedded += r.embedded ?? 0;
        totalSkipped += r.skipped ?? 0;
        totalSeeded += r.seeded ?? 0;
        totalOverruns += r.overruns ?? 0;
        const nextOffset = Math.max(0, Number.parseInt(String(r.next ?? 0), 10) || 0);
        write(
          `\r${key} [${effectiveMode}]: ${nextOffset} parcourus ` +
            `(embed=${totalEmbedded}, skip=${totalSkipped}, seed=${totalSeeded})   `,
        );
        if (r.done) break;
        offset = nextOffset;
        if (effectiveMode === "full" && progressPath) {
          savedProgress[key] = offset;
          writeFileSync(progressPath, JSON.stringify(savedProgress, null, 2));
        }
      }
      if (effectiveMode === "full" && progressPath) {
        savedProgress[key] = "done";
        writeFileSync(progressPath, JSON.stringify(savedProgress, null, 2));
      }
      log("");

      if (prune && (effectiveMode === "full" || effectiveMode === "incremental")) {
        const pr = await post({ kind, law, mode: "prune" });
        const deleted = pr.deleted ?? 0;
        totalDeleted += deleted;
        if (deleted > 0) {
          log(`  prune ${key}: ${deleted} vecteur(s) orphelin(s) supprimé(s)`);
        }
      }
    }
  }

  const durationSec = Math.round((Date.now() - t0) / 1000);
  log(
    `\nTerminé [${mode}] : ${totalScanned} parcouru(s), ${totalEmbedded} embeddé(s), ` +
      `${totalSkipped} inchangé(s), ${totalSeeded} amorcé(s), ${totalDeleted} purgé(s) ` +
      `en ${durationSec}s ; ${totalOverruns} texte(s) tronqué(s) à ~1500 tokens.`,
  );
  return {
    totalScanned,
    totalEmbedded,
    totalSkipped,
    totalSeeded,
    totalDeleted,
    totalOverruns,
    durationSec,
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const opts = parseBackfillArgs(process.argv.slice(2));
  const token = resolveBackfillToken();
  const allLaws = lawsConfig.laws.map((l) => l.id);
  runBackfill({
    token,
    laws: opts.laws ?? allLaws,
    kinds: opts.kinds,
    mode: opts.mode,
    prune: opts.prune,
    seedIfEmpty: opts.seedIfEmpty,
    resume: opts.resume,
  }).catch((e) => {
    console.error(`\n❌ Backfill échoué : ${e.message}`);
    process.exit(1);
  });
}
