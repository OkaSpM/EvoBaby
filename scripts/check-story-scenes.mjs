import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "frontend-b/package.json"));
const { buildSync } = require("esbuild");
const bundle = buildSync({ entryPoints: [path.join(root, "frontend-b/src/story-scenes.ts")], bundle: true,
  write: false, platform: "node", format: "esm", target: "es2022", logLevel: "silent" });
const { resolveStoryScenes, STORY_SCENES, CHOICE_STORY_SCENES } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`);

function state(update = {}) {
  return {
    simulation: { turn: 0, running: false, speed: 1, seed: 42, canInjectFirst: false, canInjectSecond: false },
    world: { size: 8, base: [3, 3], weather: "Sunny", cells: [] },
    agents: Array.from({ length: 5 }, (_, index) => ({ id: `A${index + 1}`, energy: 60, position: [index, 1] })),
    tasks: [], collectiveKnowledge: [], metaBeliefs: [], incidents: [], recentEvents: [], story_events: [],
    metrics: { averageEnergy: 60, exploredCellPercent: 0, verifiedCollectiveBeliefs: 0, openTasks: 0,
      knowledgeMature: false, attacks: { attacks: [], comparison: null } },
    choices: {}, awaiting_choice: null, paradigm: null,
    merged_game: { enabled: true, phase: "exploring", complete: false, observation_window_turns: 60 },
    ...update,
  };
}

function at(turn, update = {}) {
  return state({ ...update, simulation: { ...state().simulation, turn, ...(update.simulation || {}) } });
}

function incident(update = {}) {
  return { id: "I1", attackNumber: 1, status: "INJECTED", injectedTurn: 33,
    targetAgentId: null, rootBeliefId: null, omittedCondition: null, affectedAgentIds: [],
    detectedTurn: null, disputedTurn: null, investigationTaskId: null, replacementBeliefId: null,
    revokedBeliefIds: [], resolvedTurn: null, verificationRequestCount: 0, evidenceByContext: [], lineage: [],
    ...update };
}

function investigation(update = {}) {
  return { id: "T29", type: "INVESTIGATION", status: "IN_PROGRESS", priority: 95, created_turn: 53,
    updated_turn: 60, description: "Check contexts", belief_id: "B99", required_contexts: [],
    claimant_agent_ids: ["A2"], completed_context_ids: [], resolution: null, ...update };
}

function negative(turn, agent = "A3") {
  return { event_id: `E${turn}`, type: "ACTION_EXECUTED", turn, agent_id: agent,
    observation: { position: [1, 5], region: "SW", weather: "Sunny", object: "Moss", energy: 35 },
    result: { action: "USE_MOSS", object: "Moss", success: true, reason: "Observed feedback", resource_effect: -8, returned_to_base: false } };
}

function chapter(result, id) { return result.chapters.find(item => item.id === id); }
function ids(result) { return result.chapters.map(item => item.id); }
function deepFreeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}

test("six scene definitions are local assets and choice art has neutral D1/D3 mappings", () => {
  assert.deepEqual(Object.keys(STORY_SCENES), ["departure", "hearth", "anomaly", "verification", "repair", "second-trial"]);
  for (const [id, scene] of Object.entries(STORY_SCENES)) {
    assert.equal(scene.image, `/b/art/story/${id}.png`);
    assert.ok(scene.imageAlt.length > 10);
  }
  assert.deepEqual(CHOICE_STORY_SCENES, { D1: "hearth", D2: "anomaly", D3: "verification", D4: "second-trial" });
});

test("initial village does not claim later chapters or completed exploration", () => {
  const result = resolveStoryScenes(state());
  assert.deepEqual(ids(result), ["departure"]);
  assert.equal(result.current.recordedTurn, 0);
  assert.match(result.current.caption, /第一份经验/);
});

test("a natural negative trial before any incident is not a rumor anomaly", () => {
  const result = resolveStoryScenes(at(2, { recentEvents: [negative(1)] }));
  assert.deepEqual(ids(result), ["departure"]);
});

test("hearth uses visible sharing time, not the creation time of a belief", () => {
  const result = resolveStoryScenes(at(12, { collectiveKnowledge: [{ created_turn: 2 }],
    story_events: [{ id: "M1", turn: 9, kind: "SHARE_BELIEF", agent_id: "A1", belief_id: "B1", content: "A claim" }] }));
  assert.equal(chapter(result, "hearth").recordedTurn, 9);
  assert.equal(chapter(result, "hearth").turnLabel, "可见分享记录");
});

test("truncated sharing history remains reached with an unknown timestamp", () => {
  const result = resolveStoryScenes(at(80, { incidents: [incident()], collectiveKnowledge: [{ created_turn: 2 }] }));
  assert.equal(chapter(result, "hearth").recordedTurn, null);
  assert.equal(chapter(result, "hearth").reached, true);
});

test("D1 stays a neutral hearth before a target has been chosen", () => {
  const result = resolveStoryScenes(at(33, { awaiting_choice: { point: "D1", turn: 33 } }));
  assert.equal(result.current.id, "hearth");
  assert.ok(!chapter(result, "anomaly"));
  assert.ok(!chapter(result, "second-trial"));
  assert.doesNotMatch(JSON.stringify(result), /A[1-5]|零号|感染者/);
});

test("a pending D2 is sufficient public evidence even if action history is truncated", () => {
  const result = resolveStoryScenes(at(52, { incidents: [incident()], awaiting_choice: { point: "D2", turn: 52 } }));
  assert.equal(result.current.id, "anomaly");
  assert.ok(!chapter(result, "repair"));
});

test("unrelated negative feedback after injection does not advance the case chapter", () => {
  for (const sampleTurn of [33, 39]) {
    const result = resolveStoryScenes(at(40, { incidents: [incident({ injectedTurn: 33 })], recentEvents: [negative(sampleTurn)] }));
    assert.equal(result.current.id, "hearth");
    assert.ok(!chapter(result, "anomaly"));
  }
});

test("choosing ignore preserves the reached anomaly without inventing investigation", () => {
  const result = resolveStoryScenes(at(80, { incidents: [incident({ status: "SPREADING" })], choices: { D2: "D" } }));
  assert.equal(chapter(result, "anomaly").recordedTurn, null);
  assert.ok(!chapter(result, "verification"));
  assert.ok(!chapter(result, "repair"));
});

test("unrelated or future tasks cannot manufacture an incident investigation", () => {
  for (const task of [investigation({ id: "unrelated" }), investigation({ created_turn: 99 })]) {
    const result = resolveStoryScenes(at(60, { incidents: [incident({ investigationTaskId: "T29" })], tasks: [task] }));
    assert.ok(!chapter(result, "verification"));
  }
});

test("an attributable investigation keeps its public creation time after event truncation", () => {
  const result = resolveStoryScenes(at(68, { incidents: [incident({ status: "INVESTIGATING", investigationTaskId: "T29", disputedTurn: 52 })], tasks: [investigation()] }));
  assert.equal(result.current.id, "verification");
  assert.equal(result.current.recordedTurn, 52);
  assert.ok(!chapter(result, "repair"));
});

test("D3 after direct revocation never becomes a repaired chapter", () => {
  const result = resolveStoryScenes(at(52, { choices: { D2: "C" }, awaiting_choice: { point: "D3" },
    incidents: [incident({ status: "REVOKED", disputedTurn: 52, resolvedTurn: 52 })] }));
  assert.equal(result.current.id, "verification");
  assert.match(result.current.caption, /撤销不等于原因已经查清/);
  assert.ok(!chapter(result, "repair"));
});

test("D3 at the observation timeout never claims successful repair", () => {
  const result = resolveStoryScenes(at(93, { choices: { D2: "D" }, awaiting_choice: { point: "D3" },
    incidents: [incident({ status: "SPREADING" })] }));
  assert.equal(result.current.id, "verification");
  assert.match(result.current.caption, /尚未确认修复/);
  assert.ok(!chapter(result, "repair"));
});

test("repair is admitted only by a reached REPAIRED resolution", () => {
  for (const status of ["INJECTED", "SPREADING", "VERIFYING", "DISPUTED", "INVESTIGATING", "REVOKED", "PREVENTED"]) {
    const result = resolveStoryScenes(at(72, { incidents: [incident({ status, resolvedTurn: 72 })], choices: { D3: "A" } }));
    assert.ok(!chapter(result, "repair"), status);
  }
  const result = resolveStoryScenes(at(72, { incidents: [incident({ status: "REPAIRED", resolvedTurn: 72 })] }));
  assert.equal(chapter(result, "repair").recordedTurn, 72);
});

test("future repair cannot leak into an earlier replay", () => {
  const result = resolveStoryScenes(at(71, { incidents: [incident({ status: "REPAIRED", resolvedTurn: 72 })] }));
  assert.ok(!chapter(result, "repair"));
});

test("D4 and a delayed second candidate mean preparation, not an injected or blocked attack", () => {
  for (const update of [{ awaiting_choice: { point: "D4" } },
    { merged_game: { enabled: true, phase: "awaiting_second_candidate", complete: false } }]) {
    const result = resolveStoryScenes(at(72, { incidents: [incident({ status: "REVOKED", resolvedTurn: 52 })], ...update }));
    assert.equal(result.current.id, "second-trial");
    assert.equal(result.current.recordedTurn, null);
    assert.match(result.current.caption, /还没有开始/);
    assert.doesNotMatch(result.current.caption, /已在采纳前被拦下|已确认修复/);
  }
});

test("a real second incident records its injection and leaves the result open", () => {
  const second = incident({ id: "I2", attackNumber: 2, injectedTurn: 73, status: "VERIFYING" });
  const result = resolveStoryScenes(at(75, { incidents: [incident(), second] }));
  assert.equal(result.current.id, "second-trial");
  assert.equal(result.current.recordedTurn, 73);
  assert.match(result.current.caption, /结果还没有写定/);
});

test("prevention is distinct from repair and must have happened by the replay turn", () => {
  const second = incident({ id: "I2", attackNumber: 2, injectedTurn: 73, status: "PREVENTED", resolvedTurn: 79 });
  const atEnd = resolveStoryScenes(at(79, { incidents: [incident(), second] }));
  assert.match(atEnd.current.caption, /采纳前被拦下/);
  assert.ok(!chapter(atEnd, "repair"));
  const earlier = resolveStoryScenes(at(78, { incidents: [incident(), second] }));
  assert.doesNotMatch(earlier.current.caption, /已在采纳前被拦下/);
});

test("completed observation windows do not become successful investigations", () => {
  const result = resolveStoryScenes(at(140, { incidents: [incident(), incident({ id: "I2", attackNumber: 2, injectedTurn: 80 })],
    paradigm: { choices: { D2: "D", D3: "D" }, name: "健忘部落" } }));
  assert.match(result.current.caption, /未发现或未修复/);
  assert.ok(!chapter(result, "repair"));
});

test("known chapter timestamps sort chronologically even if repair happens after attack two begins", () => {
  const result = resolveStoryScenes(at(90, { incidents: [incident({ status: "REPAIRED", resolvedTurn: 85 }),
    incident({ id: "I2", attackNumber: 2, injectedTurn: 80 })] }));
  const dated = result.chapters.map(item => item.recordedTurn).filter(turn => turn !== null);
  assert.deepEqual(dated, [...dated].sort((a, b) => a - b));
});

test("unrevealed roles, hidden conditions and a selected victim never drive story art", () => {
  const publicState = at(60, { incidents: [incident({ status: "INVESTIGATING", investigationTaskId: "T29", disputedTurn: 52 })], tasks: [investigation()] });
  const disclosed = structuredClone(publicState);
  Object.assign(disclosed.incidents[0], { targetAgentId: "A3", rootBeliefId: "B-SECRET", omittedCondition: "region",
    affectedAgentIds: ["A1", "A3"], replacementBeliefId: "B-NEW", revokedBeliefIds: ["B-OLD"],
    lineage: [{ parentBeliefId: "B-SECRET", childBeliefId: "B-CHILD", senderAgentId: "A3", receiverAgentId: "A1" }] });
  assert.deepEqual(resolveStoryScenes(publicState), resolveStoryScenes(disclosed));
});

test("future-only events and tasks cannot appear in replay chapters", () => {
  const result = resolveStoryScenes(at(10, { incidents: [incident()], tasks: [investigation()], recentEvents: [negative(40)],
    story_events: [{ id: "future", kind: "SHARE_BELIEF", turn: 20, agent_id: "A1" }] }));
  assert.deepEqual(ids(result), ["departure"]);
});

test("resolver is pure and independent calls cannot retain a later game's chapters", () => {
  const ended = deepFreeze(at(79, { incidents: [incident({ status: "REPAIRED", resolvedTurn: 72 }),
    incident({ id: "I2", attackNumber: 2, injectedTurn: 73, status: "PREVENTED", resolvedTurn: 79 })] }));
  const before = JSON.stringify(ended);
  resolveStoryScenes(ended);
  assert.equal(JSON.stringify(ended), before);
  assert.deepEqual(ids(resolveStoryScenes(state())), ["departure"]);
});
