"""Témoins de recette du parseur LIMS — HORS RÉSEAU.

Les fixtures de `pipeline/tests/fixtures/lims/` sont figées au SHA
`9c40b2a03bc38be8250ef7f86b1d5699afd08cbe` et versionnées : ces tests tournent donc sans le
clone du dépôt de Justice Canada, contrairement aux tests du parseur EPUB
(`test_ccq_fr`, `test_corpus`) qui téléchargent. Ils ont leur place en CI.

Chaque témoin correspond au §8.7 de `docs/phase0-structure-lims.md`, et chacun existe parce
qu'un défaut PRÉCIS a été mesuré. Les compteurs sont des faits datés, pas des préférences :
les changer demande de rejouer la reconnaissance, pas d'ajuster le test.

Régénérer les fixtures (exige le clone, cf. `pipeline/config.py::LIMS_REPO`) : le script de
génération vit hors du dépôt ; il extrait une `Section` nommée et la remet dans une
enveloppe `Statute`/`Body` minimale. `PROVENANCE.txt` porte le SHA et l'attribution exigée
par la Licence du gouvernement ouvert – Canada.
"""
from __future__ import annotations

import unittest
from pathlib import Path

from pipeline.model import DISPOSITION_SORT_BASE, Law
from pipeline.parser_lims import (
    Bilan, ErreurIngestion, derive_citation, derive_in_force, derive_titre,
    expand_plage, numero_de_label, parse_lims,
)

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "lims"


def lire(nom: str) -> bytes:
    return (FIXTURES / nom).read_bytes()


def loi(law_id: str = "ca-test") -> Law:
    return Law(id=law_id, name_fr="?", name_en="?", rlrq_cite="?")


def analyse(nom: str, lang: str = "fr") -> tuple[list, list, Bilan]:
    b = Bilan()
    divs, arts = parse_lims(lire(nom), loi(), lang, bilan=b)
    return divs, arts, b


def par_numero(arts: list, numero: str):
    for a in arts:
        if a.number == numero:
            return a
    raise AssertionError(f"article {numero!r} absent (présents : {[a.number for a in arts]})")


class TestDefinitions(unittest.TestCase):
    """§7.1 — LE PIÈGE PRINCIPAL du corpus."""

    def test_art_2_lfi_porte_ses_51_definitions(self):
        """`Definition` est ABSENTE de la liste de sérialisation du SPEC §3.5.

        Mesuré : l'art. 2 de la L.F.I. compte 51 blocs `Definition` et 13 736 caractères.
        Un walker qui ne les descend pas rend « Les définitions qui suivent s'appliquent à
        la présente loi. » — 59 caractères, soit 99,6 % de l'article perdu, sur la
        disposition la plus citée de toute loi. Et le résultat est une phrase PLAUSIBLE,
        donc indétectable à la lecture d'un échantillon.
        """
        _, arts, _ = analyse("b-3-art-2-definitions.xml")
        art = par_numero(arts, "2")
        self.assertGreater(len(art.text), 13_000,
                           "les blocs Definition n'ont pas été descendus — voir §7.1")
        # Trois termes définis, pris au début, au milieu et à la fin de l'énumération.
        for terme in ("actif à court terme", "failli", "syndic"):
            self.assertIn(terme, art.text, f"définition « {terme} » absente du texte")

    def test_la_phrase_introductive_reste_en_tete(self):
        _, arts, _ = analyse("b-3-art-2-definitions.xml")
        art = par_numero(arts, "2")
        self.assertTrue(art.text.startswith("Les définitions qui suivent"))


