import { formatBytes, formatModelFormat } from "./format";
import { normalizeDir, normalizePath, parentDirFromPath } from "./library-path";
import type { ModelListEntry, UiBundle } from "./types";

export type LibraryModelNode = {
  kind: "model";
  entry: ModelListEntry;
  order: number;
};

export type LibraryFolderNode = {
  kind: "folder";
  /** Stable id (absolute directory path). */
  key: string;
  name: string;
  pathLabel: string;
  children: LibraryNode[];
};

export type LibraryNode = LibraryModelNode | LibraryFolderNode;

export type LibraryTreeOptions = {
  models: ModelListEntry[];
  roots: readonly string[];
  activePath: string | null;
  collapsedFolders: ReadonlySet<string>;
  ui: UiBundle;
};

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

export function activeModelFolderKey(activePath: string | null): string | null {
  if (!activePath) return null;
  return parentDirFromPath(activePath);
}

function pathParts(path: string): string[] {
  return normalizePath(path).split("/").filter(Boolean);
}

function basename(path: string): string {
  const parts = pathParts(path);
  return parts[parts.length - 1] ?? path;
}

function findLongestRoot(filePath: string, roots: readonly string[]): string | null {
  const normalized = normalizePath(filePath);
  let best: string | null = null;
  for (const root of roots) {
    const nr = normalizeDir(root);
    if (normalized === nr || normalized.startsWith(`${nr}/`)) {
      if (!best || nr.length > best.length) best = nr;
    }
  }
  return best;
}

function findOrCreateFolder(
  parent: LibraryFolderNode,
  key: string,
  name: string,
  pathLabel: string,
): LibraryFolderNode {
  const existing = parent.children.find(
    (c): c is LibraryFolderNode => c.kind === "folder" && c.key === key,
  );
  if (existing) return existing;
  const node: LibraryFolderNode = {
    kind: "folder",
    key,
    name,
    pathLabel,
    children: [],
  };
  parent.children.push(node);
  return node;
}

function countModels(node: LibraryFolderNode): number {
  let n = 0;
  for (const child of node.children) {
    if (child.kind === "model") n += 1;
    else n += countModels(child);
  }
  return n;
}

function sortFolderChildren(node: LibraryFolderNode): void {
  for (const child of node.children) {
    if (child.kind === "folder") sortFolderChildren(child);
  }
  node.children.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
    if (a.kind === "folder" && b.kind === "folder") {
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    }
    return (a as LibraryModelNode).order - (b as LibraryModelNode).order;
  });
}

function insertModel(
  virtualRoot: LibraryFolderNode,
  rootMap: Map<string, LibraryFolderNode>,
  entry: ModelListEntry,
  order: number,
  roots: readonly string[],
): void {
  const parts = pathParts(entry.path);
  if (parts.length === 0) return;
  parts.pop();

  const matchedRoot = findLongestRoot(entry.path, roots);
  if (matchedRoot) {
    const anchor = rootMap.get(matchedRoot);
    if (!anchor) return;
    const rootParts = pathParts(matchedRoot);
    const dirParts = parts.slice(rootParts.length);
    let current = anchor;
    let pathAcc = matchedRoot;
    for (const seg of dirParts) {
      pathAcc = `${pathAcc}/${seg}`;
      current = findOrCreateFolder(current, pathAcc, seg, pathAcc);
    }
    current.children.push({ kind: "model", entry, order });
    return;
  }

  if (parts.length === 0) return;
  const parentPath = parts.join("/");
  const parentName = parts[parts.length - 1]!;
  const folder = findOrCreateFolder(virtualRoot, parentPath, parentName, parentPath);
  folder.children.push({ kind: "model", entry, order });
}

/** Build a folder tree from library roots and model paths. */
export function buildLibraryTree(
  models: ModelListEntry[],
  roots: readonly string[],
): LibraryFolderNode {
  const virtualRoot: LibraryFolderNode = {
    kind: "folder",
    key: "__library__",
    name: "",
    pathLabel: "",
    children: [],
  };

  const rootMap = new Map<string, LibraryFolderNode>();
  for (const root of roots) {
    const nr = normalizeDir(root);
    const node: LibraryFolderNode = {
      kind: "folder",
      key: nr,
      name: basename(nr),
      pathLabel: nr,
      children: [],
    };
    rootMap.set(nr, node);
    virtualRoot.children.push(node);
  }

  models.forEach((entry, order) => {
    insertModel(virtualRoot, rootMap, entry, order, roots);
  });

  sortFolderChildren(virtualRoot);
  return virtualRoot;
}

