import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "frontend-b/package.json"));
const React = require("react");
const { transformSync } = require("esbuild");
const source = readFileSync(path.join(root, "frontend-b/src/components/GameApp.tsx"), "utf8");
const compiled = transformSync(source, { loader: "tsx", format: "cjs", jsx: "automatic", target: "es2022" }).code;
const snapshotModule = { exports: {} };
new Function("module", "exports", transformSync(readFileSync(path.join(root, "frontend-b/src/judge-snapshot.ts"), "utf8"), { loader: "ts", format: "cjs" }).code)(snapshotModule, snapshotModule.exports);

const state = (turn = 10, extra = {}) => ({
  simulation: { turn, seed: 42, running: false, speed: 5 },
  world: { base: [3, 3], weather: "Sunny", cells: [] },
  agents: [{ id: "A1", energy: 80, region: "NW", position: [3, 3], inventory: {}, personalBeliefCount: 1, sharedBeliefCount: 0, verifiedBeliefCount: 0 }],
  tasks: [], collectiveKnowledge: [], metaBeliefs: [], incidents: [], recentEvents: [],
  metrics: { averageEnergy: 80, exploredCellPercent: 10, verifiedCollectiveBeliefs: 0, openTasks: 0, knowledgeMature: false, attacks: { attacks: [], comparison: null } },
  merged_game: { enabled: true, phase: "exploration", complete: false }, ...extra,
});
const pair = (turn = 10, object = "Berry", extra = {}) => ({ state: state(turn, extra), groundTruth: {
  turn, seed: 42, weather: "Sunny", base: [3, 3], cells: [{ position: [0, 0], object, respawn_at: null }],
  incidents: [], mossRule: { positiveWhen: { region: "NW", weather: "Rain" }, positiveEnergyDelta: 20, otherEnergyDelta: -8 },
} });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const nextTick = () => new Promise(resolve => setImmediate(resolve));
function find(node, predicate) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) return node.map(child => find(child, predicate)).find(Boolean);
  if (predicate(node)) return node;
  return find(node.props?.children, predicate);
}

