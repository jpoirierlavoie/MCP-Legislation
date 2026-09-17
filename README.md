# Lois du Québec et du Canada — serveur MCP

Serveur [MCP](https://modelcontextprotocol.io) donnant aux assistants IA un accès **en
lecture seule** au texte officiel de **97 lois et règlements** : la législation du Québec
(dont le Code civil du Québec et le Code de procédure civile) et 18 textes fédéraux que le
litige civil québécois convoque — faillite, divorce, sociétés par actions, droit d'auteur,
preuve, Cours fédérales. En **français et en anglais**, avec dates de consolidation, hiérarchie complète (Livres → Titres → Chapitres →
articles) et recherche hybride lexicale + sémantique.

**Page publique :** <https://legislation.poirierlavoie.ca/> — outils, aides au repérage,
corpus et matières, en français et en anglais, avec les décomptes lus en base.

**Point d'accès MCP :** `https://legislation.poirierlavoie.ca/mcp` (HTTP streamable) —
**instance privée, un jeton par client** : une requête sans jeton valide reçoit 404.

Source des données : les EPUB officiels de [LégisQuébec](https://www.legisquebec.gouv.qc.ca)
(Éditeur officiel du Québec). Le texte des articles est restitué **verbatim** — le serveur
n'altère jamais le contenu officiel.

## Accès

Ce serveur est une **instance privée**. L'endpoint MCP n'est ouvert qu'aux clients
autorisés, et **chacun reçoit son propre jeton, révocable seul** : renouveler ou révoquer
l'un ne perturbe aucun autre. Une requête sans jeton valide reçoit 404 (jamais 401 — un
401 annoncerait un serveur MCP et déclencherait la découverte OAuth des clients, ce qui a
déjà coincé un connecteur de façon irréversible).

Pour en demander l'accès : <jason@poirierlavoie.ca>. Le code source est public et le
corpus reproductible — pipeline d'ingestion, taxonomie et données de configuration sont
tous versionnés ici.

### Se connecter

Le jeton se présente au choix du client ; les trois formes sont équivalentes côté serveur,
et le slash final est toléré partout.

| Client | Forme | À écrire |
|---|---|---|
| Connecteur claude.ai | paramètre de requête | `https://legislation.poirierlavoie.ca/mcp?key=<jeton>` |
| Backend applicatif, Claude Code, CI | en-tête | `https://legislation.poirierlavoie.ca/mcp` + `Authorization: Bearer <jeton>` |

**Pour le connecteur claude.ai, employer `?key=`** : c'est la forme mesurée en production.
**Pour un backend qui ouvre lui-même sa session, employer l'en-tête** — c'est la seule des
trois qui ne fait jamais voyager le jeton dans une URL, donc la seule qui ne le laisse
jamais dans un journal de requêtes. La troisième forme, le segment de chemin
`https://legislation.poirierlavoie.ca/mcp/<jeton>`, est acceptée et testée mais n'est la
forme d'aucun client aujourd'hui : elle a échoué dans le formulaire de claude.ai alors
qu'une session complète y passe en `curl`.

Le transport est **HTTP streamable AVEC ÉTAT** : `initialize` d'abord, puis rejouer
l'en-tête `mcp-session-id` reçu sur les appels suivants. Un `DELETE` referme proprement la
session ; le flux `GET` est servi, mais ce serveur n'émet aucune notification
serveur→client, donc un client qui s'en passe ne perd rien.

Deux refus à ne pas confondre, et le second surprend :

- **429** — cadence trop élevée (limiteur par IP, dans le Worker). Réessayer plus tard.
- **404** — jeton absent, faux ou révoqué… **ou session inconnue** : le transport répond
  le même code quand il ne détient plus la session. Un client à état qui purge sa session
  sur 404 verra donc un jeton révoqué comme un battement de session. Trancher au `curl`.

## Le corpus

| Catégorie | Textes |
|---|---|
| Codes | Code civil du Québec, Code de procédure civile |
| Lois sectorielles | Charte des droits et libertés, protection du consommateur, normes du travail, renseignements personnels (Loi 25) et accès aux documents publics, valeurs mobilières, assureurs, coopératives de services financiers, police et déontologie policière, bâtiment (Code de construction, Code de sécurité), courtage immobilier, cités et villes, fiscalité et éthique municipales, expropriation, contrats des organismes publics et municipaux, fonction publique, procédure pénale… |
| Règles de procédure | Règlements des cours (appel, supérieure, Québec), du TAQ, du TAL, du TAMF, de la déontologie policière et de la Régie du bâtiment |
| Tarifs | Tarif judiciaire, tarifs du TAQ, du TAL et du TAMF |

Les décomptes exacts (nombre d'articles par langue, dates de consolidation) sont calculés
en base et affichés sur la [page publique](https://legislation.poirierlavoie.ca/) ainsi que
par l'outil `legislation_list_laws` — ils ne sont pas recopiés ici (R10). Rafraîchissement
semestriel.

**Ce que le corpus NE couvre PAS, et qu'il vaut mieux savoir avant d'en avoir besoin.**
Le corpus sert le **droit en vigueur**, dans sa version consolidée courante — il n'y a ni
versions antérieures, ni point de vue historique. En particulier, l'**ancien Code de
procédure civile** (RLRQ, c. C-25), abrogé et remplacé le 1er janvier 2016 par le Code
actuel (c. C-25.01), **n'y figure pas** : c'est une décision de portée, pas un oubli.
Comme la recodification a **renuméroté** le code, l'article N de l'ancien n'est pas
l'article N du nouveau — aussi `legislation_resolve_reference` refuse-t-il NOMMÉMENT une
citation de l'ancien code (« ancien C.p.c. », « c. C-25 », « C.p.c. de 1965 ») plutôt que de
la rabattre en silence sur son successeur. Côté fédéral, la portée exclut également le Code
criminel, la Loi de l'impôt sur le revenu et les lois constitutionnelles (voir l'invariant 17
de [CLAUDE.md](CLAUDE.md)).

## Les 10 outils

Le patron d'usage est en deux temps : **s'orienter** (découverte), puis **extraire**.

### Découverte

| Outil | Rôle | Exemple |
|---|---|---|
| `legislation_find_relevant` | Le routeur : d'un problème en langage libre vers les lois et chapitres candidats, avec le *pourquoi* de chaque rapprochement | `« vice caché »` → C.c.Q. Livre 5 (Obligations) + L.p.c. |
| `legislation_list_laws` | Carte du corpus : noms FR/EN, citation RLRQ, dates, matières, loi habilitante, plan des grands codes ; filtres `fonction`/`forum`/`subject` | `fonction=tarif` → les 4 tarifs |
| `legislation_list_subjects` | Les 43 matières de la taxonomie (droit privé du C.c.Q. + matières spécialisées), bilingues | — |
| `legislation_related_laws` | Graphe d'une loi : règlements pris sous elle, loi habilitante, renvois, relations curées | `law=cpc` → ses 6 règlements de cour |

### Extraction

| Outil | Rôle | Exemple |
|---|---|---|
| `legislation_get_article` | Un article verbatim, avec citation, hiérarchie, historique, date | `law=ccq, article=1457` |
| `legislation_get_articles` | Plage (`from`/`to`) ou liste (`numbers`) d'articles, paginée | `law=cpc, from=489, to=496` |
| `legislation_get_structure` | L'arbre des divisions, sans texte — pour explorer avant d'extraire | `law=ccq, depth=2` |
| `legislation_get_division` | Une division (Livre/Titre/Chapitre…) : intitulé, sous-divisions, articles | `path=ga:l_cinquieme` |
| `legislation_search_text` | Recherche hybride dans le texte des articles (voir ci-dessous) | `« délai réponse défendeur hors du Québec »` |
| `legislation_resolve_reference` | D'une citation libre vers l'article officiel ; reconnaît les chapitres RLRQ et les abréviations C.c.Q./C.p.c. | `« RLRQ, c. T-16, art. 12 »` |

## La recherche, en détail

`legislation_search_text` combine deux moteurs et **dit toujours quel chemin a produit les
résultats** :

1. **Lexical** (FTS5, insensible aux accents) — correspondance exacte d'abord ; si une
   recherche restreinte à une loi ne donne rien, elle est automatiquement **élargie au
   corpus** ; sinon l'échelle de **relaxation** s'applique (retrait d'un terme à la fois,
   puis OU pondéré bm25), chaque étape étiquetée : *« résultats approchés (terme ignoré :
   « hors ») »*.
2. **Sémantique** (embeddings multilingues) — fusionné au lexical par RRF ; il fait le
   pont de vocabulaire (*« congédiement »* trouve *« délai de congé »*) et de langue
   (une requête en anglais trouve le texte français). Les résultats issus du seul chemin
   sémantique sont marqués *« (repérage sémantique) »*.

Chaque résultat est auto-explicatif : `C.p.c. — Livre V, Titre IV : LES DEMANDES
INTÉRESSANT LE DROIT INTERNATIONAL PRIVÉ › art. 490 [ga:l_v-gb:l_iv-gc:l_i]` + extrait.
Les recherches corpus sont regroupées par loi (max 6 par loi).

## Avertissement

L'aide au repérage (`find_relevant`, taxonomie, relations) est **heuristique** : elle ne
détermine pas le droit applicable. Toujours vérifier en lisant le texte via
`get_structure` / `get_division` / `get_article`. Ce serveur ne fournit pas de conseil
juridique ; en cas de doute, consulter la version officielle sur LégisQuébec et un
professionnel du droit.

## Pour les développeurs

```
src/            Worker Cloudflare (TypeScript) : outils MCP, recherche, D1/Vectorize
pipeline/       Ingestion Python : EPUB LégisQuébec -> D1 (staging -> validation -> bascule)
laws.config.json, taxonomy.json, relations.json   Données versionnées (corpus, matières, graphe)
migrations/     Migrations D1 — s'appliquent PAR-DESSUS schema.sql, qui décrit l'état
                INITIAL et non l'état courant (procédure complète : CLAUDE.md)
tests/, eval/   contrôles bout-en-bout + harnais d'évaluation (21 cas, recall@10/MRR)
docs/           Notes d'architecture, rapports de phase, format EPUB ; archive des plans
```

Démarrage : `npm install`, puis `npx wrangler dev --var MCP_TOKEN:local-a --var
MCP_TOKEN_VEILLE:local-b` — **les `--var` sont requis** : l'endpoint est fermé par défaut,
sans secret il refuse tout. Puis `MCP_TOKEN=local-a npm run evals` contre
`http://127.0.0.1:8787/mcp`. **Avant toute modification, lire [CLAUDE.md](CLAUDE.md)** —
les invariants critiques du dépôt y sont consignés (ordre de la config, miroirs de clés
de tri, limites D1/Vectorize, échelle de recherche).

**Toute modification doit évaluer son impact sur CINQ surfaces** — outils MCP,
descriptions, schéma, ce README et la [page publique](https://legislation.poirierlavoie.ca/)
(`catalogue.json`) — et inclure les mises à jour requises dans le même commit. C'est une
condition de fin de tâche, pas une recommandation : voir l'obligation préalable en tête de
[CLAUDE.md](CLAUDE.md) et la règle R10. Garde en CI : **`npm test`** — la suite vitest à deux
projets, qui porte notamment la parité outils ↔ documentation (`tests/catalogue.test.mjs`) et
le comportement du JS de la page sans navigateur (`tests/page-client.test.mjs`). C'est bien
cette commande unique que lance `.github/workflows/ci.yml`.

Trajectoire mesurée du repérage : recall@10 **40 % → 88 % → 98 %** (`docs/reports/`).
