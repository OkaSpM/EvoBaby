import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Pause, Play, RotateCcw, RotateCw } from "lucide-react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { WILDLING_COLORS } from "./Wildling";
import type { MemberCognition } from "../types";
import { cognitionStage } from "../cognition";
import { disposeObject, loadLocalModel, normalizedModel } from "./b-three-assets";
import { cognitionFigure, loadCognitionModel } from "./cognition-three";
import { sampleFrame } from "../three-frame-check";
import { endingModelPath } from "../ending-catalog";

export const RELIC_THEMES: Record<string, { color: string; dark: string; number: string; label: string }> = {
  "慎信部落": { color: "#72d9c0", dark: "#235f52", number: "01", label: "THE WITNESS" },
  "敲锣部落": { color: "#f4bd65", dark: "#765117", number: "02", label: "THE SIGNAL" },
  "走远部落": { color: "#83b9ee", dark: "#365c81", number: "03", label: "THE EXPLORER" },
  "胆小部落": { color: "#c6afea", dark: "#675181", number: "04", label: "THE SHELTER" },
  "健忘部落": { color: "#ec968c", dark: "#864a49", number: "05", label: "THE ECHO" },
  "糊涂部落": { color: "#b8ca7e", dark: "#64733d", number: "06", label: "THE UNKNOWN" }
};
export type RelicStageHandle = { capture: () => Promise<string | null> };
type Props = { name: string; memberCognition?: MemberCognition[] };
const PEOPLE = WILDLING_COLORS;
const themeFor = (name: string) => RELIC_THEMES[name] || RELIC_THEMES["慎信部落"];

function frameRelic(camera: THREE.PerspectiveCamera, aspect: number) {
  const target = new THREE.Vector3(0, 1.05, 0);
  const distanceScale = aspect < 1.4 ? 0.96 : 0.76;
  camera.position.set(4.8, 3.8, 6.9).sub(target).multiplyScalar(distanceScale).add(target);
  camera.aspect = aspect; camera.lookAt(target); camera.updateProjectionMatrix();
}

function memberStages(memberCognition?: MemberCognition[]) {
  return PEOPLE.map((_, index) => cognitionStage(memberCognition?.find(member => Number(member.agentId.replace(/\D/g, "")) === index + 1)?.stage));
}

