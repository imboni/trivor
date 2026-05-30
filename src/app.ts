import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  getUiBundle,
  listModelsInFolder,
  loadModel,
  normalizeModelPath,
  resolveViewerModelPath,
  onLoadProgress,
  onPackProgress,
  openFolderDialog,
  openModelDialog,
  setLocale,
} from "./bridge";
import {
  gltfLoadHint,
  isModelPath,
  modelExtension,
  unsupportedModelMessage,
} from "./model-path";
import {
  formatBytes,
  formatCount,
  formatDimension,
  formatLibraryLimit,
  formatModelCount,
  formatModelFormat,
  rgbaCss,
} from "./format";

/** Maximum models kept in the library list. */
export const MAX_LIBRARY_MODELS = 100;
import type { AppPhase, ModelListEntry, SceneSummary, UiBundle } from "./types";
import {
  initTheme,
  loadStoredThemePref,
  setThemePreference,
  watchSystemTheme,
  type ThemePref,
} from "./theme";
import { flushUi } from "./ui";
import { ModelViewport, type SavedCamera } from "./viewer";

type LocalePref = "en" | "zh-Hans" | "system";

export class App {
  private ui!: UiBundle;
  private phase: AppPhase = "empty";
  private summary: SceneSummary | null = null;
  private loadPercent = 0;
  private parseProgress = 0;
  private packProgress = 0;
  private loadingStage: "parse" | "pack" | "render" = "parse";
  private status = "";
  private settingsOpen = false;
  private clearConfirmOpen = false;
  private explorerCollapsed = false;
  private inspectorCollapsed = false;
  private cinemaMode = false;
  private cinemaRotatePaused = false;
  private cinemaIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly cinemaIdleMs = 3000;

  private folderPath: string | null = null;
  private models: ModelListEntry[] = [];
  private activePath: string | null = null;
  private readonly summaryCache = new Map<string, SceneSummary>();
  private readonly cameraByPath = new Map<string, SavedCamera>();
  private loadToken = 0;
  private dialogOpen = false;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly shell: HTMLElement;
  private readonly viewport: ModelViewport;
  private readonly els: Record<string, HTMLElement>;

  constructor(root: HTMLElement) {
    this.shell = document.createElement("div");
    this.shell.className = "shell";
    this.shell.innerHTML = SHELL_HTML;
    root.appendChild(this.shell);

    const pick = (sel: string) => this.shell.querySelector(sel) as HTMLElement;
    this.els = {
      sidebarOpenFile: pick("[data-action=sidebar-open-file]"),
      sidebarOpenFolder: pick("[data-action=sidebar-open-folder]"),
      settingsBtn: pick("[data-action=settings]"),
      sidebarTitle: pick("[data-bind=sidebar-title]"),
      modelCount: pick("[data-bind=model-count]"),
      sidebarBody: pick("[data-bind=sidebar]"),
      explorerDrawer: pick("[data-bind=explorer-drawer]"),
      viewportMain: pick(".viewport"),
      viewportHost: pick(".viewport-host"),
      overlay: pick("[data-bind=overlay]"),
      viewportDock: pick("[data-bind=viewport-dock]"),
      toolZoomOut: pick("[data-action=zoom-out]"),
      toolZoomIn: pick("[data-action=zoom-in]"),
      toolResetView: pick("[data-action=reset-view]"),
      toolCinema: pick("[data-action=cinema-mode]"),
      cinemaExit: pick("[data-action=exit-cinema]"),
      cinemaToggleRotate: pick("[data-action=cinema-toggle-rotate]"),
      expandInspector: pick("[data-action=expand-inspector]"),
      toggleLibrary: pick("[data-action=toggle-library]"),
      clearLibrary: pick("[data-action=clear-library]"),
      collapseExplorer: pick("[data-action=collapse-explorer]"),
      collapseInspector: pick("[data-action=collapse-inspector]"),
      closeSettings: pick("[data-action=close-settings]"),
      inspector: pick(".inspector-panel"),
      inspectorLabel: pick("[data-bind=inspector-label]"),
      inspectorTitle: pick("[data-bind=inspector-title]"),
      inspectorBody: pick("[data-bind=inspector]"),
      settingsBackdrop: pick("[data-bind=settings]"),
      settingsPanel: pick(".settings-panel"),
      settingsTitle: pick("[data-bind=settings-title]"),
      languageLabel: pick("[data-bind=language-label]"),
      localeGroup: pick("[data-bind=locale-group]"),
      appearanceLabel: pick("[data-bind=appearance-label]"),
      themeGroup: pick("[data-bind=theme-group]"),
      perspectiveGrid: pick(".perspective-grid"),
      toast: pick("[data-bind=toast]"),
      clearConfirmPop: pick("[data-bind=clear-confirm]"),
      clearConfirmMessage: pick("[data-bind=clear-confirm-message]"),
      clearConfirmCancel: pick("[data-action=clear-library-cancel]"),
      clearConfirmOk: pick("[data-action=clear-library-confirm]"),
    };

    this.viewport = new ModelViewport(this.els.viewportHost);
    this.viewport.attachWheelSurface(this.els.viewportMain);
    this.bind();
    this.bindCinemaIdleResume();
    this.bindParallax();
  }

  async start(): Promise<void> {
    let bundle = await getUiBundle();
    const storedTheme = loadStoredThemePref();
    if (storedTheme !== bundle.theme_pref) {
      bundle = await setThemePreference(storedTheme);
    }
    this.ui = bundle;
    initTheme(bundle);
    watchSystemTheme(() => this.ui.theme_pref as ThemePref);
    this.applyUi();
    await onLoadProgress((p) => {
      if (this.phase !== "loading") return;
      this.parseProgress = p;
      this.syncLoadingProgress();
    });
    await onPackProgress((p) => {
      if (this.phase !== "loading") return;
      this.packProgress = p;
      this.syncLoadingProgress();
    });
    await listen<string>("menu-action", (e) => this.onMenuAction(e.payload));
    await listen<string>("open-path", (e) => {
      void this.openPath(e.payload, { addToList: true });
    });
    document.addEventListener("keydown", (e) => this.onKey(e));
    this.paint();
  }