function renderFolder(
  folder: LibraryFolderNode,
  depth: number,
  opts: LibraryTreeOptions,
): string {
  const collapsed = opts.collapsedFolders.has(folder.key);
  const count = countModels(folder);
  const activeFolderKey = activeModelFolderKey(opts.activePath);
  const containsActive = activeFolderKey !== null && folder.key === activeFolderKey;
  const childDepth = depth + 1;
  const childrenHtml = folder.children
    .map((child) =>
      child.kind === "folder"
        ? renderFolder(child, childDepth, opts)
        : renderModelRow(child, childDepth, opts),
    )
    .join("");

  return `
    <div class="lib-folder${collapsed ? " is-collapsed" : ""}${containsActive ? " contains-active" : ""}" data-folder-key="${escapeAttr(folder.key)}">
      <div class="lib-folder-head" style="--depth:${depth}">
        <button
          type="button"
          class="lib-folder-toggle"
          data-action="toggle-folder"
          data-folder-key="${escapeAttr(folder.key)}"
          aria-expanded="${collapsed ? "false" : "true"}"
          title="${escapeAttr(folder.pathLabel)}"
        >
          <span class="material-symbols-outlined lib-folder-chevron" aria-hidden="true">expand_more</span>
          <span class="material-symbols-outlined lib-folder-icon lib-folder-icon-line" aria-hidden="true">folder</span>
          <span class="material-symbols-outlined lib-folder-icon lib-folder-icon-solid" aria-hidden="true">folder</span>
          <span class="lib-folder-name">${escapeHtml(folder.name)}</span>
          <span class="lib-folder-count">${count}</span>
        </button>
      </div>
      <div class="lib-folder-children">
        <div class="lib-folder-children-inner">
          ${childrenHtml}
        </div>
      </div>
    </div>`;
}

function renderModelRow(node: LibraryModelNode, depth: number, opts: LibraryTreeOptions): string {
  const m = node.entry;
  const active = m.path === opts.activePath;
  const fmt = formatModelFormat(m.format, opts.ui);
  const pillClass = m.format.toLowerCase() === "glb" ? "format-pill is-glb" : "format-pill";
  const size = m.file_size ? formatBytes(m.file_size, opts.ui) : "";

  return `
    <div class="model-row ${active ? "active" : ""}" style="--depth:${depth}">
      <button type="button" class="model-row-main" data-action="select-model" data-model-path="${escapeAttr(m.path)}">
        <span class="model-row-body">
          <span class="model-row-title">${escapeHtml(m.name)}</span>
          <span class="model-row-meta">
            <span class="${pillClass}">${escapeHtml(fmt)}</span>
            ${size ? `<span class="model-row-size">${escapeHtml(size)}</span>` : ""}
          </span>
        </span>
      </button>
      <div class="model-row-actions">
        <button
          type="button"
          class="model-row-remove"
          data-action="remove-model"
          data-model-path="${escapeAttr(m.path)}"
          title="${escapeAttr(opts.ui.remove_model)}"
          aria-label="${escapeAttr(opts.ui.remove_model)}"
        >
          <span class="material-symbols-outlined">close</span>
        </button>
      </div>
    </div>`;
}

export function renderLibraryTree(opts: LibraryTreeOptions): string {
  if (opts.models.length === 0) {
    return `
      <div class="rail-empty">
        <div class="rail-empty-icon" aria-hidden="true">
          <span class="material-symbols-outlined">inventory_2</span>
        </div>
        <p>${escapeHtml(opts.ui.sidebar_empty)}</p>
      </div>`;
  }

  const tree = buildLibraryTree(opts.models, opts.roots);
  return tree.children
    .map((child) =>
      child.kind === "folder"
        ? renderFolder(child, 0, opts)
        : renderModelRow(child, 0, opts),
    )
    .join("");
}

export function libraryTreeListKey(models: ModelListEntry[], roots: readonly string[]): string {
  const rootKey = [...roots].sort().join("\n");
  const modelKey = models.map((m) => `${m.path}\0${m.name}\0${m.file_size}`).join("\n");
  return `${rootKey}\n${modelKey}`;
}
