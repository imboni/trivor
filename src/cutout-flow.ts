export async function copyPngToClipboard(bytes: Uint8Array): Promise<void> {
  const copy = new Uint8Array(bytes);
  const blob = new Blob([copy], { type: "image/png" });
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("clipboard_unavailable");
  }
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}

export function ensurePngFilename(name: string): string {
  const trimmed = name.trim() || "cutout.png";
  return trimmed.toLowerCase().endsWith(".png") ? trimmed : `${trimmed}.png`;
}

export function pngObjectUrl(bytes: Uint8Array): string {
  const copy = new Uint8Array(bytes);
  const blob = new Blob([copy], { type: "image/png" });
  return URL.createObjectURL(blob);
}

export function revokePngObjectUrl(url: string | null): void {
  if (url) URL.revokeObjectURL(url);
}
