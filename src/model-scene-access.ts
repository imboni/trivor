import { $renderer, $scene } from "@google/model-viewer/lib/model-viewer-base.js";
import type { ModelScene } from "@google/model-viewer/lib/three-components/ModelScene.js";
import type { Renderer } from "@google/model-viewer/lib/three-components/Renderer.js";

export type ModelViewerSceneHost = {
  loaded: boolean;
};

/** model-viewer element with camera API used for cutout capture. */
export type ModelViewerCaptureHost = ModelViewerSceneHost &
  HTMLElement & {
    getCameraOrbit(): { theta: number; phi: number; radius: number };
    getCameraTarget(): { x: number; y: number; z: number };
    getFieldOfView(): number;
    cameraTarget: string;
    cameraOrbit: string;
    fieldOfView: string;
    jumpCameraToGoal(): void;
  };

export function getModelScene(mv: ModelViewerSceneHost): ModelScene | null {
  const internal = mv as unknown as Record<symbol, ModelScene | undefined>;
  return internal[$scene] ?? null;
}

export function getModelRenderer(mv: ModelViewerSceneHost): Renderer | null {
  const internal = mv as unknown as Record<symbol, Renderer | undefined>;
  return internal[$renderer] ?? null;
}

export function getWebGLCanvas(mv: ModelViewerSceneHost): HTMLCanvasElement | null {
  const renderer = getModelRenderer(mv);
  return renderer?.threeRenderer?.domElement ?? null;
}

export async function waitModelRender(modelScene: ModelScene, frames = 3): Promise<void> {
  modelScene.queueRender();
  await new Promise<void>((resolve) => {
    let left = frames;
    const tick = () => {
      if (--left <= 0) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
