import { useEffect, useRef, useState } from "react";
import { CloudRain, Flame, House, Map as MapIcon, MapPin, RotateCcw, ScanSearch, Sun, ZoomIn, ZoomOut } from "lucide-react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { AgentSummary, CognitionStage, GroundTruth, Incident, Position, RawEvent, Resource, WorldView } from "../types";
import { cognitionStage } from "../cognition";
import { deriveWildlingState, wildlingColor, wildlingName } from "./Wildling";
import type { WildlingState } from "./Wildling";
import { regionLabel, resourceLabel } from "../i18n";
import { sampleFrame } from "../three-frame-check";
import { calibratedWorldModel, disposeObject, fallbackCampfire, loadLocalModel, memorialModel, mesh, normalizedModel, roundedTileGeometry, WORLD_CALIBRATION } from "./b-three-assets";
import { cognitionFigure, cognitionUpgradeRing, COGNITION_HEIGHTS, COGNITION_ROMAN, loadCognitionModel } from "./cognition-three";
import { worldPublicEffects } from "./world-public-effects";
import type { WorldSurfaceReport } from "./b-three-assets";
import { fitWorldPropModel, placeWorldProps, publicPropEventPosition, worldPropStatus, WORLD_PROPS } from "../world-props";
import type { WorldPropId, WorldPropState } from "../world-props";
import { RESOURCE_ASSETS, resourceAssetInstance } from "../resource-assets";
import "../wildling.css";
import "../scene-b.css";

interface Props {
  world: WorldView;
  agents: AgentSummary[];
  selectedAgent: string | null;
  onSelectAgent: (id: string) => void;
  events: RawEvent[];
  groundTruth?: GroundTruth | null;
  turn?: number;
  incidents?: Incident[];
  knownPositions?: Position[];
  showNames?: boolean;
  suspended?: boolean;
}

export function WildResource({ type, className = "" }: { type: Resource; className?: string }) {
  return <svg viewBox="0 0 56 56" className={`wild-resource wild-resource-${type.toLowerCase()} ${className}`} role="img" aria-label={resourceLabel[type]}>
    {type === "Berry" ? <>
      <path d="M13 40q-8-17 5-22 12-8 24 2 12 13-1 24Z" fill="#486e4e" stroke="#243e38" strokeWidth="2" />
      <circle cx="19" cy="29" r="9" fill="#cf7383" stroke="#67454d" strokeWidth="2" /><circle cx="36" cy="28" r="9" fill="#e29391" stroke="#67454d" strokeWidth="2" /><circle cx="27" cy="40" r="10" fill="#d87987" stroke="#67454d" strokeWidth="2" /><circle cx="17" cy="26" r="2.5" fill="#ffd4ca" /><circle cx="34" cy="25" r="2.5" fill="#ffe1d0" />
      <path d="M26 24Q10 12 16 8q11-2 13 13Q34 4 44 10q-1 13-15 15Z" fill="#a6c979" stroke="#395d43" strokeWidth="2" />
    </> : type === "Crystal" ? <>
      <path d="m10 35 4-15 10 4 9-18 13 20-5 21-24 3Z" fill="#9cd4e5" stroke="#4a6377" strokeWidth="2" strokeLinejoin="round" /><path d="m33 6-5 26 13 15 5-21Z" fill="#91a8d4" /><path d="m33 6 4 21-9 5Z" fill="#d8f8f4" /><path d="m14 20 5 17-2 13 11-18-4-8" fill="#b8e5ec" /><path d="m14 20 5 17 9-5m0 0 9-5 9-1m-18 6 5-26m-5 26 13 15" fill="none" stroke="#648598" strokeWidth="1.4" />
    </> : <>
      <path d="M8 36q-2-10 8-12 0-10 11-7 9-8 16 4 10 2 8 12 5 10-8 12H17Q4 45 8 36Z" fill="#76a679" stroke="#3b6554" strokeWidth="2" /><path d="m17 36 1-11m10 15 1-17m10 13 4-11m-25 7-5-3m16 2 5-4" stroke="#b1cf91" strokeWidth="2.5" strokeLinecap="round" /><path d="M12 43q18 7 34-2" stroke="#4d805b" fill="none" strokeWidth="3" />
    </>}
  </svg>;
}

export function Campfire({ quiet = false }: { quiet?: boolean }) {
  return <svg viewBox="0 0 100 104" className={`wild-campfire ${quiet ? "is-quiet" : ""}`} role="img" aria-label="篝火基地">
    <ellipse cx="51" cy="85" rx="39" ry="13" fill="#213b34" opacity=".23" />
    <g stroke="#4d5143" strokeWidth="2"><ellipse cx="23" cy="81" rx="11" ry="7" fill="#a7b5a4" transform="rotate(-25 23 81)" /><ellipse cx="44" cy="91" rx="12" ry="6" fill="#bbc3a9" /><ellipse cx="71" cy="88" rx="12" ry="7" fill="#a0b1a3" transform="rotate(-15 71 88)" /><ellipse cx="82" cy="77" rx="10" ry="7" fill="#bac4ad" /><path d="m26 82 45-20 5 9-43 21Z" fill="#9a7655" /><path d="m27 68 9-7 39 24-6 8Z" fill="#b1885b" /></g>
    <g className="wild-fire-flame"><path d="M52 12q-1 21-14 32-3-12-8-15 3 20-9 31-12 31 29 31 39-1 28-30-3-7-2-22-7 4-9 13Q69 30 52 12Z" fill="#f69b5b" stroke="#a66442" strokeWidth="2.5" /><path d="M50 43q4 13-7 23-5-5-5-10-15 24 10 29 26 3 20-17-7-13-8-21-1 15-10 16 4-9 0-20Z" fill="#ffd887" /><path d="M51 67q-17 16 1 20 19-4-1-20Z" fill="#fff0bb" /></g>
    <g className="wild-fire-sparks" fill="#f5c977"><ellipse cx="34" cy="22" rx="2" ry="4" /><ellipse cx="69" cy="13" rx="2" ry="3" /><circle cx="58" cy="2" r="2" /></g>
  </svg>;
}

