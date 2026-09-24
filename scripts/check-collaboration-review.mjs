import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "frontend-b/package.json"));
const { buildSync } = require("esbuild");
const built = buildSync({ entryPoints: [path.join(root, "frontend-b/src/collaboration-review.ts")], bundle: true,
  write: false, platform: "node", format: "esm", target: "es2022", logLevel: "silent" });
const { resolveCollaborationReview: resolve } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString("base64")}`);
const caseBuilt = buildSync({ entryPoints: [path.join(root, "frontend-b/src/case-file.ts")], bundle: true,
  write: false, platform: "node", format: "esm", target: "es2022", logLevel: "silent" });
const { resolveCaseFiles } = await import(`data:text/javascript;base64,${Buffer.from(caseBuilt.outputFiles[0].contents).toString("base64")}`);

const sample = (id = "EV1", overrides = {}) => ({ id, agentId: "A1", turn: 12, region: "SW", weather: "Rain",
  delta: -8, outcome: "COUNTEREXAMPLE", receiptVerified: true, timing: "current-incident", basis: "investigation", ...overrides });
const file = (overrides = {}) => ({ id: "I1", attackNumber: 1, status: "INVESTIGATING", statusLabel: "正在对照调查",
  injectedTurn: 10, resolvedTurn: null, sourceConfirmed: false, subject: { id: "B1", title: "公开规则" }, replacement: null,
  evidence: [], participants: [], origin: null, lineage: [], firstCounterexample: null, earliestVerifiedCounterexample: null,
  discovery: { turn: null, disputedTurn: null, evidenceIds: [], basis: "unrecorded" }, ...overrides });
const task = (overrides = {}) => ({ id: "T1", type: "INVESTIGATION", created_turn: 15, updated_turn: 19,
  belief_id: "B1", claimant_agent_ids: ["A1", "A2"], required_contexts: [{ id: "C1" }, { id: "C2" }],
  completed_context_ids: ["C1"], ...overrides });
const state = (overrides = {}) => ({ simulation: { turn: 30 }, agents: [], tasks: [], collectiveKnowledge: [], choices: {},
  incidents: [{ id: "I1", investigationTaskId: "T1" }], trace_game: { current: { incident_id: "I1" } }, ...overrides });
const snapshot = (overrides = {}) => ({ incident_id: "I1", attack_number: 1, injected_turn: 10,
  first_counterexample_turn: 12, detected_turn: 15, resolved_turn: null, status: "INVESTIGATING",
  source_confirmed: false, investigation_task_id: "T1", evidence: [{ id: "EV20", agent_id: "A2", turn: 12,
    region: "SW", weather: "Rain", outcome: "COUNTEREXAMPLE", energy_delta: -8, receipt_verified: true }], ...overrides });
const step = (view, id) => view.steps.find(item => item.id === id);
const rule = (view, id) => view.rules.find(item => item.id === id);

test("before injection no public review is manufactured", () => {
  assert.equal(resolve(state({ simulation: { turn: 9 } }), file()), null);
});

test("no evidence, elapsed turns, or finished observation does not mean solved", () => {
  const value = resolve(state({ simulation: { turn: 1000 }, merged_game: { complete: true } }), file());
  assert.equal(value.status, "open");
  assert.equal(step(value, "repair").state, "pending");
  assert.equal(step(value, "trace").state, "pending");
  assert.equal(value.evidence.verified, 0);
});

test("case-linked receipts are deduplicated by ID, not multiplied by shares", () => {
  const receipt = sample();
  const value = resolve(state(), file({ evidence: [receipt, { ...receipt }, { ...receipt }] }));
  assert.equal(value.evidence.verified, 1);
  assert.equal(value.evidence.people, 1);
  assert.equal(value.contributions[0].counterexampleCount, 1);
  assert.match(value.limits[0], /转述三次.*一份/);
});

test("unverified receipt indexes never become dated contributions", () => {
  const value = resolve(state(), file({ evidence: [sample("EV1", { receiptVerified: false, turn: null })] }));
  assert.equal(value.evidence.unchecked, 1);
  assert.equal(value.evidence.verified, 0);
  assert.equal(value.contributions.length, 0);
  assert.equal(step(value, "observe").state, "pending");
});

test("future evidence and future task updates are not replayed into the past", () => {
  const value = resolve(state({ tasks: [task({ updated_turn: 31 })] }), file({ evidence: [sample("FUTURE", { turn: 31 })] }), { replaying: true });
  assert.equal(value.task, null);
  assert.equal(value.evidence.verified, 0);
  assert.equal(value.canInvestigate, false);
  assert.match(value.limits.join(" "), /当时快照/);
});

test("historical receipt is evidence, not a new trial or incident discovery", () => {
  const value = resolve(state(), file({ evidence: [sample("OLD", { turn: 5, timing: "historical" })] }));
  assert.equal(value.evidence.historical, 1);
  assert.equal(step(value, "observe").state, "partial");
  assert.equal(step(value, "observe").turn, null);
  assert.equal(step(value, "notice").state, "pending");
  assert.equal(value.times.discovered, null);
  assert.equal(value.times.evidenceToDispute, null);
});

test("observing a counterexample and sharing a dispute preserve distinct rounds", () => {
  const value = resolve(state({ simulation: { turn: 132 } }), file({ injectedTurn: 72,
    discovery: { turn: 129, disputedTurn: 129, evidenceIds: [] }, evidence: [sample("EV246", { turn: 76 })] }));
  assert.equal(value.times.firstCounterexample, 76);
  assert.equal(value.times.discovered, 129);
  assert.equal(value.times.disputed, 129);
  assert.equal(value.times.evidenceToDispute, 53);
  assert.equal(step(value, "notice").turn, 129);
  assert.deepEqual(step(value, "notice").agentIds, []);
  assert.equal(value.status, "open");
});

test("only explicit first evidence links identify the discoverer", () => {
  const value = resolve(state(), file({ discovery: { turn: 12, disputedTurn: 15, evidenceIds: ["EV2"] },
    evidence: [sample("EV1"), sample("EV2", { agentId: "A2" })] }));
  assert.deepEqual(step(value, "notice").agentIds, ["A2"]);
  assert.equal(step(value, "notice").evidenceCount, 1);
});

test("three contributors alone do not complete correction", () => {
  const value = resolve(state({ tasks: [task()] }), file({ evidence: [sample("EV1"),
    sample("EV2", { agentId: "A2" }), sample("EV3", { agentId: "A3" })] }));
  assert.equal(value.evidence.people, 3);
  assert.equal(step(value, "check").state, "active");
  assert.notEqual(step(value, "repair").state, "done");
});

test("reused investigation keeps its actual creation round and is not presented as a new case action", () => {
  const value = resolve(state({ simulation: { turn: 80 }, tasks: [task({ created_turn: 68, updated_turn: 80 })] }),
    file({ injectedTurn: 72, discovery: { turn: 76, disputedTurn: 76, evidenceIds: [] },
      evidence: [sample("NEW", { turn: 75 })] }));
  assert.equal(step(value, "check").label, "复用已有任务");
  assert.equal(step(value, "check").turn, 68);
  assert.match(step(value, "check").detail, /原建于第 68 回合，本案沿用/);
  assert.equal(step(value, "observe").turn, 75);
  assert.equal(step(value, "notice").turn, 76);
});

test("investigation created at or after this case remains new collaboration", () => {
  for (const created_turn of [10, 15]) {
    const value = resolve(state({ tasks: [task({ created_turn })] }), file());
    assert.equal(step(value, "check").label, "分头补证");
    assert.equal(step(value, "check").turn, created_turn);
    assert.doesNotMatch(step(value, "check").detail, /本案沿用/);
  }
});

test("repair material checklist only counts checked receipts attached to that task", () => {
  const value = resolve(state({ tasks: [task({ evidence_ids: ["EV1", "EV2", "UNVERIFIED"] })] }), file({ evidence: [sample("EV1"),
    sample("EV2", { agentId: "A2", outcome: "SUPPORT", delta: 20 }), sample("UNVERIFIED", { receiptVerified: false }),
    sample("UNRELATED", { agentId: "A3" })] }));
  assert.deepEqual(value.repairChecks.map(check => check.current), [2, 2, 1, 1]);
  assert.deepEqual(value.repairChecks.map(check => check.required), [4, 2, 1, 1]);
  assert.notEqual(step(value, "repair").state, "done");
});

test("missing task evidence list is unknown rather than zero experiments", () => {
  const value = resolve(state({ tasks: [task()] }), file({ evidence: [sample()] }));
  assert.ok(value.repairChecks.every(check => check.current === null));
});

test("repaired is not source confirmation, and identification alone is not repair", () => {
  const repaired = resolve(state(), file({ status: "REPAIRED", resolvedTurn: 20 }));
  assert.equal(repaired.status, "repaired");
  assert.equal(step(repaired, "repair").state, "done");
  assert.equal(step(repaired, "trace").state, "pending");
  const identified = resolve(state(), file({ sourceConfirmed: true }));
  assert.equal(identified.status, "open");
  assert.equal(step(identified, "trace").state, "done");
  assert.match(identified.gap, /部落完成规则处理/);
});

test("repair plus identification produces case completion without inventing attribution", () => {
  const value = resolve(state(), file({ status: "REPAIRED", resolvedTurn: 20, sourceConfirmed: true }));
  assert.equal(value.status, "complete");
  assert.equal(value.canInvestigate, false);
  assert.deepEqual(step(value, "repair").agentIds, []);
});

test("revocation and prevention retain partial outcomes instead of repair", () => {
  for (const status of ["REVOKED", "PREVENTED"]) {
    const value = resolve(state(), file({ status, resolvedTurn: 20, sourceConfirmed: true }));
    assert.equal(value.status, "contained");
    assert.equal(value.times.repaired, null);
    assert.equal(step(value, "repair").state, "partial");
  }
});

test("missing or future resolution round cannot close a case", () => {
  for (const resolvedTurn of [null, 31]) {
    const value = resolve(state(), file({ status: "REPAIRED", resolvedTurn, sourceConfirmed: true }));
    assert.equal(value.status, "open");
    assert.equal(value.times.repaired, null);
  }
});

test("unknown accusation round is not derived from elapsed seconds", () => {
  const value = resolve(state({ trace_game: { current: { incident_id: "I1", result: { correct: true, elapsed: 12 } } } }), file({ sourceConfirmed: true }));
  assert.equal(step(value, "trace").turn, null);
  const known = resolve(state({ trace_game: { rounds: [{ incident_id: "I1", result: { correct: true, turn: 25 } }] } }), file({ sourceConfirmed: true }));
  assert.equal(step(known, "trace").turn, 25);
});

test("an explicitly future accusation cannot confirm or complete a past case", () => {
  const value = resolve(state({ trace_game: { current: { incident_id: "I1", result: { correct: true, turn: 31 } } },
    merged_game: { b_review: { cases: [snapshot({ status: "REPAIRED", resolved_turn: 20, source_confirmed: true })] } } }), file());
  assert.equal(value.sourceConfirmed, false);
  assert.equal(value.status, "repaired");
  assert.equal(step(value, "trace").state, "pending");
  assert.equal(step(value, "trace").turn, null);
});

test("task progress deduplicates actual requirements and cannot exceed their count", () => {
  const value = resolve(state({ tasks: [task({ completed_context_ids: ["C1", "C1", "C99"] })] }), file());
  assert.equal(value.task.completed, 1);
  assert.equal(value.task.required, 2);
});

test("local recheck threshold counts one person's counterexamples, not a group sum", () => {
  const value = resolve(state({ choices: { D2: "B" } }), file({ evidence: [sample("EV1"), sample("EV2", { agentId: "A2" }), sample("EV3", { agentId: "A3" })] }));
  assert.match(rule(value, "D2").record, /最多 1 \/ 3/);
});

test("three-person policy reads candidate source record, not investigation participant count", () => {
  const evidence = [sample("EV1"), sample("EV2", { agentId: "A2" }), sample("EV3", { agentId: "A3" })];
  const value = resolve(state({ choices: { D3: "B" }, collectiveKnowledge: [{ id: "B1", created_turn: 10,
    updated_turn: 20, independent_agent_ids: ["A1", "A1"] }] }), file({ evidence }));
  assert.match(rule(value, "D3").record, /登记 1 \/ 3/);
  assert.match(rule(value, "D3").note, /人数满足仍不等于规则通过/);
});

test("all D2 and D3 choices have concrete requirements and nonempty observed records", () => {
  for (const option of ["A", "B", "C", "D"]) {
    const value = resolve(state({ choices: { D2: option, D3: option } }), file());
    assert.ok(value.rules.every(rule => rule.chosen && rule.name && rule.requirement && rule.record && rule.note));
  }
  assert.ok(resolve(state(), file()).rules.every(rule => !rule.chosen));
});

test("D4 changes are visible instead of falsely claiming D3 is the only gate", () => {
  for (const option of ["B", "C", "D"]) assert.match(resolve(state({ choices: { D4: option } }), file()).ruleAmendment, /追加门槛/);
  assert.equal(resolve(state({ choices: { D4: "A" } }), file()).ruleAmendment, null);
});

test("new B snapshot receipts take precedence over live-trace fallbacks during replay", () => {
  const value = resolve(state({ merged_game: { b_review: { cases: [snapshot()] } } }), file({ evidence: [sample("LIVE_ONLY")] }), { replaying: true });
  assert.deepEqual(value.contributions[0].evidenceIds, ["EV20"]);
  assert.equal(value.contributions[0].agentId, "A2");
  assert.equal(value.times.discovered, 15);
  assert.equal(value.canInvestigate, false);
});

test("a B snapshot from another injection cannot override a reused incident ID", () => {
  const value = resolve(state({ merged_game: { b_review: { cases: [snapshot({ injected_turn: 9, source_confirmed: true })] } } }), file());
  assert.equal(value.sourceConfirmed, false);
  assert.equal(value.evidence.verified, 0);
});

test("future B receipts remain absent even when unchecked", () => {
  const snap = snapshot();
  snap.evidence.push({ ...snap.evidence[0], id: "FUTURE", turn: 31, receipt_verified: false });
  const value = resolve(state({ merged_game: { b_review: { cases: [snap] } } }), file());
  assert.equal(value.evidence.unchecked, 0);
  assert.equal(value.evidence.verified, 1);
});

test("B first-counterexample basis identifies the actual author, not a same-round bystander", () => {
  const snap = snapshot();
  snap.evidence[0].basis = "first-counterexample";
  snap.evidence.push({ ...snap.evidence[0], id: "EV21", agent_id: "A3", basis: "investigation" });
  const value = resolve(state({ merged_game: { b_review: { cases: [snap] } } }), file());
  assert.deepEqual(value.counterexampleAgentIds, ["A2"]);
  assert.deepEqual(step(value, "notice").agentIds, []);
  delete snap.evidence[0].basis;
  assert.deepEqual(resolve(state({ merged_game: { b_review: { cases: [snap] } } }), file()).counterexampleAgentIds, []);
});

test("B source confirmation supports earlier case identification without revealing target", () => {
  const value = resolve(state({ trace_game: { current: { incident_id: "I2" } }, merged_game: { b_review: { cases: [snapshot()] } } }), file());
  assert.equal(value.canInvestigate, true);
  const confirmed = resolve(state({ merged_game: { b_review: { cases: [snapshot({ source_confirmed: true })] } } }), file());
  assert.equal(confirmed.sourceConfirmed, true);
  assert.equal(confirmed.canInvestigate, false);
});

test("secret roots, holders, forged tags and unrelated events do not leak into review", () => {
  const clean = state();
  const dirty = state({ incidents: [{ id: "I1", investigationTaskId: "T1", rootBeliefId: "SECRET_ROOT", targetAgentId: "SECRET_AGENT", omittedCondition: "SECRET" }],
    recentEvents: [{ turn: 11, agent_id: "A5", result: { resource_effect: -8 } }] });
  assert.deepEqual(resolve(dirty, file()), resolve(clean, file()));
  assert.ok(!JSON.stringify(resolve(dirty, file({ origin: { beliefId: "SECRET", agentId: "SECRET" } }))).includes("SECRET"));
});

test("resolver does not mutate inputs or retain previous cases", () => {
  const data = state(), item = file({ evidence: [sample()] });
  const before = JSON.stringify({ data, item });
  resolve(data, item);
  assert.equal(JSON.stringify({ data, item }), before);
  assert.equal(resolve(state(), file()).evidence.verified, 0);
});

function bCaseState(overrides = {}, chronologyOverrides = {}) {
  const chronology = snapshot(chronologyOverrides);
  chronology.evidence = chronology.evidence.map(sample => ({ ...sample, basis: "first-counterexample" }));
  return state({ incidents: [{ id: "I1", attackNumber: 1, status: "INVESTIGATING", injectedTurn: 10,
    detectedTurn: 15, disputedTurn: 15, resolvedTurn: null, investigationTaskId: "T1", targetAgentId: null,
    rootBeliefId: null, replacementBeliefId: null, evidenceByContext: [], lineage: [] }], tasks: [task()],
    merged_game: { b_review: { cases: [chronology] } }, ...overrides });
}

test("CaseBook consumes B first-counterexample receipts in historical snapshots without a live trace", () => {
  const data = bCaseState();
  const value = resolveCaseFiles(data, { replaying: true })[0];
  assert.equal(value.firstCounterexample.id, "EV20");
  assert.equal(value.firstCounterexample.agentId, "A2");
  assert.equal(value.firstCounterexample.turn, 12);
  assert.equal(value.firstCounterexample.basis, "first-counterexample");
  assert.equal(value.discovery.turn, 15);
  assert.equal(value.discovery.disputedTurn, 15);
  assert.match(value.steps.find(step => step.id === "counterexample").detail, /分别记录/);
  assert.equal(value.origin, null);
});

test("B first marker must match the declared first round and cannot designate historical or future samples", () => {
  for (const turn of [5, 14, 31]) {
    const data = bCaseState();
    data.merged_game.b_review.cases[0].evidence[0].turn = turn;
    const value = resolveCaseFiles(data, { replaying: true })[0];
    assert.equal(value.firstCounterexample, null);
    if (turn === 31) assert.equal(value.evidence.length, 0);
  }
});

test("unchecked B receipt dates remain unknown and never identify a first observer", () => {
  const data = bCaseState();
  data.merged_game.b_review.cases[0].evidence[0].receipt_verified = false;
  const value = resolveCaseFiles(data, { replaying: true })[0];
  assert.equal(value.firstCounterexample, null);
  assert.equal(value.evidence[0].turn, null);
  assert.equal(value.evidence[0].delta, null);
  assert.equal(value.evidence[0].timing, "unknown");
});

test("B evidence from a different case revision or unsupported outcome is ignored", () => {
  const data = bCaseState();
  data.merged_game.b_review.cases[0].injected_turn = 9;
  assert.deepEqual(resolveCaseFiles(data)[0].evidence, []);
  data.merged_game.b_review.cases[0].injected_turn = 10;
  data.merged_game.b_review.cases[0].evidence[0].outcome = "PRESUMED";
  assert.deepEqual(resolveCaseFiles(data)[0].evidence, []);
});

test("CaseBook cannot reveal a future successful accusation", () => {
  const data = bCaseState({ trace_game: { rounds: [{ incident_id: "I1", result: { correct: true, turn: 31 } }] } });
  data.incidents[0].rootBeliefId = "SECRET_ROOT";
  data.incidents[0].targetAgentId = "A5";
  const value = resolveCaseFiles(data, { replaying: true })[0];
  assert.equal(value.sourceConfirmed, false);
  assert.equal(value.origin, null);
  assert.ok(!JSON.stringify(value).includes("SECRET_ROOT"));
});
