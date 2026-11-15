# GEMINI.md — MCP Législation (Québec et Canada)

Règles d'espace de travail pour **Google Antigravity** et **Gemini CLI** lors du développement sur le connecteur `mcp-legislation`.

> **Pourquoi ce fichier n'est pas une copie verbatim de [`CLAUDE.md`](CLAUDE.md)**
> 1. Antigravity tronque silencieusement tout fichier de règles au-delà de **24 000 octets** (plafond par fichier). [`CLAUDE.md`](CLAUDE.md) est plus volumineux — une copie identique amputerait la fin des invariants et les consignes sans avertissement.
> 2. La règle **R10** interdit les copies normatives susceptibles de dériver en silence.
> 3. La racine héberge le manifeste Gemini CLI [`gemini-extension.json`](gemini-extension.json), qui déclare `"contextFileName": []` afin de ne pas injecter ces consignes d'administration dans les sessions d'usage juridique normal du connecteur.
>
> **Obligation préalable :** Lire [`CLAUDE.md`](CLAUDE.md) **avant toute modification**. Ce document reste sous **24 000 octets** (épinglé par `tests/catalogue.test.mjs`) et ne recopie aucun décompte vivant du corpus ou des tests.

---

## 1. Rôle architectural et intégration dans le cadre global

`mcp-legislation` est le serveur MCP sécurisé d'accès officiel verbatim consolidé aux lois et règlements du Québec (via LégisQuébec) et du Canada (via Justice Canada LIMS, sous l'interrupteur `FEDERAL_CORPUS`), avec recherche hybride (FTS5 + Vectorize bilingue), déployé sur `https://legislation.poirierlavoie.ca/mcp`. Conformément à la règle R10, aucun décompte vivant du corpus n'est figé en dur dans ce document (les décomptes vivants dérivent de `laws.config.json`, de `pipeline/expected/served.json` et de D1).

```
             ┌────────────────────────────────────────────────────────┐
             │       pratique-civile-quebecoise (Plugin Cadre)        │
             │   5 compétences : recherche-juridique, analyse-doc,     │
             │  calendrier-proc, redaction-juridique, déontologie     │
             └──────┬───────────────────────┬──────────────────┬──────┘
                    │                       │                  │
   (10 outils `legislation_*`)    (10 outils `jurisprudence_*`) (6 outils `calendrier_*`,
                    │                       │           `interets_*`, `greffe_*`, `palais_*`)
                    ▼                       ▼                  ▼
         ┌─────────────────────┐ ┌─────────────────────┐ ┌──────────────────────────┐
         │   MCP-Legislation   │ │  MCP-Jurisprudence  │ │  pratique-civile-outils  │
         │  (Worker Cloudflare │ │ (Worker Cloudflare  │ │    (Worker Cloudflare    │
         │  D1 + Vectorize +   │ │  D1 cache CanLII    │ │    public, sans état,    │
         │    Workers AI)      │ │  authentifié Bearer │ │    zéro secret, Zod)     │
         └──────────┬──────────┘ └──────────┬──────────┘ └──────────────────────────┘
                    │                       │
                    └───────────┬───────────┘
                                ▼ (dépendance de dev `#v0.6.0`, zéro runtime dep)
                 ┌─────────────────────────────┐
                 │    MCP-Socle-Juridique      │
                 │  Transport JSON-RPC 2.0     │
                 │  Streamable HTTP sans état  │
                 │  Auth SHA-256 temps constant│
                 │  Zéro concept juridique     │
                 └─────────────────────────────┘
