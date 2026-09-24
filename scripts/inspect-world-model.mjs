import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frontend = path.join(root, "frontend-b");
const require = createRequire(path.join(frontend, "package.json"));
const ts = require("typescript");
const threeRoot = path.join(frontend, "node_modules/three");
const moduleUrl = relative => pathToFileURL(path.join(threeRoot, relative)).href;
const THREE = await import(moduleUrl("build/three.module.js"));
const { GLTFLoader } = await import(moduleUrl("examples/jsm/loaders/GLTFLoader.js"));

function argumentsFrom(argv) {
  const options = { model: null, widths: [8, 9.2, 9.6], offsets: [-.4, -.2, 0, .2, .4], x: 0, yaw: 0, json: null, selfTest: false, verifyBaked: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (!argument.startsWith("--")) { if (options.model) throw new Error("Only one input GLB is allowed"); options.model = argument; continue; }
    const [name, supplied] = argument.slice(2).split("=", 2);
    if (name === "help") return null;
    if (name === "self-test") { options.selfTest = true; continue; }
    if (name === "verify-baked") { options.verifyBaked = true; continue; }
    const value = supplied ?? argv[++index];
    if (value == null) throw new Error(`Missing value for --${name}`);
    if (name === "widths" || name === "offsets") {
      const numbers = value.split(",").map(Number);
      if (!numbers.length || numbers.some(number => !Number.isFinite(number))) throw new Error(`Invalid --${name}`);
      if (name === "widths" && numbers.some(number => number < 8 || number > 12)) throw new Error("Outer widths must be between 8 and 12");
      if (name === "offsets" && numbers.some(number => Math.abs(number) > 2)) throw new Error("Z offsets must stay within two world cells");
      options[name] = numbers;
    } else if (name === "x" || name === "yaw") {
      options[name] = Number(value);
      if (!Number.isFinite(options[name])) throw new Error(`Invalid --${name}`);
    } else if (name === "json") options.json = value;
    else throw new Error(`Unknown option --${name}`);
  }
  if (!options.model && !options.selfTest) return null;
  return options;
}

// Repack only an in-memory copy. Geometry bytes and the source GLB remain unchanged.
function geometryOnlyGlb(input) {
  if (input.length < 20 || input.readUInt32LE(0) !== 0x46546c67 || input.readUInt32LE(4) !== 2 || input.readUInt32LE(8) !== input.length) throw new Error("Input is not a valid GLB v2 container");
  let document, binary;
  for (let cursor = 12; cursor + 8 <= input.length;) {
    const length = input.readUInt32LE(cursor), type = input.readUInt32LE(cursor + 4);
    const start = cursor + 8, end = start + length;
    if (end > input.length) throw new Error("GLB chunk exceeds container length");
    if (type === 0x4e4f534a) document = JSON.parse(input.subarray(start, end).toString("utf8"));
    if (type === 0x004e4942) binary = input.subarray(start, end);
    cursor = end;
  }
  if (!document) throw new Error("GLB has no JSON document");
  if ((document.buffers ?? []).some(buffer => buffer.uri && !buffer.uri.startsWith("data:"))) throw new Error("External geometry buffers are not allowed in this offline inspection");
  if ((document.extensionsUsed ?? []).some(extension => ["KHR_draco_mesh_compression", "EXT_meshopt_compression"].includes(extension))) throw new Error("Compressed geometry requires a local decoder; refusing any network decoder fallback");
  document.materials = (document.materials?.length ? document.materials : [{}]).map(material => ({ doubleSided: material.doubleSided ?? false, pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 } }));
  delete document.images;
  delete document.textures;
  delete document.samplers;
  const used = new Set(["KHR_texture_basisu", "EXT_texture_webp", "EXT_texture_avif", "KHR_texture_transform", "KHR_materials_unlit", "KHR_materials_pbrSpecularGlossiness", "KHR_materials_clearcoat", "KHR_materials_transmission", "KHR_materials_volume", "KHR_materials_ior", "KHR_materials_specular", "KHR_materials_sheen", "KHR_materials_iridescence", "KHR_materials_anisotropy", "KHR_materials_emissive_strength"]);
  document.extensionsUsed = (document.extensionsUsed ?? []).filter(extension => !used.has(extension));
  document.extensionsRequired = (document.extensionsRequired ?? []).filter(extension => !used.has(extension));
  const encoded = Buffer.from(JSON.stringify(document));
  const json = Buffer.alloc(Math.ceil(encoded.length / 4) * 4, 0x20);
  encoded.copy(json);
  const output = Buffer.alloc(12 + 8 + json.length + (binary ? 8 + binary.length : 0));
  output.writeUInt32LE(0x46546c67, 0); output.writeUInt32LE(2, 4); output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(json.length, 12); output.writeUInt32LE(0x4e4f534a, 16); json.copy(output, 20);
  if (binary) { const cursor = 20 + json.length; output.writeUInt32LE(binary.length, cursor); output.writeUInt32LE(0x004e4942, cursor + 4); binary.copy(output, cursor + 8); }
  return output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength);
}

