import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "frontend-b/package.json"));
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const bundle = require("esbuild").buildSync({ stdin: { contents: 'export * from "./components/EndingCard"; export * from "./components/EndingGallery"; export * from "./components/Cognition"; export * from "./cognition"; export * from "./cooperation-deck";', resolveDir: path.join(root, "frontend-b/src"), loader: "ts" },
  bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic", loader: { ".css": "empty" },
  external: ["react", "react/jsx-runtime", "lucide-react"], logLevel: "silent" });
const moduleValue = { exports: {} };
new Function("require", "module", "exports", bundle.outputFiles[0].text)(require, moduleValue, moduleValue.exports);
const { EndingCard, EndingGallery, CognitionPanel, CognitionFeedback, COGNITION_STAGES, ENDING_ART, COOPERATION_DECK, cooperationPreview, downloadPng, downloadJson } = moduleValue.exports;
const fixture = (changes = {}) => ({ id: "REAL-CARD-1", name: "敲锣部落", totem: "bell", tagline: "实际运行留下的协作记录",
  seed: 42, completed_turn: 79, choices: { D2: "A", D3: "A" },
  metrics: { attack1: { spread: 3, detect_turns: 6, repair_turns: 39, bad_actions: 6, status: "REPAIRED", injected_turn: 33, resolved_turn: 72 },
    attack2: { spread: 1, detect_turns: -13, repair_turns: 7, bad_actions: 0, status: "PREVENTED", injected_turn: 72, resolved_turn: 79 } },
  rules: ["先检查不同条件，再决定是否采纳。"], protocol: {}, applies_to: [], cost: {},
  memberCognition: [{ agentId: "A1", stage: 3, name: "求证者" }], ...changes });
const render = (value, preview = false) => renderToStaticMarkup(React.createElement(EndingCard, { paradigm: value, preview }));
const feedback = (state = "review") => ({ state, label: "CANARY_UNTRUSTED_LABEL", reason: "关联规则出现反例，正在补充核验。", since_turn: 76, ruleIds: ["SECRET_ROOT_CANARY"], methodLabel: "带条件记录", stage: 3 });
const updatedFixture = (status = "unresolved") => fixture({ completed_turn: 132,
  b_outcome: { status, title: "Backend title", reason: "第一案已修正规则；第二案尚未结案。", can_continue: true, observation_complete: true, pending_incident_ids: ["I2"], continuation_count: 0 },
  memberFeedback: { A1: feedback("misaligned") },
  caseChronology: [
    { incident_id: "I1", attack_number: 1, injected_turn: 33, first_counterexample_turn: 52, detected_turn: 52, resolved_turn: 72, status: "REPAIRED", source_confirmed: false, evidence: [] },
    { incident_id: "I2", attack_number: 2, injected_turn: 72, first_counterexample_turn: 76, detected_turn: 129, resolved_turn: null, status: "INVESTIGATING", source_confirmed: false, evidence: [] },
  ],
});

test("historical cognition and current rule feedback do not change with health", () => {
  const agent = { id: "A1", energy: 1, cognition: { stage: 3, earnedTurn: 33, milestones: [], progress: { current: 1, target: 3 }, nextGoal: "提交亲历反证" }, cognitionFeedback: feedback("misaligned") };
  const low = renderToStaticMarkup(React.createElement(CognitionPanel, { agent, onGuide() {} }));
  const high = renderToStaticMarkup(React.createElement(CognitionPanel, { agent: { ...agent, energy: 100 }, onGuide() {} }));
  assert.equal(low, high);
  for (const value of ["历史成长", "当前判断", "判断失准", "求证者"]) assert.ok(low.includes(value), value);
  assert.ok(!low.includes("SECRET_ROOT_CANARY"));
  assert.ok(!low.includes("CANARY_UNTRUSTED_LABEL"));
  assert.ok(!COGNITION_STAGES[2].principle.includes("换个条件"));
});

