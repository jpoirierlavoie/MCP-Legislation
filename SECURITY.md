# Security, Privacy & Professional Secrecy Policy / Politique de sécurité, confidentialité et secret professionnel

> **Français :** Ce dépôt héberge le connecteur MCP **Législation du Québec et du Canada** (`https://legislation.poirierlavoie.ca/mcp`), un Worker Cloudflare en lecture seule servant le texte officiel consolidé des lois et règlements via D1, Vectorize et Workers AI.
> Pour signaler une **vulnérabilité de sécurité** OU un **enjeu de vie privée, de confidentialité ou de secret professionnel / privilège** (`art. 9` *Charte des droits et libertés de la personne*, `art. 131` *Loi sur le Barreau*), **n'ouvrez jamais d'issue publique sur GitHub**. Écrivez directement au mainteneur :
> **Jason Poirier Lavoie, avocat (Québec)** — `jason@poirierlavoie.ca` (accusé de réception sous **72 heures**, divulgation coordonnée).
> **Ne transmettez jamais** de documents clients privilégiés, de noms de parties ou faits confidentiels réels, ni de jetons/secrets actifs (`MCP_TOKEN`, `MCP_TOKEN_VEILLE`, `BACKFILL_TOKEN`, `CLOUDFLARE_API_TOKEN`) dans un premier signalement ; utilisez des requêtes fictives.
>
> **English:** To report a **security vulnerability** OR a **privacy, confidentiality, or solicitor-client privilege / secrecy issue** affecting this connector, **do not open a public GitHub issue**. Email the maintainer privately:
> **Jason Poirier Lavoie, Lawyer (Québec)** — `jason@poirierlavoie.ca` (acknowledgement within **72 hours**, coordinated disclosure).
> **Never include** privileged client materials, confidential party/case details, or live tokens/API credentials in an initial report; use synthetic examples first.

---

## Portée

Dans la portée :
- Le Worker déployé sur `legislation.poirierlavoie.ca` (`POST /mcp`, `GET /`, `GET /mcp/server-card`, `GET /health`, `/admin/backfill-vectors`) ;
- Le code source dans `src/`, les migrations/schémas D1, le pipeline Python (`pipeline/`) et les manifestes clients (`plugin.json`, `mcp_config.json`, `gemini-extension.json`).

Hors portée :
- Ingénierie sociale, attaques physiques ou déni de service volumétrique sur l'infrastructure Cloudflare ;
- Données officielles d'origine (LégisQuébec / Éditeur officiel du Québec et ministère de la Justice du Canada) — toute erreur dans un texte officiel relève du publieur officiel.

---

## Données traitées, vie privée et secret professionnel

Ce serveur ne sert que des **textes législatifs et réglementaires publics** en lecture seule et n'héberge aucun dossier client. Deux points importants relatifs à la confidentialité et à la rétention sont toutefois exposés en toute transparence :

1. **Journalisation des requêtes de recherche (`search_log` dans D1)** :
   - La fonction `logSearch` enregistre en D1 la chaîne `query` soumise à `search_text` / `find_relevant` afin d'évaluer la qualité du repérage (replis lexicaux/sémantiques).
   - Avant persistance, `minimiserRequeteJournal` (`src/lib.ts`) normalise les espaces, masque les numéros de dossier judiciaire (`[DOSSIER]`), adresses courriel (`[COURRIEL]`), numéros de téléphone (`[TEL]`) et identifiants numériques longs NAS/NEQ (`[ID]`), et plafonne la chaîne à **160 caractères**. Chaque écriture déclenche en lot une purge glissante des entrées âgées de plus de **90 jours** (`ts < datetime('now', '-90 days')`).
   - Ce journal demeure anonyme quant à l'usager, mais le masquage par motifs ne remplace pas la discipline d'appel : par prudence déontologique, les appelants et les compétences doivent **formuler des requêtes juridiques abstraites** et **ne jamais insérer de noms de clients ni de faits identifiants confidentiels** dans le paramètre `query`.
   - En cas d'incident de confidentialité ou de demande d'effacement immédiat avant l'échéance de 90 jours, écrire à `jason@poirierlavoie.ca` (purge manuelle possible en D1 par horodatage).
2. **Porteur d'authentification dans l'URL (`?key=` vs `Authorization: Bearer`)** :
   - Trois formes équivalentes sont acceptées (`/mcp` + `Authorization: Bearer <jeton>`, `?key=<jeton>`, et `/mcp/<jeton>`).
   - Le paramètre `?key=` répond aux contraintes du formulaire de connecteur `claude.ai`, mais expose le jeton dans les journaux de requêtes HTTP d'arête Cloudflare ; pour tout client ou script qui le supporte (`Claude Code`, `Antigravity`, `Gemini CLI`, CI), employer systématiquement `Authorization: Bearer`.

---

## Contrôles de sécurité en production

- **Fermé par défaut :** `MCP_ENABLED` doit valoir explicitement `"true"` et au moins un secret figurant dans `NOMS_SECRETS` (`MCP_TOKEN`, `MCP_TOKEN_VEILLE` dans `src/auth.ts`) doit être configuré ; sinon toutes les routes `/mcp*` et `/health` répondent `404`.
- **Refus silencieux `404` (pas de `401`) :** Toute requête non authentifiée sur `/mcp*` reçoit `404` sans corps afin d'éviter la découverte OAuth non sollicitée des clients MCP et de ne pas révéler l'existence du point d'accès. Le contrôle d'authentification s'exécute avant le contrôle de méthode HTTP et avant tout traitement applicatif.
- **Comparaison cryptographique et protocole (`@poirierlavoie/mcp-socle`) :** Appariement SHA-256 à temps constant (`crypto.subtle.timingSafeEqual`), corps limité à `65 536` octets, décodage UTF-8 fatal, validation stricte des en-têtes MCP `2026-07-28`, sûreté prototype par `Object.hasOwn`.
- **Défense DNS rebinding et CORS :** Toute origine navigateur non reconnue (hors `claude.ai`, `claude.com`, `gemini.google.com`, `aistudio.google.com` et `ALLOWED_ORIGINS`) est refusée en `403` sans en-têtes CORS avant l'authentification.
- **Limitation de débit :** Binding `RATE_LIMITER` (300 requêtes / minute par `CF-Connecting-IP`, sans jamais employer le jeton comme clé). Échoue ouvert pour protéger la disponibilité en cas d'indisponibilité du compteur.
- **Page publique (`GET /`) et fiche SEP-2127 (`GET /mcp/server-card`) :**
  - `GET /` survit à `MCP_ENABLED=false`, n'émet aucun en-tête CORS (évite l'oracle cross-origine), porte une CSP `default-src 'none'` sans dépendance tierce, et les tests (`tests/catalogue.test.mjs`) interdisent toute fuite de jeton dans `src/site.ts` et `catalogue.json`.
  - `GET /mcp/server-card` expose uniquement les métadonnées publiques sans secret (soumise à `MCP_ENABLED`).

---

## Reproduction hors ligne de la suite de tests

La suite de tests complète (`tests/` et `test/`, 344 tests) tourne hors ligne sans accès Cloudflare ni secret de production :

```powershell
npm.cmd ci
npx.cmd tsc --noEmit
npm.cmd run lint
npm.cmd test
```
