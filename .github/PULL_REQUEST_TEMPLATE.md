## Résumé / Summary


## Vérifications locales / Local Verification

- [ ] `npx.cmd wrangler types` & `npx.cmd tsc --noEmit`
- [ ] `npx.cmd biome check .` & `npm.cmd run audit`
- [ ] `npm.cmd test` & `PYTHONUTF8=1 .\.venv\Scripts\python.exe -B -m unittest discover -s pipeline/tests -q`

## Évaluation d'impact obligatoire (6 surfaces — `CLAUDE.md` / `GEMINI.md`)

1. **Outils MCP (`src/tools.ts`, `src/schemas.ts`, `src/routeur.ts`) :**
2. **Descriptions (`src/tools.ts`, `src/serveur.ts`, `data/catalogue.json`) :**
3. **Schéma (`data/schema*.sql`, `migrations/`, `inputSchema`, `structuredContent`) :**
4. **`README.md`, `SECURITY.md`, `LICENSE` et manifestes :**
5. **Page publique HTML (`GET /`) et `/mcp/server-card` :**
6. **Impacts inter-dépôts (`droit-civil-quebecois`, `MCP-Socle`, `MCP-Acces`, `MCP-Legislation`, `MCP-Jurisprudence`, `MCP-Outils`) :**

## Confidentialité et sécurité

- [ ] Aucun secret (`MCP_*`, `Bearer`, SHA/clé API), aucun chemin local personnel et aucune donnée client confidentielle ou privilégiée dans les commits ni dans cette PR.