test("absent cognition feedback stays absent instead of implying healthy or recovered", () => {
  assert.equal(renderToStaticMarkup(React.createElement(CognitionFeedback, { agent: { id: "A1", energy: 100 } })), "");
  for (const [state, expected] of [["stable", "暂无待复核记录"], ["review", "待复核"], ["misaligned", "判断失准"], ["rebuilding", "正在重建"], ["recovered", "已复核"]]) {
    const html = renderToStaticMarkup(React.createElement(CognitionFeedback, { agent: { cognitionFeedback: feedback(state) } }));
    assert.ok(html.includes(expected));
  }
});

test("essential facts stay outside collapsed details and distinguish counterexample and formal discovery", () => {
  const html = render(updatedFixture());
  const visible = html.slice(0, html.indexOf('<details class="b-ending-details"'));
  for (const expected of ["调查未竟", "个人成长与当前判断", "判断失准", "两案关键时点", "反例形成", "T76", "正式发现", "T129", "尚未完成", "源头待指认"]) assert.ok(visible.includes(expected), expected);
  assert.ok(!visible.includes("SECRET_ROOT_CANARY"));
  const preview = render(updatedFixture(), true);
  assert.ok(!preview.includes("data-essential-facts"));
  assert.ok(!preview.includes("判断失准"));
});

test("live-only continuation and source actions require callbacks and remain absent from previews", () => {
  const withActions = (value, preview = false) => renderToStaticMarkup(React.createElement(EndingCard, { paradigm: value, preview, onContinue() {}, onInvestigate() {} }));
  assert.ok(withActions(updatedFixture()).includes("继续调查"));
  assert.ok(!render(updatedFixture()).includes("继续调查"));
  assert.ok(!withActions(updatedFixture(), true).includes("继续调查"));
  assert.ok(withActions(updatedFixture("awaiting_trace")).includes("追查源头"));
  assert.ok(withActions(updatedFixture()).includes("追查源头"));
  const complete = updatedFixture("partial");
  complete.b_outcome.can_continue = false;
  assert.ok(withActions(complete).includes("追查源头"));
  complete.b_outcome.pending_incident_ids = [];
  assert.ok(!withActions(complete).includes("追查源头"));
});

test("six themes each expose their own artwork and clearly labelled visual samples", () => {
  const slugs = new Set();
  for (const [name, art] of Object.entries(ENDING_ART)) {
    const html = render(fixture({ name, choices: {} }), true); slugs.add(art.slug);
    assert.ok(html.includes(`/b/art/endings-v2/${art.slug}.png`));
    assert.ok(html.includes('data-preview="true"'));
    assert.ok(html.includes("视觉预览 · 非本局成绩"));
    assert.ok(html.includes("造型预览"));
  }
  assert.equal(slugs.size, 6);
});

test("sixteen integrated artworks preserve the image title and motto without a duplicate visible heading", () => {
  for (const card of COOPERATION_DECK) {
    const html = render(cooperationPreview(card), true);
    assert.ok(html.includes(card.artwork));
    assert.ok(html.includes(`data-cooperation-card="${card.id}"`));
    assert.ok(html.includes("协作路径预览 · 不是已达成结局"));
    assert.ok(!html.includes("b-card-heading"));
    assert.ok(!html.includes("b-card-receipt"));
    assert.ok(!html.includes("b-sculpture-wrap"));
    assert.ok(!html.includes("b-ending-details"));
    assert.ok(!html.includes("JSON 协议"));
  }
});

test("gallery exposes sixteen paths without claiming sixteen achieved outcomes", () => {
  const html = renderToStaticMarkup(React.createElement(EndingGallery, { wall: [], onOpen() {} }));
  assert.equal((html.match(/data-cooperation-card=/g) || []).length, 16);
  assert.ok(html.includes("不等于 16 种结局"));
  assert.ok(html.includes("真实存档"));
  assert.ok(!html.includes("六种结局"));
  for (const card of COOPERATION_DECK) assert.ok(html.includes(card.artwork));
});

