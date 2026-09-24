import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkeleton } from "three/addons/utils/SkeletonUtils.js";
import type { Resource } from "../types";
import type { WildlingState } from "./Wildling";

const modelCache = new Map<string, Promise<THREE.Group>>();

export function loadLocalModel(path: string, expectedSha256?: string): Promise<THREE.Group> {
  const key = `${path}:${expectedSha256 ?? "unverified"}`;
  if (!modelCache.has(key)) {
    const pending = (async () => {
      const loader = new GLTFLoader();
      if (!expectedSha256) return (await loader.loadAsync(path)).scene;
      const response = await fetch(path, { credentials: "same-origin" });
      if (!response.ok) throw new Error(`Model download failed: ${response.status}`);
      const bytes = await response.arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const sha256 = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
      if (sha256 !== expectedSha256) throw new Error("World model asset-version-mismatch");
      const scene = (await loader.parseAsync(bytes, path.slice(0, path.lastIndexOf("/") + 1))).scene;
      scene.userData.verifiedAssetSha256 = sha256;
      return scene;
    })();
    modelCache.set(key, pending);
    pending.catch(() => modelCache.delete(key));
  }
  return modelCache.get(key)!;
}

export function material(color: THREE.ColorRepresentation, roughness = .84) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness: .02 });
}

export function mesh(geometry: THREE.BufferGeometry, color: THREE.ColorRepresentation, position: [number, number, number], scale?: [number, number, number]) {
  const result = new THREE.Mesh(geometry, material(color));
  result.position.set(...position);
  if (scale) result.scale.set(...scale);
  result.castShadow = true;
  result.receiveShadow = true;
  return result;
}

export function disposeObject(root: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  root.traverse(node => {
    if (!(node instanceof THREE.Mesh) && !(node instanceof THREE.Line) && !(node instanceof THREE.Points)) return;
    if (node.geometry && !node.userData.sharedGeometry) geometries.add(node.geometry);
    (Array.isArray(node.material) ? node.material : [node.material]).forEach(item => materials.add(item));
  });
  geometries.forEach(item => item.dispose());
  materials.forEach(item => item.dispose());
}

function clonedModel(source: THREE.Group) {
  const object = cloneSkeleton(source);
  object.traverse(node => {
    if (!(node instanceof THREE.Mesh)) return;
    node.material = Array.isArray(node.material) ? node.material.map(item => item.clone()) : node.material.clone();
    node.userData.sharedGeometry = true;
    node.castShadow = true;
    node.receiveShadow = true;
  });
  return object;
}

export function normalizedModel(source: THREE.Group, height: number) {
  const object = clonedModel(source);
  const box = new THREE.Box3().setFromObject(object);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const scale = height / Math.max(size.y, .001);
  object.scale.multiplyScalar(scale);
  object.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
  const wrapper = new THREE.Group();
  wrapper.add(object);
  return wrapper;
}

export function normalizedWorldModel(source: THREE.Group, size: number) {
  const object = clonedModel(source);
  const bounds = new THREE.Box3().setFromObject(object);
  const extent = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const sx = size / Math.max(extent.x, .001), sz = size / Math.max(extent.z, .001);
  const sy = Math.min(sx, sz);
  const wrapper = new THREE.Group();
  wrapper.add(object);
  wrapper.scale.set(sx, sy, sz);
  wrapper.position.set(-center.x * sx, -bounds.min.y * sy - .65, -center.z * sz);
  wrapper.updateMatrixWorld(true);
  return wrapper;
}

export interface WorldSurfaceReport {
  accepted: boolean;
  heights: number[];
  min: number;
  max: number;
  rawGround: number | null;
  rawMin: number | null;
  rawMax: number | null;
  invalidCells: { x: number; y: number; reason: string }[];
  probeCount: number;
  probeDetails: { x: number; y: number; heights: (number | null)[]; normals: number[] }[];
}

