import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "frontend-b/package.json"));
const { buildSync } = require("esbuild");
const built = buildSync({ stdin: { contents: 'export * from "./src/world-props"; export * as THREE from "three"; export { disposeObject } from "./src/components/b-three-assets";',
  resolveDir: path.join(root, "frontend-b"), loader: "ts" }, bundle: true, write: false, platform: "node", format: "esm", target: "es2022", logLevel: "silent" });
const { placeWorldProps, publicPropEventPosition, propFitFactor, worldPropStatus, fitWorldPropModel, WORLD_PROPS, THREE, disposeObject } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString("base64")}`);
const event = (update = {}) => ({ event_id: "E1", type: "ACTION_EXECUTED", turn: 12, agent_id: "A1",
  observation: { position: [5, 2], region: "NE", weather: "Rain" }, result: { action: "USE_MOSS", success: true, object: "Moss", resource_effect: -8 }, ...update });
const incident = (update = {}) => ({ id: "I1", injectedTurn: 10, rootBeliefId: null, targetAgentId: null, ...update });

test("four facilities use only local expanded-v2 models with bounded dimensions", () => {
  assert.equal(WORLD_PROPS.length, 4);
  assert.deepEqual(WORLD_PROPS.map(item => item.id), ["evidence-workbench", "record-archive", "warning-gong", "moss-control-bench"]);
  for (const item of WORLD_PROPS) {
    assert.equal(item.path, `/b/models/expanded-v2/${item.id}.glb`);
    assert.ok(item.height > .4 && item.height < .9);
    assert.ok(item.footprint <= .64);
    assert.ok(item.rotation > -Math.PI / 2 && item.rotation < 0, "+X asset fronts face the positive X/Z camera");
  }
});

test("all 64 possible bases keep facilities unique, in bounds and off every cell center", () => {
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const placements = placeWorldProps(8, [x, y]);
    assert.equal(new Set(placements.map(item => item.gridPosition.join(","))).size, 4);
    for (const item of placements) {
      const [px, py] = item.gridPosition, half = item.footprint / 2;
      assert.equal(px % 1, .5);
      assert.equal(py % 1, .5);
      assert.ok(px - half >= -.5 && px + half <= 7.5 && py - half >= -.5 && py + half <= 7.5);
      assert.ok(Math.hypot(px - x, py - y) < 2.2, "facilities stay in the village band even at the map edge");
      for (let cy = 0; cy < 8; cy++) for (let cx = 0; cx < 8; cx++) {
        const clearance = Math.hypot(Math.max(0, Math.abs(px - cx) - half), Math.max(0, Math.abs(py - cy) - half));
        assert.ok(clearance >= .24, `cell ${cx},${cy} keeps center clearance from ${item.id}`);
      }
    }
  }
});

test("the control bench follows the public anomaly while village facilities remain at base", () => {
  const home = placeWorldProps(8, [3, 3]);
  const field = placeWorldProps(8, [3, 3], [7, 0]);
  assert.deepEqual(field.slice(0, 3), home.slice(0, 3));
  assert.equal(field[3].anchor, "public-event");
  assert.ok(Math.hypot(field[3].gridPosition[0] - 7, field[3].gridPosition[1]) < 1);
  assert.equal(home[3].anchor, "base");
});

test("all base and public-event combinations remain unique", () => {
  for (let base = 0; base < 64; base++) for (let point = 0; point < 64; point++) {
    const placements = placeWorldProps(8, [base % 8, Math.floor(base / 8)], [point % 8, Math.floor(point / 8)]);
    assert.equal(new Set(placements.map(item => item.gridPosition.join(","))).size, 4);
  }
});

test("missing or invalid public positions fall back to the existing base", () => {
  const expected = placeWorldProps(8, [3, 3]);
  assert.deepEqual(placeWorldProps(8, [3, 3], [NaN, 2]), expected);
  assert.deepEqual(placeWorldProps(8, [3, 3], [8, 0]), expected);
  assert.deepEqual(placeWorldProps(1, [0, 0]), []);
  assert.deepEqual(placeWorldProps(8, [-1, 0]), []);
});

test("public placement does not use hidden source, victim, lineage or omitted condition", () => {
  const baseline = publicPropEventPosition(8, 15, [incident()], [event()]);
  const revealed = publicPropEventPosition(8, 15, [incident({ rootBeliefId: "SECRET", targetAgentId: "A5", omittedCondition: "region",
    affectedAgentIds: ["A2", "A5"], lineage: [{ receiverAgentId: "A3" }] })], [event()]);
  assert.deepEqual(baseline, [5, 2]);
  assert.deepEqual(revealed, baseline);
});

test("future events and pre-incident events do not place future or unrelated facilities", () => {
  assert.equal(publicPropEventPosition(8, 9, [incident()], [event()]), null);
  assert.equal(publicPropEventPosition(8, 11, [incident()], [event()]), null);
  assert.equal(publicPropEventPosition(8, 15, [incident({ injectedTurn: 13 })], [event()]), null);
  assert.equal(publicPropEventPosition(8, 15, [], [event()]), null);
});

test("only a successful public Moss action with negative feedback moves the bench", () => {
  for (const altered of [event({ type: "OBSERVATION" }), event({ result: { action: "USE_MOSS", success: false, object: "Moss", resource_effect: -8 } }),
    event({ result: { action: "USE_BERRY", success: true, object: "Berry", resource_effect: -8 } }),
    event({ result: { action: "USE_MOSS", success: true, object: "Moss", resource_effect: 20 } }),
    event({ observation: { position: [8, 1] } })]) {
    assert.equal(publicPropEventPosition(8, 15, [incident()], [altered]), null);
  }
});

test("latest public action wins without mutating history or returned coordinates", () => {
  const older = event(), newer = event({ turn: 14, observation: { position: [1, 6] } });
  const events = Object.freeze([older, newer]);
  const selected = publicPropEventPosition(8, 15, [incident()], events);
  assert.deepEqual(selected, [1, 6]);
  selected[0] = 99;
  assert.deepEqual(newer.observation.position, [1, 6]);
  assert.equal(events[0], older);
});

test("model status counts only successfully attached GLBs", () => {
  assert.deepEqual(worldPropStatus({}), { status: "loading", count: 0, names: [] });
  const states = Object.fromEntries(WORLD_PROPS.map(item => [item.id, "fallback"]));
  assert.equal(worldPropStatus(states).status, "fallback");
  states["record-archive"] = "glb";
  assert.deepEqual(worldPropStatus(states), { status: "partial-glb", count: 1, names: ["record-archive"] });
  WORLD_PROPS.forEach(item => { states[item.id] = "glb"; });
  assert.equal(worldPropStatus(states).count, 4);
  assert.equal(worldPropStatus(states).status, "glb");
});

test("footprint fitting never enlarges a normalized model or accepts invalid bounds", () => {
  assert.equal(propFitFactor(.5, .4, .64), 1);
  assert.equal(propFitFactor(2, 1, .64), .32);
  assert.equal(propFitFactor(Infinity, 1, .64), null);
  assert.equal(propFitFactor(0, 1, .64), null);
});

test("model instances are bottom aligned and fit target footprint and height at every rotation", () => {
  for (const dimensions of [[1, 1, 1], [6, .4, 2], [.2, 4, .7]]) for (const definition of WORLD_PROPS) {
    const source = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(...dimensions), new THREE.MeshStandardMaterial());
    body.position.set(2, 3, -4);
    source.add(body);
    const instance = fitWorldPropModel(source, definition);
    const bounds = new THREE.Box3().setFromObject(instance), size = bounds.getSize(new THREE.Vector3());
    assert.ok(Math.abs(bounds.min.y) < .000001);
    assert.ok(size.y <= definition.height + .000001);
    assert.ok(size.x <= definition.footprint + .000001);
    assert.ok(size.z <= definition.footprint + .000001);
    assert.ok(Math.abs(bounds.getCenter(new THREE.Vector3()).x) < .000001);
    assert.ok(Math.abs(bounds.getCenter(new THREE.Vector3()).z) < .000001);
    assert.equal(instance.userData.decorative, true);
    disposeObject(instance);
    body.geometry.dispose(); body.material.dispose();
  }
});

test("disposing a fitted instance keeps cached source geometry and material alive", () => {
  const source = new THREE.Group(), geometry = new THREE.BoxGeometry(2, 1, 1), material = new THREE.MeshStandardMaterial({ color: "#66aa88" });
  source.add(new THREE.Mesh(geometry, material));
  let geometryDisposals = 0, materialDisposals = 0, clonedDisposals = 0;
  geometry.addEventListener("dispose", () => geometryDisposals++);
  material.addEventListener("dispose", () => materialDisposals++);
  const instance = fitWorldPropModel(source, WORLD_PROPS[0]);
  instance.traverse(node => { if (node instanceof THREE.Mesh) { assert.equal(node.geometry, geometry); assert.notEqual(node.material, material); node.material.addEventListener("dispose", () => clonedDisposals++); } });
  disposeObject(instance);
  assert.equal(geometryDisposals, 0);
  assert.equal(materialDisposals, 0);
  assert.equal(clonedDisposals, 1);
  assert.equal(source.parent, null);
  assert.deepEqual(source.position.toArray(), [0, 0, 0]);
});

test("empty or degenerate models fail cleanly rather than showing a GLB success state", () => {
  assert.throws(() => fitWorldPropModel(new THREE.Group(), WORLD_PROPS[0]), /Invalid prop model bounds/);
});

test("four installed files are real self-contained GLBs", { skip: process.env.CHECK_EXPANDED_MODELS !== "1" }, () => {
  for (const definition of WORLD_PROPS) {
    const bytes = readFileSync(path.join(root, "frontend-b/public", definition.path.replace(/^\/b\//, "")));
    assert.equal(bytes.readUInt32LE(0), 0x46546c67);
    assert.equal(bytes.readUInt32LE(4), 2);
    assert.equal(bytes.readUInt32LE(8), bytes.length);
    assert.equal(bytes.readUInt32LE(16), 0x4e4f534a);
    const data = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString("utf8"));
    assert.ok(data.meshes?.length > 0);
    assert.ok(data.accessors?.some(item => item.type === "VEC3" && item.count > 0));
    assert.ok((data.buffers ?? []).every(item => !item.uri));
    assert.ok((data.images ?? []).every(item => item.bufferView !== undefined || item.uri?.startsWith("data:")));
  }
});
