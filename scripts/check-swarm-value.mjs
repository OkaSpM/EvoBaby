import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "frontend-b/package.json"));
function load(file) {
  const bundle = require("esbuild").buildSync({ entryPoints: [path.join(root, file)], bundle: true, write: false,
    format: "cjs", platform: "node", jsx: "automatic", loader: { ".css": "empty" },
    external: ["react", "react/jsx-runtime", "lucide-react"], logLevel: "silent" });
  const result = { exports: {} };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(require, result, result.exports);
  return result.exports;
}
const { resolveSwarmValues } = load("frontend-b/src/swarm-value.ts");
const { SwarmScene } = load("frontend-b/src/components/SwarmScene.tsx");
const agent = (id, personal = 4, verified = 2) => ({ id, personalBeliefCount: personal, verifiedBeliefCount: verified,
  energy: 100, position: [4, 4], region: "SE", inventory: {}, sharedBeliefCount: 0, currentAction: null, currentTaskId: null,
  unavailableUntilTurn: null });
const state = (changes = {}) => ({ simulation: { turn: 20, seed: 42 }, world: { base: [4, 4] }, agents: [agent("A1", 2, 3), agent("A2", 7, 5)],
  tasks: [], incidents: [], metaBeliefs: [], collectiveKnowledge: [], recentEvents: [], story_events: [], ...changes });
const task = (changes = {}) => ({ id: "T1", type: "VERIFICATION", status: "RESOLVED", created_turn: 3, updated_turn: 10,
  priority: 1, description: "", required_contexts: [], completed_context_ids: [], claimant_agent_ids: [],
  evidence_ids: ["E1", "E2"], belief_id: "B1", resolution: "BELIEF_VERIFIED", ...changes });
const belief = (changes = {}) => ({ id: "B1", status: "VERIFIED", created_turn: 2, updated_turn: 11,
  independent_agent_ids: ["A1", "A2"], ...changes });
const incident = (changes = {}) => ({ id: "I1", injectedTurn: 5, detectedTurn: 8, disputedTurn: 9,
  resolvedTurn: 15, investigationTaskId: "T1", evidenceByContext: [], ...changes });
const sample = (changes = {}) => ({ evidenceId: "E1", agentId: "A1", region: "NW", weather: "Rain", outcome: "COUNTEREXAMPLE", ...changes });
const item = (value, id) => resolveSwarmValues(value).items.find(entry => entry.id === id);