// Offline first-hit calibration, bound to the exact GLB bytes before this table is used.
// See docs/world-model-inspection-refined.json, accepted candidate (320 probes).
export const WORLD_CALIBRATION = {
  sha256: "42da5e43da6d8a82151abadd310c6e9066b2dca14a155638aa23561497874297",
  size: 8,
  outer: 11.2,
  yaw: -Math.PI / 2,
  offsetX: 0,
  offsetZ: -.6,
  targetHeight: .27,
  rawGround: 1.736744568326833,
  rawMin: 1.6972526252543547,
  rawMax: 1.880457566814407,
  heights: [
    .270875, .2972982, .2949361, .3130554, .2815442, .2823054, .2840849, .282492,
    .2897071, .2832411, .309124, .2697188, .2743674, .3071439, .2679827, .2886336,
    .288583, .413713, .405553, .2712932, .2853145, .2831327, .2732021, .2793335,
    .2847238, .2888463, .3003543, .285568, .2859054, .3056756, .281045, .2701905,
    .2720406, .2852478, .2903438, .2701311, .283932, .2908211, .2848036, .2836053,
    .2894078, .281376, .2896694, .2828239, .2900668, .2827131, .2804491, .2834592,
    .2825427, .3018185, .2884755, .2998714, .2760028, .2698124, .2943198, .2824386,
    .2698488, .2847738, .2969028, .2710655, .2936053, .3063644, .3146926, .2881408,
  ],
} as const;

export function calibratedWorldModel(source: THREE.Group) {
  if (source.userData.verifiedAssetSha256 !== WORLD_CALIBRATION.sha256) throw new Error("World model asset-version-mismatch");
  const model = new THREE.Group();
  model.add(normalizedWorldModel(source, WORLD_CALIBRATION.outer));
  model.rotation.y = WORLD_CALIBRATION.yaw;
  model.position.set(WORLD_CALIBRATION.offsetX, WORLD_CALIBRATION.targetHeight - WORLD_CALIBRATION.rawGround, WORLD_CALIBRATION.offsetZ);
  model.updateMatrixWorld(true);
  const heights = [...WORLD_CALIBRATION.heights];
  const report: WorldSurfaceReport = {
    accepted: true, heights, min: Math.min(...heights), max: Math.max(...heights),
    rawGround: WORLD_CALIBRATION.rawGround, rawMin: WORLD_CALIBRATION.rawMin, rawMax: WORLD_CALIBRATION.rawMax,
    invalidCells: [], probeCount: 320, probeDetails: [],
  };
  return { model, report };
}

