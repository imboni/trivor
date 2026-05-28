import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  getUiBundle,
  listModelsInFolder,
  loadModel,
  normalizeModelPath,
  resolveViewerModelPath,
  onLoadProgress,
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
  formatModelCount,
  formatModelFormat,
  rgbaCss,
} from "./format";
import type { AppPhase, ModelListEntry, SceneSummary, UiBundle } from "./types";
import {
  initTheme,
  loadStoredThemePref,
  setThemePreference,
  watchSystemTheme,
  type ThemePref,
} from "./theme";
import { flushUi } from "./ui";
import { ModelViewport } from "./viewer";

type LocalePref = "en" | "zh-Hans" | "system";

export class App {
  private ui!: UiBundle;
  private phase: AppPhase = "empty";
  private summary: SceneSummary | null = null;
  private loadPercent = 0;
  private loadingStage: "parse" | "render" = "parse";
  private status = "";
  private settingsOpen = false;

  private folderPath: string | null = null;
  private models: ModelListEntry[] = [];
  private activePath: string | null = null;
  private readonly summaryCache = new Map<string, SceneSummary>();
  private loadToken = 0;
  private dialogOpen = false;

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
      brandName: pick("[data-bind=brand-name]"),
      brandTag: pick("[data-bind=brand-tag]"),
      sidebarOpenFile: pick("[data-action=sidebar-open-file]"),
      sidebarOpenFolder: pick("[data-action=sidebar-open-folder]"),
      settingsBtn: pick("[data-action=settings]"),
      sidebarTitle: pick("[data-bind=sidebar-title]"),
      modelCount: pick("[data-bind=model-count]"),
      sidebarBody: pick("[data-bind=sidebar]"),
      viewportMain: pick(".viewport"),
      viewportHost: pick(".viewport-host"),
      viewportHints: pick("[data-bind=viewport-hints]"),
      overlay: pick("[data-bind=overlay]"),
      viewportDock: pick("[data-bind=viewport-dock]"),
      toolZoomOut: pick("[data-action=zoom-out]"),
      toolZoomIn: pick("[data-action=zoom-in]"),
      toolResetView: pick("[data-action=reset-view]"),
      closeSettings: pick("[data-action=close-settings]"),
      inspector: pick(".detail-panel"),
      inspectorTitle: pick("[data-bind=inspector-title]"),
      inspectorBody: pick("[data-bind=inspector]"),
      settingsBackdrop: pick("[data-bind=settings]"),
      settingsPanel: pick(".settings-panel"),
      settingsTitle: pick("[data-bind=settings-title]"),
      languageLabel: pick("[data-bind=language-label]"),
      localeGroup: pick("[data-bind=locale-group]"),
      appearanceLabel: pick("[data-bind=appearance-label]"),
      themeGroup: pick("[data-bind=theme-group]"),
    };

    this.viewport = new ModelViewport(this.els.viewportHost);
    this.viewport.attachWheelSurface(this.els.viewportMain);
    this.bind();
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
      this.loadPercent = p;
      if (this.phase === "loading") this.paintLoadingProgress();
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
        if (this.phase === "ready") this.viewport.reset();
        break;
      case "fit-view":
        if (this.phase === "ready") void this.viewport.fit();
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
      this.viewport.reset();
      this.viewport.focus();
    });
  }

  private bindLocaleButtons(): void {
    this.els.localeGroup.querySelectorAll("[data-locale]").forEach((el) => {
      el.addEventListener("click", () => {
        const pref = (el as HTMLElement).dataset.locale as LocalePref;
        void setLocale(pref).then((bundle) => {
          this.ui = bundle;
          this.applyUi();
          this.paint();
        });
      });
    });
  }

  private applyUi(): void {
    document.documentElement.lang = this.ui.locale;
    document.title = this.ui.window_title;
    this.els.brandName.textContent = this.ui.app_name;
    this.els.brandTag.textContent = this.ui.tagline;
    this.els.sidebarOpenFile.textContent = this.ui.open_file;
    this.els.sidebarOpenFolder.textContent = this.ui.open_folder;
    this.els.settingsBtn.title = this.ui.settings;
    this.els.settingsBtn.setAttribute("aria-label", this.ui.settings);
    this.els.sidebarTitle.textContent = this.ui.sidebar_models;
    this.els.inspectorTitle.textContent = this.ui.inspector_title;
    this.els.settingsTitle.textContent = this.ui.settings;
    this.els.languageLabel.textContent = this.ui.language;
    this.els.appearanceLabel.textContent = this.ui.appearance;
    this.els.viewportHints.textContent = this.ui.viewport_hints;
    this.els.toolZoomOut.title = this.ui.tool_zoom_out;
    this.els.toolZoomIn.title = this.ui.tool_zoom_in;
    this.els.toolResetView.title = this.ui.tool_reset_view;
    this.els.closeSettings.title = this.ui.close_settings;
    this.els.closeSettings.setAttribute("aria-label", this.ui.close_settings);
    this.paintModelCount();
    this.renderLocaleSegments();
    this.renderThemeSegments();
    this.bindLocaleButtons();
    this.bindThemeButtons();
  }

  private paintModelCount(): void {
    const el = this.els.modelCount;
    if (this.models.length === 0) {
      el.textContent = "";
      return;
    }
    el.textContent = formatModelCount(this.ui.model_count, this.models.length, this.ui.locale);
  }

  private renderLocaleSegments(): void {
    const ui = this.ui;
    const active = ui.locale_pref;
    const seg = (id: LocalePref, label: string) =>
      `<button type="button" class="seg ${active === id ? "active" : ""}" data-locale="${id}">${label}</button>`;
    this.els.localeGroup.innerHTML = [
      seg("en", ui.lang_en),
      seg("zh-Hans", ui.lang_zh),
      seg("system", ui.lang_system),
    ].join("");
  }

  private renderThemeSegments(): void {
    const ui = this.ui;
    const active = ui.theme_pref;
    const seg = (id: ThemePref, label: string) =>
      `<button type="button" class="seg ${active === id ? "active" : ""}" data-theme="${id}">${label}</button>`;
    this.els.themeGroup.innerHTML = [
      seg("dark", ui.theme_dark),
      seg("light", ui.theme_light),
      seg("system", ui.theme_system),
    ].join("");
  }

  private bindThemeButtons(): void {
    this.els.themeGroup.querySelectorAll("[data-theme]").forEach((el) => {
      el.addEventListener("click", () => {
        const pref = (el as HTMLElement).dataset.theme as ThemePref;
        void setThemePreference(pref).then((bundle) => {
          this.ui = bundle;
          initTheme(bundle);
          this.applyUi();
          this.paint();
        });
      });
    });
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
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
      void this.viewport.fit();
    } else if (key.toLowerCase() === "r") {
      this.viewport.reset();
    }
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
        this.phase = "error";
        this.status = this.ui.error_folder_empty;
        this.paint();
        return;
      }
      this.folderPath = dir;
      this.models = items;
      this.paintSidebar();
      const first = items[0]!.path;
      if (this.activePath !== first) {
        await this.openPath(first);
      } else {
        this.paint();
      }
    } catch (err) {
      this.phase = "error";
      this.status = err instanceof Error ? err.message : String(err);
      this.paint();
    }
  }

  private upsertModel(entry: ModelListEntry): void {
    const i = this.models.findIndex((m) => m.path === entry.path);
    if (i >= 0) this.models[i] = entry;
    else this.models.push(entry);
    this.models.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
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
      if (entry) this.upsertModel(entry);
    }

    if (this.activePath === path && this.phase === "ready" && this.summary) {
      return;
    }

    const token = ++this.loadToken;
    this.activePath = path;
    this.phase = "loading";
    this.loadPercent = 0;
    this.loadingStage = "parse";
    this.status = "";
    this.paint();

    await flushUi();

    try {
      const cached = this.summaryCache.get(path);

      this.loadingStage = "render";
      this.loadPercent = cached ? 95 : 20;
      this.paintLoadingProgress();

      const viewerPath = await resolveViewerModelPath(path);
      this.loadPercent = cached ? 95 : 55;
      this.paintLoadingProgress();

      const assetUrl = convertFileSrc(viewerPath, "asset");
      const viewerPromise = this.viewport.load(assetUrl, this.ui.error_viewer_load);
      const summaryPromise = cached
        ? Promise.resolve(cached)
        : loadModel(path).then((summary) => {
            this.summaryCache.set(path, summary);
            return summary;
          });

      const [summary] = await Promise.all([summaryPromise, viewerPromise]);

      if (token !== this.loadToken) return;

      this.summary = summary;
      const entry = this.modelEntryFromPath(summary.path);
      if (entry) {
        entry.file_size = summary.file_size;
        this.upsertModel(entry);
      }
      this.phase = "ready";
      this.viewport.focus();
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
    this.els.viewportMain.classList.toggle("is-interactive", interactive);
    this.els.viewportDock.classList.toggle("is-visible", interactive);
    this.els.viewportHints.classList.toggle("is-visible", interactive);
    this.els.overlay.classList.toggle("is-visible", overlayVisible);
    this.els.overlay.classList.toggle("is-empty", this.phase === "empty");
    this.els.overlay.classList.toggle("is-loading", this.phase === "loading");
    this.els.overlay.classList.toggle("is-switching", switching);
    this.els.overlay.classList.toggle("is-error", this.phase === "error");
    this.els.inspector.classList.toggle("is-busy", this.phase === "loading");

    this.paintSidebar();
    this.paintOverlay();
    this.paintInspector();
  }

  private paintInspector(): void {
    const body = this.els.inspectorBody;
    const hasContent = this.summary && (this.phase === "ready" || this.phase === "loading");
    const contentKey = hasContent
      ? `model:${this.summary!.path}:${this.ui.locale}`
      : `placeholder:${this.ui.locale}`;

    body.classList.toggle("is-placeholder", !hasContent);
    if (body.dataset.contentKey === contentKey) return;

    body.classList.add("is-fading");
    body.dataset.contentKey = contentKey;
    body.innerHTML = hasContent
      ? this.inspectorHtml(this.ui, this.summary!)
      : this.inspectorPlaceholderHtml(this.ui);
    requestAnimationFrame(() => body.classList.remove("is-fading"));
  }

  private inspectorPlaceholderHtml(ui: UiBundle): string {
    return `
      <div class="detail-placeholder">
        <div class="detail-placeholder-icon" aria-hidden="true"></div>
        <p>${escapeHtml(ui.inspector_placeholder)}</p>
      </div>`;
  }

  private paintSidebar(): void {
    this.els.sidebarBody.innerHTML = this.sidebarHtml(this.ui);
    this.paintModelCount();
    this.els.sidebarBody.querySelectorAll("[data-model-path]").forEach((el) => {
      el.addEventListener("click", () => {
        const path = (el as HTMLElement).dataset.modelPath;
        if (path && path !== this.activePath) void this.openPath(path);
      });
    });
  }

  private paintOverlay(): void {
    if (this.phase === "ready") return;
    const kind =
      this.phase === "empty"
        ? `empty:${this.ui.locale}`
        : `${this.phase}:${this.summary ? "switch" : "full"}`;
    if (this.els.overlay.dataset.overlayKind !== kind) {
      this.els.overlay.dataset.overlayKind = kind;
      this.els.overlay.innerHTML = this.overlayHtml(this.ui);
    }
    if (this.phase === "loading") this.paintLoadingProgress();
  }

  private paintLoadingProgress(): void {
    if (this.phase !== "loading") return;
    const label = this.els.overlay.querySelector(".load-text");
    const fill = this.els.overlay.querySelector(".load-fill") as HTMLElement | null;
    if (label) label.textContent = this.loadingLabel();
    if (fill) fill.style.width = `${this.loadPercent}%`;
    if (!label) this.paintOverlay();
  }

  private loadingLabel(): string {
    const ui = this.ui;
    const stage =
      this.loadingStage === "parse" ? ui.loading_reading : ui.loading_rendering;
    return `${stage} · ${this.loadPercent}%`;
  }

  private sidebarHtml(ui: UiBundle): string {
    if (this.models.length === 0) {
      return `
        <div class="rail-empty">
          <div class="rail-empty-icon" aria-hidden="true"></div>
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
        <button type="button" class="model-row ${active ? "active" : ""}" data-model-path="${escapeAttr(m.path)}">
          <span class="${pillClass}">${escapeHtml(fmt)}</span>
          <span class="model-row-body">
            <span class="model-row-title">${escapeHtml(m.name)}</span>
            ${sub ? `<span class="model-row-sub">${escapeHtml(sub)}</span>` : ""}
          </span>
        </button>`;
      })
      .join("");
  }

  private overlayHtml(ui: UiBundle): string {
    if (this.phase === "loading") {
      const compact = this.summary !== null;
      return `
        <div class="load-panel ${compact ? "is-compact" : ""}">
          <div class="load-bar"><div class="load-fill" style="width:${this.loadPercent}%"></div></div>
          <p class="load-text">${escapeHtml(this.loadingLabel())}</p>
        </div>`;
    }
    if (this.phase === "empty") {
      return `
        <div class="empty-hero">
          <div class="empty-glow" aria-hidden="true"></div>
          <img class="empty-mark" src="/logo.png" width="56" height="56" alt="" />
          <p class="empty-brand">${escapeHtml(ui.app_name)}</p>
          <p class="empty-quote">${escapeHtml(ui.empty_title)}</p>
          <p class="empty-hint">${escapeHtml(ui.empty_hint)}</p>
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
    const pillClass = s.format.toLowerCase() === "glb" ? "format-pill is-glb" : "format-pill";
    const meta = [formatBytes(s.file_size, ui), fmt].join(" · ");

    const stats = [
      { val: formatCount(s.mesh_count, ui.locale), lbl: ui.metric_meshes },
      { val: formatCount(s.material_count, ui.locale), lbl: ui.metric_materials },
      { val: formatCount(s.vertex_count, ui.locale), lbl: ui.metric_vertices },
      { val: formatCount(s.triangle_count, ui.locale), lbl: ui.metric_triangles },
    ];

    const mats = s.materials
      .map(
        (m) => `
        <li class="mat-item">
          <span class="swatch" style="background:${rgbaCss(m.base_color)}"></span>
          <span>${escapeHtml(m.name)}</span>
        </li>`,
      )
      .join("");

    return `
      <article class="detail-content">
        <header class="model-head">
          <span class="${pillClass}">${escapeHtml(fmt)}</span>
          <h3 class="model-title">${escapeHtml(s.name)}</h3>
          <p class="model-meta">${escapeHtml(meta)}</p>
        </header>
        <div class="stat-grid">
          ${stats
            .map(
              (st) => `
            <div class="stat-card">
              <span class="stat-val">${escapeHtml(st.val)}</span>
              <span class="stat-lbl">${escapeHtml(st.lbl)}</span>
            </div>`,
            )
            .join("")}
        </div>
        <section class="detail-block">
          <h4>${escapeHtml(ui.panel_dimensions)}</h4>
          ${dimensionBars(ui, s)}
        </section>
        <section class="detail-block">
          <h4>${escapeHtml(ui.panel_materials)}</h4>
          ${
            mats
              ? `<ul class="mat-list">${mats}</ul>`
              : `<p class="detail-empty">${escapeHtml(ui.metric_none)}</p>`
          }
        </section>
      </article>`;
  }
}

function dimensionBars(ui: UiBundle, s: SceneSummary): string {
  const w = s.bounds_w;
  const h = s.bounds_h;
  const d = s.bounds_d;
  const max = Math.max(w, h, d, 0.001);

  const row = (label: string, val: number) => {
    const pct = Math.max(4, (val / max) * 100);
    return `
      <div class="dim-row">
        <span class="dim-lbl">${escapeHtml(label)}</span>
        <div class="dim-track"><div class="dim-fill" style="width:${pct}%"></div></div>
        <span class="dim-val">${escapeHtml(formatDimension(val, ui.unit_meter))}</span>
      </div>`;
  };

  return (
    row(ui.metric_axis_w, w) + row(ui.metric_axis_h, h) + row(ui.metric_axis_d, d)
  );
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
  <aside class="rail">
    <header class="rail-head">
      <div class="brand">
        <img class="brand-mark" src="/logo.png" width="32" height="32" alt="" />
        <div class="brand-text">
          <div class="brand-name" data-bind="brand-name"></div>
          <div class="brand-tag" data-bind="brand-tag"></div>
        </div>
      </div>
      <button type="button" class="rail-settings" data-action="settings" aria-label="">⚙</button>
    </header>
    <div class="rail-actions">
      <button type="button" class="btn btn-primary" data-action="sidebar-open-file"></button>
      <button type="button" class="btn btn-secondary" data-action="sidebar-open-folder"></button>
    </div>
    <div class="rail-section">
      <span class="rail-label" data-bind="sidebar-title"></span>
      <span class="rail-count" data-bind="model-count"></span>
    </div>
    <div class="rail-list" data-bind="sidebar"></div>
  </aside>
  <div class="stage">
    <main class="viewport">
      <div class="viewport-host" tabindex="0"></div>
      <div class="viewport-hints" data-bind="viewport-hints"></div>
      <div class="overlay" data-bind="overlay"></div>
      <div class="viewport-dock" data-bind="viewport-dock">
        <button type="button" class="dock-btn" data-action="zoom-out" aria-label="">−</button>
        <button type="button" class="dock-btn" data-action="zoom-in" aria-label="">+</button>
        <span class="dock-divider" aria-hidden="true"></span>
        <button type="button" class="dock-btn" data-action="reset-view" aria-label="">↺</button>
      </div>
    </main>
    <aside class="detail-panel">
      <header class="detail-head">
        <h2 data-bind="inspector-title"></h2>
      </header>
      <div class="detail-body" data-bind="inspector"></div>
    </aside>
  </div>
  <div class="settings-backdrop hidden" data-bind="settings">
    <div class="settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-heading">
      <header class="settings-header">
        <h2 id="settings-heading" data-bind="settings-title"></h2>
        <button type="button" class="settings-close" data-action="close-settings" aria-label="">×</button>
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
