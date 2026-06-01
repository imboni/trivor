import type { UiBundle } from "./types";
import { formatBytes, formatCompactCount } from "./format";
import { gltfLoadHint } from "./model-path";

/** Auto meshopt preview threshold (matches Rust `PREVIEW_OPTIMIZE_BYTES`). */
export const PREVIEW_OPTIMIZE_BYTES = 200 * 1024 * 1024;

/** Typical stable limits (matches Rust `VIEWER_*` in `gltf_inspect.rs`). */
export const VIEWER_STABLE_MAX_BYTES = PREVIEW_OPTIMIZE_BYTES;
export const VIEWER_STABLE_MAX_TRIANGLES = 5_000_000;
export const VIEWER_HARD_MAX_BYTES = 1024 * 1024 * 1024;
export const VIEWER_HARD_MAX_TRIANGLES = 20_000_000;

export function isPreviewCachePath(viewerPath: string): boolean {
  return viewerPath.includes("-preview-");
}

const GENERIC_VIEWER_ERRORS = new Set([
  "Failed to load model",
  "This model could not be displayed.",
  "无法显示这个模型。",
]);

function isTechnicalViewerError(message: string): boolean {
  return (
    /\$preparedGLTF/.test(message) ||
    /undefined is not an object/.test(message) ||
    /evaluating ['`]/.test(message) ||
    /^(TypeError|ReferenceError|SyntaxError|RangeError):/.test(message) ||
    /\n\s*at /.test(message)
  );
}

function localizeBackendLoadError(raw: string, ui: UiBundle): string | null {
  if (raw === "GLTFPACK_SIDECAR_MISSING") {
    return ui.error_gltfpack_missing;
  }
  const preview = /^GLTFPACK_PREVIEW_FAILED:(\d+)$/.exec(raw);
  if (preview) {
    const bytes = Number(preview[1]);
    const size = formatBytes(bytes, ui);
    return ui.error_gltfpack_preview_failed.replace("{size}", size);
  }
  return null;
}

function appendSidecarHint(path: string, msg: string, ui: UiBundle): string {
  const sidecar = gltfLoadHint(path, ui);
  if (sidecar && !msg.includes(sidecar)) return `${msg}\n${sidecar}`;
  return msg;
}

function enrichLoadFailureMessage(
  ui: UiBundle,
  path: string,
  base: string,
  fileSizeForPath: (path: string) => number,
): string {
  if (fileSizeForPath(path) < PREVIEW_OPTIMIZE_BYTES) {
    return base;
  }

  const advice = ui.load_export_advice
    .replace("{stable_size}", formatBytes(VIEWER_STABLE_MAX_BYTES, ui))
    .replace("{stable_tris}", formatCompactCount(VIEWER_STABLE_MAX_TRIANGLES, ui.locale))
    .replace("{hard_size}", formatBytes(VIEWER_HARD_MAX_BYTES, ui))
    .replace("{hard_tris}", formatCompactCount(VIEWER_HARD_MAX_TRIANGLES, ui.locale));

  return `${base}\n\n${advice}`;
}

export function resolveLoadFailureMessage(
  ui: UiBundle,
  path: string,
  err: unknown,
  viewerPath: string | null,
  fileSizeForPath: (path: string) => number,
): string {
  const raw = err instanceof Error ? err.message : String(err);
  const backend = localizeBackendLoadError(raw, ui);
  if (backend) {
    return enrichLoadFailureMessage(ui, path, backend, fileSizeForPath);
  }

  const generic =
    raw === ui.error_viewer_load ||
    GENERIC_VIEWER_ERRORS.has(raw) ||
    isTechnicalViewerError(raw);
  if (!generic) {
    return enrichLoadFailureMessage(
      ui,
      path,
      appendSidecarHint(path, raw, ui),
      fileSizeForPath,
    );
  }

  const size = formatBytes(fileSizeForPath(path), ui);
  let base: string;
  if (viewerPath && isPreviewCachePath(viewerPath)) {
    base = ui.error_preview_render_failed.replace("{size}", size);
  } else if (fileSizeForPath(path) >= PREVIEW_OPTIMIZE_BYTES) {
    base = ui.error_large_viewer_failed.replace("{size}", size);
  } else {
    base = ui.error_viewer_load;
  }
  return enrichLoadFailureMessage(ui, path, base, fileSizeForPath);
}
