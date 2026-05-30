import { invoke } from "@tauri-apps/api/core";
import type { UiBundle } from "../types";

export type ThemePref = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

const STORAGE_KEY = "trivor.theme";

export function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function resolveTheme(pref: ThemePref): ResolvedTheme {
  if (pref === "dark") return "dark";
  if (pref === "light") return "light";
  return systemPrefersDark() ? "dark" : "light";
}

export function applyTheme(resolved: ResolvedTheme): void {
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
}

export function loadStoredThemePref(): ThemePref {
  const v = localStorage.getItem(STORAGE_KEY);
  if (v === "dark" || v === "light" || v === "system") return v;
  return "system";
}

export function storeThemePref(pref: ThemePref): void {
  localStorage.setItem(STORAGE_KEY, pref);
}

export async function setThemePreference(pref: ThemePref): Promise<UiBundle> {
  storeThemePref(pref);
  return invoke<UiBundle>("set_theme", { preference: pref });
}

export function initTheme(bundle: UiBundle): void {
  const pref = bundle.theme_pref as ThemePref;
  storeThemePref(pref);
  applyTheme(bundle.theme as ResolvedTheme);
}

let systemListener: (() => void) | null = null;

export function watchSystemTheme(getPref: () => ThemePref, onResolvedChange?: () => void): void {
  systemListener?.();
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const handler = () => {
    if (getPref() !== "system") return;
    applyTheme(mq.matches ? "dark" : "light");
    onResolvedChange?.();
  };
  mq.addEventListener("change", handler);
  systemListener = () => mq.removeEventListener("change", handler);
}
