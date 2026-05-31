import { isTauri } from "@tauri-apps/api/core";

/**
 * macOS overlay title bar.
 *
 * Drag + double-click zoom are handled by Tauri's built-in drag.js (mouseup on macOS).
 * Do NOT add a custom dblclick → toggleMaximize handler; it breaks the second zoom-out.
 */
export function mountOverlayTitlebar(shell: HTMLElement): void {
  if (!isTauri()) return;

  document.documentElement.classList.add("is-macos-overlay-titlebar");

  const drag = shell.querySelector<HTMLElement>(".titlebar-drag");
  if (!drag) return;

  drag.setAttribute("data-tauri-drag-region", "");
}
