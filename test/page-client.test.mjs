import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const RACINE = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = readFileSync(join(RACINE, "src", "site.ts"), "utf8");

function bloc(nom) {
  const m = SRC.match(new RegExp(`const ${nom} = String\\.raw\`([\\s\\S]*?)\`;`));
  assert.ok(m, `bloc ${nom} introuvable dans src/site.ts`);
  return m[1];
}

const BOOT = bloc("BOOT");
const LARGE = (SRC.match(/const LARGE = "([^"]+)"/) ?? [])[1];

test("les blocs String.raw sont extractibles et sans backtick", () => {
  assert.ok(LARGE, "const LARGE introuvable");
  assert.ok(!BOOT.includes("`"), "BOOT contient un backtick");
  assert.ok(!bloc("JS").includes("`"), "JS contient un backtick");
});

test("le point de rupture n'est écrit qu'une fois (jeton LARGEUR)", () => {
  assert.ok(bloc("JS").includes("LARGEUR"), "jeton LARGEUR absent du JS client");
  assert.ok(jsClient().includes(`min-width:${LARGE}`), "LARGEUR non substitué");
});

function jsClient() {
  return bloc("JS").replace("LARGEUR", LARGE);
}

function scene({ langStockee = null, themeStocke = null, langue = "fr-CA", large = true } = {}) {
  const store = new Map();
  if (langStockee) store.set("legisLang", langStockee);
  if (themeStocke) store.set("legisTheme", themeStocke);

  const noeud = (id) => {
    const e = { id, className: "", lang: "", open: undefined, _h: {} };
    e.classList = {
      contains: (c) => e.className.split(/\s+/).filter(Boolean).includes(c),
      add(c) {
        if (!this.contains(c)) e.className = `${e.className} ${c}`.trim();
      },
      remove(c) {
        e.className = e.className
          .split(/\s+/)
          .filter((x) => x && x !== c)
          .join(" ");
      },
      toggle(c, on) {
        if (on) this.add(c);
        else this.remove(c);
      },
    };
    e.addEventListener = (t, f) => {
      (e._h[t] ??= []).push(f);
    };
    e.click = () => (e._h.click ?? []).forEach((f) => f());
    e.querySelectorAll = () => [];
    return e;
  };

  const html = noeud("html");
  const bascule = noeud("bascule");
  const theme = noeud("theme");
  const tdm = noeud("tdm");
  const haut = noeud("haut");
  const titre = {
    getAttribute: (a) =>
      ({
        "data-fr": "MCP Législation — Lois du Québec et du Canada",
        "data-en": "MCP Legislation — Laws of Québec and Canada",
      })[a] ?? null,
  };
  const requetes = [];

  const fenetre = {
    innerHeight: 800,
    pageYOffset: 0,
    _h: {},
    addEventListener(t, f) {
      (this._h[t] ??= []).push(f);
    },
    defiler(y) {
      this.pageYOffset = y;
      (this._h.scroll ?? []).forEach((f) => f());
    },
  };

  const globaux = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    navigator: { language: langue },
    matchMedia: (q) => {
      requetes.push(q);
      return {
        matches: /min-width/.test(q) ? large : false,
        addEventListener() {},
        addListener() {},
      };
    },
    IntersectionObserver: class {
      observe() {}
    },
    window: fenetre,
    document: {
      title: "MCP Législation — Lois du Québec et du Canada",
      documentElement: html,
      getElementById: (i) => ({ bascule, theme })[i] ?? null,
      querySelector: (s) => ({ ".tdm": tdm, ".haut": haut, "title[data-en]": titre })[s] ?? null,
    },
  };

  const noms = Object.keys(globaux);
  const lancer = (code) => new Function(...noms, code)(...noms.map((n) => globaux[n]));

  lancer(BOOT);
  const demarrerJs = () => lancer(jsClient());
  const classes = () => html.className.split(/\s+/).filter(Boolean).sort().join(" ");
  return {
    html,
    bascule,
    theme,
    tdm,
    haut,
    fenetre,
    store,
    requetes,
    demarrerJs,
    classes,
    doc: globaux.document,
  };
}

test("amorçage à froid : français, thème automatique (aucune classe de thème)", () => {
  const s = scene();
  assert.equal(s.classes(), "l-fr");
  assert.equal(s.html.lang, "fr");
});

test("amorçage : la langue du navigateur est respectée", () => {
  const s = scene({ langue: "en-CA" });
  assert.equal(s.classes(), "l-en");
  assert.equal(s.doc.title, "MCP Legislation — Laws of Québec and Canada");
  s.demarrerJs();
  s.bascule.click();
  assert.equal(s.doc.title, "MCP Législation — Lois du Québec et du Canada");
});

