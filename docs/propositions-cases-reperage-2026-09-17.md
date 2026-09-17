# Propositions de cas d'éval — repérage du louage et flexion française (2026-09-17)

> ⛔ **Rien ici n'est appliqué.** `eval/cases.json` est la vérité terrain de Jason
> (invariant 16) : ce document PROPOSE, il ne modifie pas. Instantané daté — il ne fait pas
> foi sur l'état courant.
>
> Ce qui a été appliqué le même jour, et qui n'est pas dans ce document : le plancher de
> rendement du barreau leave-one-out, le facteur de couverture de requête, la matière
> `louage` de `taxonomy.json`, et les évals `find_relevant` de `tests/evals.mjs` — ce
> dernier fichier n'est pas ⛔.

## Pourquoi ces propositions existent

Deux défauts de repérage ont été mesurés en production le 2026-09-17 et corrigés le même
jour. Les 21 cas de `eval/cases.json` n'en couvraient **aucun** :

| Thème | Couverture dans `cases.json` avant ce jour |
|---|---|
| bail, louage, logement | **aucun cas** |
| flexion française (« garantie » ≠ « garantir ») | **aucun cas** |
| vice caché | cas 6 et 7 — mais sur la requête « vice caché maison recours », qui ne déclenche pas le défaut |

Le défaut de flexion ne se manifeste qu'à partir de **quatre termes** dont un seul manque au
texte : en dessous, le ET lexical réussit ; au-delà de six tokens FTS, le leave-one-out est
sauté et le barreau OU rattrape tout seul. La fenêtre où le défaut vivait était donc étroite,
et aucun cas d'éval ne tombait dedans. C'est ce qui explique qu'il ait survécu à trois
agrandissements du corpus sans qu'un test rougisse.

## Cas proposés pour `eval/cases.json`

Les `must_include` ci-dessous ont tous été **mesurés** le 2026-09-17, pas déduits : chaque
article nommé a été rendu par l'outil, et son texte lu.

```json
{
  "id": 22,
  "query": "vice caché garantie qualité",
  "law_scope": null,
  "must_include": [
    { "law": "ccq", "article": "1726" },
    { "law": "ccq", "article": "1728" }
  ],
  "nice_to_have": [
    { "law": "ccq", "article": "1727" },
    { "law": "ccq", "article": "1729" }
  ],
  "note": "Quatre termes du vocabulaire courant dont aucun texte ne porte les quatre formes fléchies. Avant le plancher de rendement du 2026-09-17, le leave-one-out rendait UN résultat — p-40.1 art. 53.1, sur les automobiles gravement défectueuses — et masquait le barreau OU, qui met 1726 en tête."
}
```

```json
{
  "id": 23,
  "query": "bail commercial résiliation défaut de payer le loyer",
  "law_scope": null,
  "must_include": [
    { "law": "ccq", "article": "1883" }
  ],
  "nice_to_have": [
    { "law": "ccq", "article": "1863" },
    { "law": "ccq", "article": "1851" }
  ],
  "note": "Régime GÉNÉRAL du louage, applicable au bail commercial. 1883 était déjà rendu en tête par le barreau OU (huit tokens FTS : le leave-one-out est sauté). Le cas garde surtout la couverture par find_relevant, qui échouait."
}
```

## Ce que ces trois articles établissent sur la taxonomie

Vérifié en production le 2026-09-17, par `legislation_get_articles` :

| Article | Objet | Division |
|---|---|---|
| 1851 | définition du louage | `…gc:l_quatrieme-gd:l_i` — Section I, DE LA NATURE DU LOUAGE |
| 1863 | inexécution, résiliation, diminution de loyer | `…gc:l_quatrieme-gd:l_ii-ge:l_1` — Section II, § 1 |
| 1883 | résiliation pour défaut de paiement du loyer | `…gc:l_quatrieme-gd:l_iii` — Section III, DE LA FIN DU BAIL |

**Aucun des trois n'est dans la Section IV**, seule section intitulée
`RÈGLES PARTICULIÈRES AU BAIL D'UN LOGEMENT`. Le régime que consulte un praticien du bail
commercial est donc entièrement hors du domaine résidentiel — alors que le chapitre entier
portait la matière « Louage résidentiel », et elle seule.

L'art. 1851 tranche aussi la question de vocabulaire, dans le texte officiel lui-même :

> « Le louage, **aussi appelé bail**, est le contrat par lequel une personne, le locateur,
> s'engage envers une autre personne, le locataire, à lui procurer, moyennant un loyer, la
> jouissance d'un bien […] »

Le fossé que la description de la nouvelle matière referme — « bail » ne trouvait pas
« louage », parce que l'appariement est unidirectionnel et qu'aucun des deux mots n'est
préfixe de l'autre — est donc un fossé que le Code ne connaît pas. Il n'existait qu'entre la
question de l'usager et l'intitulé de la division.

## Deux chantiers ouverts, non traités le 2026-09-17

1. **La sélection du retrait leave-one-out se fait sur la SOMME des bm25**
   (`src/lib.ts`). Une somme de scores négatifs récompense le nombre de résultats autant que
   leur qualité : un retrait rendant dix résultats médiocres bat un retrait rendant un
   excellent résultat. Un `min` ou une moyenne re-classe tous les LOO — l'invariant 7
   interdit de réordonner l'échelle sans re-mesurer.

2. **`cpc ga:l_v-gb:l_iii` est mappé à TROIS matières** (successions, biens, sûretés) sur un
   seul chemin, donc récolte trois signaux S1 et devance le chapitre de l'hypothèque légale
   du C.c.Q. sur « hypothèque légale de la construction ». Défaut de diversité voisin de
   l'invariant 15, mais distinct : le plafond `MAX_PER_SUBJECT` compte les candidats PAR
   matière, et ne voit pas un candidat qui en porte plusieurs. L'éval correspondante de
   `tests/evals.mjs` exige donc `present` et non `top`, avec la note qui l'explique.
