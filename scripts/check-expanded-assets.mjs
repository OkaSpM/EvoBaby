import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const names = ["evidence-workbench", "record-archive", "warning-gong", "moss-control-bench",
  ...["witness", "alarm", "pathfinder", "shelter", "forgetful", "confused"].map(name => `ending-${name}`),
  "resource-berry", "resource-crystal", "resource-moss"];
const reports = [];
for (const name of names) {
  const file = path.join(root, "frontend-b/public/models/expanded-v2", `${name}.glb`);
  const bytes = readFileSync(file);
  assert.equal(bytes.readUInt32LE(0), 0x46546c67, name);
  assert.equal(bytes.readUInt32LE(4), 2, name);
  assert.equal(bytes.readUInt32LE(8), bytes.length, name);
  assert.equal(bytes.readUInt32LE(16), 0x4e4f534a, name);
  const data = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString("utf8"));
  assert.ok((data.buffers ?? []).every(buffer => !buffer.uri), `${name}: external geometry dependency`);
  assert.ok(data.images?.length, `${name}: textured model required`);
  assert.ok(data.images.every(item => item.bufferView !== undefined || item.uri?.startsWith("data:")), `${name}: external image dependency`);
  assert.ok(!(data.extensionsRequired ?? []).some(item => ["KHR_draco_mesh_compression", "EXT_meshopt_compression", "KHR_texture_basisu"].includes(item)), `${name}: unavailable runtime decoder`);
  let triangles = 0;
  for (const mesh of data.meshes ?? []) for (const primitive of mesh.primitives) {
    assert.equal(primitive.mode ?? 4, 4, `${name}: expected triangles`);
    const index = primitive.indices ?? primitive.attributes.POSITION;
    triangles += data.accessors[index].count / 3;
    const positions = data.accessors[primitive.attributes.POSITION];
    assert.ok(positions.count > 0 && positions.type === "VEC3", name);
    assert.ok(positions.min?.every(Number.isFinite) && positions.max?.every(Number.isFinite), name);
  }
  assert.ok(triangles > 0 && triangles <= (name.startsWith("resource-") ? 6000 : 16000), `${name}: triangle budget ${triangles}`);
  assert.ok(bytes.length < 20 * 1024 * 1024, `${name}: excessive file size`);
  reports.push({ name, triangles, bytes: bytes.length, textures: data.images.length, sha256: createHash("sha256").update(bytes).digest("hex") });
}
console.log(JSON.stringify({ models: reports.length, totalBytes: reports.reduce((sum, item) => sum + item.bytes, 0), reports }, null, 2));
