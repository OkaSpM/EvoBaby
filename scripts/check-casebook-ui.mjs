import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "frontend-b/package.json"));
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const bundle = require("esbuild").buildSync({ entryPoints: [path.join(root, "frontend-b/src/components/CaseBook.tsx")],
  bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic", loader: { ".css": "empty" },
  external: ["react", "react/jsx-runtime", "lucide-react"], logLevel: "silent" });
const moduleValue = { exports: {} };
// Expose the receipt only inside this in-memory test bundle, not the application API.
new Function("require", "module", "exports", bundle.outputFiles[0].text + "\nmodule.exports.testReceipt = EvidenceReceipt;")(require, moduleValue, moduleValue.exports);
const { CaseBook, testReceipt } = moduleValue.exports;
const incident = (update = {}) => ({ id: "I1", attackNumber: 1, status: "INJECTED", injectedTurn: 3,
  detectedTurn: null, disputedTurn: null, resolvedTurn: null, investigationTaskId: null,
  rootBeliefId: null, targetAgentId: null, replacementBeliefId: null, evidenceByContext: [], lineage: [], ...update });
const state = (update = {}) => ({ simulation: { turn: 20, seed: 42 }, incidents: [], tasks: [],
  collectiveKnowledge: [], trace_game: null, ...update });
const render = (value, replaying = false, initialCaseId = null) => renderToStaticMarkup(React.createElement(CaseBook,
  { state: value, replaying, initialCaseId, onInvestigate() {}, onSelectAgent() {}, sessionKey: "ui-check" }));
const current = (id = "I1", correct = false) => ({ current: { incident_id: id, result: correct ? { correct: true } : null } });

test("no future cases or invented placeholder cases", () => {
  const html = render(state({ incidents: [incident({ injectedTurn: 21 })] }));
  assert.ok(html.includes("还没有公开案件"));
  assert.ok(!html.includes('role="tab"'));
});

test("both existing case tabs appear, only the latest case panel is initially selected", () => {
  const html = render(state({ incidents: [incident(), incident({ id: "I2", attackNumber: 2, injectedTurn: 15 })] }));
  assert.ok(html.includes("第一案")); assert.ok(html.includes("第二案"));
  assert.ok(html.includes('data-case-id="I2"'));
  assert.ok(!html.includes('data-case-id="I1"'));
});

test("unconfirmed current case can open the independent trace game", () => {
  const html = render(state({ incidents: [incident()], trace_game: current() }));
  assert.ok(html.includes("尚未指认成功")); assert.ok(html.includes("去追零号"));
  assert.ok(html.includes("原始说法尚未公开"));
});
test("opening evidence from the first trace keeps the first case selected", () => {
  const html = render(state({ incidents: [incident(), incident({ id: "I2", attackNumber: 2, injectedTurn: 15 })] }), false, "I1");
  assert.ok(html.includes('data-case-id="I1"'));
  assert.ok(!html.includes('data-case-id="I2"'));
});

test("historical case without a current trace round does not offer a false accusation button", () => {
  const html = render(state({ incidents: [incident()], trace_game: current("I2") }));
  assert.ok(html.includes("当前只能指认最新案件"));
  assert.ok(!html.includes("去追零号"));
});

test("replay omits the accusation action and explains the historical boundary", () => {
  const html = render(state({ incidents: [incident()], trace_game: current() }), true);
  assert.ok(html.includes("回放只保留这一回合已公开的事实"));
  assert.ok(!html.includes("去追零号"));
});

test("privileged origin fields alone never reveal the source or actual lineage", () => {
  const html = render(state({ incidents: [incident({ targetAgentId: "A3", rootBeliefId: "HIDDEN_ROOT",
    lineage: [{ senderAgentId: "A3", receiverAgentId: "A1", parentBeliefId: "HIDDEN_ROOT", childBeliefId: "HIDDEN_CHILD" }] })], trace_game: current() }));
  assert.ok(!html.includes("HIDDEN_ROOT")); assert.ok(!html.includes("HIDDEN_CHILD"));
  assert.ok(html.includes('data-source-confirmed="false"'));
});

test("correct confirmed source includes real lineage, not synthetic arrows", () => {
  const html = render(state({ incidents: [incident({ targetAgentId: "A3", rootBeliefId: "REAL_ROOT",
    lineage: [{ senderAgentId: "A3", receiverAgentId: "A1", parentBeliefId: "REAL_ROOT", childBeliefId: "REAL_CHILD" }] })], trace_game: current("I1", true) }));
  assert.ok(html.includes("已确认的零号记忆")); assert.ok(html.includes("REAL_ROOT")); assert.ok(html.includes("REAL_CHILD"));
  assert.ok(html.includes('data-source-confirmed="true"'));
});

