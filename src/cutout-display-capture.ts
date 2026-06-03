import type { ModelScene } from "@google/model-viewer/lib/three-components/ModelScene.js";
import type { Renderer } from "@google/model-viewer/lib/three-components/Renderer.js";
import { Color, NeutralToneMapping, Vector4, WebGLRenderTarget, type WebGLRenderer } from "three";
import {
  CutoutExportError,
  DEFAULT_CUTOUT_OPTIONS,
  findCutoutAlphaBounds,
  type CutoutAlphaBounds,
} from "./cutout-export";
import { SCENE_GUIDE_RENDER_LAYER } from "./scene-guides";
import {
  getModelRenderer,
  getModelScene,
  waitModelRender,
  type ModelViewerCaptureHost,
} from "./model-scene-access";

type CaptureHost = ModelViewerCaptureHost;

const GUIDE_LAYER_MASK = 1 << SCENE_GUIDE_RENDER_LAYER;
const SCALE_STEPS = [1, 0.79, 0.62, 0.5, 0.4, 0.31, 0.25] as const;

let captureChain: Promise<unknown> = Promise.resolve();

export type CutoutCaptureOptions = {
  includeShadow?: boolean;
};

const COMMERCE_EXPOSURE = 1.3;

/**
 * Measure alpha silhouette bounds via offscreen render — matches export crop without
 * mutating the visible viewport (no grid flicker).
 */
export async function measureCutoutFrameBounds(
  mv: CaptureHost,
  opts: CutoutCaptureOptions = {},
): Promise<CutoutAlphaBounds | null> {
  const run = captureChain.then(() => measureCutoutFrameBoundsInner(mv, opts));
  captureChain = run.catch(() => {});
  return run;
}

async function measureCutoutFrameBoundsInner(
  mv: CaptureHost,
  opts: CutoutCaptureOptions,
): Promise<CutoutAlphaBounds | null> {
  try {
    const capture = captureCutoutFrameOffscreen(mv, opts);
    return findCutoutAlphaBounds(
      capture.data,
      capture.width,
      capture.height,
      DEFAULT_CUTOUT_OPTIONS.alphaThreshold,
    );
  } catch (err) {
    if (err instanceof CutoutExportError && err.code === "empty") return null;
    throw err;
  }
}

/**
 * Ask model-viewer to render one frame, then read the same WebGL viewport pixels
 * shown on screen (matches exposure, tone mapping, and effects).
 */
export async function captureCutoutFrameForExport(
  mv: CaptureHost,
  opts: CutoutCaptureOptions = {},
): Promise<ImageData> {
  const run = captureChain.then(() => captureCutoutFrameForExportInner(mv, opts));
  captureChain = run.catch(() => {});
  return run;
}

async function captureCutoutFrameForExportInner(
  mv: CaptureHost,
  opts: CutoutCaptureOptions,
): Promise<ImageData> {
  if (!mv.loaded) throw new CutoutExportError("not_ready");

  const modelScene = getModelScene(mv);
  const renderer = getModelRenderer(mv);
  if (!modelScene || !renderer?.threeRenderer) {
    throw new CutoutExportError("not_ready");
  }

  const camera = modelScene.getCamera();
  const includeShadow = opts.includeShadow ?? false;

  const savedBackground = modelScene.background;
  const savedShadowIntensity = modelScene.shadowIntensity;
  const savedShadowAttr = mv.getAttribute("shadow-intensity");
  const savedCameraLayers = camera.layers.mask;

  try {
    syncLiveCamera(mv);

    modelScene.background = null;
    if (!includeShadow) {
      mv.setAttribute("shadow-intensity", "0");
      modelScene.setShadowIntensity(0);
    }
    camera.layers.mask = savedCameraLayers & ~GUIDE_LAYER_MASK;

    modelScene.queueRender();
    await waitModelRender(modelScene, 4);

    return readModelViewerViewportPixels(renderer, modelScene);
  } finally {
    camera.layers.mask = savedCameraLayers;
    modelScene.background = savedBackground;
    if (savedShadowAttr != null) {
      mv.setAttribute("shadow-intensity", savedShadowAttr);
    } else {
      mv.removeAttribute("shadow-intensity");
    }
    modelScene.setShadowIntensity(savedShadowIntensity);
    modelScene.queueRender();
  }
}

