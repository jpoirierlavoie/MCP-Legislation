# Phase 0 — Reconnaissance de la structure PDF (directives judiciaires et instructions AMF)

**Date de l'inspection :** 18 novembre 2026 (vague 1 complète : 13 PDF uniques mesurés + 3 EPUB de redirection LégisQuébec `V-1.1` inspectés).
**Source :** fichiers locaux fournis par l'utilisateur après autorisation R1 du `2026-11-18T17:44:28Z` pour l'ingestion non commerciale verbatim (`QCCS`, `QCCQ`, `AMF`) ainsi que les règlements appariés `RLRQ, c. V-1.1, r. 10/21/24` (téléchargement manuel pour les PDF derrière Cloudflare `HTTP 403`, aucun contournement).
**Fichiers inspectés (`pipeline/samples/`, gitignorés — 13 PDF uniques vague 1) :**
- **[MESURÉ — QCCS]** `2026-02-23_Directives_District_Montreal.pdf` — **498 520 octets**, SHA-256 `0fc38543825a3bfef0d3cc299f2f2557ae34d35a066b851364f7bc9768870cb2` (32 p., `qccs-dist-mtl`).
- **[MESURÉ — QCCS]** `Directives_de_la_division_de_Montreal.pdf` — **725 964 octets**, SHA-256 `aa876ce7d11539f5fad47b2d04456490fcb077530d5f386ca0964541684621de` (40 p., `qccs-div-mtl`). *Note :* `Directives_de_la_division_de_Montreal (1).pdf` est un doublon strictement identique (725 964 octets, même SHA-256), ignoré.
- **[MESURÉ — QCCS]** `2022-01-31_Directives_concernant_le_fonctionnement_de_la_division_de_Quebec.pdf` — **628 982 octets**, SHA-256 `6ca850eb6aa59a04ebb86a652f6e4f48be6069413ca4a1b5842a2d1341968051` (17 p., `qccs-div-qc`).
- **[MESURÉ — QCCQ]** `ChCivile_DirectiveReglesParticulieres.pdf` — **234 060 octets**, SHA-256 `7697b867fd52623f56db1b1fa7cf0bc964738f570355aa5247fbdabceea446e2` (2 p., `qccq-regles-simplifiees`).
- **[MESURÉ — QCCQ]** `MtlCivil_ModeFonctDivPratCivile.pdf` — **248 369 octets**, SHA-256 `a2788b5b3646e9a524e02a70159f98afd9c6c1e66c533ea089e900a14a5097b9` (6 p., `qccq-mtl-prat-civile`).
- **[MESURÉ — QCCQ]** `MtlCivil_ModeFonctDivPratAdmin.pdf` — **240 910 octets**, SHA-256 `0d7382ebd952ac2a87fa56e7b6f245551b1ab806a0cf34acbc40dfe506d9af37` (4 p., `qccq-mtl-prat-admin`).
- **[MESURÉ — QCCQ DAA, et non QCCA]** `DAA_DirectiveListeCommuneJuris.pdf` (normalisé depuis `DAA_DirectiveListeCommuneJuris (1).pdf`) — **509 591 octets**, SHA-256 `8d57aeebc574963dd96a19f7426c2de6f120808875a093b2130e2df6a7d2b04f` (20 p., `qccq-daa-jurisprudence`, juge en chef Lucie Rondeau, Cour du Québec).
- **[MESURÉ — AMF / `V-1.1` règlements]** `2026juil04-31-103-vofficielle-fr.pdf` — **860 381 octets**, SHA-256 `5a2423216895281913d2fee39a61dde0f57bd95a8de5642682c8b7a0383e5b7c` (168 p., `v-1.1-r.10`) ; `2025sept19-45-106-vofficielle-fr.pdf` — **1 412 644 octets**, SHA-256 `0ae6488ef7a704b5ea7b018178acf3a55645e941d0d787fbb402be80153c80ac` (261 p., `v-1.1-r.21`) ; `2026sept22-51-102-vofficielle-fr.pdf` — **1 119 039 octets**, SHA-256 `fc56d6e7df2df8cc2eead3e463f04d5a9661377f8e33d3208c9588839ea7225b` (211 p., `v-1.1-r.24`).
- **[MESURÉ — AMF Instructions générales]** `2026juil04-31-103-ig-vconsolidee-fr.pdf` — **1 086 098 octets**, SHA-256 `4cc1c096d3901174d034670c902b0feb30276d142cf7acf6893092c0838e488c` (196 p., `amf-ig-31-103`) ; `2023juin09-45-106-ig-vconsolidee-fr.pdf` — **431 110 octets**, SHA-256 `e57707a04d13e7047d9f22e3873c2ee41b71b210705935b9e13d0a83ab1910ef` (58 p., `amf-ig-45-106`) ; `2026sept22-51-102-ig-vadmin-fr.pdf` — **376 394 octets**, SHA-256 `2a432c8793865c39c2f087b6568ece6b58b4e4466370ff528f24685b2ac82164` (46 p., `amf-ig-51-102`).
- **[HORS VAGUE 1]** `QCCA` (directives et *Avis du greffier*), `QCCS` Laval/Longueuil, versions EN éventuelles.

**Méthode :** recensement exhaustif par `pipeline/discovery/recon_pdf.py` (`pymupdf` `1.28.2`, zéro LLM, zéro OCR), **sans liste blanche préalable** — toutes les polices, tailles, drapeaux, marges `x0`, bandeaux `y0`, annotations de liens, signets (`outline`/TOC) et formes de numérotation sont comptés. Les décomptes des **13 PDF uniques** ci-dessous sont **exhaustifs et mesurés** ; aucune métrique des corpus hors vague 1 n'est extrapolée. Ce document est le **contrat** cité par `pipeline/parser_pdf.py` (`§N`), à l'image de `docs/phase0-structure-lims.md` et `docs/phase0-structure-epub.md`.

---

## 1. Sources, accès, droits de reproduction et dates (audit R1)

### 1.1 Vérification des conditions d'utilisation, `robots.txt` et autorisation R1 (`2026-11-18T17:44:28Z`)

Tous les quatre domaines PDF de la vague 1 (ainsi que `www.tribunaux.qc.ca`) ont été sondés directement (`curl.exe` sur `/robots.txt`) et vérifiés via les pages légales indexées (`Location:` de redirection résolus). Les quatre éditeurs bloquent l'accès HTTP automatisé par Cloudflare Managed Challenge (`HTTP 403`) et affichent des clauses restreignant la reproduction, le stockage ou l'indexation en base de données. À la suite de la pause R1, **l'utilisateur a explicitement autorisé le `2026-11-18T17:44:28Z`** la poursuite de l'ingestion non commerciale verbatim sur les quatre éditeurs PDF (`QCCS`, `QCCQ`, `QCCA`, `AMF`) ainsi que sur les EPUB LégisQuébec `V-1.1` appariés, tout en maintenant l'interdiction stricte de contourner Cloudflare `HTTP 403` (les PDF distants manquants demeurent en pause jusqu'à leur téléchargement manuel par l'utilisateur dans `pipeline/samples/`).

