# mcp-legislation — Lois du Québec et du Canada (serveur MCP)

Directives de développement, contrat de vérité et invariants anti-dérive pour **`mcp-legislation`** (`https://legislation.poirierlavoie.ca/mcp` et `/mcp/oauth`), gouvernant à l'identique Claude et Google Antigravity / Gemini CLI (`CLAUDE.md` et `GEMINI.md` doivent rester identiques octet pour octet et sous **24 000 octets** UTF-8 LF sans BOM ; `gemini-extension.json` déclare `"contextFileName": []` afin de ne jamais injecter ces consignes dans les sessions des usagers finaux).

Propriétaire : Jason Poirier Lavoie (avocat). Lecture seule pour les usagers ; les données proviennent des EPUB officiels de LégisQuébec, des XML du ministère de la Justice du Canada (Licence du gouvernement ouvert – Canada ; version officielle fédérale publiée par le ministre, art. 31 de la *Loi sur la révision et la codification des textes législatifs*) et de sa codification administrative en PDF (`CONST_TRD.pdf`), ainsi que des PDF officiels des tribunaux du Québec (QCCS, QCCQ) et de l'AMF (`source = 'pdf'`). **C'est un outil juridique : un résultat faux rendu en silence est le pire défaut possible — refuser vaut toujours mieux que deviner.**

---

## ⛔ OBLIGATION PRÉALABLE À TOUTE MODIFICATION (aucune exception)

**Avant de terminer QUELLE QUE SOIT une tâche touchant ce dépôt, exécuter une évaluation d'impact explicite sur les CINQ surfaces locales (dont `README.md` et la page publique HTML `GET /`) ainsi que sur les dépôts liés (`Inter-dépôts`), et inclure les mises à jour requises DANS LE MÊME COMMIT.** Ce n'est pas une bonne pratique, c'est une condition de fin de tâche. **Le coût en tokens n'est JAMAIS une raison de sauter cette évaluation** — le coût en tokens n'exempte de rien.

| # | Surface | Où | Ce qui la fait bouger |
|---|---|---|---|
| 1 | **Outils MCP** | `src/tools.ts`, `src/schemas.ts`, `src/routeur.ts` | nom, ajout/retrait (R2), paramètres, comportement, message d'erreur servi |
| 2 | **Descriptions** | `src/tools.ts` (`description`, `title`), `src/serveur.ts`, `catalogue.json` | toute reformulation ; R3 borne le delta à ≤ 2 phrases et exige de consigner le coût en tokens |
| 3 | **Schéma** | `schema.sql`, `schema-decouverte.sql`, `migrations/`, `inputSchema` des outils, forme de `structuredContent` | colonne ajoutée/retirée, champ de sortie ajouté/retiré/renommé |
| 4 | **README.md** et manifestes | `README.md`, `SECURITY.md`, `LICENSE` (`Apache-2.0`), `NOTICE`, `package.json`, `plugin.json`, `mcp_config.json`, `gemini-extension.json`, `CLAUDE.md`, `GEMINI.md`, `/mcp/server-card` | tout ce qui change ce que le dépôt annonce faire, sa licence, sa confidentialité ou sa connectivité |
| 5 | **Page publique** (HTML `GET /`) | `catalogue.json` + `src/site.ts` (`tests/page-client.test.mjs`, `tests/catalogue.test.mjs`) | rendu bilingue FR/EN de `GET /`, décomptes lus en D1, constantes de calibration, section `#acces`, licence ou clause de non-conseil |
| 6 | **Inter-dépôts (Cross-repository)** | `droit-civil-quebecois` (manifestes, `skills/`, `verifier.py`, `verifier_tout.py`), `MCP-Socle` (`v0.8.4`), `MCP-Acces`, `MCP-Jurisprudence` (jumeau HTML/CSS), `MCP-Outils` | tout changement d'outil, schéma, porteur d'authentification, quotas, page publique `GET /`, confidentialité ou licence |