test("amorçage : les deux préférences stockées sont posées ENSEMBLE", () => {
  const s = scene({ langStockee: "en", themeStocke: "dark" });
  assert.equal(s.classes(), "l-en t-dark");
  assert.equal(s.html.lang, "en");
});

test("amorçage : un thème stocké aberrant est ignoré (retour à l'automatique)", () => {
  assert.equal(scene({ themeStocke: "sombre" }).classes(), "l-fr");
});

test("thème : cycle auto -> clair -> sombre -> auto", () => {
  const s = scene();
  s.demarrerJs();
  s.theme.click();
  assert.equal(s.classes(), "js l-fr t-light");
  assert.equal(s.store.get("legisTheme"), "light");
  s.theme.click();
  assert.equal(s.classes(), "js l-fr t-dark");
  assert.equal(s.store.get("legisTheme"), "dark");
  s.theme.click();
  assert.equal(s.classes(), "js l-fr");
  assert.equal(s.store.has("legisTheme"), false, "la clé doit être RETIRÉE, pas mise à 'auto'");
});

test("RÉGRESSION : basculer la langue ne doit PAS effacer le thème", () => {
  const s = scene({ themeStocke: "dark" });
  s.demarrerJs();
  s.bascule.click();
  assert.equal(s.classes(), "js l-en t-dark", "le thème a été écrasé par la bascule de langue");
  assert.equal(s.html.lang, "en");
  s.bascule.click();
  assert.equal(s.classes(), "js l-fr t-dark");
  assert.equal(s.html.lang, "fr");
});

test("RÉGRESSION : basculer le thème ne doit PAS effacer la langue", () => {
  const s = scene({ langStockee: "en" });
  s.demarrerJs();
  s.theme.click();
  assert.equal(s.classes(), "js l-en t-light");
  assert.equal(s.html.lang, "en", "l'attribut lang doit survivre au changement de thème");
});

test("une seule classe de langue à la fois (sinon les DEUX langues s'affichent)", () => {
  const s = scene();
  s.demarrerJs();
  for (let i = 0; i < 3; i++) {
    s.bascule.click();
    const c = s.html.className.split(/\s+/).filter(Boolean);
    assert.equal(c.filter((x) => x === "l-fr" || x === "l-en").length, 1, `après ${i + 1} clic(s)`);
  }
});

test("une seule classe de thème à la fois", () => {
  const s = scene();
  s.demarrerJs();
  for (let i = 0; i < 4; i++) {
    s.theme.click();
    const c = s.html.className.split(/\s+/).filter(Boolean);
    assert.ok(
      c.filter((x) => x === "t-light" || x === "t-dark").length <= 1,
      `après ${i + 1} clic(s)`,
    );
  }
});

test("la préférence de langue survit à un rechargement", () => {
  const s = scene();
  s.demarrerJs();
  s.theme.click();
  s.bascule.click();
  const attendu = s.classes();
  const s2 = scene({
    langStockee: s.store.get("legisLang"),
    themeStocke: s.store.get("legisTheme"),
  });
  s2.demarrerJs();
  assert.equal(s2.classes(), attendu, "l'état rechargé diffère de l'état quitté");
});

test("TDM : dépliée au-dessus du point de rupture, repliée en dessous", () => {
  const large = scene({ large: true });
  large.demarrerJs();
  assert.equal(large.tdm.open, true);
  assert.ok(
    large.requetes.some((q) => q.includes(`min-width:${LARGE}`)),
    `aucune requête média sur ${LARGE}`,
  );

  const etroit = scene({ large: false });
  etroit.demarrerJs();
  assert.equal(etroit.tdm.open, false);
});

test("pastille : masquée en haut de page, visible après un écran défilé", () => {
  const s = scene();
  s.demarrerJs();
  assert.ok(
    s.html.classList.contains("js"),
    "la classe js n'est pas posée : le CSS ne masquera jamais la pastille",
  );
  assert.equal(s.haut.classList.contains("on"), false, "visible alors qu'on est en haut");
  s.fenetre.defiler(900);
  assert.ok(s.haut.classList.contains("on"), "invisible après un écran défilé");
  s.fenetre.defiler(0);
  assert.equal(s.haut.classList.contains("on"), false, "reste visible revenu en haut");
});

test("pastille : 'js' vit dans le script de fin de page, PAS dans BOOT", () => {
  assert.ok(!BOOT.includes("js"), "BOOT ne doit pas poser la classe js");
  assert.ok(/classList\.add\('js'\)/.test(bloc("JS")), "le script de fin de page doit poser js");
});

