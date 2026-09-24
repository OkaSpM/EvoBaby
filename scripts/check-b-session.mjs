import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "frontend-b/package.json"));
const { transformSync } = require("esbuild");
function load(name, dependencies = {}) {
  const module = { exports: {} };
  const code = transformSync(readFileSync(path.join(root, `frontend-b/src/${name}.ts`), "utf8"), { loader: "ts", format: "cjs" }).code;
  new Function("require", "module", "exports", code)(id => dependencies[id] || require(id), module, module.exports);
  return module.exports;
}
const session = load("b-session");
const { api } = load("api", { "./b-session": session });
const state = (closure, extra = {}) => ({ simulation: { turn: 20 }, agents: [{ id: "A1" }, { id: "A2" }], incidents: [], merged_game: { enabled: true, b_review: { closure, cognition_feedback: {} } }, ...extra });

test("feedback attaches only the current snapshot's member mapping", () => {
  const source = state();
  source.merged_game.b_review.cognition_feedback.A1 = { state: "review", since_turn: 18 };
  const result = session.withBFeedback(source);
  assert.equal(result.agents[0].cognitionFeedback.state, "review");
  assert.equal(result.agents[1].cognitionFeedback, null);
  assert.equal(source.agents[0].cognitionFeedback, undefined);
});
test("legacy snapshots are preserved without invented feedback", () => {
  const source = state(null, { merged_game: { enabled: true } });
  assert.equal(session.withBFeedback(source), source);
});
test("older snapshots cannot inherit present feedback", () => {
  const past = state();
  past.agents[0].cognitionFeedback = { state: "recovered", since_turn: 100 };
  assert.equal(session.withBFeedback(past).agents[0].cognitionFeedback, null);
});
test("unresolved observation offers continuation, not a success label", () => {
  const mission = session.currentMission(state({ status: "unresolved", can_continue: true, title: "调查未竟", reason: "仍缺对照证据" }));
  assert.equal(mission.action, "continue");
  assert.equal(mission.title, "调查未竟");
});
test("repair without identification calls for source investigation", () => {
  const mission = session.currentMission(state({ status: "awaiting_trace", pending_incident_ids: ["I1", "I2"] }));
  assert.equal(mission.action, "investigate");
  assert.match(mission.detail, /2/);
});
test("only explicit success shows the complete closure mission", () => {
  assert.equal(session.currentMission(state({ status: "success" })).action, "review");
  assert.match(session.currentMission(state({ status: "success" })).title, /均已查明/);
});
test("closed partial cases offer remaining trace or review, never pretend active repair", () => {
  const closure = { status: "partial", observation_complete: true, can_continue: false, pending_incident_ids: ["I1"], title: "已止损，未完整修复", reason: "旧说法已撤回" };
  assert.equal(session.currentMission(state(closure)).action, "investigate");
  assert.equal(session.currentMission(state({ ...closure, pending_incident_ids: [] })).action, "review");
});
test("an unresolved decision takes priority over advance", () => {
  assert.equal(session.currentMission(state(null, { awaiting_choice: { point: "D2" } })).action, "choose");
});
test("initial and exploration missions use real playable actions", () => {
  assert.equal(session.currentMission(state(null, { merged_game: { enabled: false } })).action, "begin");
  assert.equal(session.currentMission(state()).action, "advance");
});
test("B accusation names its selected historical case; legacy routing remains intact", async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, json: async () => ({ correct: false, state: state() }) }; };
  try {
    const response = await api.accuse("A1", "B17", "I1");
    assert.equal(calls[0].url, "/api/b/trace/accuse");
    assert.equal(calls[0].body.incident_id, "I1");
    assert.equal(response.state.agents[0].cognitionFeedback, null);
    await api.accuse("A1", "B17");
    assert.equal(calls[1].url, "/api/trace/accuse");
  } finally { globalThis.fetch = original; }
});
test("continuation stays on the B endpoint with a bounded observation budget", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "/api/b/continue"); assert.equal(JSON.parse(init.body).turns, 60);
    return { ok: true, json: async () => ({ state: state() }) };
  };
  try { await api.continueInvestigation(); } finally { globalThis.fetch = original; }
});
