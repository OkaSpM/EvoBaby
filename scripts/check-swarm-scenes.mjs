import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "frontend-b/package.json"));
const { buildSync } = require("esbuild");
const bundle = buildSync({ entryPoints: [path.join(root, "frontend-b/src/swarm-scene.ts")], bundle: true,
  write: false, platform: "node", format: "esm", target: "es2022", logLevel: "silent" });
const { resolveSwarmScene } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`);

const agents = () => Array.from({ length: 5 }, (_, index) => ({ id: `A${index + 1}`, currentTaskId: null,
  currentAction: null, unavailableUntilTurn: null, removed: false }));
const state = (update = {}) => ({ simulation: { turn: 20 }, agents: agents(), tasks: [], incidents: [], story_events: [], ...update });
const context = (id, update = {}) => ({ id, object: "Moss", conditions: { region: "NW", weather: "Rain" },
  evidence_kind: "ACTION_EFFECT", independent_of: [], ...update });
const task = (update = {}) => ({ id: "T1", type: "VERIFICATION", status: "OPEN", priority: 80,
  created_turn: 3, updated_turn: 4, description: "Check one claim", belief_id: "B1",
  required_contexts: [context("C1"), context("C2", { conditions: { region: "SE", weather: "Sunny" } })],
  claimed_contexts: [], claimant_agent_ids: [], completed_context_ids: [], evidence_ids: [], resolution: null, ...update });
const incident = (update = {}) => ({ id: "I1", status: "INVESTIGATING", attackNumber: 1, injectedTurn: 3,
  detectedTurn: 4, disputedTurn: 5, resolvedTurn: null, investigationTaskId: "T1", evidenceByContext: [], ...update });
const evidence = (id, update = {}) => ({ evidenceId: id, agentId: "A1", region: "NW", weather: "Rain", outcome: "SUPPORT", ...update });
const claim = (agent = "A1", id = "C1", turn = 6) => ({ agent_id: agent, context_id: id, claimed_turn: turn });
const step = (view, id) => view.focusTask.steps.find(item => item.id === id);
function deepFreeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}

test("empty and legacy snapshots remain neutral without invented tasks or messages", () => {
  const value = resolveSwarmScene(state());
  assert.equal(value.focusTask, null);
  assert.equal(value.latestResult, null);
  assert.deepEqual(value.tasks, []);
  assert.deepEqual(value.messages, []);
  assert.equal(value.members.length, 5);
  assert.ok(value.members.every(member => member.mode === "exploring"));
  assert.equal(value.broadcastEnabled, null);
  assert.equal(resolveSwarmScene({ simulation: { turn: 0 } }).activeTaskCount, 0);
});

test("active investigations lead, then verification and survival, priority within each type", () => {
  const value = resolveSwarmScene(state({ tasks: [
    task({ id: "V", priority: 100 }), task({ id: "S", type: "SURVIVAL", priority: 100 }),
    task({ id: "I2", type: "INVESTIGATION", priority: 90 }), task({ id: "I1", type: "INVESTIGATION", priority: 95 }),
    task({ id: "R", type: "INVESTIGATION", status: "RESOLVED", updated_turn: 19, resolution: "BELIEF_REVOKED" }),
  ] }));
  assert.deepEqual(value.tasks.map(item => item.id), ["I1", "I2", "V", "S"]);
  assert.equal(value.focusTask.id, "I1");
  assert.equal(value.latestResult.id, "R");
  assert.equal(value.activeTaskCount, 4);
});

test("without active tasks the most recent terminal result stays visible", () => {
  const value = resolveSwarmScene(state({ tasks: [task({ id: "old", status: "RESOLVED", updated_turn: 9 }),
    task({ id: "latest", status: "EXPIRED", updated_turn: 19, resolution: "INSUFFICIENT_SUPPORT" })] }));
  assert.deepEqual(value.tasks.map(item => item.id), ["latest"]);
  assert.equal(value.activeTaskCount, 0);
  assert.equal(value.focusTask.result.kind, "expired");
  assert.equal(step(value, "result").state, "attention");
});

test("an unclaimed open task has only an evidenced initiation step", () => {
  const value = resolveSwarmScene(state({ tasks: [task()] }));
  assert.deepEqual(value.focusTask.steps.map(item => item.state), ["done", "pending", "pending", "pending"]);
  assert.equal(step(value, "initiate").turn, 3);
  assert.equal(step(value, "verify").turn, null);
  assert.equal(value.focusTask.result.kind, "pending");
});

test("a genuine claim links the correct member to the exact required context", () => {
  const members = agents(); members[0].currentTaskId = "T1";
  const value = resolveSwarmScene(state({ agents: members,
    tasks: [task({ status: "CLAIMED", claimed_contexts: [claim()], claimant_agent_ids: ["A1"] })] }));
  assert.deepEqual(value.focusTask.contexts.map(item => item.claimantAgentIds), [["A1"], []]);
  assert.equal(value.members[0].mode, "task");
  assert.deepEqual(value.members[0].contextIds, ["C1"]);
  assert.equal(value.members[0].detail, "苔藓 · 西北 · 雨天");
  assert.equal(value.claimedAgentCount, 1);
  assert.equal(step(value, "verify").state, "active");
  assert.equal(step(value, "verify").turn, 6);
});

test("removed and resting members cannot be current assignees even with stale claims", () => {
  const members = agents();
  members[0] = { ...members[0], currentTaskId: "T1", removed: true };
  members[1] = { ...members[1], currentTaskId: "T1", unavailableUntilTurn: 21 };
  members[2] = { ...members[2], currentTaskId: "T1" };
  const value = resolveSwarmScene(state({ agents: members, removed_agents: ["A3"], tasks: [task({ status: "CLAIMED",
    claimed_contexts: [claim(), claim("A2"), claim("A3")], claimant_agent_ids: ["A1", "A2", "A3"] })] }));
  assert.deepEqual(value.members.slice(0, 3).map(item => item.mode), ["removed", "resting", "removed"]);
  assert.ok(value.members.slice(0, 3).every(item => item.taskId === null));
  assert.deepEqual(value.focusTask.claimantAgentIds, []);
  assert.equal(value.claimedAgentCount, 0);
});

test("members rejoin at the actual availability turn and do not adopt another member's context", () => {
  const members = agents(); members[0] = { ...members[0], currentTaskId: "T1", unavailableUntilTurn: 20 };
  const value = resolveSwarmScene(state({ agents: members, tasks: [task({ claimed_contexts: [claim("A2")] })] }));
  assert.equal(value.members[0].mode, "task");
  assert.deepEqual(value.members[0].contextIds, []);
  assert.equal(value.members[0].detail, "具体情境未记录");
});

test("old task fields preserve unknown evidence totals and do not guess claim context", () => {
  const old = task({ status: "CLAIMED", claimant_agent_ids: ["A1"] });
  delete old.claimed_contexts; delete old.evidence_ids;
  const value = resolveSwarmScene(state({ tasks: [old] }));
  assert.equal(value.focusTask.evidenceCount, null);
  assert.deepEqual(value.focusTask.claimantAgentIds, ["A1"]);
  assert.ok(value.focusTask.contexts.every(item => item.claimantAgentIds.length === 0));
  assert.match(step(value, "evidence").detail, /未记录/);
});

test("evidence is deduplicated, completed requirements are bounded, and open tasks remain unfinished", () => {
  const value = resolveSwarmScene(state({ tasks: [task({ status: "IN_PROGRESS", evidence_ids: ["E1", "E1", "E2"],
    completed_context_ids: ["C1", "C1", "missing", "C2"] })] }));
  assert.equal(value.focusTask.evidenceCount, 2);
  assert.equal(value.focusTask.completedCount, 2);
  assert.equal(step(value, "verify").state, "done");
  assert.equal(step(value, "evidence").state, "active");
  assert.equal(step(value, "result").state, "pending");
  assert.equal(value.focusTask.result.kind, "pending");
});

test("EXPIRED is never a successful completion, even when all contexts were submitted", () => {
  for (const resolution of ["INSUFFICIENT_SUPPORT", "INVESTIGATION_REQUIRED", null]) {
    const value = resolveSwarmScene(state({ tasks: [task({ status: "EXPIRED", resolution,
      completed_context_ids: ["C1", "C2"], evidence_ids: ["E1", "E2"] })] }));
    assert.equal(value.focusTask.result.kind, "expired");
    assert.equal(value.focusTask.result.tone, "warning");
    assert.equal(step(value, "result").state, "attention");
  }
});

test("revocation is distinct from actual repair", () => {
  const value = resolveSwarmScene(state({ tasks: [task({ status: "RESOLVED", resolution: "BELIEF_REVOKED" })],
    incidents: [incident({ status: "REVOKED", resolvedTurn: 18 })] }));
  assert.equal(value.focusTask.result.kind, "revoked");
  assert.equal(value.focusTask.result.label, "旧结论已撤回");
  assert.equal(step(value, "result").state, "attention");
});

test("repair requires the associated public incident's reached REPAIRED resolution", () => {
  const closed = task({ type: "INVESTIGATION", status: "RESOLVED", updated_turn: 18, resolution: "BELIEF_REPAIRED" });
  assert.equal(resolveSwarmScene(state({ tasks: [closed] })).focusTask.result.kind, "unconfirmed");
  assert.equal(resolveSwarmScene(state({ tasks: [closed], incidents: [incident({ status: "REPAIRED" })] })).focusTask.result.kind, "unconfirmed");
  const value = resolveSwarmScene(state({ tasks: [closed], incidents: [incident({ status: "REPAIRED", resolvedTurn: 18 })] }));
  assert.equal(value.focusTask.result.kind, "repaired");
  assert.equal(value.focusTask.result.turn, 18);
  assert.equal(step(value, "result").state, "done");
});

test("verification, recovery and prevention have their own literal outcomes", () => {
  assert.equal(resolveSwarmScene(state({ tasks: [task({ status: "RESOLVED", resolution: "BELIEF_VERIFIED" })] })).focusTask.result.kind, "verified");
  assert.equal(resolveSwarmScene(state({ tasks: [task({ status: "RESOLVED", resolution: "ENERGY_RECOVERED" })] })).focusTask.result.kind, "recovered");
  assert.equal(resolveSwarmScene(state({ tasks: [task({ status: "RESOLVED" })],
    incidents: [incident({ status: "PREVENTED", resolvedTurn: 18 })] })).focusTask.result.kind, "prevented");
});

test("only a focus task's associated investigation evidence is projected", () => {
  const value = resolveSwarmScene(state({ tasks: [task({ type: "INVESTIGATION" })], incidents: [
    incident({ id: "unrelated", investigationTaskId: "T9", evidenceByContext: [evidence("wrong")] }),
    incident({ evidenceByContext: [evidence("E2", { agentId: "A2", region: "SE", weather: "Sunny", outcome: "COUNTEREXAMPLE" }),
      evidence("E1"), evidence("E1")] }),
  ] }));
  assert.deepEqual(value.evidence.map(item => item.evidenceId), ["E1", "E2"]);
  assert.deepEqual(value.evidence.map(item => item.label), ["支持样本", "反例"]);
  assert.deepEqual(value.evidence, value.focusTask.evidence);
});

test("replay excludes future tasks, future task updates, future claims and future incidents", () => {
  const value = resolveSwarmScene(state({ tasks: [task({ id: "future", created_turn: 21, updated_turn: 21 }),
    task({ id: "future-change", updated_turn: 21 }), task({ status: "CLAIMED", claimed_contexts: [claim("A1", "C1", 21)] })],
    incidents: [incident({ status: "REPAIRED", resolvedTurn: 21, evidenceByContext: [evidence("later")] })] }));
  assert.deepEqual(value.tasks.map(item => item.id), ["T1"]);
  assert.deepEqual(value.focusTask.claimantAgentIds, []);
  assert.deepEqual(value.evidence, []);
  assert.equal(value.focusTask.result.kind, "pending");
});

test("communication shows six latest actual public messages without invented task or receiver edges", () => {
  const events = Array.from({ length: 9 }, (_, index) => ({ id: `M${index}`, turn: index + 1,
    kind: "SUBMIT_EVIDENCE", agent_id: "A1", belief_id: "B1", content: "Submission" }));
  events.push({ ...events[8] }, { ...events[0], id: "future", turn: 21 }, { ...events[0], id: "private", kind: "INTERNAL_AUDIT" });
  const value = resolveSwarmScene(state({ tasks: [task()], story_events: events,
    messages: [{ id: "not-public", type: "SUBMIT_EVIDENCE", turn: 20, from_agent: "A2", task_id: "T1", recipient_agent_ids: ["A3"] }] }));
  assert.deepEqual(value.messages.map(item => item.id), ["M8", "M7", "M6", "M5", "M4", "M3"]);
  assert.ok(value.messages.every(item => !Object.hasOwn(item, "taskId") && !Object.hasOwn(item, "recipientAgentIds")));
  assert.equal(step(value, "evidence").state, "pending");
});

test("communication labels distinguish request, receipt, sharing, dispute and availability", () => {
  const kinds = ["REQUEST_VERIFICATION", "SUBMIT_EVIDENCE", "SHARE_BELIEF", "RAISE_DISPUTE", "TASK_AVAILABLE"];
  const value = resolveSwarmScene(state({ story_events: kinds.map((kind, index) => ({ id: `M${index}`, turn: 1,
    kind, agent_id: "A1", belief_id: null, content: kind })) }));
  assert.equal(new Set(value.messages.map(item => item.actionLabel)).size, 5);
});

test("hidden roles and source truth cannot alter the public view model", () => {
  const base = state({ tasks: [task({ type: "INVESTIGATION" })], incidents: [incident({ evidenceByContext: [evidence("E1")] })] });
  const altered = structuredClone(base);
  Object.assign(altered.incidents[0], { targetAgentId: "A3", rootBeliefId: "SECRET", omittedCondition: "region",
    affectedAgentIds: ["A2"], replacementBeliefId: "SECRET2", revokedBeliefIds: ["SECRET3"], lineage: [{ receiverAgentId: "A4" }] });
  altered.groundTruth = { mossRule: "hidden" }; altered.corruptionAudit = ["SECRET"];
  assert.deepEqual(resolveSwarmScene(altered), resolveSwarmScene(base));
});

test("terminal task claims cannot continue assigning a member", () => {
  const members = agents(); members[0].currentTaskId = "T1";
  const value = resolveSwarmScene(state({ agents: members,
    tasks: [task({ status: "RESOLVED", claimed_contexts: [claim()], claimant_agent_ids: ["A1"] })] }));
  assert.equal(value.members[0].mode, "exploring");
  assert.equal(value.members[0].taskId, null);
  assert.deepEqual(value.focusTask.claimantAgentIds, []);
});

test("the resolver is pure and carries no progress into a reset snapshot", () => {
  const snapshot = deepFreeze(state({ broadcast_enabled: false,
    tasks: [task({ status: "RESOLVED", resolution: "BELIEF_VERIFIED", evidence_ids: ["E1"] })] }));
  const before = JSON.stringify(snapshot);
  assert.equal(resolveSwarmScene(snapshot).broadcastEnabled, false);
  assert.equal(JSON.stringify(snapshot), before);
  assert.equal(resolveSwarmScene(state({ simulation: { turn: 0 } })).focusTask, null);
});
