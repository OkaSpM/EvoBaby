import * as THREE from "three";
import type { CognitionStage } from "../types";
import { cognitionStage } from "../cognition";
import type { WildlingState } from "./Wildling";
import { loadLocalModel, mesh, normalizedModel, wildlingAccessories } from "./b-three-assets";

export const COGNITION_HEIGHTS: Record<CognitionStage, number> = { 1: 1.1, 2: 1.17, 3: 1.23, 4: 1.4 };
export const COGNITION_ROMAN = ["I", "II", "III", "IV"] as const;

export function loadCognitionModel(stage: CognitionStage) {
  return loadLocalModel(`/b/models/cognition-${stage}.glb`);
}

function identityGarments(color: string, stage: CognitionStage) {
  const outfit = new THREE.Group();
  const capeHeight = stage === 4 ? .51 : stage === 2 ? .28 : .31;
  const cape = mesh(new THREE.CylinderGeometry(.215, stage === 4 ? .34 : .29, capeHeight, 20, 1, true, Math.PI / 2, Math.PI), color, [0, .59 - capeHeight / 2, -.025]);
  (cape.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
  cape.name = "identity-cape";
  outfit.add(cape);
  const panel = new THREE.Shape();
  panel.moveTo(-.135, .16); panel.lineTo(.135, .16); panel.lineTo(.16, -.11); panel.quadraticCurveTo(0, -.18, -.16, -.11); panel.closePath();
  const apron = mesh(new THREE.ExtrudeGeometry(panel, { depth: .014, bevelEnabled: true, bevelSegments: 1, steps: 1, bevelSize: .013, bevelThickness: .007 }), color, [0, .34, .208]);
  apron.name = "identity-front-tunic";
  outfit.add(apron);
  const collar = mesh(new THREE.TorusGeometry(.21, .027, 5, 20), color, [0, .54, -.012], [1, 1, .85]);
  collar.rotation.x = Math.PI / 2;
  outfit.add(collar);
  outfit.add(mesh(new THREE.OctahedronGeometry(.038), "#ead7a1", [0, .465, .25]));
  return outfit;
}

function leaf(color: string, position: [number, number, number], scale: [number, number, number], angle = 0) {
  const object = mesh(new THREE.SphereGeometry(1, 10, 7), color, position, scale);
  object.rotation.z = angle;
  return object;
}

function recordBook(open: boolean) {
  const book = new THREE.Group();
  if (open) {
    [-1, 1].forEach(side => {
      const page = mesh(new THREE.BoxGeometry(.15, .19, .025), "#f5e4ac", [side * .074, 0, 0]);
      page.rotation.y = side * -.22;
      book.add(page);
    });
  } else {
    book.add(mesh(new THREE.BoxGeometry(.19, .245, .06), "#987555", [0, 0, 0]));
    book.add(mesh(new THREE.BoxGeometry(.14, .19, .008), "#ead7a2", [0, 0, .035]));
  }
  [-.05, 0, .05].forEach(y => book.add(mesh(new THREE.BoxGeometry(open ? .2 : .10, .008, .005), "#a08854", [0, y, .04])));
  return book;
}

function fallbackCognition(stage: CognitionStage, color: string) {
  const body = new THREE.Group();
  body.name = `cognition-${stage}-procedural-fallback`;
  body.add(mesh(new THREE.CylinderGeometry(.18, .24, .33, 12), color, [0, .33, 0]));
  body.add(mesh(new THREE.SphereGeometry(.272, 20, 14), "#f0c7a5", [0, .735, .025], [1, .95, .86]));
  const hair = mesh(new THREE.SphereGeometry(.278, 18, 12, 0, Math.PI * 2, 0, Math.PI * .52), "#d8aa52", [0, .79, .005], [1.04, .89, .95]);
  body.add(hair);
  [-1, 1].forEach(side => {
    body.add(mesh(new THREE.SphereGeometry(.07, 10, 8), "#edc09d", [side * .268, .75, .02], [.6, 1, .85]));
    body.add(mesh(new THREE.SphereGeometry(.077, 12, 10), "#f9f9e8", [side * .10, .765, .241], [1, 1.12, .46]));
    body.add(mesh(new THREE.SphereGeometry(.041, 12, 9), "#285b54", [side * .10, .76, .273], [.8, 1.05, .38]));
    body.add(mesh(new THREE.SphereGeometry(.012, 8, 7), "#ffffff", [side * .09, .778, .291]));
    const arm = mesh(new THREE.CapsuleGeometry(.055, .14, 3, 8), "#efc4a0", [side * .255, .39, .04]);
    arm.rotation.z = side * .25; body.add(arm);
    body.add(mesh(new THREE.SphereGeometry(.085, 10, 8), "#796553", [side * .12, .065, .045], [.85, .7, 1.4]));
  });
  body.add(mesh(new THREE.SphereGeometry(.036, 10, 8), "#dbaa8b", [0, .695, .274], [1, .65, .7]));
  if (stage === 1) {
    body.add(leaf("#8bbc6c", [.065, 1.035, 0], [.07, .13, .025], -.45));
    body.add(mesh(new THREE.BoxGeometry(.15, .17, .08), "#a28057", [-.23, .285, .07]));
  } else if (stage === 2) {
    const hood = mesh(new THREE.SphereGeometry(.32, 18, 14, .40, Math.PI * 2 - .80, 0, Math.PI * .60), "#83b45b", [0, .77, -.028], [1, 1.04, .98]);
    body.add(hood);
    body.add(leaf("#a9cb76", [0, 1.075, -.06], [.085, .135, .027], -.25));
    const book = recordBook(false); book.position.set(-.28, .41, .19); book.rotation.z = -.18; body.add(book);
  } else if (stage === 3) {
    const brim = mesh(new THREE.ConeGeometry(.43, .16, 12), "#78a65d", [0, 1.02, -.025], [1, 1, .86]);
    body.add(brim);
    body.add(mesh(new THREE.ConeGeometry(.265, .27, 12), "#91ba65", [0, 1.14, -.025], [1, 1, .87]));
    const lens = mesh(new THREE.TorusGeometry(.10, .026, 8, 24), "#94774e", [.30, .57, .20]);
    body.add(lens);
    body.add(mesh(new THREE.CircleGeometry(.09, 24), "#b8e6e3", [.30, .57, .202]));
    const handle = mesh(new THREE.CylinderGeometry(.019, .019, .15, 8), "#98744a", [.30, .435, .20]); body.add(handle);
    body.add(mesh(new THREE.CylinderGeometry(.057, .057, .14, 10), "#c6dcd2", [-.28, .32, .13]));
  } else {
    for (let index = 0; index < 5; index++) {
      const angle = (index - 2) * .35;
      body.add(leaf(index % 2 ? "#91be69" : "#6ea362", [Math.sin(angle) * .28, 1.10 + Math.cos(angle) * .10, -.035], [.073, .20, .03], -angle));
    }
    const band = mesh(new THREE.TorusGeometry(.235, .023, 6, 24), "#d6bf80", [0, .965, .01]); band.rotation.x = Math.PI / 2; body.add(band);
    body.add(mesh(new THREE.CylinderGeometry(.024, .03, 1.08, 10), "#95704a", [.34, .58, .015]));
    for (let index = 0; index < 3; index++) {
      const ring = mesh(new THREE.TorusGeometry(.06, .012, 6, 16), "#d9c180", [.34, .98 + index * .065, .015]);
      ring.rotation.x = Math.PI / 2; body.add(ring);
    }
    const book = recordBook(true); book.position.set(-.25, .50, .18); book.rotation.y = -.20; body.add(book);
  }
  return body;
}

// The mask requires saturated green garment pixels inside the torso band; skin, hair and eyes stay intact.
function recolorGarments(figure: THREE.Group, color: string, stage: CognitionStage) {
  figure.updateMatrixWorld(true);
  figure.traverse(node => {
    if (!(node instanceof THREE.Mesh)) return;
    const localMatrix = node.matrixWorld.clone();
    const surfaces = Array.isArray(node.material) ? node.material : [node.material];
    surfaces.forEach(surface => {
      if (!(surface instanceof THREE.MeshStandardMaterial)) return;
      const identityColor = new THREE.Color(color);
      surface.onBeforeCompile = shader => {
        shader.uniforms.cognitionClothColor = { value: identityColor };
        shader.uniforms.cognitionLocalMatrix = { value: localMatrix };
        shader.uniforms.cognitionClothTop = { value: stage === 4 ? .73 : .65 };
        shader.vertexShader = `uniform mat4 cognitionLocalMatrix; varying float vCognitionHeight;\n${shader.vertexShader}`;
        shader.vertexShader = shader.vertexShader.replace("#include <begin_vertex>", "#include <begin_vertex>\nvCognitionHeight = (cognitionLocalMatrix * vec4(transformed, 1.0)).y;");
        shader.fragmentShader = `uniform vec3 cognitionClothColor; uniform float cognitionClothTop; varying float vCognitionHeight;\n${shader.fragmentShader}`;
        shader.fragmentShader = shader.fragmentShader.replace("#include <color_fragment>", `#include <color_fragment>
          float greenExcess = diffuseColor.g - max(diffuseColor.r, diffuseColor.b);
          float clothMask = smoothstep(0.018, 0.065, greenExcess) * smoothstep(0.10, 0.18, vCognitionHeight) * (1.0 - smoothstep(cognitionClothTop - 0.05, cognitionClothTop, vCognitionHeight));
          float clothShade = clamp(diffuseColor.g * 1.8 + 0.28, 0.36, 1.2);
          diffuseColor.rgb = mix(diffuseColor.rgb, cognitionClothColor * clothShade, clothMask);
        `);
      };
      surface.customProgramCacheKey = () => "cognition-clothes-v1";
      surface.needsUpdate = true;
    });
  });
}

export function cognitionFigure(source: THREE.Group | null, color: string, state: WildlingState = {}) {
  const stage = cognitionStage(state.cognitionStage);
  const result = new THREE.Group();
  result.userData.cognitionStage = stage;
  result.userData.modelStatus = source ? "glb" : "fallback";
  result.userData.identityGarment = source ? "texture-mask" : "physical-outfit";
  if (source) {
    const figure = normalizedModel(source, COGNITION_HEIGHTS[stage]);
    // All four Tripo meshes face +X (checked against eye UVs and surface normals).
    figure.rotation.y = -Math.PI / 2;
    recolorGarments(figure, color, stage);
    result.add(figure);
  } else {
    result.add(fallbackCognition(stage, color));
    result.add(identityGarments(color, stage));
  }
  result.add(wildlingAccessories(color, state, false));
  return result;
}

export function cognitionUpgradeRing(color: string) {
  const ring = new THREE.Mesh(new THREE.RingGeometry(.34, .37, 44), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = .035;
  ring.visible = false;
  ring.name = "cognition-upgrade-ring";
  return ring;
}
