import type { UiBundle } from "./types";

type ByteUnits = Pick<
  UiBundle,
  "unit_bytes_b" | "unit_bytes_kb" | "unit_bytes_mb" | "unit_bytes_gb"
>;

export function formatAppDate(isoDate: string, locale: string): string {
  if (!isoDate || isoDate === "unknown") return "";
  const parts = isoDate.split("-").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 3 || parts.some((part) => Number.isNaN(part))) return isoDate;
  const [year, month, day] = parts as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return new Intl.DateTimeFormat(locale.startsWith("zh") ? "zh-Hans" : "en", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

export function formatBytes(bytes: number, units: ByteUnits): string {
  if (bytes >= 1024 ** 3) {
    const gb = bytes / 1024 ** 3;
    return gb >= 10
      ? `${gb.toFixed(1)} ${units.unit_bytes_gb}`
      : `${gb.toFixed(2)} ${units.unit_bytes_gb}`;
  }
  if (bytes >= 1024 ** 2) {
    const mb = bytes / 1024 ** 2;
    return mb >= 100
      ? `${mb.toFixed(0)} ${units.unit_bytes_mb}`
      : `${mb.toFixed(2)} ${units.unit_bytes_mb}`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} ${units.unit_bytes_kb}`;
  }
  return `${bytes} ${units.unit_bytes_b}`;
}

export function formatCount(n: number, locale: string): string {
  return n.toLocaleString(locale === "zh-Hans" ? "zh-Hans" : "en");
}

/** Compact triangle counts for load-limit hints (e.g. 500 万 / 5 million). */
export function formatCompactCount(n: number, locale: string): string {
  if (locale.startsWith("zh")) {
    if (n >= 100_000_000) {
      const wan = n / 10_000;
      return Number.isInteger(wan) ? `${wan} 万` : `${wan.toFixed(1)} 万`;
    }
    if (n >= 10_000) {
      const wan = n / 10_000;
      return Number.isInteger(wan) ? `${wan} 万` : `${wan.toFixed(1)} 万`;
    }
    return formatCount(n, locale);
  }
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return Number.isInteger(m) ? `${m} million` : `${m.toFixed(1)} million`;
  }
  return formatCount(n, locale);
}

export function formatModelCount(template: string, count: number, locale: string): string {
  return template.replace("{n}", formatCount(count, locale));
}

export function formatLibraryLimit(
  template: string,
  max: number,
  skipped: number,
  locale: string,
): string {
  return template
    .replace("{max}", formatCount(max, locale))
    .replace("{n}", formatCount(skipped, locale));
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