export async function sampleWorldSurface(object: THREE.Group, size: number, targetHeight: number, cancelled: () => boolean = () => false): Promise<WorldSurfaceReport> {
  object.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(object);
  const ray = new THREE.Raycaster();
  ray.far = bounds.max.y - bounds.min.y + 4;
  const down = new THREE.Vector3(0, -1, 0), origin = new THREE.Vector3();
  const normal = new THREE.Vector3(), normalMatrix = new THREE.Matrix3();
  const center = (size - 1) / 2;
  const probes = [[0, 0], [-.32, -.32], [.32, -.32], [-.32, .32], [.32, .32]];
  const cells: { height: number | null; walkable: boolean; normal: number }[][] = [];
  const topHeights: number[] = [];
  const collisionHeights: number[] = [];
  for (let y = 0; y < size; y++) {
    if (cancelled()) throw new Error("World surface sampling cancelled");
    for (let x = 0; x < size; x++) {
      const samples = probes.map(([dx, dz]) => {
        origin.set(x - center + dx, bounds.max.y + 2, y - center + dz);
        ray.set(origin, down);
        const hit = ray.intersectObject(object, true)[0];
        if (!hit?.face) return { height: null, walkable: false, normal: 0 };
        normalMatrix.getNormalMatrix(hit.object.matrixWorld);
        normal.copy(hit.face.normal).applyMatrix3(normalMatrix).normalize();
        const walkable = normal.y > .65;
        collisionHeights.push(hit.point.y);
        if (walkable) topHeights.push(hit.point.y);
        return { height: hit.point.y, walkable, normal: normal.y };
      });
      cells.push(samples);
    }
    if (typeof requestAnimationFrame === "function") await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  }
  const histogram = new Map<number, number>();
  topHeights.forEach(height => { const bin = Math.round(height / .06); histogram.set(bin, (histogram.get(bin) ?? 0) + 1); });
  const dominantBin = [...histogram.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
  const cluster = dominantBin == null ? [] : topHeights.filter(height => Math.abs(height - dominantBin * .06) <= .10).sort((a, b) => a - b);
  const rawGround = cluster.length ? cluster[Math.floor(cluster.length / 2)] : null;
  const invalidCells: WorldSurfaceReport["invalidCells"] = [];
  const heights = cells.map((samples, index) => {
    const x = index % size, y = Math.floor(index / size);
    if (rawGround == null || samples.some(sample => sample.height == null)) {
      invalidCells.push({ x, y, reason: "blocked-or-missing-walkable-surface" });
      return targetHeight;
    }
    // A lower hit under a house is not walkable: reject occluded centers rather than placing agents on roofs.
    if (samples.some(sample => sample.height! > rawGround + .34 || sample.height! < rawGround - .28)) {
      invalidCells.push({ x, y, reason: "obstruction-or-excessive-height" });
      return targetHeight;
    }
    // Tiny stone seams may have steep facets, but the first collision must remain at ground level.
    if (samples.some(sample => !sample.walkable && (sample.normal <= 0 || Math.abs(sample.height! - rawGround) > .14))) {
      invalidCells.push({ x, y, reason: "steep-obstacle-above-ground-band" });
      return targetHeight;
    }
    return Math.max(...samples.map(sample => sample.height!)) - rawGround + targetHeight;
  });
  heights.forEach((height, index) => {
    const x = index % size, y = Math.floor(index / size);
    if ((x < size - 1 && Math.abs(height - heights[index + 1]) > .28) || (y < size - 1 && Math.abs(height - heights[index + size]) > .28)) {
      if (!invalidCells.some(cell => cell.x === x && cell.y === y)) invalidCells.push({ x, y, reason: "non-continuous-neighbor-height" });
    }
  });
  const min = Math.min(...heights), max = Math.max(...heights);
  if (max - min > .4) {
    const index = heights.indexOf(max);
    if (!invalidCells.some(cell => cell.x === index % size && cell.y === Math.floor(index / size))) invalidCells.push({ x: index % size, y: Math.floor(index / size), reason: "excessive-total-height-range" });
  }
  const accepted = rawGround != null && invalidCells.length === 0 && max - min <= .4;
  if (accepted) {
    object.position.y += targetHeight - rawGround!;
    object.updateMatrixWorld(true);
  }
  return { accepted, heights, min, max, rawGround, rawMin: collisionHeights.length ? Math.min(...collisionHeights) : null, rawMax: collisionHeights.length ? Math.max(...collisionHeights) : null, invalidCells, probeCount: size * size * probes.length, probeDetails: cells.map((samples, index) => ({ x: index % size, y: Math.floor(index / size), heights: samples.map(sample => sample.height), normals: samples.map(sample => sample.normal) })) };
}

export function resourceModel(type: Resource): THREE.Group {
  const group = new THREE.Group();
  if (type === "Crystal") {
    [[-.13, .23, .02, .15, .5], [.12, .16, .06, .11, .36], [.03, .13, -.13, .09, .28]].forEach(([x, y, z, radius, height], index) => {
      const crystal = mesh(new THREE.CylinderGeometry(0, radius, height, 5), ["#d1f2ef", "#81c1cf", "#c6d1f4"][index], [x, y, z]);
      crystal.rotation.z = index === 1 ? -.25 : .12;
      group.add(crystal);
    });
  } else if (type === "Berry") {
    group.add(mesh(new THREE.IcosahedronGeometry(.25, 1), "#65995b", [0, .18, 0], [1, .8, 1]));
    [[-.12, .25, .16], [.12, .21, .14], [.0, .32, .06]].forEach(([x, y, z], index) => group.add(mesh(new THREE.SphereGeometry(.08, 10, 8), index % 2 ? "#dd7487" : "#bb526d", [x, y, z])));
    const leaf = mesh(new THREE.SphereGeometry(.13, 8, 6), "#b0c779", [.08, .38, -.02], [1, .18, .45]);
    leaf.rotation.z = .4;
    group.add(leaf);
  } else {
    [[-.15, .02, .04], [.10, .035, .06], [.0, .04, -.10]].forEach(([x, y, z], index) => group.add(mesh(new THREE.DodecahedronGeometry(.19, 0), ["#88b783", "#a5c87d", "#79a892"][index], [x, y, z], [1, .3, 1])));
    for (let index = 0; index < 4; index++) {
      const sprig = mesh(new THREE.ConeGeometry(.035, .17, 4), "#b7d39a", [(index - 1.5) * .09, .105, .02]);
      sprig.rotation.z = (index - 1.5) * .16;
      group.add(sprig);
    }
  }
  return group;
}

export function fallbackWildling(color: string): THREE.Group {
  const group = new THREE.Group();
  group.add(mesh(new THREE.CylinderGeometry(.18, .29, .36, 9), color, [0, .36, 0]));
  group.add(mesh(new THREE.SphereGeometry(.285, 16, 12), "#edc5a4", [0, .74, .035], [1, .93, .86]));
  const hood = mesh(new THREE.SphereGeometry(.3, 12, 8, 0, Math.PI * 2, 0, Math.PI * .54), "#4b7560", [0, .77, .005], [1.04, .95, 1]);
  group.add(hood);
  [-1, 1].forEach(side => {
    group.add(mesh(new THREE.SphereGeometry(.092, 12, 10), "#fffbea", [.112 * side, .757, .255], [1, 1.08, .45]));
    group.add(mesh(new THREE.SphereGeometry(.047, 10, 8), "#273d34", [.105 * side, .752, .295], [1, 1.16, .32]));
    group.add(mesh(new THREE.SphereGeometry(.014, 8, 6), "#ffffff", [.095 * side, .775, .307]));
    group.add(mesh(new THREE.SphereGeometry(.073, 10, 8), "#ebc3a0", [.296 * side, .75, .01], [.7, 1.05, .8]));
    const arm = mesh(new THREE.CapsuleGeometry(.055, .12, 3, 7), "#edc5a4", [.245 * side, .4, .065]);
    arm.rotation.z = side * .4;
    arm.name = side === -1 ? "arm-left" : "arm-right";
    group.add(arm);
    const foot = mesh(new THREE.SphereGeometry(.09, 10, 8), "#7b6557", [.13 * side, .09, .065], [.8, .7, 1.45]);
    foot.name = side === -1 ? "foot-left" : "foot-right";
    group.add(foot);
  });
  group.add(mesh(new THREE.SphereGeometry(.041, 10, 7), "#d59f80", [0, .684, .289], [1.05, .68, .8]));
  const leaf = mesh(new THREE.SphereGeometry(.13, 10, 6), "#add18b", [.08, 1.035, 0], [.52, 1, .18]);
  leaf.rotation.z = -.7;
  group.add(leaf);
  return group;
}

export function wildlingAccessories(color: string, state: WildlingState, overModel = false) {
  const group = new THREE.Group();
  if (overModel) {
    const cloak = mesh(new THREE.CylinderGeometry(.205, .305, .275, 10, 1, true), color, [0, .285, 0], [1, 1, .85]);
    cloak.name = "tribe-color-cloak";
    (cloak.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
    group.add(cloak);
    const collar = mesh(new THREE.TorusGeometry(.195, .027, 5, 18), color, [0, .429, 0], [1, .9, 1]);
    collar.rotation.x = Math.PI / 2;
    group.add(collar);
    const tie = mesh(new THREE.OctahedronGeometry(.045), "#f8e6b7", [0, .37, .217], [.6, 1, .32]);
    group.add(tie);
  }
  const pack = mesh(new THREE.BoxGeometry(.23, .28, .14), color, [0, .37, -.23]);
  group.add(pack);
  const ring = new THREE.Mesh(new THREE.RingGeometry(.29, .36, 40), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: .78 }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = .018;
  ring.name = "identity-ring";
  group.add(ring);
  if (state.berry) {
    const berry = resourceModel("Berry");
    berry.scale.setScalar(.36);
    berry.position.set(.30, .27, .0);
    group.add(berry);
  }
  if (state.crystal) {
    const crystal = resourceModel("Crystal");
    crystal.scale.setScalar(.5);
    crystal.position.set(-.29, .25, .07);
    group.add(crystal);
  }
  if (state.ruffled) {
    const bandage = mesh(new THREE.BoxGeometry(.17, .08, .018), "#eee4c9", [.18, .86, .21]);
    bandage.rotation.z = -.5;
    group.add(bandage);
  }
  if (state.showTruth && state.infected) {
    const mark = mesh(new THREE.OctahedronGeometry(.085), "#ab6484", [0, 1.21, 0]);
    mark.name = "truth-infection";
    group.add(mark);
  }
  for (let index = 0; index < Math.min(state.reputation ?? 0, 5); index++) {
    group.add(mesh(new THREE.OctahedronGeometry(.03), "#ffe6a2", [(index - 2) * .067, .34, .27]));
  }
  return group;
}

export function memorialModel(color: string) {
  const group = new THREE.Group();
  group.add(mesh(new THREE.CylinderGeometry(.3, .34, .11, 8), "#a6b8ae", [0, .06, 0]));
  group.add(mesh(new THREE.BoxGeometry(.37, .54, .17), "#c2cec1", [0, .34, 0]));
  group.add(mesh(new THREE.SphereGeometry(.185, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), "#c2cec1", [0, .61, 0], [1, .75, .46]));
  const badge = mesh(new THREE.OctahedronGeometry(.09), color, [0, .43, .095], [.7, 1, .25]);
  group.add(badge);
  return group;
}

export function fallbackCampfire() {
  const group = new THREE.Group();
  for (let index = 0; index < 9; index++) {
    const angle = index * Math.PI * 2 / 9;
    const stone = mesh(new THREE.DodecahedronGeometry(.11), "#9ea997", [Math.cos(angle) * .36, .06, Math.sin(angle) * .36], [1.15, .7, 1]);
    group.add(stone);
  }
  [-.58, .58].forEach(angle => {
    const log = mesh(new THREE.CylinderGeometry(.06, .07, .6, 7), "#92765a", [0, .11, 0]);
    log.rotation.set(Math.PI / 2, 0, angle);
    group.add(log);
  });
  const flame = new THREE.Group();
  flame.name = "fire-flame";
  const outer = mesh(new THREE.ConeGeometry(.17, .51, 7), "#ef9856", [0, .34, 0]);
  (outer.material as THREE.MeshStandardMaterial).emissive.set("#ec7939");
  (outer.material as THREE.MeshStandardMaterial).emissiveIntensity = .65;
  const inner = mesh(new THREE.ConeGeometry(.105, .33, 7), "#ffe8a1", [.02, .28, .07]);
  (inner.material as THREE.MeshStandardMaterial).emissive.set("#ffcb6c");
  (inner.material as THREE.MeshStandardMaterial).emissiveIntensity = .65;
  flame.add(outer, inner);
  group.add(flame);
  return group;
}

export function roundedTileGeometry(width: number, depth: number, height: number, radius = .085) {
  const x = -width / 2, y = -depth / 2;
  const shape = new THREE.Shape();
  shape.moveTo(x + radius, y);
  shape.lineTo(x + width - radius, y);
  shape.quadraticCurveTo(x + width, y, x + width, y + radius);
  shape.lineTo(x + width, y + depth - radius);
  shape.quadraticCurveTo(x + width, y + depth, x + width - radius, y + depth);
  shape.lineTo(x + radius, y + depth);
  shape.quadraticCurveTo(x, y + depth, x, y + depth - radius);
  shape.lineTo(x, y + radius);
  shape.quadraticCurveTo(x, y, x + radius, y);
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: true, bevelSegments: 1, steps: 1, bevelSize: .018, bevelThickness: .018, curveSegments: 3 });
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}
