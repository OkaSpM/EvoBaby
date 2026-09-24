import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "frontend-b/package.json"));
const output = require("esbuild").buildSync({ entryPoints: [path.join(root, "frontend-b/src/cooperation-deck.ts")], bundle: true, write: false, platform: "node", format: "cjs" });
const compiled = { exports: {} };
new Function("module", "exports", output.outputFiles[0].text)(compiled, compiled.exports);
const { COOPERATION_DECK, resolveCooperationCard, cooperationPreview } = compiled.exports;

test("deck exhausts exactly D2 by D3, not sixteen fabricated ending classes", () => {
  assert.equal(COOPERATION_DECK.length, 16);
  assert.deepEqual(COOPERATION_DECK.map(card => card.id), [..."ABCD"].flatMap(d2 => [..."ABCD"].map(d3 => `${d2}${d3}`.toLowerCase())));
  assert.equal(new Set(COOPERATION_DECK.map(card => card.title)).size, 16);
  assert.equal(new Set(COOPERATION_DECK.map(card => card.motto)).size, 16);
  assert.deepEqual(COOPERATION_DECK.map(card => card.number), Array.from({ length: 16 }, (_, index) => index + 1));
});

test("every card has its own local graphic and both explicit path choices", () => {
  for (const card of COOPERATION_DECK) {
    assert.equal(card.artwork, `/b/art/cooperation-v3/${card.id}.png`);
    assert.ok(card.pathLabel.includes(" · "));
    assert.equal(resolveCooperationCard({ choices: { D2: card.d2, D3: card.d3 } }), card);
  }
});

test("missing or invalid choices never acquire a made-up matching story", () => {
  for (const choices of [{}, { D2: "A" }, { D3: "C" }, { D2: "a", D3: "B" }, { D2: "A", D3: "Q" }, null, undefined]) {
    assert.equal(resolveCooperationCard({ choices }), null);
  }
});

test("actual ending, seed, metrics and D1/D4 do not get overwritten to fit art", () => {
  const record = { name: "另一种真实结局", choices: { D1: "C", D2: "B", D3: "D", D4: "C" }, seed: 107, metrics: { sample: 3 } };
  const before = structuredClone(record);
  assert.equal(resolveCooperationCard(record).id, "bd");
  assert.deepEqual(record, before);
});

test("path previews are labelled and have no attained identity or frozen progression", () => {
  for (const card of COOPERATION_DECK) {
    const preview = cooperationPreview(card);
    assert.match(preview.name, /^协作路径 · /);
    assert.deepEqual(preview.choices, { D2: card.d2, D3: card.d3 });
    for (const key of ["id", "seed", "completed_turn", "memberCognition"]) assert.equal(preview[key], undefined);
    assert.deepEqual(preview.protocol, {});
    assert.deepEqual(preview.rules, []);
    assert.equal(preview.metrics.attack1.detect_turns, null);
    assert.equal(preview.metrics.attack2.detect_turns, null);
  }
});

test("preview objects are independent, including both attack placeholders", () => {
  const first = cooperationPreview(COOPERATION_DECK[0]), second = cooperationPreview(COOPERATION_DECK[0]);
  first.choices.D2 = "D"; first.metrics.attack1.spread = 5;
  assert.equal(second.choices.D2, "A");
  assert.equal(second.metrics.attack1.spread, 0);
  assert.equal(first.metrics.attack2.spread, 0);
});

test("all sixteen final images are distinct complete portrait PNG files", { skip: process.env.CHECK_COOPERATION_ART !== "1" }, () => {
  const hashes = new Set();
  for (const card of COOPERATION_DECK) {
    const file = path.join(root, "frontend-b/public", card.artwork.replace(/^\/b\//, ""));
    const bytes = fs.readFileSync(file);
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", card.id);
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    assert.ok(width >= 960 && height >= 1280, `${card.id}: ${width}×${height}`);
    assert.ok(Math.abs(width / height - .75) < .025, `${card.id}: must preserve portrait 3:4 composition`);
    assert.ok(bytes.includes(Buffer.from("IEND")), card.id);
    hashes.add(createHash("sha256").update(bytes).digest("hex"));
  }
  assert.equal(hashes.size, 16, "Do not repeat one image to fill the deck");
});
