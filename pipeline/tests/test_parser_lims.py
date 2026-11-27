from __future__ import annotations

import unittest
from pathlib import Path

from pipeline.model import DISPOSITION_SORT_BASE, Law
from pipeline.parser_lims import (
    Bilan, BalisageIncoherent, ErreurIngestion, derive_citation, derive_in_force,
    derive_titre, expand_plage, numero_de_division, parse_lims,
)

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "lims"

def lire(nom: str) -> bytes:
    return (FIXTURES / nom).read_bytes()

def loi(law_id: str = "ca-test") -> Law:
    return Law(id=law_id, name_fr="?", name_en="?", official_cite="?")

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

    def test_art_2_lfi_porte_ses_51_definitions(self):
        _, arts, _ = analyse("b-3-art-2-definitions.xml")
        art = par_numero(arts, "2")
        self.assertGreater(len(art.text), 13_000,
                           "les blocs Definition n'ont pas été descendus — voir §7.1")
        for terme in ("actif à court terme", "failli", "syndic"):
            self.assertIn(terme, art.text, f"définition « {terme} » absente du texte")

    def test_la_phrase_introductive_reste_en_tete(self):
        _, arts, _ = analyse("b-3-art-2-definitions.xml")
        art = par_numero(arts, "2")
        self.assertTrue(art.text.startswith("Les définitions qui suivent"))

class TestSerialisation(unittest.TestCase):

    def test_art_183_lfi_note_marginale_hors_du_texte(self):
        _, arts, _ = analyse("b-3-art-183.xml")
        art = par_numero(arts, "183")
        self.assertEqual(art.marginal_note, "Tribunaux compétents")
        self.assertNotIn("Tribunaux compétents", art.text,
                         "la note marginale a fui dans le texte — art. 14 L.i., et R4")

    def test_art_183_conserve_ses_labels_internes(self):
        _, arts, _ = analyse("b-3-art-183.xml")
        art = par_numero(arts, "183")
        self.assertIn("(1)", art.text)
        self.assertIn("(1.1)", art.text, "l'alinéa (1.1) manque")
        self.assertIn("a)", art.text)
        self.assertFalse(art.text.lstrip().startswith("183"))

    def test_art_183_historique_sorti_du_texte(self):
        _, arts, _ = analyse("b-3-art-183.xml")
        art = par_numero(arts, "183")
        self.assertIsNotNone(art.history)
        self.assertIn("ch. B-3", art.history)
        self.assertNotIn(art.history, art.text)

class TestLabelsABalisage(unittest.TestCase):

    def test_numero_de_label_retire_l_asterisque(self):
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

class TestNumeroDeDivision(unittest.TestCase):

    def test_les_formes_reelles_du_corpus(self):
        for label, attendu in [
            ("PARTIE I", "I"), ("PARTIE II", "II"), ("PARTIE III", "III"),
            ("PARTIE IV", "IV"), ("PARTIE XIV", "XIV"), ("PARTIE XXI", "XXI"),
            ("PART III", "III"), ("PART 2", "2"),
            ("SECTION I", "I"), ("SECTION 3", "3"),
            ("DIVISION I", "I"), ("DIVISION 7", "7"),
            ("PARTIE XIV.1", "XIV.1"), ("PARTIE VII.1", "VII.1"), ("SECTION I.1", "I.1"),
        ]:
            self.assertEqual(numero_de_division(label), attendu, label)

    def test_les_pieges_exacts_de_l_ancienne_regle(self):
        for label, ancienne_valeur_fausse in [
            ("PARTIE II", "I"),
            ("PARTIE XIV", "I"),
            ("SECTION I", "C"),
            ("DIVISION I", "DIVI"),
        ]:
            self.assertNotEqual(numero_de_division(label), ancienne_valeur_fausse, label)

    def test_un_mot_cle_inedit_ARRETE(self):
        for label in ("ANNEXE 1", "SCHEDULE 2", "CHAPITRE IV", "TARIF A"):
            with self.assertRaises(BalisageIncoherent, msg=label):
                numero_de_division(label)

    def test_label_vide_ou_absent(self):
        self.assertIsNone(numero_de_division(""))
        self.assertIsNone(numero_de_division("   "))

    def test_le_corpus_quebecois_nest_pas_concerne(self):
        import pipeline.parser as parser_epub
        self.assertFalse(hasattr(parser_epub, "numero_de_division"),
                         "le correctif ne doit pas fuir dans le parseur EPUB")

