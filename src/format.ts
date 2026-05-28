import type { UiBundle } from "./types";

type ByteUnits = Pick<UiBundle, "unit_bytes_b" | "unit_bytes_kb" | "unit_bytes_mb">;

export function formatBytes(bytes: number, units: ByteUnits): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} ${units.unit_bytes_mb}`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} ${units.unit_bytes_kb}`;
  }
  return `${bytes} ${units.unit_bytes_b}`;
}

export function formatCount(n: number, locale: string): string {
  return n.toLocaleString(locale === "zh-Hans" ? "zh-Hans" : "en");
}

export function formatModelCount(template: string, count: number, locale: string): string {
  return template.replace("{n}", formatCount(count, locale));
}

export function formatModelFormat(format: string, ui: Pick<UiBundle, "format_gltf" | "format_glb">): string {
  switch (format.toLowerCase()) {
    case "gltf":
      return ui.format_gltf;
    case "glb":
      return ui.format_glb;
    default:
      return format.toUpperCase();
  }
}

export function formatDimension(value: number, unit: string): string {
  return `${value.toFixed(3)} ${unit}`;
}

export function rgbaCss(c: [number, number, number, number]): string {
  const [r, g, b, a] = c;
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a})`;
}
