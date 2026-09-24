import * as THREE from "three";
import type { Incident, Position, RawEvent } from "./types";
import { disposeObject, normalizedModel } from "./components/b-three-assets";

export type WorldPropId = "evidence-workbench" | "record-archive" | "warning-gong" | "moss-control-bench";
export type WorldPropState = "loading" | "glb" | "fallback";
export interface WorldPropDefinition {
  id: WorldPropId; name: string; path: string; height: number; footprint: number; rotation: number;
  offset: readonly [number, number];
}
export interface WorldPropPlacement extends WorldPropDefinition {
  anchor: "base" | "public-event"; gridPosition: Position;
}

export const WORLD_PROPS: readonly WorldPropDefinition[] = [
  { id: "evidence-workbench", name: "证据工作台", path: "/b/models/expanded-v2/evidence-workbench.glb", height: .55, footprint: .64, rotation: -.60, offset: [-.5, .5] },
  { id: "record-archive", name: "部落记录架", path: "/b/models/expanded-v2/record-archive.glb", height: .83, footprint: .64, rotation: -.72, offset: [-.5, -.5] },
  { id: "warning-gong", name: "警示锣", path: "/b/models/expanded-v2/warning-gong.glb", height: .76, footprint: .60, rotation: -.65, offset: [.5, -.5] },
  { id: "moss-control-bench", name: "苔藓对照台", path: "/b/models/expanded-v2/moss-control-bench.glb", height: .48, footprint: .64, rotation: -.50, offset: [.5, .5] },
];

function validPosition(value: Position | null | undefined, size: number): value is Position {
  return Array.isArray(value) && value.length === 2 && value.every(item => Number.isFinite(item) && item >= 0 && item < size);
}

export function publicPropEventPosition(size: number, now: number, incidents: Incident[] = [], events: RawEvent[] = []): Position | null {
  const incident = incidents.filter(item => item.injectedTurn <= now).at(-1);
  if (!incident) return null;
  const event = events.filter(item => item.type === "ACTION_EXECUTED" && item.turn >= incident.injectedTurn && item.turn <= now
    && item.result?.action === "USE_MOSS" && item.result.success === true && item.result.object === "Moss" && item.result.resource_effect < 0
    && validPosition(item.observation.position, size) && item.observation.position.every(Number.isInteger))
    .slice().sort((a, b) => b.turn - a.turn)[0];
  return event ? [...event.observation.position] : null;
}

export function placeWorldProps(size: number, base: Position, publicPosition: Position | null = null): WorldPropPlacement[] {
  if (!Number.isInteger(size) || size < 3 || !validPosition(base, size)) return [];
  const intersections: Position[] = [];
  for (let y = .5; y < size - 1; y++) for (let x = .5; x < size - 1; x++) intersections.push([x, y]);
  const used = new Set<string>();
  return WORLD_PROPS.map(definition => {
    const anchor = definition.id === "moss-control-bench" && validPosition(publicPosition, size) ? "public-event" : "base";
    const origin = anchor === "public-event" ? publicPosition! : base;
    const desired: Position = [origin[0] + definition.offset[0], origin[1] + definition.offset[1]];
    const distance = (position: Position) => (position[0] - desired[0]) ** 2 + (position[1] - desired[1]) ** 2;
    const available = intersections.filter(position => !used.has(position.join(","))).sort((a, b) => distance(a) - distance(b) || a[1] - b[1] || a[0] - b[0]);
    const gridPosition = available[0];
    used.add(gridPosition.join(","));
    return { ...definition, anchor, gridPosition: [...gridPosition] };
  });
}

export function propFitFactor(width: number, depth: number, footprint: number): number | null {
  if (![width, depth, footprint].every(value => Number.isFinite(value) && value > 0)) return null;
  return Math.min(1, footprint / Math.max(width, depth));
}

export function fitWorldPropModel(source: THREE.Group, placement: WorldPropDefinition): THREE.Group {
  const original = new THREE.Box3().setFromObject(source).getSize(new THREE.Vector3());
  if (![original.x, original.y, original.z].every(value => Number.isFinite(value) && value > .00001)) throw new Error("Invalid prop model bounds");
  const result = normalizedModel(source, placement.height);
  result.rotation.y = placement.rotation;
  const extent = new THREE.Box3().setFromObject(result).getSize(new THREE.Vector3());
  const factor = propFitFactor(extent.x, extent.z, placement.footprint);
  if (factor === null) { disposeObject(result); throw new Error("Invalid prop footprint"); }
  result.scale.multiplyScalar(factor);
  result.name = `expanded-prop-${placement.id}`;
  result.userData.propId = placement.id;
  result.userData.decorative = true;
  return result;
}

export function worldPropStatus(states: Partial<Record<WorldPropId, WorldPropState>>) {
  const names = WORLD_PROPS.filter(item => states[item.id] === "glb").map(item => item.id);
  return { count: names.length, names, status: names.length === WORLD_PROPS.length ? "glb"
    : WORLD_PROPS.some(item => states[item.id] === undefined || states[item.id] === "loading") ? "loading"
    : names.length ? "partial-glb" : "fallback" };
}
