import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "frontend-b/package.json"));
const { buildSync } = require("esbuild");
const built = buildSync({ entryPoints: [path.join(root, "frontend-b/src/ending-insights.ts")], bundle: true,
  write: false, platform: "node", format: "esm", target: "es2022", logLevel: "silent" });
const { resolveEndingInsights } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString("base64")}`);
const metric = (update = {}) => ({ spread: 4, bad_actions: 6, detect_turns: 5, repair_turns: 12,
  status: "REPAIRED", injected_turn: 10, resolved_turn: 22, observed_until_turn: 22, censored: false,
  contexts_before_adoption: 1, ...update });
const card = (update = {}) => ({ name: "走远部落", choices: { D2: "A", D3: "A", D4: "A" },
  metrics: { attack1: metric(), attack2: metric({ spread: 1, bad_actions: 0, status: "PREVENTED", injected_turn: 22,
    detect_turns: 2, repair_turns: 2, resolved_turn: 24, observed_until_turn: 24, contexts_before_adoption: 3 }) },
  completed_turn: 24, protocol: { meta_rule: "context_diversity" }, cost: { adoption_delay_turns: null, token_overhead_pct: null }, ...update });
const point = (value, attack, id) => value.attacks[attack - 1].points.find(item => item.id === id);
const value = (result, id) => result.values.find(item => item.id === id);
function freeze(object) { if (object && typeof object === "object") { Object.values(object).forEach(freeze); Object.freeze(object); } return object; }

test("two actual attack observations create comparisons without claiming causality", () => {
  const result = resolveEndingInsights(card());
  assert.equal(result.comparisons[0].delta, -3);
  assert.equal(result.comparisons[1].delta, -6);
  assert.equal(result.comparisons[0].tone, "positive");
  assert.match(result.comparisons[0].detail, /本局两次观察/);
  assert.match(result.comparisons[0].detail, /不单独归因/);
  assert.match(result.limits.join(" "), /不是对照实验/);
});

test("worsening counts stay visible and zero is not missing", () => {
  const result = resolveEndingInsights(card({ metrics: { attack1: metric({ spread: 0, bad_actions: 0 }), attack2: metric({ spread: 3, bad_actions: 7 }) } }));
  assert.equal(result.comparisons[0].first, 0);
  assert.equal(result.comparisons[0].delta, 3);
  assert.equal(result.comparisons[1].tone, "caution");
});

test("missing and invalid counts stay unknown rather than producing fake improvement", () => {
  const result = resolveEndingInsights(card({ metrics: { attack1: metric({ spread: undefined, bad_actions: -1 }), attack2: metric({ spread: NaN, bad_actions: Infinity }) } }));
  assert.equal(result.comparisons[0].delta, null);
  assert.equal(result.comparisons[1].delta, null);
  assert.equal(result.attacks[0].spread, null);
});

test("discovery turn is derived from valid injected turn and nonnegative recorded metric", () => {
  const result = resolveEndingInsights(card());
  assert.deepEqual([point(result, 1, "discovery").turn, point(result, 1, "discovery").elapsedTurns], [15, 5]);
  assert.equal(point(result, 1, "discovery").basis, "derived");
  assert.match(point(result, 1, "discovery").label, /争议/);
  assert.match(point(result, 1, "discovery").detail, /不能据此确定首次异常/);
});

test("negative detection retains historical time but never displays negative duration", () => {
  const result = resolveEndingInsights(card({ metrics: { attack1: metric(), attack2: metric({ injected_turn: 56, resolved_turn: 58,
    observed_until_turn: 58, status: "PREVENTED", detect_turns: -13, repair_turns: 2 }) }, completed_turn: 58 }));
  const discovery = point(result, 2, "discovery");
  assert.equal(discovery.turn, 43);
  assert.equal(discovery.elapsedTurns, null);
  assert.equal(discovery.basis, "historical");
  assert.equal(point(result, 2, "resolved").elapsedTurns, 2);
  assert.match(result.limits.join(" "), /负发现指标/);
});

test("negative metric without injection cannot fabricate an absolute historical turn", () => {
  const result = resolveEndingInsights(card({ metrics: { attack1: metric({ injected_turn: undefined, detect_turns: -5 }), attack2: metric() } }));
  assert.equal(point(result, 1, "discovery").turn, null);
  assert.equal(point(result, 1, "discovery").elapsedTurns, null);
  assert.equal(point(result, 1, "discovery").basis, "historical");
});

test("future derived discovery is not shown as an observed event", () => {
  const result = resolveEndingInsights(card({ metrics: { attack1: metric({ detect_turns: 100 }), attack2: metric() } }));
  assert.equal(point(result, 1, "discovery").turn, null);
  assert.equal(point(result, 1, "discovery").elapsedTurns, null);
  assert.match(result.attacks[0].warnings.join(" "), /超出观察范围/);
});

test("null discovery remains unknown even when closure time exists", () => {
  const result = resolveEndingInsights(card({ metrics: { attack1: metric({ detect_turns: null }), attack2: metric() } }));
  assert.equal(point(result, 1, "discovery").turn, null);
  assert.equal(point(result, 1, "discovery").elapsedTurns, null);
  assert.equal(point(result, 1, "resolved").turn, 22);
});

test("old card preserves durations without inventing status or absolute times", () => {
  const old = { spread: 2, bad_actions: 3, detect_turns: 4, repair_turns: 8 };
  const result = resolveEndingInsights(card({ metrics: { attack1: old, attack2: old }, completed_turn: undefined }));
  assert.equal(result.attacks[0].status, null);
  assert.equal(point(result, 1, "injected").turn, null);
  assert.equal(point(result, 1, "discovery").turn, null);
  assert.equal(point(result, 1, "discovery").elapsedTurns, 4);
  assert.equal(point(result, 1, "resolved").elapsedTurns, 8);
  assert.match(point(result, 1, "resolved").label, /状态未知/);
});

test("REPAIRED, REVOKED, PREVENTED and unfinished states are distinct", () => {
  for (const [status, label] of [["REPAIRED", "规则修正"], ["REVOKED", "撤回旧说法"], ["PREVENTED", "采纳前阻止"], ["INVESTIGATING", "尚未结案"]]) {
    const result = resolveEndingInsights(card({ metrics: { attack1: metric({ status }), attack2: metric() } }));
    assert.equal(point(result, 1, "resolved").label, label);
    if (status === "INVESTIGATING") {
      assert.equal(point(result, 1, "resolved").turn, null);
      assert.equal(point(result, 1, "resolved").elapsedTurns, null);
    }
  }
});

test("closure metric conflicts are reported and valid endpoints take precedence", () => {
  const result = resolveEndingInsights(card({ metrics: { attack1: metric({ repair_turns: 3 }), attack2: metric() } }));
  assert.equal(point(result, 1, "resolved").elapsedTurns, 12);
  assert.match(result.attacks[0].warnings.join(" "), /起止回合不一致/);
});

test("a missing absolute closure may be derived while an explicit null stays unknown", () => {
  const result = resolveEndingInsights(card({ metrics: { attack1: metric({ resolved_turn: undefined }), attack2: metric({ resolved_turn: null }) } }));
  assert.equal(point(result, 1, "resolved").turn, 22);
  assert.equal(point(result, 1, "resolved").basis, "derived");
  assert.equal(point(result, 2, "resolved").turn, null);
});

test("observation cutoff does not become a completion or discovery", () => {
  const result = resolveEndingInsights(card({ metrics: { attack1: metric({ status: "SPREADING", detect_turns: null, repair_turns: null, resolved_turn: null, censored: true }), attack2: metric() } }));
  assert.match(point(result, 1, "observed").label, /未结案/);
  assert.equal(point(result, 1, "discovery").turn, null);
  assert.equal(point(result, 1, "resolved").turn, null);
});

test("actual protocol takes precedence over an inconsistent choice and no rule is invented", () => {
  const result = resolveEndingInsights(card({ choices: { D3: "A" }, protocol: { meta_rule: "none" } }));
  assert.equal(value(result, "verification").title, "没有新增验证规矩");
  const missing = resolveEndingInsights(card({ choices: {}, protocol: {} }));
  assert.equal(value(missing, "verification").title, "验证规矩未记录");
});

test("recorded rule variants and D4 adjustments use specific honest semantics", () => {
  for (const [choice, match] of [["A", /场景/], ["B", /三位独立/], ["C", /自身支持证据/], ["D", /不新增/]]) {
    const result = resolveEndingInsights(card({ choices: { D3: choice, D4: "B" }, protocol: {} }));
    assert.match(value(result, "verification").detail, match);
    assert.match(value(result, "verification").detail, /0\.9/);
    assert.match(value(result, "verification").detail, /不单独证明/);
  }
});

test("unknown cost is never zero while a measured zero delay is respected", () => {
  const unknown = resolveEndingInsights(card());
  assert.match(value(unknown, "cost").detail, /未计量不是零成本/);
  const measured = resolveEndingInsights(card({ cost: { adoption_delay_turns: 0, token_overhead_pct: null } }));
  assert.match(value(measured, "cost").detail, /平均采纳等待 0 回合/);
  assert.match(value(measured, "cost").detail, /Token 成本未计量/);
});

test("reported adoption contexts are not substituted for actual contexts", () => {
  const result = resolveEndingInsights(card({ metrics: { attack1: metric({ contexts_before_adoption: undefined, reported_contexts_before_adoption: 9 }), attack2: metric() } }));
  assert.equal(result.attacks[0].contextsBeforeAdoption, null);
});

test("all six ending names preserve identical observations rather than reclassifying metrics", () => {
  const expected = resolveEndingInsights(card());
  for (const name of ["慎信部落", "敲锣部落", "走远部落", "胆小部落", "健忘部落", "糊涂部落"]) {
    assert.deepEqual(resolveEndingInsights(card({ name })), expected);
  }
});

test("inputs remain immutable and sparse runtime cards do not throw", () => {
  const input = freeze(card());
  assert.doesNotThrow(() => resolveEndingInsights(input));
  const sparse = resolveEndingInsights({ name: "旧卡" });
  assert.equal(sparse.attacks.length, 2);
  assert.equal(sparse.comparisons[0].delta, null);
});

if (process.env.CASE_QA_BASE) test("isolated QA card exposes actual timeline and distinct repaired/prevented outcomes", async () => {
  assert.equal(process.env.CASE_QA_BASE, "http://127.0.0.1:8782", "Only the isolated QA GET service is allowed");
  const response = await fetch(`${process.env.CASE_QA_BASE}/api/state`);
  assert.equal(response.ok, true);
  const state = await response.json();
  assert.ok(state.paradigm, "QA should already be complete; this test never advances it");
  const result = resolveEndingInsights(state.paradigm);
  assert.equal(result.attacks[0].status, "REPAIRED");
  assert.equal(result.attacks[1].status, "PREVENTED");
  assert.ok(result.attacks.every(item => item.points.every(row => row.elapsedTurns === null || row.elapsedTurns >= 0)));
  assert.equal(point(result, 1, "injected").turn, state.paradigm.metrics.attack1.injected_turn);
  assert.equal(point(result, 2, "resolved").turn, state.paradigm.metrics.attack2.resolved_turn);
});

const chronology = (number, update = {}) => ({ incident_id: `I${number}`, attack_number: number,
  injected_turn: number === 1 ? 33 : 72, first_counterexample_turn: number === 1 ? 52 : 76,
  detected_turn: number === 1 ? 52 : 129, resolved_turn: number === 1 ? 72 : null,
  status: number === 1 ? "REPAIRED" : "INVESTIGATING", source_confirmed: false,
  investigation_task_id: `T${number}`, evidence: [], ...update });
const closure = (status, extra = {}) => ({ status, title: "Backend title", reason: "两案保留独立的处理与追源记录。",
  can_continue: false, observation_complete: true, pending_incident_ids: [], continuation_count: 0, ...extra });

test("B chronology separates raw counterexample, formal discovery and unresolved cutoff", () => {
  const result = resolveEndingInsights(card({ completed_turn: 132, caseChronology: [chronology(1), chronology(2)], b_outcome: closure("unresolved") }));
  assert.deepEqual([point(result, 2, "counterexample").turn, point(result, 2, "counterexample").elapsedTurns], [76, 4]);
  assert.deepEqual([point(result, 2, "discovery").turn, point(result, 2, "discovery").elapsedTurns], [129, 57]);
  assert.equal(point(result, 2, "resolved").turn, null);
  assert.equal(result.outcome.title, "调查未竟");
  assert.ok(result.gaps.includes("第二案：调查尚未完成。"));
});

test("new null discovery cannot be backfilled from old relative metric or sample", () => {
  const result = resolveEndingInsights(card({ completed_turn: 132, caseChronology: [chronology(1, { detected_turn: null })] }));
  assert.equal(point(result, 1, "discovery").turn, null);
  assert.equal(point(result, 1, "discovery").elapsedTurns, null);
  assert.equal(point(result, 1, "counterexample").turn, 52);
});

test("new historical or future samples cannot turn into a negative or future discovery", () => {
  const result = resolveEndingInsights(card({ completed_turn: 132, caseChronology: [chronology(1, { first_counterexample_turn: 20, detected_turn: 999, resolved_turn: 999 })] }));
  assert.equal(point(result, 1, "counterexample").basis, "historical");
  assert.equal(point(result, 1, "counterexample").elapsedTurns, null);
  assert.equal(point(result, 1, "discovery").turn, null);
  assert.equal(point(result, 1, "resolved").turn, null);
});

test("success needs both repaired cases and both confirmed sources", () => {
  const confirmed = [chronology(1, { source_confirmed: true }), chronology(2, { status: "REPAIRED", resolved_turn: 131, source_confirmed: true })];
  const ready = card({ completed_turn: 132, caseChronology: confirmed, b_outcome: closure("success") });
  assert.equal(resolveEndingInsights(ready).outcome.title, "真相已查明");
  assert.deepEqual(resolveEndingInsights(ready).gaps, []);
  for (const changed of [{ source_confirmed: false }, { status: "PREVENTED" }, { status: "REVOKED" }]) {
    const result = resolveEndingInsights({ ...ready, caseChronology: [confirmed[0], { ...confirmed[1], ...changed }] });
    assert.notEqual(result.outcome.status, "success");
    assert.ok(result.gaps.length > 0);
  }
});

test("historical stage and current rule judgment remain independent", () => {
  const result = resolveEndingInsights(card({ memberCognition: [{ agentId: "A1", stage: 4, name: "引路者" }], memberFeedback: {
    A1: { state: "misaligned", label: "source label", reason: "已收到反例仍在传播旧规则。", since_turn: 70, ruleIds: ["B1"], methodLabel: "协调修正传知", stage: 4 },
  } }));
  assert.equal(result.growth[0].stage, 4);
  assert.equal(result.growth[0].feedback.label, "判断失准");
  assert.equal(result.growth[1].stage, null);
  assert.equal(result.growth[1].feedback, null);
});

test("legacy censored cards never present a tribe category as a success result", () => {
  const result = resolveEndingInsights(card({ name: "糊涂部落", metrics: { attack1: metric(), attack2: metric({ status: "INVESTIGATING", censored: true }) } }));
  assert.equal(result.outcome.title, "调查未竟");
  assert.equal(result.attacks[1].sourceConfirmed, null);
  assert.equal(result.growth.every(member => member.feedback === null), true);
});

test("source confirmation has its own frozen turn and does not reuse resolution time", () => {
  const input = card({ completed_turn: 132, caseChronology: [chronology(1, { source_confirmed: true, source_confirmed_turn: 80 })] });
  const source = point(resolveEndingInsights(input), 1, "source");
  assert.deepEqual([source.turn, source.elapsedTurns], [80, 47]);
  for (const timestamp of [undefined, null, 32, 133, -1]) {
    const result = resolveEndingInsights({ ...input, caseChronology: [chronology(1, { source_confirmed: true, source_confirmed_turn: timestamp })] });
    assert.equal(result.attacks[0].sourceConfirmed, true);
    assert.equal(point(result, 1, "source").turn, null);
  }
  const unconfirmed = resolveEndingInsights({ ...input, caseChronology: [chronology(1, { source_confirmed: false, source_confirmed_turn: 80 })] });
  assert.equal(point(unconfirmed, 1, "source").turn, null);
});
