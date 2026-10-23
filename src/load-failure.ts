import type { UiBundle } from "./types";
import { formatBytes } from "./format";
import { gltfLoadHint } from "./model-path";

/** Auto meshopt preview threshold (matches Rust `PREVIEW_OPTIMIZE_BYTES`). */
export const PREVIEW_OPTIMIZE_BYTES = 200 * 1024 * 1024;

export function isPreviewCachePath(viewerPath: string): boolean {
  const name = viewerPath.split(/[/\\]/).pop() ?? viewerPath;
  return /^(?:preview|structure|preview-budget|detail-budget)-v\d+-/.test(name) || name.includes("-preview-");
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

export function localizeBackendLoadError(raw: string, ui: UiBundle): string | null {
  if (raw === "MODEL_ASSETS_ACCESS_CANCELLED") return ui.error_model_access_cancelled;
  const denied = "MODEL_ASSETS_ACCESS_DENIED:";
  if (raw.startsWith(denied)) {
    return ui.error_model_access_denied.replace("{path}", raw.slice(denied.length));
  }
  if (raw.startsWith("IMPORT_FAILED:")) return ui.error_model_import;
  switch (raw) {
    case "MODEL_PREPARATION_CANCELLED": return ui.error_model_preparation_cancelled;
    case "MODEL_PREPARATION_LARGE_FORMAT_UNSUPPORTED": return ui.error_model_large_format;
    case "MODEL_PREPARATION_UNSUPPORTED_DRACO": return ui.error_model_draco_preview;
    case "MODEL_PREPARATION_BUDGET_EXCEEDED": return ui.error_model_preview_budget;
  }
  if (raw.startsWith("MODEL_PREPARATION_") || raw.startsWith("MODEL_STRUCTURE_")) {
    return ui.error_model_preparation;
  }
  if (raw === "GLTFPACK_SIDECAR_MISSING") {
    return ui.error_gltfpack_missing;
  }
  const preview = /^GLTFPACK_PREVIEW_FAILED:(\d+)$/.exec(raw);
  if (preview) {
    const bytes = Number(preview[1]);
    const size = formatBytes(bytes, ui);
    return ui.error_gltfpack_preview_failed.replace("{size}", size);
  }
  if (raw.startsWith("GLTFPACK_PREVIEW_FAILED:")) return ui.error_model_preparation;
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

  return `${base}\n\n${ui.load_export_advice}`;
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
    if (/^MODEL_(?:ASSETS_ACCESS|PREPARATION|STRUCTURE)_/.test(raw)) return backend;
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
