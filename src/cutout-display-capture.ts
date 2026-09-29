import type { ModelScene } from "@google/model-viewer/lib/three-components/ModelScene.js";
import type { Renderer } from "@google/model-viewer/lib/three-components/Renderer.js";
import {
  Color,
  HalfFloatType,
  Matrix4,
  NeutralToneMapping,
  Vector4,
  WebGLRenderTarget,
  type Object3D,
  type WebGLRenderer,
} from "three";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
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
  type ModelViewerCaptureHost,
} from "./model-scene-access";

type CaptureHost = ModelViewerCaptureHost;

const GUIDE_LAYER_MASK = 1 << SCENE_GUIDE_RENDER_LAYER;
const SCALE_STEPS = [1, 0.79, 0.62, 0.5, 0.4, 0.31, 0.25] as const;
export const MAX_CAPTURE_EDGE = 8192;
// Keep GPU allocations bounded even for a 4096 px export with 2× supersampling.
const CAPTURE_TILE_EDGE = 2048;
const COMMERCE_EXPOSURE = 1.3;

let captureChain: Promise<unknown> = Promise.resolve();

export type CutoutCaptureRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
  fullWidth: number;
  fullHeight: number;
};

export type CutoutCaptureOptions = {
  includeShadow?: boolean;
  /** Multiplier on the measured scene/region size, independent of device density. */
  renderScale?: number;
  /** Crop in the pixel coordinates of an earlier measurement. */
  region?: CutoutCaptureRegion;
};

export type CutoutFrameBounds = CutoutAlphaBounds & {
  frameWidth: number;
  frameHeight: number;
};

/** Measure without changing the live camera, background, or visible canvas. */
export async function measureCutoutFrameBounds(
  mv: CaptureHost,
  opts: CutoutCaptureOptions = {},
): Promise<CutoutFrameBounds | null> {
  const capture = await captureCutoutFrameOffscreen(mv, { ...opts, renderScale: 1 });
  const bounds = findCutoutAlphaBounds(
    capture.data,
    capture.width,
    capture.height,
    DEFAULT_CUTOUT_OPTIONS.alphaThreshold,
  );
  return bounds && { ...bounds, frameWidth: capture.width, frameHeight: capture.height };
}

/** Offscreen render for export — resolution independent of window size. */
export async function captureCutoutFrameOffscreen(
  mv: CaptureHost,
  opts: CutoutCaptureOptions = {},
): Promise<ImageData> {
  const run = captureChain.then(() => captureCutoutFrameOffscreenInner(mv, opts));
  captureChain = run.catch(() => {});
  return run;
}

