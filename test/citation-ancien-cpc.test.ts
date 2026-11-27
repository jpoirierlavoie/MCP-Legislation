import { describe, expect, it } from "vitest";

import { type LawRow, parseCitation } from "../src/lib";

const LOIS = [
  { id: "cpc", official_cite: "RLRQ, c. C-25.01" },
  { id: "ccq", official_cite: "RLRQ, c. CCQ-1991" },
] as unknown as LawRow[];

describe("ancien C.p.c. (C-25) — nommé, jamais rabattu", () => {
  it("ne résout PAS vers le code en vigueur quand la citation dit « ancien »", () => {
    const p = parseCitation("art. 2 ancien C.p.c.", LOIS);
    expect(p.law).toBeNull();
    expect(p.hors_corpus).toBe("C-25");
    expect(p.article).toBe("2");
  });

  it("couvre les formulations usuelles, dans les deux langues", () => {
    for (const c of [
      "article 110 de l'ancien C.p.c.",
      "art. 110 de l'ancien code de procedure civile",
      "C.p.c. de 1965, art. 110",
      "former C.C.P., s. 110",
      "old Code of Civil Procedure, s. 110",
    ]) {
      const p = parseCitation(c, LOIS);
      expect(p.hors_corpus, c).toBe("C-25");
      expect(p.law, c).toBeNull();
    }
  });

  it("nomme le chapitre C-25 sous toutes ses formes de citation", () => {
    for (const c of ["RLRQ, c. C-25, art. 110", "art. 110 C-25", "chapitre C-25, article 110"]) {
      const p = parseCitation(c, LOIS);
      expect(p.hors_corpus, c).toBe("C-25");
      expect(p.chapitre_inconnu, c).toBeNull();
    }
  });

  it("C-25 n'apparie PAS C-25.01 — l'ancrage du chapitre tient", () => {
    expect(parseCitation("RLRQ, c. C-25, art. 110", LOIS).law).toBeNull();
    expect(parseCitation("RLRQ, c. C-25.01, art. 110", LOIS).law).toBe("cpc");
  });
});

describe("la résolution normale n'est pas abîmée", () => {
  it("le C.p.c. EN VIGUEUR résout toujours", () => {
    for (const c of ["art. 110 C.p.c.", "art. 110 cpc", "art. 110 CPC"]) {
      const p = parseCitation(c, LOIS);
      expect(p.law, c).toBe("cpc");
      expect(p.hors_corpus, c).toBeNull();
      expect(p.article, c).toBe("110");
    }
  });

  it("ASYMÉTRIE ASSUMÉE : le nom ÉPELÉ ne résout pas, mais il suffit à refuser", () => {
    expect(parseCitation("article 110 du Code de procédure civile", LOIS).law).toBeNull();
    expect(parseCitation("art. 110 de l'ancien Code de procédure civile", LOIS).hors_corpus).toBe(
      "C-25",
    );
  });

  it("« ancien » près d'une AUTRE loi ne déclenche rien", () => {
    const p = parseCitation("art. 1457 de l'ancien C.c.Q.", LOIS);
    expect(p.hors_corpus).toBeNull();
    expect(p.law).toBe("ccq");
  });

  it("le chapitre en vigueur l'emporte sur le mot « ancien »", () => {
    const p = parseCitation("l'ancien article 110 de RLRQ, c. C-25.01", LOIS);
    expect(p.law).toBe("cpc");
    expect(p.hors_corpus).toBeNull();
  });
});