class TestPlages(unittest.TestCase):

    def test_i_15_porte_le_label_de_plage(self):
        for nom, attendu in (("i-15-fr.xml", "11 à 14"), ("i-15-en.xml", "11 to 14")):
            lang = "fr" if nom.endswith("fr.xml") else "en"
            _, arts, _ = analyse(nom, lang)
            self.assertIn(attendu, [a.number for a in arts])

    def test_expansion_est_propre_a_la_langue(self):
        self.assertEqual(expand_plage("11 à 14"), ["11", "12", "13", "14"])
        self.assertEqual(expand_plage("11 to 14"), ["11", "12", "13", "14"])
        self.assertEqual(expand_plage("7 et 8"), ["7", "8"])
        self.assertEqual(expand_plage("7 and 8"), ["7", "8"])
        self.assertEqual(expand_plage("183"), [], "un numéro simple n'est pas une plage")

    def test_la_cle_de_tri_dune_plage_est_celle_du_premier_numero(self):
        _, arts, _ = analyse("i-15-fr.xml")
        plage = par_numero(arts, "11 à 14")
        art10 = par_numero(arts, "10")
        self.assertIsNotNone(plage.sort_key)
        self.assertLess(plage.sort_key, DISPOSITION_SORT_BASE,
                        "la plage est rangée parmi les pseudo-articles, donc en fin de corpus")
        self.assertGreater(plage.sort_key, art10.sort_key or 0,
                           "la plage doit suivre l'article 10")

class TestPreambule(unittest.TestCase):

    def test_preambule_du_code_canadien_du_travail(self):
        divs, arts, b = analyse("l-2-preambule.xml")
        art = par_numero(arts, "preambule")
        self.assertEqual(art.sort_key, 0,
                         "0 : le préambule PRÉCÈDE l'article 1 (art. 13 de la Loi d'interprétation)")
        self.assertIn("Attendu", art.text)
        self.assertEqual(b.preambule, 2,
                         "les DEUX Section doivent être comptées au bilan, même fusionnées")
        self.assertTrue(any(d.path == "fp:0" and d.kind == "disposition" for d in divs))

class TestBilanDeMatiere(unittest.TestCase):

    def test_i_15_bilan_par_provenance(self):
        divs, arts, b = analyse("i-15-fr.xml")
        self.assertEqual(b.corps, 11)
        self.assertEqual(b.annexe, 0)
        self.assertEqual(b.preambule, 0)
        self.assertEqual(b.refuse_ancetre + b.refuse_annexe, 8)
        self.assertEqual(b.inconnu, 0)
        self.assertEqual(len([d for d in divs if d.kind in ("partie", "rubrique")]), 3)

    def test_aucune_section_non_en_vigueur_ne_devient_un_article(self):
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

    def test_f_29_2_est_edictee_mais_non_en_vigueur(self):
        import xml.etree.ElementTree as ET
        racine = ET.fromstring(lire("f-29.2-fr.xml"))
        self.assertEqual(derive_in_force(racine), 0)

    def test_une_loi_en_vigueur_le_declare(self):
        import xml.etree.ElementTree as ET
        self.assertEqual(derive_in_force(ET.fromstring(lire("i-15-fr.xml"))), 1)

    def test_un_reglement_sans_attribut_est_en_vigueur(self):
        import xml.etree.ElementTree as ET
        self.assertEqual(derive_in_force(ET.fromstring(b'<Regulation xml:lang="fr"/>')), 1)
        self.assertEqual(
            derive_in_force(ET.fromstring(b'<Regulation xml:lang="fr" in-force="no"/>')), 0)

class TestCitation(unittest.TestCase):

    def test_forme_consolidee(self):
        import xml.etree.ElementTree as ET
        racine = ET.fromstring(lire("i-15-fr.xml"))
        self.assertEqual(derive_citation(racine, "fr"), ("L.R.C. (1985), ch. I-15", "I-15"))
        self.assertEqual(derive_citation(racine, "en"), ("R.S.C. 1985, c. I-15", "I-15"))

    def test_le_chapitre_est_rendu_separement(self):
        import xml.etree.ElementTree as ET
        _, chapitre = derive_citation(ET.fromstring(lire("i-15-fr.xml")), "fr")
        self.assertEqual(chapitre, "I-15")

    def test_titre_dune_loi_vient_du_short_title(self):
        import xml.etree.ElementTree as ET
        self.assertEqual(derive_titre(ET.fromstring(lire("i-15-fr.xml"))), "Loi sur l’intérêt")

class TestPorteDesBalises(unittest.TestCase):

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
        xml = (b'<Statute xml:lang="fr" in-force="yes"><Identification/>'
               b'<Body/><Schedule><Section><Label>1</Label>'
               b'<Text>x</Text></Section></Schedule></Statute>')
        with self.assertRaises(ErreurIngestion) as ctx:
            parse_lims(xml, loi(), "fr")
        self.assertIn("chaîne", str(ctx.exception).lower())

class TestIsomorphisme(unittest.TestCase):

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