function harness(overrides = {}) {
  const slots = [], effects = [], writes = [], calls = [];
  const intervals = new Map(), timeouts = new Map();
  let cursor = 0, timerId = 0, dirty = false, tree, closed = false;
  const originals = Object.fromEntries(["window", "localStorage"].map(key => [key, globalThis[key]]));
  globalThis.window = {
    setInterval: fn => { const id = ++timerId; intervals.set(id, fn); return id; },
    clearInterval: id => intervals.delete(id),
    setTimeout: fn => { const id = ++timerId; timeouts.set(id, fn); return id; },
    clearTimeout: id => timeouts.delete(id),
  };
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  const client = {
    state: async () => state(), export: async () => pair(),
    agent: async () => ({ personalBeliefs: [], adoptedSharedBeliefs: [], knownCells: [] }),
    step: async () => ({ state: state(11) }), startGame: async () => ({ state: state(0) }),
    pause: async () => ({ state: state(11) }), replay: async turn => state(turn), ...overrides,
  };
  const api = Object.fromEntries(Object.entries(client).map(([key, fn]) => [key, (...args) => { calls.push({ key, args }); return fn(...args); }]));
  const slot = init => { const index = cursor++; if (!slots[index]) slots[index] = init(); return slots[index]; };
  const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const hooks = {
    useState(initial) { const entry = slot(() => ({ value: typeof initial === "function" ? initial() : initial })); return [entry.value, value => { writes.push({ closed }); const next = typeof value === "function" ? value(entry.value) : value; if (!Object.is(next, entry.value)) dirty = true; entry.value = next; }]; },
    useRef(initial) { return slot(() => ({ current: initial })); },
    useCallback(callback, deps) { const entry = slot(() => ({ deps: null, callback })); if (!sameDeps(entry.deps, deps)) { entry.callback = callback; entry.deps = deps; } return entry.callback; },
    useEffect(effect, deps) { const entry = slot(() => ({ deps: null, cleanup: null })); if (!sameDeps(entry.deps, deps)) { entry.deps = deps; effects.push(() => { entry.cleanup?.(); entry.cleanup = effect(); }); } },
  };
  const stubs = new Proxy({}, { get(target, key) { if (!(key in target)) { target[key] = () => null; Object.defineProperty(target[key], "name", { value: String(key) }); } return target[key]; } });
  const localRequire = name => {
    if (name === "react") return { ...React, ...hooks };
    if (name === "react/jsx-runtime") return require(name);
    if (name === "../api") return { api };
    if (name === "../judge-snapshot") return snapshotModule.exports;
    if (name === "../i18n") return { actionLabel: {}, beliefStatusLabel: {}, regionLabel: {}, resourceLabel: {}, taskStatusLabel: {}, taskTypeLabel: {}, beliefTitle: b => b.id, conditionsLabel: () => "" };
    if (name === "../story-scenes") return { resolveStoryScenes: () => ({ current: { number: "1", title: "公开章节" }, chapters: [] }) };
    if (name === "../swarm-scene") return { resolveSwarmScene: () => ({ members: [] }) };
    if (name === "./Wildling") return { Wildling: stubs.Wildling, deriveWildlingState: () => ({}), wildlingColor: () => "#abcdef", wildlingName: id => id };
    if (name === "./Cognition") return { ...Object.fromEntries(["CognitionBadge", "CognitionGuide", "CognitionNotice", "CognitionPanel"].map(key => [key, stubs[key]])), useCognitionNotices: () => ({ notices: [], reset() {}, dismiss() {} }) };
    return stubs;
  };
  const module = { exports: {} };
  new Function("require", "module", "exports", compiled)(localRequire, module, module.exports);
  const render = () => { cursor = 0; dirty = false; tree = module.exports.GameApp({ onJudge() {} }); effects.splice(0).forEach(effect => effect()); return tree; };
  render();
  return {
    calls, writes,
    get tree() { return tree; },
    get world() { return find(tree, node => node.type?.name === "WildWorldScene")?.props; },
    count(key) { return calls.filter(call => call.key === key).length; },
    async flush() { for (let attempt = 0; attempt < 5; attempt++) { await nextTick(); if (dirty && !closed) render(); } },
    click(label) { const button = find(tree, node => node.type === "button" && (node.props["aria-label"] === label || node.props.title === label)); assert.ok(button, label); assert.equal(!!button.props.disabled, false, label); button.props.onClick(); render(); },
    truth() { const button = find(tree, node => node.type === "button" && /世界真值/.test(node.props["aria-label"] || "")); assert.ok(button); return button; },
    poll() { [...intervals.values()].forEach(fn => fn()); },
    scrub(turn) { const input = find(tree, node => node.props?.["aria-label"] === "世界回合回放"); input.props.onChange({ target: { value: String(turn) } }); render(); },
    timers() { const pending = [...timeouts.values()]; timeouts.clear(); pending.forEach(fn => fn()); },
    live() { const banner = find(tree, node => node.props?.className === "replay-banner"); assert.ok(banner); find(banner, node => node.type === "button").props.onClick(); render(); },
    unmount() { closed = true; slots.forEach(entry => entry.cleanup?.()); },
    close() { if (!closed) { closed = true; slots.forEach(entry => entry.cleanup?.()); } for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } },
  };
}
async function withApp(overrides, run) { const app = harness(overrides); try { await app.flush(); await run(app); } finally { app.close(); } }

test("ordinary polling never requests privileged state or export", async () => {
  await withApp({}, async app => {
    assert.equal(app.count("state"), 1); assert.equal(app.count("export"), 0);
    assert.equal(app.world.groundTruth, null);
    app.poll(); await app.flush(); assert.equal(app.count("state"), 2);
    assert.ok(app.calls.filter(call => call.key === "state").every(call => call.args.length === 0));
  });
});

