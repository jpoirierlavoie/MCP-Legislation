# `fixtures/`

## `tools-list.reference.json`

Ce que `tools/list` publiait le **2026-09-16**, SDK compris, capturé par
`scripts/capturer-tools-list.mjs` sur le chemin réel d'un client.

**À quoi ça sert.** La marche 2 de la phase 1 remplace `McpAgent` et le SDK par le routeur
du socle, ce qui oblige à réécrire les dix `inputSchema` de Zod vers du JSON Schema. Les
réécrire à la main, c'est parier que quarante-deux champs seront transcrits sans faute — et
la faute y est silencieuse : un `required` de trop rend un refus dur sur tous les appels
nominaux, un `default` inventé ment au modèle sans que rien n'échoue.

Cette fixture est la seule référence qui ne se discute pas.

**Ce n'est PAS une cible octet pour octet**, et il ne faut pas en faire une. Le SDK publie
des détails qu'il serait malsain de graver dans le socle — un ordre de clefs hérité de
`zod-to-json-schema` (`default`, `description`, `type`, `enum` : ni alphabétique, ni
déclaratif), et un `$schema` en draft-07. La cible est l'identité du CONTRAT : mêmes outils,
mêmes titres, mêmes descriptions, mêmes champs, mêmes contraintes, mêmes `required`, mêmes
annotations. Toute autre différence doit être **énumérée et motivée**, jamais découverte.

**Quatre écarts sont déjà connus et attendent une décision :**

| Écart | Ce que publie le SDK | À trancher |
|---|---|---|
| `$schema` | `http://json-schema.org/draft-07/schema#` | `2026-07-28` suppose 2020-12 en l'absence du champ. Le conserver fige le contrat actuel ; le retirer aligne sur la révision |
| `execution` | `{ "taskSupport": "forbidden" }` | Champ ajouté par le SDK (extension Tasks). Le socle ne l'émet pas. Le reprendre ou l'abandonner est une décision, pas un oubli |
| `additionalProperties` | **absent** | Zod écarte les clefs inconnues EN SILENCE. L'ajouter à `false` change le comportement : un argument surnuméraire toléré devient un refus |
| ordre des clefs | celui de `zod-to-json-schema` | Le socle émet un ordre déclaratif. La charge change sans que sa valeur change |

**À relancer AVANT la bascule, jamais après.** Une fois le SDK retiré, la référence n'est
plus reproductible et le script ne s'exécute plus. C'est voulu : il disparaîtra avec la
dépendance, et la fixture restera comme trace de ce qui était servi.
