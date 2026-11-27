import assert from "node:assert/strict";
import { test } from "vitest";
import { checkBaselineGate } from "../eval/run.mjs";

const sampleBaseline = () => ({
  aggregates: { cases_zero: 0 },
  cases: [
    {
      id: 1,
      query: "vice caché",
      search: {
        recall_at_10: 1,
        mrr: 1,
        must_found: ["ccq|1726"],
        top: ["ccq|1726", "ccq|1728", "ccq|1739"],
      },
      find_relevant: { coverage: 1 },
    },
    {
      id: 2,
      query: "assignation hors du Québec",
      search: {
        recall_at_10: 1,
        mrr: 0.5,
        must_found: ["cpc|490"],
        top: ["cpc|145", "cpc|490"],
      },
      find_relevant: { coverage: 0.5 },
    },
  ],
});

test("checkBaselineGate : passe à l'identique et tolère une permutation en queue sans régression", () => {
  const base = sampleBaseline();
  assert.deepEqual(checkBaselineGate(base, base), { ok: true, regressions: [], notices: [] });

  const permuted = sampleBaseline();
  permuted.cases[0].search.top = ["ccq|1726", "ccq|1739", "ccq|1728"];
  const g = checkBaselineGate(permuted, base);
  assert.equal(g.ok, true);
  assert.equal(g.notices.length, 1);
});

test("checkBaselineGate : échoue sur toute régression de recall, MRR, must_found ou FR-couv", () => {
  const base = sampleBaseline();

  const badRecall = sampleBaseline();
  badRecall.cases[0].search.recall_at_10 = 0;
  badRecall.cases[0].search.must_found = [];
  assert.equal(checkBaselineGate(badRecall, base).ok, false);

  const badMrr = sampleBaseline();
  badMrr.cases[1].search.mrr = 0.25;
  assert.equal(checkBaselineGate(badMrr, base).ok, false);

  const badMust = sampleBaseline();
  badMust.cases[0].search.must_found = [];
  assert.equal(checkBaselineGate(badMust, base).ok, false);

  const badFr = sampleBaseline();
  badFr.cases[1].find_relevant.coverage = 0;
  assert.equal(checkBaselineGate(badFr, base).ok, false);
});
