export type SceneGuideOptions = {
  previewGrid: boolean;
  showGuides: boolean;
};

const STORAGE_KEY = "trivor.scene.v2";
const LEGACY_STORAGE_KEY = "trivor.scene.v1";

const DEFAULTS: SceneGuideOptions = {
  previewGrid: true,
  showGuides: false,
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
    this.options = { ...this.options, ...partial };
    saveStored(this.options);
  }

  toggle(key: keyof SceneGuideOptions): void {
    this.set({ [key]: !this.options[key] });
  }

  reset(): void {
    this.options = { ...DEFAULTS };
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  }
}

function loadStored(): Partial<SceneGuideOptions> {
  const current = readStoredRecord(STORAGE_KEY);
  if (current) return normalizeStored(current);

  const legacy = readStoredRecord(LEGACY_STORAGE_KEY);
  if (legacy) return normalizeStored(legacy);

  return {};
}

function readStoredRecord(key: string): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
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
  return out;
}

function saveStored(options: SceneGuideOptions): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(options));
}
