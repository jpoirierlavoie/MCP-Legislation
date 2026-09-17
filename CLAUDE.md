# CLAUDE.md — Lois du Québec et du Canada (serveur MCP)

Serveur MCP **en production** servant le texte officiel de 97 lois et règlements — 79 du
Québec et 18 fédéraux — (FR + EN) : `https://legislation.poirierlavoie.ca/mcp`. Propriétaire : Jason Poirier Lavoie
(avocat). Lecture seule pour les usagers ; les données viennent des EPUB officiels de
LégisQuébec et des XML du ministère de la Justice du Canada (Licence du gouvernement
ouvert – Canada ; la version officielle fédérale est celle publiée par le ministre,
art. 31 de la Loi sur la révision et la codification des textes législatifs). **C'est un outil juridique : un résultat faux rendu en silence est le pire
défaut possible — refuser vaut toujours mieux que deviner.**

## ⛔ OBLIGATION PRÉALABLE À TOUTE MODIFICATION (aucune exception)

**Avant de terminer QUELLE QUE SOIT une tâche touchant ce dépôt, évaluer explicitement son
impact sur les CINQ surfaces ci-dessous, et inclure les mises à jour requises DANS LE MÊME
COMMIT.** Ce n'est pas une bonne pratique, c'est une condition de fin de tâche : une tâche
qui laisse une surface en retard n'est pas terminée, elle est en dette.

**Le coût en tokens n'est JAMAIS une raison de sauter cette évaluation** — consigne
explicite de Jason. Lire les cinq fichiers, comparer, et rendre compte coûte moins cher
qu'une seule ligne fausse servie à un modèle dans un outil juridique.

| # | Surface | Où | Ce qui la fait bouger |
|---|---|---|---|
| 1 | **Outils MCP** | `src/tools.ts` | nom, ajout/retrait (R2), paramètres, comportement, message d'erreur servi |
| 2 | **Descriptions** | `src/tools.ts` (`description`, `title`), `catalogue.json` | toute reformulation ; R3 borne le delta et exige de consigner le coût en tokens |
| 3 | **Schéma** | `schema.sql`, `schema-decouverte.sql`, `migrations/`, `inputSchema` des outils, forme de `structuredContent` | colonne ajoutée/retirée, champ de sortie ajouté/retiré/renommé |
| 4 | **README.md** | racine | tout ce qui change ce que le dépôt *annonce* faire |
| 5 | **Page publique** | `catalogue.json` + `src/site.ts` | tout ce qui change ce que le public *lit* |

**Procédure, à exécuter et à RAPPORTER — pas à supposer :**

1. Pour chacune des cinq surfaces : dire si elle est touchée, et pourquoi (« non touchée »
   est une réponse valable, mais elle doit être ÉNONCÉE, jamais passée sous silence).
2. `node --test tests/catalogue.test.mjs` — garde de parité, hors réseau. Il attrape les
   ruptures structurelles ; il n'attrape PAS un sens qui a changé.
3. Si une surface bouge : `npx tsc --noEmit`, puis `npm run evals` contre la cible.
4. Si le schéma bouge : migration numérotée + bookmark Time Travel AVANT `--remote`
   (invariant 6), et vérifier que `structuredContent` n'a pas rétréci en silence
   (corollaire structuré de R4, décision 001).

**Pourquoi cette obligation existe.** La dérive n'est pas hypothétique ici, elle est
documentée : `legislation_resolve_reference` a servi aux modèles « Voir les 38 textes
disponibles » pendant que le corpus en comptait 79 ; le README annonçait 3 tarifs sur 4,
~46 000 articles sur 49 255, 57 contrôles sur 62, et publiait une configuration de
connexion qui renvoyait 404 ; `docs/ARCHITECTURE-NOTES.md` est resté à 38 lois / 28 matières.
**Aucun test n'a échoué dans aucun de ces cas.** C'est exactement le mode de défaut que ce
dépôt refuse : faux, servi, silencieux.

Détail des mécanismes et de ce qu'ils n'attrapent pas : **R10**, plus bas.

**`docs/` est une ARCHIVE PAR DÉFAUT — il n'est PAS une sixième surface.** Tout document
qui s'y trouve porte une date et **ne fait jamais foi sur l'état courant** : ce sont des
instantanés, des rapports de phase, des plans exécutés. L'état vivant est D1, les JSON
versionnés, `CLAUDE.md`, `README.md` et la page publique — rien d'autre.
C'est délibérément une politique et non une discipline de plus : un document daté ne dérive
pas, il vieillit. `docs/ARCHITECTURE-NOTES.md` a traversé QUATRE agrandissements du corpus
en se déclarant « état réel » sans qu'aucun test n'échoue, précisément parce qu'il
prétendait au présent. Corollaire de rédaction : dans `docs/`, écrire au passé et dater ;
ne jamais y recopier un décompte vivant en le présentant comme actuel.

**EN REVANCHE, UNE SIXIÈME SURFACE EXISTE — et elle vit HORS de ce dépôt.** Elle a CHANGÉ de
forme le 2026-09-02, et le piège est là : le clavardage interne de Pallas Athéna, qui offrait
les dix outils à son modèle depuis `athena/chat/worker_tools.py` **engendré** depuis
`tools/list` par `athena/scripts/sync_worker_tools.py`, a été supprimé EN ENTIER (commit
`ef85473`, 87 fichiers) quand le cabinet est passé à un compte Claude for Work sous DPA.
**Ce générateur n'existe plus. Ne pas le chercher, ne pas tenter de le relancer** — la
consigne qui figurait ici jusqu'au 2026-09-16 prescrivait un remède injouable.
Le couplage, lui, a SURVÉCU en changeant de support : il vit désormais dans les **Skills
claude.ai** (`competences-juridiques-pallas-athena/`, deux compétences — recherche et
rédaction) qui nomment les outils `legislation_*` **à la main** (25 appels relevés le
2026-09-16, répartis sur 6 fichiers). Rien ne les engendre, donc rien ne peut les réparer :
après tout ajout, retrait ou renommage d'outil, les corriger À LA MAIN puis les téléverser
dans claude.ai. Sinon l'échec n'apparaît qu'en pleine recherche juridique, sous la forme
d'un outil qui « n'existe pas ».
Les CINQ surfaces ci-dessus restent le contrat INTRA-dépôt ; celle-ci est un couplage
inter-dépôts, non gardé — et depuis le 2026-09-02, non engendré non plus.