| Éditeur / Domaine | `robots.txt` / Accès HTTP | Conditions vérifiées (extraits exacts) | Statut R1 |
|---|---|---|---|
| **QCCS** (`coursuperieureduquebec.ca`) | `HTTP 403` Cloudflare Managed Challenge (`cType: 'managed'`, JS+cookies requis) | Aucune licence ouverte indexée ; mention `« Tous droits réservés »` ; relève du réseau judiciaire `tribunaux.qc.ca` (copie, stockage et reproduction hors navigation soumis à autorisation écrite préalable). | **AUTORISÉ PAR L'UTILISATEUR (`2026-11-18T17:44:28Z`)** · 3 PDF en local (`qccs-dist-mtl`, `qccs-div-mtl`, `qccs-div-qc`) ; Laval/Longueuil hors vague 1 |
| **QCCQ** (`courduquebec.ca`) | `HTTP 403` Cloudflare Managed Challenge (`cType: 'managed'`) | Aucune licence ouverte indexée ; mention `© Cour du Québec - Tous droits réservés` ; réseau `tribunaux.qc.ca`. | **AUTORISÉ PAR L'UTILISATEUR (`2026-11-18T17:44:28Z`)** · 4 PDF en local (`qccq-regles-simplifiees`, `qccq-mtl-prat-civile`, `qccq-mtl-prat-admin`, `qccq-daa-jurisprudence`) |
| **QCCA** (`courdappelduquebec.ca`) | `HTTP 403` Cloudflare Managed Challenge (`cType: 'managed'`) | `/propriete-intellectuelle` & `/en/intellectual-property` : *« Hormis pour les besoins propres à la navigation sur Internet et sauf indication contraire, il est strictement interdit de copier, de redistribuer, de reproduire, de republier, d'emmagasiner sur tout médium, de retransmettre ou de modifier l'information contenue sur ce site ou d'en faire un usage public ou commercial, sous quelque forme que ce soit. »* | **AUTORISÉ PAR L'UTILISATEUR (`2026-11-18T17:44:28Z`)** · Hors vague 1 (note : `DAA_DirectiveListeCommuneJuris.pdf` relève de la **QCCQ**, non de la QCCA) |
| **AMF** (`lautorite.qc.ca`) | `HTTP 403` Cloudflare Managed Challenge (`cType: 'managed'`) | `/grand-public/conditions-dutilisation/conditions-generales` : *« … vous ne pouvez pas vendre, distribuer, publier, afficher, modifier, indexer dans une base de données, copier, reproduire ou réutiliser de quelque façon que ce soit le contenu du site Web […] sans avoir obtenu au préalable le consentement écrit de l'Autorité. »* | **AUTORISÉ PAR L'UTILISATEUR (`2026-11-18T17:44:28Z`)** · 6 PDF en local (`v-1.1-r.10/21/24` + `amf-ig-31-103/45-106/51-102`) |

**Règlements AMF appariés (`V-1.1, r. 10 / r. 21 / r. 24` — vérification directe des EPUB LégisQuébec) :** les règlements édictés correspondant aux trois *Instructions générales* relèvent de `RLRQ, c. V-1.1` (et non `I-14.01`). Le téléchargement et l'inspection directe des 3 EPUB FR sur `legisquebec.gouv.qc.ca` (`HTTP 200 OK`) montrent qu'il ne s'agit que de **coquilles de redirection à 1 page** :
- `V-1.1,%20R.%2010.epub` (**360 759 octets**, 11 entrées ZIP, seul `OPF/page0.xhtml`, **0 division, 0 article**) redirigeant vers `lautorite.qc.ca` ;
- `V-1.1,%20R.%2021.epub` (**360 586 octets**, 11 entrées ZIP, seul `OPF/page0.xhtml`, **0 division, 0 article**) ;
- `V-1.1,%20R.%2024.epub` (**360 651 octets**, 11 entrées ZIP, seul `OPF/page0.xhtml`, **0 division, 0 article**).

