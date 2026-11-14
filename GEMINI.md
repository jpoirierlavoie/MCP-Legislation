# GEMINI.md — MCP Législation (Québec et Canada)

Règles d'espace de travail pour **Google Antigravity** et **Gemini CLI** lors du développement de ce dépôt.

> **Pourquoi ce fichier n'est pas une copie verbatim de [`CLAUDE.md`](CLAUDE.md)**
> 1. Antigravity tronque silencieusement tout fichier de règles au-delà de **24 000 octets** (plafond par fichier), alors que [`CLAUDE.md`](CLAUDE.md) dépasse **50 Ko** — une copie identique amputerait la fin des invariants et les consignes sur les secrets et le parseur fédéral sans avertissement.
> 2. La règle **R10** interdit les copies normatives susceptibles de dériver en silence.
> 3. La racine héberge aussi le manifeste Gemini CLI [`gemini-extension.json`](gemini-extension.json), qui déclare `"contextFileName": []` afin de ne pas injecter ces consignes de maintenance dans les sessions d'usage juridique normal du connecteur.
>
> **Obligation préalable :** lire [`CLAUDE.md`](CLAUDE.md) **avant toute modification**. Ce document reste volontairement sous **24 000 octets** (épinglé par `tests/catalogue.test.mjs`) et ne recopie aucun décompte vivant du corpus ou des tests.

---

## Obligation préalable — les cinq surfaces (R10), sans exception