## Architecture (3 morceaux)

1. **Worker Cloudflare** (`src/`, TypeScript) — McpAgent (Durable Object) + 10 outils
   `legislation_*`, D1 (`legislation`), Workers AI (bge-m3) + Vectorize (`legislation-articles`) pour la
   recherche hybride. Config : `wrangler.jsonc` (PAS .toml).
2. **Pipeline Python** (`pipeline/`, venv `./.venv/Scripts/python.exe`, toujours
   `PYTHONUTF8=1`) — télécharge/parse les EPUB Irosoft, charge D1 par
   staging → validation → bascule. Ne JAMAIS écrire directement en production.
3. **Données versionnées** — `laws.config.json` (79 lois), `catalogue.json` (doc publique
   des outils et des aides au repérage, bilingue — R10), `taxonomy.json` (43 matières
   bilingues), `relations.json` (relations curées), `schema.sql` + `schema-decouverte.sql`
   + `migrations/` (wrangler d1 migrations).

Fichiers clés : `src/tools.ts` (outils MCP), `src/lib.ts` (requêtes D1, échelle de
recherche, fusion RRF), `src/relevance.ts` (TOUTES les constantes de calibration : poids
S1–S4, RRF_K, SEMANTIC_MIN_SCORE…), `src/backfill.ts` (route admin vecteurs), `src/site.ts` (page publique servie à `/` — ses
décomptes sont LUS en D1, jamais recopiés ; elle ne contient JAMAIS le jeton et n'appelle
jamais `/mcp`), `pipeline/ingest.py` (orchestrateur),
`pipeline/discovery/` (recon/migrate/load/relations/verify).
Un seul « backfill » subsiste, celui des VECTEURS (`src/backfill.ts` + `scripts/backfill-vectors.mjs`) :
l'homonyme Python remplissait `name_norm`/`heading_norm` avant que l'invariant n° 3 ne les
fasse calculer au chargement, il est supprimé.

## Commandes

```bash
npx wrangler dev --var MCP_TOKEN:a --var MCP_TOKEN_VEILLE:b   # dev local (D1 local ; PAS Vectorize)
#   ^ les --var sont REQUIS depuis le défaut fermé (2026-08-27) : sans secret, /mcp refuse TOUT
npx tsc --noEmit                                   # type-check (toujours avant commit)
npm run evals                                      # contrôles bout-en-bout (le harnais imprime son total ; MCP_URL=… pour cibler)
npm run eval                                       # harnais d'éval : 21 cas, recall@10/MRR (production)
node eval/run.mjs --refresh-paths                  # revalide eval/cases.resolved.json et SORT — diff à VIDER avant de mesurer
node scripts/journal.mjs [--local|--jours N|--tout] # dépouille search_log (lecture seule) : replis et reformulations
PYTHONUTF8=1 ./.venv/Scripts/python.exe -m unittest discover -s pipeline/tests -q   # 131 tests
npm test                                           # vitest, DEUX projets : 8 fichiers, 94 contrôles (sans réseau, en CI)
#   ^ « workerd » (test/**/*.test.ts, via wrangler.test.jsonc) et « node » (tests/**, scripts/**) :
#     garde anti-dérive doc (R10), JS client de la page, détecteur de veille, plages, chemins…
#     NE PLUS lancer ces fichiers avec `node --test` : ils sont passés à vitest le 2026-09-16
#     et le lanceur de Node y répond « pass 0, fail 1 » sans rien dire du pourquoi.
PYTHONUTF8=1 ./.venv/Scripts/python.exe -m pipeline.ingest --law X --lang fr --apply-local
npx wrangler d1 migrations apply legislation --local|--remote   # bookmark Time Travel AVANT --remote
npx wrangler deploy                                # jeton requis (voir Secrets)
```

## Secrets et jetons

- `cf.token` (racine, gitignoré) : jeton API Cloudflare. **Ne JAMAIS l'afficher, le lire
  en contexte, ni le supprimer** (consigne de Jason). Chargement inline uniquement :
  `export CLOUDFLARE_API_TOKEN=$(tr -d ' \t\r\n' < cf.token)`.
- `backfill.token` (racine, gitignoré) : Bearer de la route `/admin/backfill-vectors`.
- `mcp.token` (racine, gitignoré) : jeton du **connecteur claude.ai** (`src/auth.ts`).
  Miroir du secret Worker `MCP_TOKEN` (`wrangler secret put MCP_TOKEN`) et du secret
  GitHub du même nom (veille CI). Les clients Node le résolvent tout seuls
  (`eval/mcp-client.mjs` : `MCP_TOKEN` puis `mcp.token`) — rien à exporter à la main.
  N'ouvre QUE la lecture MCP : aucun droit sur le compte Cloudflare ni sur la base.
  **Rotation = poser le nouveau secret, puis mettre à jour les 3 copies** (fichier local,
  secret GitHub, URL du connecteur claude.ai — forme `…/mcp?key=<jeton>`).
  À savoir : `?key=` voyage dans l'URL, donc dans le journal de requêtes de
  l'observabilité — traiter `MCP_TOKEN` comme **déjà vu** par le pipeline de logs du
  compte. Un jeton employé uniquement en `Authorization: Bearer` n'y apparaît jamais.
