// Tests hors ligne du pilote de backfill incrémental (scripts/backfill-vectors.mjs).

import assert from "node:assert/strict";
import { test } from "vitest";
import {
  parseBackfillArgs,
  resolveBackfillToken,
  runBackfill,
} from "../scripts/backfill-vectors.mjs";

test("parseBackfillArgs : drapeaux --mode, --incremental, --prune, --seed-if-empty", () => {
  const d = parseBackfillArgs([]);
  assert.equal(d.mode, "full");
  assert.equal(d.prune, false);
  assert.deepEqual(d.kinds, ["articles", "divisions"]);

  const inc = parseBackfillArgs([
    "--incremental",
    "--prune",
    "--laws",
    "ccq,cpc",
    "--kind",
    "articles",
  ]);
  assert.equal(inc.mode, "incremental");
  assert.equal(inc.prune, true);
  assert.deepEqual(inc.laws, ["ccq", "cpc"]);
  assert.deepEqual(inc.kinds, ["articles"]);

  const seed = parseBackfillArgs(["--mode", "incremental", "--seed-if-empty"]);
  assert.equal(seed.mode, "incremental");
  assert.equal(seed.seedIfEmpty, true);

  assert.throws(() => parseBackfillArgs(["--mode", "invalide"]), /Mode invalide/);
});

test("resolveBackfillToken : lit BACKFILL_TOKEN en env et refuse si absent", () => {
  assert.equal(resolveBackfillToken({ BACKFILL_TOKEN: "  abc  " }), "abc");
  assert.throws(() => resolveBackfillToken({}), /BACKFILL_TOKEN absent/);
});

test("runBackfill : enchaîne incremental + prune et gère reprise sur 502", async () => {
  const calls = [];
  let failOnce = true;
  const fetchMock = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (body.law === "ccq" && body.kind === "articles" && body.mode === "incremental" && failOnce) {
      failOnce = false;
      return new Response("bad gateway", { status: 502 });
    }
    if (body.mode === "prune") {
      return new Response(JSON.stringify({ mode: "prune", deleted: 2, done: true }), {
        status: 200,
      });
    }
    return new Response(
      JSON.stringify({
        mode: body.mode,
        scanned: 5,
        embedded: 1,
        skipped: 4,
        overruns: 0,
        done: true,
        next: 5,
      }),
      { status: 200 },
    );
  };

  const res = await runBackfill({
    baseUrl: "https://example.test",
    token: "tok",
    laws: ["ccq"],
    kinds: ["articles", "divisions"],
    mode: "incremental",
    prune: true,
    progressPath: null,
    paceMs: 0,
    retryBaseMs: 0,
    fetchImpl: fetchMock,
    log: () => {},
    write: () => {},
  });

  assert.equal(res.totalScanned, 10);
  assert.equal(res.totalEmbedded, 2);
  assert.equal(res.totalSkipped, 8);
  assert.equal(res.totalDeleted, 4);
  assert.deepEqual(
    calls.map((c) => `${c.kind}:${c.mode}`),
    [
      "articles:incremental",
      "articles:incremental",
      "articles:prune",
      "divisions:incremental",
      "divisions:prune",
    ],
  );
});

test("runBackfill --seed-if-empty bascule sur seed quand tracked=0", async () => {
  const modes = [];
  const fetchMock = async (_url, init) => {
    const body = JSON.parse(init.body);
    modes.push(`${body.kind}:${body.mode}`);
    if (body.mode === "ping") {
      return new Response(JSON.stringify({ ok: true, tracked: 0 }), { status: 200 });
    }
    return new Response(
      JSON.stringify({ mode: "seed", scanned: 3, seeded: 3, embedded: 0, done: true, next: 3 }),
      { status: 200 },
    );
  };

  const res = await runBackfill({
    baseUrl: "https://example.test",
    token: "tok",
    laws: ["cpc"],
    kinds: ["articles"],
    mode: "incremental",
    seedIfEmpty: true,
    prune: true,
    progressPath: null,
    paceMs: 0,
    retryBaseMs: 0,
    fetchImpl: fetchMock,
    log: () => {},
    write: () => {},
  });

  assert.equal(res.totalSeeded, 3);
  assert.equal(res.totalEmbedded, 0);
  assert.equal(res.totalDeleted, 0);
  assert.deepEqual(modes, ["articles:ping", "articles:seed"]);
});
