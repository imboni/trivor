import type { ColorPreset } from "./model-appearance";

export type SceneGuideOptions = {
  previewGrid: boolean;
  showGuides: boolean;
  colorPreset: ColorPreset;
  modelOpacity: number;
};

const STORAGE_KEY = "trivor.scene.v3";
const LEGACY_STORAGE_KEY = "trivor.scene.v1";
const LEGACY_V2_KEY = "trivor.scene.v2";

const DEFAULTS: SceneGuideOptions = {
  previewGrid: true,
  showGuides: false,
  colorPreset: "original",
  modelOpacity: 1,
};

export class SceneOptionsStore {
  private options: SceneGuideOptions;

  constructor() {
    this.options = { ...DEFAULTS, ...loadStored() };
  }

  get(): SceneGuideOptions {
    return { ...this.options };
  }

  set(partial: Partial<SceneGuideOptions>): void {
    this.options = { ...this.options, ...normalizeStored(partial) };
    saveStored(this.options);
  }

  toggle(key: "previewGrid" | "showGuides"): void {
    this.set({ [key]: !this.options[key] });
  }

  reset(): void {
    this.options = { ...DEFAULTS };
    try {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(LEGACY_STORAGE_KEY);
      localStorage.removeItem(LEGACY_V2_KEY);
    } catch {
      // Preferences still work in memory if web storage is unavailable.
    }
  }
}

function loadStored(): Partial<SceneGuideOptions> {
  const current = readStoredRecord(STORAGE_KEY);
  if (current) return normalizeStored(current);

  const v2 = readStoredRecord(LEGACY_V2_KEY);
  if (v2) return normalizeStored(v2);

  const legacy = readStoredRecord(LEGACY_STORAGE_KEY);
  if (legacy) return normalizeStored(legacy);

  return {};
}

function readStoredRecord(key: string): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function normalizeStored(parsed: Record<string, unknown>): Partial<SceneGuideOptions> {
  const out: Partial<SceneGuideOptions> = {};
  if (typeof parsed.previewGrid === "boolean") out.previewGrid = parsed.previewGrid;
  if (typeof parsed.showGuides === "boolean") {
    out.showGuides = parsed.showGuides;
  } else if (typeof parsed.showOrigin === "boolean" || typeof parsed.showAxes === "boolean") {
    out.showGuides = Boolean(parsed.showOrigin) || Boolean(parsed.showAxes);
  }
  if (
    parsed.colorPreset === "original" ||
    parsed.colorPreset === "clay" ||
    parsed.colorPreset === "warm" ||
    parsed.colorPreset === "cool"
  ) {
    out.colorPreset = parsed.colorPreset;
  }
  if (typeof parsed.modelOpacity === "number" && Number.isFinite(parsed.modelOpacity)) {
    out.modelOpacity = Math.min(1, Math.max(0, parsed.modelOpacity));
  }
  return out;
}

function saveStored(options: SceneGuideOptions): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(options));
  } catch {
    // Storage failures must not interrupt applying the selected appearance.
  }
}