test("a preview hides genuine-looking input metrics, JSON, QR, choices and saved cognition", () => {
  const value = fixture({ seed: 889941, metrics: { attack1: { spread: 9182, bad_actions: 9175 }, attack2: { spread: 9183, bad_actions: 9176 } },
    rules: ["CANARY_RULE"], memberCognition: [{ agentId: "A1", stage: 4, name: "引路者" }] });
  const html = render(value, true);
  for (const forbidden of ["9182", "9183", "9175", "9176", "889941", "CANARY_RULE", "/api/paradigm/cards/", "JSON 协议", 'data-cognition-stage="4"', "ACTUAL RUN", "data-ending-value="])
    assert.ok(!html.includes(forbidden), forbidden);
});

test("real saved cards preserve JSON/QR, actual cognition, insights and both timelines", () => {
  const html = render(fixture());
  for (const expected of ["/api/paradigm/cards/REAL-CARD-1/qr", "JSON 协议", 'data-cognition-stage="3"', "阶段未记录", "协作留下了什么", 'data-attack-number="1"', 'data-attack-number="2"', "两案发现时间线", "历史", "不计作负耗时"])
    assert.ok(html.includes(expected), expected);
  assert.ok(!html.includes("注入后 -13"));
  assert.ok(html.includes('/b/art/cooperation-v3/aa.png'));
  assert.ok(html.includes('class="b-ending-details"'));
  assert.ok(!html.includes('class="b-ending-details" open=""'));
  assert.ok(!html.includes('class="relic-stage"'));
  assert.ok(html.includes("本局真实结果"));
});

test("old cards do not derive member stages or incident outcomes from their ending theme", () => {
  const value = fixture({ memberCognition: undefined, metrics: { attack1: { spread: 2, detect_turns: null, repair_turns: null, bad_actions: 0 }, attack2: { spread: 1, detect_turns: null, repair_turns: null, bad_actions: 0 } } });
  const html = render(value);
  assert.equal((html.match(/阶段未记录/g) || []).length, 5);
  assert.ok(!html.includes('data-cognition-stage="4"'));
  assert.ok(html.includes("未记录"));
});

test("fixed ending slogans never become real incident conclusions, including legacy cards", () => {
  const runs = JSON.parse(readFileSync(path.join(root, "docs/cooperation-deck-v3/runs.json"), "utf8"));
  for (const run of runs.paths) {
    const original = structuredClone(run.paradigm);
    for (const choices of [original.choices, {}]) {
      const card = { ...original, choices };
      const html = render(card);
      assert.ok(!html.includes(original.tagline), run.path);
      assert.ok(html.includes(original.name));
    }
    assert.deepEqual(original, run.paradigm);
  }
});

test("metrics do not promise first discovery and repeated warnings are presented once", () => {
  const html = render(fixture());
  assert.ok(html.includes("发现 / 争议")); assert.ok(!html.includes("首次发现"));
  assert.equal(html.split("负发现指标不是更快发现，也不能归零").length - 1, 1);
  assert.equal(html.split("对照调查形成修正规则，旧说法已撤回；不等于玩家已指认源头。").length - 1, 1);
});

test("old relative time remains visible even when an absolute discovery turn is absent", () => {
  const value = fixture(); delete value.metrics.attack1.injected_turn;
  const html = render(value);
  assert.ok(html.includes("绝对回合未记录 · 注入后 6 回合"));
});

test("long cards retain an optional closing icon after all content without affecting PNG controls", () => {
  const html = renderToStaticMarkup(React.createElement(EndingCard, { paradigm: fixture(), onClose() {} }));
  assert.ok(html.includes('aria-label="关闭部落卡"'));
  assert.ok(html.includes('aria-label="关闭部落卡（底部）"'));
  assert.ok(html.lastIndexOf('aria-label="关闭部落卡（底部）"') > html.lastIndexOf("JSON 协议"));
  assert.ok(!render(fixture()).includes('aria-label="关闭部落卡（底部）"'));
});

