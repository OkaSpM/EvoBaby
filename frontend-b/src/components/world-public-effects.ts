import * as THREE from "three";
import type { AgentSummary, Position, RawEvent, Resource, WorldView } from "../types";
import { disposeObject, mesh, resourceModel } from "./b-three-assets";

type EffectKind = "collect" | "restore" | "setback" | "verify" | "share";
export type PublicEffect = { id: string; kind: EffectKind; agentId: string; turn: number; position: Position; source: "public-action" | "public-milestone"; resource?: Resource; delta?: number; evidenceIds?: string[] };

function validPosition(value: unknown, size: number): value is Position {
  return Array.isArray(value) && value.length === 2 && value.every(coordinate => Number.isInteger(coordinate) && coordinate >= 0 && coordinate < size);
}

export function publicEffectCandidates(events: RawEvent[], agents: AgentSummary[], turn: number, size: number): PublicEffect[] {
  const candidates: PublicEffect[] = [];
  for (const event of events) {
    const result = event.result as (RawEvent["result"] & { position?: unknown });
    if (event.type !== "ACTION_EXECUTED" || event.turn !== turn || !result?.success) continue;
    // The post-action observation can be Base after exhaustion; only the public result retains the action site.
    const position = result.position ?? (result.returned_to_base ? null : event.observation.position);
    if (!validPosition(position, size)) continue;
    const base = { id: event.event_id, agentId: event.agent_id, turn, position: [...position] as Position, source: "public-action" as const };
    if (result.action === "COLLECT" && (result.object === "Berry" || result.object === "Crystal")) candidates.push({ ...base, kind: "collect", resource: result.object });
    else if (result.resource_effect > 0) candidates.push({ ...base, kind: "restore", delta: result.resource_effect });
    else if (result.resource_effect < 0) candidates.push({ ...base, kind: "setback", delta: result.resource_effect });
    else if (result.action === "REQUEST_VERIFY") candidates.push({ ...base, kind: "verify" });
    else if (result.action === "SHARE_BELIEF") candidates.push({ ...base, kind: "share" });
  }
  for (const agent of agents) {
    if (agent.removed || (agent.unavailableUntilTurn != null && agent.unavailableUntilTurn > 100000) || !validPosition(agent.position, size)) continue;
    for (const milestone of agent.cognition?.milestones ?? []) {
      if (milestone.turn !== turn || milestone.stage < 3 || milestone.stage > (agent.cognition?.stage ?? 1) || !milestone.evidenceIds.length) continue;
      candidates.push({ id: `cognition:${agent.id}:${milestone.stage}:${milestone.turn}`, kind: milestone.stage === 4 ? "share" : "verify", agentId: agent.id, turn, position: [...agent.position], source: "public-milestone", evidenceIds: [...milestone.evidenceIds] });
    }
  }
  return candidates;
}

export class PublicEffectCursor {
  private turn: number | null = null;
  private seen = new Set<string>();
  take(candidates: PublicEffect[], turn: number) {
    const reset = this.turn !== null && (turn < this.turn || turn > this.turn + 1);
    const initial = this.turn === null;
    const rewind = this.turn !== null && turn < this.turn;
    if (this.turn !== turn) this.seen.clear();
    this.turn = turn;
    const fresh: PublicEffect[] = [];
    candidates.forEach(candidate => {
      if (!this.seen.has(candidate.id)) fresh.push(candidate);
      this.seen.add(candidate.id);
    });
    return { reset, effects: initial || rewind ? [] : fresh };
  }
}

type Burst = { spec: PublicEffect; root: THREE.Group; startedAt: number; duration: number; fades: { material: THREE.Material & { opacity: number }; opacity: number }[] };

