import { Color } from "three";

export type SceneTheme = {
  gridLine: Color;
  gridMajor: Color;
  gridOpacity: number;
  gridFineWeight: number;
  gridMinorWeight: number;
  gridMajorWeight: number;
  axisX: number;
  axisY: number;
  axisZ: number;
  origin: number;
  overlayAxisShaft: number;
  overlayAxisHead: number;
  overlayOriginCore: number;
  overlayOriginRing: number;
  axisWidgetFront: number;
  axisWidgetBack: number;
  axisWidgetX: string;
  axisWidgetY: string;
  axisWidgetZ: string;
};

let cached: SceneTheme | null = null;
let cachedTheme = "";
let themeEpoch = 0;

export function readSceneTheme(): SceneTheme {
  const theme = document.documentElement.dataset.theme ?? "dark";
  if (cached && cachedTheme === theme) return cached;

  const style = getComputedStyle(document.documentElement);
  cachedTheme = theme;
  cached = {
    gridLine: cssColor(style, "--scene-grid-line", 0x8ca0bd),
    gridMajor: cssColor(style, "--scene-grid-major", 0xa8bdd6),
    gridOpacity: cssNumber(style, "--scene-grid-opacity", 0.48),
    gridFineWeight: cssNumber(style, "--scene-grid-fine", 0.22),
    gridMinorWeight: cssNumber(style, "--scene-grid-minor", 0.36),
    gridMajorWeight: cssNumber(style, "--scene-grid-major-weight", 0.58),
    axisX: cssHex(style, "--scene-axis-x", 0xe07085),
    axisY: cssHex(style, "--scene-axis-y", 0x52c46e),
    axisZ: cssHex(style, "--scene-axis-z", 0x5498eb),
    origin: cssHex(style, "--scene-origin", 0xe3e2e6),
    overlayAxisShaft: cssNumber(style, "--scene-overlay-axis-shaft", 0.44),
    overlayAxisHead: cssNumber(style, "--scene-overlay-axis-head", 0.52),
    overlayOriginCore: cssNumber(style, "--scene-overlay-origin-core", 0.5),
    overlayOriginRing: cssNumber(style, "--scene-overlay-origin-ring", 0.26),
    axisWidgetFront: cssNumber(style, "--axis-widget-front", 0.88),
    axisWidgetBack: cssNumber(style, "--axis-widget-back", 0.38),
    axisWidgetX: cssString(style, "--scene-axis-x", "#e07085"),
    axisWidgetY: cssString(style, "--scene-axis-y", "#52c46e"),
    axisWidgetZ: cssString(style, "--scene-axis-z", "#5498eb"),
  };
  return cached;
}

export function invalidateSceneThemeCache(): void {
  cached = null;
  cachedTheme = "";
  themeEpoch += 1;
}

export function sceneThemeEpoch(): number {
  return themeEpoch;
}

function cssString(style: CSSStyleDeclaration, name: string, fallback: string): string {
  const raw = style.getPropertyValue(name).trim();
  return raw || fallback;
}

function cssNumber(style: CSSStyleDeclaration, name: string, fallback: number): number {
  const raw = style.getPropertyValue(name).trim();
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

function cssHex(style: CSSStyleDeclaration, name: string, fallback: number): number {
  const raw = style.getPropertyValue(name).trim();
  if (!raw) return fallback;
  return new Color(raw).getHex();
}

function cssColor(style: CSSStyleDeclaration, name: string, fallback: number): Color {
  const raw = style.getPropertyValue(name).trim();
  return raw ? new Color(raw) : new Color(fallback);
}
