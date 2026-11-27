import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import {
  agregeParSeau,
  checkPdfBuffer,
  classify,
  computeDrift,
  extractConsolidation,
  extractConsolidationFederale,
  extractPdfIndexDrift,
  fetchLivePdf,
  isCloudflare403,
  loadPdfProfilePins,
  NOM_PUBLIEUR,
  parsePdfHeader,
  sha256HexBytes,
  UNREACHABLE_ALERT_RATIO,
} from "./check-consolidation.mjs";

const RACINE = join(dirname(fileURLToPath(import.meta.url)), "..");

const banner = (d) => `<div class="text-end"> À jour au ${d} </div>`;

test("extractConsolidation : bannière canonique (avec <sup>er</sup>)", () => {
  assert.equal(
    extractConsolidation(`<div class="text-end"> À jour au 1<sup>er</sup> avril 2026 </div>`),
    "2026-04-01",
  );
  assert.equal(extractConsolidation(banner("3 mars 2025")), "2025-03-03");
});

test("extractConsolidation : ignore les dates d'historique HORS text-end (finding fidélité #6)", () => {
  const html = `<p>en vigueur de la mise à jour au 1 janvier 1984</p>${banner("2 avril 2026")}`;
  assert.equal(extractConsolidation(html), "2026-04-02");
});

test("extractConsolidation : ignore le contenu des <script> (finding fidélité #8)", () => {
  const html = `<script>var x="jour au 9 mai 2010";</script>${banner("3 mars 2025")}`;
  assert.equal(extractConsolidation(html), "2025-03-03");
});

test("extractConsolidation : ne colle pas le texte d'éléments distincts (finding fidélité #8)", () => {
  const html = `<td>dernière mise à jour au</td><td>5 janvier 2024</td>`;
  assert.equal(extractConsolidation(html), null);
});

test("extractConsolidation : poursuit sur un mois invalide, retient la date valide (finding fidélité #7)", () => {
  const html = banner("5 foobar 2020") + banner("3 mars 2025");
  assert.equal(extractConsolidation(html), "2025-03-03");
});

test("extractConsolidation : page atteinte sans bannière -> null (=> illisible, pas silencieux)", () => {
  assert.equal(extractConsolidation(`<html><body>rien ici</body></html>`), null);
});

test("classify : une page 200 illisible n'est PAS rangée en injoignable (finding cardinal #1/#2)", () => {
  const { illisible, injoignable, retard } = classify([
    { status: "illisible", stored: "2026-04-01", live: null },
    { status: "injoignable", stored: "2026-04-01", live: null },
    { status: "ok", stored: "2026-04-01", live: "2026-04-02" },
  ]);
  assert.equal(illisible.length, 1);
  assert.equal(injoignable.length, 1);
  assert.equal(retard.length, 1);
});

test("classify : retard / anomalie / à jour / sans date stockée", () => {
  const { retard, anomalie, sansStockee } = classify([
    { status: "ok", stored: "2026-04-01", live: "2026-04-02" },
    { status: "ok", stored: "2026-04-02", live: "2026-04-01" },
    { status: "ok", stored: "2026-04-01", live: "2026-04-01" },
    { status: "ok", stored: null, live: "2026-04-01" },
  ]);
  assert.equal(retard.length, 1);
  assert.equal(anomalie.length, 1);
  assert.equal(sansStockee.length, 1);
});

test("computeDrift : une page illisible suffit à déclencher la dérive (finding cardinal)", () => {
  const d = computeDrift({
    retard: [],
    anomalie: [],
    sansStockee: [],
    illisible: [{}],
    sansLangue: [],
    injoignable: [],
    total: 10,
  });
  assert.equal(d.drift, true);
});

test("computeDrift : injoignables sous le seuil, sans autre signal -> pas de dérive", () => {
  const injoignable = Array.from({ length: 2 }, () => ({}));
  const d = computeDrift({
    retard: [],
    anomalie: [],
    sansStockee: [],
    illisible: [],
    sansLangue: [],
    injoignable,
    total: 100,
  });
  assert.equal(d.drift, false);
});

test("computeDrift : blocage massif injoignable -> alerte réseau, SANS dérive corpus (séparation 2026-07-23)", () => {
  const injoignable = Array.from({ length: 30 }, () => ({}));
  const d = computeDrift({
    retard: [],
    anomalie: [],
    sansStockee: [],
    illisible: [],
    sansLangue: [],
    injoignable,
    total: 100,
  });
  assert.equal(d.unreachableRatio >= UNREACHABLE_ALERT_RATIO, true);
  assert.equal(d.unreachableAlert, true);
  assert.equal(d.drift, false);
});

