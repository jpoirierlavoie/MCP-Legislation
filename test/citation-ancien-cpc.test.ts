import { describe, expect, it } from "vitest";

import { type LawRow, parseCitation } from "../src/lib";

/**
 * L'ANCIEN Code de procédure civile (C-25) ne doit JAMAIS être rabattu sur son successeur.
 *
 * POURQUOI CE FICHIER EXISTE. Mesuré en production le 2026-09-17 :
 *
 *     legislation_resolve_reference({ citation: "art. 2 ancien C.p.c." })
 *       -> RLRQ, c. C-25.01, art. 2  (à jour au …)
 *
 * L'abréviation « C.p.c. » appariait et le mot « ancien » était purement ignoré. Or la
 * recodification du 1er janvier 2016 a RENUMÉROTÉ le code : l'article N de l'ancien n'est
 * pas l'article N du nouveau. La réponse était donc FAUSSE ET ASSURÉE — pire qu'un silence,
 * parce qu'elle cite une disposition réelle, en vigueur et bien formée, qui n'a rien à voir
 * avec ce qu'on demandait. C'est nommément le mode de défaut que ce dépôt refuse.
 *
 * Le corpus ne porte QUE C-25.01 (vérifié : `laws.config.json` n'a aucune entrée `c-25`).
 * La décision de ne pas ingérer l'ancien code est de Jason (2026-09-17) ; ce qui se corrige
 * ici n'est pas la couverture, c'est le SILENCE sur son absence.
 */

// parseCitation n'a besoin que des chapitres pour son premier passage. Deux lignes suffisent :
// le C.p.c. en vigueur et un témoin, pour prouver qu'on ne casse pas la résolution normale.
const LOIS = [
  { id: "cpc", official_cite: "RLRQ, c. C-25.01" },
  { id: "ccq", official_cite: "RLRQ, c. CCQ-1991" },
] as unknown as LawRow[];

describe("ancien C.p.c. (C-25) — nommé, jamais rabattu", () => {
  it("ne résout PAS vers le code en vigueur quand la citation dit « ancien »", () => {
    const p = parseCitation("art. 2 ancien C.p.c.", LOIS);
    expect(p.law).toBeNull();
    expect(p.hors_corpus).toBe("C-25");
    // Le numéro reste détecté : le refus doit pouvoir le citer pour être utile.
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
    for (const c of [
      "RLRQ, c. C-25, art. 110",
      "art. 110 C-25", // sans « c. » : CHAPITRE_EXPLICITE ne le voit pas, chapterRegex si
      "chapitre C-25, article 110",
    ]) {
      const p = parseCitation(c, LOIS);
      expect(p.hors_corpus, c).toBe("C-25");
      // Et il ne repart pas en « chapitre inconnu » générique : le refus est circonstancié.
      expect(p.chapitre_inconnu, c).toBeNull();
    }
  });

  it("C-25 n'apparie PAS C-25.01 — l'ancrage du chapitre tient", () => {
    // Le piège inverse : si `chapterRegex` mordait sur un préfixe, « c. C-25 » résoudrait
    // le code EN VIGUEUR. C'est le même défaut que « c. B-1 » ⊂ « c. B-1.1 ».
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
    // Constat du 2026-09-17, ANTÉRIEUR à ce correctif : la table d'abréviations ne connaît
    // que « C.p.c. » et « cpc », jamais « Code de procédure civile » en toutes lettres.
    expect(parseCitation("article 110 du Code de procédure civile", LOIS).law).toBeNull();
    // Le détecteur d'ancienneté, lui, reconnaît la forme épelée. L'asymétrie est VOULUE :
    // elle ne peut produire qu'un refus de plus, jamais une résolution de trop — et un
    // refus sur une citation juste coûte infiniment moins qu'un article faux servi.
    expect(parseCitation("art. 110 de l'ancien Code de procédure civile", LOIS).hors_corpus).toBe(
      "C-25",
    );
  });

  it("« ancien » près d'une AUTRE loi ne déclenche rien", () => {
    // Le garde-fou du garde-fou : « ancien » est un mot courant. Il ne doit agir qu'en
    // présence d'un marqueur de procédure civile, sinon on refuserait des citations justes.
    const p = parseCitation("art. 1457 de l'ancien C.c.Q.", LOIS);
    expect(p.hors_corpus).toBeNull();
    expect(p.law).toBe("ccq");
  });

  it("le chapitre en vigueur l'emporte sur le mot « ancien »", () => {
    // Citer C-25.01 NOMMÉMENT est sans ambiguïté, même avec le mot « ancien » à côté
    // (« l'ancien article 110 de C-25.01 » parle d'une version antérieure du MÊME code).
    const p = parseCitation("l'ancien article 110 de RLRQ, c. C-25.01", LOIS);
    expect(p.law).toBe("cpc");
    expect(p.hors_corpus).toBeNull();
  });
});
