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

export type LibraryMenuContext = {
  /** Directory to rescan when choosing “refresh folder”. */
  folderDir: string | null;
  /** File or folder path passed to reveal_in_finder. */
  revealPath: string | null;
};

export function resolveLibraryMenuContext(target: HTMLElement): LibraryMenuContext {
  const modelRow = target.closest<HTMLElement>(".model-row");
  if (modelRow) {
    const path = modelRow
      .querySelector<HTMLElement>("[data-action=select-model]")
      ?.getAttribute("data-model-path");
    if (path) {
      return { folderDir: parentDirFromPath(path), revealPath: path };
    }
  }

  const folder = target.closest<HTMLElement>(".lib-folder[data-folder-key]");
  if (folder?.dataset.folderKey) {
    const key = folder.dataset.folderKey;
    return { folderDir: key, revealPath: key };
  }

  return { folderDir: null, revealPath: null };
}
