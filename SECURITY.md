# Security, Privacy & Professional Secrecy Policy / Politique de sécurité, confidentialité et secret professionnel

> **Français :** Ce dépôt héberge le connecteur MCP **Législation du Québec et du Canada** (`https://legislation.poirierlavoie.ca/mcp` et `https://legislation.poirierlavoie.ca/mcp/oauth`), un Worker Cloudflare en lecture seule servant le texte officiel consolidé des lois, règlements, directives de pratique et orientations AMF via D1, Vectorize et Workers AI.
> Pour signaler une **vulnérabilité de sécurité** OU un **enjeu de vie privée, de confidentialité ou de secret professionnel / privilège** (`art. 9` *Charte des droits et libertés de la personne*, `art. 131` *Loi sur le Barreau*), **n'ouvrez jamais d'issue publique sur GitHub**. Écrivez directement au mainteneur :
> **Jason Poirier Lavoie, avocat (Québec)** — `jason@poirierlavoie.ca` (accusé de réception sous **72 heures**, divulgation coordonnée).
> **Ne transmettez jamais** de documents clients privilégiés, de noms de parties ou faits confidentiels réels, ni de jetons/secrets actifs dans un premier signalement ; utilisez des requêtes fictives.
>
> **English:** To report a **security vulnerability** OR a **privacy, confidentiality, or solicitor-client privilege / secrecy issue** affecting this connector, **do not open a public GitHub issue**. Email the maintainer privately:
> **Jason Poirier Lavoie, Lawyer (Québec)** — `jason@poirierlavoie.ca` (acknowledgement within **72 hours**, coordinated disclosure).
> **Never include** privileged client materials, confidential party/case details, or live tokens/API credentials in an initial report; use synthetic examples first.

---

## Portée

Dans la portée :
- Le Worker déployé sur `legislation.poirierlavoie.ca` (`POST /mcp`, `POST /mcp/oauth`, `GET /.well-known/oauth-protected-resource/mcp/oauth`, `GET /`, `GET /mcp/server-card`, `GET /health`, `/admin/backfill-vectors`) ;
- Le code source dans `src/`, les migrations/schémas D1, le pipeline Python (`pipeline/`) et les manifestes clients (`plugin.json`, `mcp_config.json`, `gemini-extension.json`).

Hors portée :
- Ingénierie sociale, attaques physiques ou déni de service volumétrique sur l'infrastructure Cloudflare ;
- Données officielles d'origine (LégisQuébec / Éditeur officiel du Québec, ministère de la Justice du Canada, Cour supérieure du Québec, Cour du Québec et Autorité des marchés financiers (AMF)) — toute erreur dans un texte officiel relève du publieur officiel.

---

## Données traitées, vie privée et secret professionnel

Ce serveur ne sert que des **textes législatifs et réglementaires publics** en lecture seule et n'héberge aucun dossier client :

1. **Zéro journalisation de contenu de requête (`S13`, `S14`, `G9`, `G37`)** :
   - Aucune écriture dans `search_log` n'a lieu à l'exécution ; aucun texte de requête (`query`), référence législative ou argument d'outil n'est persisté ni émis dans `console.*`.
   - Les journaux d'invocation Cloudflare sont explicitement désactivés dans `wrangler.jsonc` (`observability.enabled = false`, `observability.logs.invocation_logs = false`).
   - Seuls des compteurs journaliers agrégés par titulaire (`compteur_jour`) et des événements techniques strictement dépourvus de contenu de requête (`evenement_technique`, horodatés à la minute et purgés automatiquement à 90 jours) sont enregistrés en arrière-plan dans `DB_IDENTITE`.
   - Par prudence déontologique (transit HTTPS et calcul d'enchâssement en mémoire lorsque le mode hybride est actif), les appelants doivent toujours **formuler des requêtes juridiques abstraites** sans noms de clients ni faits identifiants.
2. **Désactivation libre-service du volet vectoriel (`hybride_permis`, `S19`)** :
   - Chaque titulaire peut désactiver le repérage sémantique (`hybride_permis = 0`) dans `https://acces.poirierlavoie.ca/moi` : `search_text` s'exécute alors exclusivement en mode lexical FTS5 local sur D1, sans jamais invoquer `Workers AI` ni `Vectorize`.
3. **Deux montages d'authentification étanches (`/mcp` et `/mcp/oauth`)** :
   - `/mcp` accepte les jetons individuels de titulaires (`DB_IDENTITE`, portée `legislation` ou `les_deux`) ainsi que les secrets transitoires de phase 3a (`MCP_TOKEN`, `MCP_TOKEN_VEILLE`), et oppose un `404` vide uniforme sans `WWW-Authenticate` à tout refus. Privilégier `Authorization: Bearer <jeton>` dès que le client le permet (`?key=` reste toléré sur `/mcp` pour compatibilité transitoire).
   - `/mcp/oauth` accepte exclusivement l'en-tête `Authorization: Bearer <jeton>` (aucun `?key=`, aucun segment de chemin) et répond `401` RFC 9728 pointant vers `https://acces.poirierlavoie.ca`.

---

## Contrôles de sécurité en production

- **Fermé par défaut (`MCP_ENABLED !== "true"`) :** Coupe `/mcp*`, `/.well-known/oauth-protected-resource/mcp/oauth` et `/health` en `404`, tout en laissant `GET /` accessible (`200`).
- **Comparaison cryptographique et protocole (`@poirierlavoie/mcp-socle` `0.8.0`) :** Appariement SHA-256 à temps constant (`crypto.subtle.timingSafeEqual`), corps limité à `65 536` octets, décodage UTF-8 fatal, validation stricte des en-têtes MCP `2026-07-28`, contrôle de méthode HTTP `POST` exécuté **après** l'authentification (`G23`).
- **Défense DNS rebinding et CORS :** Toute origine navigateur non reconnue est refusée en `403` sans en-têtes CORS avant l'authentification ; `OPTIONS` pré-vol répond `204` sans être limité en débit.
- **Limitation de débit à deux niveaux et quotas (`G32`, `G34`) :** Pré-authentification par IP (`RL_PRE_AUTH_IP` 600/min, `RL_ECHEC_IP` 20/min, `RL_ECHECS_GLOBAL` 300/min + quarantaine IP en mémoire contournée par tout jeton valide déjà reconnu afin de protéger les IP partagées de cabinets/infonuagiques), puis post-authentification par `titulaire_id` (`RL_TITULAIRE` 300/min en régime `actif`, `RL_TITULAIRE_LIMITE` 20/min en régime `limite`) et quotas journaliers UTC (`local`, `semantique`) vérifiés sur le nom d'outil du corps JSON-RPC.

---

## Reproduction hors ligne de la suite de tests

La suite de tests complète tourne hors ligne sans accès Cloudflare ni secret de production :

```powershell
npm.cmd ci
npx.cmd tsc --noEmit
npm.cmd run lint
npm.cmd run audit
npm.cmd test
```