class TestSerialisation(unittest.TestCase):
    """§4 — ce qui reste dans le texte, et ce qui en sort."""

    def test_art_183_lfi_note_marginale_hors_du_texte(self):
        """Art. 14 de la Loi d'interprétation : la note marginale NE FAIT PAS partie du texte."""
        _, arts, _ = analyse("b-3-art-183.xml")
        art = par_numero(arts, "183")
        self.assertEqual(art.marginal_note, "Tribunaux compétents")
        self.assertNotIn("Tribunaux compétents", art.text,
                         "la note marginale a fui dans le texte — art. 14 L.i., et R4")

    def test_art_183_conserve_ses_labels_internes(self):
        """On plaide « art. 183(1)a) L.F.I. » : un texte sans ses (1) et ses a) est inutilisable."""
        _, arts, _ = analyse("b-3-art-183.xml")
        art = par_numero(arts, "183")
        self.assertIn("(1)", art.text)
        self.assertIn("(1.1)", art.text, "l'alinéa (1.1) manque")
        self.assertIn("a)", art.text)
        # Mais le Label de la Section elle-même — le numéro — est retiré.
        self.assertFalse(art.text.lstrip().startswith("183"))

    def test_art_183_historique_sorti_du_texte(self):
        _, arts, _ = analyse("b-3-art-183.xml")
        art = par_numero(arts, "183")
        self.assertIsNotNone(art.history)
        self.assertIn("ch. B-3", art.history)
        self.assertNotIn(art.history, art.text)


class TestLabelsABalisage(unittest.TestCase):
    """§7.4 — aplatir NE SUFFIT PAS : il faut retirer le marqueur de note."""

    def test_numero_de_label_retire_l_asterisque(self):
        """Aplatir naïvement rend « *36 », et `get_article(law, '36')` ne trouve rien."""
        _, arts, _ = analyse("d-3.4-art-36-label-balise.xml")
        self.assertEqual([a.number for a in arts], ["36"])
        _, arts, _ = analyse("p-8.6-art-72-label-balise.xml")
        self.assertEqual([a.number for a in arts], ["72"])

    def test_aucun_numero_ne_commence_par_un_marqueur(self):
        for nom in ("d-3.4-art-36-label-balise.xml", "p-8.6-art-72-label-balise.xml",
                    "b-3-art-183.xml", "i-15-fr.xml"):
            _, arts, _ = analyse(nom)
            for a in arts:
                self.assertFalse(a.number.startswith(("*", "†", "‡")),
                                 f"{nom} : numéro {a.number!r} porte un marqueur de note")


class TestPlages(unittest.TestCase):
    """§3.6 — le témoin de plage, et il est DANS le corpus."""

    def test_i_15_porte_le_label_de_plage(self):
        """Le SPEC §8 nommait la Loi sur les banques, hors corpus. I-15 fait l'affaire."""
        for nom, attendu in (("i-15-fr.xml", "11 à 14"), ("i-15-en.xml", "11 to 14")):
            lang = "fr" if nom.endswith("fr.xml") else "en"
            _, arts, _ = analyse(nom, lang)
            self.assertIn(attendu, [a.number for a in arts])

    def test_expansion_est_propre_a_la_langue(self):
        """Corollaire de l'isomorphisme (§3.1) : les divergences FR/EN sont dans les plages."""
        self.assertEqual(expand_plage("11 à 14"), ["11", "12", "13", "14"])
        self.assertEqual(expand_plage("11 to 14"), ["11", "12", "13", "14"])
        self.assertEqual(expand_plage("7 et 8"), ["7", "8"])
        self.assertEqual(expand_plage("7 and 8"), ["7", "8"])
        self.assertEqual(expand_plage("183"), [], "un numéro simple n'est pas une plage")

    def test_la_cle_de_tri_dune_plage_est_celle_du_premier_numero(self):
        """`sort_key()` seul rendrait 9e15 et empilerait TOUTES les plages sur une valeur.

        Le parseur pré-pose donc la clé. Et `load.prepare` doit la RESPECTER — son ancien
        `a.sort_key or sort_key(...)` jetait toute clé valant 0.
        """
        _, arts, _ = analyse("i-15-fr.xml")
        plage = par_numero(arts, "11 à 14")
        art10 = par_numero(arts, "10")
        self.assertIsNotNone(plage.sort_key)
        self.assertLess(plage.sort_key, DISPOSITION_SORT_BASE,
                        "la plage est rangée parmi les pseudo-articles, donc en fin de corpus")
        self.assertGreater(plage.sort_key, art10.sort_key or 0,
                           "la plage doit suivre l'article 10")


