# `fixtures/`

## `tools-list.reference.json`

Charge utile de référence capturée le **2026-09-16** depuis l'ancien serveur SDK avant
le passage définitif au routeur sans état `@poirierlavoie/mcp-socle`.

**À quoi ça sert.** Elle fige le contrat `tools/list` historique (noms, descriptions,
`inputSchema`, `required`, annotations, `$schema`, `execution`) et alimente la
génération de `src/schemas.ts` (`scripts/engendrer-schemas.mjs`) ainsi que les tests de
non-régression (`test/schemas-engendres.test.ts`, `test/routeur.test.ts`).

**Statut.** L'ancien script de capture et la dépendance `@modelcontextprotocol/sdk` ont
été retirés après le passage complet au socle ; la fixture demeure comme référence de
contrat pour `src/schemas.ts` et les tests.