test("computeDrift : blocage massif + retard réel -> les DEUX drapeaux levés (le blocage ne masque pas la dérive)", () => {
  const injoignable = Array.from({ length: 30 }, () => ({}));
  const d = computeDrift({
    retard: [{}],
    anomalie: [],
    sansStockee: [],
    illisible: [],
    sansLangue: [],
    injoignable,
    total: 100,
  });
  assert.equal(d.drift, true);
  assert.equal(d.unreachableAlert, true);
});

test("computeDrift : une loi sans langue déclarée est actionnable (finding #4/#5)", () => {
  const d = computeDrift({
    retard: [],
    anomalie: [],
    sansStockee: [],
    illisible: [],
    sansLangue: [{ id: "x" }],
    injoignable: [],
    total: 0,
  });
  assert.equal(d.drift, true);
});

const LOI_FR =
  "<div class='info'><p id='assentedDate'>Loi &agrave; jour 2026-07-21; " +
  "<a href='#hist'>derni&egrave;re modification</a> 2026-06-20 " +
  "<a href='PITIndex.html'>Versions antérieures</a></p></div>";
const LOI_EN =
  "<div class='info'><p id='assentedDate'>Act current to 2026-07-21 and " +
  "<a href='#hist'>last amended</a> on 2026-06-20. " +
  "<a href='PITIndex.html'>Previous Versions</a></p></div>";
const REGLEMENT_FR =
  "<div class='info'><p id='assentedDate'>Règlement à jour 2026-07-21; " +
  "<a href='#hist'>derni&egrave;re modification</a> 2025-12-21 " +
  "<a href='PITIndex.html'>Versions antérieures</a></p></div>";

test("extractConsolidationFederale : les trois libellés réels rendent la date « à jour »", () => {
  assert.equal(extractConsolidationFederale(LOI_FR), "2026-07-21");
  assert.equal(extractConsolidationFederale(LOI_EN), "2026-07-21");
  assert.equal(extractConsolidationFederale(REGLEMENT_FR), "2026-07-21");
});

test("extractConsolidationFederale : l'ORDRE des deux dates ne décide rien", () => {
  const inverse =
    "<p id='assentedDate'><a href='#hist'>derni&egrave;re modification</a> " +
    "2026-06-20 — Loi &agrave; jour 2026-07-21;</p>";
  assert.equal(extractConsolidationFederale(inverse), "2026-07-21");
});

test("extractConsolidationFederale : une date HORS du bloc est ignorée (portée bornée)", () => {
  const html =
    "<p class='hist'>à jour 1999-01-01</p>" +
    "<div class='info'><p id='assentedDate'>Loi &agrave; jour 2026-07-21;</p></div>" +
    "<p class='note'>à jour 2030-12-31</p>";
  assert.equal(extractConsolidationFederale(html), "2026-07-21");
});

test("extractConsolidationFederale : ignore le contenu des <script> (parité avec le miroir QC)", () => {
  const html =
    "<script>var x=\"<p id='assentedDate'>Loi à jour 1999-01-01;</p>\";</script>" +
    "<p id='assentedDate'>Loi &agrave; jour 2026-07-21;</p>";
  assert.equal(extractConsolidationFederale(html), "2026-07-21");
});

test("extractConsolidationFederale : bloc absent -> null (=> illisible, jamais « à jour »)", () => {
  assert.equal(
    extractConsolidationFederale("<html><body><p>Loi à jour 2026-07-21;</p></body></html>"),
    null,
  );
});

test("extractConsolidationFederale : libellé changé -> null, on refuse au lieu de deviner", () => {
  assert.equal(
    extractConsolidationFederale("<p id='assentedDate'>Consolidé le 2026-07-21.</p>"),
    null,
  );
  assert.equal(
    extractConsolidationFederale("<p id='assentedDate'>Loi à jour 21 juillet 2026;</p>"),
    null,
  );
});

