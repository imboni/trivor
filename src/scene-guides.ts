import type { ModelScene } from "@google/model-viewer/lib/three-components/ModelScene.js";
import { getModelScene as readModelScene } from "./model-scene-access";
import {
  Box3,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PlaneGeometry,
  RingGeometry,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
} from "three";

import { readSceneTheme, sceneThemeEpoch } from "./scene-theme";

export const SCENE_GUIDE_GROUP_NAME = "trivor-scene-guides";
/** Separate layer so offscreen export can omit guides without hiding them. */
export const SCENE_GUIDE_RENDER_LAYER = 1;
const GUIDE_GROUP_NAME = SCENE_GUIDE_GROUP_NAME;

type GuideModelViewer = {
  loaded: boolean;
  getBoundingBoxCenter(): { x: number; y: number; z: number };
  getDimensions(): { x: number; y: number; z: number };
};

export type SceneGuideSyncOptions = {
  previewGrid: boolean;
  showGuides: boolean;
};

const GRID_OBJECT_NAME = "trivor-model-grid";
const GUIDES_CORE_NAME = "trivor-scene-guides-core";

let appliedThemeEpoch = -1;
let appliedOpts: SceneGuideSyncOptions | null = null;

/** Call when the loaded model changes so guides are rebuilt for the new bounds. */
export function resetSceneGuideSyncCache(): void {
  appliedThemeEpoch = -1;
  appliedOpts = null;
}

export function syncSceneGuides(
  mv: GuideModelViewer,
  opts: SceneGuideSyncOptions,
  force = false,
): void {
  const modelScene = readModelScene(mv);
  if (!modelScene) return;

  const wantsGuides = (opts.previewGrid || opts.showGuides) && mv.loaded;
  const existing = modelScene.target.getObjectByName(GUIDE_GROUP_NAME);
  const themeEpoch = sceneThemeEpoch();

  if (
    !force &&
    appliedThemeEpoch === themeEpoch &&
    appliedOpts?.previewGrid === opts.previewGrid &&
    appliedOpts?.showGuides === opts.showGuides &&
    guidesMatchExisting(existing, opts, wantsGuides)
  ) {
    return;
  }

  removeGuides(modelScene);

  if (!wantsGuides) {
    appliedThemeEpoch = themeEpoch;
    appliedOpts = { ...opts };
    requestRender(modelScene);
    return;
  }

  const bbox = readBounds(modelScene, mv);
  const center = bbox.getCenter(new Vector3());
  const size = bbox.getSize(new Vector3());
  const span = Math.max(size.x, size.y, size.z, 0.001);

  const root = new Group();
  root.name = GUIDE_GROUP_NAME;
  root.renderOrder = 10;

  if (opts.previewGrid) {
    root.add(createModelGrid(bbox, span, readSceneTheme()));
  }

  if (opts.showGuides) {
    const theme = readSceneTheme();
    const guides = new Group();
    guides.name = GUIDES_CORE_NAME;
    guides.position.copy(center);
    guides.add(createAxisGizmo(span * 0.36, theme));
    guides.add(createOriginGizmo(span, theme));
    root.add(guides);
  }

  assignSceneGuideLayers(root);
  modelScene.getCamera().layers.enable(SCENE_GUIDE_RENDER_LAYER);
  modelScene.target.add(root);
  appliedThemeEpoch = themeEpoch;
  appliedOpts = { ...opts };
  requestRender(modelScene);
}

function assignSceneGuideLayers(root: Group): void {
  root.traverse((obj) => {
    obj.layers.disableAll();
    obj.layers.enable(SCENE_GUIDE_RENDER_LAYER);
  });
}