Aucune tâche touchant ce dépôt n'est terminée tant que son impact sur les **cinq surfaces** n'a pas été évalué explicitement et répercuté dans le **même commit** (le coût en tokens n'exempte jamais de cette évaluation) :

1. **Outils MCP** (`src/tools.ts`, `src/schemas.ts`, `src/routeur.ts`) — noms `legislation_*`, paramètres, comportement, erreurs servies.
2. **Descriptions et titres** (`src/tools.ts`, `src/serveur.ts` `INSTRUCTIONS`/`PUBLIC_DESCRIPTION`, `catalogue.json`) — R3 borne le delta à ≤ 2 phrases et exige de consigner le coût en tokens.
3. **Schéma** (`schema.sql` = état initial uniquement, `schema-decouverte.sql`, `migrations/`, `src/schemas.ts`, forme de `structuredContent`) — toute étiquette qui borne un résultat doit voyager en champ obligatoire dans `structuredContent` (R4, décision 001) ; `outputSchema` reste absent à dessein.
4. **Documentation et manifestes** (`README.md`, `CLAUDE.md`, `GEMINI.md`, `package.json`, `plugin.json`, `mcp_config.json`, `gemini-extension.json`, `/mcp/server-card`, `tests/catalogue.test.mjs`).
5. **Page publique** (`catalogue.json` + `src/site.ts`) — décomptes lus en D1, constantes importées de `src/relevance.ts`, titres issus de `catalogue.json`.

**Sixième surface hors dépôt :** les compétences claude.ai (`competences-juridiques-pallas-athena/`) et le greffon Antigravity `pratique-civile-quebecoise` nomment les outils `legislation_*` à la main : tout ajout, retrait ou renommage d'outil impose leur mise à jour manuelle.

**`docs/` est une archive datée par défaut** (ne fait pas foi sur l'état courant), à l'exception des références techniques vivantes citées par le code (`docs/phase0-structure-epub.md`, `docs/phase0-structure-lims.md`, `docs/archive/PLAN.md`, `docs/archive/plan-couche-decouverte.md`).

---

## Contrat de vérité et règles de conception (R2–R10)

- **Outil juridique :** un résultat faux rendu en silence est le pire défaut possible — **refuser vaut toujours mieux que deviner**.
- Le texte des articles provient des EPUB officiels de **LégisQuébec** et des XML LIMS du **ministère de la Justice du Canada** ; il est restitué **verbatim**, sans jamais altérer le contenu officiel.
- **R2** : aucun nouvel outil MCP sans approbation explicite.
- **R3** : delta de description d'outil ≤ 2 phrases ; consigner le delta de tokens.
- **R4** : toute aide éditoriale est visiblement étiquetée non officielle ; la garde-fou `GARDE_FOU` de `legislation_find_relevant` est imposée mot pour mot.
- **R7** : fail open toujours annoncé explicitement (étiquettes d'élargissement, de relaxation et de repérage sémantique).
- **R8** : chemins sensibles derrière variables d'environnement (`RELAX_SEARCH`, `HYBRID_SEARCH`, `FEDERAL_CORPUS`).
- **R9** : réponse de recherche ~≤ 800 tokens en régime normal.
- **R10** : aucun décompte vivant (lois, matières, articles, contrôles) ni constante de calibration écrite à la main en prose ; tout décompte dérive de D1, des JSON versionnés (`pipeline/expected/served.json`, `taxonomy.json`) ou de `src/relevance.ts`.

---

## Synthèse des 18 invariants critiques (détails dans `CLAUDE.md`)

1. **Ordre porteur de `laws.config.json`** : `_id_base()` dérive les plages d'identifiants de la position ; ajouter uniquement **en fin de liste** (`pipeline/tests/test_config.py`).
2. **`sortKeyOf()` (`src/lib.ts`) et `sort_key()` (`pipeline/model.py`)** sont des miroirs exacts (`test/ranges.test.mjs`).
3. **Chargement monolingue** : l'UPSERT de `laws` n'écrase jamais l'autre langue ni sa citation officielle ; `name_norm`/`heading_norm` sont calculés au chargement.
4. **Chemins Irosoft propres à la langue** : toute traversée entre langues passe par `translateDivisionPath` / `translatePaths`.
5. **Pas de `LIKE`/`GLOB` sur `divisions.path`** : utiliser l'intervalle lexicographique `subtreeClause`.
6. **Limites D1** : lots SQL ≤ 100 Ko UTF-8 (morceler via `UPDATE … ||` pour les longs textes) ; `wrangler d1 export` sans `--table` échoue sur `articles_fts` → sauvegarde **Time Travel** avant toute migration ; répéter toute migration destructive sur une base D1 distante jetable provisionnée avec `schema.sql` + migrations + `schema-decouverte.sql`, puis la supprimer par UUID hors agent.
7. **Échelle de recherche & plancher** : exact → élargissement corpus → leave-one-out (`RELAX_MIN_LOO_TOTAL`) → OU+bm25, puis RRF avec Vectorize, puis sémantique seul sous `SEMANTIC_MIN_SCORE` (`src/relevance.ts`), gardés ensemble par `test/repere-echelle.test.ts` et `tests/evals.mjs`.
8. **Vectorize** : identifiants ≤ 64 octets (SHA-256/24hex), index de métadonnées créés avant insertion, découpage récursif sur erreur `3030`.
9. **WAF de zone** : bloque les rafales de `POST` de backfill sur le domaine personnalisé ; ouvrir temporairement `workers_dev: true` puis refermer.
10. **Sessions MCP** : une session par lot dans `eval/mcp-client.mjs` (transport désormais sans état sous `SOCLE=true`).
11. **Windows / Git Bash** : tout patch contenant des barres obliques inverses passe par un fichier script, jamais par heredoc.
12. **Calibration continue** : pondérations sans seuil discontinu dépendant du nombre de lois ou de la longueur de la requête (`specificityFactor`, `coverageFactor`).
13. **`description` de matière (`taxonomy.json`)** : surface d'appariement sans négation ni mention contrastive.
14. **Préfixe de mot borné (`MAX_SUFFIX`)** dans `src/relevance.ts`.
15. **Plafond de diversité par matière (`MAX_PER_SUBJECT`)** hors signaux S2/S3/S4.
16. **Vérité terrain et éditorial juridique (⛔)** : ne jamais modifier `eval/cases.json` ni le contenu éditorial `validated` sans décision explicite du praticien.
17. **Corpus fédéral (`pipeline/parser_lims.py`)** : descendre `Body` et `Schedule` explicitement (jamais `.iter('Section')` à cause de `RelatedOrNotInForce`/`AmendedText`), lire `consol_date_*` sur la page Justice Canada (`<p id="assentedDate">`), figer `LIMS_REF` à un SHA pour rejouer à l'identique ; portée arrêtée (Code criminel, Loi de l'impôt sur le revenu, lois constitutionnelles hors portée).
18. **`label` de matière (`taxonomy.json`)** : motif servi par `legislation_find_relevant` ; vérifier l'étendue réelle des divisions avant rattachement (`tests/taxonomie.test.mjs`).

---

## Contrôle d'accès `/mcp`, CORS et fiche SEP-2127

- **Fermé par défaut** (`src/auth.ts`, `src/index.ts`) : `MCP_ENABLED` doit valoir exactement `"true"`, et `NOMS_SECRETS` (`PORTE`) liste littéralement les secrets admis sans court-circuit.
- **Trois porteurs équivalents** : `Authorization: Bearer <jeton>`, `?key=<jeton>` et `/mcp/<jeton>` (slash final toléré partout).
- **Refus sur `/mcp*` en `404` (jamais `401`)** : un `401` déclenche la découverte OAuth des clients.
- **Origines CORS navigateur** : `https://claude.ai`, `https://claude.com`, `https://gemini.google.com`, `https://aistudio.google.com` + `ALLOWED_ORIGINS` ; le pré-vol `OPTIONS` autorise les en-têtes MCP `2026-07-28` (`Mcp-Method`, `Mcp-Name`, `Mcp-Session-Id`, `Last-Event-ID`).
- **Exception publique SEP-2127** : `GET`/`HEAD`/`OPTIONS /mcp/server-card` sert la fiche dérivée de `src/serveur.ts` sans secret (`Access-Control-Allow-Origin: *`), soumise au coupe-circuit `MCP_ENABLED`.

---

## Secrets et éléments à ne pas modifier ou supprimer

- **Interdiction absolue** de lire, afficher ou copier : `cf.token`, `mcp.token`, `mcp-veille.token`, `backfill.token`, `*.token`, `mcp.url`, `.dev.vars`, `.env*`, `~/.gemini/config/mcp_config.json`, `~/.gemini/config/config.json`.
- **Interdiction absolue** d'exécuter `wrangler d1 delete` depuis un agent (`confirm2` répond oui hors TTY).
- **Ne pas supprimer** : le bloc `"triggers": { "crons": [...] }` de `wrangler.jsonc`, `complexity.noUselessStringRaw: "off"` dans `biome.json`, ni `wrangler.transit.jsonc`, `scripts/capturer-tools-list.mjs` et `fixtures/tools-list.reference.json` hors de leur échéance consignée dans `CLAUDE.md`.
- **Ne pas écrire de motif de jeton** (`Bearer `, `?key=`, hexadécimal ≥ 32 caractères) dans le HTML généré par `src/site.ts`.

---

## Procédure sûre et commandes (Windows PowerShell)

Avec `ExecutionPolicy Restricted`, employer `npm.cmd` et `npx.cmd`. Toujours exécuter `npm.cmd test` (et **jamais** `node --test`) : `pretest` régénère `wrangler.test.jsonc` hors ligne.

```powershell
npx.cmd wrangler types
npx.cmd tsc --noEmit
npx.cmd biome check .
npm.cmd test
npx.cmd wrangler deploy --dry-run
```

Tests Python hors ligne : `PYTHONUTF8=1 ./.venv/Scripts/python.exe -m unittest discover -s pipeline/tests -p "test_config.py" -v` (et modules unitaires sans téléchargement listés dans `.github/workflows/ci.yml`).

**Déploiement manuel uniquement :** ne jamais exécuter `wrangler deploy` sans `--dry-run`, ni `wrangler d1 migrations apply --remote`, sans instruction explicite du praticien (et sans bookmark Time Travel avant migration).
