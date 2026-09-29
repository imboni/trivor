import type { Mesh, MeshPhysicalMaterial, MeshStandardMaterial, Object3D } from "three";
import { getModelScene, type ModelViewerSceneHost } from "./model-scene-access";

export type ColorPreset = "original" | "clay" | "warm" | "cool";

export type ModelAppearanceOptions = {
  preset: ColorPreset;
  opacity: number;
};

type MaterialSnapshot = {
  color: { r: number; g: number; b: number };
  opacity: number;
  transparent: boolean;
  depthWrite: boolean;
  alphaTest: number;
  roughness: number;
  roughnessMap: MeshStandardMaterial["roughnessMap"];
  metalness: number;
  emissive?: { r: number; g: number; b: number };
  physical: Partial<Pick<MeshPhysicalMaterial, "transmission" | "clearcoat" | "sheen" | "iridescence">>;
  onBeforeCompile: MeshStandardMaterial["onBeforeCompile"];
  customProgramCacheKey: MeshStandardMaterial["customProgramCacheKey"];
  programKey: string;
  clay: boolean;
};

type AppearanceMaterial = MeshStandardMaterial & MaterialSnapshot["physical"];

let applied = new WeakMap<Object3D, ModelAppearanceOptions>();
const snapshots = new WeakMap<object, MaterialSnapshot>();

const PRESET_TINT: Record<Exclude<ColorPreset, "original">, { r: number; g: number; b: number }> = {
  clay: { r: 0.82, g: 0.8, b: 0.78 },
  warm: { r: 1.08, g: 1.0, b: 0.92 },
  cool: { r: 0.92, g: 0.98, b: 1.08 },
};

export function resetModelAppearanceCache(): void {
  applied = new WeakMap();
}

function isMesh(node: Object3D): node is Mesh {
  return (node as Mesh).isMesh === true;
}

export function syncModelAppearance(
  mv: ModelViewerSceneHost,
  opts: ModelAppearanceOptions,
  force = false,
): void {
  if (!mv.loaded) return;
  const modelScene = getModelScene(mv);
  // Guides and the ground shadow are siblings of the model, not model content.
  const root = modelScene?.model;
  if (!modelScene || !root) return;

  const opacity = Number.isFinite(opts.opacity) ? Math.min(1, Math.max(0, opts.opacity)) : 1;
  const previous = applied.get(root);
  if (
    !force &&
    previous?.preset === opts.preset &&
    previous.opacity === opacity
  ) {
    return;
  }

  const visited = new Set<AppearanceMaterial>();
  root.traverse((node) => {
    if (!isMesh(node) || !node.material) return;

    const materials = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of materials) {
      const mat = material as AppearanceMaterial;
      if (!mat.color || visited.has(mat)) continue;
      visited.add(mat);

      if (!snapshots.has(mat)) {
        snapshots.set(mat, {
          color: { r: mat.color.r, g: mat.color.g, b: mat.color.b },
          opacity: mat.opacity ?? 1,
          transparent: Boolean(mat.transparent),
          depthWrite: mat.depthWrite,
          alphaTest: mat.alphaTest,
          roughness: mat.roughness,
          roughnessMap: mat.roughnessMap,
          metalness: mat.metalness,
          emissive: mat.emissive
            ? { r: mat.emissive.r, g: mat.emissive.g, b: mat.emissive.b }
            : undefined,
          physical: {
            transmission: mat.transmission,
            clearcoat: mat.clearcoat,
            sheen: mat.sheen,
            iridescence: mat.iridescence,
          },
          onBeforeCompile: mat.onBeforeCompile,
          customProgramCacheKey: mat.customProgramCacheKey,
          programKey: mat.customProgramCacheKey(),
          clay: false,
        });
      }

      const snap = snapshots.get(mat)!;
      if (opts.preset === "original") {
        mat.color.setRGB(snap.color.r, snap.color.g, snap.color.b);
      } else if (opts.preset === "clay") {
        const tint = PRESET_TINT.clay;
        mat.color.setRGB(tint.r, tint.g, tint.b);
      } else {
        const tint = PRESET_TINT[opts.preset];
        mat.color.setRGB(
          snap.color.r * tint.r,
          snap.color.g * tint.g,
          snap.color.b * tint.b,
        );
      }

      const clay = opts.preset === "clay";
      const transparent = opacity < 1 || snap.transparent;
      const shaderChanged = snap.clay !== clay || mat.transparent !== transparent;
      if (snap.clay !== clay) {
        if (clay) {
          // Keep texture/vertex alpha for cut-out leaves, fences, etc., while
          // replacing their RGB with a neutral color. Removing map loses alpha.
          mat.onBeforeCompile = function (shader, renderer) {
            snap.onBeforeCompile.call(this, shader, renderer);
            shader.fragmentShader = shader.fragmentShader.replace(
              "#include <color_fragment>",
              "#include <color_fragment>\n\tdiffuseColor.rgb = diffuse;",
            );
          };
          mat.customProgramCacheKey = () => `${snap.programKey}|trivor-clay-v1`;
        } else {
          mat.onBeforeCompile = snap.onBeforeCompile;
          mat.customProgramCacheKey = snap.customProgramCacheKey;
        }
        if (snap.roughness !== undefined) {
          mat.roughness = clay ? 0.9 : snap.roughness;
          mat.roughnessMap = clay ? null : snap.roughnessMap;
          mat.metalness = clay ? 0 : snap.metalness;
        }
        if (snap.emissive) {
          const c = snap.emissive;
          mat.emissive.setRGB(clay ? 0 : c.r, clay ? 0 : c.g, clay ? 0 : c.b);
        }
        for (const key of ["transmission", "clearcoat", "sheen", "iridescence"] as const) {
          const original = snap.physical[key];
          if (original !== undefined) mat[key] = clay ? 0 : original;
        }
        snap.clay = clay;
      }

      mat.transparent = transparent;
      mat.opacity = opacity * snap.opacity;
      mat.depthWrite = opacity < 1 ? false : snap.depthWrite;
      // Fade masked materials without discarding their entire surface when the
      // requested opacity drops below their original alpha-test threshold.
      mat.alphaTest = snap.alphaTest * opacity;
      if (shaderChanged) mat.needsUpdate = true;
    }
  });

  // Record synchronously: an old render wait must not repopulate the cache
  // after a model switch, or race a newer slider change.
  applied.set(root, { preset: opts.preset, opacity });
  modelScene.queueRender();
}
