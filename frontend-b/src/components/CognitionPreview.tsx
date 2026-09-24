import { useEffect, useRef, useState } from "react";
import { RotateCcw, RotateCw } from "lucide-react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { CognitionStage } from "../types";
import { wildlingColor, wildlingName } from "./Wildling";
import { disposeObject, mesh } from "./b-three-assets";
import { cognitionFigure, COGNITION_ROMAN, loadCognitionModel } from "./cognition-three";
import { sampleFrame } from "../three-frame-check";
import "../scene-b.css";

type Props = { stage: CognitionStage; agentId: string };
type PreviewRuntime = { show: (stage: CognitionStage, agentId: string) => void; reset: () => void; rotate: () => void };

export function CognitionPreview({ stage, agentId }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const runtime = useRef<PreviewRuntime | null>(null);
  const [status, setStatus] = useState("loading");
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: "low-power" }); }
    catch { setStatus("webgl-unavailable"); return; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.setAttribute("role", "img");
    renderer.domElement.setAttribute("aria-label", "认知形态三维预览，非当前游戏阶位");
    renderer.domElement.dataset.scene = "cognition-preview";
    element.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(31, 1, .1, 30);
    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.enablePan = false;
    orbit.minDistance = 1.4;
    orbit.maxDistance = 6;
    orbit.minPolarAngle = .5;
    orbit.maxPolarAngle = Math.PI * .49;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    orbit.enableDamping = !reducedMotion.matches;
    let frameBounds = new THREE.Box3(new THREE.Vector3(-.53, -.1, -.53), new THREE.Vector3(.53, 1.4, .53));
    const reset = () => {
      const direction = new THREE.Vector3(.12, .13, 1).normalize();
      frameBounds.getCenter(orbit.target);
      camera.position.copy(orbit.target).addScaledVector(direction, 10);
      camera.lookAt(orbit.target); camera.updateMatrixWorld(true);
      const verticalSlope = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      const horizontalSlope = verticalSlope * camera.aspect;
      let distance = 0;
      for (const x of [frameBounds.min.x, frameBounds.max.x]) for (const y of [frameBounds.min.y, frameBounds.max.y]) for (const z of [frameBounds.min.z, frameBounds.max.z]) {
        const corner = new THREE.Vector3(x, y, z).applyMatrix4(camera.matrixWorldInverse);
        const towardsCamera = corner.z + 10;
        distance = Math.max(distance, Math.abs(corner.x) * 1.2 / horizontalSlope + towardsCamera, Math.abs(corner.y) * 1.2 / verticalSlope + towardsCamera);
      }
      camera.position.copy(orbit.target).addScaledVector(direction, Math.max(distance, orbit.minDistance));
      orbit.update();
    };
    reset();
    scene.add(new THREE.HemisphereLight("#fff8e6", "#8dadac", 2.5));
    const key = new THREE.DirectionalLight("#fff5df", 3.2);
    key.position.set(-3, 6, 5); key.castShadow = true;
    key.shadow.mapSize.set(512, 512); key.shadow.normalBias = .025;
    Object.assign(key.shadow.camera, { left: -2, right: 2, top: 2.5, bottom: -2, near: .1, far: 15 });
    scene.add(key);
    const fill = new THREE.DirectionalLight("#d6eaf7", 1.1); fill.position.set(4, 2, -3); scene.add(fill);
    const base = mesh(new THREE.CylinderGeometry(.48, .53, .09, 48), "#d9e3dd", [0, -.055, 0]);
    base.castShadow = false; scene.add(base);
    let figure: THREE.Group | null = null;
    let disposed = false, request = 0, raf = 0, lastFrame = 0, visible = true;
    const show = (nextStage: CognitionStage, nextId: string) => {
      const current = ++request;
      setStatus("loading");
      const replace = (source: THREE.Group | null) => {
        if (figure) { scene.remove(figure); disposeObject(figure); }
        figure = cognitionFigure(source, wildlingColor(nextId), { cognitionStage: nextStage });
        scene.add(figure);
        frameBounds = new THREE.Box3().setFromObject(figure);
        frameBounds.expandByPoint(new THREE.Vector3(-.53, -.1, -.53));
        frameBounds.expandByPoint(new THREE.Vector3(.53, 0, .53));
        reset();
      };
      replace(null);
      loadCognitionModel(nextStage).then(source => {
        if (disposed || current !== request) return;
        replace(source); setStatus("glb");
      }).catch(() => { if (!disposed && current === request) setStatus("fallback"); });
    };
    runtime.current = { show, reset, rotate: () => { camera.position.sub(orbit.target).applyAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 6).add(orbit.target); orbit.update(); } };
    const resize = () => {
      const width = Math.max(element.clientWidth, 1), height = Math.max(element.clientHeight, 1);
      renderer.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix(); reset();
    };
    const observer = new ResizeObserver(resize); observer.observe(element); resize();
    const intersection = new IntersectionObserver(entries => { visible = entries[0]?.isIntersecting ?? true; }); intersection.observe(element);
    const render = (now: number) => {
      if (disposed) return;
      raf = requestAnimationFrame(render);
      if (!visible || document.hidden || now - lastFrame < 1000 / 30) return;
      lastFrame = now; orbit.update(); renderer.render(scene, camera); sampleFrame(renderer);
    };
    raf = requestAnimationFrame(render);
    return () => {
      disposed = true; request++; runtime.current = null;
      cancelAnimationFrame(raf); observer.disconnect(); intersection.disconnect(); orbit.dispose();
      disposeObject(scene); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
    };
  }, []);
  useEffect(() => { runtime.current?.show(stage, agentId); }, [stage, agentId]);
  return <div className="cognition-3d-preview" data-preview="true" data-stage={stage} data-agent-id={agentId} data-model-status={status} aria-label={`${wildlingName(agentId)} ${COGNITION_ROMAN[stage - 1]}阶造型预览，非当前游戏阶位`}>
    <div className="cognition-3d-viewport" ref={host} />
    <span className="cognition-3d-status" role="status">{status === "glb" ? "TRIPO 3D" : status === "loading" ? "模型载入中" : status === "webgl-unavailable" ? "WebGL 暂不可用" : "程序形态 / 模型降级"}</span>
    <div className="cognition-3d-tools" role="toolbar" aria-label="造型预览视角">
      <button type="button" title="旋转造型" aria-label="旋转造型预览" disabled={status === "webgl-unavailable"} onClick={() => runtime.current?.rotate()}><RotateCw size={16} /></button>
      <button type="button" title="复位造型" aria-label="复位造型预览" disabled={status === "webgl-unavailable"} onClick={() => runtime.current?.reset()}><RotateCcw size={16} /></button>
    </div>
  </div>;
}
