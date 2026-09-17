import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * LE CONTRAT SERVI À UN MODÈLE INCONNU — gardes posées le 2026-09-17, avant l'ouverture
 * publique de l'endpoint.
 *
 * Ces contrôles lisent le TEXTE SOURCE, comme tests/catalogue.test.mjs, parce que ce qu'ils
 * épinglent ne se voit qu'à la lecture : des chaînes servies à chaque session, qu'aucun
 * appel ne fait échouer quand elles sont fausses. Les trois défauts qu'ils ferment étaient
 * tous SILENCIEUX — ils produisaient une non-action, jamais une erreur :
 *
 *   1. la charge utile envoyait vers `get_structure` / `get_division` / `get_article`, des
 *      noms qui n'existent pas (tous les outils sont `legislation_*`). Avec plusieurs
 *      serveurs MCP branchés, l'appel pouvait partir chez un voisin ;
 *   2. les instructions annonçaient « du Québec » en taisant les 18 textes fédéraux servis ;
 *   3. rien ne disait que le corpus est une SÉLECTION FERMÉE, donc une absence de résultat
 *      se lisait comme « aucune règle n'existe ».
 */

const RACINE = join(dirname(fileURLToPath(import.meta.url)), "..");
const lire = (p) => readFileSync(join(RACINE, p), "utf8");

// INSTRUCTIONS et SERVER_INFO ont quitté src/index.ts pour src/serveur.ts, afin que le
// routeur du socle et McpAgent servent LE MÊME texte. On lit donc les deux fichiers :
// serveur.ts porte les chaînes, index.ts reste surveillé au cas où un nom mort y
// réapparaîtrait. Ce que la garde prouve est inchangé.
const indexTs = `${lire("src/serveur.ts")}
${lire("src/index.ts")}`;
const toolsTs = lire("src/tools.ts");

/** Noms d'outils SANS préfixe — aucun n'existe côté serveur. */
const NOMS_MORTS =
  /(?<![a-z_])(get_structure|get_division|get_articles?|list_laws|list_subjects|search_text|find_relevant|related_laws|resolve_reference)(?![a-z_])/g;

/**
 * Ne garde que ce qui est SERVI. Deux exclusions, chacune vérifiée :
 *  - les commentaires PARLENT des noms morts (dont ce fichier-ci), ils ne les servent pas ;
 *  - `tool: "find_relevant"` / `tool: "search_text"` sont les valeurs écrites dans la colonne
 *    `search_log.tool`, volontairement SANS préfixe (elles n'ont jamais eu le nom d'outil pour
 *    forme, et le renommage du 2026-09-16 ne les a donc pas touchées).
 */
const sansCommentaires = (src) =>
  src
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .filter((l) => !/\btool:\s*"/.test(l))
    .join("\n");

describe("aucun nom d'outil mort n'est SERVI", () => {
  it("les instructions du serveur ne citent que des outils existants", () => {
    const bloc = indexTs.match(/const INSTRUCTIONS =([\s\S]*?);\n/)?.[1] ?? "";
    const morts = [...new Set([...bloc.matchAll(NOMS_MORTS)].map((m) => m[1]))];
    expect(morts, `noms sans préfixe dans INSTRUCTIONS : ${morts.join(", ")}`).toEqual([]);
  });

  it("le garde-fou de find_relevant ne cite que des outils existants", () => {
    // Il voyage dans CHAQUE réponse de repérage, en prose ET dans structuredContent :
    // une erreur ici est répétée à tous les tours, pas seulement à la connexion.
    const bloc = toolsTs.match(/const GARDE_FOU =([\s\S]*?);\n/)?.[1] ?? "";
    expect(bloc.length, "GARDE_FOU introuvable — la regex a-t-elle cassé ?").toBeGreaterThan(50);
    const morts = [...new Set([...bloc.matchAll(NOMS_MORTS)].map((m) => m[1]))];
    expect(morts, `noms sans préfixe dans GARDE_FOU : ${morts.join(", ")}`).toEqual([]);
  });

  it("aucune description d'outil ne cite un nom sans préfixe", () => {
    const morts = [
      ...new Set([...sansCommentaires(toolsTs).matchAll(NOMS_MORTS)].map((m) => m[1])),
    ];
    expect(morts, `noms sans préfixe servis depuis src/tools.ts : ${morts.join(", ")}`).toEqual([]);
  });
});

describe("les instructions disent la portée ET les limites", () => {
  const bloc = indexTs.match(/const INSTRUCTIONS =([\s\S]*?);\n/)?.[1] ?? "";

  it("annoncent les DEUX juridictions", () => {
    // Le corpus porte 18 textes fédéraux. Les taire les rend invisibles à tout modèle qui
    // ne connaît pas le dépôt : il écarte le serveur et répond de mémoire.
    expect(bloc).toMatch(/QUÉBEC/i);
    expect(bloc).toMatch(/CANADA|fédéral/i);
  });

  it("disent que le corpus est une sélection fermée", () => {
    expect(bloc).toMatch(/SÉLECTION FERMÉE/i);
  });

  it("disent qu'une absence n'est pas une réponse", () => {
    expect(bloc).toMatch(/absence de résultat/i);
  });

  it("portent l'avertissement du cabinet", () => {
    // Il vit sinon dans catalogue.avertissement, que SEULE la page publique lit (src/site.ts).
    // Un modèle ne le voyait jamais.
    expect(bloc).toMatch(/aucun conseil juridique/i);
    expect(bloc).toMatch(/fait foi/i);
    expect(bloc).toMatch(/heuristique/i);
  });
});

describe("le serveur s'annonce par sa juridiction", () => {
  it("serverInfo.name nomme le Québec et le Canada", () => {
    // C'est la chaîne qu'un hôte affiche dans son sélecteur, et celle que le connecteur
    // jumeau (Jurisprudence du Canada) désigne à ses modèles.
    const nom = indexTs.match(/name:\s*"([^"]+)",\s*version:/)?.[1] ?? "";
    expect(nom).toMatch(/Québec/i);
    expect(nom).toMatch(/Canada/i);
  });
});

describe("get_articles refuse au lieu de servir la moitié de la demande", () => {
  it("les deux modes fournis ensemble sont REFUSÉS", () => {
    // Mesuré en production : { from, to, numbers } rendait la plage et jetait numbers SANS
    // RIEN DIRE. La réponse avait l'air complète.
    expect(toolsTs).toMatch(/useRange && numbers\?\.length/);
    expect(toolsTs).toMatch(/Modes INCOMPATIBLES/);
  });
});

describe("aucun message interne ne fuit vers l'appelant", () => {
  it("l'échec de recherche ne renvoie pas le message brut du moteur", () => {
    // `e.message` vient de SQLite/FTS5 : « fts5: syntax error near … ». Sans intérêt pour
    // l'appelant, et c'est de l'intérieur donné à voir une fois l'endpoint public.
    expect(toolsTs).not.toMatch(/Recherche invalide[^;]*\$\{\(e as Error\)\.message\}/);
  });
});