class TestVague3BalisesEtAnnexes(unittest.TestCase):

    @staticmethod
    def _parse(xml: bytes, law_id: str = "ca-test", lang: str = "fr"):
        b = Bilan()
        divs, arts = parse_lims(xml, loi(law_id), lang, bilan=b)
        return divs, arts, b

    def test_preambule_introduction_sans_section_n_altere_pas_le_bilan(self):
        xml = (
            b'<Statute xml:lang="fr" in-force="yes"><Identification/>'
            b"<Introduction><Preamble>"
            b"<Provision><Text>Attendu que les adolescents...</Text></Provision>"
            b"</Preamble></Introduction>"
            b"<Body><Section><Label>1</Label><Text>Titre abr\xc3\xa9g\xc3\xa9.</Text></Section></Body>"
            b"</Statute>"
        )
        divs, arts, b = self._parse(xml, "ca-y-1.5", "fr")
        pre = par_numero(arts, "preambule")
        self.assertEqual(pre.sort_key, 0)
        self.assertEqual(pre.division_path, "fp:0")
        self.assertIn("adolescents", pre.text)
        self.assertEqual(b.preambule, 0)
        self.assertEqual(b.corps, 1)
        self.assertEqual(b.inconnu, 0)
        self.assertTrue(any(d.path == "fp:0" and d.kind == "disposition" for d in divs))

    def test_keep_en_ligne_conserve_le_mot_sans_collage(self):
        xml = (
            b'<Statute xml:lang="en" in-force="yes"><Identification/>'
            b"<Body><Section><Label>696.75</Label>"
            b"<Subsection><Label>(2)</Label>"
            b'<Text>The <Keep svc="1">authorized</Keep> commissioner may act.</Text>'
            b"</Subsection></Section></Body></Statute>"
        )
        _, arts, _ = self._parse(xml, "ca-c-46", "en")
        art = par_numero(arts, "696.75")
        self.assertIn("The authorized commissioner may act.", art.text)

    def test_annexes_sans_section_list_table_repealed_et_formgroup(self):
        xml = (
            b'<Statute xml:lang="fr" in-force="yes"><Identification/>'
            b"<Body><Section><Label>2</Label><Text>D\xc3\xa9finitions.</Text></Section></Body>"
            b"<Schedule><ScheduleFormHeading><Label>ANNEXE I</Label></ScheduleFormHeading>"
            b"<List><Item><Label>1</Label><Text>Pavot \xc3\xa0 opium :</Text>"
            b"<List><Item><Label>(1)</Label><Text>opium</Text></Item></List>"
            b"</Item></List></Schedule>"
            b"<Schedule><ScheduleFormHeading><Label>ANNEXE V</Label></ScheduleFormHeading>"
            b"<DocumentInternal><Group><GroupHeading><Label>PARTIE 1</Label>"
            b"<TitleText>Substances d\xc3\xa9sign\xc3\xa9es</TitleText></GroupHeading>"
            b"<Provision><table><tgroup cols=\"2\"><tbody>"
            b"<row><entry>Article</entry><entry>Substance</entry></row>"
            b"<row><entry>1</entry><entry>Exempt\xc3\xa9</entry></row>"
            b"</tbody></tgroup></table></Provision></Group></DocumentInternal></Schedule>"
            b"<Schedule><ScheduleFormHeading><Label>ANNEXE VII</Label></ScheduleFormHeading>"
            b"<Repealed>[Abrog\xc3\xa9e, 2018, ch. 16, art. 205]</Repealed></Schedule>"
            b"<Schedule><ScheduleFormHeading><Label>FORMULE 5</Label></ScheduleFormHeading>"
            b"<FormGroup><Provision><Text>Mandat de perquisition</Text></Provision>"
            b"<Provision><Text>Au nom de Sa Majest\xc3\xa9.</Text></Provision></FormGroup></Schedule>"
            b"</Statute>"
        )
        _, arts, _ = self._parse(xml, "ca-c-38.8", "fr")
        a1 = par_numero(arts, "annexe-i")
        self.assertGreaterEqual(a1.sort_key, DISPOSITION_SORT_BASE)
        self.assertIn("1 Pavot à opium :", a1.text)
        self.assertIn("  (1) opium", a1.text)
        a5 = par_numero(arts, "annexe-v")
        self.assertIn("PARTIE 1 — Substances désignées", a5.text)
        self.assertIn("1 : Exempté", a5.text)
        a7 = par_numero(arts, "annexe-vii")
        self.assertEqual(a7.repealed, 1)
        f5 = par_numero(arts, "formule-5")
        self.assertIn("Mandat de perquisition\nAu nom de Sa Majesté.", f5.text)

if __name__ == "__main__":
    unittest.main()