test("MIROIR : la regex fédérale est identique des deux côtés (JS ↔ Python)", () => {
  const js = readFileSync(join(RACINE, "scripts/check-consolidation.mjs"), "utf8");
  const py = readFileSync(join(RACINE, "pipeline/ingest.py"), "utf8");

  const mJs = js.match(/const DATE_FEDERALE = \/([^/]+)\/i;/);
  assert.ok(mJs, "regex d'ancrage introuvable dans check-consolidation.mjs");

  const mPy = py.match(/_DATE_FEDERALE = re\.compile\(r"([^"]+)", re\.I\)/);
  assert.ok(mPy, "_DATE_FEDERALE introuvable dans pipeline/ingest.py");

  assert.equal(
    mJs[1],
    mPy[1],
    "les deux moitiés du miroir de date fédérale ont divergé : l'ingestion et la veille " +
      "liraient des dates différentes sur la même page, et les 36 contrôles fédéraux " +
      "seraient faux sans qu'aucun test ne rougisse.",
  );

  assert.ok(js.includes("assentedDate"), "portée du bloc absente côté JS");
  assert.ok(py.includes('find("p", id="assentedDate")'), "portée du bloc absente côté Python");
});

const ctl = (publieur, status, extra = {}) => ({
  id: "x",
  lang: "fr",
  publieur,
  status,
  stored: "2026-01-01",
  live: "2026-01-01",
  ...extra,
});

test("agregeParSeau : un seau ENTIÈREMENT bloqué alerte, même si l'autre est propre", () => {
  const checks = [
    ...Array.from({ length: 36 }, () => ctl("justice", "injoignable", { note: "réseau" })),
    ...Array.from({ length: 158 }, () => ctl("legisquebec", "ok")),
  ];
  const r = agregeParSeau(checks);
  assert.equal(r.unreachableAlert, true, "un blocage TOTAL du fédéral doit alerter");
  assert.deepEqual(r.bloquees, [NOM_PUBLIEUR.justice]);
  assert.equal(r.seaux.get("justice").unreachableRatio, 1);
  assert.equal(r.seaux.get("legisquebec").unreachableAlert, false);
});

test("agregeParSeau : le MÊME jeu agrégé globalement NE déclencherait PAS l'alerte", () => {
  const injoignable = Array.from({ length: 36 }, () => ({}));
  const global = computeDrift({
    retard: [],
    anomalie: [],
    sansStockee: [],
    illisible: [],
    sansLangue: [],
    injoignable,
    total: 194,
  });
  assert.equal(global.unreachableAlert, false);
  assert.ok(global.unreachableRatio < UNREACHABLE_ALERT_RATIO);
});

test("agregeParSeau : la dérive d'UN seul seau suffit à faire parler le job (OU)", () => {
  const checks = [
    ctl("justice", "ok", { stored: "2026-01-01", live: "2026-07-21" }),
    ctl("legisquebec", "ok"),
  ];
  const r = agregeParSeau(checks);
  assert.equal(r.drift, true);
  assert.equal(r.seaux.get("justice").drift, true);
  assert.equal(r.seaux.get("legisquebec").drift, false);
});

test("agregeParSeau : `bloquees` nomme les DEUX publieurs quand les deux bloquent", () => {
  const checks = [
    ...Array.from({ length: 4 }, () => ctl("justice", "injoignable", { note: "réseau" })),
    ...Array.from({ length: 4 }, () => ctl("legisquebec", "injoignable", { note: "réseau" })),
  ];
  const r = agregeParSeau(checks);
  assert.deepEqual(r.bloquees.sort(), [NOM_PUBLIEUR.justice, NOM_PUBLIEUR.legisquebec].sort());
});

test("agregeParSeau : un seau VIDE est OMIS, jamais compté comme sain", () => {
  const r = agregeParSeau([ctl("legisquebec", "ok")]);
  assert.equal(r.seaux.has("justice"), false);
  assert.equal(r.seaux.size, 1);
});

test("agregeParSeau : une loi sans langue reste actionnable, DANS SON seau", () => {
  const r = agregeParSeau([ctl("legisquebec", "ok")], [{ id: "ca-x", publieur: "justice" }]);
  assert.equal(r.drift, true);
  assert.equal(r.seaux.get("justice").drift, true);
  assert.equal(r.seaux.get("legisquebec").drift, false);
});