  private onMenuAction(action: string): void {
    switch (action) {
      case "open-file":
        void this.pickFile();
        break;
      case "open-folder":
        void this.pickFolder();
        break;
      case "settings":
        this.settingsOpen = true;
        this.paint();
        break;
      case "zoom-in":
        if (this.phase === "ready") this.viewport.zoomIn();
        break;
      case "zoom-out":
        if (this.phase === "ready") this.viewport.zoomOut();
        break;
      case "reset-view":
        this.resetView();
        break;
      case "fit-view":
        void this.fitView();
        break;
      default:
        break;
    }
  }

  private bind(): void {
    this.els.sidebarOpenFile.addEventListener("click", () => void this.pickFile());
    this.els.sidebarOpenFolder.addEventListener("click", () => void this.pickFolder());
    this.els.settingsBtn.addEventListener("click", () => {
      this.settingsOpen = true;
      this.paint();
    });
    this.els.settingsPanel.addEventListener("click", (e) => e.stopPropagation());
    this.els.settingsBackdrop.addEventListener("click", () => {
      this.settingsOpen = false;
      this.paint();
    });
    this.els.closeSettings.addEventListener("click", () => {
      this.settingsOpen = false;
      this.paint();
    });

    this.els.viewportHost.addEventListener("dblclick", () => {
      if (this.phase === "ready") void this.viewport.fit();
    });

    this.els.toolZoomIn.addEventListener("click", () => {
      this.viewport.zoomIn();
      this.viewport.focus();
    });
    this.els.toolZoomOut.addEventListener("click", () => {
      this.viewport.zoomOut();
      this.viewport.focus();
    });
    this.els.toolResetView.addEventListener("click", () => {
      this.resetView();
      this.viewport.focus();
    });
    this.els.toolCinema.addEventListener("click", () => {
      this.setCinemaMode(!this.cinemaMode);
      this.viewport.focus();
    });
    this.els.cinemaExit.addEventListener("click", () => {
      this.setCinemaMode(false);
      this.viewport.focus();
    });
    this.els.cinemaToggleRotate.addEventListener("click", () => {
      this.toggleCinemaRotatePause();
      this.viewport.focus();
    });
    this.els.expandInspector.addEventListener("click", () => {
      if (this.inspectorCollapsed) {
        this.inspectorCollapsed = false;
        this.paint();
      }
    });
    this.els.toggleLibrary.addEventListener("click", () => this.toggleExplorerCollapsed());
    this.els.clearLibrary.addEventListener("click", (e) => {
      e.stopPropagation();
      this.clearConfirmOpen = !this.clearConfirmOpen;
      this.paint();
    });
    this.els.clearConfirmCancel.addEventListener("click", (e) => {
      e.stopPropagation();
      this.clearConfirmOpen = false;
      this.paint();
    });
    this.els.clearConfirmOk.addEventListener("click", (e) => {
      e.stopPropagation();
      this.performClearLibrary();
    });
    document.addEventListener("click", () => {
      if (!this.clearConfirmOpen) return;
      this.clearConfirmOpen = false;
      this.paint();
    });
    this.els.clearConfirmPop.addEventListener("click", (e) => e.stopPropagation());
    this.els.collapseExplorer.addEventListener("click", () => this.toggleExplorerCollapsed());
    this.els.collapseInspector.addEventListener("click", () => this.toggleInspectorCollapsed());

    this.els.sidebarBody.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const removeBtn = target.closest<HTMLElement>("[data-action=remove-model]");
      if (removeBtn) {
        e.preventDefault();
        e.stopPropagation();
        const path = removeBtn.dataset.modelPath;
        if (path) this.removeModel(path);
        return;
      }
      const selectBtn = target.closest<HTMLElement>("[data-action=select-model]");
      if (selectBtn) {
        const path = selectBtn.dataset.modelPath;
        if (path && path !== this.activePath) void this.openPath(path);
      }
    });

    this.els.localeGroup.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-locale]");
      if (!btn?.dataset.locale) return;
      const pref = btn.dataset.locale as LocalePref;
      void setLocale(pref).then((bundle) => {
        this.ui = bundle;
        this.applyUi();
        this.paint();
      });
    });

    this.els.themeGroup.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-theme]");
      if (!btn?.dataset.theme) return;
      const pref = btn.dataset.theme as ThemePref;
      void setThemePreference(pref).then((bundle) => {
        this.ui = bundle;
        initTheme(bundle);
        this.syncThemeSegmentsActive();
        this.paint();
      });
    });
  }

  private bindParallax(): void {
    const grid = this.els.perspectiveGrid;
    window.addEventListener("mousemove", (e) => {
      const x = (e.clientX / window.innerWidth - 0.5) * 10;
      const y = (e.clientY / window.innerHeight - 0.5) * 10;
      grid.style.transform = `rotateX(60deg) translateY(-200px) translateX(${x}px) translateZ(${y}px)`;
    });
  }

  private applyUi(): void {
    document.documentElement.lang = this.ui.locale;
    document.title = this.ui.window_title;
    this.els.sidebarOpenFile.title = this.ui.open_file;
    this.els.sidebarOpenFile.setAttribute("aria-label", this.ui.open_file);
    this.els.sidebarOpenFolder.title = this.ui.open_folder;
    this.els.sidebarOpenFolder.setAttribute("aria-label", this.ui.open_folder);
    this.els.settingsBtn.title = this.ui.settings;
    this.els.settingsBtn.setAttribute("aria-label", this.ui.settings);
    this.els.sidebarTitle.textContent = this.ui.sidebar_models;
    this.els.inspectorLabel.textContent = this.ui.inspector_title;
    this.els.settingsTitle.textContent = this.ui.settings;
    this.els.languageLabel.textContent = this.ui.language;
    this.els.appearanceLabel.textContent = this.ui.appearance;
    this.els.toolZoomOut.title = this.ui.tool_zoom_out;
    this.els.toolZoomOut.setAttribute("aria-label", this.ui.tool_zoom_out);
    this.els.toolZoomIn.title = this.ui.tool_zoom_in;
    this.els.toolZoomIn.setAttribute("aria-label", this.ui.tool_zoom_in);
    this.els.toolResetView.title = this.ui.tool_reset_view;
    this.els.toolResetView.setAttribute("aria-label", this.ui.tool_reset_view);
    this.els.toolCinema.title = this.ui.tool_cinema;
    this.els.toolCinema.setAttribute("aria-label", this.ui.tool_cinema);
    this.els.cinemaExit.title = this.ui.tool_exit_cinema;
    this.els.cinemaExit.setAttribute("aria-label", this.ui.tool_exit_cinema);
    this.els.expandInspector.title = this.ui.expand_inspector;
    this.els.expandInspector.setAttribute("aria-label", this.ui.expand_inspector);
    this.paintCinemaControls();
    this.els.toggleLibrary.title = this.ui.toggle_library;
    this.els.toggleLibrary.setAttribute("aria-label", this.ui.toggle_library);
    this.paintPanelToggles();
    this.els.clearLibrary.title = this.ui.clear_library;
    this.els.clearLibrary.setAttribute("aria-label", this.ui.clear_library);
    this.els.closeSettings.title = this.ui.close_settings;
    this.els.closeSettings.setAttribute("aria-label", this.ui.close_settings);
    this.paintModelCount();
    this.renderLocaleSegments();
    this.renderThemeSegments();
  }

  private paintModelCount(): void {
    const el = this.els.modelCount;
    const empty = this.models.length === 0;
    if (empty) {
      el.textContent = "";
    } else {
      el.textContent = formatModelCount(this.ui.model_count, this.models.length, this.ui.locale);
    }
    const clearBtn = this.els.clearLibrary as HTMLButtonElement;
    clearBtn.disabled = empty;
    clearBtn.classList.toggle("is-disabled", empty);
  }

  private renderLocaleSegments(): void {
    const ui = this.ui;
    const seg = (id: LocalePref, label: string) =>
      `<button type="button" class="seg" data-locale="${id}">${label}</button>`;
    this.els.localeGroup.innerHTML = [
      seg("en", ui.lang_en),
      seg("zh-Hans", ui.lang_zh),
      seg("system", ui.lang_system),
    ].join("");
    this.syncLocaleSegmentsActive();
  }

  private renderThemeSegments(): void {
    const ui = this.ui;
    const seg = (id: ThemePref, label: string) =>
      `<button type="button" class="seg" data-theme="${id}">${label}</button>`;
    this.els.themeGroup.innerHTML = [
      seg("dark", ui.theme_dark),
      seg("light", ui.theme_light),
      seg("system", ui.theme_system),
    ].join("");
    this.syncThemeSegmentsActive();
  }

  private syncLocaleSegmentsActive(): void {
    const active = this.ui.locale_pref;
    this.els.localeGroup.querySelectorAll<HTMLElement>("[data-locale]").forEach((el) => {
      el.classList.toggle("active", el.dataset.locale === active);
    });
  }

  private syncThemeSegmentsActive(): void {
    const active = this.ui.theme_pref;
    this.els.themeGroup.querySelectorAll<HTMLElement>("[data-theme]").forEach((el) => {
      el.classList.toggle("active", el.dataset.theme === active);
    });
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      if (this.cinemaMode) {
        this.setCinemaMode(false);
        return;
      }
      if (this.clearConfirmOpen) {
        this.clearConfirmOpen = false;
        this.paint();
        return;
      }
      if (this.settingsOpen) {
        this.settingsOpen = false;
        this.paint();
      }
      return;
    }
    if (this.phase !== "ready") return;

    const key = e.key;
    if (key === "=" || key === "+") {
      e.preventDefault();
      this.viewport.zoomIn();
    } else if (key === "-" || key === "_") {
      e.preventDefault();
      this.viewport.zoomOut();
    } else if (key.toLowerCase() === "f") {
      void this.fitView();
    } else if (key.toLowerCase() === "r") {
      this.resetView();
    } else if (key.toLowerCase() === "p") {
      this.setCinemaMode(!this.cinemaMode);
    }
  }

  private resetView(): void {
    if (this.phase !== "ready") return;
    const path = this.activePath;
    const initial = path ? this.cameraByPath.get(path) : undefined;
    if (initial) {
      this.viewport.importSnapshot(initial);
    }
    this.viewport.reset();
  }

  private persistCameraForPath(path: string): void {
    const snap = this.viewport.exportSnapshot();
    if (snap) this.cameraByPath.set(path, snap);
  }

  /** Persist the framing captured after this load (used only for reset-view fallback). */
  private saveInitialCameraForPath(path: string): void {
    this.persistCameraForPath(path);
  }

  private async fitView(): Promise<void> {
    if (this.phase !== "ready") return;
    await this.viewport.fit();
  }

  private bindCinemaIdleResume(): void {
    const surface = this.els.viewportMain;
    surface.addEventListener("pointerdown", () => {
      if (!this.cinemaMode || this.cinemaRotatePaused) return;
      this.clearCinemaIdleTimer();
      this.viewport.setAutoRotate(false);
      this.paintCinemaControls();
    });
    surface.addEventListener("pointerup", () => {
      if (!this.cinemaMode || this.cinemaRotatePaused) return;
      this.scheduleCinemaIdleResume();
    });
    surface.addEventListener(
      "wheel",
      () => {
        if (!this.cinemaMode || this.cinemaRotatePaused) return;
        this.viewport.setAutoRotate(false);
        this.paintCinemaControls();
        this.scheduleCinemaIdleResume();
      },
      { passive: true },
    );
  }

  private scheduleCinemaIdleResume(): void {
    if (!this.cinemaMode || this.cinemaRotatePaused) return;
    if (this.cinemaIdleTimer) clearTimeout(this.cinemaIdleTimer);
    this.cinemaIdleTimer = setTimeout(() => {
      this.cinemaIdleTimer = null;
      if (!this.cinemaMode || this.cinemaRotatePaused || this.phase !== "ready") return;
      this.resetView();
      this.viewport.setAutoRotate(true);
      this.paintCinemaControls();
    }, this.cinemaIdleMs);
  }

  private clearCinemaIdleTimer(): void {
    if (this.cinemaIdleTimer) {
      clearTimeout(this.cinemaIdleTimer);
      this.cinemaIdleTimer = null;
    }
  }

  private setCinemaMode(on: boolean): void {
    if (on && this.phase !== "ready") return;
    if (on === this.cinemaMode) return;
    this.cinemaMode = on;
    if (on) {
      this.cinemaRotatePaused = false;
      this.resetView();
      this.viewport.setAutoRotate(true);
      this.paintCinemaControls();
    } else {
      this.clearCinemaIdleTimer();
      this.cinemaRotatePaused = false;
      this.viewport.setAutoRotate(false);
    }
    this.paint();
  }

  private toggleCinemaRotatePause(): void {
    if (!this.cinemaMode) return;
    if (this.viewport.isAutoRotateActive()) {
      this.cinemaRotatePaused = true;
      this.clearCinemaIdleTimer();
      this.viewport.setAutoRotate(false);
    } else {
      this.cinemaRotatePaused = false;
      this.resetView();
      this.viewport.setAutoRotate(true);
    }
    this.paintCinemaControls();
  }

  private paintCinemaControls(): void {
    if (!this.cinemaMode) return;
    const rotating = this.viewport.isAutoRotateActive();
    const label = rotating ? this.ui.tool_pause_rotate : this.ui.tool_resume_rotate;
    const icon = rotating ? "pause" : "play_arrow";
    this.els.cinemaToggleRotate.title = label;
    this.els.cinemaToggleRotate.setAttribute("aria-label", label);
    this.els.cinemaToggleRotate.classList.toggle("is-paused", !rotating);
    this.els.cinemaToggleRotate.classList.toggle("is-active", rotating);
    const sym = this.els.cinemaToggleRotate.querySelector(".material-symbols-outlined");
    if (sym) sym.textContent = icon;
  }

  private toggleExplorerCollapsed(): void {
    if (this.cinemaMode || this.models.length === 0) return;
    this.clearConfirmOpen = false;
    this.explorerCollapsed = !this.explorerCollapsed;
    this.paint();
  }

  private toggleInspectorCollapsed(): void {
    if (this.cinemaMode) return;
    const showModelPanels =
      this.phase === "ready" || (this.phase === "loading" && this.activePath !== null);
    if (!showModelPanels) return;
    this.inspectorCollapsed = !this.inspectorCollapsed;
    this.paint();
  }

  private paintPanelToggles(): void {
    const collapseLabel = this.ui.collapse_panel;
    const expandLabel = this.ui.expand_panel;
    this.els.collapseExplorer.title = this.explorerCollapsed ? expandLabel : collapseLabel;
    this.els.collapseExplorer.setAttribute(
      "aria-label",
      this.explorerCollapsed ? expandLabel : collapseLabel,
    );
    this.els.collapseInspector.title = this.inspectorCollapsed ? expandLabel : collapseLabel;
    this.els.collapseInspector.setAttribute(
      "aria-label",
      this.inspectorCollapsed ? expandLabel : collapseLabel,
    );
    const expIcon = this.els.collapseExplorer.querySelector(".material-symbols-outlined");
    if (expIcon) {
      expIcon.textContent = this.explorerCollapsed ? "chevron_right" : "chevron_left";
    }
    const inspIcon = this.els.collapseInspector.querySelector(".material-symbols-outlined");
    if (inspIcon) {
      inspIcon.textContent = this.inspectorCollapsed ? "chevron_left" : "chevron_right";
    }
    this.els.toggleLibrary.classList.toggle(
      "is-active",
      this.models.length > 0 && !this.explorerCollapsed,
    );
  }

  private async pickFile(): Promise<void> {
    if (this.dialogOpen) return;
    this.dialogOpen = true;
    try {
      const path = await openModelDialog();
      if (path) await this.openPath(path, { addToList: true });
    } finally {
      this.dialogOpen = false;
    }
  }

  private async pickFolder(): Promise<void> {
    if (this.dialogOpen) return;
    this.dialogOpen = true;
    try {
      const dir = await openFolderDialog();
      if (dir) await this.loadFolder(dir);
    } finally {
      this.dialogOpen = false;
    }
  }

  private async loadFolder(dir: string): Promise<void> {
    try {
      const items = await listModelsInFolder(dir);
      if (items.length === 0) {
        if (this.models.length === 0) {
          this.phase = "error";
          this.status = this.ui.error_folder_empty;
          this.paint();
        }
        return;
      }
      this.folderPath = dir;
      const pathsBefore = new Set(this.models.map((m) => m.path));
      const previousActive = this.activePath;
      let skipped = 0;
      for (const entry of items) {
        if (!this.tryUpsertModel(entry)) skipped++;
      }
      if (skipped > 0) this.notifyLibraryLimit(skipped);
      const firstNew = items.find(
        (e) => !pathsBefore.has(e.path) && this.models.some((m) => m.path === e.path),
      );

      if (
        previousActive &&
        this.models.some((m) => m.path === previousActive)
      ) {
        this.paint();
        return;
      }

      const toOpen = firstNew?.path ?? items[0]!.path;
      if (this.activePath !== toOpen) {
        await this.openPath(toOpen);
      } else {
        this.paint();
      }
    } catch (err) {
      this.phase = "error";
      this.status = err instanceof Error ? err.message : String(err);
      this.paint();
    }
  }

  /** Add or update a library entry. Returns false when the list is full and this is a new path. */
  private tryUpsertModel(entry: ModelListEntry): boolean {
    const i = this.models.findIndex((m) => m.path === entry.path);
    if (i >= 0) {
      this.models[i] = entry;
      return true;
    }
    if (this.models.length >= MAX_LIBRARY_MODELS) return false;
    this.models.push(entry);
    return true;
  }

  private notifyLibraryLimit(skipped: number): void {
    if (skipped <= 0) return;
    const message = formatLibraryLimit(
      this.ui.library_limit,
      MAX_LIBRARY_MODELS,
      skipped,
      this.ui.locale,
    );
    this.showToast(message);
  }

  private showToast(message: string): void {
    const el = this.els.toast;
    el.textContent = message;
    el.classList.add("is-visible");
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      el.classList.remove("is-visible");
      this.toastTimer = null;
    }, 4500);
  }

  private modelListKey(): string {
    return this.models.map((m) => `${m.path}\0${m.name}\0${m.file_size}`).join("\n");
  }

  private modelEntryFromPath(path: string): ModelListEntry | null {
    const ext = modelExtension(path);
    if (!isModelPath(path)) return null;
    const name = path.split(/[/\\]/).pop() ?? "model";
    const existing = this.models.find((m) => m.path === path);
    return {
      path,
      name,
      format: ext,
      file_size: existing?.file_size ?? 0,
    };
  }

  private async openPath(path: string, opts?: { addToList?: boolean }): Promise<void> {
    try {
      path = await normalizeModelPath(path);
    } catch {
      /* keep original */
    }

    const ext = modelExtension(path);
    if (!isModelPath(path)) {
      this.phase = "error";
      this.status = unsupportedModelMessage(ext, this.ui);
      this.summary = null;
      this.activePath = null;
      this.viewport.clear();
      this.paint();
      return;
    }

    if (opts?.addToList) {
      const entry = this.modelEntryFromPath(path);
      if (entry && !this.tryUpsertModel(entry)) this.notifyLibraryLimit(1);
    }

    if (this.activePath === path && this.phase === "ready" && this.summary) {
      return;
    }

    const prevPath = this.activePath;
    if (prevPath && prevPath !== path && this.phase === "ready") {
      this.persistCameraForPath(prevPath);
    }

    const token = ++this.loadToken;
    this.activePath = path;
    this.phase = "loading";
    this.loadPercent = 0;
    this.parseProgress = 0;
    this.packProgress = 0;
    this.loadingStage = "parse";
    this.status = "";
    this.paint();

    await flushUi();

    try {
      const cached = this.summaryCache.get(path);

      this.loadingStage = cached ? "pack" : "parse";
      this.parseProgress = cached ? 100 : 0;
      this.packProgress = 0;
      this.syncLoadingProgress();

      if (this.cinemaMode) {
        this.viewport.setAutoRotate(false);
        this.paintCinemaControls();
      }

      const summaryPromise = cached
        ? Promise.resolve(cached)
        : loadModel(path).then((summary) => {
            this.summaryCache.set(path, summary);
            this.parseProgress = 100;
            if (token === this.loadToken && this.phase === "loading") {
              this.syncLoadingProgress();
            }
            return summary;
          });
      const viewerPathPromise = resolveViewerModelPath(path);

      const [summary, viewerPath] = await Promise.all([summaryPromise, viewerPathPromise]);
      if (token !== this.loadToken) return;

      this.loadingStage = "render";
      this.loadPercent = 85;
      this.paintOverlay();

      const assetUrl = convertFileSrc(viewerPath, "asset");
      this.loadPercent = 92;
      this.paintOverlay();

      await this.viewport.load(assetUrl, this.ui.error_viewer_load);

      if (token !== this.loadToken) return;
      if (
        this.models.length === 0 ||
        this.activePath !== path ||
        !this.models.some((m) => m.path === path)
      ) {
        if (token === this.loadToken && this.phase === "loading") {
          this.phase = this.models.length === 0 ? "empty" : "ready";
        }
        return;
      }

      this.summary = summary;
      const entry = this.modelEntryFromPath(summary.path);
      if (entry) {
        entry.file_size = summary.file_size;
        this.tryUpsertModel(entry);
      }
      this.saveInitialCameraForPath(path);
      this.phase = "ready";
      this.loadPercent = 100;
      this.paintOverlay();
      if (this.cinemaMode && !this.cinemaRotatePaused) {
        this.resetView();
        this.viewport.setAutoRotate(true);
      }
      this.viewport.focus();
      this.paintCinemaControls();
    } catch (err) {
      if (token !== this.loadToken) return;
      this.phase = "error";
      let msg = err instanceof Error ? err.message : String(err);
      const hint = gltfLoadHint(path, this.ui);
      if (hint && !msg.includes(hint)) msg = `${msg}\n${hint}`;
      this.status = msg;
      if (!this.summary) this.viewport.clear();
    }
    this.paint();
  }

  private paint(): void {
    const interactive = this.phase === "ready";
    const overlayVisible = this.phase !== "ready";
    const switching = this.phase === "loading" && this.summary !== null;

    this.els.settingsBackdrop.classList.toggle("hidden", !this.settingsOpen);
    this.els.clearConfirmPop.classList.toggle("hidden", !this.clearConfirmOpen);
    this.els.clearLibrary.classList.toggle("is-active", this.clearConfirmOpen);
    if (this.clearConfirmOpen) {
      this.els.clearConfirmMessage.textContent = this.ui.clear_library_confirm;
      this.els.clearConfirmCancel.textContent = this.ui.cancel;
      this.els.clearConfirmOk.textContent = this.ui.clear_library;
    }
    this.els.viewportMain.classList.toggle("is-interactive", interactive);
    this.els.overlay.classList.toggle("is-visible", overlayVisible);
    this.els.overlay.classList.toggle("is-empty", this.phase === "empty");
    this.els.overlay.classList.toggle("is-loading", this.phase === "loading");
    this.els.overlay.classList.toggle("is-switching", switching);
    this.els.overlay.classList.toggle("is-error", this.phase === "error");
    const showModelPanels =
      this.phase === "ready" || (this.phase === "loading" && this.activePath !== null);
    const hasLibrary = showModelPanels && this.models.length > 0;

    this.shell.classList.toggle("is-cinema", this.cinemaMode);
    this.shell.classList.toggle("is-explorer-collapsed", this.explorerCollapsed);
    this.shell.classList.toggle("is-inspector-collapsed", this.inspectorCollapsed);

    this.els.explorerDrawer.classList.toggle("is-visible", hasLibrary);
    this.els.explorerDrawer.classList.toggle("is-collapsed", this.explorerCollapsed);
    this.els.explorerDrawer.classList.toggle("is-clear-pop-open", this.clearConfirmOpen);
    this.els.inspector.classList.toggle("is-visible", showModelPanels);
    this.els.inspector.classList.toggle("is-collapsed", this.inspectorCollapsed);

    this.els.viewportDock.classList.toggle("is-visible", interactive && !this.cinemaMode);
    this.els.toolCinema.classList.toggle("is-active", this.cinemaMode);
    const showInspectorTab =
      showModelPanels && this.inspectorCollapsed && !this.cinemaMode;
    this.els.expandInspector.classList.toggle("is-visible", showInspectorTab);
    this.paintPanelToggles();
    if (this.cinemaMode) this.paintCinemaControls();

    this.paintSidebar();
    this.paintOverlay();
    this.paintInspector();
  }

  private paintInspector(): void {
    const body = this.els.inspectorBody;
    const loading = this.phase === "loading" && this.activePath !== null;
    const ready = this.phase === "ready" && this.summary !== null;
    const titleEntry = this.activePath
      ? this.models.find((m) => m.path === this.activePath)
      : undefined;
    const contentKey = loading
      ? `loading:${this.activePath}:${this.ui.locale}`
      : ready
        ? `model:${this.summary!.path}:${this.ui.locale}`
        : "idle";

    this.els.inspectorTitle.textContent = titleEntry?.name ?? this.summary?.name ?? "—";
    body.classList.toggle("is-loading", loading);
    body.classList.toggle("is-placeholder", !loading && !ready);
    if (body.dataset.contentKey === contentKey) return;

    body.dataset.contentKey = contentKey;
    body.innerHTML = loading
      ? this.inspectorSkeletonHtml(this.ui)
      : ready
        ? this.inspectorHtml(this.ui, this.summary!)
        : "";
  }

  private inspectorSkeletonHtml(ui: UiBundle): string {
    const line = (w: string) => `<div class="skeleton-line ${w}"></div>`;
    const kv = () => `
      <div class="skeleton-kv">
        ${line("w-40")}
        ${line("w-24")}
      </div>`;

    return `
      <div class="detail-skeleton" aria-busy="true" aria-label="${escapeAttr(ui.loading)}">
        ${line("w-56")}
        <div class="skeleton-group">${kv()}${kv()}${kv()}${kv()}</div>
        <div class="detail-divider"></div>
        <div class="skeleton-block-title">${line("w-28")}</div>
        <div class="skeleton-group">${kv()}${kv()}${kv()}</div>
        <div class="detail-divider"></div>
        <div class="skeleton-block-title">${line("w-20")}</div>
        <div class="skeleton-mat">${line("w-full")}</div>
        <div class="skeleton-mat">${line("w-full")}</div>
      </div>`;
  }

  private removeModel(path: string): void {
    const index = this.models.findIndex((m) => m.path === path);
    if (index < 0) return;

    const wasActive = this.activePath === path;
    this.models.splice(index, 1);
    this.summaryCache.delete(path);
    this.cameraByPath.delete(path);

    if (this.models.length === 0) {
      this.unloadScene();
      return;
    }

    if (!wasActive) {
      this.paint();
      return;
    }

    this.loadToken++;
    this.activePath = null;
    this.summary = null;
    this.viewport.clear();

    const next = this.models[Math.min(index, this.models.length - 1)]!;
    void this.openPath(next.path);
  }

  private performClearLibrary(): void {
    if (this.models.length === 0) {
      this.clearConfirmOpen = false;
      this.paint();
      return;
    }
    this.clearConfirmOpen = false;
    this.models = [];
    this.summaryCache.clear();
    this.cameraByPath.clear();
    this.unloadScene();
  }

  private unloadScene(): void {
    this.loadToken++;
    this.activePath = null;
    this.summary = null;
    this.folderPath = null;
    this.phase = "empty";
    this.status = "";
    this.cinemaMode = false;
    this.cinemaRotatePaused = false;
    this.clearCinemaIdleTimer();
    this.viewport.setAutoRotate(false);
    this.viewport.clear();
    this.paint();
  }

  private paintSidebar(): void {
    const body = this.els.sidebarBody;
    const listKey = this.modelListKey();
    const prevCount = Number(body.dataset.modelCount ?? "0");
    const count = this.models.length;

    if (body.dataset.listKey !== listKey) {
      const scrollTop = body.scrollTop;
      body.dataset.listKey = listKey;
      body.dataset.modelCount = String(count);
      body.innerHTML = this.sidebarHtml(this.ui);
      if (count > prevCount && prevCount > 0) {
        body.scrollTop = body.scrollHeight;
      } else {
        body.scrollTop = scrollTop;
      }
    }

    const active = this.activePath;
    for (const row of body.querySelectorAll<HTMLElement>(".model-row")) {
      const path = row
        .querySelector<HTMLElement>("[data-action=select-model]")
        ?.getAttribute("data-model-path");
      row.classList.toggle("active", path === active);
    }

    this.paintModelCount();
  }

  private paintOverlay(): void {
    if (this.phase === "ready") return;
    if (this.phase === "loading") {
      const kind = `loading:${this.summary ? "switch" : "full"}:${this.ui.locale}`;
      if (this.els.overlay.dataset.overlayKind !== kind) {
        this.els.overlay.dataset.overlayKind = kind;
        this.els.overlay.innerHTML = this.overlayHtml(this.ui);
      }
      const fill = this.els.overlay.querySelector(".load-fill") as HTMLElement | null;
      const label = this.els.overlay.querySelector(".load-text");
      if (fill) fill.style.width = `${this.loadPercent}%`;
      if (label) label.textContent = this.loadingLabel();
      return;
    }
    const kind = this.phase === "empty" ? `empty:${this.ui.locale}` : `${this.phase}:full`;
    if (this.els.overlay.dataset.overlayKind !== kind) {
      this.els.overlay.dataset.overlayKind = kind;
      this.els.overlay.innerHTML = this.overlayHtml(this.ui);
    }
  }

  private syncLoadingProgress(): void {
    if (this.phase !== "loading" || this.loadingStage === "render") return;

    const parseDone = this.parseProgress >= 100;
    if (!parseDone) {
      this.loadingStage = "parse";
      this.loadPercent = Math.min(
        40,
        Math.floor(this.parseProgress * 0.35 + this.packProgress * 0.05),
      );
    } else {
      this.loadingStage = "pack";
      this.loadPercent = Math.min(90, 10 + Math.floor(this.packProgress * 0.8));
    }
    this.paintOverlay();
  }

  private loadingLabel(): string {
    const stage =
      this.loadingStage === "parse"
        ? this.ui.loading_reading
        : this.loadingStage === "pack"
          ? this.ui.loading_packing
          : this.ui.loading_rendering;
    return `${stage} · ${this.loadPercent}%`;
  }

  private sidebarHtml(ui: UiBundle): string {
    if (this.models.length === 0) {
      return `
        <div class="rail-empty">
          <div class="rail-empty-icon" aria-hidden="true">
            <span class="material-symbols-outlined">inventory_2</span>
          </div>
          <p>${escapeHtml(ui.sidebar_empty)}</p>
        </div>`;
    }
    return this.models
      .map((m) => {
        const active = m.path === this.activePath;
        const fmt = formatModelFormat(m.format, ui);
        const pillClass = m.format.toLowerCase() === "glb" ? "format-pill is-glb" : "format-pill";
        const sub = m.file_size ? formatBytes(m.file_size, ui) : "";
        return `
        <div class="model-row ${active ? "active" : ""}">
          <button type="button" class="model-row-main" data-action="select-model" data-model-path="${escapeAttr(m.path)}">
            <span class="${pillClass}">${escapeHtml(fmt)}</span>
            <span class="model-row-body">
              <span class="model-row-title">${escapeHtml(m.name)}</span>
              ${sub ? `<span class="model-row-sub">${escapeHtml(sub)}</span>` : ""}
            </span>
          </button>
          <button type="button" class="model-row-remove" data-action="remove-model" data-model-path="${escapeAttr(m.path)}" aria-label="${escapeAttr(ui.remove_model)}">
            <span class="material-symbols-outlined">close</span>
          </button>
        </div>`;
      })
      .join("");
  }

  private overlayHtml(ui: UiBundle): string {
    if (this.phase === "loading") {
      const compact = this.summary !== null;
      return `
        <div class="load-panel ${compact ? "is-compact" : ""}" aria-busy="true" aria-label="${escapeAttr(ui.loading)}">
          <div class="load-bar"><div class="load-fill" style="width:${this.loadPercent}%"></div></div>
          <p class="load-text">${escapeHtml(this.loadingLabel())}</p>
        </div>`;
    }
    if (this.phase === "empty") {
      return `
        <div class="empty-hero">
          <div class="empty-glow" aria-hidden="true"></div>
          <img class="empty-mark" src="/logo.png" width="64" height="64" alt="" />
          <p class="empty-brand">${escapeHtml(ui.app_name)}</p>
          <p class="empty-quote">${escapeHtml(ui.empty_title)}</p>
        </div>`;
    }
    if (this.phase === "error") {
      return `
        <div class="error-panel">
          <div class="error-icon" aria-hidden="true">!</div>
          <h3 class="error-title">${escapeHtml(ui.error_title)}</h3>
          <p class="error-message">${escapeHtml(this.status)}</p>
        </div>`;
    }
    return "";
  }

  private inspectorHtml(ui: UiBundle, s: SceneSummary): string {
    const fmt = formatModelFormat(s.format, ui);
    const meta = [formatBytes(s.file_size, ui), fmt].join(" · ");

    const kv = (key: string, val: string) => `
      <div class="kv-row">
        <span class="kv-key">${escapeHtml(key)}</span>
        <span class="kv-val">${escapeHtml(val)}</span>
      </div>`;

    const stats = [
      kv(ui.metric_vertices, formatCount(s.vertex_count, ui.locale)),
      kv(ui.metric_triangles, formatCount(s.triangle_count, ui.locale)),
      kv(ui.metric_meshes, formatCount(s.mesh_count, ui.locale)),
      kv(ui.metric_materials, formatCount(s.material_count, ui.locale)),
    ].join("");

    const mats = s.materials
      .map(
        (m) => `
        <li class="mat-item">
          <span class="swatch" style="background:${rgbaCss(m.base_color)}"></span>
          <span class="mat-item-name">${escapeHtml(m.name)}</span>
        </li>`,
      )
      .join("");

    const materialsBody = mats
      ? `<ul class="mat-list">${mats}</ul>`
      : `<p class="detail-empty">${escapeHtml(ui.metric_none)}</p>`;

    return `
      <article class="detail-content">
        <div class="detail-core">
          <p class="detail-meta">${escapeHtml(meta)}</p>
          <div class="kv-group">${stats}</div>
          <div class="detail-divider"></div>
          <section class="detail-block">
            <h4 class="detail-block-title">${escapeHtml(ui.panel_dimensions)}</h4>
            ${dimensionRows(ui, s)}
          </section>
        </div>
        <section class="detail-materials">
          <h4 class="detail-block-title">${escapeHtml(ui.panel_materials)}</h4>
          <div class="detail-materials-scroll scroll-subtle">${materialsBody}</div>
        </section>
      </article>`;
  }
}

