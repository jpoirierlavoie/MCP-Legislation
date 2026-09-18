// La porte G5 : tout `structuredContent` servi VALIDE contre l'`outputSchema` publié.
//
// POURQUOI CE FICHIER EST LE CŒUR DE LA MARCHE 4. Publier un `outputSchema` est une
// promesse faite à un client qui, lui, ne vérifie rien : il désérialise et croit. Sans ce
// contrôle, la promesse serait tenue par la discipline seule — c'est-à-dire, à terme, pas
// tenue. La sortie est mesurée SUR LE FIL, à travers `SELF.fetch`, et non en appelant le
// gestionnaire : ce qui compte est ce qui traverse `JSON.stringify`, où toutes les
// garanties de type s'évaporent.
//
// CE QU'IL ATTRAPE QUE LES TYPES NE VOIENT PAS :
//   · `gardes` vide — `minItems: 1` est la seule couche qui survive à la sérialisation ;
//   · un `null` de colonne là où le schéma annonce une chaîne ;
//   · un champ oublié dans `required`, ou un champ de trop sous `additionalProperties`.
//
// LE GABARIT N'EST PAS DU DROIT : les matières s'appellent `essai-*` et leurs libellés sont
// inventés, pour qu'on ne puisse jamais les prendre pour la taxonomie réelle. Une seule
// porte une description nulle et un libellé anglais nul — c'est le cas qui a fait entrer
// l'union de types dans le socle, et il doit rester éprouvé.

import { env, SELF } from "cloudflare:test";
import { validateArgs } from "@poirierlavoie/socle-juridique/protocole/valide";
import { beforeAll, describe, expect, it } from "vitest";
import { SORTIES } from "../src/schemas-sortie";
import { amorcerGabarit } from "./gabarit-corpus";

const URL_MCP = "https://legislation.test/mcp";
const JETON = "jeton-de-test";

const e = env as unknown as Record<string, unknown>;
e.MCP_TOKEN = JETON;
e.MCP_ENABLED = "true";
e.SOCLE = "true";
// Hors ligne : ni Workers AI ni Vectorize ne sont émulés localement (sondage 0.0).
e.HYBRID_SEARCH = "0";

const db = () => (env as unknown as { DB: D1Database }).DB;

interface Resultat {
  result: {
    structuredContent?: Record<string, unknown>;
    content: Array<{ text: string }>;
    isError?: boolean;
  };
}

