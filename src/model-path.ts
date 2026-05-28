import type { UiBundle } from "./types";

const MODEL_EXT = new Set(["glb", "gltf"]);

/** File extension from the basename (handles `foo.bar.gltf`). */
export function modelExtension(path: string): string {
  const base = path.split(/[/\\]/).pop() ?? path;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

export function isModelPath(path: string): boolean {
  return MODEL_EXT.has(modelExtension(path));
}

export function unsupportedModelMessage(ext: string, ui: UiBundle): string {
  if (!ext) return ui.error_unknown_file_type;
  return ui.error_unsupported_ext.replace("{ext}", ext);
}

export function gltfLoadHint(path: string, ui: UiBundle): string {
  if (modelExtension(path) !== "gltf") return "";
  return ui.error_gltf_sidecar_hint;
}