function captureCutoutFrameOffscreenInner(
  mv: CaptureHost,
  opts: CutoutCaptureOptions,
): ImageData {
  if (!mv.loaded) throw new CutoutExportError("not_ready");

  const modelScene = getModelScene(mv);
  const renderer = getModelRenderer(mv);
  if (!modelScene || !renderer?.threeRenderer) {
    throw new CutoutExportError("not_ready");
  }

  const threeRenderer = renderer.threeRenderer;
  const gl = threeRenderer.getContext();
  if (gl.isContextLost()) throw new CutoutExportError("not_ready");
  const region = opts.region ?? sceneRegion(renderer, modelScene);
  const renderScale = opts.renderScale ?? 1;
  const width = Math.ceil(region.width * renderScale);
  const height = Math.ceil(region.height * renderScale);
  if (![width, height, region.x, region.y, region.fullWidth, region.fullHeight].every(Number.isFinite)) {
    throw new CutoutExportError("too_large");
  }
  if (width < 1 || height < 1 || region.fullWidth <= 0 || region.fullHeight <= 0) {
    throw new CutoutExportError("empty");
  }
  if (width > MAX_CAPTURE_EDGE || height > MAX_CAPTURE_EDGE) {
    throw new CutoutExportError("too_large");
  }

  const tileEdge = Math.min(
    CAPTURE_TILE_EDGE,
    threeRenderer.capabilities.maxTextureSize,
    gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number,
  );
  if (tileEdge < 1) throw new CutoutExportError("too_large");

  // A cloned camera retains the current animated orbit without changing camera
  // attributes (which otherwise freezes responsive framing and emits camera-change).
  const liveCamera = modelScene.getCamera();
  liveCamera.updateWorldMatrix(true, false);
  const camera = liveCamera.clone();
  camera.matrixAutoUpdate = false;
  camera.matrix.copy(liveCamera.matrixWorld);
  camera.layers.mask &= ~GUIDE_LAYER_MASK;
  const fullProjection = liveCamera.projectionMatrix.clone();
  const cropProjection = new Matrix4();

  const includeShadow = opts.includeShadow ?? false;
  const savedBackground = modelScene.background;
  const savedOverrideMaterial = modelScene.overrideMaterial;
  const savedShadowIntensity = modelScene.shadowIntensity;
  const savedShadowVisibility: Array<[Object3D, boolean]> = [];
  if (includeShadow) {
    modelScene.shadow?.traverse((object) => savedShadowVisibility.push([object, object.visible]));
  }
  const savedRenderTarget = threeRenderer.getRenderTarget();
  const savedCubeFace = threeRenderer.getActiveCubeFace();
  const savedMipmapLevel = threeRenderer.getActiveMipmapLevel();
  const savedViewport = threeRenderer.getViewport(new Vector4());
  const savedScissor = threeRenderer.getScissor(new Vector4());
  const savedScissorTest = threeRenderer.getScissorTest();
  const savedAutoClear = threeRenderer.autoClear;
  const savedToneMapping = threeRenderer.toneMapping;
  const savedExposure = threeRenderer.toneMappingExposure;
  const savedClearColor = threeRenderer.getClearColor(new Color());
  const savedClearAlpha = threeRenderer.getClearAlpha();
  const savedXrEnabled = threeRenderer.xr.enabled;

  const sceneTarget = new WebGLRenderTarget(1, 1, {
    type: HalfFloatType,
    depthBuffer: true,
    stencilBuffer: false,
  });
  const outputTarget = new WebGLRenderTarget(1, 1, {
    depthBuffer: false,
    stencilBuffer: false,
  });
  const outputPass = new OutputPass();
  // Transparent rendering produces premultiplied linear RGB. PNG/ImageData uses
  // straight alpha: undo the premultiplication before tone mapping and sRGB.
  outputPass.material.fragmentShader = outputPass.material.fragmentShader.replace(
    "gl_FragColor = texture2D( tDiffuse, vUv );",
    `gl_FragColor = texture2D( tDiffuse, vUv );
     if (gl_FragColor.a > 0.0) gl_FragColor.rgb /= gl_FragColor.a;`,
  );

  try {
    const result = new ImageData(width, height);
    const buffer = new Uint8Array(Math.min(tileEdge, width) * Math.min(tileEdge, height) * 4);
    modelScene.background = null;
    if (!includeShadow) modelScene.setShadowIntensity(0);
    threeRenderer.xr.enabled = false;
    threeRenderer.setClearColor(0x000000, 0);
    threeRenderer.setScissorTest(false);
    threeRenderer.autoClear = true;
    threeRenderer.toneMapping = modelScene.toneMapping;
    applyCutoutRendererExposure(threeRenderer, mv, modelScene);
    if (includeShadow) modelScene.renderShadow(threeRenderer);

    // Do not await while touching the shared renderer: model-viewer's animation
    // loop must never see the temporary background, shadow or render targets.
    for (let y = 0; y < height; y += tileEdge) {
      for (let x = 0; x < width; x += tileEdge) {
        const tileWidth = Math.min(tileEdge, width - x);
        const tileHeight = Math.min(tileEdge, height - y);
        const sourceX = region.x + (x / width) * region.width;
        const sourceY = region.y + (y / height) * region.height;
        const sourceWidth = (tileWidth / width) * region.width;
        const sourceHeight = (tileHeight / height) * region.height;
        // Crop the existing projection, preserving any pre-existing view offset.
        cropProjection.set(
          region.fullWidth / sourceWidth, 0, 0,
          (region.fullWidth - 2 * sourceX - sourceWidth) / sourceWidth,
          0, region.fullHeight / sourceHeight, 0,
          (2 * sourceY + sourceHeight - region.fullHeight) / sourceHeight,
          0, 0, 1, 0,
          0, 0, 0, 1,
        );
        camera.projectionMatrix.copy(fullProjection).premultiply(cropProjection);
        camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
        sceneTarget.setSize(tileWidth, tileHeight);
        outputTarget.setSize(tileWidth, tileHeight);
        threeRenderer.setRenderTarget(sceneTarget);
        threeRenderer.clear(true, true, true);
        threeRenderer.render(modelScene, camera);
        // Rendering to a regular target skips display tone mapping and sRGB in
        // Three.js, so a final output pass is required for viewport-matching PNGs.
        outputPass.render(threeRenderer, outputTarget, sceneTarget, 0, false);
        threeRenderer.readRenderTargetPixels(outputTarget, 0, 0, tileWidth, tileHeight, buffer);
        const rowBytes = tileWidth * 4;
        for (let row = 0; row < tileHeight; row++) {
          const start = (tileHeight - row - 1) * rowBytes;
          result.data.set(buffer.subarray(start, start + rowBytes), ((y + row) * width + x) * 4);
        }
      }
    }
    return result;
  } finally {
    threeRenderer.autoClear = savedAutoClear;
    threeRenderer.toneMapping = savedToneMapping;
    threeRenderer.toneMappingExposure = savedExposure;
    threeRenderer.setClearColor(savedClearColor, savedClearAlpha);
    threeRenderer.xr.enabled = savedXrEnabled;
    threeRenderer.setViewport(savedViewport);
    threeRenderer.setScissor(savedScissor);
    threeRenderer.setScissorTest(savedScissorTest);
    threeRenderer.setRenderTarget(savedRenderTarget, savedCubeFace, savedMipmapLevel);
    sceneTarget.dispose();
    outputTarget.dispose();
    outputPass.dispose();
    modelScene.background = savedBackground;
    modelScene.overrideMaterial = savedOverrideMaterial;
    if (!includeShadow) modelScene.setShadowIntensity(savedShadowIntensity);
    for (const [object, visible] of savedShadowVisibility) object.visible = visible;
    modelScene.queueRender();
  }
}

