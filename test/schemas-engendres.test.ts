import { describe, expect, it } from "vitest";
import reference from "../data/tools-list.reference.json";
import { PUBLIES } from "../src/schemas";

const noms = Object.keys(PUBLIES);

describe("schémas engendrés contre référence publiée", () => {
  it("porte les dix outils, dans le même ordre", () => {
    expect(noms).toEqual(reference.map((t) => t.name));
  });

  it("chaque descripteur est identique à ce qui est publié", () => {
    for (const t of reference) {
      const p = PUBLIES[t.name];
      expect(p, `${t.name} absent de PUBLIES`).toBeDefined();
      expect(p?.title, `${t.name} : titre`).toBe(t.title);
      expect(p?.description, `${t.name} : description`).toBe(t.description);
      expect(p?.inputSchema, `${t.name} : inputSchema`).toEqual(t.inputSchema);
      expect(p?.annotations, `${t.name} : annotations`).toEqual(t.annotations);
    }
  });

  it("conserve `$schema` et `execution`, que le SDK publie", () => {
    for (const nom of noms) {
      expect(PUBLIES[nom]?.inputSchema.$schema, `${nom} : $schema`).toBe(
        "http://json-schema.org/draft-07/schema#",
      );
    }
    const avecExecution = reference.filter((t) => "execution" in t);
    for (const t of avecExecution) {
      expect(PUBLIES[t.name]?.execution, `${t.name} : execution`).toEqual(
        (t as { execution: unknown }).execution,
      );
    }
  });

  it("verrouille `additionalProperties: false` sur les dix schémas", () => {
    for (const nom of noms) {
      expect(PUBLIES[nom]?.inputSchema.additionalProperties, `${nom}`).toBe(false);
    }
  });

  it("les treize défauts publiés sont tous là", () => {
    const defauts = noms.flatMap((nom) =>
      Object.entries(PUBLIES[nom]?.inputSchema.properties ?? {})
        .filter(([, v]) => v.default !== undefined)
        .map(([champ]) => `${nom}.${champ}`),
    );
    expect(defauts).toHaveLength(13);
  });

  it("tout `type` employé est un type que le validateur du socle sait contrôler", () => {
    const connus = ["object", "string", "integer", "number", "boolean", "array"];
    for (const nom of noms) {
      const s = PUBLIES[nom]?.inputSchema;
      expect(s?.type, `${nom} : type racine`).toBe("object");
      for (const [champ, def] of Object.entries(s?.properties ?? {})) {
        if (def.type !== undefined) {
          expect(connus, `${nom}.${champ} : type « ${def.type} » inconnu`).toContain(def.type);
        }
        if (def.items?.type !== undefined) {
          expect(connus, `${nom}.${champ}[] : type inconnu`).toContain(def.items.type);
        }
      }
    }
  });
});