function dimensionRows(ui: UiBundle, s: SceneSummary): string {
  const rows = [
    { key: ui.metric_axis_w, val: s.bounds_w },
    { key: ui.metric_axis_h, val: s.bounds_h },
    { key: ui.metric_axis_d, val: s.bounds_d },
  ];

  return rows
    .map(
      (r) => `
      <div class="kv-row">
        <span class="kv-key">${escapeHtml(r.key)}</span>
        <span class="kv-val">${escapeHtml(formatDimension(r.val, ui.unit_meter))}</span>
      </div>`,
    )
    .join("");
}

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

const SHELL_HTML = `
  <div class="viewport-bg" aria-hidden="true">
    <div class="perspective-grid"></div>
  </div>

  <main class="viewport">
    <div class="viewport-host" tabindex="0"></div>
    <div class="overlay" data-bind="overlay"></div>
  </main>

  <aside class="explorer-rail glass-capsule">
    <button type="button" class="rail-primary-btn" data-action="sidebar-open-file" aria-label="">
      <span class="material-symbols-outlined">add</span>
    </button>
    <button type="button" class="rail-icon-btn" data-action="sidebar-open-folder" aria-label="">
      <span class="material-symbols-outlined">folder_open</span>
    </button>
    <button type="button" class="rail-icon-btn" data-action="toggle-library" aria-label="">
      <span class="material-symbols-outlined">side_navigation</span>
    </button>
    <button type="button" class="rail-icon-btn rail-settings" data-action="settings" aria-label="">
      <span class="material-symbols-outlined">settings</span>
    </button>
  </aside>

  <aside class="explorer-drawer glass-capsule" data-bind="explorer-drawer">
    <div class="explorer-drawer-head">
      <div class="panel-head-text">
        <span class="explorer-drawer-title" data-bind="sidebar-title"></span>
        <span class="explorer-drawer-count" data-bind="model-count"></span>
      </div>
      <div class="explorer-drawer-actions">
        <div class="explorer-clear-anchor">
          <button type="button" class="panel-toggle" data-action="clear-library" aria-label="">
            <span class="material-symbols-outlined">playlist_remove</span>
          </button>
          <div class="library-clear-pop glass-capsule hidden" data-bind="clear-confirm" role="alertdialog" aria-modal="true">
            <p class="library-clear-pop-text" data-bind="clear-confirm-message"></p>
            <div class="library-clear-pop-actions">
              <button type="button" class="library-clear-pop-btn" data-action="clear-library-cancel"></button>
              <button type="button" class="library-clear-pop-btn library-clear-pop-btn-primary" data-action="clear-library-confirm"></button>
            </div>
          </div>
        </div>
        <button type="button" class="panel-toggle" data-action="collapse-explorer" aria-label="">
          <span class="material-symbols-outlined">chevron_left</span>
        </button>
      </div>
    </div>
    <div class="explorer-drawer-body scroll-subtle" data-bind="sidebar"></div>
  </aside>

  <aside class="inspector-panel glass-capsule">
    <header class="inspector-head">
      <div class="inspector-head-row">
        <span class="inspector-label" data-bind="inspector-label"></span>
        <button type="button" class="panel-toggle" data-action="collapse-inspector" aria-label="">
          <span class="material-symbols-outlined">chevron_right</span>
        </button>
      </div>
      <h2 class="inspector-title" data-bind="inspector-title">—</h2>
    </header>
    <div class="inspector-body" data-bind="inspector"></div>
  </aside>

  <footer class="bottom-dock glass-capsule" data-bind="viewport-dock">
    <button type="button" class="dock-btn" data-action="zoom-out" aria-label="">
      <span class="material-symbols-outlined">zoom_out</span>
    </button>
    <button type="button" class="dock-btn" data-action="zoom-in" aria-label="">
      <span class="material-symbols-outlined">zoom_in</span>
    </button>
    <button type="button" class="dock-btn" data-action="reset-view" aria-label="">
      <span class="material-symbols-outlined">sync</span>
    </button>
    <span class="dock-divider" aria-hidden="true"></span>
    <button type="button" class="dock-btn" data-action="cinema-mode" aria-label="">
      <span class="material-symbols-outlined">panorama</span>
    </button>
  </footer>

  <div class="cinema-controls">
    <button type="button" class="cinema-ctrl glass-capsule" data-action="cinema-toggle-rotate" aria-label="">
      <span class="material-symbols-outlined">pause</span>
    </button>
    <button type="button" class="cinema-ctrl glass-capsule" data-action="exit-cinema" aria-label="">
      <span class="material-symbols-outlined">close</span>
    </button>
  </div>

  <button type="button" class="panel-expand-tab glass-capsule" data-action="expand-inspector" aria-label="">
    <span class="material-symbols-outlined">chevron_left</span>
  </button>

  <div class="app-toast glass-capsule" data-bind="toast" role="status" aria-live="polite"></div>

  <div class="settings-backdrop hidden" data-bind="settings">
    <div class="settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-heading">
      <header class="settings-header">
        <h2 id="settings-heading" data-bind="settings-title"></h2>
        <button type="button" class="settings-close" data-action="close-settings" aria-label="">
          <span class="material-symbols-outlined">close</span>
        </button>
      </header>
      <div class="settings-body">
        <div class="settings-section">
          <label data-bind="language-label"></label>
          <div class="segmented" data-bind="locale-group"></div>
        </div>
        <div class="settings-section">
          <label data-bind="appearance-label"></label>
          <div class="segmented" data-bind="theme-group"></div>
        </div>
      </div>
    </div>
  </div>
`;