async function sharedSurfaceFunctions() {
  const filename = path.join(frontend, "src/components/b-three-assets.ts");
  const source = await fs.readFile(filename, "utf8");
  const transformImports = context => node => {
    const visit = current => {
      if (ts.isImportDeclaration(current) && ts.isStringLiteral(current.moduleSpecifier)) {
        const original = current.moduleSpecifier.text;
        const replacement = original === "three" ? moduleUrl("build/three.module.js") : original.startsWith("three/addons/") ? moduleUrl(`examples/jsm/${original.slice("three/addons/".length)}`) : null;
        if (replacement) return ts.factory.updateImportDeclaration(current, current.modifiers, current.importClause, ts.factory.createStringLiteral(replacement), current.attributes);
      }
      return ts.visitEachChild(current, visit, context);
    };
    return ts.visitNode(node, visit);
  };
  const compiled = ts.transpileModule(source, { fileName: filename, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false }, transformers: { before: [transformImports] } });
  return import(`data:text/javascript;base64,${Buffer.from(compiled.outputText).toString("base64")}`);
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  if (!options) {
    process.stdout.write("Usage: node scripts/inspect-world-model.mjs [model.glb] [--widths 8,9.2,9.6] [--offsets=-0.4,-0.2,0,0.2,0.4] [--x 0] [--yaw 0] [--json report.json] [--verify-baked] [--self-test]\n");
    return;
  }
  const { normalizedWorldModel, sampleWorldSurface, disposeObject, calibratedWorldModel, WORLD_CALIBRATION } = await sharedSurfaceFunctions();
  if (options.selfTest) {
    const makeFloor = (missing = false) => {
      const floor = new THREE.Group();
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        if (missing && x === 2 && y === 2) continue;
        const tile = new THREE.Mesh(new THREE.BoxGeometry(.98, .2, .98), new THREE.MeshBasicMaterial());
        tile.position.set(x - 3.5, .17, y - 3.5);
        floor.add(tile);
      }
      return floor;
    };
    const flat = makeFloor(), missing = makeFloor(true), roof = makeFloor();
    const obstruction = new THREE.Mesh(new THREE.PlaneGeometry(.85, .85), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    obstruction.rotation.x = -Math.PI / 2 + 1;
    obstruction.position.set(-.5, 1.1, -.5);
    roof.add(obstruction);
    const flatReport = await sampleWorldSurface(flat, 8, .27);
    assert.equal(flatReport.accepted, true);
    assert.equal(flatReport.heights.length, 64);
    assert.ok(flatReport.heights.every(height => Math.abs(height - .27) < 1e-6));
    const missingReport = await sampleWorldSurface(missing, 8, .27);
    assert.equal(missingReport.accepted, false);
    assert.ok(missingReport.invalidCells.some(cell => cell.x === 2 && cell.y === 2));
    const roofReport = await sampleWorldSurface(roof, 8, .27);
    assert.equal(roofReport.accepted, false);
    assert.ok(roofReport.invalidCells.some(cell => cell.x === 3 && cell.y === 3));
    assert.throws(() => calibratedWorldModel(flat), /asset-version-mismatch/);
    [flat, missing, roof].forEach(disposeObject);
    process.stderr.write("PASS flat64 / missing-cell / first-hit-steep-roof / unverified-calibration-rejected\n");
    if (!options.model) return;
  }
  const modelPath = path.resolve(options.model);
  const original = await fs.readFile(modelPath);
  const sha256 = createHash("sha256").update(original).digest("hex");
  if (options.verifyBaked) {
    assert.equal(sha256, WORLD_CALIBRATION.sha256, "GLB hash does not match the baked calibration");
    options.widths = [WORLD_CALIBRATION.outer]; options.offsets = [WORLD_CALIBRATION.offsetZ];
    options.x = WORLD_CALIBRATION.offsetX; options.yaw = WORLD_CALIBRATION.yaw * 180 / Math.PI;
  }
  const gltf = await new GLTFLoader().parseAsync(geometryOnlyGlb(original), "");
  const sourceBounds = new THREE.Box3().setFromObject(gltf.scene);
  const sourceExtent = sourceBounds.getSize(new THREE.Vector3());
  const report = { model: modelPath, sha256, originalBytes: original.length, sourceExtent: sourceExtent.toArray(), grid: [8, 8], normalization: "outer extent tested separately from the fixed internal 8x8 sample grid", heightsAreWorldUnits: true, texturesLoaded: false, candidates: [] };
  for (const outer of options.widths) for (const z of options.offsets) {
    const start = performance.now();
    const model = new THREE.Group();
    model.add(normalizedWorldModel(gltf.scene, outer));
    model.rotation.y = options.yaw * Math.PI / 180;
    model.position.set(options.x, 0, z);
    model.updateMatrixWorld(true);
    const surface = await sampleWorldSurface(model, 8, .27);
    if (options.verifyBaked) {
      assert.equal(surface.accepted, true, "Baked world failed the first-hit surface guard");
      surface.heights.forEach((height, index) => assert.ok(Math.abs(height - WORLD_CALIBRATION.heights[index]) < 1e-6, `Baked height mismatch at cell ${index}`));
      assert.ok(Math.abs(surface.rawGround - WORLD_CALIBRATION.rawGround) < 1e-6);
      gltf.scene.userData.verifiedAssetSha256 = sha256;
      const calibrated = calibratedWorldModel(gltf.scene);
      const actualBounds = new THREE.Box3().setFromObject(model), bakedBounds = new THREE.Box3().setFromObject(calibrated.model);
      assert.ok(actualBounds.min.distanceTo(bakedBounds.min) < 1e-6 && actualBounds.max.distanceTo(bakedBounds.max) < 1e-6, "Baked transform differs from inspected geometry");
      disposeObject(calibrated.model);
      process.stderr.write("PASS exact GLB hash / 64 baked heights / identical calibrated transform\n");
    }
    const candidate = { outer, offsetX: options.x, offsetZ: z, yawDegrees: options.yaw, accepted: surface.accepted, min: surface.min, max: surface.max, rawGround: surface.rawGround, rawMin: surface.rawMin, rawMax: surface.rawMax, invalid_cells: surface.invalidCells, probeCount: surface.probeCount, milliseconds: Math.round(performance.now() - start), heights: surface.heights, probeDetails: surface.probeDetails };
    report.candidates.push(candidate);
    process.stderr.write(`${report.candidates.length}/${options.widths.length * options.offsets.length} outer=${outer} z=${z} accepted=${surface.accepted} invalid=${surface.invalidCells.length} range=${surface.min.toFixed(3)}..${surface.max.toFixed(3)} ${candidate.milliseconds}ms\n`);
    disposeObject(model);
  }
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (options.json) await fs.writeFile(path.resolve(options.json), output);
  process.stdout.write(output);
}

main().catch(error => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; });
