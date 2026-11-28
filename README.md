# Lois du Québec et du Canada — serveur MCP

Serveur [MCP](https://modelcontextprotocol.io) d'intérêt public en **lecture seule** et sans journalisation, réservé gratuitement aux membres actifs en règle du Barreau du Québec via [`acces.poirierlavoie.ca`](https://acces.poirierlavoie.ca) (**aucune clé API CanLII requise**), donnant aux assistants IA un accès verbatim au texte officiel de **134 lois, règlements et directives** : la législation du Québec (dont le Code civil du Québec et le Code de procédure civile), les lois fédérales pertinentes en litige civil et pénal québécois — Lois constitutionnelles de 1867 et de 1982 (dont la Charte canadienne des droits et libertés), faillite, divorce, sociétés par actions et organisations à but non lucratif, brevets, droit d'auteur, marques de commerce et dessins industriels, preuve, Cours fédérales, Cour suprême, ainsi que le silo pénal isolé (`Code criminel`, drogues et justice pour les adolescents) — et les directives de pratique des tribunaux du Québec (Cour supérieure, Cour du Québec) et des textes de l'Autorité des marchés financiers (AMF). En **français et en anglais** (les directives et textes PDF sont en français seulement lorsqu'aucune version anglaise officielle n'existe), avec dates de consolidation, hiérarchie complète (Livres → Titres → Chapitres → dispositions ou paragraphes) et recherche plein texte.

> **In English:** Read-only public-interest MCP server providing AI assistants with verbatim access to Québec statutes and regulations, federal statutes relevant to Québec civil and criminal litigation (with the *Criminal Code*, *CDSA*, and *YCJA* isolated in the `penal` domain), Québec court practice directives, and AMF securities texts (French and English where officially published). Part of [`droit-civil-quebecois`](https://github.com/jpoirierlavoie/droit-civil-quebecois); free access reserved for active members in good standing of the Barreau du Québec via [`acces.poirierlavoie.ca`](https://acces.poirierlavoie.ca) (**no CanLII API key required**). Query text is never logged.

- **Page publique :** <https://legislation.poirierlavoie.ca/> (outils, méthodes de repérage, liste complète des textes et matières, en français et en anglais)
- **Connexion OAuth 2.1 (par défaut via le greffon) :** `https://legislation.poirierlavoie.ca/mcp/oauth`
- **Connexion directe par jeton (scripts et clients autonomes) :** `https://legislation.poirierlavoie.ca/mcp`

Source des données : les publications officielles de [LégisQuébec](https://www.legisquebec.gouv.qc.ca) (Éditeur officiel du Québec), du ministère de la Justice du Canada, et les PDF officiels publiés par les tribunaux du Québec (Cour supérieure, Cour du Québec) et l'AMF (règlements `V-1.1, r. 10`, `r. 21`, `r. 24` et *Instructions générales*). Le serveur restitue le texte officiel **sans altération**.

## Accès

Ce serveur est réservé aux membres actifs en règle du Barreau du Québec. La gestion des demandes d'accès et des jetons individuels s'effectue sur <https://acces.poirierlavoie.ca/demande> et <https://acces.poirierlavoie.ca/moi> (ou par courriel à <jason@poirierlavoie.ca>) : chaque titulaire dispose de son propre accès révocable indépendamment. Aucune clé API CanLII n'est requise pour consulter la législation ou les outils (la clé CanLII demeure facultative à l'inscription et n'est exigée que pour `juris`). Aucun texte de requête n'est journalisé.

Le code source et les scripts d'ingestion sont publiés gratuitement sous licence `Apache-2.0`.

### Se connecter

- **Via le greffon complet [`droit-civil-quebecois`](https://github.com/jpoirierlavoie/droit-civil-quebecois) (méthode recommandée) :** Claude Code, Claude Desktop, `claude.ai`, Google Antigravity, Gemini CLI et Gemini App se connectent automatiquement par navigateur en OAuth 2.1 sur `https://legislation.poirierlavoie.ca/mcp/oauth` via `acces.poirierlavoie.ca`, sans variable secrète à configurer.
- **Via jeton individuel (ligne de commande, scripts, API Gemini Deep Research ou installation autonome de ce dépôt) :** utiliser `https://legislation.poirierlavoie.ca/mcp` avec l'en-tête `Authorization: Bearer <jeton>` créé dans `/moi` (sur `/mcp`, toute requête sans jeton valide reçoit `404` sans corps).
- **Portées OAuth 2.1 / jeton acceptées :** `"tous"` (portée universelle par défaut sur `acces.poirierlavoie.ca`), `"legislation"` (portée spécifique au service) et `"les_deux"` (portée héritée rétrocompatible). Les métadonnées RFC 9728 de `/mcp/oauth` sont publiées sur `https://legislation.poirierlavoie.ca/.well-known/oauth-protected-resource/mcp/oauth`.

| Client | Mode | Adresse à saisir |
|---|---|---|
| Greffon `droit-civil-quebecois` (`claude.ai`, Claude Code/Desktop, Antigravity, Gemini) | OAuth 2.1 | `https://legislation.poirierlavoie.ca/mcp/oauth` |
| Scripts, API, installation autonome avec jeton | En-tête `Authorization: Bearer <jeton>` | `https://legislation.poirierlavoie.ca/mcp` |
| Formulaire web sans OAuth (`claude.ai` en mode jeton) | Paramètre de requête | `https://legislation.poirierlavoie.ca/mcp?key=<jeton>` |

- **Installation autonome de ce seul dépôt (sans le greffon `droit-civil-quebecois`) :**
  - **Google Antigravity** (`plugin.json`, `mcp_config.json`) : `agy plugin install https://github.com/jpoirierlavoie/MCP-Legislation.git`, puis se connecter en OAuth 2.1 dans le navigateur via `acces.poirierlavoie.ca` (sans variable secrète à configurer).
  - **Gemini CLI** (`gemini-extension.json`) : `gemini extensions install https://github.com/jpoirierlavoie/MCP-Legislation`, puis se connecter en OAuth 2.1 dans le navigateur via `acces.poirierlavoie.ca`. (`"contextFileName": []` évite d'injecter `GEMINI.md` dans vos sessions.)
- **Note technique sur `?key=` et le chemin URL :** lorsque la connexion se fait par jeton dans un outil en ligne de commande ou un backend, privilégier l'en-tête `Authorization: Bearer <jeton>` afin que le jeton n'apparaisse pas dans une URL. La forme `?key=<jeton>` est prise en charge pour les formulaires web de connecteurs à jeton ; la forme en segment de chemin `https://legislation.poirierlavoie.ca/mcp/<jeton>` est également acceptée mais déconseillée dans les formulaires web.
- **Découverte HTTP (SEP-2127) :** `GET https://legislation.poirierlavoie.ca/mcp/server-card` et `GET https://legislation.poirierlavoie.ca/.well-known/mcp/server-card.json` (`application/mcp-server-card+json`).
- **Transport :** HTTP streamable sans état (`POST /mcp` ; `GET` et `DELETE` refusés en `405`).
- **Codes d'erreur courants :** `429` (cadence par minute dépassée, réessayer après `Retry-After`), `404` sur `/mcp` ou `401` sur `/mcp/oauth` (jeton absent, expiré ou révoqué), `200 [QUOTA_EPUISE]` (plafond journalier UTC atteint).

## Le corpus

| Catégorie | Textes |
|---|---|
| Codes | Code civil du Québec, Code de procédure civile |
| Lois sectorielles | Chartes (droits et libertés, langue française), protection du consommateur, assurance automobile, curateur public, notariat, commissions d'enquête, travail et SST (normes, Code du travail, TAT, LATMP, LSST), renseignements personnels (Loi 25) et accès aux documents publics, valeurs mobilières (dont `V-1.1, r. 10`, `r. 21` et `r. 24` tirés des PDF officiels de l'AMF, `fonction='reglement'`), assureurs, fiducies, coopératives de services financiers, police et déontologie policière, bâtiment (Code de construction, Code de sécurité), courtage immobilier, municipal/aménagement/environnement (cités et villes, compétences municipales, LAU, LQE, LPTAA, fiscalité et éthique), expropriation, contrats des organismes publics et municipaux, fonction publique, procédure pénale et droit criminel fédéral (`Code criminel`, `LRCDAS`, `LSJPA`, en domaine `penal`)… |
| Règles de procédure | Règlements et règles des cours (Cour suprême, appel, supérieure, Québec, Cours fédérales), du TAT, du TAQ, du TAL, du TAMF, de la déontologie policière et de la Régie du bâtiment |
| Tarifs | Tarif judiciaire, tarifs du TAQ, du TAL et du TAMF |
| Directives judiciaires | Directives de pratique de la Cour supérieure (Montréal — District et Division — et Québec) et de la Cour du Québec (règles simplifiées, pratique civile et administrative à Montréal, liste commune DAA) — source PDF, non législatives, français seulement |
| Orientations (AMF) | *Instructions générales* 31-103, 45-106 et 51-102 de l'Autorité des marchés financiers — source PDF, indicatives et sans force de loi, français seulement |

Les décomptes exacts (dates de consolidation, répartition) sont calculés
en base et affichés sur la [page publique](https://legislation.poirierlavoie.ca/) ainsi que
par l'outil `list_laws`. Rafraîchissement semestriel.

**Ce que le corpus NE couvre PAS, et qu'il vaut mieux savoir avant d'en avoir besoin.**
Le corpus sert le **droit en vigueur**, dans sa version consolidée courante — il n'y a ni
versions antérieures, ni point de vue historique. En particulier, l'**ancien Code de
procédure civile** (RLRQ, c. C-25), abrogé et remplacé le 1er janvier 2016 par le Code
actuel (c. C-25.01), **n'y figure pas** : c'est une décision de portée, pas un oubli.
Comme la recodification a **renuméroté** le code, l'article N de l'ancien n'est pas
l'article N du nouveau — aussi `resolve_reference` refuse-t-il NOMMÉMENT une
citation de l'ancien code (« ancien C.p.c. », « c. C-25 », « C.p.c. de 1965 ») plutôt que de
la rabattre en silence sur son successeur. Côté fédéral, la portée couvre 24 lois et 3 règlements
— dont les Lois constitutionnelles de 1867 et de 1982 ainsi que le silo criminel fédéral
(`Code criminel`, `LRCDAS`, `LSJPA`, placé en quarantaine par défaut hors de `core`) — et exclut
la Loi de l'impôt sur le revenu.

## Les 10 outils

Le patron d'usage est en deux temps : **s'orienter** (découverte), puis **extraire**.

### Découverte

| Outil | Rôle | Exemple |
|---|---|---|
| `find_relevant` | Le routeur : d'un problème en langage libre vers les lois et chapitres candidats (`core` par défaut ; `domains`, `jurisdiction`, `forum` + radar `other_domains`), avec le *pourquoi* de chaque rapprochement | `« vice caché »` → C.c.Q. Livre 5 (Obligations) + L.p.c. |
| `list_laws` | Carte du corpus : noms FR/EN, citation RLRQ, dates, matières, domaine, loi habilitante, plan des grands codes ; filtres `domains`/`jurisdiction`/`fonction`/`forum`/`subject` (`core` par défaut ; `domains=["all"]` pour les 8 domaines) | `fonction=tarif, domains=["all"]` → les 4 tarifs |
| `list_subjects` | Les 50 matières de la taxonomie (droit privé du C.c.Q. + matières spécialisées), bilingues | — |
| `related_laws` | Graphe d'une loi : règlements pris sous elle, loi habilitante, renvois, relations curées (`preseance-sur`, `interprete`…) | `law=cpc` → ses 6 règlements de cour |

### Extraction

| Outil | Rôle | Exemple |
|---|---|---|
| `get_article` | Un article ou paragraphe verbatim, avec citation, hiérarchie, historique, statut normatif, liens d'annexe et date | `law=ccq, article=1457` ou `law=amf-ig-45-106, article=2A.1` |
| `get_articles` | Plage (`from`/`to`) ou liste (`numbers`) d'articles, paginée, avec date de consolidation et signalement des numéros introuvables (`missing_numbers`) | `law=cpc, from=489, to=496` |
| `get_structure` | L'arbre des divisions, sans texte — pour explorer avant d'extraire | `law=ccq, depth=2` |
| `get_division` | Une division (Livre/Titre/Chapitre…) : intitulé, sous-divisions, articles | `path=ga:l_cinquieme` |
| `search_text` | Recherche hybride dans le texte des articles (voir ci-dessous) | `« délai réponse défendeur hors du Québec »` |
| `resolve_reference` | D'une citation libre vers l'article ou paragraphe officiel ; reconnaît chapitres RLRQ, C.c.Q./C.p.c., abréviations fédérales (`L.F.I.`, `L.C.S.A.`, `L.A.C.C.`, `L.D.`…), `par.`/`dir.` (C.S./C.Q.) et `IG 45-106` | `« RLRQ, c. T-16, art. 12 »` |

## La recherche, en détail

`search_text` combine deux approches et **dit toujours comment il a trouvé chaque résultat** :

1. **Recherche par mots exacts (FTS5, insensible aux accents)** — correspondance exacte d'abord ; si une
   recherche restreinte à une loi ne donne rien, elle est automatiquement **élargie à l'ensemble du
   corpus** ; sinon l'échelle de **relaxation** s'applique progressivement (retrait d'un terme à la fois,
   puis recherche pondérée `bm25` sur un seul terme), chaque étape étant clairement étiquetée
   (*« résultats approchés (terme ignoré : « hors ») »*). La recherche continue tant qu'un palier ne rend
   pas assez de résultats (car le moteur lexical ne relie pas automatiquement « garantie » à « garantir »).
2. **Recherche par sens (index vectoriel multilingue)** — fusionnée à la recherche lexicale par classement réciproque (RRF) ; elle relie les synonymes (*« congédiement »* trouve *« délai de congé »*) et traverse la barrière linguistique (une requête en anglais trouve le texte français). Les résultats issus du seul chemin sémantique sont marqués *« (repérage sémantique) »*. Chaque titulaire peut désactiver l'option d'IA sémantique dans son compte (<https://acces.poirierlavoie.ca/moi>) pour s'en tenir aux mots exacts sur la base locale (`hybride_permis = 0`).

Chaque résultat affiche son fil d'Ariane complet : `C.p.c. — Livre V, Titre IV : LES DEMANDES
INTÉRESSANT LE DROIT INTERNATIONAL PRIVÉ › art. 490 [ga:l_v-gb:l_iv-gc:l_i]` + extrait.

Trois compteurs accompagnent la réponse : `total` compte les correspondances **par mots exacts** dans tout le corpus, `returned` la taille de la page affichée, et `sources` départage les résultats lexicaux des résultats par sens. Un `total` de 1 avec cinq résultats signifie donc un résultat par mots exacts et quatre résultats voisins par le sens. Les résultats corpus sont regroupés par loi (max 6 par loi).

## Avertissement

L'aide au repérage (`find_relevant`, taxonomie, relations) est **heuristique** :
elle ne détermine pas le droit applicable. Toujours vérifier en lisant le texte via
`get_structure` / `get_division` / `get_article`.
Ce serveur ne fournit pas de conseil juridique ; en cas de doute, consulter la version
officielle du publieur (LégisQuébec, Justice Canada, tribunaux du Québec ou AMF — les directives de pratique et *Instructions générales* étant des textes non législatifs) et un professionnel du droit.

## Pour les développeurs

```
src/            Worker Cloudflare (TypeScript) : outils MCP, recherche, D1/Vectorize
pipeline/       Ingestion Python : EPUB LégisQuébec, XML LIMS Justice Canada et PDF (QCCS/QCCQ/AMF) -> D1 (staging -> validation -> bascule)
data/           Données versionnées (laws.config.json, catalogue.json, taxonomy.json, relations.json, tools-list.reference.json, schema.sql, schema-decouverte.sql)
migrations/     Migrations D1 — s'appliquent PAR-DESSUS data/schema.sql, qui décrit l'état
                INITIAL et non l'état courant (procédure complète : CLAUDE.md)
test/, eval/    contrôles bout-en-bout + harnais d'évaluation (21 cas, recall@10/MRR)
docs/           Spécifications de phase 0 (formats EPUB, LIMS, PDF)
```

Démarrage : `npm install`, puis `npx wrangler dev --var MCP_TOKEN:local-a --var
MCP_TOKEN_VEILLE:local-b` — **les `--var` sont requis** : l'endpoint est fermé par défaut,
sans secret il refuse tout. Puis `MCP_TOKEN=local-a npm run evals` contre
`http://127.0.0.1:8787/mcp`. Les manifestes clients vivent à la racine (`plugin.json`,
`mcp_config.json`, `gemini-extension.json`). **Avant toute modification, lire
[CLAUDE.md](CLAUDE.md)** (et [GEMINI.md](GEMINI.md) sous Antigravity / Gemini CLI) —
les invariants critiques du dépôt y sont consignés (ordre de la config, miroirs de clés
de tri, limites D1/Vectorize, échelle de recherche).

**Déploiement continu :** tout `push` sur `main` déclenche
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) dans l'environnement GitHub
`production` (`CLOUDFLARE_API_TOKEN` requis côté GitHub), qui exécute la porte de tests,
bootstrappe une D1 vierge puis lance **`npm run deploy`** (`scripts/deployer.mjs` :
migrations D1 `--remote` d'abord, puis déploiement du Worker avec `--var COMMIT:<sha>`),
suivi d'une vérification vivante de `/health`, `/mcp/server-card` et `/`. En repli local,
employer **`npm run deploy`** (et jamais `wrangler deploy` seul).

**Rafraîchissement du corpus en deux étapes :** le workflow
[`.github/workflows/rafraichir-corpus.yml`](.github/workflows/rafraichir-corpus.yml)
orchestre [`pipeline/refresh.py`](pipeline/refresh.py) sans écriture non surveillée en
production : l'étape 1 (`preparer`, en lecture seule sur planification mensuelle ou
déclenchement manuel) valide les sources en staging, calcule le diff incrémental et publie un
artefact + commentaire récapitulatif ; l'étape 2 (`appliquer`, sur `workflow_dispatch` manuel
dans l'environnement GitHub `production` avec `confirmer=APPLIQUER`) bascule uniquement les
lois modifiées dans D1, lance la synchronisation incrémentale Vectorize
(`npm run backfill:incremental`, secret `BACKFILL_TOKEN` requis côté GitHub) et bloque tout
relais sans validation via la porte d'évaluation (`npm run eval:gate`).

**Toute modification doit évaluer son impact sur CINQ surfaces** — outils MCP,
descriptions, schéma, ce README et la [page publique](https://legislation.poirierlavoie.ca/)
(`data/catalogue.json`) — et inclure les mises à jour requises dans le même commit. C'est une
condition de fin de tâche, pas une recommandation : voir l'obligation préalable en tête de
[CLAUDE.md](CLAUDE.md). Garde en CI : **`npm test`** — la suite vitest à deux
projets, qui porte notamment la parité outils ↔ documentation (`test/catalogue.test.mjs`) et
le comportement du JS de la page sans navigateur (`test/page-client.test.mjs`). C'est bien
cette commande unique que lance `.github/workflows/ci.yml`.

Trajectoire mesurée du repérage : recall@10 **40 % → 88 % → 98 %**.

## Auto-hébergement d'une fourche autonome / Self-hosting a standalone fork

Ce dépôt fonctionne de manière entièrement autonome sans l'infrastructure centrale de gestion d'accès (`MCP-Acces` / `DB_IDENTITE`) :

1. **Base D1, schémas embarqués et corpus :** Créez votre base Cloudflare D1 (`wrangler d1 create legislation`), renseignez son `database_id` dans `wrangler.jsonc`, appliquez les schémas et migrations embarqués (`data/schema.sql`, `migrations/` et `data/schema-decouverte.sql`), puis alimentez la base avec le pipeline Python (`pipeline/ingest.py`). Les liaisons Vectorize (`VECTORS`) et Workers AI (`AI`) sont facultatives si vous fixez `HYBRID_SEARCH = "0"`.
2. **Omettre `DB_IDENTITE` et ajuster le routage (`wrangler.jsonc`) :** Supprimez ou omettez le bloc D1 `DB_IDENTITE` dans `wrangler.jsonc` (`env.DB_IDENTITE` devient `undefined` — le Worker bascule alors sur l'authentification par secret statique sans `MCP-Acces` ni perte de fonctionnalité). Comme `wrangler.jsonc` fixe par défaut `"workers_dev": false` et `"routes"` sur `legislation.poirierlavoie.ca`, passez à `"workers_dev": true` et retirez ou adaptez `"routes"` pour déployer sur `*.workers.dev` (ou votre propre domaine).
3. **Activer le serveur et définir un secret statique :** Fixez `MCP_ENABLED = "true"` dans `wrangler.jsonc` et enregistrez votre secret de repli avec `npx wrangler secret put MCP_TOKEN` (vous pouvez aussi définir `MCP_TOKEN_VEILLE` pour une rotation sans interruption).
4. **Connexion cliente :** Déployez (`npx wrangler deploy`) puis connectez votre client MCP sur `https://<votre-worker>.workers.dev/mcp` (ou votre domaine personnalisé) avec l'en-tête `Authorization: Bearer <jeton>` (où `<jeton>` est votre `MCP_TOKEN`). Les requêtes sans jeton reçoivent `404`.

> **English:** This repository is self-contained with bundled SQL schemas/migrations and runs standalone without `droit-civil-quebecois`, `MCP-Acces`, or `DB_IDENTITE`: create your D1 database (`legislation`), apply `data/schema.sql`, `migrations/`, and `data/schema-decouverte.sql`, seed it via `pipeline/ingest.py` (Vectorize/`AI` are optional if `HYBRID_SEARCH = "0"`), omit the `DB_IDENTITE` D1 binding from `wrangler.jsonc`, change `"workers_dev": false` to `"workers_dev": true` and remove or update `"routes"` (currently set for `legislation.poirierlavoie.ca`) in `wrangler.jsonc`, set `MCP_ENABLED = "true"`, add `MCP_TOKEN` (and optionally `MCP_TOKEN_VEILLE`) with `npx wrangler secret put MCP_TOKEN`, deploy, and point your MCP client to `https://<your-worker>.workers.dev/mcp` (or your custom domain) using `Authorization: Bearer <jeton>` (unauthenticated calls return an empty `404`).

## Sécurité, confidentialité et licence

- **Sécurité, vie privée et secret professionnel :** Aucun texte de requête ni argument d'outil n'est journalisé à l'exécution (journaux d'invocation Cloudflare désactivés, zéro écriture dans `search_log`, télémétrie strictement bornée à `compteur_jour` et `evenement_technique` sans contenu dans `DB_IDENTITE`). Consulter [`SECURITY.md`](SECURITY.md) pour signaler de manière privée et coordonnée toute vulnérabilité ou question de confidentialité / secret professionnel à Jason Poirier Lavoie (`jason@poirierlavoie.ca`), sans ouvrir d'issue publique ni joindre de renseignements confidentiels de clients.
- **Licence :** Le logiciel, les schémas, le pipeline et la documentation originale (élaborés en grande partie avec l'assistance de l'IA pour l'intérêt public) sont publiés gratuitement sous licence **`Apache-2.0`** ([`LICENSE`](LICENSE)). Aucun droit d'auteur n'est revendiqué sur les textes servis, qui demeurent soumis aux régimes de l'Éditeur officiel du Québec (LégisQuébec), de la Licence du gouvernement ouvert – Canada (Justice Canada), ainsi que des tribunaux du Québec (Cour supérieure, Cour du Québec) et de l'Autorité des marchés financiers (AMF) — voir [`NOTICE`](NOTICE).