function makeBurst(spec: PublicEffect) {
  const root = new THREE.Group();
  if (spec.kind === "collect" && spec.resource) {
    const collected = resourceModel(spec.resource);
    collected.scale.setScalar(.43);
    collected.name = "collected-resource";
    root.add(collected);
  } else if (spec.kind === "verify" || spec.kind === "share") {
    const paper = mesh(new THREE.BoxGeometry(.13, .17, .012), "#f3e5bd", [-.23, .02, 0]);
    paper.rotation.z = -.16; root.add(paper);
    for (const y of [-.04, 0, .04]) root.add(mesh(new THREE.BoxGeometry(.075, .007, .004), "#7e9b85", [-.23, y + .02, .009]));
    [-1, 1].forEach(side => root.add(mesh(new THREE.OctahedronGeometry(.028), spec.kind === "share" ? "#c3ab64" : "#5eaaa1", [side * .075, -.055, .025])));
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-.055, -.055, .025), new THREE.Vector3(.055, -.055, .025)]), new THREE.LineBasicMaterial({ color: "#88a99b" }));
    root.add(line);
  } else {
    const restorative = spec.kind === "restore";
    for (let index = 0; index < (restorative ? 5 : 4); index++) {
      const angle = index * 2.4;
      const particle = mesh(restorative ? new THREE.OctahedronGeometry(.027) : new THREE.DodecahedronGeometry(.027, 0), restorative ? index % 2 ? "#d8cf92" : "#8dbba0" : "#bd7e66", [Math.cos(angle) * .13, (index % 3) * .04, Math.sin(angle) * .10]);
      particle.scale.set(restorative ? .6 : 1, restorative ? 1.55 : .7, .65);
      root.add(particle);
    }
  }
  const fades: Burst["fades"] = [];
  root.traverse(node => {
    if (!(node instanceof THREE.Mesh) && !(node instanceof THREE.Line)) return;
    if (node instanceof THREE.Mesh) node.castShadow = false;
    (Array.isArray(node.material) ? node.material : [node.material]).forEach(surface => {
      surface.transparent = true; surface.depthWrite = false;
      fades.push({ material: surface, opacity: surface.opacity });
    });
  });
  return { root, fades };
}