LégisQuébec ne publiant aucun texte réglementaire exploitable dans ces EPUB (et l'AMF étant la seule source du texte officiel consolidé en ligne), la frontière « EPUB-first, PDF-only » (§5.1) impose pour `v-1.1-r.10`, `v-1.1-r.21` et `v-1.1-r.24` l'ingestion par **`parser_pdf.py`** avec `source = "pdf"`, `fonction = "reglement"`, `unit = "article"` et `enabling = "v-1.1"` (`reglement-de` auto vers `v-1.1` + `parent_law_id = 'v-1.1'`).

### 1.2 URL officielles repérées et règles d'épinglage des dates

| Texte / Ensemble | ID corpus | Langue | Fichier local / Source | État |
|---|---|---|---|---|
| QCCS — District de Montréal (directives) | `qccs-dist-mtl` | FR | `2026-02-23_Directives_District_Montreal.pdf` (`coursuperieureduquebec.ca`) | **[MESURÉ]** |
| QCCS — Division de Montréal (directives) | `qccs-div-mtl` | FR | `Directives_de_la_division_de_Montreal.pdf` (`coursuperieureduquebec.ca`) | **[MESURÉ]** |
| QCCS — Division de Québec (directives) | `qccs-div-qc` | FR | `2022-01-31_Directives_concernant_le_fonctionnement_de_la_division_de_Quebec.pdf` | **[MESURÉ]** |
| QCCQ — Règles particulières (gestion simplifiée) | `qccq-regles-simplifiees` | FR | `ChCivile_DirectiveReglesParticulieres.pdf` (`courduquebec.ca`) | **[MESURÉ]** |
| QCCQ — Montréal, pratique civile | `qccq-mtl-prat-civile` | FR | `MtlCivil_ModeFonctDivPratCivile.pdf` (`courduquebec.ca`) | **[MESURÉ]** |
| QCCQ — Montréal, pratique administrative | `qccq-mtl-prat-admin` | FR | `MtlCivil_ModeFonctDivPratAdmin.pdf` (`courduquebec.ca`) | **[MESURÉ]** |
| QCCQ — DAA, liste commune de jurisprudence | `qccq-daa-jurisprudence` | FR | `DAA_DirectiveListeCommuneJuris.pdf` (`courduquebec.ca`, juge en chef Lucie Rondeau) | **[MESURÉ]** |
| Règlement `31-103` (`RLRQ, c. V-1.1, r. 10`) | `v-1.1-r.10` | FR | `2026juil04-31-103-vofficielle-fr.pdf` (`lautorite.qc.ca`) | **[MESURÉ]** |
| Règlement `45-106` (`RLRQ, c. V-1.1, r. 21`) | `v-1.1-r.21` | FR | `2025sept19-45-106-vofficielle-fr.pdf` (`lautorite.qc.ca`) | **[MESURÉ]** |
| Règlement `51-102` (`RLRQ, c. V-1.1, r. 24`) | `v-1.1-r.24` | FR | `2026sept22-51-102-vofficielle-fr.pdf` (`lautorite.qc.ca`) | **[MESURÉ]** |
| IG `31-103` (AMF) | `amf-ig-31-103` | FR | `2026juil04-31-103-ig-vconsolidee-fr.pdf` (`lautorite.qc.ca`) | **[MESURÉ]** |
| IG `45-106` (AMF) | `amf-ig-45-106` | FR | `2023juin09-45-106-ig-vconsolidee-fr.pdf` (`lautorite.qc.ca`) | **[MESURÉ]** |
| IG `51-102` (AMF) | `amf-ig-51-102` | FR | `2026sept22-51-102-ig-vadmin-fr.pdf` (`lautorite.qc.ca`) | **[MESURÉ]** |
| QCCA — Directives et *Avis du greffier* ; QCCS Laval/Longueuil | — | FR / EN | — | **[HORS VAGUE 1]** |

**Règles fermes d'accès, d'épinglage et de date :**
1. **Zéro contournement WAF :** ne jamais contourner Cloudflare `403` ; les PDF bloqués requièrent un téléchargement manuel par l'utilisateur après confirmation R1.
2. **Épinglage par SHA-256 :** chaque profil déclaratif (`pipeline/pdf_profiles/*.json`) épingle le SHA-256 exact du fichier source ingéré.
3. **Date de consolidation lue dans le texte (`"À jour au …"`) :** ne jamais utiliser `HTTP Last-Modified` ni `/ModDate` du PDF. **Preuve mesurée sur QCCS Division de Montréal :** `/ModDate` vaut `D:20260702095820-04'00'` (2 juillet 2026) alors que la page 1 énonce explicitement **`À jour au 1er janvier 2026`**. Sur District de Montréal : `/ModDate` vaut `D:20260216093822-05'00'` (16 février) contre **`À jour au 23 février 2026`** en p. 1 et p. 4.

---

## 2. Enveloppe PDF, typographie, marges (`x0`) et bandeaux (`y0`)

### 2.1 Paramètres de mesure et refus strict des PDF numérisés (zéro OCR, zéro LLM)

`pipeline/discovery/recon_pdf.py` (et le futur `pipeline/parser_pdf.py`) extrait par `page.get_text("dict", flags=pymupdf.TEXTFLAGS_DICT & ~pymupdf.TEXT_PRESERVE_IMAGES)`, `page.get_images(full=True)`, `page.get_links()`, `page.rect` (en tenant compte de `p_dict["height"]` / `page.cropbox.height` et `page.derotation_matrix` sur les pages pivotées `/Rotate 90`/`180`/`270`) et `doc.get_toc(simple=False)` sous `PYTHONUTF8=1`, avec écriture UTF-8 LF sans BOM.

**Critères de refus dur (sans jamais recourir à l'OCR ni à un LLM) :**
- `doc.is_encrypted and doc.needs_pass` → `EncryptedPdfError` (code de sortie `2`).
- `0` octet ou flux invalide (`FileDataError`/`EmptyFileError`) → `CorruptPdfError` (code de sortie `2`).
- `doc.page_count == 0`, `total_non_ws_chars == 0`, `(total_images > 0 and avg_non_ws_chars_per_page < 10.0)`, ou numérisation partielle majoritaire (`len(image_only_pages) == page_count` ou `len(image_only_pages) > page_count / 2`, où une page est `image_only` si `page_images > 0 and page_non_ws_chars < 10`) → `ScannedPdfError` (code de sortie `2`).
- **Numérisation partielle minoritaire (`0 < len(image_only_pages) <= page_count / 2`) :** consignée explicitement dans `image_only_pages` et `warnings` (JSON + Markdown). Vérifié sur les deux PDF QCCS Montréal : **`image_only_pages == []`**.
- Présence massive de glyphes de remplacement `\ufffd` (`replacement_chars`) à signaler avant toute ingestion.

### 2.2 Inventaire mesuré — QCCS Montréal (`[MESURÉ]`)

| Mesure | `2026-02-23_Directives_District_Montreal.pdf` | `Directives_de_la_division_de_Montreal.pdf` |
|---|---|---|
| Pages & format | **32 p.**, `612.0 × 792.0 pt` (US Letter) | **40 p.**, `612.0 × 792.0 pt` (US Letter) |
| Producteur PDF | `Microsoft® Word pour Microsoft 365` | `Microsoft® Word pour Microsoft\u00A0365` |
| Couche texte & `\ufffd` | 1 540 spans · 47 865 car. non-blancs · **0 `\ufffd`** · 2 images (`image_only_pages == []`) | 2 357 spans · 67 082 car. non-blancs · **0 `\ufffd`** · 1 image (`image_only_pages == []`) |
| Espaces `Zs` hors ASCII | 0 dans le texte et `/creator` (Word a émis ASCII `0x20`) | 0 dans le texte ; `\u00A0` dans `/creator` et `/producer` uniquement |
| Corps dominant | `ArialMT` **12.0 pt** (1 031 spans) | `ArialMT` **12.0 pt** (1 768 spans) |
| Titres / niveaux | `Arial-BoldMT` **14.04 / 12.0 / 11.04 pt** | `Arial-BoldMT` **13.92 / 12.0 / 11.04 pt** |
| Historique (`Modification` / `Abrogation`) | `Arial-BoldItalicMT` **9.96 pt** (et `12.0 pt` en p. 32 ; spans finaux `ArialMT 12.0 pt` dont p. 20) + `6.48 pt` exposant (`er`) | `Arial-BoldItalicMT` **10.08 pt** (avec spans `,` / `er` en `Arial-BoldMT`) + `6.48 pt` exposant (`er`) |
| Notes de bas de page | `6.48 pt` appel `1` + `9.96 pt` texte en **p. 23** (`x0 = 92.18 pt`) | `6.48 pt` appel `1` + `10.08 pt` texte en **p. 18** (`1 Reconnaissance optique de caractères qui permet la recherche par mots-clés.`) |
| Puces & symboles | `SymbolMT` 12.0 pt en **p. 5–22** (50 spans : `−`, `•`) ; 0 `Wingdings2` | `SymbolMT` 12.0 pt en **p. 7–34** (48 spans) + `Wingdings2` 12.0 pt en **p. 25–26** (2 spans) |
| Bandeaux `y0` répétés | En-tête `<N>` sur 28 pages (`y=[48.42, 61.8]`) ; 0 pied répété | En-tête `<N>` sur 36 pages (`y=[36.44, 49.82]`) ; 0 pied répété |

**Clusters de marge gauche `x0` mesurés (hors bandeaux répétés) :**
- **Titres & numéros de paragraphes principaux (retrait négatif / *hanging indent*) :** `x0 ≈ 92.18 pt` (avec un cas isolé `88.82 pt` sur `46. Abrogé.` et **`85.1 pt` sur District p. 32** `LISTE DES ANNEXES` / sous-titres et entrées d'annexe ; dans Division p. 40, `LISTE DES ANNEXES` est à **`92.18 pt`**).
- **Corps de paragraphe et notes d'historique :** `x0 ≈ 120.5 pt` (District, 396 lignes) et `x0 ≈ 127.73 pt` (Division, 721 lignes).
- **Sous-éléments imbriqués (à rattacher au paragraphe parent) :**
  - Tirets/sous-numéros `1.`, `2.`, `−` : `x0 ≈ 138.5 pt`.
  - Lettres `a)`, `b)` : `x0 ≈ 148.9 pt`.
  - Puces `•` : `x0 ≈ 166.9 pt` (District) / `152.2 pt` (Division).
  - Chiffres romains `i.`, `ii.` : `x0 ≈ 163.0 pt` (Division).
- **Pagination romaine des pages liminaires (TOC p. 1–3) :** centrée `x0 ≈ 303–306 pt` (`i`, `ii`, `iii`).

### 2.3 Inventaire mesuré — 11 nouveaux PDF vague 1 (`[MESURÉ]`)

| ID | Pages | Spans (`0` non classé) | Particularités typographiques et géométriques mesurées |
|---|---|---|---|
| `qccs-div-qc` | 17 p. | **1 219 / 1 219** | TDM imprimée p. 1–2 (`(art. ... C.p.c.)` entre parenthèses) ; `Wingdings-Regular` `\uf0a7` (41 spans p. 16–17 → `▪`) ; 3 tableaux (`p. 4, 6, 7`) ; `71 LINK_URI` + `34 LINK_GOTO`. |
| `qccq-regles-simplifiees` | 2 p. | **143 / 143** | `doc.get_toc() = 0` ; articles `1..8` en gras de tête + sous-items `a.`..`g.` à `x0 = 127.7` ; note de refonte italique p. 1 (`note-preliminaire`) ; notes `1..3` en `x0 = 70.9` ; `7 LINK_URI` (`SJ-1273/1274/1276.pdf`). |
| `qccq-mtl-prat-civile` | 6 p. | **242 / 242** | `doc.get_toc() = 20` bruité ; articles titrés `1.1.`–`4.4.` à `x0 = 125.4` ; `PRÉAMBULE` + prose d'intro `3.` à `x0 = 90.0` ; date de clôture nue `21 juillet 2023` p. 6 ; `12 LINK_URI`. |
| `qccq-mtl-prat-admin` | 4 p. | **183 / 183** | `doc.get_toc() = 15` bruité ; `PRÉAMBULE` ; date de clôture nue p. 4 (`2023-07-21`) ; `12 LINK_URI`. |
| `qccq-daa-jurisprudence` | 20 p. | **1 788 / 1 788** | QCCQ DAA (juge en chef Lucie Rondeau) ; note inline mono-span `1 RLRQ, c. C-25.01, r.4, art. 39.` (`8.04 pt`) ; **19 tableaux** p. 2–20 ; `195 LINK_URI` (CanLII/BAILII) ; date `2021-09-27`. |
| `v-1.1-r.10` | 168 p. | **10 860 / 10 860** | Date multi-lignes / cartouche (`2026-07-04`) ; historique 9 pt (`A.M.`/`L.Q.`/`N.I.`/`D.`) ; collision `13.2.01 == 13.2.1` en `sort_key` ; `14.6.2` omis de `doc.get_toc()`. |
| `v-1.1-r.21` | 261 p. | **17 884 / 17 884** | **6 divisions abrogées** et **56 articles abrogés** (`(Abrogé).`) ; `Wingdings-Regular` `\uf0a8` (18 spans → `□`) ; encadrés italiques ; `2.35.1.1`, `5A.1..5A.6` ; lien brisé `http://sedar/` p. 179. |
| `v-1.1-r.24` | 211 p. | **14 534 / 14 534** | `4A.1..4B.3` ; `divisions = 93` ; `historique = 78` ; liens brisés `http://de/` et `http://sedar/`. |
| `amf-ig-31-103` | 196 p. | **10 774 / 10 774** | `Wingdings-Regular` `\uf0a7` (2 spans → `▪`) ; collision `13.2.01 == 13.2.1` ; 13 images de barres de graphique en p. 180 (`image_only_pages == []`). |
| `amf-ig-45-106` | 58 p. | **3 476 / 3 476** | Collision `3.4.01 == 3.4.1` ; tableaux de corps p. 34–36 ; date `2023-06-09`. |
| `amf-ig-51-102` | 46 p. | **2 920 / 2 920** | Pages paysage `792.0 × 612.0 pt` en **p. 44–45** avec pied de page à `y0 = 552.5 / 564.0` (exigeant un seuil relatif `y_ratio_min`) ; `4A.1..4A.8` ; date `2026-09-22`. |

---

## 3. Hiérarchie, signets (`outline`/TOC), chemins positionnels et `sort_key`

### 3.1 Signets PDF (`doc.get_toc()`) et table des matières imprimée

- **[MESURÉ — QCCS / QCCQ]**
  - `qccs-dist-mtl` et `qccs-div-mtl` : **`doc.get_toc()` = 0 signet** ; pages 1–3 (`i`, `ii`, `iii`) portent une **TDM imprimée** (District : 58 `LINK_GOTO` vers p. 4–32 ; Division : sans `LINK_GOTO`).
  - `qccs-div-qc` : `doc.get_toc()` = **150 signets bruités** ; la Porte 2 s'appuie sur la TDM imprimée p. 1–2 en retirant 6 renvois entre parenthèses `(art. ... C.p.c.)` (`strip_parentheticals`).
  - `qccq-mtl-prat-civile` (20 signets) et `qccq-mtl-prat-admin` (15 signets) : signets Word bruités (paragraphes entiers) → `toc_parser.source = "none"`.
  - `qccq-regles-simplifiees` (2 p.) et `qccq-daa-jurisprudence` : `doc.get_toc() = 0`, aucune TDM imprimée → `toc_parser.source = "none"`.
- **[MESURÉ — AMF / `V-1.1`]** `doc.get_toc()` exploitable pour la Porte 2 et le découpage des annexes (`annexes.mode = "full_sections"`), avec deux écarts éditoriaux mesurés : certains signets incluent un titre d'article numéroté (`exclude_numbered_articles`), et **`14.6.2` est absent des signets de `v-1.1-r.10`** (`toc_exempt_articles`).
- **Conséquence pour la Porte 2 (parité TOC ↔ Divisions) :** lorsque `toc_parser.source = "outline"` ou `"printed"`, la Porte 2 vérifie les rubriques contre les divisions du corps (`pages` de TDM exclues de l'ingestion d'articles) ; lorsque le document est court ou ses signets Word sont bruités (`"none"`), seules l'unicité `(law, lang, number)` / `(law, lang, path)` et la non-vacuité sont exigées.

### 3.2 Reconstruction par pile, chemins positionnels et miroir `SEG_SPLIT`

Les divisions sont reconstruites par pile à partir des niveaux typographiques définis au profil (`DIRECTIVES GÉNÉRALES` / `DIRECTIVES PROPRES AUX AFFAIRES DE LA CHAMBRE …` en majuscules grasses `12 pt` → niveau 1 ; sous-rubriques en gras `12 pt` mixte → niveau 2 ; `LISTE DES ANNEXES` → annexe) :
- **Chemins positionnels :** `ph<niveau>:<rang>` dans le corps (ex. `ph1:1-ph2:2`), `ps:<n>` dans les annexes, `pp:0` uniquement comme segment racine autonome pour un préambule éventuel (absent des deux QCCS Montréal ; ne jamais l'enchaîner après `-` tant que `SEG_SPLIT` ne déclare pas `pp`).
- **Miroir obligatoire `SEG_SPLIT` (`pipeline/paths.py:25` ↔ `src/paths.ts:50`) :** étendre les deux littéraux à l'identique en M3 (`-(?=(?:g[a-z]|fh\d+|fs|fp|ph\d+|ps):)`), vérifié caractère pour caractère par `tests/paths.test.mjs` et `pipeline/tests/test_paths.py`.
- **Bilinguisme :** `fr`-only est autorisé lorsqu'aucun PDF anglais officiel n'existe ; si un PDF EN existe (`[EN ATTENTE]`), l'isomorphisme FR↔EN doit être **mesuré** et non présumé.

### 3.3 `sort_key` (`pipeline/model.py`) ↔ `sortKeyOf` (`src/lib.ts`) et `validate.py`

- **[MESURÉ — 13 PDF vague 1]**
  - QCCS Montréal : District `1..172` + 9 décimaux ; Division `1..190` + 27 décimaux.
  - Règlements & IG AMF : sections alphanumériques et multi-niveaux mesurées (`2.35.1.1`, `4A.1..4B.3`, `5A.1..5A.6`, `13.2.01`, `3.4.01`), ainsi que préambule / note préliminaire (`note-preliminaire` à `sort_key = 0`) et annexes découpées (`annexes.mode = "full_sections"`).
  - **Collisions numériques réelles mesurées :** `13.2.01` et `13.2.1` coexistent dans `v-1.1-r.10` et `amf-ig-31-103` (de même `3.4.01` et `3.4.1` dans `amf-ig-45-106`) avec la **même `sort_key` numérique**. L'unicité `(law, lang, number)` et l'encodage `sort_key` en miroir exact (`model.py` ↔ `lib.ts`) maintiennent toute disposition réelle strictement dans `(0, DISPOSITION_SORT_BASE)` (`2 < 2.1 < 2A < 2A.1 < 2B < 3`), avec `sort_key("note-preliminaire") == 0` et `kind = 'annexe'` `>= DISPOSITION_SORT_BASE`. Dans `pipeline/validate.py`, les lacunes d'entiers sont non bloquantes lorsque `fonction in ("directive", "orientation")` ou sur les règlements CSA par sous-sections non contiguës.

---

## 4. Dispositions, sous-éléments, historique, abrogations et liens

### 4.1 Rattachement par bande `x0` et conservation des marqueurs internes

- **[MESURÉ — QCCS / QCCQ / AMF]**
  - QCCS Montréal : chaque paragraphe s'ouvre par `^\d+(?:\.\d+)*\.?` au cluster `x0 ≈ 92.18 pt` (`88.82 pt` pour `46. Abrogé.`), continuation à `120.5 pt` (District) / `127.73 pt` (Division).
  - QCCQ / QCCS Québec / AMF : outre les retraits négatifs classiques, certains documents utilisent des dispositions titrées (`titled_heading_mode`, ex. `1.1.`–`4.4.` à `x0 = 125.4 pt` dans `qccq-mtl-prat-civile`), des sous-items lettrés `a.`..`g.` (`allow_alpha_dot_subitems`, ex. `qccq-regles-simplifiees` à `x0 = 127.7 pt`), ou exigent l'amorce en gras (`require_bold_lead`) et un point dans le numéro (`require_dot_in_number`, ex. `V-1.1` / IG AMF) afin de distinguer un numéro d'article d'un renvoi dans le texte courant.
  - Les sous-éléments indentés (`1.`, `2.`, `a)`, `a.`, `−`, `•`, `i.`) restent **à l'intérieur** de la disposition parente (`articles.text`), jamais promus en articles autonomes ; seul le numéro principal de tête est extrait vers `articles.number`.

### 4.2 Historique structuré (`R4`) et abrogations

- **[MESURÉ — QCCS Montréal & Corpus AMF / `V-1.1`]**
  - **Historique :**
    - **District :** **100** lignes d'historique dans le corps (+ **1** en p. 32 ; **110** articles avec `history` extraits après regroupement/annexes).
    - **Division :** **33** lignes d'historique (`30` articles avec `history`).
    - **AMF / `V-1.1` :** notes d'historique en **9 pt** (`A.M.`, `L.Q.`, `N.I.`, `D.`) sur une ou plusieurs lignes (`continue_while_max_size_pt` : **190** articles dans `v-1.1-r.10`, **143** dans `v-1.1-r.21`, **78** dans `v-1.1-r.24`), plus un journal final des modifications (`trailing_log_regex` → pseudo-article `historique-modifications` sur `v-1.1-r.10/21/24` et `amf-ig-31-103/45-106/51-102`).
    - **Conséquence impérative M3 (`parser_pdf.py`) :** combiner les préfixes explicites (`^(?:Modifications?|Abrogation)\s*:`, `A.M.`, `L.Q.`, `N.I.`, `D.`) et la typographie de continuation (`continue_while_max_size_pt`) pour extraire dans `articles.history` **sans** altérer `articles.text` (R4).
  - **Abrogations (`repealed = 1`) :**
    - **QCCS District :** **65** paragraphes abrogés (`64` `N. Abrogé.` + `1` `134. Abrogation.`).
    - **QCCS Division :** **6** paragraphes abrogés par ellipse `[…]` (`83.1 […]`–`88. […]`).
    - **AMF `V-1.1, r. 21` (`v-1.1-r.21`) :** **56** articles abrogés (dont la forme `(Abrogé).`) et **6 divisions abrogées** (`Division.repealed = 1`) ; `v-1.1-r.10` (**3** articles abrogés), `v-1.1-r.24` (**3**), `amf-ig-45-106` (**1**).
    - Toutes ces formes positionnent `repealed = 1` tout en conservant le texte officiel verbatim dans `articles.text`.

### 4.3 Annotations de liens (`page.get_links()` → `articles.links`)

- **[MESURÉ — 13 PDF vague 1]**
  - QCCS District : `53 LINK_URI` + `1 LINK_LAUNCH` (`38` dispositions liées). QCCS Division : `221 LINK_URI` (dont `mailto:par` p. 32 assaini ; `55` dispositions liées). QCCS Québec : `71 LINK_URI` + `34 LINK_GOTO` (`13` dispositions liées).
  - QCCQ : `qccq-regles-simplifiees` (`7 LINK_URI` `SJ-1273/1274/1276.pdf`, `4` liées), `qccq-mtl-prat-civile` (`12 LINK_URI`, `5` liées), `qccq-mtl-prat-admin` (`12 LINK_URI`, `5` liées), `qccq-daa-jurisprudence` (**`195 LINK_URI`** CanLII/BAILII dans les 19 tableaux, `6` dispositions liées).
  - AMF / `V-1.1` : `v-1.1-r.21` contient un lien Word brisé sans point de domaine **`http://sedar/`** (p. 179) et `v-1.1-r.24` contient **`http://de/`** et **`http://sedar/`** ; filtrés proprement par `links.ignore_host_without_dot`.
- **Règle d'extraction :** seuls les liens actionnables (`LINK_URI` avec hôte contenant `.`, hors bruit éditorial tel `mailto:par` / `http://sedar/` / `http://de/`, plus `LINK_LAUNCH` courriel assaini) sont sérialisés dans `articles.links` (`[{"label": ..., "url": ...}]`) ; les `LINK_GOTO` internes ne sont jamais émis.

---

## 5. Frontière « EPUB-first, PDF-only » et Bilan de matière 100 % des spans (Porte 1)

### 5.1 Frontière impérative de source

| Catégorie juridique | Source obligatoire | Justification |
|---|---|---|
| Lois et règlements édictés du Québec publiés en EPUB complet | **EPUB LégisQuébec** (`parser.py`) | Texte officiel structuré par Irosoft déjà disponible en HTTP 200. |
| Règlements AMF édictés sous `V-1.1` à EPUB LégisQuébec vide (`RLRQ, c. V-1.1, r. 10`, `r. 21`, `r. 24`) | **PDF officiel AMF (`parser_pdf.py`)** avec `fonction='reglement'` | Les 3 EPUB LégisQuébec (`~360.6–360.8 Ko`, 11 entrées ZIP, seul `OPF/page0.xhtml`, **0 article**) ne sont que des pages de redirection vers l'AMF ; l'AMF est l'unique source du texte consolidé complet. |
| Lois et règlements fédéraux | **XML LIMS Justice Canada** (`parser_lims.py`) | Dépôt officiel `justicecanada/laws-lois-xml`. |
| Directives judiciaires (QCCS, QCCQ) et *Instructions générales* AMF | **PDF (`parser_pdf.py`)** | Aucun EPUB ni XML officiel disponible. |

### 5.2 Porte 1 — Bilan de matière 100 % des spans (`0` span non classé)

Inspiré de `docs/phase0-structure-lims.md` §5 et §7.3 : chaque span extrait de chaque page doit entrer dans un seau de provenance explicite (`running_header`, `running_footer`, `consolidation_date`, `whitespace_only`, `heading_or_division`, `numbered_provision`, `subitem`, `history`, `repeal_marker`, `body_text`, `toc_preliminaire`, `table_text`, `footnote`, `annexe`). Tout `unclassified > 0` ou divergence `comptabilisés != total_spans` arrête l'ingestion.

**Mesuré par `parser_pdf.py` sur l'ensemble des 13 PDF vague 1 (`unclassified_spans == 0`, couverture 100 %) :**
- `qccs-dist-mtl` : **1 540 / 1 540** · `divs=55` · `arts=195` (`real=181, rep=65, disp=14`) · `date=2026-02-23` · `links=38` · `hist=110`
- `qccs-div-mtl` : **2 357 / 2 357** · `divs=65` · `arts=229` (`real=217, rep=6, disp=12`) · `date=2026-01-01` · `links=55` · `hist=30`
- `qccs-div-qc` : **1 219 / 1 219** · `divs=35` · `arts=89` (`real=86, rep=0, disp=3`) · `date=2022-01-31` · `links=13`
- `qccq-regles-simplifiees` : **143 / 143** · `divs=3` · `arts=8` (`real=8`) · `date=2026-05-14` · `links=4`
- `qccq-mtl-prat-civile` : **242 / 242** · `divs=5` · `arts=17` (`real=15, disp=2`) · `date=2023-07-21` · `links=5`
- `qccq-mtl-prat-admin` : **183 / 183** · `divs=4` · `arts=11` (`real=10, disp=1`) · `date=2023-07-21` · `links=5`
- `qccq-daa-jurisprudence` : **1 788 / 1 788** · `divs=8` · `arts=11` (`real=5, disp=6`) · `date=2021-09-27` · `links=6`
- `v-1.1-r.10` : **10 860 / 10 860** · `divs=60` · `arts=205` (`real=190, rep=3, disp=15`) · `date=2026-07-04` · `hist=190`
- `v-1.1-r.21` : **17 884 / 17 884** · `divs=146 (rep=6)` · `arts=274` (`real=144, rep=56, disp=130`) · `date=2025-09-19` · `links=3` · `hist=143`
- `v-1.1-r.24` : **14 534 / 14 534** · `divs=93` · `arts=156` (`real=78, rep=3, disp=78`) · `date=2026-09-22` · `hist=78`
- `amf-ig-31-103` : **10 774 / 10 774** · `divs=48` · `arts=122` (`real=97, disp=25`) · `date=2026-07-04` · `links=1`
- `amf-ig-45-106` : **3 476 / 3 476** · `divs=7` · `arts=56` (`real=54, rep=1, disp=2`) · `date=2023-06-09`
- `amf-ig-51-102` : **2 920 / 2 920** · `divs=16` · `arts=72` (`real=70, disp=2`) · `date=2026-09-22` · `links=2`

---

## 6. Blocs spéciaux : annexes, listes de jurisprudence, tableaux et collisions

1. **`LISTE DES ANNEXES` (dernière page des deux QCCS Montréal) :**
   - District p. 32 (`x0 = 85.1 pt`) : renvoie aux formulaires Division 1–8 + District 1–5 via des **`LINK_URI`** vers des `.docx`/`.doc` externes (et note `Annexe district Montréal 6. Abrogation : 23 février 2026`).
   - Division p. 40 (`x0 = 92.18 pt`) : renvoie aux formulaires `Division 1.` à `Division 8.` via **11 boîtes `LINK_URI`** (les titres `Division 6`–`8` ont chacun 2 annotations scindées sur 2 lignes).
   - **Modélisation :** extraits comme pseudo-articles adressables `kind = 'annexe'` (`sort_key >= DISPOSITION_SORT_BASE`, numéros préfixés `annexe-division-1`, `annexe-district-1`, etc., pour éviter toute collision avec les paragraphes `1..190`) portant les URL dans `articles.links`.
2. **`LISTES COMMUNES DE JURISPRUDENCE` (Division PDF p. 34–39 / pages imprimées 31–36) :** paragraphes `187..190` suivis de listes d'arrêts cliquables (**91 `LINK_URI`** en p. 35–39 vers CanLII / SOQUIJ / Lexum CSC) — les URL doivent être capturées dans `articles.links` des dispositions correspondantes.
3. **Notes de bas de page :** mesurées en District p. 23 (`6.48 pt` + `9.96 pt`), Division p. 18 (`6.48 pt` + `10.08 pt`), `qccq-regles-simplifiees` (`1..3` à `x0 = 70.9`) et `qccq-daa-jurisprudence` (note inline mono-span `1 RLRQ, c. C-25.01, r.4, art. 39.` en `8.04 pt`, `allow_inline_lead`) ; rattachées explicitement sans promotion en dispositions numérotées.
4. **Tableaux déterministes (`page.find_tables()`), préambules et grandes annexes (`annexes.mode = "full_sections"`) :**
   - Tableaux mesurés et extraits par `page.find_tables()` sur `qccs-div-qc` (3 tableaux p. 4, 6, 7), `qccq-daa-jurisprudence` (**19 tableaux** p. 2–20 avec `195 LINK_URI`), `amf-ig-45-106` (tableaux p. 34–36) et annexes de `v-1.1-r.10/21/24` + IG AMF (spans exclus dans `table_text`/`annexe`, texte rendu linéairement avec préservation des boîtes de liens).
   - Préambules et prose introductive non numérotée : `note-preliminaire` (`preamble_number` à `sort_key = 0`) sur `qccq-regles-simplifiees` et les règlements `V-1.1` / IG AMF (encadrés italiques) ; `allow_division_intro_prose` (`intro-*`) et `unnumbered_prose_divisions` sur `qccq-mtl-prat-civile` / `qccq-mtl-prat-admin` / `qccq-daa-jurisprudence`.
   - Annexes volumineuses AMF / `V-1.1` : découpées par `annexes.mode = "full_sections"` selon les signets `doc.get_toc()` post-annexe, garantissant chaque ID Vectorize `art:<law_id>:<number> <= 64` octets UTF-8 et chaque ligne D1 bien en deçà du plafond de `100 Ko` UTF-8.

---

## 7. Pièges d'extraction — règles fermes (mesurés en phase 0)

- **7.1 Zéro confiance dans `/ModDate` et `HTTP Last-Modified` :** mesuré sur Division (`modDate = 2026-07-02` vs texte `À jour au 1er janvier 2026`). Toujours extraire `"À jour au …"` depuis le corps/page titre.
- **7.2 Fusion des lignes par tolérance verticale `y <= 2.5 pt` (ancrée hors exposants) :** mesuré sur les **47** (District) et **27** (Division) spans exposants `er` (`6.48 pt`) de `1er`, plus les appels de note (`1`, `(1)`). Ancrer `anchor_y` sur les spans de ligne de base (`not (flags & 1)`) et ne jamais insérer d'espace avant un exposant collé (`1` + `er` → `1er`).
- **7.3 Polices symboliques `SymbolMT`, `Wingdings2` et `Wingdings-Regular` :** mesurées sur District (`SymbolMT` 50 spans), Division (`SymbolMT` 48 spans + `Wingdings2` 2 spans), `qccs-div-qc` (`Wingdings-Regular \uf0a7` 41 spans p. 16–17 → `▪`), `amf-ig-31-103` (`Wingdings-Regular \uf0a7` 2 spans → `▪`) et `v-1.1-r.21` (`Wingdings-Regular \uf0a8` 18 spans → `□`). Normalisées dans `_PUA_BY_FONT` lors de la sérialisation sans altérer le sens.
- **7.4 Pages liminaires de TDM (`i..iii`, p. 1–3) :** ne portent pas de numéros d'articles de corps, mais contiennent des titres identiques aux vrais intitulés du corps (et dans District, `58 LINK_GOTO`). Toujours borner le corps à partir de la page de début de contenu (`page 4` QCCS Montréal ; `page 3` QCCS Québec) et ne retenir la TDM que pour le contrôle Porte 2.
- **7.5 Sous-items indentés, renvois de salle, collisions `01` et dates/années :** ne pas promouvoir `1.`, `2.` à `x0 ≈ 138.5`/`139.5`, `a.`..`g.` à `127.7` (`qccq-regles-simplifiees`), les numéros de salle (`2.07 ou 2.12.`), les notes de bas de page (`6.48–8.04 pt`), ni `(2022) 154 G.O.Q. II` / `2019 CSC 65` en articles autonomes ; exiger le cluster `x0` de premier niveau et, au besoin, `require_bold_lead` / `require_dot_in_number`. Sur les textes AMF, tenir compte des paires exactes mesurées **`13.2.01 == 13.2.1`** (`v-1.1-r.10`, `amf-ig-31-103`) et **`3.4.01 == 3.4.1`** (`amf-ig-45-106`) ayant la même `sort_key`.
- **7.6 Collisions avec `45-106`, `51-102`, `31-103`, dates ISO et pages paysage :** les motifs d'articles alphanumériques (`2A.1`, `4B.2`, `5A.6`, `4A.8`) exigent un séparateur non-tiret et un point interne ou un délimiteur final. Les bandeaux de pied de page doivent supporter `y_ratio_min` relatif à la hauteur de page afin d'exclure les pieds des pages paysage `792.0 × 612.0 pt` (`amf-ig-51-102` p. 44–45 à `y0 = 552.5 / 564.0`).
- **7.7 Annotations de liens brisées ou non-URI :** filtrer `LINK_GOTO` des liens externes et assainir les artefacts éditoriaux mesurés (`LINK_LAUNCH` p. 8 District ; `mailto:par` p. 32 Division ; **`http://sedar/`** p. 179 `v-1.1-r.21` et **`http://de/`** / **`http://sedar/`** `v-1.1-r.24` écartés par `links.ignore_host_without_dot`).
- **7.8 Invariant de bilan par provenance (non auto-équilibré) :** chaque page et chaque span doit être comptabilisé par seau de provenance contre un témoin figé (`docs/phase0-structure-lims.md` §7.3).

---

## 8. Stratégie de parseur déclaratif (`pipeline/pdf_profiles/*.json`) et témoins figés

### 8.1 Algorithme déterministe (`parser_pdf.py`)

1. **Vérifier le profil JSON :** SHA-256 du PDF + métadonnées (`law_id`, `fonction`, `lang`, `source='pdf'`).
2. **Contrôle anti-numérisation (Porte 0) :** rejeter chiffrés, corrompus, 0 page, ou image seulement / numérisation majoritaire sans couche texte exploitable (`ScannedPdfError`), et signaler toute numérisation partielle minoritaire (`image_only_pages`).
3. **Exclusion des bandeaux `y0` & capture de date :** retirer les en-têtes/pieds répétés (`<N>`) en travaillant dans le repère des spans (`p_dict["height"]` / `cropbox`, compatible `/Rotate 90`/`180`/`270`) après avoir extrait la bannière `"À jour au …"`.
4. **Séparation liminaire / corps / annexes :** isoler la TDM imprimée (p. 1–3 pour contrôle Porte 2), parcourir les lignes reconstruites (`y <= 2.5 pt`, `_norm`) du corps puis des annexes.
5. **Segmentation `x0` et pile de divisions :** ouvrir les divisions (`ph<level>:<rank>`, `ps:<n>`) selon la typographie du profil ; ouvrir un paragraphe/article au `x0` principal ; rattacher les lignes de continuation, puces et sous-items (`a)`, `1.`, `−`) au parent.
6. **Extraction hors-texte `history`, `repealed`, `links` :** détacher les lignes `^(?:Modifications?|Abrogation)\s*:` (préfixe + typographie) dans `articles.history` ; positionner `repealed = 1` sur `Abrogé.`, `Abrogation.` et `[…]` ; attacher les `LINK_URI` (et `LINK_LAUNCH` courriel normalisé) par intersection de `bbox` (avec `derotation_matrix` si page pivotée) dans `articles.links`.
7. **Portes 1 & 2 + `validate.py` :** vérifier `unclassified_spans == 0`, parité TDM/signets ↔ divisions, unicité `(law, lang, number)` et `(law, lang, path)`.

### 8.2 Témoins figés de non-régression

- **`2026-02-23_Directives_District_Montreal.pdf` (`[MESURÉ]`) :**
  - SHA-256 `0fc38543825a3bfef0d3cc299f2f2557ae34d35a066b851364f7bc9768870cb2`, **32 pages**, **1 540 spans** (`0` non classé), consolidation **`2026-02-23`**, `image_only_pages == []`.
  - Paragraphes : entiers `1..172` (0 lacune) + 9 décimaux (`26.1`, `27.1`–`27.4`, `29.1`, `68.1`, `91.1`, `115.1`), **65** abrogés (`64` `N. Abrogé.` + `1` `134. Abrogation.` en p. 27, `0` sur ligne suivante), **100** lignes d'historique dans le corps (+ 1 en p. 32), `53 LINK_URI` + `1 LINK_LAUNCH`.
  - Témoin de préséance (§ 1, p. 4) : *« Ces directives complètent celles de la division de Montréal, mais ont préséance sur celles-ci. »*
  - Témoins d'abrogation (§ 46, p. 14 ; § 134, p. 27) : `46. Abrogé.` (`x0 = 88.82 pt`) et `134. Abrogation.`.
  - Témoin décimal + lien (§ 115.1, p. 26) : *« L’adresse courriel du registraire est registraires-mtl@justice.gouv.qc.ca. »* (`mailto:registraires-mtl@justice.gouv.qc.ca`).
- **`Directives_de_la_division_de_Montreal.pdf` (`[MESURÉ]`) :**
  - SHA-256 `aa876ce7d11539f5fad47b2d04456490fcb077530d5f386ca0964541684621de`, **40 pages**, **2 357 spans** (`0` non classé), consolidation **`2026-01-01`** (malgré `/ModDate` 2026-07-02), `image_only_pages == []`.
  - Paragraphes : entiers `1..190` (0 lacune) + 27 décimaux, **6** abrogés par `[…]` (`83.1 […]` p. 16 ; `84. […]`–`86. […]` p. 17 ; `87. […]`–`88. […]` p. 18), **33** lignes d'historique, `221 LINK_URI` (dont **91** en p. 35–39 `LISTES COMMUNES DE JURISPRUDENCE` et **11** en p. 40).
  - Témoin d'annexes (p. 40) : `Division 1.` .. `Division 8.` avec liens `.docx`/`.doc` vers `coursuperieureduquebec.ca`.
- **`2022-01-31_Directives_concernant_le_fonctionnement_de_la_division_de_Quebec.pdf` (`qccs-div-qc`, `[MESURÉ]`) :** SHA-256 `6ca850eb6aa59a04ebb86a652f6e4f48be6069413ca4a1b5842a2d1341968051`, **17 pages**, **1 219 / 1 219 spans** (`0` non classé), `date = 2022-01-31`, `35` divisions, `89` articles (`86` réels, `3` dispositifs spéciaux), `13` articles avec liens, 3 tableaux (`p. 4, 6, 7`), `Wingdings-Regular \uf0a7` (41 spans p. 16–17).
- **QCCQ (`[MESURÉ]`) :**
  - `qccq-regles-simplifiees` : **2 pages**, **143 / 143 spans**, `date = 2026-05-14`, `3` divisions, `8` articles, `4` avec liens (`SJ-1273/1274/1276.pdf`), sous-items `a.`..`g.`.
  - `qccq-mtl-prat-civile` : **6 pages**, **242 / 242 spans**, `date = 2023-07-21`, `5` divisions, `17` articles (`15` réels, `2` intro/annexe), `5` avec liens.
  - `qccq-mtl-prat-admin` : **4 pages**, **183 / 183 spans**, `date = 2023-07-21`, `4` divisions, `11` articles (`10` réels, `1` spécial), `5` avec liens.
  - `qccq-daa-jurisprudence` (QCCQ DAA, non QCCA) : **20 pages**, **1 788 / 1 788 spans**, `date = 2021-09-27`, `8` divisions, `11` articles (`5` réels, `6` spéciaux), **19 tableaux** et `195 LINK_URI` (`6` dispositions liées).
- **Règlements `V-1.1` et Instructions générales AMF (`[MESURÉ]`) :**
  - `v-1.1-r.10` : **168 p.**, **10 860 spans**, `60` div., `205` art. (`190` réels, `3` abrogés, `15` spéciaux), `190` hist., `date = 2026-07-04` (`13.2.01 == 13.2.1` ; `14.6.2` omis des signets).
  - `v-1.1-r.21` : **261 p.**, **17 884 spans**, `146` div. (**6 abrogées**), `274` art. (`144` réels, **56 abrogés**, `130` spéciaux), `143` hist., `date = 2025-09-19`, `2.35.1.1`, `5A.1..5A.6`, `Wingdings-Regular \uf0a8` (18 spans), `http://sedar/` filtré.
  - `v-1.1-r.24` : **211 p.**, **14 534 spans**, `93` div., `156` art. (`78` réels, `3` abrogés, `78` spéciaux), `78` hist., `date = 2026-09-22`, `4A.1..4B.3`, `http://de/` et `http://sedar/` filtrés.
  - `amf-ig-31-103` : **196 p.**, **10 774 spans**, `48` div., `122` art. (`97` réels, `25` spéciaux), `date = 2026-07-04`, `Wingdings-Regular \uf0a7` (2 spans), `13.2.01 == 13.2.1`.
  - `amf-ig-45-106` : **58 p.**, **3 476 spans**, `7` div., `56` art. (`54` réels, `1` abrogé, `2` spéciaux), `date = 2023-06-09`, `3.4.01 == 3.4.1`, tableaux p. 34–36.
  - `amf-ig-51-102` : **46 p.**, **2 920 spans**, `16` div., `72` art. (`70` réels, `2` spéciaux), `date = 2026-09-22`, pages paysage p. 44–45 (`y_ratio_min`), `4A.1..4A.8`.

---

## 9. Questions ouvertes — décisions prises et décisions restantes

**Tranchées par la mesure (13 PDF vague 1 + EPUB `V-1.1`) :**
1. **TDM et signets (`toc_parser.source`) :** `"printed"` sur QCCS Montréal & Québec (`strip_parentheticals` sur Québec), `"none"` lorsque `doc.get_toc()` est vide ou bruité (`QCCQ`), et `"outline"` sur AMF/`V-1.1` (avec `exclude_numbered_articles` et exemption explicite de `14.6.2` dans `v-1.1-r.10`).
2. **Tolérance verticale `y <= 2.5 pt`, `y_ratio_min` et exposants :** l'ancrage hors exposants préserve `1er` et les appels `(1)`, tandis que `y_ratio_min` exclut les pieds de pages paysage (`amf-ig-51-102` p. 44–45 à `612 pt` de hauteur).
3. **`/ModDate` non fiable :** la date est lue depuis le corps, la cartouche multi-ligne AMF ou le bloc de clôture (`closing_blocks`), jamais depuis `/ModDate`.
4. **Historiques, abrogations et liens brisés :** `^(?:Modifications?|Abrogation)\s*:` et `9 pt` `A.M.`/`L.Q.`/`N.I.`/`D.` (`continue_while_max_size_pt` + `trailing_log_regex`), `Division.repealed` sur `(Abrogé).`, et `links.ignore_host_without_dot` écartant `http://sedar/` et `http://de/`.
5. **Règlements `RLRQ, c. V-1.1, r. 10/21/24` par `parser_pdf.py` :** les 3 EPUB LégisQuébec vérifiés ne sont que des coquilles de redirection vers l'AMF (`360.6–360.8 Ko`, 0 article) ; ils entrent donc légalement en `source = "pdf"`, `fonction = "reglement"`, `unit = "article"` avec lien auto `reglement-de -> v-1.1`.
6. **Attribution exacte de `DAA_DirectiveListeCommuneJuris.pdf` :** émise par la **Cour du Québec (`QCCQ`, DAA)** (`qccq-daa-jurisprudence`) et non par la QCCA ; `Directives_de_la_division_de_Montreal (1).pdf` est un doublon byte-à-byte ignoré.

**Tranchées par l'architecture et par l'utilisateur :**
1. **Autorisation R1 accordée (`2026-11-18T17:44:28Z`) :** ingestion non commerciale verbatim autorisée pour les 13 PDF fournis manuellement dans `pipeline/samples/`.
2. **Garde `PDF_CORPUS` (R8) + frontière EPUB-first (`§5.1`) :** `parser_pdf.py` reste zéro LLM / zéro OCR avec `ScannedPdfError` dur ; `PDF_CORPUS` reste à `"0"` jusqu'à la bascule M5.
3. **Chemins `ph<level>:<rank>` / `ps:<n>` et `sort_key` alphanumérique `< 9e15` :** verrouillés en miroir exact Python ↔ TypeScript (`paths.py` ↔ `paths.ts`, `model.py` ↔ `lib.ts`) et couverts par tests unitaires.
4. **Porte 1 (100 % des spans), Porte 2 (parité TDM/signets) et plafonds D1/Vectorize :** `0` span non classé sur les 13 PDF, IDs Vectorize `<= 64` octets UTF-8 et lignes D1 `< 100 Ko` UTF-8 (via `annexes.mode = "full_sections"`).

**Restant à trancher hors M3 (M4/M5 ou vagues ultérieures) :**
1. **Attribution et mentions `LICENSE` / `README.md` / `src/site.ts` en M5** avant passage de `PDF_CORPUS` à `"1"`.
2. **Vagues ultérieures éventuelles (`QCCA`, `QCCS` Laval/Longueuil, versions EN)** soumises aux mêmes Portes 0/1/2 et au même épinglage SHA-256.

---

*Contrat de phase 0 vérifié et mesuré sur les 13 PDF uniques de la vague 1 (`pipeline/pdf_profiles/*.json`, `pipeline/parser_pdf.py`).*
