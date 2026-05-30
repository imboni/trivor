import type { UiBundle } from "./types";

export type ShortcutId =
  | "open_file"
  | "open_folder"
  | "settings"
  | "close_settings"
  | "zoom_in"
  | "zoom_out"
  | "fit_view"
  | "reset_view"
  | "cinema_mode";

export type ShortcutBinding = {
  key: string;
  meta?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
};

type ShortcutDefinition = {
  id: ShortcutId;
  category: "general" | "viewer";
  defaults: ShortcutBinding[];
  customizable: boolean;
  label: (ui: UiBundle) => string;
};

const STORAGE_KEY = "trivor.shortcuts.v1";

const DEFINITIONS: ShortcutDefinition[] = [
  {
    id: "open_file",
    category: "general",
    defaults: [{ key: "o", meta: true }],
    customizable: true,
    label: (ui) => ui.open_file.replace(/…|\.\.\.$/, "").trim(),
  },
  {
    id: "open_folder",
    category: "general",
    defaults: [{ key: "o", meta: true, shift: true }],
    customizable: true,
    label: (ui) => ui.open_folder.replace(/…|\.\.\.$/, "").trim(),
  },
  {
    id: "settings",
    category: "general",
    defaults: [{ key: ",", meta: true }],
    customizable: true,
    label: (ui) => ui.settings,
  },
  {
    id: "close_settings",
    category: "general",
    defaults: [{ key: "Escape" }],
    customizable: true,
    label: (ui) => ui.close_settings,
  },
  {
    id: "zoom_in",
    category: "viewer",
    defaults: [
      { key: "=", meta: true },
      { key: "+", meta: true, shift: true },
    ],
    customizable: true,
    label: (ui) => ui.tool_zoom_in,
  },
  {
    id: "zoom_out",
    category: "viewer",
    defaults: [{ key: "-", meta: true }],
    customizable: true,
    label: (ui) => ui.tool_zoom_out,
  },
  {
    id: "fit_view",
    category: "viewer",
    defaults: [
      { key: "0", meta: true },
      { key: "f" },
    ],
    customizable: true,
    label: (ui) => ui.tool_fit_view,
  },
  {
    id: "reset_view",
    category: "viewer",
    defaults: [
      { key: "r", meta: true },
      { key: "r" },
    ],
    customizable: true,
    label: (ui) => ui.tool_reset_view,
  },
  {
    id: "cinema_mode",
    category: "viewer",
    defaults: [{ key: "p" }],
    customizable: true,
    label: (ui) => ui.tool_cinema,
  },
];

const DEFINITION_BY_ID = new Map(DEFINITIONS.map((d) => [d.id, d]));

function normalizeKey(key: string): string {
  if (key === " ") return "Space";
  if (key === "Esc") return "Escape";
  if (key.length === 1) return key.toLowerCase();
  return key;
}

export function bindingFromEvent(e: KeyboardEvent): ShortcutBinding | null {
  if (e.isComposing || e.repeat) return null;
  const key = normalizeKey(e.key);
  if (key === "Control" || key === "Meta" || key === "Alt" || key === "Shift") return null;
  return {
    key,
    meta: e.metaKey || undefined,
    ctrl: e.ctrlKey || undefined,
    alt: e.altKey || undefined,
    shift: e.shiftKey || undefined,
  };
}

function bindingKey(binding: ShortcutBinding): string {
  const parts = [
    binding.meta ? "m" : "",
    binding.ctrl ? "c" : "",
    binding.alt ? "a" : "",
    binding.shift ? "s" : "",
    binding.key,
  ];
  return parts.join("+");
}

export function bindingsEqual(a: ShortcutBinding, b: ShortcutBinding): boolean {
  return bindingKey(a) === bindingKey(b);
}

function loadOverrides(): Partial<Record<ShortcutId, ShortcutBinding[]>> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<Record<ShortcutId, ShortcutBinding[]>>;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