async function withCanvas(run, { missingArtwork = false, deferImages = false } = {}) {
  const originals = { document: globalThis.document, Image: globalThis.Image, create: URL.createObjectURL, revoke: URL.revokeObjectURL, timeout: globalThis.setTimeout };
  const timers = [];
  globalThis.setTimeout = (...args) => { const timer = originals.timeout(...args); timers.push(timer); return timer; };
  const texts = [], requested = [], images = [], downloads = [], blobs = [], revoked = [], pendingImages = [];
  const context = { font: "24px sans-serif", fillStyle: "", measureText(value) {
    const size = Number(this.font.match(/([\d.]+)px/)?.[1] || 24);
    return { width: [...value].reduce((sum, char) => sum + (/[^\x00-\xff]/.test(char) ? size : size * .55), 0) };
  }, fillText(value, x, y) { texts.push({ value, x, y, font: this.font, width: this.measureText(value).width }); },
  fillRect() {}, drawImage(image, x, y, width, height) { images.push({ source: image.src, x, y, width, height }); } };
  const canvas = { width: 0, height: 0, getContext: () => context, toBlob: callback => callback(new Blob(["png-test"])) };
  globalThis.document = { fonts: { ready: Promise.resolve() }, createElement(type) {
    if (type === "canvas") return canvas;
    if (type === "a") return { href: "", download: "", click() { downloads.push(this.download); } };
    throw new Error(`Unexpected element ${type}`);
  } };
  globalThis.Image = class {
    width = 1536; height = 1152;
    set src(value) {
      if (value.includes("/cooperation-v3/")) { this.width = 1200; this.height = 1600; }
      this.source = value; requested.push(value);
      const complete = () => missingArtwork && value.includes("/art/") ? this.onerror?.() : this.onload?.();
      if (deferImages) pendingImages.push(complete); else queueMicrotask(complete);
    }
    get src() { return this.source; }
  };
  URL.createObjectURL = blob => { blobs.push(blob); return `blob:check-${blobs.length}`; };
  URL.revokeObjectURL = url => revoked.push(url);
  try { return await run({ canvas, texts, requested, images, downloads, blobs, revoked, pendingImages }); }
  finally { timers.forEach(clearTimeout); globalThis.setTimeout = originals.timeout; globalThis.document = originals.document; globalThis.Image = originals.Image; URL.createObjectURL = originals.create; URL.revokeObjectURL = originals.revoke; }
}

test("compact PNG contains the full integrated artwork and real receipt, keeping all content above the footer", async () => {
  await withCanvas(async ({ canvas, texts, images, requested }) => {
    await downloadPng(fixture(), "data:sculpture");
    const content = texts.map(item => item.value).join(" ");
    for (const expected of ["本局真实结果", "敲锣部落", "第一案", "第二案", "历史", "原始值保留在 JSON", "发现 / 争议"])
      assert.ok(content.includes(expected), expected);
    assert.ok(!requested.some(url => url.endsWith("/qr")));
    assert.ok(!requested.includes("data:sculpture"));
    assert.ok(canvas.height > 1800 && canvas.height < 2700, String(canvas.height));
    assert.equal(images[0].source, "/b/art/cooperation-v3/aa.png");
    assert.ok(Math.abs(images[0].height / images[0].width - 4 / 3) < 1e-10);
    assert.equal(images[0].x, 0); assert.equal(images[0].y, 0);
    assert.ok(!content.includes(COOPERATION_DECK[0].title));
    assert.ok(texts.every(item => item.y < canvas.height - 30), "no text is clipped by the lower edge");
    assert.ok(images.every(item => item.y + item.height <= canvas.height - 30), "no media is clipped");
    assert.ok(texts.every(item => item.x + item.width <= 1100), "no text exceeds the right edge");
  });
});