test("parsePdfHeader & checkPdfBuffer : valide %PDF-, rejette soft-404 HTML, détecte dérive SHA-256", () => {
  const pdfBytes = Buffer.from("%PDF-1.7\n1 0 obj << /ModDate (D:20260223120000-05'00') >>\n%%EOF");
  const hdr = parsePdfHeader(pdfBytes);
  assert.equal(hdr.valid, true);
  assert.equal(hdr.modDate, "2026-02-23");

  const expected = sha256HexBytes(pdfBytes);
  const okRes = checkPdfBuffer(pdfBytes, { expectedSha256: expected, storedDate: "2026-02-23" });
  assert.equal(okRes.status, "ok");
  assert.equal(okRes.shaDrift, false);

  const driftRes = checkPdfBuffer(pdfBytes, {
    expectedSha256: "0".repeat(64),
    storedDate: "2026-02-23",
  });
  assert.equal(driftRes.status, "ok");
  assert.equal(driftRes.shaDrift, true);

  const htmlSoft404 = Buffer.from("<!doctype html><html><body>Introuvable</body></html>");
  const badRes = checkPdfBuffer(htmlSoft404, {
    expectedSha256: expected,
    storedDate: "2026-02-23",
  });
  assert.equal(badRes.status, "illisible");

  const missingPin = checkPdfBuffer(pdfBytes, {
    expectedSha256: undefined,
    storedDate: "2026-02-23",
  });
  assert.equal(missingPin.status, "illisible");
  assert.match(missingPin.note, /SHA-256/i);
});

test("extractPdfIndexDrift : page d'index qccs-div-mtl (match, renommage, aucun lien)", () => {
  const baseUrl =
    "https://coursuperieureduquebec.ca/division-de-montreal/directives-et-annexes-en-vigueur";
  const htmlOk = `<p>À jour au 1<sup>er</sup> janvier 2026</p><a href="/fileadmin/Directives_de_la_division_de_Montreal.pdf">Directives</a>`;
  const rOk = extractPdfIndexDrift(htmlOk, {
    expectedFilename: "Directives_de_la_division_de_Montreal.pdf",
    baseUrl,
  });
  assert.equal(rOk.status, "ok");
  assert.equal(rOk.shaDrift, false);
  assert.equal(rOk.liveDate, "2026-01-01");
  assert.equal(
    rOk.matchedUrl,
    "https://coursuperieureduquebec.ca/fileadmin/Directives_de_la_division_de_Montreal.pdf",
  );

  const htmlRenamed = `<a href="/fileadmin/Directives_de_la_division_de_Montreal_2026_11.pdf">Nouveau</a>`;
  const rDrift = extractPdfIndexDrift(htmlRenamed, {
    expectedFilename: "Directives_de_la_division_de_Montreal.pdf",
    baseUrl,
  });
  assert.equal(rDrift.status, "ok");
  assert.equal(rDrift.shaDrift, true);

  const rEmpty = extractPdfIndexDrift("<html><body>Aucun document</body></html>", {
    expectedFilename: "Directives_de_la_division_de_Montreal.pdf",
    baseUrl,
  });
  assert.equal(rEmpty.status, "illisible");

  const rEncoded = extractPdfIndexDrift(
    '<a href="/fileadmin/Directives%20de%20la%20division%20de%20Montreal.pdf">Directives</a>',
    {
      expectedFilename: "Directives de la division de Montreal.pdf",
      baseUrl,
    },
  );
  assert.equal(rEncoded.status, "ok");
  assert.equal(rEncoded.shaDrift, false);
});

test("fetchLivePdf : classe Cloudflare 403 en injoignable et suit page d'index vers PDF", async () => {
  assert.equal(isCloudflare403(403, new Headers({ "cf-mitigated": "challenge" }), ""), true);
  assert.equal(
    isCloudflare403(403, new Headers(), "<html><title>Just a moment...</title></html>"),
    true,
  );

  const r403 = await fetchLivePdf(
    "https://courduquebec.ca/fileadmin/test.pdf",
    { filename: "test.pdf", sha256: "a".repeat(64) },
    "2026-01-01",
    async () =>
      new Response("<html>Just a moment...</html>", {
        status: 403,
        headers: { "cf-mitigated": "challenge" },
      }),
  );
  assert.equal(r403.status, "injoignable");
  assert.match(r403.note, /Cloudflare 403/);

  const pdfBytes = Buffer.from("%PDF-1.7\ncontenu\n%%EOF");
  const expectedSha = sha256HexBytes(pdfBytes);
  const indexHtml = '<a href="/files/Directives_de_la_division_de_Montreal.pdf">Directives</a>';
  const rIdx = await fetchLivePdf(
    "https://coursuperieureduquebec.ca/division-de-montreal/directives-et-annexes-en-vigueur",
    { filename: "Directives_de_la_division_de_Montreal.pdf", sha256: expectedSha },
    "2026-01-01",
    async (u) => {
      if (String(u).endsWith(".pdf")) {
        return new Response(pdfBytes, {
          status: 200,
          headers: { "content-type": "application/pdf" },
        });
      }
      return new Response(indexHtml, { status: 200, headers: { "content-type": "text/html" } });
    },
  );
  assert.equal(rIdx.status, "ok");
  assert.equal(rIdx.shaDrift, false);
});