function saveOverrides(overrides: Partial<Record<ShortcutId, ShortcutBinding[]>>): void {
  if (Object.keys(overrides).length === 0) {
    localStorage.removeItem(STORAGE_KEY);
    return;
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
}

export class ShortcutStore {
  private overrides: Partial<Record<ShortcutId, ShortcutBinding[]>>;

  constructor() {
    this.overrides = loadOverrides();
  }

  bindingsFor(id: ShortcutId): ShortcutBinding[] {
    const custom = this.overrides[id];
    if (custom?.length) return custom;
    return DEFINITION_BY_ID.get(id)?.defaults ?? [];
  }

  allBindings(): Map<ShortcutId, ShortcutBinding[]> {
    const map = new Map<ShortcutId, ShortcutBinding[]>();
    for (const def of DEFINITIONS) {
      map.set(def.id, this.bindingsFor(def.id));
    }
    return map;
  }

  setBinding(id: ShortcutId, binding: ShortcutBinding): boolean {
    const def = DEFINITION_BY_ID.get(id);
    if (!def?.customizable) return false;
    if (findConflict(id, binding, this.overrides)) return false;
    this.overrides[id] = [binding];
    saveOverrides(this.overrides);
    return true;
  }

  reset(id: ShortcutId): void {
    delete this.overrides[id];
    saveOverrides(this.overrides);
  }

  resetAll(): void {
    this.overrides = {};
    saveOverrides(this.overrides);
  }

  match(event: KeyboardEvent): ShortcutId | null {
    const pressed = bindingFromEvent(event);
    if (!pressed) return null;
    for (const def of DEFINITIONS) {
      for (const binding of this.bindingsFor(def.id)) {
        if (bindingsEqual(pressed, binding)) return def.id;
      }
    }
    return null;
  }
}

function findConflict(
  exceptId: ShortcutId,
  binding: ShortcutBinding,
  overrides: Partial<Record<ShortcutId, ShortcutBinding[]>>,
): ShortcutId | null {
  for (const def of DEFINITIONS) {
    if (def.id === exceptId) continue;
    const list =
      overrides[def.id]?.length ? overrides[def.id]! : def.defaults;
    if (list.some((b) => bindingsEqual(b, binding))) return def.id;
  }
  return null;
}

export function shortcutDefinitions(): readonly ShortcutDefinition[] {
  return DEFINITIONS;
}

export function formatBinding(binding: ShortcutBinding): string {
  const isMac =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPod|iPad/i.test(navigator.platform || navigator.userAgent);
  const mod: string[] = [];
  if (binding.ctrl) mod.push(isMac ? "⌃" : "Ctrl");
  if (binding.alt) mod.push(isMac ? "⌥" : "Alt");
  if (binding.shift) mod.push(isMac ? "⇧" : "Shift");
  if (binding.meta) mod.push(isMac ? "⌘" : "Ctrl");

  let key = binding.key;
  if (key === "Escape") key = isMac ? "Esc" : "Esc";
  else if (key === " ") key = "Space";
  else if (key === ",") key = ",";
  else if (key.length === 1) key = key.toUpperCase();

  return [...mod, key].join(isMac ? "" : "+");
}

export function formatBindings(bindings: ShortcutBinding[]): string {
  const unique = bindings.filter(
    (b, i, arr) => arr.findIndex((x) => bindingsEqual(x, b)) === i,
  );
  return unique.map(formatBinding).join(" · ");
}

export type ShortcutUiCopy = {
  section: string;
  categoryGeneral: string;
  categoryViewer: string;
  pressKeys: string;
  resetAll: string;
  restore: string;
  doubleClickFit: string;
};

export function renderShortcutsSettings(
  ui: UiBundle,
  copy: ShortcutUiCopy,
  store: ShortcutStore,
  recordingId: ShortcutId | null,
): string {
  const renderRow = (def: ShortcutDefinition): string => {
    const bindings = store.bindingsFor(def.id);
    const recording = recordingId === def.id;
    const display = recording ? copy.pressKeys : formatBindings(bindings);
    return `
      <div class="settings-shortcut-row${recording ? " is-recording" : ""}" data-shortcut-id="${def.id}">
        <span class="settings-shortcut-label">${escapeHtml(def.label(ui))}</span>
        <div class="settings-shortcut-actions">
          <button
            type="button"
            class="settings-shortcut-key"
            data-action="edit-shortcut"
            data-shortcut-id="${def.id}"
            aria-label="${escapeAttr(copy.pressKeys)}"
          >${escapeHtml(display)}</button>
          <button
            type="button"
            class="settings-shortcut-restore"
            data-action="restore-shortcut"
            data-shortcut-id="${def.id}"
            title="${escapeAttr(copy.restore)}"
            aria-label="${escapeAttr(copy.restore)}"
          >
            <span class="material-symbols-outlined" aria-hidden="true">restart_alt</span>
          </button>
        </div>
      </div>`;
  };

  const general = DEFINITIONS.filter((d) => d.category === "general").map(renderRow).join("");
  const viewer = DEFINITIONS.filter((d) => d.category === "viewer").map(renderRow).join("");

  return `
    <div class="settings-shortcuts-grid">
      <p class="settings-shortcuts-category">${escapeHtml(copy.categoryGeneral)}</p>
      ${general}
      <p class="settings-shortcuts-category">${escapeHtml(copy.categoryViewer)}</p>
      ${viewer}
      <div class="settings-shortcut-row is-static">
        <span class="settings-shortcut-label">${escapeHtml(copy.doubleClickFit)}</span>
        <span class="settings-shortcut-key is-readonly" aria-hidden="true">—</span>
      </div>
    </div>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/'/g, "&#39;");
}
