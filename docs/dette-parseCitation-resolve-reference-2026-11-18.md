# Dette technique & post-mortem de quota — `parseCitation()` (`resolve_reference`)

**Date :** 2026-11-18  
**Statut :** Document de reprise différée (reporté après réinitialisation du quota hebdomadaire dans ~6 jours)  
**Portée réelle :** Uniquement `parseCitation()` dans `src/lib.ts` (appelé par `resolve_reference` dans `src/tools.ts`). Les 9 autres outils MCP (`find_relevant`, `list_laws`, `get_article`, `get_articles`, `get_structure`, `get_division`, `search_text`, `list_subjects`, `related_laws`), le parseur PDF (`pipeline/parser_pdf.py`), les profils, D1 et Vectorize ne sont **pas** touchés par cette dette.

---

## 1. Pourquoi le jalon M6 a tourné sur 7 rondes (et brûlé le quota)

1. **Mécanique de boucle adversariale non bornée :** Dans le jalon M6 (« Tier 5 Adversarial Hardening »), chaque correctif (`worker_p2_rN`) déclenchait une nouvelle vague de *Challengers* à boîte blanche lisant le code exact de `src/lib.ts`. Tant qu'un Challenger trouvait une formulation synthétique exploitant une frontière d'expression régulière, le sous-orchestrateur relançait une nouvelle ronde.
2. **Surface ouverte :** La grammaire des citations juridiques libres (directives de cours, numéros de salles, dates françaises avec exposant `1ᵉʳ`, règlements AMF citant leur loi habilitante `V-1.1` et annexes de formulaires contenant eux-mêmes l'expression *« A. Instructions générales »*) est une grammaire non régulière. Chaque patch regex de la ronde $N$ exposait un nouveau cas limite exploité à la ronde $N+1$ :
   - **Ronde 3 (`test/tier5-adversarial.test.ts:895-965`) :** `"Instruction générale relative au Règlement 45-106 (c. V-1.1, r. 21), 2A.1"` — la mention parenthétique `c. V-1.1, r. 21` détournait l'étape 1 vers le règlement (`v-1.1-r.21`) au lieu de `amf-ig-45-106`.
   - **Ronde 4 (`L967-1041`) :** `"Règlement 45-106 (RLRQ, c. V-1.1), art. 2.3"` — la mention de la loi habilitante `V-1.1` capturait `v-1.1` ou faisait extraire `1` (de `V-1.1`) comme numéro d'article.
   - **Ronde 5 (`L1043-1121`) :** Refus des districts non ingérés (`Mont-Laurier`, `Cowansville`, `Percé`), dates avec exposant Unicode `1ᵉʳ` captées comme `par. 1`, numéros de salles QCCQ (`Salles 2.06, 2.02 — 5`) captés comme `par. 2.02`, et `Annexe division 1` / `Annexe district 1`.
   - **Ronde 6 (`L1123-1219`) :** Libellés anglais (`"Superior Court Directives — Quebec District"` vs `"Quebec Division"`), subdivisions d'annexes séparées par virgule (`Annexe 51-102A1, Partie 1`, `rubrique 4`, `Appendice 1`), et `ch.` dans `CHAPITRE_EXPLICITE`.
   - **Ronde 7 (`L1221-1279`) :** Annexes du `Règlement 45-106` titrées `Annexe 45-106A2, A. Instructions générales` qui déclenchaient `citesInstructionGenerale()` et renvoyaient vers `amf-ig-45-106` au lieu de `v-1.1-r.21`.

**Leçon de gouvernance `/teamwork` :** Sur une fonction d'analyse de texte libre, ne jamais lancer de boucle Challenger illimitée ; borner à 1–2 rondes ciblées et exiger une grammaire/parseur borné plutôt que des rustines regex incrémentales.

---

## 2. Les trois risques techniques résiduels dans `src/lib.ts`

### Risque 1 — Retour arrière regex (ReDoS / plafond CPU Worker) sur `Annexe ...`
* **Emplacement :** `buildPseudoAnnexeEspace()` (`src/lib.ts:1288-1295`) et `STRIP_PSEUDO_NORM` (`src/lib.ts:1300-1303`), appelés dans `extractPseudoArticle()` (`L1305-1330`) et sur le chemin QCCS/QCCQ (`L1484`, `L1548`).
* **Mécanisme :** Quantificateurs `*` imbriqués avec lookaheads négatifs à l'intérieur d'une répétition (`(?:... (?!${stop})${ANNEXE_MOT})*` dans `subdiv` et `corps`).
* **Impact :** Une longue citation malformée commençant par `annexe ...` ou `schedule ...` contenant beaucoup de mots séparés par des virgules/espaces peut provoquer un retour arrière combinatoire et atteindre le plafond CPU d'une requête Cloudflare Worker sur `resolve_reference`.

### Risque 2 — Constantes de vague 1 codées en dur (dette d'extensibilité vague 2)
* **Emplacements :**
  1. `AMF_PAIRS` (`src/lib.ts:1263-1267`) et `STRIP_DATES_ET_SALLES` (`src/lib.ts:1334`) codent en dur exactement `31-103`, `45-106` et `51-102`.
  2. `AUTRES_DISTRICTS_QC` (`src/lib.ts:1271-1272`) code en dur ~80 municipalités/districts — **y compris `laval` et `longueuil`** — ainsi que `DISTRICT_NON_MTL` (`L1274-1275`) et `DIVISION_QCCS_NON_INGERE` (`L1276-1277`).
* **Impact :** Dès l'ajout de Laval/Longueuil ou d'une 4e paire AMF (ex. `61-101`, `81-102`), `resolve_reference` refusera silencieusement les nouveaux districts (interceptés par `AUTRES_DISTRICTS_QC`) ou ne retirera pas le code AMF avant l'extraction d'article (ex. `61` pris pour `art. 61`), obligeant à modifier `src/lib.ts` à chaque ajout dans `laws.config.json`.

### Risque 3 — Fragilité d'ordre et de lookahead sur les citations composées (risque R4)
* **Emplacements :** `citesInstructionGenerale()` (`src/lib.ts:1350-1366`), `isReg` (`L1383-1386`), suppression `normSansCour` / `narrow()` (`L1483-1587`), et `parseCitation()` étape 1 (`L1394-1415`).
* **Impact :** La désambiguïsation entre texte principal et mention accessoire (loi habilitante entre parenthèses, intitulé d'annexe contenant *« Instructions générales »*, référence croisée) dépend de cascades de lookaheads/lookbehinds plutôt que d'une séparation syntaxique claire. Tout nouveau motif de citation composée risque une fausse résolution ou exige une nouvelle rustine.

---

## 3. Plan de remédiation ciblé (1 seule session normale, sans `/teamwork`)

À exécuter après la réinitialisation du quota hebdomadaire, dans une conversation normale unique (faible consommation de tokens), en gardant **tous** les tests existants verts (`test/citation-pdf-amf.test.ts` et `test/tier5-adversarial.test.ts` Rounds 1–7).

1. **Remplacer `buildPseudoAnnexeEspace` / `STRIP_PSEUDO_NORM` par un scanneur linéaire $O(n)$ :**
   - Écrire un parseur séquentiel sans quantificateurs imbriqués (`tokenizePseudoAnnexe`) qui lit `annexe|schedule|formulaire` et consomme mot par mot jusqu'à un mot d'arrêt (`ANNEXE_STOP_COMMON` / fin de proposition) ou une subdivision (`Partie`, `rubrique`, `Appendice`, `A. Instructions générales`, `Instructions`), en bornant la longueur traitée.
   - Ajouter un test adversarial de temps d'exécution (`< 5 ms` sur une chaîne pathologique de 2 000 caractères commençant par `"Annexe a b c ..."`).

2. **Dériver dynamiquement les index AMF et QCCS/QCCQ à partir des lignes `laws` passées à `parseCitation(citation, laws)` :**
   - **AMF :** construire la table des paires `(code -> { regId, igId })` et le motif des codes connus directement depuis `laws` (`id` / `official_cite` / `name_fr` des règlements et `amf-ig-*`), au lieu de `AMF_PAIRS` et de la regex figée `(31-103|45-106|51-102)`.
   - **Districts / Divisions :** au lieu d'une liste noire statique qui piège les futurs ajouts comme `laval` ou `longueuil`, comparer tout `<district|division> de X` extrait de la citation contre l'ensemble réel des districts/divisions présents dans `laws` (et refuser si un nom explicite de district/division ne correspond à aucune ligne `qccs-*`/`qccq-*` chargée, sans liste noire figée à maintenir). Conserver la compatibilité stricte avec les tests existants (`Mont-Laurier`, `Cowansville`, `Percé`, `Quebec District`).

3. **Simplifier la désambiguïsation des citations composées (R4) :**
   - Découper proprement la citation en segment principal vs clauses parenthétiques / subordonnées (`pris en vertu de ...`, `relative à ...`, `Annexe <id>, ...`) avant l'appariement de texte, de sorte qu'une annexe d'un règlement (`Annexe 45-106A2, A. Instructions générales`) reste liée à son règlement et qu'une citation citant deux instruments sans relation claire retourne `ambigu` plutôt que de deviner.

4. **Vérifications obligatoires (procédure `GEMINI.md` des 6 surfaces) :**
   - Vérifier explicitement les 6 surfaces (`src/lib.ts` seul touché -> impact `Outils MCP` uniquement interne à `resolve_reference` ; surfaces 2–6 non touchées si aucun changement de contrat/comportement public ; mettre à jour `docs/architecture` / archiver ou annoter cette fiche de dette résolue).
   - Exécuter :
     ```powershell
     npx.cmd tsc --noEmit
     npx.cmd biome check .
     npm.cmd run audit
     npm.cmd test
     PYTHONUTF8=1 ./.venv/Scripts/python.exe -m unittest discover -s pipeline/tests -q
     ```

---

## 4. Prompt prêt à copier-coller dans 6 jours

```text
Lis `docs/dette-parseCitation-resolve-reference-2026-11-18.md`, `src/lib.ts` (autour de `parseCitation`), `test/citation-pdf-amf.test.ts` et `test/tier5-adversarial.test.ts`.
Exécute le plan de remédiation §3 en une seule passe propre (sans `/teamwork`) :
1. Remplacer `buildPseudoAnnexeEspace` / `STRIP_PSEUDO_NORM` par un scanneur linéaire O(n) sans risque ReDoS + test < 5 ms sur entrée pathologique.
2. Dériver dynamiquement les paires AMF et la détection des districts/divisions QCCS/QCCQ depuis le paramètre `laws` (supprimer la dépendance figée à `AMF_PAIRS` et aux districts futurs comme `laval`/`longueuil` dans `AUTRES_DISTRICTS_QC`).
3. Nettoyer la séparation texte principal vs clause accessoire/annexe en gardant 100 % des tests existants (`test/citation-pdf-amf.test.ts` et `test/tier5-adversarial.test.ts`) verts.
4. Évaluer les 6 surfaces `GEMINI.md` et exécuter `tsc --noEmit`, `biome check .`, `npm run audit` et `npm test`.
```