class TestPreambule(unittest.TestCase):
    """§3.6 — deux emplacements, dont un que le SPEC signale sans le décrire."""

    def test_preambule_du_code_canadien_du_travail(self):
        """Deux `Section` consécutives : l'une étiquetée « Préambule » et SANS texte propre,
        l'autre à `Label` VIDE et porteuse des `Provision`. Elles fusionnent en un article.
        """
        divs, arts, b = analyse("l-2-preambule.xml")
        art = par_numero(arts, "preambule")
        self.assertEqual(art.sort_key, 0,
                         "0 : le préambule PRÉCÈDE l'article 1 (art. 13 de la Loi d'interprétation)")
        self.assertIn("Attendu", art.text)
        self.assertEqual(b.preambule, 2,
                         "les DEUX Section doivent être comptées au bilan, même fusionnées")
        self.assertTrue(any(d.path == "fp:0" and d.kind == "disposition" for d in divs))


class TestBilanDeMatiere(unittest.TestCase):
    """§7.3 — le contrôle qui remplace l'invariant §4.1, lequel s'équilibre des deux côtés."""

    def test_i_15_bilan_par_provenance(self):
        """Valeurs mesurées. I-15 porte 8 Section de droit NON EN VIGUEUR, sous NifProvs."""
        divs, arts, b = analyse("i-15-fr.xml")
        self.assertEqual(b.corps, 11)
        self.assertEqual(b.annexe, 0)
        self.assertEqual(b.preambule, 0)
        self.assertEqual(b.refuse_ancetre + b.refuse_annexe, 8)
        self.assertEqual(b.inconnu, 0)
        self.assertEqual(len([d for d in divs if d.kind in ("partie", "rubrique")]), 3)

    def test_aucune_section_non_en_vigueur_ne_devient_un_article(self):
        """Les Section de NifProvs portent 17, 18, 175, 176 — disjoints du corps 1..11.

        Un doublon de numéro ne les trahirait donc PAS : c'est l'invariant §4.4 du SPEC qui
        est aveugle ici, et c'est pourquoi le refus se fait par CHAÎNE D'ANCÊTRES.
        """
        _, arts, _ = analyse("i-15-fr.xml")
        numeros = {a.number for a in arts}
        for interdit in ("17", "18", "175", "176"):
            self.assertNotIn(interdit, numeros,
                             f"l'article {interdit} vient de MODIFICATIONS NON EN VIGUEUR")

    def test_le_bilan_couvre_toute_section_du_fichier(self):
        for nom, lang in (("i-15-fr.xml", "fr"), ("i-15-en.xml", "en"),
                          ("b-3-art-183.xml", "fr"), ("l-2-preambule.xml", "fr")):
            _, _, b = analyse(nom, lang)
            self.assertEqual(b.inconnu, 0, f"{nom} : Section non attribuée")


class TestEntreeEnVigueur(unittest.TestCase):
    """§5.1 — la polarité d'`in-force` dépend du TYPE DE RACINE."""

    def test_f_29_2_est_edictee_mais_non_en_vigueur(self):
        """Le témoin de REFUS. Une LOI sans `in-force` sur sa racine n'est pas en vigueur."""
        import xml.etree.ElementTree as ET
        racine = ET.fromstring(lire("f-29.2-fr.xml"))
        self.assertEqual(derive_in_force(racine), 0)

    def test_une_loi_en_vigueur_le_declare(self):
        import xml.etree.ElementTree as ET
        self.assertEqual(derive_in_force(ET.fromstring(lire("i-15-fr.xml"))), 1)

    def test_un_reglement_sans_attribut_est_en_vigueur(self):
        """« Absent ⇒ 0 » (SPEC §3.7) refuserait les DEUX règlements du corpus.

        La DTD ne déclare pas `in-force` sur `Regulation`, et ni DORS/98-106 ni
        C.R.C. ch. 368 ne le portent : l'absence n'est une information que là où
        l'attribut EXISTE.
        """
        import xml.etree.ElementTree as ET
        self.assertEqual(derive_in_force(ET.fromstring(b'<Regulation xml:lang="fr"/>')), 1)
        self.assertEqual(
            derive_in_force(ET.fromstring(b'<Regulation xml:lang="fr" in-force="no"/>')), 0)