function applyCutoutRendererExposure(
  threeRenderer: WebGLRenderer,
  mv: CaptureHost,
  modelScene: ModelScene,
): void {
  const exposure = modelScene.exposure;
  const env = mv.getAttribute("environment-image");
  const sky = mv.getAttribute("skybox-image");
  const compensateExposure =
    modelScene.toneMapping === NeutralToneMapping &&
    (env === "neutral" || env === "legacy" || (!env && !sky));
  threeRenderer.toneMappingExposure =
    (Number.isFinite(exposure) ? exposure : 1) * (compensateExposure ? COMMERCE_EXPOSURE : 1);
}

function sceneRegion(renderer: Renderer, modelScene: ModelScene): CutoutCaptureRegion {
  const scaleFactor = SCALE_STEPS[modelScene.scaleStep] ?? 1;
  const dpr = (renderer as unknown as { dpr?: number }).dpr ?? window.devicePixelRatio;
  const sceneWidth = modelScene.width * scaleFactor * dpr;
  const sceneHeight = modelScene.height * scaleFactor * dpr;
  // Bounds measurement needs a silhouette, not a full Retina display readback.
  // A large external screen must not make a normal 4096 px export fail.
  const measureScale = Math.min(1, CAPTURE_TILE_EDGE / Math.max(sceneWidth, sceneHeight));
  const width = Math.ceil(sceneWidth * measureScale);
  const height = Math.ceil(sceneHeight * measureScale);
  return { x: 0, y: 0, width, height, fullWidth: width, fullHeight: height };
}
