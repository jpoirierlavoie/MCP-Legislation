/**
 * Découpage des chemins de divisions — POINT DE VÉRITÉ UNIQUE.
 *
 * Module PUR : aucun import, aucune dépendance à D1. C'est délibéré — il n'existe aucune
 * étape de compilation pour les tests (tsconfig `noEmit`, pas d'`allowJs`), donc
 * `tests/paths.test.mjs` le vérifie en LISANT sa source. Un import le rendrait intestable.
 *
 * DEUX FAMILLES cohabitent dans `divisions.path`, et c'est la source du problème :
 *
 *   Irosoft (Québec)   `ga:l_cinquieme-gb:l_premier-gc:l_troisieme`
 *                      préfixes `ga:`…`gi:`, un par niveau, valeur propre à la LANGUE.
 *                      Plus des pseudo-divisions en slug : `annexe-a`, `repeal-schedules`,
 *                      `disposition-preliminaire` — 118 mesurées en production.
 *   LIMS (fédéral)     `fh<niveau>:<rang>` pour le corps, `fs:<n>` pour une annexe,
 *                      `fs:2-fh1:1` pour une division DANS une annexe, `fp:` réservé au
 *                      pseudo-chemin du préambule. Positionnel, donc IDENTIQUE dans les
 *                      deux langues (mesuré sur les 19 textes : séquence de niveaux
 *                      identique partout — docs/phase0-structure-lims.md §3.1).
 *
 * POURQUOI CE MODULE EXISTE. Le dépôt portait TROIS découpeurs incompatibles :
 * `depthOf`/`truncate` coupaient sur CHAQUE `-`, tandis que `PATH_SEG` et le `seg` de
 * `translateDivisionPath` étaient bornés à `/-(?=g[a-z]:)/`. Mesuré le 2026-09-11 sur les
 * 3 585 chemins distincts de la production, les deux conventions divergent sur 120 chemins :
 *
 *   - le découpeur par tiret tronque `annexe-a` en `annexe` — chemin qui EXISTE, donc il
 *     rend UNE AUTRE DIVISION en silence — et `repeal-schedules` en `repeal`, qui n'existe
 *     pas ; il casse aussi `gc:l_dix-septieme` ;
 *   - le découpeur `g[a-z]:` voit `fh1:3-fh2:5` comme UN SEUL segment, donc `depth = 1`,
 *     et `translateDivisionPath` rend alors la division DESCENDANTE trouvée par le pont au
 *     lieu de l'ancêtre demandé. Une réponse FAUSSE, pas une réponse vide.
 *
 * Vérifié à l'inverse : `PATH_SEG` et la `SEG_SPLIT` ci-dessous s'accordent sur les
 * 3 585 chemins, donc l'unification est un NO-OP pour `breadcrumbChains` et pour
 * `src/backfill.ts` — là où un changement aurait coûté le plus cher, puisque le fil
 * d'Ariane est CUIT dans le texte embarqué des vecteurs.
 *
 * MIROIR : `pipeline/paths.py` porte le même littéral de regex, caractère pour caractère,
 * et `tests/paths.test.mjs` le compare. C'est la dette que le miroir
 * `sortKeyOf` ↔ `sort_key` n'a jamais eue — et `schema.sql` a décrit pendant longtemps une
 * TROISIÈME échelle qui n'existait nulle part.
 */

/**
 * Frontière de segment : un `-` SUIVI d'un préfixe de famille connu.
 *
 * Un préfixe inconnu n'ouvre PAS un segment — c'est ce qui protège les slugs
 * (`annexe-a`, `disposition-preliminaire`) et les valeurs à trait d'union
 * (`gc:l_dix-septieme`). Élargir cette énumération rouvre cette classe de défaut.
 */
export const SEG_SPLIT = /-(?=(?:g[a-z]|fh\d+|fs|fp):)/;

/** Préfixes de la famille LIMS (fédérale). */
const FEDERAL = /^(?:fh\d+|fs|fp):/;

/** Segments d'un chemin, dans l'ordre (racine d'abord). */
export function segmentsOf(path: string): string[] {
  return path.split(SEG_SPLIT);
}

/** Profondeur d'un chemin : `fh1:3-fh2:5` -> 2, `gc:l_dix-septieme` -> 1. */
export function depthOf(path: string): number {
  return segmentsOf(path).length;
}

/**
 * Tronque un chemin à `d` segments. Le résultat est un PRÉFIXE qui est lui-même un chemin
 * valide — ce que le découpage par tiret ne garantissait pas.
 */
export function truncatePath(path: string, d: number): string {
  return segmentsOf(path).slice(0, d).join("-");
}

/**
 * Vrai pour un chemin de la famille LIMS. Sert au court-circuit de
 * `translateDivisionPath` : le chemin fédéral étant positionnel, il est identique dans les
 * deux langues et il n'y a RIEN à traduire. Mieux vaut ne rien traduire que traduire faux.
 */
export function isFederalPath(path: string): boolean {
  return FEDERAL.test(path);
}

/**
 * « Ce chemin ou tout son sous-arbre », en SQL.
 *
 * Ni LIKE (où `_` est un joker, présent dans nos chemins) ni GLOB : D1 plafonne la
 * COMPLEXITÉ des motifs LIKE/GLOB (« LIKE or GLOB pattern too complex »), seuil qu'un
 * chemin profond du C.c.Q. dépasse. On passe donc par un INTERVALLE LEXICOGRAPHIQUE, sans
 * motif, et indexable : les descendants d'un chemin sont exactement ceux de
 * [path+'-', path+'.'), car `.` (0x2E) suit immédiatement `-` (0x2D).
 *
 * Sûr pour les DEUX familles, et prouvé par l'ordre des octets : tout ce qui peut suivre un
 * chemin — chiffres (0x30-0x39), `:` (0x3A), lettres — trie AU-DESSUS de `.`. Donc `fh1:3`
 * ne capte pas `fh1:30`, `fs:1` ne capte pas `fs:10`, et `annexe-a` ne capte pas
 * `annexe-abrogative`.
 */
export function subtreeClause(col: string): string {
  return `(${col} = ? OR (${col} >= ? || '-' AND ${col} < ? || '.'))`;
}

/** Les 3 liaisons attendues par subtreeClause (le chemin, trois fois). */
export function subtreeBinds(path: string): [string, string, string] {
  return [path, path, path];
}
