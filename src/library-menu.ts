import type { LibraryMenuContext } from "./library-path";
import type { UiBundle } from "./types";

export type LibraryMenuAction = "show-in-folder" | "refresh-folder" | "refresh-library";

export type LibraryMenuShowOptions = LibraryMenuContext & {
  ui: UiBundle;
  x: number;
  y: number;
  canRefreshLibrary: boolean;
};

const MENU_MOTION_MS = 200;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function menuItem(action: LibraryMenuAction, icon: string, label: string): string {
  return `
        <button
          type="button"
          class="library-context-menu-item"
          role="menuitem"
          data-library-menu-action="${action}"
        >
          <span class="material-symbols-outlined library-context-menu-icon" aria-hidden="true">${icon}</span>
          <span class="library-context-menu-label">${escapeHtml(label)}</span>
        </button>`;
}

export class LibraryContextMenu {
  private readonly el: HTMLElement;
  private context: LibraryMenuContext = { folderDir: null, revealPath: null };
  private onSelect: ((action: LibraryMenuAction, ctx: LibraryMenuContext) => void) | null = null;
  private menuVisible = false;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(container: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "library-context-menu glass-capsule hidden";
    this.el.setAttribute("role", "menu");
    container.appendChild(this.el);

    this.el.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-library-menu-action]");
      if (!btn?.dataset.libraryMenuAction) return;
      e.preventDefault();
      e.stopPropagation();
      const action = btn.dataset.libraryMenuAction as LibraryMenuAction;
      const ctx = this.context;
      this.hide();
      this.onSelect?.(action, ctx);
    });

    this.el.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  setHandler(handler: (action: LibraryMenuAction, ctx: LibraryMenuContext) => void): void {
    this.onSelect = handler;
  }

  show(opts: LibraryMenuShowOptions): void {
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }

    this.context = {
      folderDir: opts.folderDir,
      revealPath: opts.revealPath,
    };
    const items: string[] = [];

    if (opts.revealPath) {
      items.push(menuItem("show-in-folder", "folder_open", opts.ui.show_in_folder));
    }

    if (opts.folderDir) {
      items.push(menuItem("refresh-folder", "sync", opts.ui.refresh_folder));
    }

    if (opts.canRefreshLibrary) {
      items.push(menuItem("refresh-library", "inventory_2", opts.ui.refresh_library));
    }

    if (items.length === 0) return;

    const wasVisible = this.menuVisible && this.el.classList.contains("is-visible");
    this.menuVisible = true;
    this.el.innerHTML = items.join("");
    this.el.classList.remove("hidden");

    const pad = 8;
    this.el.style.left = `${opts.x}px`;
    this.el.style.top = `${opts.y}px`;

    const rect = this.el.getBoundingClientRect();
    let left = opts.x;
    let top = opts.y;
    if (left + rect.width > window.innerWidth - pad) {
      left = Math.max(pad, window.innerWidth - rect.width - pad);
    }
    if (top + rect.height > window.innerHeight - pad) {
      top = Math.max(pad, window.innerHeight - rect.height - pad);
    }
    this.el.style.left = `${left}px`;
    this.el.style.top = `${top}px`;

    if (wasVisible) return;

    requestAnimationFrame(() => {
      this.el.classList.add("is-visible");
    });
  }

  hide(): void {
    if (!this.menuVisible || this.hideTimer) return;

    this.el.classList.remove("is-visible");
    this.hideTimer = setTimeout(() => {
      this.el.classList.add("hidden");
      this.el.innerHTML = "";
      this.context = { folderDir: null, revealPath: null };
      this.menuVisible = false;
      this.hideTimer = null;
    }, MENU_MOTION_MS);
  }
}
