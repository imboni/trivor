export type UpdatePreferences = {
  autoCheckOnStartup: boolean;
};

const STORAGE_KEY = "trivor.update";

const DEFAULTS: UpdatePreferences = {
  autoCheckOnStartup: true,
};

export class UpdatePreferencesStore {
  private options: UpdatePreferences;

  constructor() {
    this.options = { ...DEFAULTS, ...loadStored() };
  }

  get(): UpdatePreferences {
    return { ...this.options };
  }

  set(partial: Partial<UpdatePreferences>): void {
    this.options = { ...this.options, ...partial };
    saveStored(this.options);
  }

  toggleAutoCheckOnStartup(): void {
    this.set({ autoCheckOnStartup: !this.options.autoCheckOnStartup });
  }
}

function loadStored(): Partial<UpdatePreferences> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Partial<UpdatePreferences> = {};
    if (typeof parsed.autoCheckOnStartup === "boolean") {
      out.autoCheckOnStartup = parsed.autoCheckOnStartup;
    }
    return out;
  } catch {
    return {};
  }
}

function saveStored(options: UpdatePreferences): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(options));
}
