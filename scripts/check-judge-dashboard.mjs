import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "frontend-b/package.json"));
const { buildSync } = require("esbuild");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const bundle = buildSync({ stdin: { contents: `
  export * from "./judge-snapshot";
  export * from "./judge-comparison";
  export * from "./components/EvolutionPanel";
  export * from "./components/TruthPanel";
`, resolveDir: path.join(root, "frontend-b/src"), loader: "ts" }, bundle: true, write: false,
  platform: "node", format: "cjs", target: "es2022", jsx: "automatic", logLevel: "silent",
  external: ["react", "react/jsx-runtime", "lucide-react"] });
const compiled = { exports: {} };
new Function("module", "exports", "require", bundle.outputFiles[0].text)(compiled, compiled.exports, require);
const { loadJudgeSnapshot, judgeRequestIsCurrent, judgeIncidentOutcome, judgeComparisonComplete,
  judgeMetricValue, EvolutionPanel, TruthPanel } = compiled.exports;

const state = (turn = 40, seed = 42) => ({ simulation: { turn, seed }, incidents: [] });
const truth = (turn = 40, seed = 42) => ({ turn, seed, cells: [], incidents: [], mossRule: {
  positiveWhen: { region: "NW", weather: "Rain" }, positiveEnergyDelta: 20, otherEnergyDelta: -8,
} });
const incident = (status, id = "incident-1", attackNumber = 1) => ({ id, attackNumber, status,
  injectedTurn: 20, resolvedTurn: ["REPAIRED", "REVOKED", "PREVENTED"].includes(status) ? 30 : null,
  rootBeliefId: null, omittedCondition: null, affectedAgentIds: [], verificationRequestCount: 0,
  evidenceByContext: [], lineage: [],
});
const metric = (id, values = {}) => ({ incident_id: id, agents_affected: 2,
  turns_until_first_dispute: 3, turns_until_repair: 10, incorrect_actions_caused: 2,
  contexts_checked_before_adoption: 2, ...values });

test("truth off requests only the ordinary state and never privileged export", async () => {
  let calls = 0;
  const publicState = state();
  const snapshot = await loadJudgeSnapshot({ state: async () => { calls++; return publicState; }, export: () => assert.fail("Unexpected export") }, false);
  assert.equal(calls, 1);
  assert.equal(snapshot.state, publicState);
  assert.equal(snapshot.truth, null);
});

test("truth on commits one export pair without a second state request", async () => {
  let calls = 0;
  const pair = { state: state(), groundTruth: truth() };
  const snapshot = await loadJudgeSnapshot({ state: () => assert.fail("Cross-request state"), export: async () => { calls++; return pair; } }, true);
  assert.equal(calls, 1);
  assert.equal(snapshot.state, pair.state);
  assert.equal(snapshot.truth, pair.groundTruth);
});

test("every truth refresh receives the current attack audit, not its initial snapshot", async () => {
  let turn = 40;
  const client = { state: () => assert.fail("Cross-request state"), export: async () => ({ state: state(turn), groundTruth: { ...truth(turn), incidents: turn === 40 ? [{}] : [{}, {}] } }) };
  assert.equal((await loadJudgeSnapshot(client, true)).truth.incidents.length, 1);
  turn = 70;
  const next = await loadJudgeSnapshot(client, true);
  assert.equal(next.state.simulation.turn, next.truth.turn);
  assert.equal(next.truth.incidents.length, 2);
});

test("an inconsistent turn or seed is rejected rather than called a same-snapshot view", async () => {
  for (const invalid of [truth(41), truth(40, 43)]) {
    await assert.rejects(loadJudgeSnapshot({ export: async () => ({ state: state(), groundTruth: invalid }) }, true), /快照不一致/);
  }
});

test("closing truth invalidates an export that resolves later", async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  let requestVersion = 7;
  let showingTruth = true;
  let committed = null;
  const refresh = loadJudgeSnapshot({ export: () => pending }, true).then(snapshot => {
    if (judgeRequestIsCurrent(7, requestVersion, true, showingTruth)) committed = snapshot;
  });
  requestVersion++;
  showingTruth = false;
  resolve({ state: state(), groundTruth: truth() });
  await refresh;
  assert.equal(committed, null);
});

test("reopening truth, newer polls, mutations and unmounts reject old versions", () => {
  assert.equal(judgeRequestIsCurrent(3, 3, true, true), true);
  assert.equal(judgeRequestIsCurrent(3, 4, true, true), false);
  assert.equal(judgeRequestIsCurrent(3, 3, true, false), false);
  assert.equal(judgeRequestIsCurrent(3, 5, false, true), false);
});

test("all three terminal outcomes remain distinct", () => {
  assert.equal(judgeIncidentOutcome(incident("REPAIRED")), "已修复");
  assert.equal(judgeIncidentOutcome(incident("REVOKED")), "已撤回");
  assert.equal(judgeIncidentOutcome(incident("PREVENTED")), "采纳前阻止");
  assert.equal(judgeIncidentOutcome(incident("INVESTIGATING")), "观察中");
  assert.equal(judgeIncidentOutcome(), "状态未记录");
});