function makeRelic(name: string, memberCognition?: MemberCognition[]) {
  const theme = themeFor(name);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(33, 1.65, 0.1, 50);
  frameRelic(camera, 1.65);
  const sculpture = new THREE.Group();
  scene.add(sculpture);
  const material = (color: string, metalness = 0, roughness = 0.5) => new THREE.MeshStandardMaterial({ color, metalness, roughness });
  const charcoal = material("#283b39", 0.25, 0.37);
  const enamel = material(theme.color, 0.15, 0.26);
  const porcelain = material("#f9fbf6", 0.05, 0.3);
  const brass = material("#ceb479", 0.7, 0.27);
  const mesh = (geometry: THREE.BufferGeometry, surface: THREE.Material, position: [number, number, number], parent: THREE.Object3D = sculpture) => {
    const item = new THREE.Mesh(geometry, surface);
    item.position.set(...position); item.castShadow = true; item.receiveShadow = true;
    parent.add(item); return item;
  };
  const pedestal = mesh(new THREE.CylinderGeometry(2.02, 1.9, 0.22, 80), charcoal, [0, 0.13, 0]);
  mesh(new THREE.CylinderGeometry(1.91, 1.98, 0.1, 80), enamel, [0, 0.285, 0]);
  mesh(new THREE.CylinderGeometry(1.82, 1.87, 0.045, 80), porcelain, [0, 0.36, 0]);
  pedestal.rotation.y = 0.2;
  const inlay = mesh(new THREE.TorusGeometry(1.73, 0.012, 6, 100), brass, [0, 0.39, 0]);
  inlay.rotation.x = Math.PI / 2;

  const totem = new THREE.Group(); totem.position.set(0, 0.38, -0.28); totem.rotation.y = 0.45; sculpture.add(totem);
  const fallbackTotem = new THREE.Group(); totem.add(fallbackTotem);
  mesh(new THREE.CylinderGeometry(0.48, 0.57, 0.18, 48), charcoal, [0, 0.09, 0], fallbackTotem);
  mesh(new THREE.CylinderGeometry(0.18, 0.23, 0.84, 32), brass, [0, 0.57, 0], fallbackTotem);
  const symbol = new THREE.Group(); symbol.position.y = 1.36; fallbackTotem.add(symbol);
  if (name === "敲锣部落") {
    const gong = mesh(new THREE.CylinderGeometry(0.65, 0.65, 0.14, 64), enamel, [0, 0, 0], symbol);
    gong.rotation.x = Math.PI / 2;
    const rim = mesh(new THREE.TorusGeometry(0.59, 0.037, 12, 64), brass, [0, 0, 0.09], symbol);
    rim.rotation.z = 0.1;
    mesh(new THREE.SphereGeometry(0.2, 24, 16), brass, [0, 0, 0.1], symbol).scale.z = 0.5;
    const hammer = mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.86, 12), charcoal, [0.51, -0.55, 0.36], symbol);
    hammer.rotation.z = -0.52;
    mesh(new THREE.SphereGeometry(0.13, 16, 12), porcelain, [0.28, -0.15, 0.36], symbol);
  } else if (name === "走远部落") {
    const ring = mesh(new THREE.TorusGeometry(0.61, 0.065, 12, 64), enamel, [0, 0.02, 0], symbol);
    ring.rotation.y = 0.14;
    const needle = mesh(new THREE.ConeGeometry(0.22, 0.98, 4), brass, [0, 0.18, 0.09], symbol);
    needle.rotation.z = -0.34;
    mesh(new THREE.SphereGeometry(0.115, 20, 14), porcelain, [0, 0, 0.16], symbol);
    const tail = mesh(new THREE.ConeGeometry(0.16, 0.55, 4), charcoal, [-0.13, -0.26, 0.09], symbol);
    tail.rotation.z = Math.PI - 0.34;
  } else if (name === "胆小部落") {
    const shape = new THREE.Shape(); shape.moveTo(0, -0.7); shape.quadraticCurveTo(0.58, -0.34, 0.57, 0.42);
    shape.lineTo(0, 0.67); shape.lineTo(-0.57, 0.42); shape.quadraticCurveTo(-0.58, -0.34, 0, -0.7);
    const shield = mesh(new THREE.ExtrudeGeometry(shape, { depth: 0.1, bevelEnabled: true, bevelSegments: 3, steps: 1, bevelSize: 0.06, bevelThickness: 0.05 }), enamel, [0, 0, 0], symbol);
    shield.rotation.y = -0.1;
    mesh(new THREE.BoxGeometry(0.09, 0.72, 0.07), brass, [0, 0.04, 0.2], symbol);
    mesh(new THREE.BoxGeometry(0.52, 0.09, 0.07), brass, [0, 0.16, 0.2], symbol);
  } else if (name === "健忘部落") {
    for (let i = 0; i < 5; i++) {
      const ring = mesh(new THREE.TorusGeometry(0.18 + i * 0.11, 0.038, 10, 44, Math.PI * 1.55), i % 2 ? brass : enamel, [0, -0.05 + i * 0.025, i * 0.035], symbol);
      ring.rotation.z = -Math.PI * 0.3 + i * 0.14;
    }
    mesh(new THREE.SphereGeometry(0.085, 16, 12), porcelain, [0, -0.1, 0.12], symbol);
  } else if (name === "糊涂部落") {
    for (let i = 0; i < 3; i++) {
      const ring = mesh(new THREE.TorusGeometry(0.53, 0.08, 12, 64), i === 1 ? brass : enamel, [0, 0, 0], symbol);
      ring.rotation.set(i * 0.95, i * 1.15, i * 0.24);
    }
    mesh(new THREE.IcosahedronGeometry(0.22, 0), porcelain, [0, 0, 0], symbol);
  } else {
    mesh(new THREE.TorusGeometry(0.56, 0.13, 18, 64), enamel, [0, 0, 0], symbol);
    mesh(new THREE.TorusGeometry(0.4, 0.02, 10, 64), brass, [0, 0, 0.07], symbol);
    const iris = mesh(new THREE.SphereGeometry(0.3, 28, 24), porcelain, [0, 0, 0.05], symbol); iris.scale.z = 0.42;
    const pupil = mesh(new THREE.SphereGeometry(0.14, 22, 16), charcoal, [0, 0, 0.185], symbol); pupil.scale.z = 0.6;
  }

  const people: THREE.Group[] = [];
  const fallbackPeople: THREE.Group[] = [];
  const stages = memberStages(memberCognition);
  PEOPLE.forEach((color, i) => {
    // Space the five silhouettes in camera coordinates, not along an oblique world-space arc.
    const viewingAngle = Math.atan2(4.8, 6.9);
    const person = new THREE.Group();
    person.position.set((i - 2) * .72, .4, [.52, 1.04, 1.22, 1.04, .52][i]);
    person.position.applyAxisAngle(new THREE.Vector3(0, 1, 0), viewingAngle);
    person.rotation.y = Math.atan2(camera.position.x - person.position.x, camera.position.z - person.position.z);
    person.scale.setScalar(.68); sculpture.add(person); people.push(person);
    const fallback = cognitionFigure(null, color, { cognitionStage: stages[i] });
    person.add(fallback); fallbackPeople.push(fallback);
    person.userData.cognitionStage = stages[i];
  });

  const floor = mesh(new THREE.PlaneGeometry(100, 100), new THREE.ShadowMaterial({ opacity: 0.16 }), [0, 0.001, 0], scene);
  floor.rotation.x = -Math.PI / 2; floor.castShadow = false;
  scene.add(new THREE.HemisphereLight("#f6fbff", "#94afa1", 2.7));
  const key = new THREE.DirectionalLight("#fff8e8", 4.4); key.position.set(-3, 7, 5); key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024); key.shadow.camera.left = -4; key.shadow.camera.right = 4;
  key.shadow.camera.top = 4; key.shadow.camera.bottom = -4; key.shadow.normalBias = 0.035;
  key.shadow.bias = -0.00015; key.shadow.radius = 4; scene.add(key);
  const rim = new THREE.DirectionalLight("#c6e8f3", 2.2); rim.position.set(4, 4, -4); scene.add(rim);

  let disposed = false;
  const load = async (promise: Promise<THREE.Group>, apply: (object: THREE.Group) => void) => {
    try {
      const source = await promise;
      if (disposed) return false;
      apply(source); return true;
    } catch { return false; }
  };
  const ready = Promise.all([
    Promise.all(people.map((person, i) => load(loadCognitionModel(stages[i]), original => {
      person.remove(fallbackPeople[i]); disposeObject(fallbackPeople[i]);
      person.add(cognitionFigure(original, PEOPLE[i], { cognitionStage: stages[i] }));
    }))),
    (async () => {
      const path = endingModelPath(name);
      if (!path) return false;
      return load(loadLocalModel(path), original => {
        const object = normalizedModel(original, 1.88);
        const bounds = new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3());
        const footprint = Math.max(bounds.x, bounds.z);
        if (footprint > 1.7) object.scale.multiplyScalar(1.7 / footprint);
        // The shelter's closed leaves need a three-quarter view to reveal their volume.
        const showcaseYaw = name === "胆小部落" ? Math.PI / 6 : 0;
        object.rotation.y = Math.atan2(4.8, 6.9) - Math.PI / 2 - totem.rotation.y + showcaseYaw;
        object.position.y = .02;
        totem.add(object);
        fallbackTotem.visible = false;
      });
    })()
  ]).then(([members, generatedTotem]) => ({ wildling: members.every(Boolean), memberCount: members.filter(Boolean).length, totem: generatedTotem }));
  return { scene, camera, sculpture, ready, dispose: () => { disposed = true; disposeObject(scene); } };
}