async function appeler(nom: string, args: Record<string, unknown> = {}): Promise<Resultat> {
  const r = await SELF.fetch(URL_MCP, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${JETON}`,
      "MCP-Protocol-Version": "2025-06-18",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: nom, arguments: args },
    }),
  });
  expect(r.status).toBe(200);
  const c = (await r.json()) as Resultat;
  // Un gabarit qui tombe sur une branche d'ERREUR ne mesure rien : `err()` ne porte aucune
  // charge structurée, et le schéma la refuserait dans un message qui accuse le schéma.
  // Mieux vaut échouer ici, en nommant l'appel.
  expect(
    c.result.isError ?? false,
    `${nom} ${JSON.stringify(args)} : ${c.result.content[0]?.text}`,
  ).toBe(false);
  return c;
}

beforeAll(() => amorcerGabarit(db()));

/**
 * Un jeu d'arguments par outil enveloppé — plusieurs quand une branche change la charge.
 *
 * ⚠ CETTE TABLE EST LA CONDITION D'ENTRÉE DANS `SORTIES`. La garde ci-dessous exige que les
 *   deux ensembles de clefs coïncident : enrôler un outil sans lui donner de gabarit rend le
 *   test rouge. Sans elle, publier un `outputSchema` que rien ne mesure ne coûterait qu'un
 *   oubli — et c'est exactement l'oubli que la marche 4 doit rendre impossible.
 */
const GABARITS: Record<string, Array<Record<string, unknown>>> = {
  // Deux langues : `label` et `description` changent de source selon `lang`, et c'est là
  // qu'un `null` de traduction remonte.
  legislation_list_subjects: [{}, { lang: "en" }],
  // Sans filtre, puis avec — `filters` doit rester présent et non nul dans les deux cas.
  legislation_list_laws: [{}, { fonction: "reglement" }, { structure: false }],
  // Les deux sens, et le cas HORS CORPUS (`other_name` nul) que seul `essai-code` porte.
  legislation_related_laws: [
    { law: "essai-code" },
    { law: "essai-code", direction: "in" },
    { law: "essai-code", direction: "out" },
  ],
  // Un article DANS une division, et un ABROGÉ — `repealed` doit voyager, pas disparaître.
  legislation_get_article: [
    { law: "essai-code", article: "1" },
    { law: "essai-code", article: "3" },
    // Coercition : les modèles envoient les numéros d'article en NOMBRES.
    { law: "essai-code", article: 2 },
  ],
  // Les deux modes, parce que `pagination` et `range_resolution` en dépendent :
  // la plage rend un objet, la liste rend `null`.
  legislation_get_articles: [
    { law: "essai-code", from: "1", to: "3" },
    { law: "essai-code", numbers: ["1", "2"] },
  ],
  legislation_get_structure: [
    { law: "essai-code" },
    { law: "essai-code", depth: 4 },
    { law: "essai-code", root_path: "ga:l_premier" },
  ],
  // `include_text: false` retire `text` et `history` des articles : le schéma ne les
  // exige donc pas, et ce gabarit est ce qui le prouve.
  legislation_get_division: [
    { law: "essai-code", path: "ga:l_premier-gb:t_i-gc:c_i" },
    { law: "essai-code", path: "ga:l_premier-gb:t_i-gc:c_i", include_text: false },
    { law: "essai-code", division_id: 1 },
  ],
  // Reconnue PAR CHAPITRE — la seule voie qui marche sans abréviation usuelle au corpus.
  legislation_resolve_reference: [{ citation: "art. 1, RLRQ, c. ESSAI-1" }],
  // « essai » apparie label_norm (S1) ET name_norm (S3) ; « capacité » n'apparie que le
  // texte des articles, que `find_relevant` ne lit pas.
  legislation_find_relevant: [{ query: "essai" }, { query: "essai", lang: "en" }],
  // Deux appels qui comptent : l'un trouve directement, l'autre DOIT replier — c'est la
  // seule façon de voir `REPLI_LEXICAL` s'ajouter, et donc de mesurer `supplementaires`.
  legislation_search_text: [
    { query: "capacité" },
    { query: "capacité essai inexistante", law: "essai-code" },
  ],
};

describe("G5 — toute charge servie valide contre son `outputSchema`", () => {
  it("chaque outil enveloppé a son gabarit d'appel", () => {
    expect(Object.keys(GABARITS).sort()).toEqual(Object.keys(SORTIES).sort());
  });

  for (const [nom, jeux] of Object.entries(GABARITS)) {
    for (const args of jeux) {
      it(`${nom} ${JSON.stringify(args)}`, async () => {
        const c = await appeler(nom, args);
        const schema = SORTIES[nom];
        expect(schema).toBeDefined();
        expect(validateArgs(schema!, c.result.structuredContent)).toEqual([]);
      });
    }
  }
});

describe("legislation_list_subjects — ce que le schéma seul ne dit pas", () => {
  it("porte sa réserve, et la réserve porte son texte", async () => {
    // La garde n'est pas décorative : c'est elle qui empêche un client de lire la taxonomie
    // comme une détermination du droit applicable. Vide, l'enveloppe serait pire que la
    // charge plate d'avant — typée, donc crue.
    const c = await appeler("legislation_list_subjects");
    const gardes = c.result.structuredContent?.gardes as Array<Record<string, string>>;
    expect(gardes.map((g) => g.code)).toEqual(["REPERAGE_HEURISTIQUE"]);
    expect(gardes[0]?.texte).toContain("Ne détermine PAS le droit applicable");
  });

  it("nomme son autorité — sans quoi rien n'est citable", async () => {
    const c = await appeler("legislation_list_subjects");
    const p = c.result.structuredContent?.provenance as Record<string, string>;
    expect(p.autorite).toBe("Éditeur officiel du Québec");
    expect(p.source).toBe("legisquebec");
  });

  it("les colonnes nullables arrivent `null`, et le schéma le DIT", async () => {
    // Le cas qui a fait entrer l'union de types dans le socle. S'il tombe, c'est soit que la
    // charge s'est mise à taire ses nulls (mensonge par omission), soit que le schéma s'est
    // resserré sur `string` — et alors la validation ci-dessus rougirait aussi.
    const c = await appeler("legislation_list_subjects");
    const d = c.result.structuredContent?.donnees as { subjects: Array<Record<string, unknown>> };
    const nue = d.subjects.find((s) => s.id === "essai-nu");
    expect(nue).toBeDefined();
    expect(nue?.label_en).toBeNull();
    expect(nue?.description).toBeNull();
    // Le libellé servi retombe sur le français : `null` n'y remonte jamais.
    expect(nue?.label).toBe("Matière sans traduction");
  });

  it("la prose reste la prose — `content` n'a pas bougé de forme", async () => {
    // L'enveloppe ne remplace pas le texte, elle l'accompagne. Un client qui ne lit que la
    // prose doit continuer d'y trouver la même chose qu'avant la marche 4.
    const c = await appeler("legislation_list_subjects");
    expect(c.result.content[0]?.text).toContain("matières :");
    expect(c.result.content[0]?.text).toContain("essai-nu");
  });
});