test("comparison is complete only when both actual incidents have terminal status", () => {
  for (const status of ["REPAIRED", "REVOKED", "PREVENTED"]) assert.equal(judgeComparisonComplete(incident("REPAIRED"), incident(status)), true);
  assert.equal(judgeComparisonComplete(incident("REPAIRED"), incident("INJECTED")), false);
  assert.equal(judgeComparisonComplete(incident("REPAIRED")), false);
});

test("null is not prevention, while actual zero remains zero", () => {
  assert.equal(judgeMetricValue(0), 0);
  assert.equal(judgeMetricValue(null), "未记录");
  assert.equal(judgeMetricValue(null, true, incident("INJECTED")), "未发生");
  assert.equal(judgeMetricValue(null, true, incident("PREVENTED")), "未记录");
  assert.equal(judgeMetricValue(Number.NaN), "未记录");
});

test("negative discovery time in a prevented case means historical evidence reuse, not invented elapsed time", () => {
  const prevented = { ...incident("PREVENTED", "incident-2", 2), injectedTurn: 56, resolvedTurn: 58 };
  assert.equal(judgeMetricValue(-13, true, prevented), "历史证据时间*");
  assert.equal(judgeMetricValue(-13, true, incident("REPAIRED")), "时间记录异常");
  assert.equal(judgeMetricValue(-13, true, incident("INJECTED")), "时间记录异常");
  assert.equal(judgeMetricValue(-13, true), "时间记录异常");
  assert.equal(judgeMetricValue(-2, "closure", prevented), "时间记录异常");
  assert.equal(judgeMetricValue(0, true, prevented), 0);
  assert.equal(judgeMetricValue(2, "closure", prevented), 2);
});

test("historical discovery markup has an explicit footnote and preserves raw metrics", () => {
  const second = Object.freeze(metric("incident-2", { turns_until_first_dispute: -13 }));
  const metrics = { comparison: { first_attack: metric("incident-1"), second_attack: second } };
  const original = JSON.stringify(metrics);
  const markup = renderToStaticMarkup(createElement(EvolutionPanel, { metaBeliefs: [],
    incidents: [incident("REPAIRED"), { ...incident("PREVENTED", "incident-2", 2), injectedTurn: 56, resolvedTurn: 58 }], metrics,
  }));
  assert.match(markup, /历史证据时间\*/);
  assert.match(markup, /data-historical-evidence-note="true"/);
  assert.match(markup, /发现耗时未记录，不计为负耗时/);
  assert.doesNotMatch(markup, /-13|class="better"/);
  assert.equal(JSON.stringify(metrics), original);
});

test("observing comparison markup never claims strategy success or highlights improvement", () => {
  const markup = renderToStaticMarkup(createElement(EvolutionPanel, { metaBeliefs: [],
    incidents: [incident("REPAIRED"), incident("INJECTED", "incident-2", 2)],
    metrics: { comparison: { first_attack: metric("incident-1"), second_attack: metric("incident-2", { turns_until_repair: null, agents_affected: 0 }) } },
  }));
  assert.match(markup, /data-comparison-state="observing"/);
  assert.match(markup, /结案耗时/);
  assert.match(markup, /未发生/);
  assert.doesNotMatch(markup, /策略生效|提前阻止|class="better"/);
  assert.match(markup, /role="region" aria-label="两次攻击指标对照" tabindex="0"/);
});

test("completed comparison renders repair versus revocation without rewriting either as prevention", () => {
  const markup = renderToStaticMarkup(createElement(EvolutionPanel, { metaBeliefs: [],
    incidents: [incident("REPAIRED"), incident("REVOKED", "incident-2", 2)],
    metrics: { comparison: { first_attack: metric("incident-1"), second_attack: metric("incident-2", { turns_until_first_dispute: null, turns_until_repair: 5 }) } },
  }));
  assert.match(markup, /已完成对照/);
  assert.match(markup, /已修复/);
  assert.match(markup, /已撤回/);
  assert.match(markup, /未记录/);
  assert.doesNotMatch(markup, /策略生效|提前阻止/);
});

test("meta cognition and comparison remain reachable before attack two exists", () => {
  const markup = renderToStaticMarkup(createElement(EvolutionPanel, { metaBeliefs: [], incidents: [], metrics: { comparison: null } }));
  assert.match(markup, /id="judge-investigations"/);
  assert.match(markup, /认知演化/);
  assert.match(markup, /两次攻击对比/);
  assert.match(markup, /待第二案/);
});

test("truth markup carries its current turn and explicitly separates judge audit from player tracing", () => {
  const markup = renderToStaticMarkup(createElement(TruthPanel, { truth: { ...truth(70), incidents: [{}, {}] } }));
  assert.match(markup, /data-truth-snapshot-turn="70"/);
  assert.match(markup, /2 次受控攻击/);
  assert.match(markup, /评委真相不代表玩家已完成来源指认/);
});