```

### Intégration avec les compétences du plugin (`pratique-civile-quebecoise`)
- **`skills/recherche-juridique`** : Consomme les 10 outils `legislation_*` comme source primaire de droit textuel. Suit le pattern d'utilisation en deux temps : Découverte (`legislation_find_relevant`, `legislation_list_laws`, `legislation_list_subjects`, `legislation_related_laws`), puis Extraction (`legislation_get_article`, `legislation_get_articles`, `legislation_get_structure`, `legislation_get_division`, `legislation_search_text`, `legislation_resolve_reference`). Nomme également l'ensemble des 10 outils `jurisprudence_*`, `greffe_parse_court_file_number`, `palais_list`, `palais_get` et `interets_compute_1619` (notamment dans `references/methode-sources.md`, `livrables.md`, `preliminaires.md`, `sources-doctrinales.md`), et mobilise les besoins d'aptitude `TEXTE`, `CALCUL`, `GREFFE`, `INSCRIPTION`. Transmet les lois et articles identifiés à `MCP-Jurisprudence` (`jurisprudence_citator` avec `rel="legislation"`).
- **`skills/redaction-juridique`** : Invoque explicitement `legislation_get_article` (dont `lang="en"` pour extraire la terminologie officielle anglaise des concepts québécois du C.c.Q. et du C.p.c. et purger la contamination de common law), `legislation_search_text`, `calendrier_compute_deadlines` et `interets_compute_1619`, sous les besoins d'aptitude `CALCUL` et `GREFFE`.
- **`skills/calendrier-procedural`** : Consomme `calendrier_compute_deadlines` et `calendrier_list_holidays` (avec repli local `scripts/calcul_delai.py`) sous les besoins `CALCUL`, `INSCRIPTION`, `TEXTE`. N'appelle aucun outil `legislation_*` directement (délègue la recherche législative et la prescription à `recherche-juridique`).
- **`skills/analyse-documentaire`** : Ne nomme AUCUN outil MCP directement. Exprime des besoins d'aptitude abstraits `GREFFE`, `TEXTE` et `INSCRIPTION`, en déléguant la recherche juridique et la vérification de citations à `recherche-juridique` et les délais à `calendrier-procedural`.
- **`skills/deontologie-professionnelle`** : Ne nomme AUCUN outil MCP directement ; délègue le droit substantiel et procédural hors déontologie à `recherche-juridique` et les délais à `calendrier-procedural`.
- **Configuration** : Connecté dans `.mcp.json` et `gemini-extension.json` via `https://legislation.poirierlavoie.ca/mcp` avec `Authorization: Bearer ${MCP_LEGISLATION_SECRET}`.

### Dépendances croisées inter-dépôts
- **`MCP-Socle-Juridique`** : Consomme `@poirierlavoie/socle-juridique#v0.6.0` en `devDependencies`. Avec `"SOCLE": "true"` dans `wrangler.jsonc`, les requêtes sur `/mcp` sont distribuées sans état par `servirRequeteMcp` via `src/routeur.ts`. Zéro dépendance d'exécution (`dependencies: {}`).
- **`MCP-Jurisprudence`** : Serveur jumeau partageant la même identité typographique (Georgia) et les mêmes variables CSS sur sa page publique `GET /`.
- **`pratique-civile-outils`** : Législation fournit le texte des dispositions procédurales et substantielles ; `pratique-civile-outils` exécute les calculs arithmétiques d'échéances et d'intérêts.

---

## 2. Évaluation d'impact obligatoire — Cinq surfaces locales (`README.md`, Page publique HTML) et inter-dépôts (R10)

Aucune tâche touchant ce dépôt n'est terminée tant que son impact sur les **cinq surfaces locales** et sur l'**axe inter-dépôts** n'a pas été évalué, répercuté dans le **même changement** et **explicitement rapporté** (« non touchée » avec justification, jamais passée sous silence — le coût en tokens n'exempte jamais de cette vérification) :

