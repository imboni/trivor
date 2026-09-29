export type CutoutMaxLongEdge = 2048 | 4096;

export type CutoutUserOptions = {
  maxLongEdge: CutoutMaxLongEdge;
  superSampling: 1 | 2;
};

const STORAGE_KEY = "trivor.cutout.export.v1";

export const DEFAULT_CUTOUT_USER_OPTIONS: CutoutUserOptions = {
  maxLongEdge: 2048,
  superSampling: 2,
};

export function loadCutoutUserOptions(): CutoutUserOptions {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_CUTOUT_USER_OPTIONS };
    const parsed = JSON.parse(raw) as Partial<CutoutUserOptions>;
    const maxLongEdge = parsed.maxLongEdge === 4096 ? 4096 : 2048;
    const superSampling = parsed.superSampling === 1 ? 1 : 2;
    return { maxLongEdge, superSampling };
  } catch {
    return { ...DEFAULT_CUTOUT_USER_OPTIONS };
  }
}

export function saveCutoutUserOptions(options: CutoutUserOptions): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(options));
  } catch {
    // Export still works when storage is full or unavailable in the webview.
  }
}