test("agregeParSeau : isole le 3e seau 'pdf' et classe shaDrift en retard", () => {
  const checks = [
    ...Array.from({ length: 13 }, () =>
      ctl("pdf", "injoignable", {
        note: "Cloudflare 403 (challenge WAF — vérification manuelle requise)",
      }),
    ),
    ...Array.from({ length: 158 }, () => ctl("legisquebec", "ok")),
    ...Array.from({ length: 36 }, () => ctl("justice", "ok")),
  ];
  const r = agregeParSeau(checks);
  assert.equal(r.unreachableAlert, true);
  assert.equal(r.drift, false);
  assert.deepEqual(r.bloquees, [NOM_PUBLIEUR.pdf]);
  assert.equal(r.seaux.size, 3);
  assert.equal(r.seaux.get("legisquebec").unreachableAlert, false);
  assert.equal(r.seaux.get("justice").unreachableAlert, false);

  const driftChecks = [
    ctl("pdf", "ok", { shaDrift: true, note: "empreinte SHA-256 modifiée" }),
    ctl("legisquebec", "ok"),
  ];
  const rDrift = agregeParSeau(driftChecks);
  assert.equal(rDrift.drift, true);
  assert.equal(rDrift.seaux.get("pdf").retard.length, 1);
});

test("loadPdfProfilePins : charge les 15 empreintes SHA-256 des profils PDF", () => {
  const pins = loadPdfProfilePins(RACINE);
  assert.equal(pins.size, 15);
  assert.ok(pins.get("qccs-div-mtl")?.fr?.sha256);
  assert.equal(pins.get("qccs-div-mtl")?.fr?.filename, "Directives_de_la_division_de_Montreal.pdf");
  assert.ok(pins.get("ca-const-1867")?.fr?.sha256);
  assert.ok(pins.get("ca-const-1867")?.en?.sha256);
  assert.equal(pins.get("ca-const-1982")?.en?.filename, "CONST_TRD.pdf");
});

test("extractPdfIndexDrift : le nom de fichier exact prime sur un préfixe antérieur (Annexe_<cible>.pdf)", () => {
  const baseUrl =
    "https://coursuperieureduquebec.ca/division-de-montreal/directives-et-annexes-en-vigueur";
  const html =
    '<a href="/fileadmin/Annexe_Directives_de_la_division_de_Montreal.pdf">Annexe</a>' +
    '<a href="/fileadmin/Directives_de_la_division_de_Montreal.pdf">Directives</a>';
  const r = extractPdfIndexDrift(html, {
    expectedFilename: "Directives_de_la_division_de_Montreal.pdf",
    baseUrl,
  });
  assert.equal(r.status, "ok");
  assert.equal(r.shaDrift, false);
  assert.equal(
    r.matchedUrl,
    "https://coursuperieureduquebec.ca/fileadmin/Directives_de_la_division_de_Montreal.pdf",
  );
});

test("fetchLivePdf : borne le suivi d'index à 1 saut et classe une boucle HTML 200 en illisible", async () => {
  let calls = 0;
  const htmlLoop =
    '<html><body><a href="/fileadmin/Directives_de_la_division_de_Montreal.pdf">Directives</a></body></html>';
  const r = await fetchLivePdf(
    "https://coursuperieureduquebec.ca/division-de-montreal/directives-et-annexes-en-vigueur",
    { filename: "Directives_de_la_division_de_Montreal.pdf", sha256: "a".repeat(64) },
    "2026-01-01",
    async () => {
      calls += 1;
      return new Response(htmlLoop, {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    },
  );
  assert.ok(calls <= 2, `attendu <= 2 appels fetch, obtenu ${calls}`);
  assert.equal(r.status, "illisible");
});
