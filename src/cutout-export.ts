import type { SceneGuideSyncOptions } from "./scene-guides";
import { captureCutoutFrameForExport } from "./cutout-display-capture";
import { type ModelViewerCaptureHost } from "./model-scene-access";

export type CutoutExportOptions = {
  paddingPx: number;
  maxLongEdge: number;
  includeShadow: boolean;
  alphaThreshold: number;
};

export const DEFAULT_CUTOUT_OPTIONS: CutoutExportOptions = {
  paddingPx: 16,
  maxLongEdge: 2048,
  includeShadow: false,
  alphaThreshold: 1,
};

export type CutoutExportErrorCode = "not_ready" | "empty";

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
  return findAlphaBounds(data, width, height, threshold);
}

export async function exportCutoutPng(ctx: CutoutExportContext): Promise<Uint8Array> {
  const options = ctx.options ?? DEFAULT_CUTOUT_OPTIONS;
  const capture = await captureCutoutFrameForExport(ctx.mv, {
    includeShadow: options.includeShadow,
  });

  const bounds = findAlphaBounds(
    capture.data,
    capture.width,
    capture.height,
    options.alphaThreshold,
  );
  if (!bounds) throw new CutoutExportError("empty");

  const output = cropScaleToPngCanvas(
    capture,
    bounds,
    options.paddingPx,
    options.maxLongEdge,
  );
  return await canvasToPngBytes(output);
}

function findAlphaBounds(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  threshold: number,
): Bounds | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha <= threshold) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < minX || maxY < minY) return null;
  return { minX, minY, maxX, maxY };
}

function cropScaleToPngCanvas(
  source: ImageData,
  bounds: Bounds,
  paddingPx: number,
  maxLongEdge: number,
): HTMLCanvasElement {
  const cropW = bounds.maxX - bounds.minX + 1;
  const cropH = bounds.maxY - bounds.minY + 1;
  const paddedW = cropW + paddingPx * 2;
  const paddedH = cropH + paddingPx * 2;
  const longEdge = Math.max(paddedW, paddedH);
  const scale = longEdge > maxLongEdge ? maxLongEdge / longEdge : 1;
  const outW = Math.max(1, Math.round(paddedW * scale));
  const outH = Math.max(1, Math.round(paddedH * scale));

  const out = document.createElement("canvas");
  out.width = outW;
  out.height = outH;
  const ctx = out.getContext("2d");
  if (!ctx) throw new CutoutExportError("empty");

  const scratch = document.createElement("canvas");
  scratch.width = source.width;
  scratch.height = source.height;
  const scratchCtx = scratch.getContext("2d");
  if (!scratchCtx) throw new CutoutExportError("empty");
  scratchCtx.putImageData(source, 0, 0);

  const pad = paddingPx * scale;
  ctx.drawImage(
    scratch,
    bounds.minX,
    bounds.minY,
    cropW,
    cropH,
    pad,
    pad,
    cropW * scale,
    cropH * scale,
  );
  return out;
}

function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new CutoutExportError("empty"));
          return;
        }
        void blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)));
      },
      "image/png",
    );
  });
}