function captureCutoutFrameOffscreen(mv: CaptureHost, opts: CutoutCaptureOptions): ImageData {
  if (!mv.loaded) throw new CutoutExportError("not_ready");

  const modelScene = getModelScene(mv);
  const renderer = getModelRenderer(mv);
  if (!modelScene || !renderer?.threeRenderer) {
    throw new CutoutExportError("not_ready");
  }

  syncLiveCamera(mv);

  const camera = modelScene.getCamera();
  const includeShadow = opts.includeShadow ?? false;
  const threeRenderer = renderer.threeRenderer;
  const { width, height } = scenePixelSize(renderer, modelScene);
  if (width < 1 || height < 1) throw new CutoutExportError("empty");

  const savedBackground = modelScene.background;
  const savedShadowIntensity = modelScene.shadowIntensity;
  const savedShadowAttr = mv.getAttribute("shadow-intensity");
  const savedCameraLayers = camera.layers.mask;
  const savedRenderTarget = threeRenderer.getRenderTarget();
  const savedViewport = new Vector4();
  threeRenderer.getViewport(savedViewport);
  const savedAutoClear = threeRenderer.autoClear;
  const savedToneMapping = threeRenderer.toneMapping;
  const savedExposure = threeRenderer.toneMappingExposure;
  const savedClearColor = new Color();
  const savedClearAlpha = threeRenderer.getClearAlpha();
  threeRenderer.getClearColor(savedClearColor);

  const renderTarget = new WebGLRenderTarget(width, height, {
    depthBuffer: true,
    stencilBuffer: false,
  });

  try {
    modelScene.background = null;
    if (!includeShadow) {
      mv.setAttribute("shadow-intensity", "0");
      modelScene.setShadowIntensity(0);
    }
    camera.layers.mask = savedCameraLayers & ~GUIDE_LAYER_MASK;

    applyCutoutRendererExposure(threeRenderer, mv, modelScene);

    threeRenderer.setRenderTarget(renderTarget);
    threeRenderer.setViewport(0, 0, width, height);
    threeRenderer.setClearColor(0x000000, 0);
    threeRenderer.autoClear = true;
    threeRenderer.clear(true, true, true);

    if (includeShadow) {
      modelScene.renderShadow(threeRenderer);
    }

    threeRenderer.toneMapping = modelScene.toneMapping;
    if (modelScene.effectRenderer != null) {
      modelScene.effectRenderer.render(0);
    } else {
      threeRenderer.render(modelScene, camera);
    }

    const buffer = new Uint8Array(width * height * 4);
    threeRenderer.readRenderTargetPixels(renderTarget, 0, 0, width, height, buffer);
    return flipBufferToImageData(buffer, width, height);
  } finally {
    threeRenderer.setRenderTarget(savedRenderTarget);
    threeRenderer.setViewport(savedViewport);
    threeRenderer.autoClear = savedAutoClear;
    threeRenderer.toneMapping = savedToneMapping;
    threeRenderer.toneMappingExposure = savedExposure;
    threeRenderer.setClearColor(savedClearColor, savedClearAlpha);
    renderTarget.dispose();

    camera.layers.mask = savedCameraLayers;
    modelScene.background = savedBackground;
    if (savedShadowAttr != null) {
      mv.setAttribute("shadow-intensity", savedShadowAttr);
    } else {
      mv.removeAttribute("shadow-intensity");
    }
    modelScene.setShadowIntensity(savedShadowIntensity);
  }
}

function applyCutoutRendererExposure(
  threeRenderer: WebGLRenderer,
  mv: CaptureHost,
  modelScene: ModelScene,
): void {
  const exposure = modelScene.exposure;
  const exposureIsNumber = typeof exposure === "number" && !Number.isNaN(exposure);
  const env = mv.getAttribute("environment-image");
  const sky = mv.getAttribute("skybox-image");
  const compensateExposure =
    modelScene.toneMapping === NeutralToneMapping &&
    (env === "neutral" || env === "legacy" || (!env && !sky));
  threeRenderer.toneMappingExposure =
    (exposureIsNumber ? exposure : 1.0) * (compensateExposure ? COMMERCE_EXPOSURE : 1.0);
}

function flipBufferToImageData(
  buffer: Uint8Array,
  width: number,
  height: number,
): ImageData {
  const data = new Uint8ClampedArray(buffer.length);
  const rowBytes = width * 4;
  for (let y = 0; y < height; y++) {
    const srcStart = (height - 1 - y) * rowBytes;
    data.set(buffer.subarray(srcStart, srcStart + rowBytes), y * rowBytes);
  }
  return new ImageData(data, width, height);
}

function syncLiveCamera(mv: CaptureHost): void {
  const orbit = mv.getCameraOrbit();
  const target = mv.getCameraTarget();
  const fov = mv.getFieldOfView();
  if (!Number.isFinite(orbit.radius) || orbit.radius <= 0) return;
  mv.cameraTarget = `${target.x}m ${target.y}m ${target.z}m`;
  if (Number.isFinite(fov) && fov > 0) {
    mv.fieldOfView = `${fov}deg`;
  }
  mv.cameraOrbit = `${orbit.theta}rad ${orbit.phi}rad ${orbit.radius}m`;
  mv.jumpCameraToGoal();
}

function readModelViewerViewportPixels(
  renderer: Renderer,
  modelScene: ModelScene,
): ImageData {
  const { width, height } = scenePixelSize(renderer, modelScene);
  if (width < 1 || height < 1) throw new CutoutExportError("empty");

  const canvas = renderer.threeRenderer!.domElement;
  const internal = renderer as unknown as { height?: number; dpr?: number };
  const dpr = internal.dpr ?? (typeof window !== "undefined" ? window.devicePixelRatio : 1);
  const layoutH = internal.height ?? canvas.height / dpr;
  const srcY = Math.max(0, Math.ceil(layoutH * dpr) - height);

  const scratch = document.createElement("canvas");
  scratch.width = width;
  scratch.height = height;
  const ctx = scratch.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new CutoutExportError("empty");
  ctx.drawImage(canvas, 0, srcY, width, height, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

function scenePixelSize(
  renderer: Renderer,
  modelScene: ModelScene,
): { width: number; height: number } {
  const scaleFactor = SCALE_STEPS[modelScene.scaleStep] ?? 1;
  const dpr =
    (renderer as unknown as { dpr?: number }).dpr ??
    (typeof window !== "undefined" ? window.devicePixelRatio : 1);
  const canvas = renderer.threeRenderer?.domElement;
  const maxW = canvas?.width ?? modelScene.width;
  const maxH = canvas?.height ?? modelScene.height;
  return {
    width: Math.min(Math.ceil(modelScene.width * scaleFactor * dpr), maxW),
    height: Math.min(Math.ceil(modelScene.height * scaleFactor * dpr), maxH),
  };
}