class TestCitation(unittest.TestCase):
    """§3.4 — trois formes déterministes, dérivées d'`Identification`, jamais du nom de fichier."""

    def test_forme_consolidee(self):
        import xml.etree.ElementTree as ET
        racine = ET.fromstring(lire("i-15-fr.xml"))
        self.assertEqual(derive_citation(racine, "fr"), ("L.R.C. (1985), ch. I-15", "I-15"))
        self.assertEqual(derive_citation(racine, "en"), ("R.S.C. 1985, c. I-15", "I-15"))

    def test_le_chapitre_est_rendu_separement(self):
        """`parseCitation` doit apparier sur le CHAPITRE, jamais sur la citation entière.

        « L.R.C. (1985), ch. B-3 » fait 23 caractères, plus que tout chapitre RLRQ, et
        remporterait la course du plus long dans la boucle de `src/lib.ts`.
        """
        import xml.etree.ElementTree as ET
        _, chapitre = derive_citation(ET.fromstring(lire("i-15-fr.xml")), "fr")
        self.assertEqual(chapitre, "I-15")

    def test_titre_dune_loi_vient_du_short_title(self):
        """Le §7.7 : un RÈGLEMENT n'a pas de `ShortTitle`, seulement `LongTitle`.

        L'apostrophe attendue est TYPOGRAPHIQUE (U+2019), comme dans la source. Le parseur
        la préserve délibérément — même choix que le parseur EPUB, dont `_norm` ne normalise
        que les ESPACES Unicode et laisse les autres caractères verbatim. Un texte officiel
        ne se retouche pas (R4).
        """
        import xml.etree.ElementTree as ET
        self.assertEqual(derive_titre(ET.fromstring(lire("i-15-fr.xml"))), "Loi sur l’intérêt")


class TestPorteDesBalises(unittest.TestCase):
    """La liste BLANCHE : une balise ou une chaîne inédite ARRÊTE l'ingestion."""

    def test_balise_inconnue_arrete(self):
        xml = (b'<Statute xml:lang="fr" in-force="yes"><Identification/>'
               b'<Body><Balisebidon/></Body></Statute>')
        with self.assertRaises(ErreurIngestion) as ctx:
            parse_lims(xml, loi(), "fr")
        self.assertIn("Balisebidon", str(ctx.exception))

    def test_racine_inattendue_arrete(self):
        with self.assertRaises(ErreurIngestion):
            parse_lims(b'<Autre xml:lang="fr"/>', loi(), "fr")

    def test_chaine_dancetres_inedite_arrete(self):
        """Une `Section` hors des trois chaînes blanches et sans conteneur de refus."""
        xml = (b'<Statute xml:lang="fr" in-force="yes"><Identification/>'
               b'<Body/><Schedule><Section><Label>1</Label>'
               b'<Text>x</Text></Section></Schedule></Statute>')
        with self.assertRaises(ErreurIngestion) as ctx:
            parse_lims(xml, loi(), "fr")
        self.assertIn("chaîne", str(ctx.exception).lower())


class TestIsomorphisme(unittest.TestCase):
    """§3.1 — acquis à DÉFENDRE, pas hypothèse."""

    def test_i_15_meme_structure_dans_les_deux_langues(self):
        divs_fr, arts_fr, _ = analyse("i-15-fr.xml", "fr")
        divs_en, arts_en, _ = analyse("i-15-en.xml", "en")
        self.assertEqual(len(divs_fr), len(divs_en))
        self.assertEqual(len(arts_fr), len(arts_en))
        self.assertEqual([d.path for d in divs_fr], [d.path for d in divs_en],
                         "les chemins positionnels doivent être IDENTIQUES : c'est ce qui "
                         "rend le court-circuit de translateDivisionPath légitime")

    def test_les_divergences_de_numeros_sont_lexicales_et_dans_les_plages(self):
        _, arts_fr, _ = analyse("i-15-fr.xml", "fr")
        _, arts_en, _ = analyse("i-15-en.xml", "en")
        ecarts = [(a.number, b.number) for a, b in zip(arts_fr, arts_en) if a.number != b.number]
        self.assertEqual(ecarts, [("11 à 14", "11 to 14")])


if __name__ == "__main__":
    unittest.main()
