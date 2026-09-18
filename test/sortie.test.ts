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

const URL_MCP = "https://legislation.test/mcp";
const JETON = "jeton-de-test";

const e = env as unknown as Record<string, unknown>;
e.MCP_TOKEN = JETON;
e.MCP_ENABLED = "true";
e.SOCLE = "true";

const db = () => (env as unknown as { DB: D1Database }).DB;

interface Resultat {
  result: { structuredContent?: Record<string, unknown>; content: Array<{ text: string }> };
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
  return (await r.json()) as Resultat;
}

beforeAll(async () => {
  await db().batch([
    db()
      .prepare(
        "INSERT OR IGNORE INTO subjects (id, label_fr, label_en, label_norm, kind, description_fr, description_en)" +
          " VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        "essai-plein",
        "Matière d'essai",
        "Test subject",
        "matiere essai",
        "prive-ccq",
        "Description d'essai.",
        "Test description.",
      ),
    // La ligne qui compte : traduction ABSENTE et description ABSENTE, donc `null` en sortie.
    db()
      .prepare(
        "INSERT OR IGNORE INTO subjects (id, label_fr, label_en, label_norm, kind, description_fr, description_en)" +
          " VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        "essai-nu",
        "Matière sans traduction",
        null,
        "matiere sans traduction",
        "specialise",
        null,
        null,
      ),
  ]);
});

/**
 * Un jeu d'arguments par outil enveloppé — plusieurs quand une branche change la charge.
 *
 * ⚠ CETTE TABLE EST LA CONDITION D'ENTRÉE DANS `SORTIES`. La garde ci-dessous exige que les
 *   deux ensembles de clefs coïncident : enrôler un outil sans lui donner de gabarit rend le
 *   test rouge. Sans elle, publier un `outputSchema` que rien ne mesure ne coûterait qu'un
 *   oubli — et c'est exactement l'oubli que la marche 4 doit rendre impossible.
 */
const GABARITS: Record<string, Array<Record<string, unknown>>> = {
  legislation_list_subjects: [{}, { lang: "en" }],
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