test("long investigation rules remain in the JSON and details, not the compact artwork receipt", async () => {
  let shortHeight;
  await withCanvas(async ({ canvas }) => { await downloadPng(fixture(), "data:sculpture"); shortHeight = canvas.height; });
  await withCanvas(async ({ canvas, texts }) => {
    await downloadPng(fixture({ rules: Array.from({ length: 8 }, () => "核对不同地域与天气下的真实回执，保留反例与未确认的边界。".repeat(5)) }), "data:sculpture");
    assert.equal(canvas.height, shortHeight);
    assert.ok(!texts.some(item => item.value.includes("核对不同地域")));
    assert.ok(texts.every(item => item.y < canvas.height - 30));
  });
});

test("preview PNG never requests QR or prints scores, seed, protocol JSON or achieved stages", async () => {
  await withCanvas(async ({ texts, requested, downloads }) => {
    await downloadPng(fixture({ seed: 885522, rules: ["CANARY_RULE"] }), "data:sculpture", { preview: true });
    const content = texts.map(item => item.value).join(" ");
    assert.ok(content.includes("协作路径预览 · 不是已达成结局"));
    assert.ok(!requested.some(url => url.includes("/api/")));
    for (const forbidden of ["885522", "CANARY_RULE", "ACTUAL RUN", "SEED", "III 求证者", "协作留下了什么"])
      assert.ok(!content.includes(forbidden), forbidden);
    assert.ok(downloads[0].includes("视觉预览"));
  });
});

test("missing artwork yields an honest PNG fallback while preserving real data", async () => {
  await withCanvas(async ({ canvas, texts, images }) => {
    await downloadPng(fixture(), "data:sculpture");
    const content = texts.map(item => item.value).join(" ");
    assert.ok(content.includes("原画尚未载入"));
    assert.ok(content.includes("本局真实结果"));
    assert.equal(images.length, 0);
    assert.ok(texts.every(item => item.y < canvas.height - 30));
  }, { missingArtwork: true });
});

test("JSON download retains the exact original payload with no derived insights mutation", async () => {
  await withCanvas(async ({ blobs }) => {
    const original = fixture(), before = JSON.stringify(original);
    downloadJson(original);
    assert.deepEqual(JSON.parse(await blobs[0].text()), JSON.parse(before));
    assert.equal(JSON.stringify(original), before);
  });
});

test("new PNG shares factual outcome, historical growth, current feedback and separate incident times", async () => {
  await withCanvas(async ({ canvas, texts }) => {
    await downloadPng(updatedFixture(), null, { download: false });
    const content = texts.map(item => item.value).join(" ");
    for (const expected of ["调查未竟", "个人成长", "判断失准", "反例形成：T76", "正式发现：T129", "尚未结案", "源头待指认", "当前状态未记录"]) assert.ok(content.includes(expected), expected);
    assert.ok(!content.includes("SECRET_ROOT_CANARY"));
    assert.ok(canvas.height < 2700, String(canvas.height));
    assert.ok(texts.every(item => item.y < canvas.height - 30 && item.x + item.width <= 1100));
  });
});

test("HTML and PNG show the same saved source confirmation turn with explicit old-record gaps", async () => {
  const card = updatedFixture();
  card.caseChronology[0].source_confirmed = true;
  card.caseChronology[0].source_confirmed_turn = 80;
  card.caseChronology[1].source_confirmed = true;
  const html = render(card);
  assert.ok(html.includes("T80"));
  assert.ok(html.includes("已指认 · 回合未记录"));
  await withCanvas(async ({ texts, canvas }) => {
    await downloadPng(card, null, { download: false });
    const content = texts.map(item => item.value).join(" ");
    assert.ok(content.includes("玩家指认：T80"));
    assert.ok(content.includes("已指认 · 回合未记录"));
    assert.ok(texts.every(item => item.y < canvas.height - 30 && item.x + item.width <= 1100));
  });
});

