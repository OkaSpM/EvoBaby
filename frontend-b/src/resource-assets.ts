import * as THREE from "three";
import type { Resource } from "./types";
import { disposeObject, normalizedModel, resourceModel } from "./components/b-three-assets";

export const RESOURCE_ASSETS: Record<Resource, { path: string; height: number; footprint: number }> = {
  Berry: { path: "/b/models/expanded-v2/resource-berry.glb", height: .46, footprint: .56 },
  Crystal: { path: "/b/models/expanded-v2/resource-crystal.glb", height: .58, footprint: .55 },
  Moss: { path: "/b/models/expanded-v2/resource-moss.glb", height: .24, footprint: .58 },
};

export function resourceAssetInstance(type: Resource, source?: THREE.Group): THREE.Group {
  if (!source) return resourceModel(type);
  const spec = RESOURCE_ASSETS[type];
  const bounds = new THREE.Box3().setFromObject(source).getSize(new THREE.Vector3());
  if (![bounds.x, bounds.y, bounds.z].every(value => Number.isFinite(value) && value > .00001)) return resourceModel(type);
  const instance = normalizedModel(source, spec.height);
  const size = new THREE.Box3().setFromObject(instance).getSize(new THREE.Vector3());
  // Bound the diagonal as well, because each resource turns with its tile.
  const footprint = Math.hypot(size.x, size.z);
  if (!Number.isFinite(footprint) || footprint <= 0) { disposeObject(instance); return resourceModel(type); }
  instance.scale.multiplyScalar(Math.min(1, spec.footprint / footprint));
  instance.userData.tripoResource = type;
  return instance;
}
