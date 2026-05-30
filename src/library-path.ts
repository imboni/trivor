export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

export function normalizeDir(dir: string): string {
  return normalizePath(dir).replace(/\/$/, "");
}

export function isPathUnderDir(filePath: string, dir: string): boolean {
  const file = normalizePath(filePath);
  const root = normalizeDir(dir);
  return file === root || file.startsWith(`${root}/`);
}

export function parentDirFromPath(filePath: string): string | null {
  const normalized = normalizePath(filePath);
  const slash = normalized.lastIndexOf("/");
  if (slash <= 0) return null;
  return normalized.slice(0, slash);
}

export function resolveLibraryMenuFolder(target: HTMLElement): string | null {
  const folder = target.closest<HTMLElement>(".lib-folder[data-folder-key]");
  if (folder?.dataset.folderKey) return folder.dataset.folderKey;

  const modelRow = target.closest<HTMLElement>(".model-row");
  if (modelRow) {
    const path = modelRow
      .querySelector<HTMLElement>("[data-action=select-model]")
      ?.getAttribute("data-model-path");
    if (path) return parentDirFromPath(path);
  }

  return null;
}