type ModelState = "loading" | "glb" | "fallback";
type SceneView = "world" | "village" | "event";
type ModelKind = "campfire" | "world-8x8";
const MODEL_KINDS: ModelKind[] = ["campfire", "world-8x8"];
type AgentNode = { root: THREE.Group; body: THREE.Group; target: THREE.Vector3; state: WildlingState; signature: string; previousPosition: string; stage: CognitionStage; upgradeAt: number; upgradeRing: THREE.Mesh };
type SceneRuntime = { scene: THREE.Scene; camera: THREE.OrthographicCamera; renderer: THREE.WebGLRenderer; controls: OrbitControls; terrain: THREE.Group; contents: THREE.Group; characters: THREE.Group; agents: Map<string, AgentNode>; fire: THREE.Group; fireLight: THREE.PointLight; tiles: Map<string, THREE.Mesh>; models: Record<ModelKind, THREE.Group | null>; reset: () => void; focus: (view: SceneView) => void; sync: () => void };
const REGION_COLORS = { NW: "#91b46c", NE: "#91b9ca", SW: "#78b7a3", SE: "#d7a48d" };
const TILE_TOP = .27;

function agentIsRemoved(agent: AgentSummary) {
  return !!agent.removed || (agent.unavailableUntilTurn != null && agent.unavailableUntilTurn > 100000);
}

function publicInvestigationPosition(props: Props): Position | null {
  return publicPropEventPosition(props.world.size, props.turn ?? 0, props.incidents, props.events);
}

