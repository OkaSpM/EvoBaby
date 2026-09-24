import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "frontend-b/package.json"));
const { buildSync } = require("esbuild");
async function load(file) {
  const built = buildSync({ entryPoints: [path.join(root, file)], bundle: true, write: false,
    platform: "node", format: "esm", target: "es2022", logLevel: "silent" });
  return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString("base64")}`);
}
const { resolveCaseFiles, caseTraceIds } = await load("frontend-b/src/case-file.ts");
const { createCaseTraceLoader } = await load("frontend-b/src/use-case-file.ts");

const incident = (update = {}) => ({ id: "I1", attackNumber: 1, status: "INVESTIGATING", injectedTurn: 3,
  detectedTurn: 5, disputedTurn: 5, resolvedTurn: null, investigationTaskId: "T1", targetAgentId: null,
  rootBeliefId: null, replacementBeliefId: null, evidenceByContext: [], lineage: [], ...update });
const task = (update = {}) => ({ id: "T1", type: "INVESTIGATION", created_turn: 5, updated_turn: 10,
  belief_id: "B1", evidence_ids: [], ...update });
const state = (update = {}) => ({ simulation: { turn: 20, seed: 42 }, tasks: [task()], incidents: [incident()],
  collectiveKnowledge: [], recentEvents: [], ...update });
const belief = (id = "B1", update = {}) => ({ id, type: "CONDITIONAL_EFFECT", object: "Moss",
  conditions: { region: null, weather: "Rain" }, expected_effect: "ENERGY_POSITIVE", created_turn: 3, ...update });
const publicSample = (id = "EV1", update = {}) => ({ evidenceId: id, agentId: "A1", region: "SE", weather: "Rain", outcome: "COUNTEREXAMPLE", ...update });
function trace(id = "B1", sampleOverrides = {}, options = {}) {
  const sample = { id: "EV1", kind: "ACTION_EFFECT", event_ids: ["E1"], turn: 8, agent_id: "A1",
    position: [5, 5], region: "SE", weather: "Rain", object: "Moss", observed_object: "Moss", action: "USE_MOSS", energy_delta: -8, ...sampleOverrides };
  const receipt = { kind: "event", event_id: "E1", type: "ACTION_EXECUTED", turn: sample.turn, agent_id: sample.agent_id,
    result: { turn: sample.turn, agent_id: sample.agent_id, position: sample.position, region: sample.region,
      weather: sample.weather, object: sample.object, action: sample.action, success: true,
      energy_before: 60, energy_after: 60 + sample.energy_delta - 1, action_cost: 1, resource_effect: sample.energy_delta } };
  return { targetId: id, records: [
    { id, content: "A claim", declaredRefs: [sample.id], parentIds: [], suggestedEvidence: [], details: { kind: "belief", belief: belief(id, { evidence_ids: [sample.id] }) } },
    { id: sample.id, content: "A sample", declaredRefs: ["E1"], parentIds: [], suggestedEvidence: [], details: sample },
    { id: "E1", content: "Action receipt", declaredRefs: [], parentIds: [], suggestedEvidence: [], details: receipt },
  ], lines: { transmitted: [], declared: [{ from: sample.id, to: id }, { from: "E1", to: sample.id }], discovered: [] },
  missingParentIds: [], truncated: false, ...options };
}
const resolve = (snapshot = state(), traces = {}, options = {}) => resolveCaseFiles(snapshot, { traces, ...options })[0];
const confirmedState = (update = {}) => state({ incidents: [incident({ rootBeliefId: "B1", targetAgentId: "A1" })],
  trace_game: { rounds: [{ incident_id: "I1", result: { correct: true } }] }, ...update });
const step = (view, id) => view.steps.find(item => item.id === id);
function freeze(value) { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }

test("no incident and future incidents produce no cases", () => {
  assert.deepEqual(resolveCaseFiles(state({ incidents: [] })), []);
  assert.deepEqual(resolveCaseFiles(state({ incidents: [incident({ injectedTurn: 21 })] })), []);
});

test("an injected case does not invent detection, source, subject or evidence", () => {
  const snapshot = state({ tasks: [], incidents: [incident({ status: "INJECTED", detectedTurn: null, disputedTurn: null, investigationTaskId: null })] });
  const value = resolve(snapshot);
  assert.equal(value.sourceConfirmed, false);
  assert.equal(value.origin, null);
  assert.equal(value.subject, null);
  assert.equal(value.firstCounterexample, null);
  assert.equal(value.earliestVerifiedCounterexample, null);
  assert.deepEqual(value.evidence, []);
  assert.deepEqual(caseTraceIds(snapshot, snapshot.incidents[0]), []);
});

test("a public D2 alert records its own turn without inventing a checked receipt", () => {
  const value = resolve(state({ awaiting_choice: { point: "D2", turn: 6, evidence_ids: ["EV_MISSING"] } }));
  assert.equal(value.discovery.turn, 6);
  assert.equal(value.discovery.elapsedTurns, 3);
  assert.equal(value.discovery.basis, "choice-alert");
  assert.deepEqual(value.discovery.evidenceIds, ["EV_MISSING"]);
  assert.equal(value.firstCounterexample, null);
  assert.equal(value.discovery.disputedTurn, 5);
});

test("public detection and dispute retain separate times", () => {
  const value = resolve(state({ incidents: [incident({ detectedTurn: 6, disputedTurn: 9 })] }));
  assert.equal(value.discovery.turn, 6);
  assert.equal(value.discovery.elapsedTurns, 3);
  assert.equal(value.discovery.basis, "incident-detected");
  assert.equal(value.discovery.disputedTurn, 9);
  assert.equal(value.discovery.disputedElapsedTurns, 6);
  assert.match(value.discovery.detail, /不一定是第一条异常行动/);
});

test("negative discovery duration becomes historical evidence time, not a discovery", () => {
  const value = resolve(state({ incidents: [incident({ injectedTurn: 10, detectedTurn: 4, disputedTurn: 13 })] }));
  assert.equal(value.discovery.turn, null);
  assert.equal(value.discovery.elapsedTurns, null);
  assert.equal(value.discovery.basis, "historical-evidence");
  assert.equal(value.discovery.historicalEvidenceTurn, 4);
  assert.equal(value.discovery.disputedTurn, 13);
  assert.equal(value.discovery.disputedElapsedTurns, 3);
});

test("future detection and dispute cannot contaminate replay", () => {
  const value = resolve(state({ simulation: { turn: 7, seed: 42 }, incidents: [incident({ detectedTurn: 8, disputedTurn: 9 })],
    awaiting_choice: { point: "D2", turn: 10, evidence_ids: ["EV_FUTURE"] } }), {}, { replaying: true });
  assert.equal(value.discovery.turn, null);
  assert.equal(value.discovery.disputedTurn, null);
  assert.equal(value.discovery.basis, "unrecorded");
  assert.deepEqual(value.discovery.evidenceIds, []);
});

test("missing discovery is not inferred from a dispute or a verified sample", () => {
  const value = resolve(state({ incidents: [incident({ detectedTurn: null, disputedTurn: 9, evidenceByContext: [publicSample()] })] }), { B1: trace() });
  assert.equal(value.evidence[0].turn, 8);
  assert.equal(value.discovery.turn, null);
  assert.equal(value.discovery.disputedTurn, 9);
  assert.equal(value.discovery.basis, "unrecorded");
});

test("zero-turn discovery is valid and D2 first-attack alert does not label a second attack", () => {
  const value = resolve(state({ incidents: [incident({ attackNumber: 2, detectedTurn: 3, disputedTurn: null })],
    awaiting_choice: { point: "D2", turn: 9, evidence_ids: ["EV1"] } }));
  assert.equal(value.discovery.turn, 3);
  assert.equal(value.discovery.elapsedTurns, 0);
  assert.equal(value.discovery.basis, "incident-detected");
  assert.deepEqual(value.discovery.evidenceIds, []);
});

test("ordinary same-resource negative actions are not attributed to this case", () => {
  const value = resolve(state({ recentEvents: [{ event_id: "E7", turn: 8, agent_id: "A4", type: "ACTION_EXECUTED",
    result: { action: "USE_MOSS", resource_effect: -8 } }] }));
  assert.deepEqual(value.evidence, []);
  assert.equal(value.firstCounterexample, null);
});

test("public contextual evidence stays undated until its actual receipt is checked", () => {
  const value = resolve(state({ incidents: [incident({ evidenceByContext: [publicSample()] })] }));
  assert.equal(value.evidence.length, 1);
  assert.equal(value.evidence[0].turn, null);
  assert.equal(value.evidence[0].delta, null);
  assert.equal(value.evidence[0].receiptVerified, false);
  assert.equal(value.earliestVerifiedCounterexample, null);
  assert.match(value.limitations.join(" "), /原始行动回执/);
});

test("receipt matching verifies real actor, action, conditions, coordinates, turn and energy", () => {
  const value = resolve(state({ incidents: [incident({ evidenceByContext: [publicSample()] })] }), { B1: trace() });
  assert.equal(value.evidence[0].receiptVerified, true);
  assert.equal(value.evidence[0].turn, 8);
  assert.equal(value.evidence[0].delta, -8);
  assert.equal(value.earliestVerifiedCounterexample.id, "EV1");
  assert.equal(value.firstCounterexample, null);
  assert.match(step(value, "counterexample").detail, /不冒称首次发现/);
});

test("a declared citation alone does not become a case experiment", () => {
  const value = resolve(state(), { B1: trace() });
  assert.deepEqual(value.evidence, []);
  assert.equal(value.earliestVerifiedCounterexample, null);
});

test("missing action receipt leaves a linked sample unverified even if its claimed energy is negative", () => {
  const data = trace(); data.records.pop();
  const value = resolve(state({ incidents: [incident({ evidenceByContext: [publicSample()] })] }), { B1: data });
  assert.equal(value.evidence[0].receiptVerified, false);
  assert.equal(value.evidence[0].delta, null);
});

test("mismatched physical receipt fields cannot validate a sample", () => {
  const mutations = [
    item => { item.agent_id = "A2"; }, item => { item.turn = 9; }, item => { item.result.agent_id = "A2"; },
    item => { item.result.region = "NW"; }, item => { item.result.weather = "Sunny"; },
    item => { item.result.resource_effect = 20; }, item => { item.result.success = false; },
    item => { item.result.action = "INSPECT"; }, item => { item.result.energy_after += 1; },
    item => { item.result.position = [2, 2]; },
  ];
  for (const mutate of mutations) {
    const data = trace(); mutate(data.records[2].details);
    const value = resolve(state({ incidents: [incident({ evidenceByContext: [publicSample()] })] }), { B1: data });
    assert.equal(value.evidence[0].receiptVerified, false);
  }
});

test("energy ceilings and exhaustion keep the observed delta instead of the nominal resource effect", () => {
  const capped = trace("B1", { region: "NW", energy_delta: 5 });
  Object.assign(capped.records[2].details.result, { energy_before: 95, energy_after: 100, action_cost: 0, resource_effect: 20 });
  const positive = resolve(state({ incidents: [incident({ evidenceByContext: [publicSample("EV1", { region: "NW", outcome: "SUPPORT" })] })] }), { B1: capped });
  assert.equal(positive.evidence[0].receiptVerified, true);
  assert.equal(positive.evidence[0].delta, 5);
  const exhausted = trace("B1", { energy_delta: -5 });
  Object.assign(exhausted.records[2].details.result, { energy_before: 5, energy_after: 0, action_cost: 0, resource_effect: -8 });
  const negative = resolve(state({ incidents: [incident({ evidenceByContext: [publicSample()] })] }), { B1: exhausted });
  assert.equal(negative.evidence[0].receiptVerified, true);
  assert.equal(negative.evidence[0].delta, -5);
});

test("only explicit discovered links to this case subject admit extra evidence", () => {
  const data = trace(); data.lines.discovered.push({ from: "EV1", to: "B99", outcome: "COUNTEREXAMPLE" });
  assert.deepEqual(resolve(state(), { B1: data }).evidence, []);
  data.lines.discovered[0].to = "B1";
  assert.equal(resolve(state(), { B1: data }).evidence[0].receiptVerified, true);
});

test("D2's explicit first evidence ID must also have a verified matching case receipt", () => {
  const snapshot = confirmedState({ awaiting_choice: { point: "D2", evidence_ids: ["EV1"] } });
  const value = resolve(snapshot, { B1: trace() });
  assert.equal(value.firstCounterexample.id, "EV1");
  assert.equal(step(value, "counterexample").label, "首次关联反例");
  const data = trace(); data.records.pop();
  assert.equal(resolve(snapshot, { B1: data }).firstCounterexample, null);
  const unrelated = trace("B1", { weather: "Sunny" });
  assert.equal(resolve(snapshot, { B1: unrelated }).firstCounterexample, null);
});

test("the earliest checked investigation example is not assumed to be the detection event", () => {
  const snapshot = state({ incidents: [incident({ detectedTurn: 5, disputedTurn: 5, evidenceByContext: [publicSample()] })] });
  const value = resolve(snapshot, { B1: trace() });
  assert.equal(value.firstCounterexample, null);
  assert.equal(value.earliestVerifiedCounterexample.turn, 8);
  assert.equal(step(value, "counterexample").turn, 8);
});

test("future samples are excluded while checked older samples remain explicitly historical", () => {
  const snapshot = state({ incidents: [incident({ evidenceByContext: [publicSample()] })] });
  assert.deepEqual(resolve(snapshot, { B1: trace("B1", { turn: 21 }) }).evidence, []);
  const value = resolve(snapshot, { B1: trace("B1", { turn: 2 }) });
  assert.equal(value.evidence[0].timing, "historical");
  assert.equal(value.firstCounterexample, null);
  assert.equal(step(value, "counterexample").label, "既有反例对照");
  assert.match(value.limitations.join(" "), /不是本轮新实验/);
});

test("the associated investigation belief takes priority over an independently confirmed source", () => {
  const snapshot = confirmedState({ tasks: [task({ belief_id: "B56", evidence_ids: ["EV1"] })] });
  const value = resolve(snapshot, { B56: trace("B56"), B1: trace("B1") });
  assert.deepEqual(caseTraceIds(snapshot, snapshot.incidents[0]), ["B56"]);
  assert.equal(value.subject.id, "B56");
  assert.equal(value.origin.beliefId, "B1");
  assert.equal(value.evidence[0].receiptVerified, true);
  assert.equal(value.evidence[0].basis, "investigation");
  assert.match(value.limitations.join(" "), /编号不同/);
});

test("a prevented case may reuse a checked direct historical reference, never an unsupported declaration", () => {
  const snapshot = confirmedState({ tasks: [], incidents: [incident({ status: "PREVENTED", injectedTurn: 10, resolvedTurn: 18,
    rootBeliefId: "B1", targetAgentId: "A1", investigationTaskId: null })] });
  const data = trace("B1", { turn: 8 });
  const value = resolve(snapshot, { B1: data });
  assert.equal(value.evidence[0].basis, "belief-reference");
  assert.equal(value.evidence[0].timing, "historical");
  assert.equal(value.evidence[0].delta, -8);
  assert.equal(value.firstCounterexample, null);
  data.records.pop();
  assert.deepEqual(resolve(snapshot, { B1: data }).evidence, []);
});

test("direct reference fallback needs agreement between belief, edge and actual receipt", () => {
  const snapshot = confirmedState({ tasks: [] });
  for (const remove of [data => { data.records[0].details.belief.evidence_ids = []; },
    data => { data.records[0].declaredRefs = []; }, data => { data.lines.declared = []; }]) {
    const data = trace(); remove(data);
    assert.deepEqual(resolve(snapshot, { B1: data }).evidence, []);
  }
});

test("replay never enriches old evidence from a current trace response", () => {
  const snapshot = state({ incidents: [incident({ evidenceByContext: [publicSample()] })] });
  const value = resolve(snapshot, { B1: trace() }, { replaying: true });
  assert.equal(value.evidence[0].turn, null);
  assert.equal(value.evidence[0].delta, null);
  assert.equal(value.earliestVerifiedCounterexample, null);
  assert.match(value.limitations.join(" "), /回放只使用当时快照/);
});

test("debug truth IDs without a correct accusation never reveal origin or request root traces", () => {
  const snapshot = state({ incidents: [incident({ rootBeliefId: "SECRET_ROOT", targetAgentId: "A4", replacementBeliefId: "SECRET_REPAIR",
    lineage: [{ senderAgentId: "A4", parentBeliefId: "SECRET_ROOT", receiverAgentId: "A5", childBeliefId: "B44" }] })] });
  const value = resolve(snapshot, { SECRET_ROOT: trace("SECRET_ROOT") });
  assert.equal(value.sourceConfirmed, false);
  assert.equal(value.origin, null);
  assert.deepEqual(value.lineage, []);
  assert.deepEqual(caseTraceIds(snapshot, snapshot.incidents[0]), ["B1"]);
  assert.ok(!JSON.stringify(value).includes("SECRET"));
});

test("correct results reveal only their own incident with both public origin fields present", () => {
  const snapshot = confirmedState({ incidents: [incident({ rootBeliefId: "B1", targetAgentId: "A1",
    lineage: [{ senderAgentId: "A1", parentBeliefId: "B1", receiverAgentId: "A2", childBeliefId: "B2" }] }),
    incident({ id: "I2", attackNumber: 2, rootBeliefId: "B3", targetAgentId: "A3", injectedTurn: 15 })] });
  const values = resolveCaseFiles(snapshot);
  assert.deepEqual(values[0].origin, { agentId: "A1", beliefId: "B1" });
  assert.equal(values[0].lineage.length, 1);
  assert.equal(values[1].origin, null);
  snapshot.incidents[0].targetAgentId = null;
  assert.equal(resolve(snapshot).sourceConfirmed, false);
});

test("wrong accusations do not confirm a source", () => {
  const snapshot = confirmedState({ trace_game: { current: { incident_id: "I1", result: { correct: false } } } });
  assert.equal(resolve(snapshot).sourceConfirmed, false);
});

test("repair, revocation, prevention and unresolved states retain distinct conclusions", () => {
  const expected = { REPAIRED: "规则已修正", REVOKED: "旧说法已撤回", PREVENTED: "采纳前已阻止", INVESTIGATING: "正在对照调查" };
  for (const [status, label] of Object.entries(expected)) {
    const value = resolve(state({ incidents: [incident({ status, resolvedTurn: status === "INVESTIGATING" ? null : 18 })] }));
    assert.equal(value.statusLabel, label);
    assert.equal(step(value, "resolution").state, status === "INVESTIGATING" ? "pending" : "done");
    if (status === "REVOKED") assert.match(value.summary, /没有据此查出/);
    if (status === "PREVENTED") assert.match(value.summary, /没有经历先传播再修复/);
  }
});

test("future or missing resolution dates cannot claim a completed repair", () => {
  for (const resolvedTurn of [null, 21]) {
    const value = resolve(state({ incidents: [incident({ status: "REPAIRED", resolvedTurn })] }));
    assert.notEqual(value.status, "REPAIRED");
    assert.equal(value.resolvedTurn, null);
    assert.equal(value.replacement, null);
  }
});

test("before and after rules require explicit public IDs and never infer the hidden world rule", () => {
  const snapshot = confirmedState({ incidents: [incident({ status: "REPAIRED", resolvedTurn: 18,
    rootBeliefId: "B1", targetAgentId: "A1", replacementBeliefId: "B2" })] });
  const replacement = trace("B2"); replacement.records[0].details.belief = belief("B2", { created_turn: 18, conditions: { region: "NW", weather: "Rain" } });
  const value = resolve(snapshot, { B1: trace(), B2: replacement });
  assert.deepEqual(caseTraceIds(snapshot, snapshot.incidents[0]), ["B1", "B2"]);
  assert.match(value.subject.title, /雨天/);
  assert.ok(!value.subject.title.includes("西北"));
  assert.match(value.replacement.title, /西北区 \/ 雨天/);
  snapshot.incidents[0].replacementBeliefId = null;
  assert.equal(resolve(snapshot, { B2: replacement }).replacement, null);
});

test("participants aggregate only associated evidence and deduplicate IDs", () => {
  const value = resolve(state({ incidents: [incident({ evidenceByContext: [publicSample(), publicSample(),
    publicSample("EV2", { agentId: "A2", region: "NW", outcome: "SUPPORT" })] })] }));
  assert.equal(value.evidence.length, 2);
  assert.deepEqual(value.participants, [
    { agentId: "A1", evidenceCount: 1, supportCount: 0, counterexampleCount: 1 },
    { agentId: "A2", evidenceCount: 1, supportCount: 1, counterexampleCount: 0 },
  ]);
  assert.equal(step(value, "verification").state, "done");
});

test("hidden metadata and forged markers do not drive attribution or receipt checking", () => {
  const snapshot = state({ incidents: [incident({ evidenceByContext: [publicSample()] })] });
  const data = trace(), value = resolve(snapshot, { B1: data });
  Object.assign(data.records[1].details, { forged: true, origin_type: "CORRUPTION", truth: "secret" });
  Object.assign(snapshot.incidents[0], { targetAgentId: "A5", rootBeliefId: "SECRET", omittedCondition: "weather", affectedAgentIds: ["A5"] });
  assert.deepEqual(resolve(snapshot, { B1: data }), value);
});

test("unrequested or mismatched trace targets cannot supply evidence", () => {
  const snapshot = state({ incidents: [incident({ evidenceByContext: [publicSample()] })] });
  assert.equal(resolve(snapshot, { B9: trace("B9") }).evidence[0].receiptVerified, false);
  assert.equal(resolve(snapshot, { B1: trace("B9") }).evidence[0].receiptVerified, false);
});

test("the pure resolver does not mutate inputs and resets without retained cases", () => {
  const snapshot = freeze(state({ incidents: [incident({ evidenceByContext: [publicSample()] })] })), data = freeze(trace());
  const before = JSON.stringify(snapshot);
  resolve(snapshot, { B1: data });
  assert.equal(JSON.stringify(snapshot), before);
  assert.deepEqual(resolveCaseFiles(state({ incidents: [], tasks: [] })), []);
});

test("trace loader caps a request at two IDs and reuses unchanged public revisions", async () => {
  const calls = [];
  const loader = createCaseTraceLoader(async id => { calls.push(id); return trace(id); });
  await loader.load("42:0", "revision1", ["B1", "B2", "B3"]);
  await loader.load("42:0", "revision1", ["B1", "B2"]);
  assert.deepEqual(calls, ["B1", "B2"]);
  await loader.load("42:0", "revision1", ["B1"], true);
  assert.deepEqual(calls, ["B1", "B2", "B1"]);
});

test("a delayed previous case response cannot win over the newly selected case", async () => {
  let finish;
  const loader = createCaseTraceLoader(id => id === "B1" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(trace(id)));
  const old = loader.load("42:0", "old", ["B1"]);
  const current = await loader.load("42:0", "new", ["B2"]);
  finish(trace("B1"));
  assert.equal(await old, null);
  assert.deepEqual(Object.keys(current.traces), ["B2"]);
});

test("seed or reset scope changes invalidate in-flight results and cached traces", async () => {
  let finish;
  const loader = createCaseTraceLoader(id => new Promise(resolve => { finish = resolve; }));
  const old = loader.load("42:0", "r1", ["B1"]);
  loader.clear();
  finish(trace());
  assert.equal(await old, null);
  const calls = [];
  const cache = createCaseTraceLoader(async id => { calls.push(id); return trace(id); });
  await cache.load("42:0", "same", ["B1"]);
  await cache.load("43:1", "same", ["B1"]);
  assert.equal(calls.length, 2);
});

test("trace failures remain explicit and retries are user-driven", async () => {
  let count = 0;
  const loader = createCaseTraceLoader(async id => { count += 1; if (count === 1) throw new Error("offline"); return trace(id); });
  const failed = await loader.load("42:0", "r1", ["B1"]);
  assert.match(failed.error, /可重试/);
  assert.deepEqual(failed.traces, {});
  assert.equal(count, 1);
  assert.equal((await loader.load("42:0", "r1", ["B1"], true)).error, null);
  assert.equal(count, 2);
});

test("trace cache is finite and wrong-target responses are rejected", async () => {
  const calls = [];
  const loader = createCaseTraceLoader(async id => { calls.push(id); return trace(id); });
  for (let index = 0; index < 10; index += 1) await loader.load("42:0", `r${index}`, ["B1"]);
  await loader.load("42:0", "r0", ["B1"]);
  assert.equal(calls.length, 11);
  const wrong = createCaseTraceLoader(async () => trace("B2"));
  assert.ok((await wrong.load("42:0", "r1", ["B1"])).error);
});

if (process.env.CASE_QA_BASE) {
  test("isolated real backend projection resolves investigation and prevention receipts without truth APIs", async () => {
    assert.equal(process.env.CASE_QA_BASE, "http://127.0.0.1:8782", "Only the temporary QA server is allowed");
    const read = async url => {
      const response = await fetch(`${process.env.CASE_QA_BASE}${url}`);
      assert.equal(response.status, 200);
      return response.json();
    };
    const snapshot = await read("/api/state");
    const traces = {};
    for (const item of snapshot.incidents) for (const id of caseTraceIds(snapshot, item)) {
      traces[id] = await read(`/api/beliefs/${encodeURIComponent(id)}/trace`);
    }
    const values = resolveCaseFiles(snapshot, { traces });
    const repaired = values.find(item => item.status === "REPAIRED");
    assert.ok(repaired);
    assert.equal(repaired.subject.id, "B56");
    assert.notEqual(repaired.origin.beliefId, repaired.subject.id);
    assert.equal(repaired.evidence.length, 6);
    assert.equal(repaired.participants.length, 4);
    assert.ok(repaired.evidence.every(item => item.receiptVerified && item.basis === "investigation"));
    const prevented = values.find(item => item.status === "PREVENTED");
    assert.ok(prevented);
    assert.ok(prevented.evidence.some(item => item.outcome === "COUNTEREXAMPLE" && item.receiptVerified));
    assert.ok(prevented.evidence.every(item => item.receiptVerified && item.basis === "belief-reference"));
    assert.equal(prevented.firstCounterexample, null);
  });
}
