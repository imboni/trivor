import type { SceneGuideSyncOptions } from "./scene-guides";
import { captureCutoutFrameOffscreen } from "./cutout-display-capture";
import { type ModelViewerCaptureHost } from "./model-scene-access";

export type CutoutExportOptions = {
  paddingPx: number;
  maxLongEdge: number;
  includeShadow: boolean;
  alphaThreshold: number;
  superSampling: 1 | 2;
};

export const DEFAULT_CUTOUT_OPTIONS: CutoutExportOptions = {
  paddingPx: 16,
  maxLongEdge: 2048,
  includeShadow: false,
  alphaThreshold: 1,
  superSampling: 2,
};

export type CutoutExportErrorCode = "not_ready" | "empty" | "too_large";

export class CutoutExportError extends Error {
  readonly code: CutoutExportErrorCode;

  constructor(code: CutoutExportErrorCode) {
    super(code);
    this.code = code;
  }
}

type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

export type CutoutExportContext = {
  mv: ModelViewerCaptureHost;
  guideOpts: SceneGuideSyncOptions;
  syncGuides: (opts: SceneGuideSyncOptions) => void;
  getPresentation: () => boolean;
  setPresentation: (enabled: boolean) => void;
  options?: CutoutExportOptions;
};

export type CutoutAlphaBounds = Bounds;

export function findCutoutAlphaBounds(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  threshold = DEFAULT_CUTOUT_OPTIONS.alphaThreshold,
): CutoutAlphaBounds | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] <= threshold) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return maxX < minX || maxY < minY ? null : { minX, minY, maxX, maxY };
}

/** Padding is measured in final output pixels, independent of capture scale. */
export function computeCutoutRenderScale(
  bounds: Bounds,
  paddingPx: number,
  maxLongEdge: number,
): number {
  const longEdge = Math.max(bounds.maxX - bounds.minX + 1, bounds.maxY - bounds.minY + 1);
  return (maxLongEdge - paddingPx * 2) / longEdge;
}

export async function exportCutoutPng(ctx: CutoutExportContext): Promise<Uint8Array> {
  const options = { ...DEFAULT_CUTOUT_OPTIONS, ...ctx.options };
  if (
    !Number.isInteger(options.maxLongEdge) || options.maxLongEdge < 1 ||
    options.maxLongEdge > 4096 || !Number.isInteger(options.paddingPx) ||
    options.paddingPx < 0 || options.paddingPx * 2 >= options.maxLongEdge ||
    ![1, 2].includes(options.superSampling) || !Number.isFinite(options.alphaThreshold) ||
    options.alphaThreshold < 0 || options.alphaThreshold >= 255
  ) {
    throw new CutoutExportError("too_large");
  }

  const measure = await captureCutoutFrameOffscreen(ctx.mv, {
    includeShadow: options.includeShadow,
  });
  const bounds1x = findCutoutAlphaBounds(
    measure.data, measure.width, measure.height, options.alphaThreshold,
  );
  if (!bounds1x) throw new CutoutExportError("empty");

  // Render just the model region, not a potentially enormous mostly-empty
  // viewport. One measurement-pixel of guard space retains antialiased edges.
  const region = {
    x: Math.max(0, bounds1x.minX - 1),
    y: Math.max(0, bounds1x.minY - 1),
    width: 0,
    height: 0,
    fullWidth: measure.width,
    fullHeight: measure.height,
  };
  region.width = Math.min(measure.width, bounds1x.maxX + 2) - region.x;
  region.height = Math.min(measure.height, bounds1x.maxY + 2) - region.y;
  const renderScale = computeCutoutRenderScale(
    { minX: 0, minY: 0, maxX: region.width - 1, maxY: region.height - 1 },
    options.paddingPx,
    options.maxLongEdge,
  );
  const capture = await captureCutoutFrameOffscreen(ctx.mv, {
    includeShadow: options.includeShadow,
    renderScale: renderScale * options.superSampling,
    region,
  });
  const bounds = findCutoutAlphaBounds(
    capture.data, capture.width, capture.height, options.alphaThreshold,
  );
  if (!bounds) throw new CutoutExportError("empty");

  const output = cropScaleToPngCanvas(capture, bounds, options.paddingPx, options.maxLongEdge);
  try {
    return await canvasToPngBytes(output);
  } finally {
    output.width = output.height = 0;
  }
}

function cropScaleToPngCanvas(
  source: ImageData,
  bounds: Bounds,
  paddingPx: number,
  maxLongEdge: number,
): HTMLCanvasElement {
  const cropW = bounds.maxX - bounds.minX + 1;
  const cropH = bounds.maxY - bounds.minY + 1;
  const scale = computeCutoutRenderScale(bounds, paddingPx, maxLongEdge);
  const drawW = Math.max(1, Math.round(cropW * scale));
  const drawH = Math.max(1, Math.round(cropH * scale));
  const out = document.createElement("canvas");
  out.width = drawW + paddingPx * 2;
  out.height = drawH + paddingPx * 2;
  const ctx = out.getContext("2d");
  if (!ctx) throw new CutoutExportError("empty");

  // Copy only the alpha crop, avoiding a second canvas the size of the viewport.
  const scratch = document.createElement("canvas");
  scratch.width = cropW;
  scratch.height = cropH;
  try {
    const scratchCtx = scratch.getContext("2d");
    if (!scratchCtx) throw new CutoutExportError("empty");
    scratchCtx.putImageData(source, -bounds.minX, -bounds.minY);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(scratch, 0, 0, cropW, cropH, paddingPx, paddingPx, drawW, drawH);
  } finally {
    scratch.width = scratch.height = 0;
  }
  return out;
}

function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new CutoutExportError("empty"));
        return;
      }
      void blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)), reject);
    }, "image/png");
  });
}