test("RÉGRESSION : la pastille absente ne doit pas emporter le reste du script", () => {
  const js = bloc("JS").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(js.includes("if(ht){"), "le bloc de la pastille doit être un if(ht){…}");
  assert.ok(!/if\(!ht\)/.test(js), "if(!ht) return; tuerait le filtre et le tri du tableau");
});

test("pastille : le lien reste utilisable sans JavaScript", () => {
  assert.ok(SRC.includes(`href="#top"`), "la pastille doit être une ancre vers #top");
  assert.ok(
    /class="sr"/.test(SRC),
    "la pastille a besoin d'un libellé accessible : le contenu d'un <a> prime sur title",
  );
});

test("SECTIONS : aucun identifiant en double", () => {
  const ids = [...SRC.matchAll(/\{ id: "([a-z]+)",/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(ids)], ids, "identifiant de section en double");
});

test("RENDU couvre exactement les sections, sans trou ni surplus", () => {
  const bloc = SRC.match(/const RENDU: Record<SectionId, \(\) => string> = \{([\s\S]*?)\n {2}\};/);
  assert.ok(bloc, "RENDU introuvable — le garde de typage a-t-il été retiré ?");
  const cles = [...bloc[1].matchAll(/^\s*([a-z]+):/gm)].map((m) => m[1]).sort();
  const ids = [...SRC.matchAll(/\{ id: "([a-z]+)",/g)].map((m) => m[1]).sort();
  assert.deepEqual(cles, ids);
});

test("l'avertissement est RENDU, pas seulement défini", () => {
  assert.ok(
    /function reperage\(\)[\s\S]*?\$\{limites\(\)\}/.test(SRC),
    "reperage() n'appelle plus limites() : l'avertissement a disparu de la page",
  );
  assert.ok(SRC.includes(`<section id="limites"`), "l'ancre #limites doit survivre");
  assert.ok(
    /Aucun conseil juridique/.test(SRC) && /No legal advice/.test(SRC),
    "la clause de non-conseil doit rester au pied de page, dans les deux langues",
  );
});

test("la TDM couvre exactement les sections de premier niveau", () => {
  const ids = [...SRC.matchAll(/\{ id: "([a-z]+)",/g)].map((m) => m[1]);
  assert.ok(ids.length >= 5, "SECTIONS semble vide");
  for (const id of ids) {
    assert.ok(SRC.includes(`<section id="${id}"`), `aucune <section id="${id}"> dans le corps`);
    assert.ok(SRC.includes(`h2("${id}")`), `le <h2> de ${id} n'est pas tiré de SECTIONS`);
  }
});

test("aucune couleur en dur hors des deux jeux de variables", () => {
  const css = (SRC.match(/const CSS = `([\s\S]*?)`;/) ?? [])[1];
  assert.ok(css, "bloc CSS introuvable");
  const sansJeux = css.replace(/\$\{(CLAIR|SOMBRE)\}/g, "");
  const dures = [...sansJeux.matchAll(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/g)].map((m) => m[0]);
  assert.deepEqual(dures, [], `couleurs hors variables : ${dures.join(", ")}`);
});

test("les deux jeux de thème déclarent exactement les mêmes variables", () => {
  const vars = (nom) => {
    const m = SRC.match(new RegExp(`const ${nom}\\s*=\\s*([\\s\\S]*?);\\r?\\n`));
    assert.ok(m, `jeu ${nom} introuvable`);
    return [...m[1].matchAll(/(--[a-z-]+):/g)].map((x) => x[1]).sort();
  };
  assert.deepEqual(vars("CLAIR"), vars("SOMBRE"));
});

test("navigation inter-connecteurs, saut clavier et schéma JSON-LD dans le gabarit", () => {
  assert.ok(SRC.includes('<nav class="suite"'), "barre de suite absente");
  assert.ok(SRC.includes('href="https://acces.poirierlavoie.ca/"'), "lien Accès absent");
  assert.ok(
    SRC.includes('href="https://jurisprudence.poirierlavoie.ca/"'),
    "lien Jurisprudence absent",
  );
  assert.ok(SRC.includes('href="https://outils.poirierlavoie.ca/"'), "lien Outils absent");
  assert.ok(SRC.includes('href="/" aria-current="page"'), "aria-current absent sur Législation");
  assert.ok(SRC.includes('href="#contenu-principal"'), "lien d'évitement clavier absent");
  assert.ok(SRC.includes('type="application/ld+json"'), "JSON-LD absent");
  assert.ok(!SRC.includes("data-h="), "attribut redondant data-h encore émis");
});