| # | Surface d'impact | Où | Ce qu'il faut évaluer et maintenir synchronisé |
|---|---|---|---|
| 1 | **Outils MCP** | `src/tools.ts`, `src/schemas.ts`, `src/routeur.ts` | noms `legislation_*`, paramètres, comportement, erreurs servies |
| 2 | **Descriptions et titres** | `src/tools.ts`, `src/serveur.ts` (`INSTRUCTIONS`/`PUBLIC_DESCRIPTION`), `catalogue.json` | R3 borne le delta à ≤ 2 phrases et exige de consigner le delta de tokens |
| 3 | **Schéma** | `schema.sql`, `schema-decouverte.sql`, `migrations/`, `src/schemas.ts`, `structuredContent` | toute étiquette limitative voyage en champ obligatoire (R4, décision 001) ; `outputSchema` reste absent |
| 4 | **`README.md`, gouvernance et manifestes** | `README.md`, `SECURITY.md`, `LICENSE` (`CC-BY-NC-SA-4.0`), `package.json`, `plugin.json`, `mcp_config.json`, `gemini-extension.json`, `/mcp/server-card`, `CLAUDE.md`, `GEMINI.md`, `tests/catalogue.test.mjs` | ce que le dépôt annonce faire, ses consignes de connexion, sa licence et sa politique sécurité/confidentialité |
| 5 | **Page publique HTML (`GET /`)** | `catalogue.json` + `src/site.ts` (`tests/page-client.test.mjs`, `tests/catalogue.test.mjs`) | rendu bilingue FR/EN de `GET /`, décomptes lus en D1, constantes importées de `src/relevance.ts`, titres issus de `catalogue.json`, section `#acces`, licence et clause de non-conseil |
| 6 | **Inter-dépôts (`Cross-repository`)** | **`pratique-civile-quebecoise`** (`.mcp.json`, `mcp_config.json`, `gemini-extension.json`, `.claude-plugin/*`, `plugin.json`, `skills/`, `regenerer_cache_mcp.py --apply`, `synchroniser_plugin_gemini.py --apply`, `verifier.py`, `verifier_tout.py`), **`MCP-Socle-Juridique`** (`#v0.6.0`), **`MCP-Jurisprudence`** (jumeau HTML/CSS), **`pratique-civile-outils`** | répercussions sur les outils nommés à la main dans les compétences, la cohérence de transport/auth ou le style partagé des pages HTML |