test("all sixteen isolated reference runs retain their actual outcomes in compact non-clipped PNGs", async () => {
  const matrix = JSON.parse(readFileSync(path.join(root, "docs/cooperation-deck-v3/runs.json"), "utf8"));
  assert.equal(matrix.paths.length, 16);
  const heights = [];
  for (const route of matrix.paths) {
    const original = JSON.stringify(route.paradigm);
    const html = render(route.paradigm);
    assert.ok(html.includes(`data-cooperation-card="${route.path.toLowerCase()}"`));
    assert.ok(html.includes(route.paradigm.name));
    await withCanvas(async ({ canvas, texts, images }) => {
      await downloadPng(route.paradigm, null, { download: false });
      const content = texts.map(item => item.value).join(" ");
      assert.ok(content.includes(route.paradigm.name));
      assert.ok(images[0].source.endsWith(`/${route.path.toLowerCase()}.png`));
      assert.ok(texts.every(item => item.y < canvas.height - 30 && item.x + item.width <= 1100));
      assert.ok(canvas.height < 2700, `${route.path}: ${canvas.height}`);
      heights.push(canvas.height);
    });
    assert.equal(JSON.stringify(route.paradigm), original);
  }
  assert.ok(Math.min(...heights) > 1800);
});

function findElement(node, predicate) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) return node.map(item => findElement(item, predicate)).find(Boolean) || null;
  if (predicate(node)) return node;
  return findElement(node.props?.children, predicate);
}