test("truth refresh atomically replaces collected resources with the matching turn without a second state request", async () => {
  let current = pair();
  await withApp({ export: async () => current }, async app => {
    app.click("查看世界真值"); await app.flush();
    assert.equal(app.world.turn, 10); assert.equal(app.world.groundTruth.cells[0].object, "Berry");
    current = pair(11, null); app.poll(); await app.flush();
    assert.equal(app.world.turn, 11); assert.equal(app.world.groundTruth.turn, 11);
    assert.equal(app.world.groundTruth.cells[0].object, null);
    assert.equal(app.count("export"), 2); assert.equal(app.count("state"), 1);
  });
});

test("polls do not overtake an in-flight truth request", async () => {
  const pending = deferred();
  await withApp({ export: () => pending.promise }, async app => {
    app.click("查看世界真值"); app.poll(); app.poll();
    assert.equal(app.count("export"), 1); pending.resolve(pair(12)); await app.flush();
    assert.equal(app.world.turn, 12); assert.equal(app.world.groundTruth.turn, 12);
  });
});

test("turning truth off clears the layer immediately and rejects late privileged responses", async () => {
  const pending = deferred();
  await withApp({ export: () => pending.promise }, async app => {
    app.click("查看世界真值"); app.click("隐藏世界真值");
    assert.equal(app.world.groundTruth, null);
    pending.resolve(pair(99)); await app.flush();
    assert.equal(app.world.turn, 10); assert.equal(app.world.groundTruth, null);
    assert.equal(app.count("state"), 2); assert.equal(app.truth().props["aria-label"], "查看世界真值");
  });
});

test("export keeps public incident data separate from privileged audit data, including after closing", async () => {
  const snapshot = pair();
  snapshot.state.incidents = [{ id: "I1", attackNumber: 1, status: "INJECTED", rootBeliefId: null, targetAgentId: null, affectedAgentIds: [], lineage: [] }];
  snapshot.groundTruth.incidents = [{ id: "I1", rootBeliefId: "SECRET", targetAgentId: "A5", affectedAgentIds: ["A5"] }];
  await withApp({ state: async () => snapshot.state, export: async () => snapshot }, async app => {
    app.click("查看世界真值"); await app.flush();
    assert.equal(app.world.incidents[0].rootBeliefId, null);
    assert.deepEqual(app.world.incidents[0].affectedAgentIds, []);
    app.click("隐藏世界真值");
    assert.equal(app.world.groundTruth, null); assert.equal(app.world.incidents[0].rootBeliefId, null);
    await app.flush(); assert.equal(app.world.incidents[0].targetAgentId, null);
  });
});

test("rapid close and reopen accepts only the newest export", async () => {
  const first = deferred(), second = deferred(); let count = 0;
  await withApp({ export: () => (++count === 1 ? first : second).promise }, async app => {
    app.click("查看世界真值"); app.click("隐藏世界真值"); app.click("查看世界真值");
    second.resolve(pair(12, null)); await app.flush(); first.resolve(pair(99)); await app.flush();
    assert.equal(app.world.turn, 12); assert.equal(app.world.groundTruth.turn, 12);
  });
});

test("operations clear old truth and fetch one new atomic pair after their public response", async () => {
  const operation = deferred(), replacement = deferred(); let exports = 0;
  await withApp({ step: () => operation.promise, export: () => ++exports === 1 ? Promise.resolve(pair()) : replacement.promise }, async app => {
    app.click("查看世界真值"); await app.flush(); app.click("推进一个世界回合");
    assert.equal(app.world.groundTruth, null);
    operation.resolve({ state: state(11) }); await app.flush();
    assert.equal(app.world.turn, 11); assert.equal(app.world.groundTruth, null);
    replacement.resolve(pair(12, null)); await app.flush();
    assert.equal(app.world.turn, 12); assert.equal(app.world.groundTruth.turn, 12);
    assert.equal(app.count("state"), 1); assert.equal(app.count("export"), 2);
  });
});

