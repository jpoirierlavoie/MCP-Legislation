#!/usr/bin/env node
/**
 * Déploiement de production — migrations D1 D'ABORD, puis le Worker avec `--var COMMIT:<sha>`.
 *
 * Exécuté à la fois par `.github/workflows/deploy.yml` et en repli local via `npm run deploy`.
 *
 * Gardes stricts :
 *   1. Arbre de travail propre (`git status --porcelain`), afin que `/health` annonce exactement
 *      le commit du code en ligne.
 *   2. Présence de `CLOUDFLARE_API_TOKEN` dans l'environnement (aucun fichier de jeton n'est lu
 *      ni affiché par ce script).
 *   3. Migrations D1 (`legislation --remote`) appliquées AVANT `wrangler deploy` — arrêt net si
 *      elles échouent. Toute migration destructive reste soumise à une répétition préalable sur
 *      une D1 distante jetable et à un bookmark Time Travel (`CLAUDE.md`).
 *   4. L'ingestion du corpus (`pipeline/`) et le backfill des vecteurs demeurent strictement
 *      manuels : ce script ne touche ni aux articles ni aux embeddings.
 */
import { execFileSync, spawnSync } from "node:child_process";

/** Sortie d'une commande git, sans bruit. */
function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function echouer(titre, ...details) {
  console.error(`\n✘ ${titre}`);
  for (const d of details) console.error(`  ${d}`);
  console.error("");
  process.exit(1);
}

const sale = git("status", "--porcelain");
if (sale) {
  echouer(
    "L'arbre de travail n'est pas propre — déploiement refusé.",
    "Le Worker annonce son commit sur /health. Déployer un arbre modifié ferait",
    "annoncer un commit qui ne décrit pas le code en ligne.",
    "",
    ...sale
      .split("\n")
      .slice(0, 10)
      .map((l) => `    ${l}`),
  );
}

const commit = git("rev-parse", "--short", "HEAD");
const branche = git("rev-parse", "--abbrev-ref", "HEAD");
const surMain = branche === "main" || process.env.GITHUB_REF === "refs/heads/main";
if (!surMain) {
  console.warn(`⚠ Branche « ${branche} » et non « main » — le contrôle de dérive comparera`);
  console.warn("  la production au dernier commit de main, et signalera donc un écart.\n");
}

if (!process.env.CLOUDFLARE_API_TOKEN) {
  echouer(
    "CLOUDFLARE_API_TOKEN est absent de l'environnement.",
    "PowerShell : $env:CLOUDFLARE_API_TOKEN = (Get-Content cf.token -Raw).Trim()",
    "bash       : export CLOUDFLARE_API_TOKEN=\"$(tr -d ' \\t\\r\\n' < cf.token)\"",
    "Le jeton ne se passe pas en argument : la liste des processus est lisible.",
  );
}

/** Exécute une commande en héritant du terminal ; rend son code de sortie. */
function lancer(etape, cmd, args) {
  console.log(`\n── ${etape}\n   ${cmd} ${args.join(" ")}\n`);
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });
  return r.status ?? 1;
}

if (
  lancer("Migrations D1 (production)", "npx", [
    "wrangler",
    "d1",
    "migrations",
    "apply",
    "legislation",
    "--remote",
  ]) !== 0
) {
  echouer(
    "Les migrations ont échoué — le Worker n'a PAS été déployé.",
    "On ne met pas en ligne du code dont le schéma n'a pas suivi.",
    "Corriger la migration (répétition préalable + Time Travel si destructive), puis relancer.",
  );
}

if (
  lancer(`Déploiement du Worker (commit ${commit})`, "npx", [
    "wrangler",
    "deploy",
    "--var",
    `COMMIT:${commit}`,
  ]) !== 0
) {
  echouer(
    "Le déploiement a échoué APRÈS des migrations réussies.",
    "Vérifier l'état du Worker et des Durable Objects avant de relancer.",
  );
}

console.log(`\n✔ En ligne : commit ${commit}.`);
console.log("  Vérifier : curl -s https://legislation.poirierlavoie.ca/health");
console.log("  Note : prévoir ~30–60 s pour le recyclage des Durable Objects.");