test("summary contains exactly four distinct facts", () => {
  assert.deepEqual(resolveSwarmValues(state()).items.map(entry => entry.id), ["experience", "knowledge", "evidence", "metacognition"]);
});
test("personal and collective counts are parallel scopes, not subtracted into net gain", () => {
  const value = item(state({ collectiveKnowledge: [belief(), belief({ id: "B2" })] }), "knowledge");
  assert.ok(value.summary.includes("共享已验证 2 条")); assert.ok(value.summary.includes("单个成员最多 5 条"));
  assert.ok(value.detail.includes("两侧口径不同，不相减")); assert.ok(!value.summary.includes("-3"));
});
test("personal experience counts do not assert proven complementary knowledge", () => {
  const value = item(state(), "experience");
  assert.ok(value.summary.includes("2–7")); assert.equal(value.members.length, 2);
  assert.ok(value.detail.includes("不等于已经证明内容互补"));
});
test("sample indexes are deduplicated across existing tasks", () => {
  const value = item(state({ tasks: [task(), task({ id: "T2", evidence_ids: ["E2", "E3"] })] }), "evidence");
  assert.ok(value.summary.includes("3 份关联样本索引"));
  assert.ok(value.detail.includes("样本原件仍需逐份核对"));
});
test("task claimants do not become inferred contributing authors", () => {
  const value = item(state({ tasks: [task({ claimant_agent_ids: ["A1", "A2"] })] }), "evidence");
  assert.ok(value.detail.includes("样本作者未记录"));
  assert.ok(!value.detail.includes("记录了 2 位成员"));
});
test("only sample authors from a precisely associated investigation are recorded", () => {
  const value = item(state({ tasks: [task()], incidents: [incident({ evidenceByContext: [sample(), sample()] }),
    incident({ id: "I2", investigationTaskId: "T_OTHER", evidenceByContext: [sample({ agentId: "A2" })] })] }), "evidence");
  assert.ok(value.detail.includes("记录了 1 位成员"));
});
test("rule independent sources remain distinct from current-task sample authors", () => {
  const value = item(state({ tasks: [task()], collectiveKnowledge: [belief()], incidents: [incident({ evidenceByContext: [sample()] })] }), "evidence");
  assert.ok(value.detail.includes("记录了 1 位成员")); assert.ok(value.detail.includes("另记 2 位独立来源"));
  assert.ok(value.detail.includes("来源不等于本次任务提交者"));
});
test("future task snapshots and future incident results are excluded", () => {
  const value = item(state({ tasks: [task({ updated_turn: 21 })], incidents: [incident({ resolvedTurn: 21, evidenceByContext: [sample()] })] }), "evidence");
  assert.ok(value.summary.includes("0 份关联样本索引")); assert.ok(value.detail.includes("样本作者未记录"));
});
test("only currently verified and already reached collective records count", () => {
  const value = item(state({ collectiveKnowledge: [belief(), belief(), belief({ id: "B2", status: "REVOKED" }),
    belief({ id: "B3", updated_turn: 21 }), belief({ id: "B4", created_turn: 22 })] }), "knowledge");
  assert.ok(value.summary.includes("共享已验证 1 条"));
});
test("a D3 choice or cognition stage alone does not count as an active meta rule", () => {
  const value = item(state({ choices: { D3: "A" }, agents: [{ ...agent("A1"), cognition: { stage: 4 } }] }), "metacognition");
  assert.equal(value.summary, "尚无生效元认知记录");
});
test("meta rules require active status and a reached creation turn", () => {
  const meta = { id: "MB1", active: true, created_turn: 12, policy_effect: { dimensions: ["region", "weather"] } };
  const value = item(state({ metaBeliefs: [meta, { ...meta, id: "MB2", active: false }, { ...meta, id: "MB3", created_turn: 21 }] }), "metacognition");
  assert.ok(value.summary.includes("1 条生效元认知")); assert.ok(value.summary.includes("区域、天气"));
  assert.ok(value.detail.includes("MB1 / T12")); assert.ok(!value.detail.includes("MB2"));
});
test("missing counts, lists and evidence metadata remain unrecorded", () => {
  const value = resolveSwarmValues(state({ agents: [agent("A1", null, null)], tasks: undefined, metaBeliefs: undefined, collectiveKnowledge: undefined }));
  assert.ok(value.items[0].summary.includes("未记录")); assert.ok(value.items[1].summary.includes("未记录"));
  assert.ok(value.items[2].summary.includes("任务样本未记录")); assert.equal(value.items[3].summary, "元认知规则未记录");
});
test("existing tasks with no retained sample list do not imply zero samples", () => {
  const value = item(state({ tasks: [task({ evidence_ids: undefined })] }), "evidence");
  assert.ok(value.summary.includes("任务样本未记录"));
  assert.ok(!value.summary.includes("0 份关联样本索引"));
});
test("source identities, affected members and true lineage never alter the facts", () => {
  const first = state({ tasks: [task()], incidents: [incident()] });
  const second = structuredClone(first); Object.assign(second.incidents[0], { targetAgentId: "SECRET_PERSON", rootBeliefId: "SECRET_ROOT",
    replacementBeliefId: "SECRET_REPLACEMENT", affectedAgentIds: ["SECRET_PERSON"], lineage: [{ senderAgentId: "SECRET_PERSON" }] });
  assert.deepEqual(resolveSwarmValues(first), resolveSwarmValues(second));
});
test("resolving facts does not mutate the snapshot", () => {
  const value = state({ tasks: [task()], collectiveKnowledge: [belief()] }), copy = structuredClone(value);
  resolveSwarmValues(value); assert.deepEqual(value, copy);
});
test("swarm UI exposes four readable facts without replacing task workflow", () => {
  const React = require("react"), { renderToStaticMarkup } = require("react-dom/server");
  const html = renderToStaticMarkup(React.createElement(SwarmScene, { state: state({ tasks: [task()] }), selectedAgent: "A1", onSelectAgent() {}, onSelectBelief() {} }));
  assert.equal((html.match(/data-swarm-value=/g) || []).length, 4);
  for (const expected of ["协作留下的增量", "不作净收益估算", "协作公告板", "任务协作事实进度", "五位成员当前分工", "篝火通信"])
    assert.ok(html.includes(expected), expected);
});