export function WildWorldScene(props: Props) {
  const { world, agents, selectedAgent, onSelectAgent, groundTruth = null, turn = 0, showNames = true } = props;
  const host = useRef<HTMLDivElement>(null);
  const labels = useRef(new Map<string, HTMLButtonElement>());
  const axes = useRef(new Map<string, HTMLSpanElement>());
  const northPointer = useRef<HTMLElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const runtime = useRef<SceneRuntime | null>(null);
  const [webglError, setWebglError] = useState(false);
  const [sceneView, setSceneView] = useState<SceneView>("world");
  const sceneViewRef = useRef<SceneView>("world");
  const [models, setModels] = useState<Record<ModelKind, ModelState>>({ campfire: "loading", "world-8x8": "loading" });
  const [stageModels, setStageModels] = useState<Partial<Record<CognitionStage, ModelState>>>({});
  const [propModels, setPropModels] = useState<Partial<Record<WorldPropId, WorldPropState>>>({});
  const [resourceModels, setResourceModels] = useState<Partial<Record<Resource, ModelState>>>({});
  const [surfaceReport, setSurfaceReport] = useState<WorldSurfaceReport | null>(null);
  const [surfaceStatus, setSurfaceStatus] = useState("loading");
  const characterStates = agents.map(agent => stageModels[cognitionStage(agent.cognition?.stage)] ?? "loading");
  const characterStatus = characterStates.every(state => state === "glb") ? "glb" : characterStates.some(state => state === "loading") ? "loading" : "fallback";
  const allModelStates = [...MODEL_KINDS.map(kind => models[kind]), characterStatus];
  const modelStatus = allModelStates.every(state => state === "glb") ? "glb" : allModelStates.some(state => state === "loading") ? "loading" : allModelStates.some(state => state === "glb") ? "partial-glb" : "fallback";
  const publicPosition = publicInvestigationPosition(props);
  const propStatus = worldPropStatus(propModels);
  const selectedMember = agents.find(agent => agent.id === selectedAgent);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    setPropModels({});
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: "high-performance" });
    } catch {
      setWebglError(true);
      return;
    }
    let disposed = false;
    let raf = 0;
    let lastTime = 0;
    let lastFrame = 0;
    const frameInterval = 1000 / 30;
    const size = latest.current.world.size, center = (size - 1) / 2;
    let surfaceHeights = new Array<number>(size * size).fill(TILE_TOP);
    let surfaceRevision = 0;
    let worldSurfaceAccepted = false;
    const propNodes = new Map<WorldPropId, THREE.Group>();
    let overviewBounds = new THREE.Box3(new THREE.Vector3(-size / 2 - .3, -.8, -size / 2 - .3), new THREE.Vector3(size / 2 + .3, 1.7, size / 2 + .3));
    const surfaceAt = (x: number, y: number) => {
      const cx = Math.max(0, Math.min(size - 1, x)), cy = Math.max(0, Math.min(size - 1, y));
      const x0 = Math.floor(cx), x1 = Math.min(size - 1, x0 + 1), y0 = Math.floor(cy), y1 = Math.min(size - 1, y0 + 1);
      const tx = cx - x0, ty = cy - y0;
      return THREE.MathUtils.lerp(THREE.MathUtils.lerp(surfaceHeights[y0 * size + x0], surfaceHeights[y0 * size + x1], tx), THREE.MathUtils.lerp(surfaceHeights[y1 * size + x0], surfaceHeights[y1 * size + x1], tx), ty);
    };
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-7, 7, 7, -7, .1, 100);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.16;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setClearColor(0xdfeae5, 0);
    renderer.domElement.setAttribute("aria-label", "荒野三维地图，五名成员的实时位置");
    renderer.domElement.setAttribute("role", "img");
    renderer.domElement.dataset.scene = "wild-world-b";
    element.prepend(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = !reducedMotion.matches;
    controls.dampingFactor = .09;
    controls.enablePan = false;
    controls.minPolarAngle = .25;
    controls.maxPolarAngle = Math.PI * .43;
    controls.minZoom = .35;
    controls.maxZoom = 5;
    controls.rotateSpeed = .55;
    controls.zoomSpeed = .7;
    const fitBounds = (bounds: THREE.Box3, padding: number) => {
      camera.zoom = 1;
      camera.lookAt(controls.target);
      camera.updateMatrixWorld(true);
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
        const corner = new THREE.Vector3(x, y, z).applyMatrix4(camera.matrixWorldInverse);
        minX = Math.min(minX, corner.x); maxX = Math.max(maxX, corner.x);
        minY = Math.min(minY, corner.y); maxY = Math.max(maxY, corner.y);
      }
      camera.zoom = Math.min((camera.right - camera.left) / Math.max((maxX - minX) * padding, .01), (camera.top - camera.bottom) / Math.max((maxY - minY) * padding, .01), controls.maxZoom);
      camera.updateProjectionMatrix();
    };
    const reset = () => {
      overviewBounds.getCenter(controls.target);
      camera.position.copy(controls.target).add(new THREE.Vector3(11, 13.5, 14));
      fitBounds(overviewBounds, 1.1);
      controls.update();
    };
    const focus = (view: SceneView) => {
      const overview = view === "world";
      controls.maxZoom = overview ? 5 : 10;
      if (overview) { reset(); return; }
      const point = view === "event" ? publicInvestigationPosition(latest.current) ?? latest.current.world.base : latest.current.world.base;
      const height = surfaceAt(...point);
      const target = new THREE.Vector3(point[0] - center, height + .42, point[1] - center);
      const bounds = new THREE.Box3(new THREE.Vector3(target.x - 1.25, height - .08, target.z - 1.25), new THREE.Vector3(target.x + 1.25, height + 1.3, target.z + 1.25));
      propNodes.forEach(node => {
        if (node.userData.anchor === (view === "event" && publicInvestigationPosition(latest.current) ? "public-event" : "base")) bounds.union(new THREE.Box3().setFromObject(node));
      });
      controls.target.copy(target);
      camera.position.copy(target).add(new THREE.Vector3(6.5, 8.2, 10));
      fitBounds(bounds, 1.23);
      controls.update();
    };
    reset();
    scene.add(new THREE.HemisphereLight(0xfff6dc, 0x6e9994, 2.3));
    const key = new THREE.DirectionalLight(0xfff1d1, 3.2);
    key.position.set(-6, 13, 8);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    Object.assign(key.shadow.camera, { left: -7, right: 7, top: 7, bottom: -7, near: 1, far: 35 });
    key.shadow.normalBias = .055;
    key.shadow.bias = -.0001;
    key.shadow.radius = 4;
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xd0e4f5, .7);
    fill.position.set(8, 7, -9);
    scene.add(fill);
    const ground = mesh(new THREE.PlaneGeometry(200, 200), "#e0eae4", [0, -.9, 0]);
    ground.rotation.x = -Math.PI / 2;
    ground.castShadow = false;
    scene.add(ground);
    const terrain = new THREE.Group(), contents = new THREE.Group(), characters = new THREE.Group(), fire = new THREE.Group(), facilities = new THREE.Group();
    facilities.name = "village-cooperation-facilities";
    const worldTerrain = new THREE.Group(), gridOverlay = new THREE.Group(), selectedTrack = new THREE.Group();
    scene.add(terrain, contents, characters, fire, worldTerrain, gridOverlay, selectedTrack, facilities);
    const publicFeedback = worldPublicEffects(scene, element, surfaceAt, size);
    const gridBorders = new Map<string, THREE.LineSegments>();
    const island = mesh(roundedTileGeometry(size + .17, size + .17, .55, .42), "#88998c", [0, -.61, 0]);
    terrain.add(island);
    const seam = mesh(roundedTileGeometry(size + .09, size + .09, .13, .35), "#c0c0a5", [0, -.1, 0]);
    terrain.add(seam);
    const tiles = new Map<string, THREE.Mesh>();
    latest.current.world.cells.forEach(cell => {
      const [x, z] = cell.position;
      const tile = mesh(roundedTileGeometry(.953, .953, .20, .045), REGION_COLORS[cell.region], [x - center, .035, z - center]);
      tile.name = `cell-${x}-${z}`;
      tiles.set(cell.position.join(","), tile);
      terrain.add(tile);
      const border = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(.96, .96)), new THREE.LineBasicMaterial({ color: "#5a7868", transparent: true, opacity: .33 }));
      border.rotation.x = -Math.PI / 2;
      border.position.set(x - center, TILE_TOP + .003, z - center);
      gridOverlay.add(border);
      gridBorders.set(cell.position.join(","), border);
      const jitter = ((x * 13 + z * 7) % 9) / 9;
      const pebble = mesh(new THREE.DodecahedronGeometry(.035 + jitter * .022), "#d1d5b6", [x - center + .35, TILE_TOP + .01, z - center - .30], [1, .4, .8]);
      terrain.add(pebble);
    });
    // Stratified stones form the island edge, not discoverable world resources.
    for (let index = 0; index < size; index++) {
      [-1, 1].forEach(side => {
        const rock = mesh(new THREE.DodecahedronGeometry(.23, 0), side === 1 ? "#a3b3a7" : "#9dafab", [index - center + .08, -.46, side * (size / 2 + .045)], [1.45, .82, .56]);
        rock.rotation.y = index * .8;
        terrain.add(rock);
        const cross = mesh(new THREE.DodecahedronGeometry(.21, 0), "#a6b4a5", [side * (size / 2 + .025), -.45, index - center + .11], [.58, .85, 1.35]);
        terrain.add(cross);
      });
    }
    const fireLight = new THREE.PointLight(0xffb66b, 1.9, 3.4, 2);
    scene.add(fireLight);
    const active: SceneRuntime = { scene, camera, renderer, controls, terrain, contents, characters, fire, fireLight, tiles, agents: new Map(), models: { campfire: null, "world-8x8": null }, reset, focus, sync: () => undefined };
    const cognitionSources = new Map<CognitionStage, THREE.Group>();
    const propSources = new Map<WorldPropId, THREE.Group>();
    const resourceSources = new Map<Resource, THREE.Group>();
    const requestedStages = new Set<CognitionStage>();
    const ensureCognition = (stage: CognitionStage) => {
      if (requestedStages.has(stage)) return;
      requestedStages.add(stage);
      setStageModels(previous => ({ ...previous, [stage]: "loading" }));
      loadCognitionModel(stage).then(model => {
        if (disposed) return;
        cognitionSources.set(stage, model);
        setStageModels(previous => ({ ...previous, [stage]: "glb" }));
        active.sync();
      }).catch(() => { if (!disposed) setStageModels(previous => ({ ...previous, [stage]: "fallback" })); });
    };
    runtime.current = active;

    let contentsSignature = "";
    let fireSignature = "";
    let eventSignature = "";
    let trackSignature = "";
    let propSignature = "";
    active.sync = () => {
      const current = latest.current;
      const placements = placeWorldProps(size, current.world.base, publicInvestigationPosition(current));
      const nextProps = JSON.stringify([surfaceRevision, placements.map(item => [item.id, item.anchor, item.gridPosition]), [...propSources.keys()]]);
      if (propSignature !== nextProps) {
        propSignature = nextProps;
        placements.forEach(placement => {
          const source = propSources.get(placement.id);
          if (!source) return;
          let node = propNodes.get(placement.id);
          if (!node) {
            try { node = fitWorldPropModel(source, placement); }
            catch { setPropModels(previous => ({ ...previous, [placement.id]: "fallback" })); return; }
            propNodes.set(placement.id, node);
            facilities.add(node);
            setPropModels(previous => ({ ...previous, [placement.id]: "glb" }));
          }
          const [x, z] = placement.gridPosition;
          node.position.set(x - center, surfaceAt(x, z) + .014, z - center);
          node.userData.anchor = placement.anchor;
          node.userData.gridPosition = [...placement.gridPosition];
          node.userData.surfaceHeight = surfaceAt(x, z);
        });
        element.dataset.propPlacements = JSON.stringify([...propNodes].map(([id, node]) => ({ id, gridPosition: node.userData.gridPosition, groundHeight: node.userData.surfaceHeight, y: node.position.y, anchor: node.userData.anchor })));
        if (sceneViewRef.current !== "world") focus(sceneViewRef.current);
      }
      const nextEvent = (publicInvestigationPosition(current) ?? current.world.base).join(",");
      if (eventSignature !== nextEvent) {
        eventSignature = nextEvent;
        if (sceneViewRef.current === "event") focus("event");
      }
      const selected = current.agents.find(agent => agent.id === current.selectedAgent);
      const recentPositions = current.events.filter(event => event.agent_id === current.selectedAgent && event.turn <= (current.turn ?? 0)).slice().sort((a, b) => a.turn - b.turn).map(event => event.observation.position);
      if (selected) recentPositions.push(selected.position);
      const positions = recentPositions.filter((position, index) => index === 0 || position[0] !== recentPositions[index - 1][0] || position[1] !== recentPositions[index - 1][1]).slice(-13);
      const nextTrack = JSON.stringify([surfaceRevision, current.selectedAgent, selected?.position, positions]);
      if (trackSignature !== nextTrack) {
        trackSignature = nextTrack;
        disposeObject(selectedTrack);
        selectedTrack.clear();
        if (selected) {
          const color = wildlingColor(selected.id);
          const [x, z] = selected.position;
          const currentCell = new THREE.Mesh(new THREE.PlaneGeometry(.9, .9), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .22, depthWrite: false }));
          currentCell.rotation.x = -Math.PI / 2;
          currentCell.position.set(x - center, surfaceAt(x, z) + .035, z - center);
          selectedTrack.add(currentCell);
          [-1, 1].forEach(side => {
            selectedTrack.add(mesh(new THREE.BoxGeometry(.965, .027, .035), color, [x - center, surfaceAt(x, z) + .045, z - center + side * .465]));
            selectedTrack.add(mesh(new THREE.BoxGeometry(.035, .027, .965), color, [x - center + side * .465, surfaceAt(x, z) + .045, z - center]));
          });
          positions.forEach((position, index) => {
            if (index === 0) return;
            const previous = positions[index - 1];
            if (Math.abs(position[0] - previous[0]) + Math.abs(position[1] - previous[1]) !== 1) return;
            const start = new THREE.Vector3(previous[0] - center, surfaceAt(...previous) + .055, previous[1] - center);
            const end = new THREE.Vector3(position[0] - center, surfaceAt(...position) + .055, position[1] - center);
            const direction = end.clone().sub(start);
            const segment = mesh(new THREE.CylinderGeometry(.017, .017, direction.length(), 6), color, [0, 0, 0]);
            segment.position.copy(start).add(end).multiplyScalar(.5);
            segment.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
            segment.castShadow = false;
            selectedTrack.add(segment);
          });
          selectedTrack.userData.position = [...selected.position];
          selectedTrack.userData.observedPositions = positions.map(position => [...position]);
        }
      }
      const known = new Set((current.knownPositions ?? []).map(position => position.join(",")));
      const truth = new Map(current.groundTruth?.cells.map(cell => [cell.position.join(","), cell]) ?? []);
      const nextContents = JSON.stringify([surfaceRevision, current.world.cells, current.groundTruth?.cells, current.knownPositions, current.selectedAgent, [...resourceSources.keys()]]);
      if (nextContents !== contentsSignature) {
        contentsSignature = nextContents;
        disposeObject(contents);
        contents.clear();
        current.world.cells.forEach(cell => {
          const cellKey = cell.position.join(",");
          const [x, z] = cell.position;
          const isBase = x === current.world.base[0] && z === current.world.base[1];
          const visible = cell.known || !!current.groundTruth || isBase;
          const tile = tiles.get(cellKey);
          const surfaceHeight = surfaceAt(x, z);
          const border = gridBorders.get(cellKey);
          if (border) {
            border.position.y = surfaceHeight + .036;
            (border.material as THREE.LineBasicMaterial).opacity = worldSurfaceAccepted ? .63 : .33;
          }
          const color = new THREE.Color(REGION_COLORS[cell.region]);
          if (!visible) color.lerp(new THREE.Color("#c7d2c5"), .55);
          if ((x + z) % 2 === 1) color.multiplyScalar(.955);
          if (tile) (tile.material as THREE.MeshStandardMaterial).color.copy(color);
          if (worldSurfaceAccepted) {
            const regionTint = new THREE.Mesh(new THREE.PlaneGeometry(.96, .96), new THREE.MeshBasicMaterial({ color: REGION_COLORS[cell.region], transparent: true, opacity: visible ? .07 : .16, depthWrite: false }));
            regionTint.rotation.x = -Math.PI / 2;
            regionTint.position.set(x - center, surfaceHeight + .009, z - center);
            contents.add(regionTint);
          }
          if (current.selectedAgent && known.has(cellKey)) {
            const outline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(.93, .006, .93)), new THREE.LineBasicMaterial({ color: wildlingColor(current.selectedAgent), transparent: true, opacity: .78 }));
            outline.position.set(x - center, surfaceHeight + .046, z - center);
            contents.add(outline);
          }
          const resource = current.groundTruth ? truth.get(cellKey)?.object : visible ? cell.object : null;
          if (resource && !isBase) {
            const object = resourceAssetInstance(resource, resourceSources.get(resource));
            object.position.set(x - center + .10, surfaceHeight, z - center - .05);
            object.rotation.y = ((x * 3 + z) % 6) * .7;
            object.userData.resource = resource;
            object.userData.cell = cellKey;
            contents.add(object);
          }
          if (!visible) {
            const veil = new THREE.Mesh(new THREE.PlaneGeometry(.94, .94), new THREE.MeshBasicMaterial({ color: "#eef2e7", transparent: true, opacity: worldSurfaceAccepted ? .38 : .22, depthWrite: false }));
            veil.rotation.x = -Math.PI / 2;
            veil.position.set(x - center, surfaceHeight + .024, z - center);
            contents.add(veil);
            const marker = mesh(new THREE.CylinderGeometry(.027, .027, .006, 10), "#9cad9e", [x - center, surfaceHeight + .032, z - center]);
            marker.castShadow = false;
            contents.add(marker);
          }
        });
      }
      const nextFire = `${surfaceRevision}:${current.world.base.join(",")}:${!!active.models.campfire}`;
      if (fireSignature !== nextFire) {
        fireSignature = nextFire;
        disposeObject(fire);
        fire.clear();
        fire.add(active.models.campfire ? normalizedModel(active.models.campfire, .66) : fallbackCampfire());
        fire.position.set(current.world.base[0] - center, surfaceAt(...current.world.base), current.world.base[1] - center);
        fireLight.position.copy(fire.position).add(new THREE.Vector3(0, .6, 0));
      }
      const infected = new Set(current.groundTruth ? (current.incidents ?? []).filter(incident => !["REPAIRED", "REVOKED", "PREVENTED"].includes(incident.status)).flatMap(incident => incident.affectedAgentIds) : []);
      const ids = new Set(current.agents.map(agent => agent.id));
      active.agents.forEach((entry, id) => {
        if (ids.has(id)) return;
        disposeObject(entry.root);
        characters.remove(entry.root);
        active.agents.delete(id);
      });
      current.agents.forEach(agent => {
        const state = deriveWildlingState(agent, current.events, current.turn ?? 0, { base: current.world.base, showTruth: !!current.groundTruth, infected: infected.has(agent.id) });
        const stage = cognitionStage(state.cognitionStage);
        ensureCognition(stage);
        const peers = current.agents.filter(other => other.position[0] === agent.position[0] && other.position[1] === agent.position[1]);
        const peerIndex = peers.findIndex(other => other.id === agent.id);
        const atBase = agent.position[0] === current.world.base[0] && agent.position[1] === current.world.base[1];
        const spread = peers.length > 1 ? .37 : atBase ? .34 : 0;
        const angle = peerIndex / peers.length * Math.PI * 2 + .3;
        const target = new THREE.Vector3(agent.position[0] - center + Math.cos(angle) * spread, surfaceAt(...agent.position), agent.position[1] - center + Math.sin(angle) * spread);
        let entry = active.agents.get(agent.id);
        if (!entry) {
          const root = new THREE.Group(), body = new THREE.Group();
          const upgradeRing = cognitionUpgradeRing(wildlingColor(agent.id));
          root.add(body, upgradeRing);
          root.position.copy(target);
          root.userData.agentId = agent.id;
          characters.add(root);
          entry = { root, body, target, state, signature: "", previousPosition: agent.position.join(","), stage, upgradeAt: 0, upgradeRing };
          active.agents.set(agent.id, entry);
        }
        if (stage > entry.stage && !state.removed) entry.upgradeAt = performance.now();
        if (stage < entry.stage) entry.upgradeAt = 0;
        entry.stage = stage;
        entry.root.userData.cognitionStage = stage;
        const source = cognitionSources.get(stage) ?? null;
        const signature = JSON.stringify([stage, !!source, state.berry, state.crystal, state.ruffled, state.reputation, state.showTruth && state.infected, state.removed]);
        if (signature !== entry.signature) {
          entry.signature = signature;
          disposeObject(entry.body);
          entry.body.clear();
          if (state.removed) entry.body.add(memorialModel(wildlingColor(agent.id)));
          else entry.body.add(cognitionFigure(source, wildlingColor(agent.id), state));
        }
        if (entry.previousPosition !== agent.position.join(",")) {
          const dx = target.x - entry.root.position.x, dz = target.z - entry.root.position.z;
          if (Math.abs(dx) + Math.abs(dz) > .05) entry.body.rotation.y = Math.atan2(dx, dz);
          entry.previousPosition = agent.position.join(",");
        }
        entry.target.copy(target);
        entry.state = state;
        const ring = entry.body.getObjectByName("identity-ring") as THREE.Mesh | undefined;
        if (ring) {
          (ring.material as THREE.MeshBasicMaterial).opacity = current.selectedAgent === agent.id ? 1 : .56;
          ring.scale.setScalar(current.selectedAgent === agent.id ? 1.2 : 1);
        }
      });
      scene.userData.weather = current.world.weather;
      key.intensity = current.world.weather === "Rain" ? 2.65 : 3.2;
      key.color.set(current.world.weather === "Rain" ? "#ecf3ee" : "#fff1d1");
      fill.intensity = current.world.weather === "Rain" ? .9 : .7;
      publicFeedback.sync(current.events, current.agents, current.turn ?? 0, current.world);
    };
    active.sync();
    const resize = () => {
      const width = Math.max(element.clientWidth, 1), height = Math.max(element.clientHeight, 1);
      const aspect = width / height;
      const halfWidth = (size * .80 + .4) * (width < 460 ? 1.02 : 1);
      const halfHeight = Math.max(size * .55 + .3, halfWidth / aspect);
      camera.left = -halfHeight * aspect;
      camera.right = halfHeight * aspect;
      camera.top = halfHeight;
      camera.bottom = -halfHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
      focus(sceneViewRef.current);
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(element);
    resize();
    const raycaster = new THREE.Raycaster();
    let pointerDown: [number, number] | null = null;
    const onPointerDown = (event: PointerEvent) => { pointerDown = [event.clientX, event.clientY]; };
    const onPointerUp = (event: PointerEvent) => {
      if (!pointerDown || Math.hypot(event.clientX - pointerDown[0], event.clientY - pointerDown[1]) > 7) return;
      const bounds = renderer.domElement.getBoundingClientRect();
      raycaster.setFromCamera(new THREE.Vector2((event.clientX - bounds.left) / bounds.width * 2 - 1, -(event.clientY - bounds.top) / bounds.height * 2 + 1), camera);
      const hit = raycaster.intersectObject(characters, true)[0];
      let picked: THREE.Object3D | null = hit?.object ?? null;
      while (picked && !picked.userData.agentId) picked = picked.parent;
      if (picked?.userData.agentId) latest.current.onSelectAgent(picked.userData.agentId);
      pointerDown = null;
    };
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointerup", onPointerUp);
    const projected = new THREE.Vector3();
    const northOrigin = new THREE.Vector3(), northEnd = new THREE.Vector3();
    const render = (time: number) => {
      if (disposed) return;
      raf = requestAnimationFrame(render);
      if (document.hidden || latest.current.suspended) { lastTime = time; lastFrame = time; return; }
      const frameElapsed = time - lastFrame;
      if (frameElapsed < frameInterval) return;
      lastFrame = time - frameElapsed % frameInterval;
      const delta = Math.min((time - lastTime) / 1000 || .016, .05);
      lastTime = time;
      const motion = reducedMotion.matches ? 0 : time / 1000;
      controls.update();
      if (northPointer.current) {
        northOrigin.set(0, 0, 0).project(camera);
        northEnd.set(0, 0, -1).project(camera);
        const dx = (northEnd.x - northOrigin.x) * element.clientWidth;
        const dy = -(northEnd.y - northOrigin.y) * element.clientHeight;
        northPointer.current.style.transform = `rotate(${Math.atan2(dx, -dy)}rad)`;
      }
      axes.current.forEach((label, coordinate) => {
        const [axis, value] = coordinate.split(":");
        const index = Number(value);
        projected.set(axis === "x" ? index - center : size / 2 + .29, surfaceAt(axis === "x" ? index : size - 1, axis === "x" ? size - 1 : index) - .04, axis === "x" ? size / 2 + .29 : index - center).project(camera);
        const x = (projected.x * .5 + .5) * element.clientWidth;
        const y = (-projected.y * .5 + .5) * element.clientHeight;
        label.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
        label.style.visibility = sceneViewRef.current !== "world" || projected.z > 1 || Math.abs(projected.x) > .98 || Math.abs(projected.y) > .95 ? "hidden" : "visible";
      });
      const occupiedLabels: { x: number; y: number }[] = [];
      active.agents.forEach((entry, id) => {
        const moving = entry.root.position.distanceToSquared(entry.target) > .0005;
        entry.root.position.lerp(entry.target, reducedMotion.matches ? 1 : 1 - Math.exp(-delta * 7));
        entry.root.position.y = surfaceAt(entry.root.position.x + center, entry.root.position.z + center);
        const state = entry.state;
        const upgradeProgress = entry.upgradeAt ? (time - entry.upgradeAt) / 1150 : 2;
        const upgrading = !reducedMotion.matches && !state.removed && upgradeProgress >= 0 && upgradeProgress < 1;
        const pulse = upgrading ? Math.sin(upgradeProgress * Math.PI) : 0;
        entry.upgradeRing.visible = upgrading;
        if (upgrading) { entry.upgradeRing.scale.setScalar(1 + upgradeProgress * 1.8); (entry.upgradeRing.material as THREE.MeshBasicMaterial).opacity = (1 - upgradeProgress) * .8; }
        entry.body.position.y = (!state.removed && !state.sleeping && motion ? moving ? Math.abs(Math.sin(motion * 12)) * .045 : state.speaking || state.eating ? Math.sin(motion * 7) * .025 : 0 : 0) + pulse * .1;
        entry.body.scale.set(1 + pulse * .055, (state.lowEnergy || state.sleeping ? .74 : 1) * (1 + pulse * .09), 1 + pulse * .055);
        entry.body.rotation.z = state.sleeping ? -.11 : state.eating && motion ? Math.sin(motion * 5) * .045 : 0;
        if (!moving && !state.walking) entry.body.rotation.y += (.62 - entry.body.rotation.y) * (1 - Math.exp(-delta * 3));
        const label = labels.current.get(id);
        if (!label) return;
        projected.copy(entry.root.position).add(new THREE.Vector3(0, state.removed ? .9 : COGNITION_HEIGHTS[entry.stage] + .17, 0)).project(camera);
        let x = (projected.x * .5 + .5) * element.clientWidth;
        let y = (-projected.y * .5 + .5) * element.clientHeight;
        const mobileHidden = element.clientWidth < 460 && latest.current.selectedAgent !== id;
        if (!mobileHidden) {
          let attempts = 0;
          while (occupiedLabels.some(other => Math.abs(other.x - x) < 69 && Math.abs(other.y - y) < 24) && attempts < 5) { y -= 25; attempts++; }
          occupiedLabels.push({ x, y });
        }
        x = Math.max(37, Math.min(element.clientWidth - 37, x));
        y = Math.max(26, Math.min(element.clientHeight - 30, y));
        label.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
        label.style.visibility = projected.z > 1 || Math.abs(projected.x) > .95 || Math.abs(projected.y) > .95 || mobileHidden ? "hidden" : "visible";
      });
      const flame = fire.getObjectByName("fire-flame");
      if (flame) flame.scale.y = motion ? 1 + Math.sin(motion * 6) * .065 : 1;
      fireLight.intensity = motion ? 1.75 + Math.sin(motion * 7) * .13 : 1.75;
      publicFeedback.update(time, reducedMotion.matches);
      renderer.render(scene, camera);
      sampleFrame(renderer);
    };
    raf = requestAnimationFrame(render);
    (Object.keys(RESOURCE_ASSETS) as Resource[]).forEach(type => {
      setResourceModels(previous => ({ ...previous, [type]: "loading" }));
      loadLocalModel(RESOURCE_ASSETS[type].path).then(model => {
        if (disposed) return;
        const probe = resourceAssetInstance(type, model);
        const valid = probe.userData.tripoResource === type;
        disposeObject(probe);
        if (!valid) throw new Error("Invalid resource model");
        resourceSources.set(type, model);
        setResourceModels(previous => ({ ...previous, [type]: "glb" }));
        active.sync();
      }).catch(() => { if (!disposed) setResourceModels(previous => ({ ...previous, [type]: "fallback" })); });
    });
    WORLD_PROPS.forEach(definition => {
      setPropModels(previous => ({ ...previous, [definition.id]: "loading" }));
      loadLocalModel(definition.path).then(model => {
        if (disposed) return;
        propSources.set(definition.id, model);
        active.sync();
      }).catch(() => { if (!disposed) setPropModels(previous => ({ ...previous, [definition.id]: "fallback" })); });
    });
    MODEL_KINDS.forEach(kind => {
      loadLocalModel(`/b/models/${kind}.glb`, kind === "world-8x8" ? WORLD_CALIBRATION.sha256 : undefined).then(model => {
        if (disposed) return;
        if (kind === "world-8x8") {
          if (size !== WORLD_CALIBRATION.size) throw new Error("World model grid-size-mismatch");
          const { model: worldModel, report } = calibratedWorldModel(model);
          let attached = false;
          try {
            setSurfaceReport(report);
            worldModel.name = "continuous-world-8x8";
            worldTerrain.add(worldModel);
            attached = true;
            surfaceHeights = report.heights;
            surfaceRevision++;
            worldSurfaceAccepted = true;
            terrain.visible = false;
            overviewBounds = new THREE.Box3().setFromObject(worldModel);
            overviewBounds.expandByPoint(new THREE.Vector3(-size / 2 - .35, TILE_TOP + 1.5, -size / 2 - .35));
            overviewBounds.expandByPoint(new THREE.Vector3(size / 2 + .35, TILE_TOP + 1.5, size / 2 + .35));
            ground.position.y = Math.min(-.9, overviewBounds.min.y - .05);
            active.models[kind] = model;
            setModels(previous => ({ ...previous, [kind]: "glb" }));
            setSurfaceStatus("ready");
            active.sync();
            focus(sceneViewRef.current);
          } finally {
            if (!attached) disposeObject(worldModel);
          }
          return;
        }
        active.models[kind] = model;
        setModels(previous => ({ ...previous, [kind]: "glb" }));
        active.sync();
      }).catch((error: unknown) => {
        if (!disposed) {
          setModels(previous => ({ ...previous, [kind]: "fallback" }));
          if (kind === "world-8x8") setSurfaceStatus(error instanceof Error && error.message.includes("mismatch") ? "asset-version-mismatch" : "missing-model");
        }
      });
    });
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      controls.dispose();
      publicFeedback.dispose();
      disposeObject(scene);
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      runtime.current = null;
    };
  }, [world.size]);

  useEffect(() => { runtime.current?.sync(); }, [props]);
  useEffect(() => {
    if (sceneViewRef.current === "event" && !props.incidents?.length) {
      sceneViewRef.current = "world";
      setSceneView("world");
      runtime.current?.focus("world");
    }
  }, [props.incidents]);

  const changeView = (view: SceneView) => {
    sceneViewRef.current = view;
    setSceneView(view);
    runtime.current?.focus(view);
  };

  const zoom = (factor: number) => {
    const active = runtime.current;
    if (!active) return;
    active.camera.zoom = Math.max(active.controls.minZoom, Math.min(active.controls.maxZoom, active.camera.zoom * factor));
    active.camera.updateProjectionMatrix();
  };
  return <section className={`wild-world-scene b-world-scene ${sceneView !== "world" ? "is-inspecting" : ""}`} aria-label="部落荒野三维地图" data-model-status={modelStatus} data-prop-model-status={webglError ? "unavailable" : propStatus.status} data-prop-model-count={propStatus.count} data-prop-model-names={propStatus.names.join(",")} data-prop-model-states={JSON.stringify(propModels)} data-wildling-model={characterStatus} data-cognition-models={JSON.stringify(stageModels)} data-campfire-model={models.campfire} data-world-model={models["world-8x8"]} data-world-surface={surfaceStatus} data-world-validation={surfaceStatus === "ready" ? "precomputed-sha256" : "unverified"} data-world-sha256={surfaceStatus === "ready" ? WORLD_CALIBRATION.sha256 : undefined} data-world-height-min={surfaceReport?.min} data-world-height-max={surfaceReport?.max} data-world-invalid-cells={JSON.stringify(surfaceReport?.invalidCells ?? [])} data-world-probe-count={surfaceReport?.probeCount ?? 0}>
    <div className="b-scene-heading"><div><span>WILD WORLD / {world.size} × {world.size} · {world.cells.length} 格</span><h2>{sceneView === "world" ? "荒野 · 64格世界" : sceneView === "village" ? `村落广场 · (${world.base.join(", ")})` : publicPosition ? `公开异常 · (${publicPosition.join(", ")})` : `篝火议事 · (${world.base.join(", ")})`}</h2></div><div className="b-scene-weather">{world.weather === "Rain" ? <CloudRain size={17} /> : <Sun size={17} />}<span>{world.weather === "Rain" ? "雨天" : "晴天"}</span><b>T{String(turn).padStart(3, "0")}</b></div></div>
    <div className={`b-scene-stage ${world.weather === "Rain" ? "is-raining" : ""}`} ref={host} data-turn={turn} data-scene-view={sceneView} data-resource-model-states={JSON.stringify(resourceModels)} data-resource-model-count={Object.values(resourceModels).filter(value => value === "glb").length}>
      {webglError && <div className="b-webgl-fallback" role="status"><strong>三维场景暂不可用</strong><span>当前设备未开启 WebGL。成员状态与探索操作仍可继续。</span><div className="b-fallback-grid" style={{ gridTemplateColumns: `repeat(${world.size}, 1fr)` }}>{world.cells.map(cell => <span key={cell.position.join(",")} style={{ background: cell.known || groundTruth ? REGION_COLORS[cell.region] : "#d5dfd5" }} title={`${regionLabel[cell.region]} ${cell.position.join(",")}`} />)}</div></div>}
      <div className="b-scene-tools" role="toolbar" aria-label="地图视角"><button type="button" aria-label="放大地图" title="放大地图" onClick={() => zoom(1.18)} disabled={webglError}><ZoomIn size={17} /></button><button type="button" aria-label="缩小地图" title="缩小地图" onClick={() => zoom(1 / 1.18)} disabled={webglError}><ZoomOut size={17} /></button><button type="button" aria-label="复位地图视角" title="复位地图视角" onClick={() => changeView("world")} disabled={webglError}><RotateCcw size={16} /></button></div>
      <div className="b-scene-views" role="toolbar" aria-label="场景位置"><button type="button" title="荒野地图" aria-label="荒野地图" aria-pressed={sceneView === "world"} onClick={() => changeView("world")}><MapIcon size={16} /></button><button type="button" title={`基地近景 (${world.base.join(", ")})`} aria-label="基地近景" aria-pressed={sceneView === "village"} disabled={webglError} onClick={() => changeView("village")}><House size={16} /></button><button type="button" title={props.incidents?.length ? publicPosition ? `公开调查位置 (${publicPosition.join(", ")})` : "篝火议事" : "尚未发生公开事件"} aria-label="事件现场" aria-pressed={sceneView === "event"} disabled={!props.incidents?.length || webglError} onClick={() => changeView("event")}><ScanSearch size={16} /></button></div>
      <div className="b-map-orientation" aria-hidden="true"><span>N</span><i ref={northPointer} /></div>
      <div className="b-grid-axes" aria-label="8乘8地图坐标轴">{(["x", "y"] as const).flatMap(axis => Array.from({ length: world.size }, (_, index) => <span key={`${axis}:${index}`} ref={element => { if (element) axes.current.set(`${axis}:${index}`, element); else axes.current.delete(`${axis}:${index}`); }} className="b-grid-axis-label" data-axis={axis} data-index={index} aria-label={`${axis} ${index}`}>{index === 0 ? <small>{axis}</small> : null}{index}</span>))}</div>
      <div className="b-agent-labels">{agents.map(agent => <button type="button" key={agent.id} ref={element => { if (element) labels.current.set(agent.id, element); else labels.current.delete(agent.id); }} className={`b-agent-label ${selectedAgent === agent.id ? "is-selected" : ""}`} data-cognition-stage={cognitionStage(agent.cognition?.stage)} data-model-status={stageModels[cognitionStage(agent.cognition?.stage)] ?? "loading"} onClick={() => onSelectAgent(agent.id)} aria-label={`${showNames ? wildlingName(agent.id) : agent.id}，认知 ${COGNITION_ROMAN[cognitionStage(agent.cognition?.stage) - 1]} 阶，能量 ${agent.energy}，${regionLabel[agent.region]}`} aria-pressed={selectedAgent === agent.id} title={`${wildlingName(agent.id)} · ${agent.position.join(",")} · 能量 ${agent.energy}`} style={{ borderColor: wildlingColor(agent.id) }}><i style={{ background: wildlingColor(agent.id) }} />{showNames ? wildlingName(agent.id) : agent.id}<b className="b-agent-stage">{COGNITION_ROMAN[cognitionStage(agent.cognition?.stage) - 1]}</b>{agentIsRemoved(agent) ? <small>纪念</small> : null}</button>)}</div>
      <div className="b-region-key" aria-label="四个生态区域"><span><i style={{ background: REGION_COLORS.NW }} />西北</span><span><i style={{ background: REGION_COLORS.NE }} />东北</span><span><i style={{ background: REGION_COLORS.SW }} />西南</span><span><i style={{ background: REGION_COLORS.SE }} />东南</span></div>
      <span className="b-model-status" role="status">{webglError ? "2D 降级" : models["world-8x8"] === "glb" ? characterStatus === "glb" ? "TRIPO / 连续64格" : characterStatus === "loading" ? "TRIPO地形 / 阶位模型载入中" : "TRIPO地形 / 阶位几何降级" : models["world-8x8"] === "loading" ? "连续世界加载中" : surfaceStatus === "asset-version-mismatch" ? "地形版本未校准 / 几何降级" : "连续格网 / 地形降级"}</span>
      {world.weather === "Rain" && !webglError && <div className="b-rain-sheet" aria-hidden="true">{Array.from({ length: 17 }, (_, index) => <i key={index} style={{ left: `${3 + index * 5.9}%`, top: `${index % 4 * 21}%`, animationDelay: `${index * -.16}s` }} />)}</div>}
    </div>
    <div className="b-scene-roster" aria-label="地图成员">{agents.map(agent => <button key={agent.id} type="button" className={selectedAgent === agent.id ? "is-selected" : ""} onClick={() => onSelectAgent(agent.id)} aria-pressed={selectedAgent === agent.id} title={`${agent.id} · ${regionLabel[agent.region]} (${agent.position.join(",")})`}><i style={{ background: wildlingColor(agent.id) }} /><span>{showNames ? wildlingName(agent.id) : agent.id} <b className="b-agent-stage">{COGNITION_ROMAN[cognitionStage(agent.cognition?.stage) - 1]}</b></span><small>{agentIsRemoved(agent) ? "离队" : agent.energy}</small></button>)}</div>
    <footer className="b-scene-caption"><span><Flame size={13} /> 篝火 ({world.base.join(", ")})</span><span>探索 {world.cells.filter(cell => cell.known).length} / {world.cells.length}</span>{selectedAgent && selectedMember ? <strong title="当前格与近期已观测足迹"><MapPin size={13} />{showNames ? wildlingName(selectedAgent) : selectedAgent} ({selectedMember.position.join(", ")})</strong> : <span>{world.size} × {world.size} 荒野</span>}</footer>
  </section>;
}
