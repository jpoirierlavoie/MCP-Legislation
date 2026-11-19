# Lois du Québec et du Canada — serveur MCP

Serveur [MCP](https://modelcontextprotocol.io) donnant aux assistants IA un accès **en
lecture seule** au texte officiel de **110 lois, règlements et directives** : la législation du Québec
(dont le Code civil du Québec et le Code de procédure civile), 18 textes fédéraux que le
litige civil québécois convoque — faillite, divorce, sociétés par actions, droit d'auteur,
preuve, Cours fédérales — ainsi que les directives de pratique des tribunaux du Québec (QCCS, QCCQ) et des textes AMF en valeurs mobilières. En **français et en anglais** (les textes PDF de la vague 1 sont publiés en français seulement lorsqu'aucune version officielle anglaise n'existe), avec dates de consolidation, hiérarchie complète (Livres → Titres → Chapitres →
articles ou paragraphes) et recherche hybride lexicale + sémantique.

**Page publique :** <https://legislation.poirierlavoie.ca/> — outils, aides au repérage,
corpus et matières, en français et en anglais, avec les décomptes lus en base.

**Point d'accès MCP :** `https://legislation.poirierlavoie.ca/mcp` (jeton direct, refus `404`)
et `https://legislation.poirierlavoie.ca/mcp/oauth` (OAuth 2.1 PKCE S256 via
<https://acces.poirierlavoie.ca>) — **accès réservé aux membres en règle du Barreau du Québec, un jeton individuel par titulaire**.

Source des données : les EPUB officiels de [LégisQuébec](https://www.legisquebec.gouv.qc.ca)
(Éditeur officiel du Québec), les fichiers XML du ministère de la Justice du Canada, et les PDF officiels publiés par les tribunaux du Québec (Cour supérieure, Cour du Québec) et l'Autorité des marchés financiers (AMF — règlements `V-1.1, r. 10`, `r. 21`, `r. 24` et *Instructions générales*). Le texte des articles et dispositions est restitué **verbatim** — le serveur
n'altère jamais le contenu officiel.

## Accès

Ce serveur est réservé aux membres en règle du Barreau du Québec. Chaque titulaire approuvé dispose de ses propres jetons individuels dans la base d'identité partagée (`mcp-identite`), révocables séparément depuis l'espace libre-service <https://acces.poirierlavoie.ca/moi> : renouveler ou révoquer l'un ne perturbe aucun autre confrère. Sur `/mcp`, une requête sans jeton valide reçoit `404` sans corps (jamais `401` — un `401` déclencherait une découverte OAuth non sollicitée sur les clients à jeton direct). Les hôtes compatibles OAuth 2.1 utilisent le sous-chemin dédié `/mcp/oauth`.

Pour demander un accès : <https://acces.poirierlavoie.ca/demande> (ou <jason@poirierlavoie.ca>). Le code source est public et le
corpus reproductible — pipeline d'ingestion, taxonomie et données de configuration sont
tous versionnés ici.

### Se connecter

Deux montages coexistent selon le client :

| Client | Montage | À écrire |
|---|---|---|
| Claude Desktop, claude.ai, ChatGPT / Codex (OAuth 2.1 PKCE S256) | OAuth 2.1 | `https://legislation.poirierlavoie.ca/mcp/oauth` (métadonnées RFC 9728 sur `GET /.well-known/oauth-protected-resource/mcp/oauth`) |
| Claude Code, Google Antigravity, Gemini CLI, CI | Jeton direct par en-tête | `https://legislation.poirierlavoie.ca/mcp` + `Authorization: Bearer <jeton>` |
| Connecteur claude.ai (mode jeton direct transitoire) | Paramètre de requête | `https://legislation.poirierlavoie.ca/mcp?key=<jeton>` |

- **Google Antigravity** (`plugin.json`, `mcp_config.json`, `assets/logo.svg` à la racine) :
  installer via `agy plugin install https://github.com/jpoirierlavoie/MCP-Legislation.git`
  (ou copier les fichiers du greffon dans `~/.gemini/config/plugins/mcp-legislation`),
  renseigner la variable `MCP_LEGISLATION_SECRET` sur la page du greffon puis l'activer —
  les outils se chargent à la demande (*lazy*) par défaut, sans contexte additionnel hors les
  `INSTRUCTIONS` canoniques du serveur.
- **Gemini CLI** (`gemini-extension.json`) : installer via
  `gemini extensions install https://github.com/jpoirierlavoie/MCP-Legislation` et saisir
  `MCP_LEGISLATION_SECRET` (stocké de façon sensible). Le manifeste déclare
  `"contextFileName": []` afin que `GEMINI.md` (réservé au développement de ce dépôt) ne
  soit pas injecté dans les sessions d'usage général.
- **Gemini web** : les origines `https://gemini.google.com` et `https://aistudio.google.com`
  sont admises par défaut dans CORS, aux côtés de `https://claude.ai` et
  `https://claude.com`.
- **Découverte HTTP (SEP-2127)** : la fiche publique de connectivité est exposée sans secret
  sur `GET https://legislation.poirierlavoie.ca/mcp/server-card`
  (`application/mcp-server-card+json`), soumise au coupe-circuit `MCP_ENABLED` (tandis que
  `/mcp` continue de répondre `404` sans jeton valide).

**Pour le connecteur claude.ai, employer `?key=`** : c'est la forme mesurée en production.
**Pour un backend qui ouvre lui-même sa session, employer l'en-tête** — c'est la seule des
trois qui ne fait jamais voyager le jeton dans une URL, donc la seule qui ne le laisse
jamais dans un journal de requêtes. La troisième forme, le segment de chemin
`https://legislation.poirierlavoie.ca/mcp/<jeton>`, est acceptée et testée mais n'est la
forme d'aucun client aujourd'hui : elle a échoué dans le formulaire de claude.ai alors
qu'une session complète y passe en `curl`.

Le transport est **HTTP streamable sans état** (`POST /mcp`, sans en-tête `mcp-session-id` ni ouverture de session côté serveur). Les requêtes `GET /mcp` et `DELETE /mcp` (y compris authentifiées) sont rejetées en `405` ; ce serveur n'émet aucune notification serveur→client.

Trois réponses de garde à connaître :

- **429** — cadence par minute trop élevée (limiteur pré-auth par IP ou post-auth par titulaire). Réessayer après `Retry-After`.
- **404** (sur `/mcp`) ou **401** RFC 9728 (sur `/mcp/oauth`) — jeton absent, inconnu, hors portée, expiré ou révoqué.
- **200 `isError: true` `[QUOTA_EPUISE]`** — plafond journalier UTC du titulaire atteint sur la classe d'appel (`local` ou `semantique`).

## Le corpus

| Catégorie | Textes |
|---|---|
| Codes | Code civil du Québec, Code de procédure civile |
| Lois sectorielles | Charte des droits et libertés, protection du consommateur, normes du travail, renseignements personnels (Loi 25) et accès aux documents publics, valeurs mobilières (dont `V-1.1, r. 10`, `r. 21` et `r. 24` tirés des PDF officiels de l'AMF, `fonction='reglement'`), assureurs, coopératives de services financiers, police et déontologie policière, bâtiment (Code de construction, Code de sécurité), courtage immobilier, cités et villes, fiscalité et éthique municipales, expropriation, contrats des organismes publics et municipaux, fonction publique, procédure pénale… |
| Règles de procédure | Règlements des cours (appel, supérieure, Québec), du TAQ, du TAL, du TAMF, de la déontologie policière et de la Régie du bâtiment |
| Tarifs | Tarif judiciaire, tarifs du TAQ, du TAL et du TAMF |
| Directives judiciaires | Directives de pratique de la Cour supérieure (Montréal — District et Division — et Québec) et de la Cour du Québec (règles simplifiées, pratique civile et administrative à Montréal, liste commune DAA) — source PDF, non législatives, français seulement |
| Orientations (AMF) | *Instructions générales* 31-103, 45-106 et 51-102 de l'Autorité des marchés financiers — source PDF, indicatives et sans force de loi, français seulement |

Les décomptes exacts (nombre d'articles par langue, dates de consolidation) sont calculés
en base et affichés sur la [page publique](https://legislation.poirierlavoie.ca/) ainsi que
par l'outil `list_laws` — ils ne sont pas recopiés ici (R10). Rafraîchissement
semestriel.

**Ce que le corpus NE couvre PAS, et qu'il vaut mieux savoir avant d'en avoir besoin.**
Le corpus sert le **droit en vigueur**, dans sa version consolidée courante — il n'y a ni
versions antérieures, ni point de vue historique. En particulier, l'**ancien Code de
procédure civile** (RLRQ, c. C-25), abrogé et remplacé le 1er janvier 2016 par le Code
actuel (c. C-25.01), **n'y figure pas** : c'est une décision de portée, pas un oubli.
Comme la recodification a **renuméroté** le code, l'article N de l'ancien n'est pas
l'article N du nouveau — aussi `resolve_reference` refuse-t-il NOMMÉMENT une
citation de l'ancien code (« ancien C.p.c. », « c. C-25 », « C.p.c. de 1965 ») plutôt que de
la rabattre en silence sur son successeur. Côté fédéral, la portée exclut également le Code
criminel, la Loi de l'impôt sur le revenu et les lois constitutionnelles (voir l'invariant 17
de [CLAUDE.md](CLAUDE.md)).

## Les 10 outils

Le patron d'usage est en deux temps : **s'orienter** (découverte), puis **extraire**.

### Découverte

| Outil | Rôle | Exemple |
|---|---|---|
| `find_relevant` | Le routeur : d'un problème en langage libre vers les lois et chapitres candidats, avec le *pourquoi* de chaque rapprochement | `« vice caché »` → C.c.Q. Livre 5 (Obligations) + L.p.c. |
| `list_laws` | Carte du corpus : noms FR/EN, citation RLRQ, dates, matières, loi habilitante, plan des grands codes ; filtres `fonction`/`forum`/`subject` | `fonction=tarif` → les 4 tarifs |
| `list_subjects` | Les 44 matières de la taxonomie (droit privé du C.c.Q. + matières spécialisées), bilingues | — |
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

`search_text` combine deux moteurs et **dit toujours quel chemin a produit les
résultats** :

1. **Lexical** (FTS5, insensible aux accents) — correspondance exacte d'abord ; si une
   recherche restreinte à une loi ne donne rien, elle est automatiquement **élargie au
   corpus** ; sinon l'échelle de **relaxation** s'applique (retrait d'un terme à la fois,
   puis OU pondéré bm25), chaque étape étiquetée : *« résultats approchés (terme ignoré :
   « hors ») »*. Un barreau n'arrête la descente que s'il rend **assez** de résultats : une
   liste d'un seul article laisse l'échelle continuer, car le moteur lexical ne connaît
   aucune famille de mots en français — une question posée avec *« garantie »* n'atteint pas
   d'elle-même un texte qui dit *« garantir »*.
2. **Sémantique** (embeddings multilingues) — fusionné au lexical par RRF ; il fait le
   pont de vocabulaire (*« congédiement »* trouve *« délai de congé »*) et de langue
   (une requête en anglais trouve le texte français). Les résultats issus du seul chemin
   sémantique sont marqués *« (repérage sémantique) »*. Chaque titulaire peut désactiver
   ce volet (`hybride_permis = 0` sur <https://acces.poirierlavoie.ca/moi>) : `search_text`
   s'exécute alors en mode lexical FTS5 seul (sans appel à `Workers AI` ni à `Vectorize`,
   comptabilisé en classe `local`) et le mentionne dans la réponse.

Chaque résultat est auto-explicatif : `C.p.c. — Livre V, Titre IV : LES DEMANDES
INTÉRESSANT LE DROIT INTERNATIONAL PRIVÉ › art. 490 [ga:l_v-gb:l_iv-gc:l_i]` + extrait.

Trois décomptes accompagnent la réponse, et ils ne disent pas la même chose : `total` compte
les appariements **lexicaux** dans le corpus entier, `returned` la taille de la page rendue,
et `sources` départage ce qui vient du lexical de ce qui vient du sémantique. Un `total` de 1
avec cinq résultats n'est donc pas une incohérence : c'est un appariement lexical et quatre
voisins de sens.
Les recherches corpus sont regroupées par loi (max 6 par loi).

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
laws.config.json, taxonomy.json, relations.json   Données versionnées (corpus, matières, graphe)
migrations/     Migrations D1 — s'appliquent PAR-DESSUS schema.sql, qui décrit l'état
                INITIAL et non l'état courant (procédure complète : CLAUDE.md)
tests/, eval/   contrôles bout-en-bout + harnais d'évaluation (21 cas, recall@10/MRR)
docs/           Notes d'architecture, rapports de phase, formats EPUB/LIMS/PDF ; archive des plans
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
(`catalogue.json`) — et inclure les mises à jour requises dans le même commit. C'est une
condition de fin de tâche, pas une recommandation : voir l'obligation préalable en tête de
[CLAUDE.md](CLAUDE.md) et la règle R10. Garde en CI : **`npm test`** — la suite vitest à deux
projets, qui porte notamment la parité outils ↔ documentation (`tests/catalogue.test.mjs`) et
le comportement du JS de la page sans navigateur (`tests/page-client.test.mjs`). C'est bien
cette commande unique que lance `.github/workflows/ci.yml`.

Trajectoire mesurée du repérage : recall@10 **40 % → 88 % → 98 %** (`docs/reports/`).

## Sécurité, confidentialité et licence

- **Sécurité, vie privée et secret professionnel :** Aucun texte de requête ni argument d'outil n'est journalisé à l'exécution (journaux d'invocation Cloudflare désactivés, zéro écriture dans `search_log`, télémétrie strictement bornée à `compteur_jour` et `evenement_technique` sans contenu dans `DB_IDENTITE`). Consulter [`SECURITY.md`](SECURITY.md) pour signaler de manière privée et coordonnée toute vulnérabilité ou question de confidentialité / secret professionnel à Jason Poirier Lavoie (`jason@poirierlavoie.ca`), sans ouvrir d'issue publique ni joindre de renseignements confidentiels de clients.
- **Licence :** Le logiciel, les schémas, le pipeline et la documentation originale sont régis par la licence **Creative Commons Attribution - Pas d'Utilisation Commerciale - Partage dans les Mêmes Conditions 4.0 International (`CC-BY-NC-SA-4.0`)**, assortie d'une **Autorisation complémentaire de pratique professionnelle du droit** pour les membres en règle du Barreau du Québec (Partie A de [`LICENSE`](LICENSE)). Les textes servis demeurent soumis aux régimes de l'Éditeur officiel du Québec (LégisQuébec), de la Licence du gouvernement ouvert – Canada (Justice Canada), ainsi que des tribunaux du Québec (Cour supérieure, Cour du Québec) et de l'Autorité des marchés financiers (AMF) (Partie B de [`LICENSE`](LICENSE)).