test("a pre-operation truth request cannot replace the refreshed post-operation snapshot", async () => {
  const old = deferred(); let exports = 0;
  await withApp({ export: () => ++exports === 1 ? old.promise : Promise.resolve(pair(12, null)) }, async app => {
    app.click("查看世界真值"); app.click("推进一个世界回合"); await app.flush();
    assert.equal(app.world.turn, 12); old.resolve(pair(99)); await app.flush();
    assert.equal(app.world.turn, 12); assert.equal(app.world.groundTruth.turn, 12);
  });
});

test("reset disables truth and an old export cannot overwrite the new game", async () => {
  const old = deferred(); let reset = false;
  await withApp({ state: async () => state(reset ? 0 : 10), export: () => old.promise, startGame: async () => { reset = true; return { state: state(0) }; } }, async app => {
    app.click("查看世界真值"); app.click("同一种子重新出发"); await app.flush();
    old.resolve(pair(99)); await app.flush();
    assert.equal(app.world.turn, 0); assert.equal(app.world.groundTruth, null);
    assert.equal(app.truth().props["aria-label"], "查看世界真值"); assert.equal(app.count("export"), 1);
  });
});

test("replay closes truth, rejects pending exports, blocks live polling and returns to a public snapshot", async () => {
  const old = deferred(); let exports = 0;
  await withApp({ export: () => ++exports === 1 ? Promise.resolve(pair()) : old.promise }, async app => {
    app.click("查看世界真值"); await app.flush(); app.poll();
    app.scrub(5); assert.equal(app.world.groundTruth, null); app.timers(); await app.flush();
    old.resolve(pair(99)); await app.flush();
    assert.equal(app.world.turn, 5); assert.equal(app.world.groundTruth, null); assert.equal(app.truth().props.disabled, true);
    const calls = app.calls.length; app.poll(); await app.flush(); assert.equal(app.calls.length, calls);
    app.live(); await app.flush(); assert.equal(app.world.turn, 10); assert.equal(app.world.groundTruth, null);
    assert.equal(app.count("export"), 2); assert.equal(app.count("state"), 2);
  });
});

test("running replay pause never combines its response with the preceding truth", async () => {
  const running = state(10, { simulation: { turn: 10, seed: 42, running: true, speed: 5 } });
  await withApp({ state: async () => running, export: async () => pair(10, "Berry", { simulation: running.simulation }) }, async app => {
    app.click("查看世界真值"); await app.flush(); app.scrub(3); app.timers(); await app.flush();
    assert.equal(app.count("pause"), 1); assert.equal(app.world.turn, 3); assert.equal(app.world.groundTruth, null);
  });
});

test("replay failure releases polling without reopening truth or losing the failure message", async () => {
  await withApp({ replay: async () => { throw new Error("测试回放不存在"); } }, async app => {
    app.scrub(5); app.timers(); await app.flush();
    assert.equal(app.world.turn, 10); assert.equal(app.world.groundTruth, null);
    const alert = find(app.tree, node => node.props?.role === "alert"); assert.ok(alert);
    const count = app.count("state"); app.poll(); await app.flush(); assert.equal(app.count("state"), count + 1);
  });
});

test("a mismatched export is rejected without committing either half", async () => {
  const mismatched = pair(99); mismatched.groundTruth.turn = 98;
  await withApp({ export: async () => mismatched }, async app => {
    app.click("查看世界真值"); await app.flush();
    assert.equal(app.world.turn, 10); assert.equal(app.world.groundTruth, null);
    assert.ok(find(app.tree, node => node.props?.role === "alert"));
  });
});

for (const kind of ["export", "mutation"]) test(`unmount rejects a late ${kind} without state writes or follow-up refresh`, async () => {
  const pending = deferred();
  await withApp(kind === "export" ? { export: () => pending.promise } : { step: () => pending.promise }, async app => {
    app.click(kind === "export" ? "查看世界真值" : "推进一个世界回合");
    app.unmount(); const writes = app.writes.length, calls = app.calls.length;
    pending.resolve(kind === "export" ? pair(99) : { state: state(99) }); await app.flush();
    assert.equal(app.writes.length, writes); assert.equal(app.calls.length, calls);
  });
});
