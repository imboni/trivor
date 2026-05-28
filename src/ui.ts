/** Yield so loading overlays paint before heavy IPC / GPU work. */
export function flushUi(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}