export function worldPublicEffects(parent: THREE.Scene, host: HTMLElement, surfaceAt: (x: number, y: number) => number, size: number) {
  const root = new THREE.Group(), ambient = new THREE.Group();
  root.name = "public-action-feedback"; ambient.name = "public-weather-feedback";
  parent.add(root, ambient);
  const center = (size - 1) / 2;
  const cursor = new PublicEffectCursor();
  const bursts: Burst[] = [];
  let lastBatch: PublicEffect[] = [];
  let currentTurn = 0, weather: WorldView["weather"] = "Sunny", base: Position = [0, 0], resting: string[] = [];
  let rainCells: Position[] = [];
  const ripples = Array.from({ length: 10 }, () => {
    const ring = new THREE.Mesh(new THREE.RingGeometry(.80, 1, 16), new THREE.MeshBasicMaterial({ color: "#b5d1cc", transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.visible = false; ambient.add(ring); return ring;
  });
  const smoke = Array.from({ length: 3 }, () => {
    const puff = new THREE.Mesh(new THREE.IcosahedronGeometry(.052, 1), new THREE.MeshBasicMaterial({ color: "#d4ddca", transparent: true, opacity: .12, depthWrite: false }));
    puff.visible = false; ambient.add(puff); return puff;
  });
  const audit = () => {
    host.dataset.publicEffects = JSON.stringify(bursts.map(burst => burst.spec));
    host.dataset.publicEffectCount = String(bursts.length);
    host.dataset.publicEffectTurn = String(currentTurn);
    host.dataset.publicEffectScope = "current-public-actions-and-milestones";
    host.dataset.publicLastBatch = JSON.stringify(lastBatch);
    host.dataset.weatherFeedback = weather === "Rain" ? "known-cell-ripples" : "none";
    host.dataset.restingAgents = resting.join(",");
  };
  const remove = (burst: Burst) => { root.remove(burst.root); disposeObject(burst.root); };
  const clear = () => { bursts.forEach(remove); bursts.length = 0; };
  const sync = (events: RawEvent[], agents: AgentSummary[], turn: number, world: WorldView) => {
    currentTurn = turn; weather = world.weather; base = [...world.base];
    resting = agents.filter(agent => !agent.removed && !(agent.unavailableUntilTurn != null && agent.unavailableUntilTurn > 100000) && agent.position.every((coordinate, index) => coordinate === base[index]) && ((agent.unavailableUntilTurn != null && agent.unavailableUntilTurn > turn) || agent.energy <= 35)).map(agent => agent.id);
    const known = world.cells.filter(cell => cell.known).map(cell => cell.position);
    rainCells = known.filter((_, index) => index % Math.max(1, Math.ceil(known.length / ripples.length)) === 0).slice(0, ripples.length);
    const next = cursor.take(publicEffectCandidates(events, agents, turn, size), turn);
    if (next.reset) { clear(); lastBatch = []; }
    if (next.effects.length) lastBatch = next.effects.slice(-8);
    for (const spec of next.effects.slice(-8)) {
      if (bursts.length >= 8) remove(bursts.shift()!);
      const visual = makeBurst(spec);
      const burst: Burst = { spec, ...visual, startedAt: performance.now(), duration: spec.kind === "setback" ? 950 : 1450 };
      root.add(burst.root); bursts.push(burst);
    }
    audit();
  };
  const update = (now: number, reducedMotion: boolean) => {
    let removed = false;
    for (let index = bursts.length - 1; index >= 0; index--) {
      const burst = bursts[index];
      const progress = (now - burst.startedAt) / (reducedMotion ? 850 : burst.duration);
      if (progress >= 1 || burst.spec.turn > currentTurn) { remove(burst); bursts.splice(index, 1); removed = true; continue; }
      const { kind, position } = burst.spec;
      const rise = reducedMotion ? .08 : kind === "setback" ? Math.sin(progress * Math.PI) * .07 : progress * .36;
      const height = kind === "verify" || kind === "share" ? .85 : kind === "collect" ? .20 : .43;
      burst.root.position.set(position[0] - center, surfaceAt(...position) + height + rise, position[1] - center);
      burst.root.scale.setScalar(reducedMotion ? 1 : kind === "collect" ? 1 - progress * .30 : 1);
      burst.root.rotation.y = reducedMotion ? 0 : kind === "collect" ? progress * .7 : Math.sin(progress * Math.PI) * .13;
      const opacity = reducedMotion ? .8 : Math.min(1, progress / .12) * Math.min(1, (1 - progress) / .4);
      burst.fades.forEach(fade => { fade.material.opacity = fade.opacity * opacity; });
    }
    ripples.forEach((ring, index) => {
      const cell = rainCells[index];
      ring.visible = weather === "Rain" && !!cell && !reducedMotion;
      if (!ring.visible || !cell) return;
      const phase = (now / 1800 + index * .137) % 1;
      ring.position.set(cell[0] - center + .16, surfaceAt(...cell) + .025, cell[1] - center - .13);
      ring.scale.setScalar(.018 + phase * .16);
      ring.material.opacity = Math.sin(phase * Math.PI) * .22;
    });
    smoke.forEach((puff, index) => {
      puff.visible = resting.length > 0;
      if (!puff.visible) return;
      const phase = reducedMotion ? index / 3 : (now / 4400 + index / 3) % 1;
      puff.position.set(base[0] - center + phase * .10, surfaceAt(...base) + .72 + phase * .62, base[1] - center - phase * .05);
      puff.scale.set(.7 + phase * .7, .9 + phase * .45, .7 + phase * .5);
      puff.material.opacity = reducedMotion ? .085 : Math.sin(phase * Math.PI) * .13;
    });
    if (removed) audit();
  };
  return { sync, update, dispose: () => { clear(); parent.remove(root, ambient); disposeObject(ambient); } };
}