**Procédure obligatoire :**
1. Énoncer explicitement l'impact vérifié sur chacune des 6 surfaces (« non touchée » vérifié et motivé, jamais passé sous silence).
2. Exécuter `npx tsc --noEmit`, `npx biome check .`, `npm run audit` et `npm test` (les deux projets vitest `workerd` et `node`, jamais `node --test`).
3. Si une surface servie bouge : vérifier `wrangler dev` + `npm run evals` (et `npm run eval` si le repérage change — aucune régression sur les 21 cas).
4. `docs/` est une **archive datée par défaut** (ne fait pas foi sur l'état courant), à l'exception des références techniques citées par le code (`docs/phase0-structure-epub.md`, `docs/phase0-structure-lims.md`, `docs/phase0-structure-pdf.md`, `docs/archive/PLAN.md`, `docs/archive/plan-couche-decouverte.md`).

---

## 1. Architecture et cadre global (`droit-civil-quebecois`)

```
             ┌────────────────────────────────────────────────────────┐
             │      droit-civil-quebecois (Plugin Cadre v3.1.1)       │
             │   10 compétences · 59 feuilles · 4 scripts stdlib      │
             └──────┬───────────────────────┬──────────────────┬──────┘
                    │                       │                  │
        (serveur `lois`, 10 outils)  (serveur `juris`, 12)  (serveur `outils`, 15)
                    │                       │                  │
                    ▼                       ▼                  ▼
         ┌─────────────────────┐ ┌─────────────────────┐ ┌──────────────────────────┐
         │   MCP-Legislation   │ │  MCP-Jurisprudence  │ │        MCP-Outils        │
         │  D1 `legislation` + │ │  D1 `canlii` + BYOK │ │   Worker public, D1 RO   │
         │  `DB_IDENTITE` + AI │ │   `DB_IDENTITE`     │ │       zéro secret        │
         └──────────┬──────────┘ └──────────┬──────────┘ └──────────────────────────┘
                    └───────────┬───────────┘
                                ▼ (`@poirierlavoie/mcp-socle` v0.8.4, zéro runtime dep)
                 ┌──────────────────────────────────────────┐
                 │  MCP-Socle + MCP-Acces (`mcp-identite`)  │
                 │  Jetons individuels, OAuth 2.1 PKCE S256 │
                 │  Quotas UTC, zéro journal de requêtes    │
                 └──────────────────────────────────────────┘
```

### Trois morceaux internes
1. **Worker Cloudflare** (`src/`, TypeScript) — Routeur MCP sans état (`@poirierlavoie/mcp-socle` `0.8.4`) + 10 outils courts (`list_laws`, `list_subjects`, `related_laws`, `find_relevant`, `get_article`, `get_articles`, `get_structure`, `get_division`, `search_text`, `resolve_reference`), D1 `DB` (`legislation`) + D1 `DB_IDENTITE` (`mcp-identite`), Workers AI (`bge-m3`) + Vectorize (`legislation-articles`). Zéro `dependencies` d'exécution.
2. **Pipeline Python** (`pipeline/`, venv `./.venv/Scripts/python.exe`, toujours `PYTHONUTF8=1`) — Ingère les EPUB LégisQuébec, les XML LIMS Justice Canada et les PDF déclaratifs (`pipeline/parser_pdf.py`, `pipeline/pdf_profiles/*.json`) par staging → validation → bascule (`pipeline/ingest.py`, `pipeline/refresh.py`).
3. **Données versionnées** — `laws.config.json`, `pipeline/expected/served.json`, `catalogue.json`, `taxonomy.json`, `relations.json`, `schema.sql` + `schema-decouverte.sql` + `migrations/`. Aucun décompte vivant n'est recopié en prose (R10).

---

## 2. Contrôle d'accès Phase 3, confidentialité et quotas (`SPEC-SOCLE-COMMUN.md`)

1. **Double montage (`/mcp` et `/mcp/oauth`) et coupe-circuit (`MCP_ENABLED`) :**
   - `MCP_ENABLED !== "true"` coupe `/mcp*`, `/.well-known/oauth-protected-resource/mcp/oauth` et `/health` en `404`, tout en laissant `GET /` ouvert (`200`, `G22`).
   - `/mcp` (`PORTE` dans `src/auth.ts`) accepte en parallèle les jetons individuels `DB_IDENTITE` (`portee` `'legislation'` ou `'les_deux'`, titulaire `actif` ou `limite`) et les secrets partagés transitoires de Phase 3a (`MCP_TOKEN`, `MCP_TOKEN_VEILLE`), sous `Authorization: Bearer <jeton>`, `?key=<jeton>` ou `/mcp/<jeton>` (slash final toléré). Tout refus sur `/mcp` renvoie **uniformément `404` sans corps ni `WWW-Authenticate`** (`S8`, `G7`, `G23`). `/mcp/server-card` et `/mcp/oauth` sont interceptés avant `/mcp/<jeton>`.
   - `/mcp/oauth` (`PORTE_OAUTH`) accepte **uniquement** `Authorization: Bearer <jeton>` (aucun `?key=`, aucun segment `/mcp/oauth/<x>`, aucun secret partagé de Worker). Tout refus renvoie `401` RFC 9728 pointant vers `GET /.well-known/oauth-protected-resource/mcp/oauth` (`authorization_servers: ["https://acces.poirierlavoie.ca"]`), tandis que la racine `GET /.well-known/oauth-protected-resource` reste en `404`.
   - Le contrôle de méthode `POST` (`405`) s'exécute **après** l'authentification sur `/mcp` comme sur `/mcp/oauth` (`G23`).
2. **Débit à deux niveaux et quotas journaliers (`G32`, `G34`) :**
   - Pré-auth par IP (`RL_PRE_AUTH_IP` `1011` 600/min, `RL_ECHEC_IP` `1012` 20/min, `RL_ECHECS_GLOBAL` `1013` 300/min) + `QuarantaineIpEchecs` contournée par tout jeton valide déjà reconnu afin de protéger les IP partagées de cabinets ou de clients infonuagiques.
   - Post-auth par `titulaire_id` (`RL_TITULAIRE` `1014` 300/min en état `actif`, `RL_TITULAIRE_LIMITE` `1015` 20/min en état `limite`), puis quotas journaliers UTC dans `DB_IDENTITE.compteur_jour` vérifiés sur le nom d'outil du corps JSON-RPC (`local`: 1 500/j `actif`, 150/j `limite` ; `semantique`: 150/j `actif`, 15/j `limite` -> HTTP `200` `isError: true` `[QUOTA_EPUISE]`).
3. **Opt-out `hybride_permis` (`S19`) :**
   - Si `principal.type === "titulaire"` et `!principal.hybridePermis`, `search_text` s'exécute uniquement en recherche lexicale FTS5 locale (sans jamais appeler `env.AI` ni `env.VECTORS`, facturé en classe `local`) et l'énonce explicitement dans la prose servie ainsi que via `hybride_desactive: true` dans `structuredContent`.
4. **Zéro journalisation de contenu et observabilité désactivée (`S13`, `S14`, `G9`, `G37`) :**
   - Aucune écriture d'exécution dans `search_log` (`logSearch` retiré de `src/` ; `0001_search_log.sql` conservé uniquement pour la chaîne historique de migrations D1).
   - `wrangler.jsonc` impose `"observability": { "enabled": false, "logs": { "enabled": false, "invocation_logs": false } }`.
   - Seuls `compteur_jour` et `evenement_technique` (sans `query` ni argument d'outil, horodatés au jour / à la minute UTC et purgés à 90 j) sont enregistrés via `ctx.waitUntil` dans `DB_IDENTITE`.

---

## 3. Règles de conception actives (R2–R10)

- **R2** : Aucun nouvel outil MCP sans approbation explicite (enrichir les 10 existants).
- **R3** : Delta de description d'outil ≤ 2 phrases ; consigner le delta de tokens.
- **R4** : Ne jamais altérer le texte officiel ni son rendu ; toute aide éditoriale est visiblement étiquetée non officielle (`GARDE_FOU` imposé mot pour mot sur `find_relevant`). Les textes non législatifs (`fonction`: `'directive'` en `paragraphe`, `'orientation'` en `article`) affichent explicitement leur statut normatif, `articles.links` et leurs arêtes `'preseance-sur'` / `'interprete'`. **Corollaire structuré (décision 001) :** toute étiquette qui borne un résultat voyage dans `structuredContent` comme champ obligatoire, jamais en prose seule (`outputSchema` reste absent de `tools/list`).
- **R7** : *Fail open* toujours annoncé explicitement (étiquettes d'élargissement, relaxation et repérage sémantique).
- **R8** : Chemins risqués derrière variables d'env (`RELAX_SEARCH`, `HYBRID_SEARCH`, `FEDERAL_CORPUS`, `PDF_CORPUS`, `CRIMINAL_CORPUS`, `DOMAIN_QUARANTINE`, `VECTOR_DOMAIN_FILTER`) — rollback = flip de variable, sans `wrangler rollback` (bloqué par la suppression Durable Object `v2: QclawMCP`).
- **R9** : Réponse de recherche ~≤ 800 tokens en régime normal.
- **R10** : Une vérité, cinq surfaces locales + inter-dépôts (`tests/catalogue.test.mjs`) ; aucun fait vivant (lois, matières, articles, seuils de calibration) écrit à la main en prose.

---

## 4. Les 19 invariants critiques (chacun a déjà cassé quelque chose)

1. **Ordre porteur de `laws.config.json`** : `_id_base()` dérive les plages d'ID de la position de chaque loi. Réordonner écrase les articles d'autres lois en silence. Toujours ajouter **en fin de liste** (`pipeline/tests/test_config.py`).
2. **Miroir exact `sortKeyOf()` (`src/lib.ts`) ↔ `sort_key()` (`pipeline/model.py`)** : Indexe `articles.sort_key` (`test/ranges.test.mjs`), y compris les numéros alphanumériques (`2A.1`, `4B.2`) et `kind='annexe'` (`>= DISPOSITION_SORT_BASE`). Les bornes de plage sont lues en base (`boundKey`).
3. **Chargement monolingue sans écrasement** : L'UPSERT de `laws` préserve l'autre langue (`name_<autre>`, `consol_date_<autre>`, `official_cite_en`) ; `name_norm` et `heading_norm` sont calculés au chargement.
4. **Chemins propres à la langue et miroir `SEG_SPLIT`** : Les identifiants Irosoft (`ga:l_cinquieme` FR / `ga:l_five` EN) traversent par le pont des numéros d'articles (`translateDivisionPath` / `translatePaths`) ; `pipeline/paths.py` et `src/paths.ts` partagent un `SEG_SPLIT` identique couvrant `ph<level>:<rank>` et `ps:<n>` (PDF).
5. **Aucun `LIKE`/`GLOB` sur `divisions.path`** : `_` est un joker `LIKE` et D1 plafonne la complexité des motifs ; employer l'intervalle lexicographique `[path+'-', path+'.')` (`subtreeClause`).
6. **Plafond D1 ≤ 100 Ko UTF-8 et export/migrations** : Lots SQL plafonnés en octets UTF-8 ; lignes géantes via `INSERT` court + `UPDATE … ||` (`pipeline/load.py`). `wrangler d1 export` global échoue sur `articles_fts` (employer Time Travel avant `--remote`, ou `--table <t> --no-schema` en gérant les lignes > 100 Ko et `divisions.parent_id > id`). Toute migration destructive (`DROP`) se répète d'abord sur une D1 distante jetable provisionnée avec `schema.sql` + `migrations/` + `schema-decouverte.sql`.
7. **Échelle de recherche, quarantaine par domaine et plancher `RELAX_MIN_LOO_TOTAL = 2`** : Ordre calibré : exact → élargissement corpus (ou limité au domaine de `law` / `domains` actifs) → leave-one-out (arrêt seulement si `total >= Math.min(2, limit)`) → OU+bm25 (`articles_fts` 5 col. pondéré `text: 1.0`, `marginal_note: MARGINAL_NOTE_WEIGHT = 0.5`, `snippet` strictement sur col. 0), puis RRF avec Vectorize, puis sémantique seul sous `SEMANTIC_MIN_SCORE = 0,40` (`test/repere-echelle.test.ts`). En Phase 0 (`DOMAIN_QUARANTINE = "1"`, `0008_domains.sql`), 8 domaines isolent `core` par défaut dans `list_laws`, `find_relevant` et `search_text` sans `law`, avec filtres `domains`/`jurisdiction`/`forum` et radar `other_domains` ; les lectures directes et `search_text(law=...)` restent ouverts à tout le corpus (`VECTOR_DOMAIN_FILTER = "1"`, index de métadonnées Vectorize `domain` et `jurisdiction` actifs).
8. **Vectorize** : Identifiants ≤ 64 octets UTF-8 (`divVectorId` et `artVectorId` hachés SHA-256/24 hex au-delà de 64 octets) ; index de métadonnées créés avant insertion ; scission récursive des lots d'embeddings sur erreur `3030`.
9. **WAF de zone** : Bloque les rafales de `POST` de backfill sur le domaine personnalisé (`workers_dev: true` temporaire seulement pendant un backfill supervisé).
10. **Sessions MCP** : Une session par lot dans `eval/mcp-client.mjs` ; transport serveur 100 % sans état.
11. **Windows / Git Bash** : Les heredocs bash mangent un niveau de `\` ; toujours passer par un fichier script écrit proprement.
12. **Calibration continue (`specificityFactor`, `coverageFactor`)** : Aucun seuil discontinu dépendant du nombre d'entités au corpus ni de la longueur de la requête dans `src/relevance.ts`.
13. **`description` de matière (`taxonomy.json`) = surface d'appariement S1** : Zéro négation ni mention contrastive (« distincte de… »), uniquement le vocabulaire devant matcher.
14. **Préfixe de mot borné (`MAX_SUFFIX = 4`)** : Couvre la flexion française sans laisser un préfixe court (« fin ») capter « financier ».
15. **Plafond de diversité par matière (`MAX_PER_SUBJECT = 3`)** : Limite les candidats issus du seul signal S1 afin qu'une matière dense n'évince pas les codes.
16. **Vérité terrain (`eval/cases.json`) ⛔** : Ne jamais modifier `eval/cases.json` ni le contenu éditorial (`taxonomy.json`, `curation/`) sans décision explicite de Jason (`--refresh-paths` revalide uniquement le cache dérivé `eval/cases.resolved.json`).
17. **Corpus fédéral (`pipeline/parser_lims.py`)** : 22 textes de base (19 lois + 3 règlements) + 3 lois pénales de Vague 3 (`ca-c-46`, `ca-c-38.8`, `ca-y-1.5` en domaine `penal`, derrière `CRIMINAL_CORPUS === "1"`, LIR exclue ; lois constitutionnelles via `pipeline/parser_pdf.py`). Descendre explicitement `Body` puis `Schedule` — **jamais** `.//Section` (qui ingérerait `RelatedOrNotInForce` / `AmendedText`). `consol_date_*` provient obligatoirement du `<p id="assentedDate">` de la page Justice Canada (jamais de `lims:current-date` ni de `LastConsolidationDate`).
18. **Libellé (`label`) de matière = motif de justification servi** : Vérifier l'étendue réelle de la division rattachée (`louage` général vs `louage résidentiel`, gardé par `tests/taxonomie.test.mjs`).
19. **Corpus PDF (`pipeline/parser_pdf.py`, `docs/phase0-structure-pdf.md`)** : 15 entrées PDF (`laws.config.json[97..111]` : 13 PDF `fr`-only QCCS/QCCQ/AMF, incluant `v-1.1-r.10`, `v-1.1-r.21` et `v-1.1-r.24` (`source='pdf', fonction='reglement'`) parce que leurs EPUB LégisQuébec sont des renvois d'une page vers l'AMF, et `ca-const-1867` / `ca-const-1982` bilingues FR/EN extraits de `CONST_TRD.pdf`). Zéro LLM, zéro OCR (`ScannedPdfError`), zéro contournement WAF/403 ; Gate 1 exige `0` span non classé ; la date de consolidation vient du texte du PDF (jamais de `/ModDate`) ; tout accès reste verrouillé derrière `PDF_CORPUS === "1"`.

---

## 5. Secrets, sécurité et commandes de vérification

- **Interdiction absolue** de lire, afficher, copier ou commiter : `cf.token`, `mcp.token`, `mcp-veille.token`, `backfill.token`, `*.token`, `mcp.url`, `.dev.vars`, `.env*`, `~/.gemini/config/*`.
- **Interdiction absolue** d'exécuter `wrangler d1 delete` ou `wrangler deploy` seul (employer `npm run deploy` / `scripts/deployer.mjs`).
- **Gouvernance Git (`main-pr-and-ci`) :** Le contournement administrateur du ruleset `main-pr-and-ci` est restreint à `pull_request` — **ne jamais pousser directement sur `main`** ; travailler sur une branche dédiée, ouvrir une Pull Request, attendre le passage des contrôles requis (`CI`, `CodeQL`, `OSV-Scanner`, `Trivy`), puis fusionner par *squash* (`gh pr merge --squash --delete-branch`).
- **Dépendances Python en CI :** Installations verrouillées par empreintes SHA-256 (`pip install --require-hashes` sur `pipeline/requirements-ci.txt` et `pipeline/requirements-lock.txt`) ; `pymupdf` borné `< 2` (`.github/dependabot.yml` ignore `>= 2.0.0`).
- **`src/site.ts`** : Mise en forme Biome avec `complexity.noUselessStringRaw` désarmé intentionnellement sur `BOOT`/`JS` ; en dev local, vider `.wrangler/state/v3/cache` (jamais `d1`) pour observer un changement de page mis en cache sous `CACHE_KEY`.
- **Veille mensuelle (`scripts/check-consolidation.mjs`)** : Lecture seule avec trois seaux par publieur (LégisQuébec + Justice Canada + PDF QCCS/QCCQ/AMF : en-tête `%PDF-`, SHA-256 contre `pipeline/pdf_profiles/*.json`, page d'index et classement propre des `403` Cloudflare en `injoignable`) et seuil de joignabilité évalué **par publieur** (`agregeParSeau`).

```powershell
npx.cmd wrangler types
node scripts/wrangler-test-config.mjs --ecrire
npx.cmd tsc --noEmit
npx.cmd biome check .
npm.cmd run audit
npm.cmd test
npx.cmd wrangler deploy --dry-run
PYTHONUTF8=1 ./.venv/Scripts/python.exe -m unittest discover -s pipeline/tests -q
```