- `mcp-veille.token` (racine, gitignoré) : jeton de la **veille de consolidation en CI**,
  miroir du secret Worker `MCP_TOKEN_VEILLE` et du secret GitHub du même nom. Droits
  IDENTIQUES au premier — il n'ouvre aucun outil de plus ; il n'existe QUE pour que les
  deux clients se révoquent SÉPARÉMENT (même modèle que le connecteur jumeau
  `jurisprudence`, §19 de sa spec). **DEUX porteurs seulement** (secret GitHub, fichier
  local) — **et `MCP_TOKEN` n'est plus, lui non plus, un secret GitHub** : il en avait
  TROIS (fichier local, secret GitHub, URL du connecteur) et n'était donc plus révocable
  seul, ce que le découpage existait précisément pour éviter. **Ne jamais réutiliser la
  valeur de `MCP_TOKEN`** : deux secrets de même valeur ne sont plus révocables
  séparément, ce qui annule tout l'objet du découpage. Révocation =
  `wrangler secret delete MCP_TOKEN_VEILLE`, une commande, sans effet sur le connecteur
  claude.ai — au prix de la surveillance mensuelle jusqu'au remplacement.
  **Précédent, 2026-09-16** : `MCP_TOKEN_ATHENA` occupait cette place et a été retiré. Le
  clavardage de Pallas Athéna, son unique destinataire, avait été supprimé le 2026-09-02
  (passage à un compte Claude for Work sous DPA) : c'était un identifiant de production
  actif pour un appelant qui n'existait plus. Retenir la leçon plutôt que la date : un
  jeton survit à son client sans que rien ne le signale.
- Commits **signés** (gpgsign actif), footer `Co-Authored-By: Claude <noreply@anthropic.com>`
  adapté au modèle courant. Un commit par sous-tâche ; arrêt pour revue humaine à chaque
  fin de phase.

## Invariants critiques (chacun a déjà cassé quelque chose)

1. **L'ORDRE de `laws.config.json` est porteur** : `_id_base()` dérive les plages d'id de
   la POSITION de chaque loi. Réordonner = toutes les clés primaires se décalent et la
   prochaine ingestion écrase les articles d'autres lois, en silence. **On AJOUTE en fin
   de liste, jamais ailleurs** (épinglé par `pipeline/tests/test_config.py`).
2. **`sortKeyOf()` (src/lib.ts) et `sort_key()` (pipeline/model.py) sont des MIROIRS** de
   la même colonne. Une divergence d'échelle vide silencieusement le mode plage de
   `get_articles` (déjà arrivé : 36 lois sur 38 muettes). Les bornes de plage sont LUES
   en base (`boundKey`) précisément pour amortir ce risque.
3. **Un chargement monolingue ne touche pas l'autre langue** : l'UPSERT de `laws` exclut
   `name_<autre>` / `consol_date_<autre>` (une passe FR écrasait le titre anglais).
   `name_norm`/`heading_norm` sont calculés AU CHARGEMENT (une réingestion les remettait
   à NULL et aveuglait les signaux S2/S3).
4. **Les chemins Irosoft sont PROPRES À LA LANGUE** (`ga:l_cinquieme` FR / `ga:l_five` EN).
   Tout chemin traversant les langues passe par le pont des numéros d'articles
   (`translateDivisionPath`/`translatePaths`). Ne jamais supposer un chemin « canonique ».
5. **Pas de LIKE/GLOB sur les chemins** : `_` est un joker LIKE, et D1 plafonne la
   complexité des motifs (« pattern too complex » sur les chemins profonds du C.c.Q.).
   Sous-arbres = intervalle lexicographique `[path+'-', path+'.')` (`subtreeClause`).
6. **D1 refuse toute instruction > 100 Ko** : lots SQL plafonnés en OCTETS UTF-8
   (pas en caractères), lignes surdimensionnées via INSERT + `UPDATE …||` par morceaux
   (`pipeline/load.py`). `wrangler d1 export` SANS argument est BLOQUÉ par la table virtuelle
   `articles_fts` → sauvegarde = **Time Travel** (bookmark consigné avant migration).
   **Nuance mesurée le 2026-09-16** : `d1 export --table <t> --no-schema` PASSE, table par
   table — c'est ce qui a permis de copier la base vers `legislation` sans réingérer
   (74 Mo pour la seule table `articles`). Deux pièges alors, tous deux rencontrés :
   l'export émet UN `INSERT` par ligne, donc une ligne >100 Ko produit une instruction que D1
   refuse (une seule dans le corpus, 148 297 octets) ; et il sort en ordre d'`id` CROISSANT,
   or `divisions.parent_id` se référence elle-même et deux lignes ont un parent d'id PLUS
   GRAND — le `PRAGMA defer_foreign_keys` de l'export ne couvrant qu'UNE transaction et
   wrangler découpant en lots, l'import échoue en clé étrangère. Remède dans les deux cas :
   `INSERT` court puis `UPDATE … ||` / `UPDATE … SET parent_id` en fin de fichier.
   Migration destructive : voir « Répéter une migration DESTRUCTIVE », plus bas.
