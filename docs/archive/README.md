# Archive — plans et rapports historiques

Documents **exécutés et clos**, conservés pour l'historique des décisions. Ne pas s'en
servir comme référence de l'état courant : plusieurs de leurs hypothèses ont été
invalidées en cours de route (les écarts sont consignés dans `../reports/`).

| Document | Rôle historique | Statut |
|---|---|---|
| `PLAN.md` | Plan initial du serveur MCP (phases 0–5 : parseur EPUB, schéma D1, Worker, outils, déploiement) | Exécuté (2026-07) |
| `plan-couche-decouverte.md` | Couche découverte v1 (phases A–E : taxonomie, graphe, 36 textes, outils d'orientation) | Exécuté (2026-07) |
| `qclaw-discovery-v2-implementation-plan.md` | Discovery v2 (phases 0–3 : relaxation, hybride sémantique, curation) | Phases 0–2 exécutées ; **la phase 3 (curation ⛔) reste à faire** — ce document demeure sa spécification |
| `phase4-cpc-en-reconnaissance.md` | Reconnaissance du C.p.c. anglais (phase 4 v1) | Ingestion faite |
| `note-legislation-federale.md` | Note de cadrage du corpus fédéral : sources, licence, format LIMS, plan par phases | Exécutée (2026-09) — **arrivée de la racine le 2026-09-17** |
| `SPEC-corpus-federal.md` | Spécification du corpus fédéral : 16 lois + 2 règlements de Justice Canada, parseur LIMS, veille à deux publieurs | Exécutée (2026-09) — **arrivée de la racine le 2026-09-17** |

### Pourquoi ces deux-là sont descendus de la racine

Le chantier qu'ils décrivent est **livré et déployé** (18 textes servis depuis le
2026-09-11), mais ils étaient rédigés au FUTUR et ne portaient leur date que dans une phrase
perdue : posés à la racine, ils se lisaient comme des consignes courantes. Ils nommaient en
outre des outils `qclaw_*` qui n'existent plus, et la table de recette de la SPEC exigeait un
`node --test` inatteignable depuis le passage à vitest. Aucun fichier du dépôt ne les citait —
vérifié : `git ls-files | xargs grep -l` ne rendait rien.

Ce qu'ils portaient de DURABLE a été rapatrié dans `CLAUDE.md` AVANT le déplacement
(invariant 17 et sa clause de portée). Ils restent ici pour le RAISONNEMENT : pourquoi ces
choix-là, et ce qui avait été mesuré pour les arrêter.

## Rapports de reconnaissance — retirés le 2026-07-30

Trois vidages de dry-run ont été supprimés : `reconnaissance-36.md` (phase B v1),
`reconnaissance-lot-2026-07-21.md` (lot 2, 38 → 47 lois, commit `7c08c73`) et
`reconnaissance-lot3-2026-07-21.json` (lot 3, 47 → 78 lois, commit `0c1418f`). Ils
pesaient 95 Ko, soit 40 % de tout `docs/`.

Ce sont des **sorties de `pipeline/discovery/recon.py`**, pas des décisions : le programme
en régénère un à chaque lot d'extension. Leur contenu utile a d'ailleurs déjà été promu
là où il agit — les comptes d'articles sont devenus des invariants de validation, et les
lois qu'ils décrivaient sont en base. Ce qu'ils portaient encore, c'était l'état du
balisage Irosoft à la date de l'ingestion ; s'il faut le retrouver, `git log` les a.

Corollaire : `docs/reconnaissance-courante.md`, que `recon.py` écrit, est désormais
gitignoré. Un artefact reproductible et daté qui traîne dans `docs/` finit par se lire
comme un document de référence — c'est précisément le défaut que cette archive combat.

**Références vivantes :** `/CLAUDE.md` (invariants et procédures), `/README.md`, les JSON
versionnés et la page publique. `../ARCHITECTURE-NOTES.md` (relevé daté de la base au
2026-07-20 et écarts au plan v2 — réduit le 2026-07-30, il dit lui-même où le reste est
parti), `../reports/phase-{0,1,2}.md` (décisions, mesures, bookmarks Time Travel),
`../phase0-structure-epub.md` (format EPUB Irosoft — toujours la référence du parseur).