function makeRenderer() {
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true, powerPreference: "low-power" });
  renderer.setClearColor(0xf0f4f2, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.02;
  return renderer;
}

export async function renderRelicSnapshot(name: string, memberCognition?: MemberCognition[]): Promise<string | null> {
  let renderer: THREE.WebGLRenderer | null = null;
  const relic = makeRelic(name, memberCognition);
  try {
    renderer = makeRenderer(); renderer.setPixelRatio(1); renderer.setSize(1100, 680, false);
    frameRelic(relic.camera, 1100 / 680);
    await relic.ready;
    renderer.render(relic.scene, relic.camera);
    return renderer.domElement.toDataURL("image/png");
  } catch { return null; }
  finally { relic.dispose(); renderer?.dispose(); renderer?.forceContextLoss(); }
}

export const RelicStage = forwardRef<RelicStageHandle, Props>(function RelicStage({ name, memberCognition }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const controls = useRef<OrbitControls | null>(null);
  const capture = useRef<(() => Promise<string | null>) | null>(null);
  const rotating = useRef(false);
  const [isRotating, setRotating] = useState(false);
  const [status, setStatus] = useState("纪念雕塑载入中");
  const [unavailable, setUnavailable] = useState(false);
  const [modelStatus, setModelStatus] = useState("loading");
  const [endingModelStatus, setEndingModelStatus] = useState("loading");
  const cognitionKey = JSON.stringify(memberStages(memberCognition));
  const cognitionRecorded = PEOPLE.every((_, index) => memberCognition?.some(member => Number(member.agentId.replace(/\D/g, "")) === index + 1 && [1, 2, 3, 4].includes(member.stage)));
  useImperativeHandle(ref, () => ({ capture: async () => capture.current?.() || null }), []);
  useEffect(() => {
    const element = host.current; if (!element) return;
    const relic = makeRelic(name, memberCognition);
    setModelStatus("loading");
    setEndingModelStatus("loading");
    let renderer: THREE.WebGLRenderer;
    try { renderer = makeRenderer(); }
    catch { setUnavailable(true); setStatus("当前设备未开启 WebGL，五人纪念像暂不可用"); relic.dispose(); return; }
    setUnavailable(false);
    const canvas = renderer.domElement;
    canvas.setAttribute("role", "img"); canvas.setAttribute("aria-label", `${name}三维纪念雕塑，五位部落成员围绕结局图腾`);
    canvas.tabIndex = 0; element.appendChild(canvas);
    const orbit = new OrbitControls(relic.camera, canvas); controls.current = orbit;
    orbit.target.set(0, 1.05, 0); orbit.enablePan = false; orbit.enableZoom = false; orbit.enableDamping = true;
    orbit.minPolarAngle = Math.PI * 0.18; orbit.maxPolarAngle = Math.PI * 0.48;
    orbit.autoRotateSpeed = 0.45;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    rotating.current = false; setRotating(false);
    const onPreference = () => { if (media.matches) { rotating.current = false; setRotating(false); } };
    media.addEventListener("change", onPreference);
    const stop = () => { rotating.current = false; setRotating(false); };
    orbit.addEventListener("start", stop);
    let alive = true, visible = true, frame = 0, lastRenderTime = 0;
    const frameInterval = 1000 / 30;
    const resize = () => {
      const width = element.clientWidth, height = element.clientHeight;
      if (!width || !height) return;
      renderer.setSize(width, height, false); frameRelic(relic.camera, width / height);
      orbit.update(); orbit.saveState(); renderer.render(relic.scene, relic.camera);
    };
    const observer = new ResizeObserver(resize); observer.observe(element); resize();
    const visibility = new IntersectionObserver(entries => { visible = entries[0]?.isIntersecting ?? true; }); visibility.observe(element);
    const render = (now: number) => {
      if (!alive) return;
      frame = requestAnimationFrame(render);
      if (!visible || document.hidden) { lastRenderTime = now; return; }
      const elapsed = now - lastRenderTime;
      if (elapsed < frameInterval) return;
      lastRenderTime = now;
      orbit.autoRotate = rotating.current; orbit.update(Math.min(elapsed / 1000, 0.1));
      renderer.render(relic.scene, relic.camera); sampleFrame(renderer);
    }; frame = requestAnimationFrame(render);
    relic.ready.then(assets => {
      if (!alive) return;
      setModelStatus(assets.wildling && assets.totem ? "glb" : assets.memberCount || assets.totem ? "partial-glb" : "fallback");
      setEndingModelStatus(assets.totem ? "glb" : "fallback");
      setStatus(cognitionRecorded ? `阶位留存 ${assets.memberCount}/5 · ${assets.totem ? "专属 Tripo 雕塑" : "几何备用雕塑"}` : `造型示意 · 缺项按I呈现 · ${assets.totem ? "专属 Tripo 雕塑" : "几何备用雕塑"}`);
    });
    capture.current = async () => {
      await relic.ready; if (!alive) return null;
      renderer.render(relic.scene, relic.camera); return canvas.toDataURL("image/png");
    };
    return () => {
      alive = false; capture.current = null; controls.current = null;
      cancelAnimationFrame(frame); observer.disconnect(); visibility.disconnect(); media.removeEventListener("change", onPreference);
      orbit.removeEventListener("start", stop); orbit.dispose(); relic.dispose(); renderer.dispose(); renderer.forceContextLoss(); canvas.remove();
    };
  }, [name, cognitionKey, cognitionRecorded]);
  return <div className="relic-stage" role="group" aria-label="部落纪念雕塑" data-model-status={modelStatus} data-ending-model-status={endingModelStatus} data-ending-model-path={endingModelPath(name) || ""} data-member-cognition={cognitionKey} data-cognition-recorded={cognitionRecorded}>
    <div className="relic-viewport" ref={host} />
    {unavailable && <div className="relic-unavailable">三维纪念像暂不可用</div>}
    <div className="relic-stage-bottom"><span className="relic-asset-status" role="status">{status}</span><div className="relic-controls">
      <button type="button" disabled={unavailable} aria-label={isRotating ? "暂停雕塑旋转" : "自动旋转雕塑"} title={isRotating ? "暂停旋转" : "自动旋转"} onClick={() => { rotating.current = !rotating.current; setRotating(rotating.current); }}>{isRotating ? <Pause size={14} /> : <Play size={14} />}</button>
      <button type="button" disabled={unavailable} aria-label="向右旋转雕塑" title="向右旋转" onClick={() => { const orbit = controls.current; if (!orbit) return; rotating.current = false; setRotating(false); const camera = orbit.object; camera.position.sub(orbit.target).applyAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 6).add(orbit.target); orbit.update(); }}><RotateCw size={15} /></button>
      <button type="button" disabled={unavailable} aria-label="重置雕塑视角" title="重置视角" onClick={() => { const orbit = controls.current; if (!orbit) return; rotating.current = false; setRotating(false); orbit.reset(); orbit.update(); }}><RotateCcw size={15} /></button>
    </div></div>
  </div>;
});