function componentHarness() {
  const slots = [], pendingEffects = [], writes = [];
  let cursor = 0;
  const slot = (initialize) => {
    const index = cursor++;
    if (!slots[index]) slots[index] = initialize();
    return slots[index];
  };
  const hooks = {
    useRef(value) { return slot(() => ({ value: { current: value } })).value; },
    useState(value) {
      const entry = slot(() => ({ value: typeof value === "function" ? value() : value }));
      return [entry.value, next => { entry.value = typeof next === "function" ? next(entry.value) : next; writes.push(entry.value); }];
    },
    useEffect(effect, deps) {
      const entry = slot(() => ({ deps: null, cleanup: null }));
      if (!entry.deps || deps.some((value, index) => !Object.is(value, entry.deps[index]))) {
        pendingEffects.push(() => { entry.cleanup?.(); entry.cleanup = effect(); entry.deps = deps; });
      }
    },
  };
  const local = { exports: {} };
  const localRequire = name => name === "react" ? { ...React, ...hooks } : require(name);
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(localRequire, local, local.exports);
  const findButton = node => {
    if (!node || typeof node !== "object") return null;
    if (Array.isArray(node)) return node.map(findButton).find(Boolean);
    if (node.type === "button" && node.props.className === "game-button primary") return node;
    return findButton(node.props?.children);
  };
  return {
    writes,
    render(props) {
      cursor = 0;
      const tree = local.exports.EndingCard(props);
      pendingEffects.splice(0).forEach(effect => effect());
      return tree;
    },
    renderGallery(props) {
      cursor = 0;
      const tree = local.exports.EndingGallery(props);
      pendingEffects.splice(0).forEach(effect => effect());
      return tree;
    },
    captureWith(capture) { slots[0].value.current = { capture }; },
    clickExport(tree) { const button = findButton(tree); assert.ok(button); button.props.onClick(); },
    unmount() { slots.forEach(entry => entry.cleanup?.()); },
  };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test("3D mounts only when the real card detail is opened, and preserves frozen member stages", () => {
  const harness = componentHarness(), paradigm = fixture();
  const props = { paradigm, preview: false };
  let tree = harness.render(props);
  const model = node => node.props?.memberCognition === paradigm.memberCognition;
  assert.equal(findElement(tree, model), null);
  findElement(tree, node => node.type === "details").props.onToggle({ currentTarget: { open: true } });
  tree = harness.render(props); assert.ok(findElement(tree, model));
  findElement(tree, node => node.type === "details").props.onToggle({ currentTarget: { open: false } });
  tree = harness.render(props); assert.equal(findElement(tree, model), null);
  harness.unmount();
});

test("gallery opens previews explicitly and passes original real records unchanged", () => {
  const harness = componentHarness(), opened = [], paradigm = fixture();
  const props = { wall: [{ id: "saved", date: "2026/09/24", seed: 42, paradigm }], onOpen: (...args) => opened.push(args) };
  let tree = harness.renderGallery(props);
  findElement(tree, node => node.props?.["data-cooperation-card"] === "aa").props.onClick();
  assert.equal(opened[0][1], true); assert.ok(opened[0][0].name.startsWith("协作路径 ·"));
  assert.equal(opened[0][0].seed, undefined); assert.equal(opened[0][0].id, undefined);
  assert.deepEqual(opened[0][0].choices, { D2: "A", D3: "A" });
  const event = { key: "End", preventDefault() {} };
  findElement(tree, node => node.props?.role === "tablist").props.onKeyDown(event);
  tree = harness.renderGallery(props);
  assert.equal(findElement(tree, node => node.props?.id === "ending-relic-tab").props["aria-selected"], true);
  findElement(tree, node => node.props?.["aria-label"] === "预览敲锣部落3D勋章").props.onClick();
  assert.equal(opened[1][0].name, "敲锣部落"); assert.equal(opened[1][1], true); assert.equal(opened[1][2], "relic");
  findElement(tree, node => node.props?.id === "ending-records-tab").props.onClick();
  tree = harness.renderGallery(props);
  assert.equal(findElement(tree, node => node.props?.id === "ending-records-tab").props["aria-selected"], true);
  assert.equal(findElement(tree, node => node.type === "p" && node.props.children === paradigm.tagline), null);
  findElement(tree, node => node.type === "button" && node.props.className?.includes("ending-record-item")).props.onClick();
  assert.equal(opened[2][0], paradigm); assert.equal(opened[2][1], false);
  harness.unmount();
});

test("relic presentation mounts directly without details and exports its actual captured image", async () => {
  const html = renderToStaticMarkup(React.createElement(EndingCard, { paradigm: fixture({ choices: {} }), preview: true, initialPresentation: "relic" }));
  assert.ok(html.includes('data-presentation="relic"'));
  assert.ok(html.includes("非已解锁勋章"));
  assert.ok(html.includes("3D勋章 PNG"));
  assert.ok(!html.includes('class="b-ending-scene"'));
  await withCanvas(async ({ requested, images }) => {
    await downloadPng(fixture(), "data:actual-relic-capture", { preview: true, download: false, presentation: "relic" });
    assert.deepEqual(requested, ["data:actual-relic-capture"]);
    assert.equal(images[0].source, "data:actual-relic-capture");
    assert.equal(await downloadPng(fixture(), null, { presentation: "relic" }), null);
  });
});

for (const change of ["unmount", "preview-mode", "card-switch"]) test(`late PNG for ${change} is revoked without state writes or a stale download`, async () => {
  await withCanvas(async ({ pendingImages, blobs, revoked, downloads }) => {
    const harness = componentHarness(), card = fixture();
    const tree = harness.render({ paradigm: card, preview: true });
    harness.captureWith(() => assert.fail("Compact PNG must not capture or create 3D")); harness.clickExport(tree);
    await flush(); assert.ok(pendingImages.length, "PNG image work started");
    if (change === "unmount") harness.unmount();
    else harness.render({ paradigm: change === "card-switch" ? fixture({ id: "NEXT", choices: { D2: "D", D3: "D" } }) : card, preview: false });
    const writes = harness.writes.length;
    for (let attempt = 0; attempt < 8; attempt++) { pendingImages.splice(0).forEach(complete => complete()); await flush(); }
    assert.equal(blobs.length, 1); assert.deepEqual(revoked, ["blob:check-1"]);
    assert.equal(harness.writes.length, writes); assert.equal(downloads.length, 0);
    if (change !== "unmount") harness.unmount();
  }, { deferImages: true });
});