test("confirmed investigation subject and zero memory are visibly distinguished", () => {
  const value = state({ incidents: [incident({ targetAgentId: "A3", rootBeliefId: "B87", investigationTaskId: "T29" })],
    tasks: [{ id: "T29", type: "INVESTIGATION", belief_id: "B56", created_turn: 5, updated_turn: 12 }], trace_game: current("I1", true) });
  const html = render(value);
  assert.ok(html.includes('data-case-subject-origin="distinct"'));
  assert.match(html, /调查核验的是规则 B56；你指认的零号记忆是 B87/);
});

test("distinction copy never reveals an unconfirmed private origin", () => {
  const html = render(state({ incidents: [incident({ targetAgentId: "A3", rootBeliefId: "PRIVATE_B87", investigationTaskId: "T29" })],
    tasks: [{ id: "T29", type: "INVESTIGATION", belief_id: "B56", created_turn: 5, updated_turn: 12 }], trace_game: current("I1", false) }));
  assert.ok(!html.includes("PRIVATE_B87"));
  assert.ok(!html.includes('data-case-subject-origin="distinct"'));
});

for (const [status, expected, forbidden] of [
  ["REPAIRED", "已记录修复，新规则原件未公开", "旧说法已撤回</h4>"],
  ["REVOKED", "这次处理是撤销，不代表已经查清完整规则。", "修正后的规则"],
  ["PREVENTED", "这条说法在通过集体采纳前被拦下，不等同于扩散后的修复。", "修正后的规则"],
  ["INVESTIGATING", "尚未形成结案结果", "修正后的规则"],
]) test(`terminal and pending conclusions remain distinct: ${status}`, () => {
  const html = render(state({ incidents: [incident({ status, resolvedTurn: status === "INVESTIGATING" ? null : 18 })] }));
  assert.ok(html.includes(expected)); assert.ok(!html.includes(forbidden));
});

test("public sample without an original receipt retains unknown energy and no claimed first discovery", () => {
  const html = render(state({ incidents: [incident({ status: "INVESTIGATING", evidenceByContext: [
    { evidenceId: "E7", agentId: "A2", region: "SE", weather: "Sunny", outcome: "COUNTEREXAMPLE" },
  ] })] }));
  assert.ok(html.includes("能量回执未核对")); assert.ok(html.includes("回合未记录"));
  assert.ok(html.includes("东南区")); assert.ok(html.includes("晴天"));
  assert.ok(html.includes('data-receipt-verified="false"'));
  assert.ok(!html.includes("首次反例记录"));
});

test("historical direct references are labelled as comparison evidence, not new experiments or proven interception causes", () => {
  const evidence = { id: "EV-old", agentId: "A2", turn: 12, region: "NW", weather: "Sunny", delta: -8,
    outcome: "COUNTEREXAMPLE", receiptVerified: true, timing: "historical", basis: "belief-reference" };
  const html = renderToStaticMarkup(React.createElement(testReceipt, { evidence, onSelectAgent() {} }));
  assert.ok(html.includes("历史回执 · 本页对照依据"));
  assert.ok(html.includes("规则直接引用的回执"));
  assert.ok(html.includes('data-evidence-timing="historical"'));
  assert.ok(html.includes('data-evidence-basis="belief-reference"'));
  assert.ok(html.includes("能量 -8"));
  assert.ok(!html.includes("本轮新实验"));
  assert.ok(!html.includes("已核验拦截来源"));
});

test("case discovery names the public turn, elapsed time and distinct dispute", () => {
  const html = render(state({ incidents: [incident({ detectedTurn: 8, disputedTurn: 10 })] }));
  assert.ok(html.includes('data-discovery-basis="incident-detected"'));
  assert.ok(html.includes("T8</strong>")); assert.ok(html.includes("注入后 5 回合"));
  assert.ok(html.includes("公开争议 T10"));
  assert.ok(html.includes("原始实验发生时刻，不等同于本案发现时刻"));
});

test("pre-injection evidence never renders negative discovery elapsed time", () => {
  const html = render(state({ incidents: [incident({ injectedTurn: 15, detectedTurn: 2 })] }));
  assert.ok(html.includes('data-discovery-basis="historical-evidence"'));
  assert.ok(html.includes("发现回合未记录")); assert.ok(html.includes("历史证据 T2"));
  assert.ok(html.includes("注入前记录，不作发现耗时"));
  assert.ok(!html.includes("注入后 -13"));
});