`docs/` est une archive datée par défaut (ne fait pas foi sur l'état courant), à l'exception des références techniques citées par le code (`docs/phase0-structure-epub.md`, `docs/phase0-structure-lims.md`).

---

## 3. Contrat de vérité et règles de conception (R2–R10)

- **Outil juridique :** Un résultat faux rendu en silence est le pire défaut possible — **refuser vaut toujours mieux que deviner**.
- Le texte des articles provient des EPUB officiels de **LégisQuébec** et des XML LIMS de **Justice Canada** ; il est restitué **verbatim**, sans jamais altérer le contenu officiel.
- **Sortie double :** Prose descriptive dans `content[0].text` et données plates dans `structuredContent`. Aucun `outputSchema` publié dans `tools/list` pour préserver le budget de jetons de contexte.
- **R2** : Aucun nouvel outil MCP sans approbation explicite.
- **R3** : Delta de description d'outil ≤ 2 phrases ; consigner le coût en tokens.
- **R4** : Toute aide éditoriale est visiblement étiquetée non officielle ; la garde `GARDE_FOU` de `legislation_find_relevant` est imposée mot pour mot.
- **R7** : Fail open toujours annoncé explicitement (étiquettes d'élargissement, de relaxation et de repérage sémantique).
- **R8** : Chemins sensibles derrière variables d'environnement (`RELAX_SEARCH`, `HYBRID_SEARCH`, `FEDERAL_CORPUS`).
- **R9** : Réponse de recherche ~≤ 800 tokens en régime normal.
- **R10** : Aucun décompte vivant (lois, matières, articles) écrit à la main en prose ; tout décompte dérive de D1 ou de `src/relevance.ts`.

---

## 4. Synthèse des 18 invariants critiques (détails dans `CLAUDE.md`)

1. **Ordre porteur de `laws.config.json`** : Plages d'identifiants dérivées de la position ; ajouter uniquement en fin de liste (`pipeline/tests/test_config.py`).
2. **`sortKeyOf()` (`src/lib.ts`) et `sort_key()` (`pipeline/model.py`)** sont des miroirs exacts (`test/ranges.test.mjs`).
3. **Chargement monolingue** : L'UPSERT de `laws` n'écrase jamais l'autre langue ni sa citation officielle.
4. **Chemins Irosoft propres à la langue** : Traversée entre langues via `translateDivisionPath` / `translatePaths`.
5. **Pas de `LIKE`/`GLOB` sur `divisions.path`** : Utiliser l'intervalle lexicographique `subtreeClause`.
6. **Limites D1** : Lots SQL ≤ 100 Ko UTF-8 ; sauvegarde Time Travel avant toute migration.
7. **Échelle de recherche & plancher** : Exact → élargissement corpus → leave-one-out (`RELAX_MIN_LOO_TOTAL`) → OU+bm25, puis RRF avec Vectorize, puis sémantique seul sous `SEMANTIC_MIN_SCORE`.
8. **Vectorize** : Identifiants ≤ 64 octets (hachage court), index de métadonnées créés avant insertion.
9. **WAF de zone** : Bloque les rafales de `POST` de backfill sur le domaine personnalisé.
10. **Sessions MCP** : Transport sans état sous `SOCLE=true`.
11. **Windows / Git Bash** : Tout patch contenant des barres obliques inverses passe par un fichier script.
12. **Calibration continue** : Pondérations sans seuil discontinu dépendant du nombre de lois ou de la longueur de la requête.
13. **`description` de matière (`taxonomy.json`)** : Surface d'appariement sans négation ni mention contrastive.
14. **Préfixe de mot borné (`MAX_SUFFIX`)** dans `src/relevance.ts`.
15. **Plafond de diversité par matière (`MAX_PER_SUBJECT`)** hors signaux S2/S3/S4.
16. **Vérité terrain (evals)** : Ne jamais modifier `eval/cases.json` ni le contenu éditorial sans décision du praticien.
17. **Corpus fédéral (`pipeline/parser_lims.py`)** : Descendre `Body` et `Schedule` explicitement ; portée arrêtée (hors Code criminel, LIR, lois constitutionnelles).
18. **`label` de matière (`taxonomy.json`)** : Motif servi par `legislation_find_relevant` ; vérifier l'étendue des divisions avant rattachement.

---

## 5. Contrôle d'accès `/mcp`, CORS et fiche SEP-2127

- **Fermé par défaut** (`src/auth.ts`, `src/index.ts`) : `MCP_ENABLED` doit valoir `"true"`, et `NOMS_SECRETS` (`PORTE`) liste les secrets admis.
- **Trois porteurs équivalents** : `Authorization: Bearer <jeton>`, `?key=<jeton>` et `/mcp/<jeton>`.
- **Refus sur `/mcp*` en `404` (jamais `401`)** : Un `401` déclenche la découverte OAuth non souhaitée des clients.
- **Origines CORS** : `https://claude.ai`, `https://claude.com`, `https://gemini.google.com`, `https://aistudio.google.com`.
- **Exception publique SEP-2127** : `GET /mcp/server-card` sert la fiche sans secret (`Access-Control-Allow-Origin: *`).

---

## 6. Secrets et sécurité

- **Interdiction absolue** de lire, afficher ou copier : `cf.token`, `mcp.token`, `mcp-veille.token`, `backfill.token`, `*.token`, `mcp.url`, `.dev.vars`, `.env*`, `~/.gemini/config/mcp_config.json`.
- **Interdiction absolue** d'exécuter `wrangler d1 delete` depuis un agent.
- Ne pas inscrire de motif de jeton dans le HTML généré par `src/site.ts`.

---

## 7. Commandes sûres (PowerShell Windows)

Employer `npm.cmd` et `npx.cmd`. Toujours exécuter `npm.cmd test` :

```powershell
npx.cmd wrangler types
npx.cmd tsc --noEmit
npx.cmd biome check .
npm.cmd test
npx.cmd wrangler deploy --dry-run
```

**Déploiement continu sur `main` :** Déclenché par `.github/workflows/deploy.yml` (`scripts/deployer.mjs` : migrations D1 puis `wrangler deploy`).
