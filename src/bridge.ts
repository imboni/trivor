import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { AppInfo, ClearCacheResult, ModelListEntry, SceneSummary, UiBundle, UpdateCheckResult } from "./types";

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

export function modelFileSize(path: string): Promise<number> {
  return invoke("model_file_size", { path });
}

export function openFolderDialog(): Promise<string | null> {
  return invoke("open_folder_dialog");
}

export function completeStartup(): Promise<string[]> {
  return invoke("complete_startup");
}

export type PathKind = "file" | "directory" | "missing";

export function pathKind(path: string): Promise<PathKind> {
  return invoke("path_kind", { path });
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

export function onPackProgress(handler: (percent: number) => void): Promise<() => void> {
  return listen<{ percent: number }>("pack-progress", (e) => {
    handler(e.payload.percent);
  });
}

export function revealModelInFolder(path: string): Promise<void> {
  return invoke("reveal_in_finder", { path });
}

export function getAppInfo(): Promise<AppInfo> {
  return invoke("get_app_info");
}

export function checkForUpdates(): Promise<UpdateCheckResult> {
  return invoke("check_for_updates");
}

export function downloadUpdate(url: string): Promise<string> {
  return invoke("download_update", { url });
}

export function openDownloadedUpdate(path: string): Promise<void> {
  return invoke("open_downloaded_update", { path });
}

export function viewerCacheSize(): Promise<number> {
  return invoke("viewer_cache_size");
}

export function clearViewerCache(): Promise<ClearCacheResult> {
  return invoke("clear_viewer_cache_cmd");
}

export function onUpdateDownloadProgress(handler: (percent: number) => void): Promise<() => void> {
  return listen<{ percent: number }>("update-download-progress", (e) => {
    handler(e.payload.percent);
  });
}

export function openExternalUrl(url: string): Promise<void> {
  return openUrl(url);
}