function guidesMatchExisting(
  existing: Object3D | undefined,
  opts: SceneGuideSyncOptions,
  wantsGuides: boolean,
): boolean {
  if (!wantsGuides) return existing == null;
  if (!existing) return false;
  const hasGrid = existing.getObjectByName(GRID_OBJECT_NAME) != null;
  const hasCore = existing.getObjectByName(GUIDES_CORE_NAME) != null;
  return hasGrid === opts.previewGrid && hasCore === opts.showGuides;
}

function readBounds(modelScene: ModelScene, mv: GuideModelViewer): Box3 {
  const bbox = modelScene.boundingBox.clone();
  if (!bbox.isEmpty()) return bbox;

  const center = mv.getBoundingBoxCenter();
  const dims = mv.getDimensions();
  bbox.setFromCenterAndSize(
    new Vector3(center.x, center.y, center.z),
    new Vector3(dims.x, dims.y, dims.z),
  );
  return bbox;
}

function createModelGrid(bbox: Box3, span: number, theme: ReturnType<typeof readSceneTheme>): Group {
  const group = new Group();
  group.name = GRID_OBJECT_NAME;

  const floorY = bbox.min.y - span * 0.002;
  const center = bbox.getCenter(new Vector3());
  const size = bbox.getSize(new Vector3());
  const modelRadius = Math.max(size.x, size.z, span * 0.35) * 0.72;
  const cell = pickGridCell(modelRadius * 2);
  const fadeStart = modelRadius * 1.05;
  const fadeEnd = Math.max(modelRadius * 3.6, fadeStart + cell * 10);
  const planeSize = fadeEnd * 3.2;

  const material = new ShaderMaterial({
    uniforms: {
      uCellSize: { value: cell },
      uOpacity: { value: theme.gridOpacity },
      uFadeStart: { value: fadeStart },
      uFadeEnd: { value: fadeEnd },
      uMajorEvery: { value: 5 },
      uFineEvery: { value: 5 },
      uFineWeight: { value: theme.gridFineWeight },
      uMinorWeight: { value: theme.gridMinorWeight },
      uMajorWeight: { value: theme.gridMajorWeight },
      uLineColor: { value: theme.gridLine.clone() },
      uMajorColor: { value: theme.gridMajor.clone() },
    },
    vertexShader: `
      varying vec2 vLocalXZ;
      void main() {
        vLocalXZ = vec2(position.x, position.y);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uCellSize;
      uniform float uOpacity;
      uniform float uFadeStart;
      uniform float uFadeEnd;
      uniform float uMajorEvery;
      uniform float uFineEvery;
      uniform float uFineWeight;
      uniform float uMinorWeight;
      uniform float uMajorWeight;
      uniform vec3 uLineColor;
      uniform vec3 uMajorColor;
      varying vec2 vLocalXZ;

      float gridLine(vec2 xz, float scale) {
        vec2 uv = xz / scale;
        vec2 grid = abs(fract(uv - 0.5) - 0.5);
        vec2 width = fwidth(uv);
        vec2 line = grid / max(width, vec2(0.00008));
        return 1.0 - clamp(min(line.x, line.y), 0.0, 1.0);
      }

      void main() {
        float dist = length(vLocalXZ);
        float fade = 1.0 - smoothstep(uFadeStart, uFadeEnd, dist);
        if (fade <= 0.001) discard;

        float fineScale = uCellSize / uFineEvery;
        float fine = gridLine(vLocalXZ, fineScale) * uFineWeight;
        float minor = gridLine(vLocalXZ, uCellSize) * uMinorWeight;
        float major = gridLine(vLocalXZ, uCellSize * uMajorEvery) * uMajorWeight;
        float lines = max(fine, max(minor, major));
        vec3 color = mix(uLineColor, uMajorColor, step(0.32, major));

        gl_FragColor = vec4(color, lines * fade * uOpacity);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    toneMapped: false,
    side: DoubleSide,
  });

  const plane = new Mesh(new PlaneGeometry(planeSize, planeSize, 1, 1), material);
  plane.renderOrder = 12;
  plane.rotation.x = -Math.PI / 2;
  group.add(plane);
  group.position.set(center.x, floorY, center.z);
  return group;
}

function pickGridCell(extent: number): number {
  const rough = extent / 20;
  const snap = [0.025, 0.05, 0.08, 0.1, 0.15, 0.2, 0.25, 0.5, 1, 2, 5];
  for (const step of snap) {
    if (rough <= step * 1.25) return step;
  }
  return snap[snap.length - 1]!;
}

function createAxisGizmo(length: number, theme: ReturnType<typeof readSceneTheme>): Group {
  const group = new Group();
  group.name = "trivor-axis-gizmo";

  const shaftRadius = length * 0.008;
  const headLength = length * 0.11;
  const headRadius = length * 0.024;

  const x = buildAxisArrow(
    length,
    shaftRadius,
    headLength,
    headRadius,
    theme.axisX,
    theme.overlayAxisShaft,
    theme.overlayAxisHead,
  );
  x.rotation.z = -Math.PI / 2;
  group.add(x);

  const y = buildAxisArrow(
    length,
    shaftRadius,
    headLength,
    headRadius,
    theme.axisY,
    theme.overlayAxisShaft,
    theme.overlayAxisHead,
  );
  group.add(y);

  const z = buildAxisArrow(
    length,
    shaftRadius,
    headLength,
    headRadius,
    theme.axisZ,
    theme.overlayAxisShaft,
    theme.overlayAxisHead,
  );
  z.rotation.x = Math.PI / 2;
  group.add(z);

  setOverlayRenderOrder(group, 900);
  return group;
}

function buildAxisArrow(
  length: number,
  shaftRadius: number,
  headLength: number,
  headRadius: number,
  color: number,
  shaftOpacity: number,
  headOpacity: number,
): Group {
  const axis = new Group();
  const shaftLen = Math.max(length - headLength, length * 0.62);

  const shaft = new Mesh(
    new CylinderGeometry(shaftRadius, shaftRadius, shaftLen, 10),
    overlayMaterial(color, shaftOpacity),
  );
  shaft.position.y = shaftLen / 2;

  const head = new Mesh(
    new ConeGeometry(headRadius, headLength, 12),
    overlayMaterial(color, headOpacity),
  );
  head.position.y = shaftLen + headLength / 2;

  axis.add(shaft, head);
  return axis;
}

function createOriginGizmo(span: number, theme: ReturnType<typeof readSceneTheme>): Group {
  const group = new Group();
  group.name = "trivor-origin-gizmo";

  const core = new Mesh(
    new SphereGeometry(span * 0.016, 16, 16),
    overlayMaterial(theme.origin, theme.overlayOriginCore),
  );
  group.add(core);

  const ring = new Mesh(
    new RingGeometry(span * 0.034, span * 0.039, 32),
    new MeshBasicMaterial({
      color: theme.origin,
      transparent: true,
      opacity: theme.overlayOriginRing,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide,
      toneMapped: false,
    }),
  );
  ring.rotation.x = Math.PI / 2;
  group.add(ring);

  setOverlayRenderOrder(group, 910);
  return group;
}

function overlayMaterial(color: number, opacity: number): MeshBasicMaterial {
  return new MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
}

function setOverlayRenderOrder(root: Object3D, order: number): void {
  root.traverse((child) => {
    child.renderOrder = order;
  });
}

function requestRender(modelScene: ModelScene): void {
  modelScene.queueRender();
}

function removeGuides(modelScene: ModelScene): void {
  const existing = modelScene.target.getObjectByName(GUIDE_GROUP_NAME);
  if (!existing) return;
  disposeObject(existing);
  existing.removeFromParent();
}

function disposeObject(obj: Object3D): void {
  obj.traverse((child) => {
    if (!(child instanceof Mesh || child instanceof LineSegments)) return;
    child.geometry.dispose();
    const mat = child.material;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat.dispose();
  });
}