7. **Échelle de recherche (ordre tranché par l'éval, ne pas réordonner sans re-mesurer)** :
   exact → élargissement corpus → leave-one-out → OU+bm25, PUIS fusion RRF avec les
   vecteurs ; le sémantique SEUL est l'ultime barreau, sous plancher
   `SEMANTIC_MIN_SCORE=0,40` **calibré par mesure** (réel EN→FR 0,525 ; charabia 0,303).
   Tout chemin de repli est ÉTIQUETÉ dans la réponse et journalisé (`search_log`).
8. **Vectorize** : ids ≤ 64 octets (chemins de divisions hachés SHA-256/24hex) ; index de
   métadonnées créés AVANT toute insertion (pas rétroactifs) ; fenêtre bge-m3 consommée
   en lot × PLUS LONG texte (rembourrage) → l'embed du backfill se scinde récursivement
   sur l'erreur 3030, ne jamais revenir à une estimation fixe.
9. **Le WAF de la zone bloque les rafales de POST** non-navigateur sur le domaine
   personnalisé. Backfill de vecteurs : activer temporairement `workers_dev: true`,
   passer par `legislation.jpoirierlavoie.workers.dev`, refermer ensuite.
10. **Une session MCP par lot de vérifications** (`eval/mcp-client.mjs`) — un processus
    Inspector par appel multiplie les sessions Durable Object (a déjà épuisé un quota).
    L'Inspector CLI sert aux contrôles ponctuels seulement.
11. **Environnement Windows/Git Bash : les heredocs bash retirent un niveau de `\`**.
    Tout patch contenant des barres obliques inverses passe par un FICHIER script
    (outil Write) puis exécution — jamais par heredoc.
12. **Toute calibration doit dégrader EN DOUCEUR quand le corpus grandit** : un seuil
    (« ≤ N entités → bonus, sinon rien ») a une position qui dépend de la taille du
    corpus. En passant de 47 à 78 lois, « récusation » a franchi le seuil de spécificité
    et le bon chapitre du C.p.c. a disparu du top 8 — sans erreur. Les pondérations sont
    désormais continues (`specificityFactor`). Se méfier de tout `<=` sur un décompte
    d'entités dans `src/relevance.ts`.
13. **Une `description` de matière est une SURFACE D'APPARIEMENT, pas de la prose.** S1
    apparie des tokens et ignore la négation : écrire « distincte de la procédure civile »
    dans la matière *Procédure pénale* lui a fait capter « appel civil » et évincer le
    C.p.c. Jamais de mention contrastive ni de « à ne pas confondre avec » dans une
    description ; n'y mettre que le vocabulaire que l'on VEUT voir matcher.
14. **L'appariement par préfixe de mot est BORNÉ (`MAX_SUFFIX = 4`)** : sans plafond de
    suffixe, un token de 3 lettres avale un mot de 9 — « fin » captait « financier » et
    noyait « clause non-concurrence fin d'emploi » sous tout le secteur financier. Le
    plafond couvre la flexion française (-s, -es, -aux, -ment, -tion) ; l'élargir revient
    à rouvrir cette classe de faux positifs.
15. **Une matière est UNE preuve, pas N candidats** (`MAX_PER_SUBJECT = 3`) : S1 injecte
    un candidat par entité mappée, tous au même score. *Bâtiment et construction* (7 lois)
    remplissait le top 8 à elle seule et en chassait le C.c.Q. Le plafond de diversité ne
    s'applique QU'aux candidats sans autre signal (S2/S3/S4). Toute matière dépassant
    ~5 entités mappées est un candidat à ce défaut : le vérifier à l'éval, pas au jugé.
16. **`eval/cases.json` est la vérité terrain de Jason** (⛔) : proposer les évolutions,
    ne jamais modifier de son propre chef. Idem tout contenu éditorial juridique
    (taxonomie, gazetteer, headnotes — drapeau `validated`, phase 3 v2).
17. **Le corpus FÉDÉRAL a son PROPRE parseur, et ses propres pièges** (18 textes sur 97,
    XML LIMS de Justice Canada, `pipeline/parser_lims.py` — rien à voir avec l'EPUB Irosoft).
    **JAMAIS `root.iter('Section')` ni `findall('.//Section')`** : mesuré sur le Code
    criminel, 294 blocs `RelatedOrNotInForce` et 270 `AmendedText` contiennent des `Section`
    portant les MÊMES NUMÉROS que le corps — du droit parallèle NON EN VIGUEUR. Une
    ingestion naïve produirait des doublons de numéros dont l'un est inapplicable : faux,
    servi, silencieux. Le parseur descend explicitement `Body` puis chaque `Schedule`, et
    REFUSE tout enfant direct de `Body` jamais observé (il lève plutôt que de deviner).
    **TROIS dates, dont une piège.** `laws.consol_date_*` vient de la **PAGE** de Justice
    Canada (`fetch_consolidation_federale`, bloc `<p id="assentedDate">`), PAS du XML, et
    l'échec de lecture est FATAL — un repli mettrait deux sémantiques dans la même colonne.
    `lims:current-date` SOUS-DÉCLARE la fraîcheur (mesuré : *Loi sur le droit d'auteur*
    annoncée à jour au 2025-07-24 dans le XML quand la page donne 2026-07-21, près d'un an).
    `LastConsolidationDate` du lookup ne doit JAMAIS servir : uniforme sur toutes les
    entrées, c'est la date de l'INSTANTANÉ et non celle de la loi. Seul
    `laws.last_amended` ← `lims:lastAmendedDate` vient bien du XML.
    **`LIMS_REF` vaut `HEAD` par défaut** : employer un SHA pour toute ingestion que l'on
    veut pouvoir rejouer à l'identique — sinon on réingère du droit différent sans le savoir.
    **Réserve consignée le 2026-09-17** : la spec exigeait d'exclure les `Schedule`
    `@spanlanguages="yes"` (88 des 92 annexes de DORS/98-106, formulaires bilingues où le
    fichier français porte du texte anglais) de `articles_fts` et de Vectorize. Ce n'est PAS
    implémenté — et le risque ne s'est pas matérialisé, parce que le contenu de ces annexes
    n'a jamais été ingéré en articles : 14 articles seulement sous `fs:%` en FR, tous du
    Tarif A en français authentique, et les sondes « whereas », « hereby », « sworn » rendent
    ZÉRO. À rouvrir SI l'on ingère un jour ces annexes plus profondément.

## Règles de conception actives (héritées du plan v2, toujours en vigueur)

- **R2** : AUCUN nouvel outil MCP sans approbation explicite (enrichir les 10 existants).
- **R3** : delta de description d'outil ≤ 2 phrases ; consigner le delta de tokens.
- **R4** : ne jamais altérer le texte officiel ni son rendu ; toute aide éditoriale est
  visiblement étiquetée non officielle. **Corollaire structuré (décision 001, 2026-07-23) :
  toute étiquette qui BORNE un résultat voyage DANS `structuredContent` comme champ
  obligatoire, jamais en prose seule** — un client peut jeter la prose et garder l'objet
  typé, et l'étiquette tomberait sans qu'aucun test n'échoue. Déjà le cas pour `fallback`
  (R7) ; s'impose à la phase 3 v2 (headnotes, drapeau `validated`) avant toute mise en
  service. `outputSchema` reste ABSENT à dessein (coût récurrent de tools/list + un schéma
  qui dérive des gabarits est un contrat menti) ; ne le revisiter que pour un consommateur
  nommé qui VALIDE.
- **R10 — UNE VÉRITÉ, CINQ SURFACES (dérive de documentation).** Mise en œuvre de
  l'**obligation préalable** en tête de ce fichier : outils, descriptions, schéma,
  `README.md`, page publique. Un outil ou une aide au repérage vit dans `src/tools.ts` (ce
  que le modèle reçoit), `catalogue.json` (ce que le public lit) et `README.md` (ce que le
  dépôt annonce) ; tout changement de nom, de titre, de sémantique, de signal, de barreau de
  repli ou de constante de calibration se répercute sur TOUTES les surfaces concernées, dans
  le même commit. **Le coût en tokens n'exempte de rien.**
  **Aucun fait vivant écrit à la main** : un décompte (lois, matières, articles, contrôles)
  se CALCULE (D1, JSON versionné) ou s'IMPORTE (`WEIGHTS`, `SEMANTIC_MIN_SCORE`) — jamais
  recopié dans de la prose. Un fait *historique daté* reste licite AVEC sa date
  (« mesuré à 38 lois : 36 en avaient », « recall@10 40 % → 88 % → 98 % »).
  **Preuve que la consigne seule ne suffit pas** : `legislation_resolve_reference` a servi aux
  modèles « Voir les 38 textes disponibles » alors que le corpus en comptait 79 ; le README
  annonçait 3 tarifs sur 4 ; `docs/ARCHITECTURE-NOTES.md` est resté à 38 lois / 28 matières.
  Tout cela sans qu'aucun test n'échoue. Garde : `tests/catalogue.test.mjs` (hors réseau,
  en CI) — parité outils ↔ catalogue dans les deux sens, bilinguisme réel, interdiction des
  titres en dur et des valeurs de calibration recopiées, décomptes du README épinglés sur
  les JSON versionnés. **Ce que RIEN n'attrape** : une description reformulée dont la prose
  de page devient fausse sans qu'aucune clé ne bouge — seule la relecture humaine le voit.
  R3 et R9 ne s'appliquent PAS à `catalogue.json` (il n'entre dans aucune réponse MCP) ;
  R4 si (aide éditoriale, visiblement non officielle). L'invariant 13 non plus : la prose de
  page n'est pas une surface d'appariement, contrairement aux descriptions de `taxonomy.json`.
- **R7** : fail open, toujours DIT (étiquettes d'élargissement/relaxation/sémantique).
- **R8** : chemins risqués derrière variables d'env (`RELAX_SEARCH`, `HYBRID_SEARCH`) —
  rollback = flip de variable, pas revert.
- **R9** : réponse de recherche ~≤ 800 tokens en régime normal.
- La description garde-fou de `find_relevant` est IMPOSÉE mot pour mot (const `GARDE_FOU`).

## Procédures sûres

**Modifier le Worker** : coder → `tsc` → `wrangler dev` + contrôles locaux →
`npm run evals` → deploy → re-vérifier en production (les Durable Objects mettent
~30–60 s à recycler l'ancien code) → `npm run eval` si le comportement de recherche a
changé — **porte : aucune régression sur les 21 cas**.

**Contrôle d'accès de `/mcp`** (`src/auth.ts`) : **DEUX jetons** (`MCP_TOKEN` pour le
connecteur claude.ai, `MCP_TOKEN_VEILLE` pour la veille de consolidation en CI), aux droits
IDENTIQUES, chacun accepté sous les TROIS mêmes formes. Tableau LITTÉRAL dans `secretsOf`,
pas de convention de nom balayée sur `env` : un nom mal orthographié se poserait sans
erreur et n'ouvrirait rien. Appariement SANS COURT-CIRCUIT (un `.some()` dirait par le
temps de réponse QUEL jeton a été présenté, donc quel client on est) et **on ne journalise
ni ne renvoie jamais lequel a servi** — les deux refus sont le même 404. `search_log` reste
ANONYME par décision : il n'existe aucune attribution par appelant, ni en base ni en log.
**La forme du connecteur claude.ai est `?key=<jeton>`** — mesurée, pas supposée : le
segment de chemin `/mcp/<jeton>` a ÉCHOUÉ en pratique (« Impossible de joindre ») alors
qu'une session complète y passe en curl, tandis que `?key=` a fonctionné du premier coup.
`Authorization: Bearer` reste la forme des clients maîtrisés (Claude Code, évals, veille CI) ;
le segment de chemin est conservé, testé, mais n'est la forme de personne aujourd'hui.

Deux constats de production à ne pas réapprendre à la dure (2026-07-23) :
- **Le slash final DOIT être toléré.** `/mcp/<jeton>/` renvoyait 404 et ce 404 poussait le
  connecteur vers la découverte OAuth, qui échouait sur l'enregistrement dynamique
  (« Impossible de s'inscrire auprès du service de connexion »). Pour un client MCP un refus
  n'est JAMAIS neutre : il est lu comme « ce serveur demande une authentification ».
- **Le connecteur émet des `GET /mcp` SANS aucun porteur** (constaté au `wrangler tail` :
  les POST portent `?key=`, les GET arrivent nus). Ces GET — le flux SSE serveur→client,
  optionnel dans le transport streamable — sont donc refusés en 404 et le connecteur
  retombe en POST seul, sans perte pour les 10 outils (aucune notification serveur→client).
  Ne pas « réparer » ça en ouvrant les GET : ce serait un trou. L'option propre, si un jour
  le flux devient utile, est d'accepter le `mcp-session-id` (64 hex émis par le DO) comme
  preuve sur les GET seulement.

Trois points à ne pas défaire :
(1) la vérification est dans le handler de module, donc AVANT le Durable Object — c'est ce
qui fait qu'un appel non autorisé ne coûte rien ; (2) un refus répond **404, jamais 401** —
un 401 annonce un serveur MCP et déclenche la découverte OAuth des clients ; (3) **l'endpoint
est FERMÉ PAR DÉFAUT** (2026-08-27, aligné sur le jumeau) — aucun secret configuré ⇒ tout
est refusé. **Rouvrir n'est donc PLUS une seule commande** : c'est `npx wrangler secret list`
PUIS supprimer TOUS les `MCP_TOKEN*`. En oublier un laisse l'endpoint FERMÉ pendant qu'on
croit l'avoir rouvert — et le connecteur continue de creuser son trou OAuth pendant qu'on
cherche ailleurs. Remède de niveau code, souvent plus rapide : `npx wrangler rollback`.
Corollaire : `wrangler dev` exige désormais `--var MCP_TOKEN:… --var MCP_TOKEN_VEILLE:…`.
Ordre de bascule :
**mettre le connecteur claude.ai sur son URL FINALE (`…/mcp?key=<jeton>`) AVANT de poser le
secret**, puis déployer, puis `wrangler secret put`. Cet ordre est contre-intuitif mais
c'est le seul sûr : `?key=` répond 200 AVEC ET SANS secret (vérifié), donc l'URL finale
fonctionne déjà pendant que l'endpoint est ouvert, et le connecteur ne voit JAMAIS de 404.

**Pourquoi (incident du 2026-07-25, une demi-journée perdue)** : l'ordre inverse — armer
d'abord, corriger l'URL ensuite — a exposé le connecteur à une fenêtre de 404. Pour un
client MCP un 404 n'est pas « pas trouvé » mais « ce serveur exige une authentification » :
il est parti en découverte OAuth, a échoué à l'enregistrement dynamique, et s'est retrouvé
COINCÉ avec un enregistrement à moitié créé — plus modifiable, plus déplaçable, plus
supprimable, plus connectable depuis l'interface claude.ai. Aucune manipulation côté client
n'en venait à bout. Le SEUL déblocage a été `wrangler secret delete MCP_TOKEN` : l'endpoint
rouvert, le connecteur s'est réparé tout seul au retry suivant. Retenir : une fenêtre de
404, même de quelques minutes, peut détruire un connecteur de façon irréversible côté
client.

**Amendement du 2026-08-27 — ce remède n'est plus une seule commande.** Depuis l'ajout de
`MCP_TOKEN_VEILLE` et le passage au défaut fermé, l'endpoint ne se rouvre qu'en supprimant
**TOUS** les secrets `MCP_TOKEN*` ; les lister d'abord (`npx wrangler secret list`).
Supprimer `MCP_TOKEN` seul laisse la porte close. C'est le coût assumé du découpage par
client : écrit ici précisément parce que c'est sous pression qu'on viendra le lire.

**Un 404 de ce serveur est AMBIGU pour un client à état** : le transport rend lui aussi 404
sur une session qu'il ne détient plus. Le client de Pallas Athéna purge sa session sur 404,
donc un jeton révoqué s'y présente comme un battement de session — visible (refus en
français à chaque tour), jamais silencieux, mais mal diagnostiqué. Trancher au curl.

**Répéter une migration DESTRUCTIVE avant de la jouer en production.** Une migration qui
`DROP` quoi que ce soit — au premier chef `articles_fts`, table virtuelle à CONTENU EXTERNE —
se répète d'abord sur une base D1 **distante** jetable. **Un vert local ne prouve rien** :
miniflare accepte du DDL que le D1 distant REFUSE (il filtre des fonctions, `sqlite_version()`
entre autres). C'est mesuré, et c'est ce constat qui a fait créer une base de recette le
2026-09-11 avant d'appliquer 0004 sur 49 255 articles.

1. **L'approvisionner par `schema.sql` + TOUTES les migrations + `schema-decouverte.sql`.**
   Sans le troisième, ce N'EST PAS un miroir et son vert est FAUX. Mesuré le 2026-09-16 sur
   la recette de 2026-09-11 : son `laws` portait **12 colonnes au lieu de 17** (`fonction`,
   `forum`, `scope_fr`, `parent_law_id`, `name_norm` manquaient — ce sont des ALTER de
   `schema-decouverte.sql`). La répétition avait donc tourné sur une table amputée, et son
   `rebuild` + `integrity-check` sur ZÉRO ligne quand la production en avait 49 255.
2. **Comparer la recette à la production AVANT de conclure** : `pragma_table_info` table par
   table, pas le texte de `sqlite_master` (qui porte les commentaires du schéma et diverge
   sans conséquence). C'est le seul contrôle qui aurait vu l'amputation ci-dessus.
3. **La supprimer DANS LA MÊME SESSION.** Créer coûte une seconde ; c'est l'oubli du ménage
   qui laisse des orphelins. Celle de 2026-09-11 a servi 46 secondes, survécu cinq jours et
   n'a été supprimée que le 2026-09-16 ; son second but déclaré (« la phase 4 en aura
   besoin ») n'a jamais eu lieu.
4. **La supprimer PAR UUID, et JAMAIS depuis un agent.** `wrangler d1 delete` affiche
   « About to delete… » puis appelle `confirm2("Ok to proceed?")` SANS options
   (`cli.js:238608`) ; `confirm2` pose `fallbackValue = true` et le renvoie hors contexte
   interactif (`cli.js:129876`), « interactif » valant `stdin.isTTY && stdout.isTTY`
   (`cli.js:36753`). Un agent, un `| tee`, une redirection : **la confirmation s'auto-répond
   OUI** — constaté en vrai le 2026-09-16. L'UUID supprime en plus le risque de frappe : un
   nom de recette n'est qu'à quelques caractères du nom de production, et `d1 delete DB`
   résout le binding depuis `wrangler.jsonc`, donc vise la PRODUCTION.

**Prochain déclencheur, déjà écrit dans le dépôt** : indexer une headnote suppose une SECONDE
colonne pondérée dans `articles_fts`, donc `DROP` + `CREATE VIRTUAL TABLE` (en-tête de
`migrations/0003_curation.sql`, §3). C'est la prochaine fois que cette procédure servira.

**⏸️ DÉCISION REPORTÉE — `c-73.2-r.6`, deux divisions au même chemin (2026-09-16).**
Diagnostic COMPLET, correctif NON fait, et c'est délibéré. Les identifiants Irosoft sont
propres à CHAQUE DOCUMENT de l'EPUB, pas à l'EPUB entier : `page3.xhtml` et `page4.xhtml`
portent tous deux un `ga:l_ii`. Irosoft répète l'en-tête du chapitre en tête de la page de
continuation et y place le titre de la SECTION là où va celui du chapitre — d'où, à la
lecture page par page, deux « CHAPITRE II » au même chemin :

    page3 : ga:l_ii « CHAPITRE II — COMITÉ DE RÉVISION DES DÉCISIONS DU SYNDIC
                      — SECTION I COMPOSITION — art. 6…»
    page4 : ga:l_ii « CHAPITRE II — RÈGLES DE FONCTIONNEMENT — art. 8…»

La structure RÉELLE est un seul Chapitre II à deux sections. Conséquence servie
aujourd'hui : `get_division('ga:l_ii')` rend l'un des deux au hasard, et son sous-arbre
mélange les articles des deux. **UNE seule loi sur 97** (les deux langues), mesuré.

POURQUOI ON N'A PAS CORRIGÉ. Le correctif toucherait la boucle qui assemble les chemins
(`parser.py`, la boucle du spine) — donc les 79 lois québécoises — pour réparer deux
divisions dans une. L'asymétrie de risque est mauvaise. Et « réparer » recouvre DEUX choses
différentes : *désambiguïser* (deux chapitres distincts et adressables — mécanique et sûr,
mais la structure reste fausse au regard du règlement) ou *fusionner* (« Règles de
fonctionnement » devient la Section II — c'est la vérité juridique, mais il faut inférer
qu'une page continue la précédente, règle qu'on refuse de généraliser depuis UN exemple).
La seconde est la bonne ; elle exige un balayage des 79 EPUB pour vérifier qu'aucune autre
loi ne serait fusionnée à tort.

CE QUI REND L'ATTENTE SÛRE : la garde d'unicité de `validate.py` (ajoutée le même jour)
REFUSE désormais cette loi — `✗ chemins de division uniques: ga:l_ii ×2` → bascule refusée.
La donnée en production garde le défaut, mais plus rien ne peut le réintroduire en silence,
et la loi ne peut plus être réingérée tant que le parseur n'est pas corrigé. À reprendre
comme chantier propre, pas en appendice d'un autre.

**Reconstruire une base à partir de rien** (nouvel environnement, D1 de CI, dev local
vierge). `schema.sql` décrit l'ÉTAT INITIAL et les migrations s'appliquent PAR-DESSUS :
c'est pourquoi il porte encore `articles.consol_date` (retirée par 0002) et PAS
`search_log` (créée par 0001). Ne jamais éditer `schema.sql` comme s'il décrivait l'état
COURANT : SQLite n'a pas de « DROP COLUMN IF EXISTS », donc une colonne retirée des DEUX
côtés rend la migration injouable sur une base neuve (arrivé avec 0002, vu à l'audit).

```bash
npx wrangler d1 execute legislation --local --file=./schema.sql   # 1. état initial
PYTHONUTF8=1 ./.venv/Scripts/python.exe -m pipeline.discovery.migrate --target local
npx wrangler d1 migrations apply legislation --local              # 3. 0001, 0002, …
PYTHONUTF8=1 ./.venv/Scripts/python.exe -m pipeline.ingest --all --apply-local
PYTHONUTF8=1 ./.venv/Scripts/python.exe -m pipeline.discovery.load --target local
```

Épinglé en CI (étapes 1 et 3, sur une base jetable) : c'est le SEUL contrôle qui parte du
vide — le harnais d'éval ne teste que contre une base déjà peuplée.

**Ajouter une loi** : (1) ajouter EN FIN de `laws.config.json` (+ `ORDRE_ATTENDU` du
test) ; (2) dry-run de reconnaissance (`pipeline/discovery/recon.py`) — arrêt revue si
balisage inconnu ; (3) `ingest --law X` local puis remote (staging→bascule, invariants de
scan) ; (4) `discovery/load.py` + `relations.py` (les deux cibles) ; (5) passe éditoriale
de Jason sur `taxonomy.json` (sans mappage, la loi est invisible au signal S1) ;
(6) backfill vecteurs (procédure §6 du rapport phase 2) ; (7) `discovery/verify.py` —
comptes de `subjects`/`subject_map`/`law_relations` et résolution de chaque
`division_path` ; (8) mettre à jour les contrôles épinglés (« 78 lois »…) ;
(9) éval avant/après.

**Rafraîchissement semestriel** : `ingest --all --download --refresh-dates` (76 combos),
rechargement découverte, re-backfill vecteurs complet, éval. **Entièrement manuel et
sous surveillance** : le cron de `wrangler.jsonc` n'exécute RIEN (aucun handler
`scheduled`), et aucun workflow GitHub n'écrit plus en base — l'ancien `refresh.yml` a
été retiré parce qu'il ne rechargeait que les articles (ni découverte ni vecteurs),
laissant les embeddings sur l'ancien texte donc du droit périmé rendu en silence.

**Veille de consolidation** (`.github/workflows/veille-consolidation.yml` +
`scripts/check-consolidation.mjs`) : job **en LECTURE SEULE**, mensuel, qui compare la
date « À jour au » de chaque loi **sur son publieur officiel** à `consol_date_*` en D1
(lue via `legislation_list_laws` sur l'endpoint MCP — jeton de LECTURE `MCP_TOKEN` en secret
GitHub, toujours AUCUN secret Cloudflare) et ouvre/actualise une
issue étiquetée `veille-consolidation` quand un rafraîchissement est dû (issue close
automatiquement à la résolution). Il DÉTECTE, il ne bascule jamais.
**DEUX publieurs, donc DEUX miroirs**, chacun fidèle à sa moitié Python et borné à sa
bannière : `extractConsolidation` ↔ `fetch_consolidation` (LégisQuébec, blocs `text-end`) ;
`extractConsolidationFederale` ↔ `extrait_consolidation_federale` (Justice Canada, le seul
`<p id="assentedDate">`). Ce second bloc porte **deux** dates — « à jour » et « dernière
modification » — donc borner la portée ne suffit pas : c'est l'ancrage sur la phrase qui
les distingue, et un test compare les deux regex **lues en source**.
Une page atteinte mais illisible est un signal ACTIONNABLE (le miroir a peut-être cassé),
jamais un null confondu avec une panne réseau — verrouillé par
`scripts/check-consolidation.test.mjs` (26 contrôles, en CI). Deux signaux SÉPARÉS
depuis le 2026-07-23 : `drift` (dérive corpus) et `unreachable` (blocage réseau) —
le titre de l'issue dit lequel a parlé ET **quel publieur** a bloqué (sortie
`sources_bloquees`), et elle ne clôt que si les DEUX sont éteints
(une page injoignable est une loi NON VÉRIFIÉE, pas une loi à jour).
**Le seuil de joignabilité s'applique PAR PUBLIEUR** (`agregeParSeau`, 2026-09-14) :
agrégé, un blocage TOTAL du fédéral pesait 36/194 = 18,6 %, donc sous les 25 %, donc le job
passait vert pendant que 18 textes sur 97 n'étaient vérifiés par rien. Défauts trouvés par
revue adversariale (2026-07-21 et 2026-09-14) et corrigés avant le commit.

## Où trouver quoi

- **Sondes FTS5** (tokenizer `unicode61`, `remove_diacritics` ACTIF, AUCUN stemming
  français, `bm25`/`snippet`/`highlight`/`fts5vocab` disponibles) et **cas fondateur de
  l'art. 490 C.p.c.** — dans `src/lib.ts`, au-dessus de `toFtsQuery`. Mesurés en production
  le 2026-07-20 ; ce sont des faits sur la PLATEFORME, donc ils ne vieillissent pas quand le
  corpus grandit. Ils vivent dans le code parce qu'on en a besoin en touchant à la requête.
- `docs/ARCHITECTURE-NOTES.md` — **relevé daté du 2026-07-20**, ne fait PAS foi sur l'état
  courant ; réduit le 2026-07-30 à ce qu'il est seul à porter : les volumes de la base à
  38 lois et les écarts entre le plan Discovery v2 et la réalité, qui expliquent pourquoi
  les invariants 4, 6 et 10 existent.
- `docs/reports/phase-{0,1,2}.md` — mesures, décisions, coûts réels de Discovery v2, et les
  **bookmarks Time Travel** consignés avant chaque migration.
- `docs/phase0-structure-epub.md` — format EPUB Irosoft. **Référence vivante du parseur** :
  citée par `pipeline/__init__.py`, `parser.py` et `validate.py`, dont les valeurs témoins
  en viennent. C'est le seul document de `docs/` que du code appelle.
- `docs/archive/` — plans exécutés (la **phase 3 v2 — curation ⛔ — y reste à faire** :
  `qclaw-discovery-v2-implementation-plan.md`). Les vidages de reconnaissance en ont été
  retirés le 2026-07-30 : sorties reproductibles de `recon.py`, pas des décisions.
- `eval/baselines/*.json` — trajectoire mesurée : recall@10 40 % → 88 % → 98 %.
- `eval/cases.resolved.json` — cache des `division_path` de la vérité terrain, DÉRIVÉ
  (régénérable), pas ⛔ contrairement à `cases.json`. Il ne portait aucune revalidation :
  une clé périmée faisait chuter FR-couv **sans un mot**, et un ancien chemin PRÉFIXE du
  nouveau faisait au contraire SUR-estimer la couverture. `--refresh-paths` le revalide et
  sort sans mesurer — régénérer et mesurer d'un même geste invaliderait la comparaison aux
  baselines. Seule une réingestion du C.c.Q. ou du C.p.c. peut l'invalider.
- `docs/propositions-journal-2026-07-30.md` — premier dépouillement de `search_log` :
  cas d'éval et entrées de gazetteer **proposés** (⛔, rien d'appliqué).

## Mise en forme (Biome, depuis le 2026-09-16)

`npx biome check .` — 100 colonnes, guillemets doubles, virgules finales, points-virgules.
Même configuration que le connecteur jumeau, à **une** règle près.

**`complexity.noUselessStringRaw` est DÉSARMÉE, et il faut savoir pourquoi.** Biome
signale les deux `String.raw` de `src/site.ts` (`BOOT` et `JS`) comme inutiles, puisque
les blocs ne contiennent aujourd'hui aucune séquence d'échappement. C'est exact et c'est
hors sujet : le commentaire au-dessus de `JS` dit que `String.raw` est là **par
prudence**, parce que les antislashs d'un gabarit non balisé seraient mangés le jour où
l'on y écrira une expression régulière — en silence. Suivre Biome retirerait une garantie
pour gagner deux caractères, et casserait au passage `tests/page-client.test.mjs`, qui
extrait ces deux blocs **par leur nom** dans le texte source.
