/**
 * Amorce la base D1 de test AVANT chaque fichier de test.
 *
 * POURQUOI CE FICHIER EXISTE. Jusqu'ici la base de test était VIDE : tout ce qui touche D1
 * y échouait sur « no such table: laws », si bien qu'aucun test de ce dépôt n'éprouvait une
 * requête, un tri, un repli de recherche ni un rendu de page. La seule vérification de
 * schéma vivait dans la CI, sous forme de bootstrap en shell — utile, mais elle ne laisse
 * écrire aucun test.
 *
 * L'ORDRE EST CELUI DE LA PRODUCTION, et il n'est pas interchangeable :
 *
 *   1. `schema.sql` — l'état INITIAL. Gelé par politique : il décrit la base telle qu'elle
 *      était avant la première migration, et non telle qu'elle est.
 *   2. `schema-decouverte.sql` — la couche de découverte (matières, relations). La CI ne
 *      l'applique PAS, et c'est une lacune connue : ses tables ne sont couvertes par aucune
 *      garde de schéma. On l'applique ici, sinon rien de ce qui lit `subjects` ou
 *      `law_relations` n'est éprouvable.
 *   3. `migrations/` — les migrations RÉELLES, dans l'ordre, par `applyD1Migrations`.
 *      Jamais un schéma de test parallèle : un schéma dupliqué finit par diverger de la
 *      production, et l'index FTS5 en « external content » est précisément le genre de
 *      construction dont la divergence est SILENCIEUSE.
 */

import { applyD1Migrations, env } from "cloudflare:test";

interface EnvTest {
  DB: D1Database;
  TEST_SCHEMA: string;
  TEST_DECOUVERTE: string;
  // Le type des migrations est fourni par le greffon ; on ne le renomme pas ici.
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const e = env as unknown as EnvTest;

/**
 * D1 `exec` veut un énoncé par ligne : il découpe sur les sauts de ligne et ne comprend ni
 * les commentaires, ni les énoncés répartis sur plusieurs lignes. Les deux fichiers de
 * schéma en sont pleins — dont deux essais de plusieurs paragraphes sur `sort_key`. On
 * réduit donc chaque énoncé à UNE ligne avant de le passer.
 */
function enonces(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ") // commentaires de ligne
    .replace(/\/\*[\s\S]*?\*\//g, " ") // commentaires de bloc
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 0)
    .map((s) => `${s};`)
    .join("\n");
}

await e.DB.exec(enonces(e.TEST_SCHEMA));
await e.DB.exec(enonces(e.TEST_DECOUVERTE));
await applyD1Migrations(e.DB, e.TEST_MIGRATIONS);
