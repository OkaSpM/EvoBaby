import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "frontend-b/package.json"));
const compiled = { exports: {} };
const bundle = require("esbuild").buildSync({ entryPoints: [path.join(root, "frontend-b/src/ending-catalog.ts")], bundle: true, write: false, platform: "node", format: "cjs" });
new Function("module", "exports", bundle.outputFiles[0].text)(compiled, compiled.exports);
const { ENDING_CATALOG, endingModelPath, endingArtworkPath, endingPreview } = compiled.exports;

test("six unique themes have local art and dedicated GLB paths", () => {
  assert.equal(ENDING_CATALOG.length, 6);
  assert.equal(new Set(ENDING_CATALOG.map(item => item.name)).size, 6);
  assert.equal(new Set(ENDING_CATALOG.map(item => endingModelPath(item.name))).size, 6);
  for (const item of ENDING_CATALOG) {
    assert.equal(endingModelPath(item.name), `/b/models/expanded-v2/ending-${item.slug}.glb`);
    assert.equal(endingArtworkPath(item.name), `/b/art/endings-v2/${item.slug}.png`);
  }
});
test("previews contain no invented run identity, choices, rules, or cognition", () => {
  for (const item of ENDING_CATALOG) {
    const preview = endingPreview(item.name);
    assert.equal(preview.name, item.name);
    for (const key of ["id", "seed", "completed_turn", "memberCognition"]) assert.equal(preview[key], undefined);
    assert.deepEqual(preview.choices, {});
    assert.deepEqual(preview.rules, []);
    assert.equal(preview.metrics.attack1.detect_turns, null);
  }
});
test("previews are independent objects; changing one cannot affect another", () => {
  const first = endingPreview("慎信部落"), second = endingPreview("慎信部落");
  first.metrics.attack1.spread = 5;
  assert.equal(second.metrics.attack1.spread, 0);
  assert.equal(first.metrics.attack2.spread, 0);
});
test("unknown historical ending never gets a different named model", () => {
  assert.equal(endingModelPath("旧结局"), null);
  assert.equal(endingArtworkPath("旧结局"), null);
});
