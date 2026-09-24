import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "frontend-b/package.json"));
const built = require("esbuild").buildSync({ stdin: { contents: 'export * from "./src/resource-assets"; export * as THREE from "three"; export { disposeObject } from "./src/components/b-three-assets";', resolveDir: path.join(root, "frontend-b"), loader: "ts" }, bundle: true, write: false, platform: "node", format: "esm", target: "es2022", logLevel: "silent" });
const { RESOURCE_ASSETS, resourceAssetInstance, THREE, disposeObject } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString("base64")}`);

test("three resources use distinct local GLBs, not CDN assets", () => {
  assert.deepEqual(Object.keys(RESOURCE_ASSETS), ["Berry", "Crystal", "Moss"]);
  for (const [type, value] of Object.entries(RESOURCE_ASSETS)) assert.equal(value.path, `/b/models/expanded-v2/resource-${type.toLowerCase()}.glb`);
});
test("every rotation stays within one grid cell, bottom aligned and height limited", () => {
  for (const [type, spec] of Object.entries(RESOURCE_ASSETS)) {
    const source = new THREE.Group();
    source.add(new THREE.Mesh(new THREE.BoxGeometry(2, 3, 5), new THREE.MeshStandardMaterial()));
    for (let rotation = 0; rotation < 12; rotation++) {
      const object = resourceAssetInstance(type, source);
      object.rotation.y = rotation * Math.PI / 6;
      const bounds = new THREE.Box3().setFromObject(object), size = bounds.getSize(new THREE.Vector3());
      assert.ok(size.x <= spec.footprint + 1e-6 && size.z <= spec.footprint + 1e-6);
      assert.ok(size.y <= spec.height + 1e-6);
      assert.ok(Math.abs(bounds.min.y) < 1e-6);
      assert.equal(object.userData.tripoResource, type);
      disposeObject(object);
    }
  }
});
test("missing and empty model fall back without falsely labelling a GLB", () => {
  for (const type of Object.keys(RESOURCE_ASSETS)) {
    const first = resourceAssetInstance(type), empty = resourceAssetInstance(type, new THREE.Group());
    assert.ok(first.children.length && empty.children.length);
    assert.equal(first.userData.tripoResource, undefined);
    assert.equal(empty.userData.tripoResource, undefined);
    disposeObject(first); disposeObject(empty);
  }
});
test("disposing a resource clone preserves shared source geometry and material", () => {
  const geometry = new THREE.BoxGeometry(1, 1, 1), material = new THREE.MeshStandardMaterial();
  let disposed = 0;
  geometry.addEventListener("dispose", () => disposed++); material.addEventListener("dispose", () => disposed++);
  const source = new THREE.Group(); source.add(new THREE.Mesh(geometry, material));
  const object = resourceAssetInstance("Berry", source);
  disposeObject(object);
  assert.equal(disposed, 0);
  assert.deepEqual(source.scale.toArray(), [1, 1, 1]);
});
