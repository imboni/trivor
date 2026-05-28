import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ModelListEntry, SceneSummary, UiBundle } from "./types";

export function getUiBundle(): Promise<UiBundle> {
  return invoke("get_ui_bundle");
}

export function setLocale(preference: "en" | "zh-Hans" | "system"): Promise<UiBundle> {
  return invoke("set_locale", { preference });
}

export function openModelDialog(): Promise<string | null> {
  return invoke("open_model_dialog");
}

export function normalizeModelPath(path: string): Promise<string> {
  return invoke("normalize_model_path", { path });
}

export function openFolderDialog(): Promise<string | null> {
  return invoke("open_folder_dialog");
}

export function listModelsInFolder(dir: string): Promise<ModelListEntry[]> {
  return invoke("scan_models_folder", { dir });
}

export function loadModel(path: string): Promise<SceneSummary> {
  return invoke("load_model", { path });
}

/** Pack separate .gltf into cached .glb when needed; returns path for model-viewer. */
export function resolveViewerModelPath(path: string): Promise<string> {
  return invoke("resolve_viewer_model_path", { path });
}

export function onLoadProgress(handler: (percent: number) => void): Promise<() => void> {
  return listen<{ percent: number }>("load-progress", (e) => {
    handler(e.payload.percent);
  });
}
