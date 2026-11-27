import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PUBLIES } from "../src/schemas.ts";

const RACINE = join(dirname(fileURLToPath(import.meta.url)), "..");
const lire = (p) => readFileSync(join(RACINE, p), "utf8");

const indexTs = `${lire("src/serveur.ts")}
${lire("src/index.ts")}`;
const toolsTs = lire("src/tools.ts");

const NOMS_MORTS =
  /\b(legislation_(?:get_structure|get_division|get_articles?|list_laws|list_subjects|search_text|find_relevant|related_laws|resolve_reference))\b/g;

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
    expect(morts, `noms préfixés v1 dans INSTRUCTIONS : ${morts.join(", ")}`).toEqual([]);
  });

  it("le garde-fou de find_relevant ne cite que des outils existants", () => {
    const bloc = toolsTs.match(/const GARDE_FOU =([\s\S]*?);\n/)?.[1] ?? "";
    expect(bloc.length, "GARDE_FOU introuvable — la regex a-t-elle cassé ?").toBeGreaterThan(50);
    const morts = [...new Set([...bloc.matchAll(NOMS_MORTS)].map((m) => m[1]))];
    expect(morts, `noms préfixés v1 dans GARDE_FOU : ${morts.join(", ")}`).toEqual([]);
  });

  it("aucune sortie d'outil ne cite un ancien nom préfixé v1", () => {
    const morts = [
      ...new Set([...sansCommentaires(toolsTs).matchAll(NOMS_MORTS)].map((m) => m[1])),
    ];
    expect(morts, `noms préfixés v1 servis depuis src/tools.ts : ${morts.join(", ")}`).toEqual([]);
  });

  it("aucune description publiée dans PUBLIES (src/schemas.ts) ne cite un ancien nom préfixé v1", () => {
    const blocPublies = JSON.stringify(PUBLIES);
    const morts = [...new Set([...blocPublies.matchAll(NOMS_MORTS)].map((m) => m[1]))];
    expect(
      morts,
      `noms préfixés v1 servis dans PUBLIES (src/schemas.ts) : ${morts.join(", ")}`,
    ).toEqual([]);
  });
});

describe("les instructions disent la portée ET les limites", () => {
  const bloc = indexTs.match(/const INSTRUCTIONS =([\s\S]*?);\n/)?.[1] ?? "";

  it("annoncent les DEUX juridictions", () => {
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
    expect(bloc).toMatch(/aucun conseil juridique/i);
    expect(bloc).toMatch(/fait foi/i);
    expect(bloc).toMatch(/heuristique/i);
  });
});

describe("le serveur s'annonce par sa juridiction", () => {
  it("serverInfo.name nomme le Québec et le Canada", () => {
    const nom = indexTs.match(/name:\s*"([^"]+)",\s*version:/)?.[1] ?? "";
    expect(nom).toMatch(/Québec/i);
    expect(nom).toMatch(/Canada/i);
  });
});

describe("get_articles refuse au lieu de servir la moitié de la demande", () => {
  it("les deux modes fournis ensemble sont REFUSÉS", () => {
    expect(toolsTs).toMatch(/useRange && numbers\?\.length/);
    expect(toolsTs).toMatch(/Modes INCOMPATIBLES/);
  });
});

describe("aucun message interne ne fuit vers l'appelant", () => {
  it("l'échec de recherche ne renvoie pas le message brut du moteur", () => {
    expect(toolsTs).not.toMatch(/Recherche invalide[^;]*\$\{\(e as Error\)\.message\}/);
  });
});
