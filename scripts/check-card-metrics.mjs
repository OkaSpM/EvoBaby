import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "frontend-b/package.json"));
const bundle = require("esbuild").buildSync({
  entryPoints: [path.join(root, "frontend-b/src/card-metrics.ts")],
  bundle: true, write: false, platform: "node", format: "cjs",
});
const compiled = { exports: {} };
new Function("module", "exports", bundle.outputFiles[0].text)(compiled, compiled.exports);
const { cardMetricLabels } = compiled.exports;
const metric = { spread: 1, bad_actions: 0, repair_turns: 2, detect_turns: -13, status: "PREVENTED" };
test("historical prevention is not a negative duration or zero", () => {
  const labels = cardMetricLabels(metric);
  assert.equal(labels.detection, "历史证据时间 *");
  assert.equal(labels.resolution, "2 回合");
  assert.match(labels.note, /原始值 -13/);
  assert.equal(metric.detect_turns, -13);
});
test("unknown historical outcomes do not invent prevention", () => {
  assert.equal(cardMetricLabels({ ...metric, status: undefined }).detection, "时间记录异常");
});
test("null and actual zero stay distinct", () => {
  assert.equal(cardMetricLabels({ ...metric, detect_turns: null }).detection, "发现时间未记录");
  assert.equal(cardMetricLabels({ ...metric, detect_turns: 0 }).detection, "0 回合");
});
test("revocation is a resolution duration, not called repair", () => {
  assert.equal(cardMetricLabels({ ...metric, status: "REVOKED", detect_turns: 1 }).resolution, "2 回合");
});
