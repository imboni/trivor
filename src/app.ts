import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  checkForUpdates,
  clearViewerCache,
  completeStartup,
  downloadUpdate,
  getAppInfo,
  getUiBundle,
  listModelsInFolder,
  loadModel,
  normalizeModelPath,
  modelFileSize,
  openDownloadedUpdate,
  openExternalUrl,
  pathKind,
  revealModelInFolder,
  resolveViewerModelPath,
  saveCutoutDialog,
  onLoadProgress,
  onPackProgress,
  onUpdateDownloadProgress,
  openFolderDialog,
  openModelDialog,
  setLocale,
  viewerCacheSize,
} from "./bridge";
import { mountOverlayTitlebar } from "./titlebar";
import {
  gltfLoadHint,
  isModelPath,
  modelExtension,
  unsupportedModelMessage,
} from "./model-path";
import {
  formatAppDate,
  formatBytes,
  formatCount,
  formatDimension,
  formatLibraryLimit,
  formatModelCount,
  formatModelFormat,
  rgbaCss,
} from "./format";
import { CutoutExportError } from "./cutout-export";
import { CutoutFrameGuide } from "./cutout-frame-guide";
import { CutoutPreviewPanel } from "./cutout-preview-panel";
import {
  ensurePngFilename,
  pngObjectUrl,
  revokePngObjectUrl,
} from "./cutout-flow";
import { activeModelFolderKey, libraryTreeListKey, renderLibraryTree } from "./library-tree";
import { LibraryContextMenu } from "./library-menu";
import { isPathUnderDir, resolveLibraryMenuContext } from "./library-path";
import {
  bindingFromEvent,
  renderShortcutsSettings,
  ShortcutStore,
  type ShortcutId,
} from "./shortcuts";
import type { AppInfo, AppPhase, ModelListEntry, SceneSummary, UiBundle, UpdateCheckResult } from "./types";
import {
  initTheme,
  loadStoredThemePref,
  setThemePreference,
  watchSystemTheme,
  type ThemePref,
} from "./theme";
import { AxisOrientationWidget } from "./axis-widget";
import { invalidateSceneThemeCache } from "./scene-theme";
import { delay, flushUi } from "./ui";
import { SceneOptionsStore, type SceneGuideOptions } from "./scene-options";
import { UpdatePreferencesStore } from "./update-preferences";
import { ModelViewport, type SavedCamera } from "./viewer";
import { measureViewportInsets } from "./viewport-framing";

/** Maximum models kept in the library list. */
export const MAX_LIBRARY_MODELS = 100;

/** Advisory hint when load fails for models at or above this on-disk size. */
const LARGE_MODEL_HINT_BYTES = 100 * 1024 * 1024;
import {
  isPreviewCachePath,
  PREVIEW_OPTIMIZE_BYTES,
  resolveLoadFailureMessage,
} from "./load-failure";

type LocalePref = "en" | "zh-Hans" | "system";

const FALLBACK_REPOSITORY = "https://github.com/imboni/trivor";
const DISMISSED_UPDATE_KEY = "trivor:dismissed-update-version";
/** Wait after launch before hitting the network; lets the shell paint and settle first. */
const UPDATE_STARTUP_CHECK_DELAY_MS = 3000;
const UPDATE_STARTUP_SETTLE_POLL_MS = 100;
const UPDATE_STARTUP_SETTLE_TIMEOUT_MS = 60_000;

function fallbackAppInfo(): AppInfo {
  return {
    version: "",
    build_date: "",
    repository: FALLBACK_REPOSITORY,
    homepage: FALLBACK_REPOSITORY,
    issues_url: `${FALLBACK_REPOSITORY}/issues`,
    releases_url: `${FALLBACK_REPOSITORY}/releases`,
    license: "MIT",
    copyright: "Copyright © 2026 imboni and contributors.",
  };
}

export class App {
  private ui!: UiBundle;
  private phase: AppPhase = "empty";
  private summary: SceneSummary | null = null;
  private loadPercent = 0;
  private parseProgress = 0;
  private packProgress = 0;
  private loadingExpectsPreview = false;
  private loadingStage: "parse" | "pack" | "render" = "parse";
  private status = "";
  private loadFailure: { path: string; viewerPath: string | null; raw: string } | null =
    null;
  private settingsOpen = false;
  private clearConfirmOpen = false;
  private static readonly POP_MOTION_MS = 200;

  private libraryClearPopShown = false;
  private libraryClearPopTimer: ReturnType<typeof setTimeout> | null = null;
  private cacheConfirmOpen = false;
  private cacheClearPopShown = false;
  private cacheClearPopTimer: ReturnType<typeof setTimeout> | null = null;
  private viewerCacheBytes: number | null = null;
  private cacheSizeFetchedForSettings = false;
  private cacheClearing = false;
  private explorerCollapsed = false;
  private inspectorCollapsed = false;
  /** After dismissing a load error overlay, keep the inspector hidden until the next model open. */
  private inspectorHiddenAfterError = false;
  private viewportInsetsRaf = 0;
  private cinemaMode = false;
  private cinemaRotatePaused = false;
  private cinemaIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private cinemaChromeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly cinemaIdleMs = 3000;
  private readonly cinemaChromeIdleMs = 2400;

  private folderPath: string | null = null;
  /** Folder roots added via “open folder”; drives the library tree. */
  private libraryRoots: string[] = [];
  private collapsedFolders = new Set<string>();
  private models: ModelListEntry[] = [];
  private activePath: string | null = null;
  private readonly summaryCache = new Map<string, SceneSummary>();
  private readonly cameraByPath = new Map<string, SavedCamera>();
  private loadToken = 0;
  private sidebarItemAnimating = false;
  private libraryRefreshing = false;
  private dialogOpen = false;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private updateStatusTimer: ReturnType<typeof setTimeout> | null = null;
  private setGridParallaxDormant: ((dormant: boolean) => void) | null = null;
  private appInfo: AppInfo | null = null;
  private updateState: "idle" | "checking" | "uptodate" | "available" | "error" = "idle";
  private updateResult: UpdateCheckResult | null = null;
  /** Kept after update check metadata expires so the banner still shows the version. */
  private cachedLatestVersion: string | null = null;
  private updateBannerVisible = false;
  private updateDownloadState: "idle" | "downloading" = "idle";
  private updateDownloadPercent = 0;
  private updateDownloadedBytes = 0;
  private updateDownloadTotalBytes = 0;
  private pendingStartupUpdateBanner = false;
  private cutoutMode = false;
  private cutoutPanelsSnapshot: { explorer: boolean; inspector: boolean } | null = null;
  private cutoutExporting = false;
  private cutoutPreviewOpen = false;
  private cutoutPendingBytes: Uint8Array | null = null;
  private cutoutPreviewUrl: string | null = null;
  private sceneGuidesSyncedForReady = false;
  private cutoutFrameGuideShown = false;
  private readonly shortcuts = new ShortcutStore();
  private shortcutRecording: ShortcutId | null = null;
  private readonly sceneOptions = new SceneOptionsStore();
  private readonly updatePreferences = new UpdatePreferencesStore();

  private readonly shell: HTMLElement;
  private readonly viewport: ModelViewport;
  private readonly cutoutFrameGuide: CutoutFrameGuide;
  private readonly cutoutPreviewPanel: CutoutPreviewPanel;
  private readonly axisWidget: AxisOrientationWidget;
  private readonly libraryMenu: LibraryContextMenu;
  private readonly els: Record<string, HTMLElement>;

  constructor(root: HTMLElement) {
    this.shell = document.createElement("div");
    this.shell.className = "shell";
    this.shell.innerHTML = SHELL_HTML;
    root.appendChild(this.shell);
    mountOverlayTitlebar(this.shell);

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
      axisWidget: pick("[data-bind=axis-widget]"),
      overlay: pick("[data-bind=overlay]"),
      viewportDock: pick("[data-bind=viewport-dock]"),
      toolZoomOut: pick("[data-action=zoom-out]"),
      toolZoomIn: pick("[data-action=zoom-in]"),
      toolFitView: pick("[data-action=fit-view]"),
      toolResetView: pick("[data-action=reset-view]"),
      toolToggleCutout: pick("[data-action=toggle-cutout-mode]"),
      cutoutRunBar: pick("[data-bind=cutout-run-bar]"),
      cutoutRunBtn: pick("[data-action=run-cutout-export]"),
      cutoutRunLabel: pick("[data-bind=cutout-run-label]"),
      toolCinema: pick("[data-action=cinema-mode]"),
      toolPreviewGrid: pick("[data-action=toggle-preview-grid]"),
      toolSceneGuides: pick("[data-action=toggle-scene-guides]"),
      cinemaExit: pick("[data-action=exit-cinema]"),
      cinemaToggleRotate: pick("[data-action=cinema-toggle-rotate]"),
      cinemaControls: pick(".cinema-controls"),
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
      settingsBody: pick(".settings-body"),
      settingsTitle: pick("[data-bind=settings-title]"),
      languageLabel: pick("[data-bind=language-label]"),
      localeGroup: pick("[data-bind=locale-group]"),
      appearanceLabel: pick("[data-bind=appearance-label]"),
      themeGroup: pick("[data-bind=theme-group]"),
      shortcutsLabel: pick("[data-bind=shortcuts-label]"),
      shortcutsResetAll: pick("[data-action=reset-shortcuts]"),
      shortcutsResetAllLabel: pick("[data-bind=shortcuts-reset-all-label]"),
      shortcutsList: pick("[data-bind=shortcuts-list]"),
      sceneLabel: pick("[data-bind=scene-label]"),
      sceneOptionsList: pick("[data-bind=scene-options-list]"),
      updatesLabel: pick("[data-bind=updates-label]"),
      updateSettingsList: pick("[data-bind=update-settings-list]"),
      storageLabel: pick("[data-bind=storage-label]"),
      cacheTitle: pick("[data-bind=cache-title]"),
      cacheHint: pick("[data-bind=cache-hint]"),
      cacheSize: pick("[data-bind=cache-size]"),
      clearCacheBtn: pick("[data-action=clear-cache]"),
      clearCacheLabel: pick("[data-bind=clear-cache-label]"),
      cacheClearConfirm: pick("[data-bind=cache-clear-confirm]"),
      cacheClearConfirmMessage: pick("[data-bind=cache-clear-confirm-message]"),
      cacheClearConfirmCancel: pick("[data-action=clear-cache-cancel]"),
      cacheClearConfirmOk: pick("[data-action=clear-cache-confirm]"),
      cutoutBackdrop: pick("[data-bind=cutout-backdrop]"),
      cutoutPreviewPanel: pick("[data-bind=cutout-preview-panel]"),
      cutoutPreviewHeader: pick("[data-bind=cutout-preview-header]"),
      cutoutPreviewStage: pick("[data-bind=cutout-preview-stage]"),
      cutoutPreviewViewport: pick("[data-bind=cutout-preview-viewport]"),
      cutoutPreviewResize: pick("[data-bind=cutout-preview-resize]"),
      cutoutPreviewTitle: pick("[data-bind=cutout-preview-title]"),
      cutoutPreviewImage: pick("[data-bind=cutout-preview-image]") as HTMLImageElement,
      cutoutPreviewMeta: pick("[data-bind=cutout-preview-meta]"),
      cutoutPreviewReset: pick("[data-action=cutout-preview-reset]"),
      cutoutPreviewCancel: pick("[data-action=cutout-preview-cancel]"),
      cutoutPreviewContinue: pick("[data-action=cutout-preview-continue]"),
      aboutLabel: pick("[data-bind=about-label]"),
      aboutName: pick("[data-bind=about-name]"),
      aboutVersion: pick("[data-bind=about-version]"),
      aboutTagline: pick("[data-bind=about-tagline]"),
      aboutDesc: pick("[data-bind=about-desc]"),
      aboutMeta: pick("[data-bind=about-meta]"),
      resourcesLabel: pick("[data-bind=resources-label]"),
      checkUpdatesBtn: pick("[data-action=check-updates]"),
      checkUpdatesIcon: pick("[data-bind=check-updates-icon]"),
      checkUpdatesLabel: pick("[data-bind=check-updates-label]"),
      downloadUpdateBtn: pick("[data-action=download-update]"),
      downloadUpdateLabel: pick("[data-bind=download-update-label]"),
      updateStatus: pick("[data-bind=update-status]"),
      updateStatusIcon: pick("[data-bind=update-status-icon]"),
      updateStatusText: pick("[data-bind=update-status-text]"),
      updateBanner: pick("[data-bind=update-banner]"),
      updateBannerTitle: pick("[data-bind=update-banner-title]"),
      updateBannerBody: pick("[data-bind=update-banner-body]"),
      updateDownloadProgress: pick("[data-bind=update-download-progress]"),
      updateDownloadProgressBar: pick("[data-bind=update-download-progress-bar]"),
      updateBannerDownloadLabel: pick("[data-bind=update-banner-download-label]"),
      updateBannerDismissBtn: pick("[data-action=dismiss-update-banner]"),
      linkGithub: pick("[data-bind=link-github]"),
      linkReleases: pick("[data-bind=link-releases]"),
      linkIssues: pick("[data-bind=link-issues]"),
      linkLicense: pick("[data-bind=link-license]"),
      perspectiveScene: pick(".perspective-scene"),
      perspectiveGridFar: pick(".perspective-grid--far"),
      perspectiveGridNear: pick(".perspective-grid--near"),
      perspectiveGlow: pick(".perspective-glow"),
      viewportBg: pick(".viewport-bg"),
      toast: pick("[data-bind=toast]"),
      toastIcon: pick("[data-bind=toast-icon]"),
      toastText: pick("[data-bind=toast-text]"),
      clearConfirmPop: pick("[data-bind=clear-confirm]"),
      clearConfirmMessage: pick("[data-bind=clear-confirm-message]"),
      clearConfirmCancel: pick("[data-action=clear-library-cancel]"),
      clearConfirmOk: pick("[data-action=clear-library-confirm]"),
    };

    this.viewport = new ModelViewport(this.els.viewportHost);
    this.cutoutFrameGuide = new CutoutFrameGuide(this.els.viewportHost, {
      getModelViewer: () => (this.phase === "ready" ? this.viewport.element : null),
    });
    this.cutoutFrameGuide.bind();
    this.cutoutPreviewPanel = new CutoutPreviewPanel({
      backdrop: this.els.cutoutBackdrop,
      panel: this.els.cutoutPreviewPanel,
      header: this.els.cutoutPreviewHeader,
      stage: this.els.cutoutPreviewStage,
      viewport: this.els.cutoutPreviewViewport,
      image: this.els.cutoutPreviewImage as HTMLImageElement,
      resizeHandle: this.els.cutoutPreviewResize,
      resetButton: this.els.cutoutPreviewReset,
      meta: this.els.cutoutPreviewMeta,
    });
    this.cutoutPreviewPanel.bind();
    this.axisWidget = new AxisOrientationWidget(this.els.axisWidget, () => this.viewport.element);
    this.libraryMenu = new LibraryContextMenu(this.shell);
    this.libraryMenu.setHandler((action, ctx) => {
      if (action === "show-in-folder" && ctx.revealPath) {
        void revealModelInFolder(ctx.revealPath);
        return;
      }
      if (action === "refresh-folder" && ctx.folderDir) {
        void this.refreshFolder(ctx.folderDir);
        return;
      }
      if (action === "refresh-library") {
        void this.refreshLibrary();
      }
    });
    this.viewport.attachWheelSurface(this.els.viewportMain);
    this.bind();
    this.bindCinemaIdleResume();
    this.bindCinemaChromeIdle();
    this.bindParallax();
    window.addEventListener("resize", () => this.scheduleFramingInsets(), { passive: true });
    window.addEventListener(
      "resize",
      () => {
        if (!this.cacheConfirmOpen || !this.settingsOpen) return;
        this.cacheConfirmOpen = false;
        this.paintCacheSection();
      },
      { passive: true },
    );
  }

  async start(): Promise<void> {
    let bundle = await getUiBundle();
    const storedTheme = loadStoredThemePref();
    if (storedTheme !== bundle.theme_pref) {
      bundle = await setThemePreference(storedTheme);
    }
    this.ui = bundle;
    try {
      this.appInfo = await getAppInfo();
    } catch {
      this.appInfo = fallbackAppInfo();
    }
    initTheme(bundle);
    watchSystemTheme(() => this.ui.theme_pref as ThemePref, () => this.onThemeResolved());
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
      void this.handleExternalOpen(e.payload);
    });
    const pendingOpens = await completeStartup();
    for (const path of pendingOpens) {
      await this.handleExternalOpen(path);
    }
    document.addEventListener("keydown", (e) => this.onKey(e));
    this.paint();
    void this.checkForUpdatesOnStartup();
  }

  private bindSettingsActions(): void {
    const bind = (action: string, handler: () => void) => {
      for (const el of this.shell.querySelectorAll<HTMLElement>(`[data-action="${action}"]`)) {
        if (el.closest(".settings-panel") === null) continue;
        el.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          handler();
        });
      }
    };

    bind("check-updates", () => void this.handleCheckUpdates(false));
    bind("download-update", () => void this.downloadUpdateInApp());
    bind("open-github", () => void this.openRepository());
    bind("open-releases", () => void this.openReleaseNotes());
    bind("open-issues", () => void this.openIssueTracker());
    bind("open-license", () => void this.openLicense());
    bind("clear-cache", () => {
      if ((this.els.clearCacheBtn as HTMLButtonElement).disabled) return;
      this.dismissExplorerPopovers();
      this.cacheConfirmOpen = !this.cacheConfirmOpen;
      this.paintCacheSection();
    });

    this.els.cacheClearConfirm.addEventListener("click", (e) => e.stopPropagation());
    this.els.cacheClearConfirmCancel.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.cacheConfirmOpen = false;
      this.paintCacheSection();
    });
    this.els.cacheClearConfirmOk.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void this.performClearCache();
    });

    this.els.shortcutsList.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const edit = target.closest<HTMLElement>("[data-action=edit-shortcut]");
      if (edit?.dataset.shortcutId) {
        e.preventDefault();
        this.startShortcutRecording(edit.dataset.shortcutId as ShortcutId);
        return;
      }
      const restore = target.closest<HTMLElement>("[data-action=restore-shortcut]");
      if (restore?.dataset.shortcutId) {
        e.preventDefault();
        this.shortcuts.reset(restore.dataset.shortcutId as ShortcutId);
        this.shortcutRecording = null;
        this.paintShortcutsSection();
      }
    });
    bind("reset-shortcuts", () => {
      this.shortcuts.resetAll();
      this.shortcutRecording = null;
      this.paintShortcutsSection();
    });
  }

  private appMeta(): AppInfo {
    return this.appInfo ?? fallbackAppInfo();
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
        this.openSettings();
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
      case "check-updates":
        this.openSettings();
        void this.handleCheckUpdates(true);
        break;
      case "release-notes":
        void this.openReleaseNotes();
        break;
      case "view-github":
        void this.openRepository();
        break;
      case "report-issue":
        void this.openIssueTracker();
        break;
      default:
        break;
    }
  }

  private bind(): void {
    this.els.sidebarOpenFile.addEventListener("click", () => void this.pickFile());
    this.els.sidebarOpenFolder.addEventListener("click", () => void this.pickFolder());
    this.els.settingsBtn.addEventListener("click", () => {
      this.openSettings();
    });
    this.els.settingsPanel.addEventListener("click", (e) => {
      if (this.cacheConfirmOpen) {
        const target = e.target as HTMLElement;
        if (
          !target.closest("[data-bind=cache-clear-confirm]") &&
          !target.closest("[data-action=clear-cache]")
        ) {
          this.cacheConfirmOpen = false;
          this.paintCacheSection();
        }
      }
      e.stopPropagation();
    });
    this.els.settingsBody.addEventListener(
      "scroll",
      () => {
        if (!this.cacheConfirmOpen) return;
        this.cacheConfirmOpen = false;
        this.paintCacheSection();
      },
      { passive: true },
    );
    this.els.settingsBackdrop.addEventListener("click", (e) => {
      if (this.cacheConfirmOpen) {
        const target = e.target as HTMLElement;
        if (
          !target.closest("[data-bind=cache-clear-confirm]") &&
          !target.closest("[data-action=clear-cache]")
        ) {
          this.cacheConfirmOpen = false;
          this.paintCacheSection();
        }
      }
      if ((e.target as HTMLElement) === this.els.settingsBackdrop) {
        this.settingsOpen = false;
        this.cacheConfirmOpen = false;
        this.cacheSizeFetchedForSettings = false;
        this.shortcutRecording = null;
        this.paint();
      }
    });
    this.els.closeSettings.addEventListener("click", () => {
      this.settingsOpen = false;
      this.cacheConfirmOpen = false;
      this.cacheSizeFetchedForSettings = false;
      this.shortcutRecording = null;
      this.paint();
    });
    this.bindSettingsActions();

    this.els.updateBannerDismissBtn?.addEventListener("click", () => this.dismissUpdateBanner());
    for (const el of this.shell.querySelectorAll<HTMLElement>('[data-action="download-update-in-app"]')) {
      el.addEventListener("click", (e) => {
        e.preventDefault();
        void this.downloadUpdateInApp();
      });
    }

    this.els.viewportHost.addEventListener("dblclick", () => {
      if (this.phase === "ready") void this.fitView();
    });

    this.els.overlay.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-action=dismiss-error]");
      if (!btn) return;
      e.preventDefault();
      this.dismissError();
    });

    this.els.toolZoomIn.addEventListener("click", () => {
      this.viewport.zoomIn();
      this.viewport.focus();
    });
    this.els.toolZoomOut.addEventListener("click", () => {
      this.viewport.zoomOut();
      this.viewport.focus();
    });
    this.els.toolFitView.addEventListener("click", () => {
      void this.fitView();
      this.viewport.focus();
    });
    this.els.toolResetView.addEventListener("click", () => {
      this.resetView();
      this.viewport.focus();
    });
    this.els.toolToggleCutout.addEventListener("click", () => {
      this.toggleCutoutMode();
      this.viewport.focus();
    });
    this.els.cutoutRunBtn.addEventListener("click", () => {
      void this.beginCutoutExport();
      this.viewport.focus();
    });

    for (const action of ["close-cutout-flow", "cutout-preview-cancel"] as const) {
      this.shell.querySelectorAll(`[data-action=${action}]`).forEach((node) => {
        node.addEventListener("click", () => this.closeCutoutFlow());
      });
    }
    this.els.cutoutPreviewContinue.addEventListener("click", () => {
      void this.saveCutoutWithDialog();
    });
    this.els.toolCinema.addEventListener("click", () => {
      this.setCinemaMode(!this.cinemaMode);
      this.viewport.focus();
    });
    this.els.toolPreviewGrid.addEventListener("click", () => {
      this.sceneOptions.toggle("previewGrid");
      this.applySceneOptions();
      this.paint();
      this.viewport.focus();
    });
    this.els.toolSceneGuides.addEventListener("click", () => {
      this.sceneOptions.toggle("showGuides");
      this.applySceneOptions();
      if (this.settingsOpen) this.syncSceneSettingsUi();
      this.paint();
      this.viewport.focus();
    });
    this.els.sceneOptionsList.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-scene-option]");
      if (!btn) return;
      const key = btn.dataset.sceneOption as keyof SceneGuideOptions | undefined;
      if (!key) return;
      this.sceneOptions.toggle(key);
      this.applySceneOptions();
      if (this.settingsOpen) this.syncSceneSettingsUi();
      this.paint();
    });
    this.els.updateSettingsList.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-update-setting]");
      if (!btn) return;
      const key = btn.dataset.updateSetting;
      if (key !== "autoCheckOnStartup") return;
      this.updatePreferences.toggleAutoCheckOnStartup();
      this.syncUpdateSettingsUi();
    });
    this.els.cinemaExit.addEventListener("click", () => {
      this.setCinemaChromeIdle(false);
      this.setCinemaMode(false);
      this.viewport.focus();
    });
    this.els.cinemaToggleRotate.addEventListener("click", () => {
      this.setCinemaChromeIdle(false);
      this.scheduleCinemaChromeHide();
      this.toggleCinemaRotatePause();
      this.viewport.focus();
    });
    this.els.expandInspector.addEventListener("click", () => {
      if (this.inspectorCollapsed) {
        this.inspectorCollapsed = false;
        this.inspectorHiddenAfterError = false;
        this.paint();
      }
    });
    this.els.toggleLibrary.addEventListener("click", () => this.toggleExplorerCollapsed());
    this.els.clearLibrary.addEventListener("click", (e) => {
      e.stopPropagation();
      this.dismissExplorerPopovers({ clearConfirm: true });
      this.clearConfirmOpen = !this.clearConfirmOpen;
      this.paint();
    });
    this.els.clearConfirmCancel.addEventListener("click", (e) => {
      e.stopPropagation();
      this.dismissExplorerPopovers();
    });
    this.els.clearConfirmOk.addEventListener("click", (e) => {
      e.stopPropagation();
      this.performClearLibrary();
    });
    document.addEventListener("click", () => {
      if (this.clearConfirmOpen) {
        this.dismissExplorerPopovers();
        return;
      }
      this.libraryMenu.hide();
      if (this.cacheConfirmOpen) {
        this.cacheConfirmOpen = false;
        this.paintCacheSection();
      }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (this.clearConfirmOpen) {
        this.dismissExplorerPopovers();
        return;
      }
      this.libraryMenu.hide();
      if (this.cacheConfirmOpen && this.settingsOpen) {
        this.cacheConfirmOpen = false;
        this.paintCacheSection();
      }
    });
    this.els.clearConfirmPop.addEventListener("click", (e) => e.stopPropagation());
    this.els.collapseExplorer.addEventListener("click", () => this.toggleExplorerCollapsed());
    this.els.collapseInspector.addEventListener("click", () => this.toggleInspectorCollapsed());

    this.els.sidebarBody.addEventListener("contextmenu", (e) => {
      if (this.libraryRefreshing) return;
      const target = e.target as HTMLElement;
      if (!this.els.sidebarBody.contains(target)) return;
      e.preventDefault();

      this.dismissExplorerPopovers();

      const menuCtx = resolveLibraryMenuContext(target);
      const canRefreshLibrary = this.libraryRoots.length > 0;
      if (!menuCtx.folderDir && !menuCtx.revealPath && !canRefreshLibrary) return;

      this.libraryMenu.show({
        ui: this.ui,
        x: e.clientX,
        y: e.clientY,
        folderDir: menuCtx.folderDir,
        revealPath: menuCtx.revealPath,
        canRefreshLibrary,
      });
    });
    this.els.sidebarBody.addEventListener("scroll", () => this.libraryMenu.hide(), {
      passive: true,
    });

    this.els.sidebarBody.addEventListener("click", (e) => {
      this.dismissExplorerPopovers();

      const target = e.target as HTMLElement;

      const toggleFolder = target.closest<HTMLElement>("[data-action=toggle-folder]");
      if (toggleFolder?.dataset.folderKey) {
        e.preventDefault();
        this.toggleFolderCollapsed(toggleFolder.dataset.folderKey);
        return;
      }

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
        this.onThemeResolved();
        this.syncThemeSegmentsActive();
        this.paint();
      });
    });
  }

  private bindParallax(): void {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const scene = this.els.perspectiveScene;
    const layerFar = this.els.perspectiveGridFar;
    const layerNear = this.els.perspectiveGridNear;
    const glow = this.els.perspectiveGlow;
    const viewportBg = this.els.viewportBg;
    if (!scene || !layerFar || !layerNear || !glow || !viewportBg) return;

    const target = { x: 0, y: 0 };
    const current = { x: 0, y: 0 };
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let ticking = false;
    let dormant = false;
    const epsilon = 0.0008;

    const applyParallax = (): void => {
      const tiltX = 61 + current.y * -1.6;
      const driftX = current.x * 22;
      const driftZ = current.y * 12;
      const glowX = 50 + current.x * 14;
      const glowY = 70 + current.y * 6;

      scene.style.perspectiveOrigin = `${50 + current.x * 7}% ${30 + current.y * 5}%`;
      glow.style.setProperty("--grid-glow-x", `${glowX}%`);
      glow.style.setProperty("--grid-glow-y", `${glowY}%`);

      layerNear.style.transform =
        `rotateX(${tiltX}deg) rotateZ(${current.x * -0.7}deg) translate3d(${driftX}px, -150px, ${driftZ}px)`;
      layerFar.style.transform =
        `rotateX(${tiltX}deg) rotateZ(${current.x * -0.35}deg) translate3d(${driftX * 0.4}px, -150px, ${driftZ * 0.4 - 70}px)`;
    };

    const needsTick = (): boolean =>
      Math.abs(target.x - current.x) > epsilon || Math.abs(target.y - current.y) > epsilon;

    const tick = (): void => {
      ticking = false;
      current.x += (target.x - current.x) * 0.07;
      current.y += (target.y - current.y) * 0.07;
      applyParallax();
      if (needsTick()) scheduleTick();
    };

    const scheduleTick = (): void => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(tick);
    };

    const markActive = (): void => {
      viewportBg.classList.remove("is-grid-idle");
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => viewportBg.classList.add("is-grid-idle"), 2200);
    };

    const onMove = (e: MouseEvent): void => {
      if (dormant) return;
      target.x = e.clientX / window.innerWidth - 0.5;
      target.y = e.clientY / window.innerHeight - 0.5;
      markActive();
      scheduleTick();
    };

    this.setGridParallaxDormant = (next: boolean): void => {
      if (dormant === next) return;
      dormant = next;
      viewportBg.classList.toggle("is-grid-dormant", next);
      if (next) {
        target.x = 0;
        target.y = 0;
        viewportBg.classList.add("is-grid-idle");
        if (idleTimer) clearTimeout(idleTimer);
        scheduleTick();
      }
    };

    window.addEventListener("mousemove", onMove, { passive: true });
    viewportBg.classList.add("is-grid-idle");
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
    this.els.shortcutsLabel.textContent = this.ui.settings_shortcuts;
    this.els.shortcutsResetAllLabel.textContent = this.ui.shortcuts_reset_all;
    this.els.shortcutsResetAll.title = this.ui.shortcuts_reset_all;
    this.els.shortcutsResetAll.setAttribute("aria-label", this.ui.shortcuts_reset_all);
    this.els.sceneLabel.textContent = this.ui.settings_viewer_scene;
    this.paintSceneSettings(true);
    this.els.updatesLabel.textContent = this.ui.settings_updates;
    this.paintUpdateSettings(true);
    this.els.storageLabel.textContent = this.ui.settings_storage;
    this.els.cacheTitle.textContent = this.ui.clear_cache_title;
    this.els.cacheHint.textContent = this.ui.clear_cache_hint;
    this.els.clearCacheLabel.textContent = this.ui.clear_cache;
    this.paintCacheSection(true);
    this.els.aboutLabel.textContent = this.ui.settings_about;
    this.els.resourcesLabel.textContent = this.ui.settings_resources;
    this.els.checkUpdatesLabel.textContent = this.ui.check_for_updates;
    this.els.downloadUpdateLabel.textContent = this.ui.download_update;
    this.els.updateBannerDownloadLabel.textContent = this.ui.download_update;
    this.els.updateBannerDismissBtn?.setAttribute("aria-label", this.ui.update_dismiss);
    this.paintUpdateBanner();
    this.els.linkGithub.textContent = this.ui.view_on_github;
    this.els.linkReleases.textContent = this.ui.view_release_notes;
    this.els.linkIssues.textContent = this.ui.report_issue;
    this.els.linkLicense.textContent = this.ui.license_mit;
    this.paintShortcutsSection();
    this.paintAboutSection();
    this.els.toolZoomOut.title = this.ui.tool_zoom_out;
    this.els.toolZoomOut.setAttribute("aria-label", this.ui.tool_zoom_out);
    this.els.toolZoomIn.title = this.ui.tool_zoom_in;
    this.els.toolZoomIn.setAttribute("aria-label", this.ui.tool_zoom_in);
    this.els.toolFitView.title = this.ui.tool_fit_view;
    this.els.toolFitView.setAttribute("aria-label", this.ui.tool_fit_view);
    this.els.toolResetView.title = this.ui.tool_reset_view;
    this.els.toolResetView.setAttribute("aria-label", this.ui.tool_reset_view);
    this.els.toolToggleCutout.title = this.ui.tool_export_cutout;
    this.els.toolToggleCutout.setAttribute("aria-label", this.ui.tool_export_cutout);
    this.els.cutoutRunLabel.textContent = this.ui.cutout_create;
    this.els.cutoutRunBtn.setAttribute("aria-label", this.ui.cutout_create);
    this.els.cutoutPreviewTitle.textContent = this.ui.cutout_preview_title;
    this.els.cutoutPreviewReset.title = this.ui.tool_reset_view;
    this.els.cutoutPreviewReset.setAttribute("aria-label", this.ui.tool_reset_view);
    this.els.cutoutPreviewCancel.textContent = this.ui.cancel;
    this.els.cutoutPreviewContinue.textContent = this.ui.cutout_save_title;
    for (const btn of this.shell.querySelectorAll<HTMLElement>("[data-action=close-cutout-flow]")) {
      btn.setAttribute("aria-label", this.ui.cancel);
    }
    this.els.toolCinema.title = this.ui.tool_cinema;
    this.els.toolCinema.setAttribute("aria-label", this.ui.tool_cinema);
    this.els.toolPreviewGrid.title = this.ui.tool_preview_grid;
    this.els.toolPreviewGrid.setAttribute("aria-label", this.ui.tool_preview_grid);
    this.els.toolSceneGuides.title = this.ui.tool_scene_guides;
    this.els.toolSceneGuides.setAttribute("aria-label", this.ui.tool_scene_guides);
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
    if (this.phase === "error" && this.loadFailure) {
      this.refreshLoadFailureStatus();
    }
  }

  private refreshLoadFailureStatus(): void {
    if (!this.loadFailure) return;
    this.status = resolveLoadFailureMessage(
      this.ui,
      this.loadFailure.path,
      new Error(this.loadFailure.raw),
      this.loadFailure.viewerPath,
      (p) => this.modelFileSizeForPath(p),
    );
    delete this.els.overlay.dataset.overlayKind;
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
    if (this.shortcutRecording) {
      this.handleShortcutRecord(e);
      return;
    }

    if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      if (this.cutoutFlowOpen()) {
        e.preventDefault();
        this.closeCutoutFlow();
        return;
      }
      if (this.cutoutMode) {
        e.preventDefault();
        this.setCutoutMode(false);
        return;
      }
    }

    if (
      e.key === "Escape" &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.shiftKey &&
      this.phase === "error" &&
      !this.settingsOpen &&
      !this.cacheConfirmOpen &&
      !this.clearConfirmOpen
    ) {
      e.preventDefault();
      this.dismissError();
      return;
    }

    const action = this.shortcuts.match(e);
    if (!action) return;

    if (action === "close_settings") {
      e.preventDefault();
      if (this.cinemaMode) {
        this.setCinemaMode(false);
        return;
      }
      if (this.clearConfirmOpen) {
        this.dismissExplorerPopovers();
        return;
      }
      if (this.cacheConfirmOpen) {
        this.cacheConfirmOpen = false;
        this.paintCacheSection();
        return;
      }
      if (this.settingsOpen) {
        this.settingsOpen = false;
        this.paint();
      }
      return;
    }

    if (this.runShortcut(action)) e.preventDefault();
  }

  private runShortcut(action: ShortcutId): boolean {
    switch (action) {
      case "open_file":
        void this.pickFile();
        return true;
      case "open_folder":
        void this.pickFolder();
        return true;
      case "settings":
        this.openSettings();
        return true;
      case "zoom_in":
        if (this.phase !== "ready") return false;
        this.viewport.zoomIn();
        return true;
      case "zoom_out":
        if (this.phase !== "ready") return false;
        this.viewport.zoomOut();
        return true;
      case "fit_view":
        if (this.phase !== "ready") return false;
        void this.fitView();
        return true;
      case "reset_view":
        if (this.phase !== "ready") return false;
        this.resetView();
        return true;
      case "cinema_mode":
        if (this.phase !== "ready") return false;
        this.setCinemaMode(!this.cinemaMode);
        return true;
      default:
        return false;
    }
  }

  private startShortcutRecording(id: ShortcutId): void {
    this.shortcutRecording = id;
    this.paintShortcutsSection();
  }

  private handleShortcutRecord(e: KeyboardEvent): void {
    e.preventDefault();
    e.stopPropagation();
    const id = this.shortcutRecording;
    if (!id) return;

    if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      this.shortcutRecording = null;
      this.paintShortcutsSection();
      return;
    }

    const binding = bindingFromEvent(e);
    if (!binding) return;

    if (this.shortcuts.setBinding(id, binding)) {
      this.shortcutRecording = null;
      this.paintShortcutsSection();
      return;
    }
    this.showToast(this.ui.shortcuts_conflict);
  }

  private paintShortcutsSection(): void {
    const copy = {
      section: this.ui.settings_shortcuts,
      categoryGeneral: this.ui.shortcuts_category_general,
      categoryViewer: this.ui.shortcuts_category_viewer,
      pressKeys: this.ui.shortcuts_press_keys,
      resetAll: this.ui.shortcuts_reset_all,
      restore: this.ui.shortcuts_restore,
      doubleClickFit: this.ui.shortcuts_double_click_fit,
    };
    this.els.shortcutsList.innerHTML = renderShortcutsSettings(
      this.ui,
      copy,
      this.shortcuts,
      this.shortcutRecording,
    );
  }

  private syncSceneSettingsUi(opts: SceneGuideOptions = this.sceneOptions.get()): void {
    for (const btn of this.els.sceneOptionsList.querySelectorAll<HTMLElement>(
      "[data-scene-option]",
    )) {
      const key = btn.dataset.sceneOption as keyof SceneGuideOptions | undefined;
      if (!key) continue;
      btn.setAttribute("aria-checked", opts[key] ? "true" : "false");
    }
  }

  private paintSceneSettings(rebuild = false): void {
    const opts = this.sceneOptions.get();
    if (!rebuild && this.els.sceneOptionsList.querySelector("[data-scene-option]")) {
      this.syncSceneSettingsUi(opts);
      return;
    }
    const rows: { key: keyof SceneGuideOptions; label: string; icon: string }[] = [
      { key: "previewGrid", label: this.ui.scene_preview_grid, icon: "grid_on" },
      { key: "showGuides", label: this.ui.scene_guides, icon: "open_with" },
    ];
    this.els.sceneOptionsList.innerHTML = rows
      .map(({ key, label, icon }) => {
        const on = opts[key];
        return `
          <button
            type="button"
            class="settings-scene-row"
            data-scene-option="${key}"
            role="switch"
            aria-checked="${on ? "true" : "false"}"
            title="${escapeAttr(label)}"
            aria-label="${escapeAttr(label)}"
          >
            <span class="settings-scene-row-label">
              <span class="material-symbols-outlined settings-scene-row-icon" aria-hidden="true">${icon}</span>
              <span class="settings-scene-row-text">${escapeHtml(label)}</span>
            </span>
            <span class="settings-scene-row-actions">
              <span class="settings-scene-switch" aria-hidden="true">
                <span class="settings-scene-switch-knob"></span>
              </span>
            </span>
          </button>`;
      })
      .join("");
  }

  private paintUpdateSettings(rebuild = false): void {
    const opts = this.updatePreferences.get();
    if (!rebuild && this.els.updateSettingsList.querySelector("[data-update-setting]")) {
      this.syncUpdateSettingsUi(opts);
      return;
    }
    const label = this.ui.auto_check_updates_on_launch;
    const on = opts.autoCheckOnStartup;
    this.els.updateSettingsList.innerHTML = `
      <button
        type="button"
        class="settings-scene-row"
        data-update-setting="autoCheckOnStartup"
        role="switch"
        aria-checked="${on ? "true" : "false"}"
        title="${escapeAttr(label)}"
        aria-label="${escapeAttr(label)}"
      >
        <span class="settings-scene-row-label">
          <span class="material-symbols-outlined settings-scene-row-icon" aria-hidden="true">update</span>
          <span class="settings-scene-row-text">${escapeHtml(label)}</span>
        </span>
        <span class="settings-scene-row-actions">
          <span class="settings-scene-switch" aria-hidden="true">
            <span class="settings-scene-switch-knob"></span>
          </span>
        </span>
      </button>`;
  }

  private syncUpdateSettingsUi(
    opts: ReturnType<UpdatePreferencesStore["get"]> = this.updatePreferences.get(),
  ): void {
    for (const btn of this.els.updateSettingsList.querySelectorAll<HTMLElement>(
      "[data-update-setting]",
    )) {
      if (btn.dataset.updateSetting !== "autoCheckOnStartup") continue;
      btn.setAttribute("aria-checked", opts.autoCheckOnStartup ? "true" : "false");
    }
  }

  private positionCacheClearConfirm(): void {
    const pop = this.els.cacheClearConfirm;
    const btn = this.els.clearCacheBtn;
    const pad = 8;
    const gap = 6;

    const apply = (): void => {
      pop.style.visibility = "hidden";
      pop.classList.remove("hidden");

      const btnRect = btn.getBoundingClientRect();
      const panelRect = this.els.settingsPanel.getBoundingClientRect();
      const popRect = pop.getBoundingClientRect();
      const width = popRect.width || 184;
      const height = popRect.height || 72;

      let top = btnRect.bottom + gap;
      if (top + height > window.innerHeight - pad) {
        top = Math.max(pad, btnRect.top - height - gap);
      }

      let left = btnRect.left + (btnRect.width - width) / 2;
      const minLeft = Math.max(pad, panelRect.left + pad);
      const maxLeft = Math.min(window.innerWidth - width - pad, panelRect.right - width - pad);
      left = Math.max(minLeft, Math.min(left, maxLeft));

      pop.style.top = `${top}px`;
      pop.style.left = `${left}px`;
      pop.style.visibility = "";
    };

    apply();
  }

  /** Close library context menu and optional clear-library confirm. */
  private dismissExplorerPopovers(keep?: { clearConfirm?: boolean }): void {
    this.libraryMenu.hide();
    if (keep?.clearConfirm || !this.clearConfirmOpen) return;
    this.clearConfirmOpen = false;
    this.syncLibraryClearPop();
    this.els.clearLibrary.classList.remove("is-active");
  }

  private openSettings(): void {
    this.dismissExplorerPopovers();
    this.settingsOpen = true;
    this.paint();
  }

  private syncFadePop(opts: {
    open: boolean;
    pop: HTMLElement;
    isShown: () => boolean;
    markShown: (value: boolean) => void;
    timer: () => ReturnType<typeof setTimeout> | null;
    setTimer: (value: ReturnType<typeof setTimeout> | null) => void;
    prepareOpen?: () => void;
    resetClosed?: () => void;
  }): void {
    const { open, pop, isShown, markShown, timer, setTimer, prepareOpen, resetClosed } = opts;

    if (open) {
      const pending = timer();
      if (pending) {
        clearTimeout(pending);
        setTimer(null);
      }

      const wasVisible = isShown() && pop.classList.contains("is-visible");
      markShown(true);
      pop.classList.remove("hidden");
      prepareOpen?.();
      if (wasVisible) return;

      requestAnimationFrame(() => {
        pop.classList.add("is-visible");
      });
      return;
    }

    if (!isShown() || timer()) return;

    pop.classList.remove("is-visible");
    setTimer(
      setTimeout(() => {
        pop.classList.add("hidden");
        resetClosed?.();
        markShown(false);
        setTimer(null);
      }, App.POP_MOTION_MS),
    );
  }

  private syncLibraryClearPop(): void {
    this.syncFadePop({
      open: this.clearConfirmOpen,
      pop: this.els.clearConfirmPop,
      isShown: () => this.libraryClearPopShown,
      markShown: (value) => {
        this.libraryClearPopShown = value;
      },
      timer: () => this.libraryClearPopTimer,
      setTimer: (value) => {
        this.libraryClearPopTimer = value;
      },
      prepareOpen: () => {
        this.els.clearConfirmMessage.textContent = this.ui.clear_library_confirm;
        this.els.clearConfirmCancel.textContent = this.ui.cancel;
        this.els.clearConfirmOk.textContent = this.ui.clear_library;
      },
    });
  }

  private syncCacheClearPop(): void {
    this.syncFadePop({
      open: this.cacheConfirmOpen && this.settingsOpen,
      pop: this.els.cacheClearConfirm,
      isShown: () => this.cacheClearPopShown,
      markShown: (value) => {
        this.cacheClearPopShown = value;
      },
      timer: () => this.cacheClearPopTimer,
      setTimer: (value) => {
        this.cacheClearPopTimer = value;
      },
      prepareOpen: () => {
        this.els.cacheClearConfirmMessage.textContent = this.ui.clear_cache_confirm;
        this.els.cacheClearConfirmCancel.textContent = this.ui.cancel;
        this.els.cacheClearConfirmOk.textContent = this.ui.clear_cache;
        this.positionCacheClearConfirm();
      },
      resetClosed: () => {
        this.els.cacheClearConfirm.style.top = "";
        this.els.cacheClearConfirm.style.left = "";
        this.els.cacheClearConfirm.style.visibility = "";
      },
    });
  }

  private paintCacheSection(force = false): void {
    this.syncCacheClearPop();
    const popOpen = this.cacheConfirmOpen && this.settingsOpen;
    this.els.clearCacheBtn.classList.toggle("is-active", popOpen);
    this.els.clearCacheBtn.setAttribute("aria-expanded", popOpen ? "true" : "false");

    if (!force && !this.settingsOpen) return;
    const bytes = this.viewerCacheBytes;
    const sizeEl = this.els.cacheSize;
    sizeEl.textContent =
      bytes === null ? "…" : bytes === 0 ? "0 B" : formatBytes(bytes, this.ui);
    sizeEl.classList.toggle("is-empty", bytes === 0);
    sizeEl.classList.toggle("is-loading", bytes === null);

    const btn = this.els.clearCacheBtn as HTMLButtonElement;
    const empty = bytes === 0;
    btn.disabled = empty || this.cacheClearing || bytes === null;
    btn.classList.toggle("is-loading", this.cacheClearing);
  }

  private async refreshViewerCacheSize(): Promise<void> {
    try {
      this.viewerCacheBytes = await viewerCacheSize();
    } catch {
      this.viewerCacheBytes = 0;
    }
    this.paintCacheSection();
  }

  private async performClearCache(): Promise<void> {
    if (this.cacheClearing) return;
    this.cacheClearing = true;
    this.cacheConfirmOpen = false;
    this.paintCacheSection();
    try {
      const result = await clearViewerCache();
      this.viewerCacheBytes = 0;
      const message =
        result.bytes_cleared > 0
          ? this.ui.clear_cache_success.replace(
              "{size}",
              formatBytes(result.bytes_cleared, this.ui),
            )
          : this.ui.clear_cache_empty;
      this.showToast(message, result.bytes_cleared > 0 ? "success" : "default");
    } catch {
      this.showToast(this.ui.clear_cache_failed, "error");
      void this.refreshViewerCacheSize();
    } finally {
      this.cacheClearing = false;
      this.paintCacheSection();
    }
  }

  private applySceneOptions(force = false): void {
    if (this.phase !== "ready") return;
    this.viewport.syncSceneGuides(this.sceneOptions.get(), force);
  }

  private syncSceneGuidesAfterModelReady(): void {
    this.sceneGuidesSyncedForReady = false;
    this.applySceneOptions(true);
    this.sceneGuidesSyncedForReady = true;
  }

  private setCutoutMode(enabled: boolean): void {
    if (this.cutoutMode === enabled) return;
    if (enabled) {
      this.cutoutPanelsSnapshot = {
        explorer: this.explorerCollapsed,
        inspector: this.inspectorCollapsed,
      };
      this.explorerCollapsed = true;
      this.inspectorCollapsed = true;
    } else {
      if (this.cutoutPanelsSnapshot) {
        this.explorerCollapsed = this.cutoutPanelsSnapshot.explorer;
        this.inspectorCollapsed = this.cutoutPanelsSnapshot.inspector;
        this.cutoutPanelsSnapshot = null;
      }
      this.closeCutoutFlow();
      this.cutoutFrameGuide.cancelSchedule();
      this.cutoutFrameGuide.setVisible(false);
      this.cutoutFrameGuideShown = false;
    }
    this.cutoutMode = enabled;
    this.paintCutoutModeUi();
    if (!enabled && this.phase === "ready") {
      this.resetView();
      this.applySceneOptions(true);
    }
    this.paint();
  }

  private toggleCutoutMode(): void {
    if (this.phase !== "ready") {
      this.showToast(this.ui.cutout_no_model);
      return;
    }
    this.setCutoutMode(!this.cutoutMode);
  }

  private paintCutoutModeUi(): void {
    const active = this.cutoutMode && this.phase === "ready";
    this.shell.classList.toggle("is-cutout-mode", active);
    this.els.toolToggleCutout.classList.toggle("is-active", active);
    const showFrame =
      this.cutoutMode &&
      this.phase === "ready" &&
      !this.cutoutFlowOpen() &&
      !this.cutoutExporting;
    if (showFrame !== this.cutoutFrameGuideShown) {
      this.cutoutFrameGuideShown = showFrame;
      this.cutoutFrameGuide.setVisible(showFrame);
    }
  }

  private onThemeResolved(): void {
    invalidateSceneThemeCache();
    this.applySceneOptions(true);
  }

  private cutoutDefaultFilename(): string {
    if (!this.activePath) return "cutout.png";
    const base = this.activePath.split(/[/\\]/).pop() ?? "model";
    const stem = base.replace(/\.[^.]+$/, "");
    return `${stem}-cutout.png`;
  }

  private cutoutFlowOpen(): boolean {
    return this.cutoutPreviewOpen;
  }

  private closeCutoutFlow(): void {
    revokePngObjectUrl(this.cutoutPreviewUrl);
    this.cutoutPreviewUrl = null;
    this.cutoutPendingBytes = null;
    this.cutoutPreviewOpen = false;
    this.cutoutPreviewPanel.reset();
    this.paintCutoutModals();
    this.paintCutoutModeUi();
  }

  private paintCutoutModals(): void {
    const open = this.cutoutFlowOpen();
    this.els.cutoutBackdrop.classList.toggle("hidden", !open);
    this.els.cutoutPreviewPanel.classList.toggle("hidden", !this.cutoutPreviewOpen);
    if (this.cutoutPreviewOpen && this.cutoutPreviewUrl) {
      this.cutoutPreviewPanel.show(this.cutoutPreviewUrl);
    }
  }

  private async beginCutoutExport(): Promise<void> {
    if (this.cutoutExporting) return;
    if (this.phase !== "ready" || !this.cutoutMode) {
      this.showToast(this.ui.cutout_no_model);
      return;
    }

    this.cutoutExporting = true;
    this.cutoutFrameGuideShown = false;
    this.cutoutFrameGuide.setVisible(false);
    this.showToast(this.ui.cutout_exporting);
    try {
      const bytes = await this.viewport.exportCutout(this.sceneOptions.get());
      revokePngObjectUrl(this.cutoutPreviewUrl);
      this.cutoutPendingBytes = bytes;
      this.cutoutPreviewUrl = pngObjectUrl(bytes);
      this.cutoutPreviewOpen = true;
      this.paintCutoutModals();
    } catch (err) {
      this.handleCutoutExportError(err);
    } finally {
      this.cutoutExporting = false;
      this.paintCutoutModeUi();
    }
  }

  private handleCutoutExportError(err: unknown): void {
    if (err instanceof CutoutExportError) {
      if (err.code === "not_ready") this.showToast(this.ui.cutout_no_model);
      else if (err.code === "empty") this.showToast(this.ui.cutout_empty, "error");
      else this.showToast(this.ui.cutout_failed, "error");
    } else {
      this.showToast(this.ui.cutout_failed, "error");
    }
  }

  private async saveCutoutWithDialog(): Promise<void> {
    if (!this.cutoutPendingBytes) return;
    const filename = ensurePngFilename(this.cutoutDefaultFilename());
    try {
      const saved = await saveCutoutDialog(filename, this.cutoutPendingBytes);
      if (!saved) return;
      this.showToast(this.ui.cutout_saved.replace("{path}", saved), "success");
      this.closeCutoutFlow();
    } catch {
      this.showToast(this.ui.cutout_failed, "error");
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
    this.syncFramingInsets();
    await this.viewport.fit();
  }

  private modelPanelsVisible(): boolean {
    const hasErrorMetadata =
      this.phase === "error" &&
      this.activePath !== null &&
      this.summaryCache.has(this.activePath);
    return (
      this.phase === "ready" ||
      (this.phase === "loading" && this.activePath !== null) ||
      hasErrorMetadata ||
      (this.models.length > 0 &&
        (this.phase === "error" || (this.phase === "empty" && this.activePath === null)))
    );
  }

  private viewportFramingContext() {
    const interactive = this.phase === "ready";
    const showModelPanels = this.modelPanelsVisible();
    const hasLibrary = showModelPanels && this.models.length > 0;
    return {
      cinemaMode: this.cinemaMode,
      showDock: interactive && !this.cinemaMode,
      hasLibrary,
      explorerCollapsed: this.explorerCollapsed,
      showInspector: showModelPanels,
      inspectorCollapsed: this.inspectorCollapsed,
      showInspectorTab:
        showModelPanels &&
        this.inspectorCollapsed &&
        !this.cinemaMode &&
        !this.inspectorHiddenAfterError,
      showAxisWidget: this.phase === "ready",
    };
  }

  private syncFramingInsets(): void {
    this.viewport.setFramingInsets(
      measureViewportInsets(this.els.viewportHost, this.shell, this.viewportFramingContext()),
    );
  }

  private scheduleFramingInsets(): void {
    if (this.viewportInsetsRaf) return;
    this.viewportInsetsRaf = requestAnimationFrame(() => {
      this.viewportInsetsRaf = 0;
      this.syncFramingInsets();
    });
  }

  private bindCinemaChromeIdle(): void {
    const reveal = (): void => {
      if (!this.cinemaMode) return;
      this.setCinemaChromeIdle(false);
      this.scheduleCinemaChromeHide();
    };

    window.addEventListener("mousemove", reveal, { passive: true });
    this.els.cinemaControls.addEventListener("mouseenter", reveal);
    this.els.axisWidget.addEventListener("mouseenter", reveal);
  }

  private scheduleCinemaChromeHide(): void {
    if (!this.cinemaMode) return;
    if (this.cinemaChromeTimer) clearTimeout(this.cinemaChromeTimer);
    this.cinemaChromeTimer = setTimeout(() => {
      this.cinemaChromeTimer = null;
      if (this.cinemaMode) this.setCinemaChromeIdle(true);
    }, this.cinemaChromeIdleMs);
  }

  private clearCinemaChromeTimer(): void {
    if (this.cinemaChromeTimer) {
      clearTimeout(this.cinemaChromeTimer);
      this.cinemaChromeTimer = null;
    }
  }

  private setCinemaChromeIdle(idle: boolean): void {
    const on = idle && this.cinemaMode;
    this.els.cinemaControls.classList.toggle("is-chrome-idle", on);
    this.shell.classList.toggle("is-cinema-chrome-idle", on);
    document.documentElement.classList.toggle("is-cinema-cursor-hidden", on);
    this.viewport.setCursorHidden(on);
  }

  private bindCinemaIdleResume(): void {
    const surface = this.els.viewportMain;
    surface.addEventListener("pointerdown", () => {
      if (!this.cinemaMode || this.cinemaRotatePaused) return;
      this.clearCinemaIdleTimer();
      this.setCinemaChromeIdle(false);
      this.scheduleCinemaChromeHide();
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
        this.setCinemaChromeIdle(false);
        this.scheduleCinemaChromeHide();
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
    if (on) this.setCutoutMode(false);
    this.cinemaMode = on;
    if (on) {
      this.cinemaRotatePaused = false;
      this.resetView();
      this.viewport.setAutoRotate(true);
      this.setCinemaChromeIdle(false);
      void customElements.whenDefined("model-viewer").then(() => {
        if (this.cinemaMode) this.scheduleCinemaChromeHide();
      });
      this.paintCinemaControls();
    } else {
      this.clearCinemaIdleTimer();
      this.clearCinemaChromeTimer();
      this.setCinemaChromeIdle(false);
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
    this.dismissExplorerPopovers();
    this.explorerCollapsed = !this.explorerCollapsed;
    this.paint();
  }

  private toggleInspectorCollapsed(): void {
    if (this.cinemaMode) return;
    if (!this.modelPanelsVisible()) return;
    this.inspectorCollapsed = !this.inspectorCollapsed;
    if (!this.inspectorCollapsed) this.inspectorHiddenAfterError = false;
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

    const showModelPanels = this.modelPanelsVisible();
    const showLibraryToggle = showModelPanels && this.models.length > 0 && !this.cinemaMode;
    const librarySlot = this.els.toggleLibrary.parentElement;
    librarySlot?.classList.toggle("is-visible", showLibraryToggle);
    this.els.toggleLibrary.classList.toggle("is-visible", showLibraryToggle);
    this.els.toggleLibrary.classList.toggle(
      "is-active",
      showLibraryToggle && !this.explorerCollapsed,
    );
    (this.els.toggleLibrary as HTMLButtonElement).disabled = !showLibraryToggle;
    this.els.toggleLibrary.setAttribute("aria-hidden", showLibraryToggle ? "false" : "true");
    const libraryIcon = this.els.toggleLibrary.querySelector(".material-symbols-outlined");
    if (libraryIcon) {
      libraryIcon.textContent = this.explorerCollapsed ? "chevron_right" : "side_navigation";
    }
  }

  private async pickFile(): Promise<void> {
    if (this.dialogOpen) return;
    this.dismissExplorerPopovers();
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
    this.dismissExplorerPopovers();
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
      try {
        this.registerLibraryRoot(await normalizeModelPath(dir));
      } catch {
        this.registerLibraryRoot(dir);
      }
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

  private registerLibraryRoot(dir: string): void {
    const normalized = dir.replace(/\\/g, "/").replace(/\/$/, "");
    if (!this.libraryRoots.includes(normalized)) {
      this.libraryRoots.push(normalized);
    }
  }

  private async refreshFolder(dir: string): Promise<void> {
    if (this.libraryRefreshing) return;
    this.libraryRefreshing = true;
    this.libraryMenu.hide();
    try {
      const scanned = await listModelsInFolder(dir);
      const removed = this.syncModelsUnderDir(dir, scanned);
      await this.handleModelsRemovedFromLibrary(removed);
      this.paint();
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : String(err));
    } finally {
      this.libraryRefreshing = false;
    }
  }

  private async refreshLibrary(): Promise<void> {
    if (this.libraryRefreshing) return;
    if (this.libraryRoots.length === 0) {
      this.showToast(this.ui.refresh_library_unavailable);
      return;
    }
    this.libraryRefreshing = true;
    this.libraryMenu.hide();
    try {
      const allScanned: ModelListEntry[] = [];
      const seen = new Set<string>();
      for (const root of this.libraryRoots) {
        const items = await listModelsInFolder(root);
        for (const item of items) {
          if (seen.has(item.path)) continue;
          seen.add(item.path);
          allScanned.push(item);
        }
      }

      const scannedPaths = new Set(allScanned.map((s) => s.path));
      const removed: string[] = [];
      this.models = this.models.filter((m) => {
        const underRoot = this.libraryRoots.some((r) => isPathUnderDir(m.path, r));
        if (!underRoot) return true;
        if (scannedPaths.has(m.path)) return true;
        removed.push(m.path);
        this.summaryCache.delete(m.path);
        this.cameraByPath.delete(m.path);
        return false;
      });

      let skipped = 0;
      for (const entry of allScanned) {
        if (!this.tryUpsertModel(entry)) skipped++;
      }
      if (skipped > 0) this.notifyLibraryLimit(skipped);

      await this.handleModelsRemovedFromLibrary(removed);
      this.paint();
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : String(err));
    } finally {
      this.libraryRefreshing = false;
    }
  }

  private syncModelsUnderDir(dir: string, scanned: ModelListEntry[]): string[] {
    const scannedPaths = new Set(scanned.map((s) => s.path));
    const removed: string[] = [];

    this.models = this.models.filter((m) => {
      if (!isPathUnderDir(m.path, dir)) return true;
      if (scannedPaths.has(m.path)) return true;
      removed.push(m.path);
      this.summaryCache.delete(m.path);
      this.cameraByPath.delete(m.path);
      return false;
    });

    let skipped = 0;
    for (const entry of scanned) {
      if (!this.tryUpsertModel(entry)) skipped++;
    }
    if (skipped > 0) this.notifyLibraryLimit(skipped);

    return removed;
  }

  private async handleModelsRemovedFromLibrary(removed: string[]): Promise<void> {
    if (!this.activePath || !removed.includes(this.activePath)) return;

    if (this.models.length === 0) {
      this.unloadScene();
      return;
    }

    const index = this.models.findIndex((m) => m.path === this.activePath);
    this.loadToken++;
    this.activePath = null;
    this.summary = null;
    this.viewport.clear();

    const next = this.models[Math.min(Math.max(index, 0), this.models.length - 1)]!;
    await this.openPath(next.path);
  }

  private toggleFolderCollapsed(folderKey: string): void {
    if (this.collapsedFolders.has(folderKey)) {
      this.collapsedFolders.delete(folderKey);
    } else {
      this.collapsedFolders.add(folderKey);
    }

    const folder = this.els.sidebarBody.querySelector<HTMLElement>(
      `.lib-folder[data-folder-key="${CSS.escape(folderKey)}"]`,
    );
    if (!folder) {
      this.paintSidebar();
      return;
    }

    const collapsed = this.collapsedFolders.has(folderKey);
    folder.classList.toggle("is-collapsed", collapsed);
    const toggle = folder.querySelector<HTMLElement>("[data-action=toggle-folder]");
    toggle?.setAttribute("aria-expanded", collapsed ? "false" : "true");
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

  private dismissError(): void {
    if (this.phase !== "error") return;
    this.loadFailure = null;
    this.status = "";
    this.activePath = null;
    this.summary = null;
    this.inspectorCollapsed = true;
    this.inspectorHiddenAfterError = true;
    this.viewport.clear();
    this.phase = "empty";
    this.paint();
  }

  private showToast(message: string, tone: "default" | "success" | "error" = "default"): void {
    const el = this.els.toast;
    const icon = tone === "success" ? "check_circle" : tone === "error" ? "error_outline" : "info";
    el.classList.remove("is-success", "is-error");
    if (tone === "success") el.classList.add("is-success");
    if (tone === "error") el.classList.add("is-error");
    this.els.toastIcon.textContent = icon;
    this.els.toastText.textContent = message;
    el.classList.add("is-visible");
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      el.classList.remove("is-visible");
      this.toastTimer = null;
    }, 4500);
  }

  private modelFileSizeForPath(path: string): number {
    if (this.summary?.path === path) return this.summary.file_size;
    const cached = this.summaryCache.get(path);
    if (cached) return cached.file_size;
    return this.models.find((m) => m.path === path)?.file_size ?? 0;
  }

  private largeModelLoadHint(path: string): string | null {
    const size = this.modelFileSizeForPath(path);
    if (size < LARGE_MODEL_HINT_BYTES) return null;
    return this.ui.error_large_model_hint.replace("{size}", formatBytes(size, this.ui));
  }

  private clearUpdateStatusTimer(): void {
    if (this.updateStatusTimer) {
      clearTimeout(this.updateStatusTimer);
      this.updateStatusTimer = null;
    }
  }

  private scheduleUpdateStatusClear(): void {
    this.clearUpdateStatusTimer();
    this.updateStatusTimer = setTimeout(() => {
      this.updateStatusTimer = null;
      if (this.updateState === "checking") return;
      if (this.updateBannerVisible || this.updateDownloadState === "downloading") return;
      this.updateState = "idle";
      this.updateResult = null;
      this.cachedLatestVersion = null;
      this.paintAboutSection();
    }, 60_000);
  }

  private latestUpdateVersion(): string {
    return this.updateResult?.latest_version ?? this.cachedLatestVersion ?? "";
  }

  private formatUpdateDownloadProgress(): string {
    const pct = this.updateDownloadPercent;
    if (this.updateDownloadTotalBytes > 0) {
      return `${formatBytes(this.updateDownloadedBytes, this.ui)} / ${formatBytes(this.updateDownloadTotalBytes, this.ui)} (${pct}%)`;
    }
    if (this.updateDownloadedBytes > 0) {
      return `${formatBytes(this.updateDownloadedBytes, this.ui)} (${pct}%)`;
    }
    return this.ui.update_downloading.replace("{percent}", String(pct));
  }

  private formatVersionLine(): string {
    const info = this.appMeta();
    const version = info.version ? `v${info.version}` : "…";
    const date = formatAppDate(info.build_date, this.ui.locale);
    return date ? `${version} · ${date}` : version;
  }

  private paintAboutSection(): void {
    const info = this.appMeta();
    this.els.aboutName.textContent = this.ui.app_name;
    this.els.aboutTagline.textContent = this.ui.tagline;
    this.els.aboutDesc.textContent = this.ui.about_description;
    this.els.aboutVersion.textContent = this.formatVersionLine();
    this.els.aboutMeta.textContent = `${info.copyright} · ${info.license}`;

    const checkBtn = this.els.checkUpdatesBtn as HTMLButtonElement | null;
    const checkIcon = this.els.checkUpdatesIcon;
    const checkLabel = this.els.checkUpdatesLabel;
    const downloadBtn = this.els.downloadUpdateBtn as HTMLButtonElement | null;
    const hintEl = this.els.updateStatus;
    const hintIcon = this.els.updateStatusIcon;
    const hintText = this.els.updateStatusText;
    if (!checkBtn || !checkIcon || !checkLabel || !downloadBtn || !hintEl || !hintIcon || !hintText) {
      return;
    }

    const checking = this.updateState === "checking";
    const downloading = this.updateDownloadState === "downloading";
    checkLabel.textContent = checking ? this.ui.update_checking : this.ui.check_for_updates;
    checkIcon.classList.toggle("hidden", checking);
    checkBtn.disabled = checking || downloading;
    checkBtn.classList.toggle("is-loading", checking);
    downloadBtn.classList.toggle("hidden", this.updateState !== "available");
    downloadBtn.disabled = downloading;

    const showHint =
      this.updateState === "uptodate" ||
      this.updateState === "available" ||
      this.updateState === "error";
    hintEl.classList.toggle("hidden", !showHint);
    hintEl.classList.remove("is-success", "is-info", "is-error");
    if (!showHint) {
      hintIcon.textContent = "";
      hintText.textContent = "";
      return;
    }

    switch (this.updateState) {
      case "uptodate":
        hintEl.classList.add("is-success");
        hintIcon.textContent = "check_circle";
        hintText.textContent = this.ui.update_up_to_date;
        break;
      case "available":
        hintEl.classList.add("is-info");
        hintIcon.textContent = downloading ? "download" : "system_update";
        hintText.textContent = downloading
          ? this.formatUpdateDownloadProgress()
          : this.ui.update_available.replace("{version}", this.latestUpdateVersion());
        break;
      case "error":
        hintEl.classList.add("is-error");
        hintIcon.textContent = "error_outline";
        hintText.textContent = this.ui.update_check_failed;
        break;
      default:
        hintIcon.textContent = "";
        hintText.textContent = "";
        break;
    }
  }

  private async checkForUpdatesOnStartup(): Promise<void> {
    if (!this.updatePreferences.get().autoCheckOnStartup) return;
    await delay(UPDATE_STARTUP_CHECK_DELAY_MS);
    await this.waitUntilStartupReady();
    await flushUi();
    await this.handleCheckUpdates(false, { silent: true, fromStartup: true });
  }

  private waitUntilStartupReady(): Promise<void> {
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        if (this.phase !== "loading" || Date.now() - started >= UPDATE_STARTUP_SETTLE_TIMEOUT_MS) {
          resolve();
          return;
        }
        setTimeout(tick, UPDATE_STARTUP_SETTLE_POLL_MS);
      };
      tick();
    });
  }

  private maybeShowStartupUpdateBanner(): void {
    if (this.phase === "loading") {
      this.pendingStartupUpdateBanner = true;
      return;
    }
    this.pendingStartupUpdateBanner = false;
    this.showUpdateBannerIfNeeded();
  }

  private showUpdateBannerIfNeeded(): void {
    const version = this.latestUpdateVersion();
    if (!version || this.updateState !== "available") {
      this.updateBannerVisible = false;
      this.paintUpdateBanner();
      return;
    }
    const dismissed = localStorage.getItem(DISMISSED_UPDATE_KEY);
    this.updateBannerVisible = dismissed !== version;
    this.paintUpdateBanner();
  }

  private paintUpdateBanner(): void {
    const banner = this.els.updateBanner;
    const title = this.els.updateBannerTitle;
    const body = this.els.updateBannerBody;
    const progress = this.els.updateDownloadProgress;
    const progressBar = this.els.updateDownloadProgressBar;
    if (!banner || !title || !body || !progress || !progressBar) return;

    const version = this.latestUpdateVersion();
    const downloading = this.updateDownloadState === "downloading";
    banner.classList.toggle("hidden", !this.updateBannerVisible);
    banner.classList.toggle("is-downloading", downloading);
    title.textContent = this.ui.update_banner_title.replace("{version}", version);
    body.textContent = downloading
      ? this.formatUpdateDownloadProgress()
      : this.ui.update_banner_body;
    progress.classList.toggle("hidden", !downloading);
    progressBar.style.width = `${this.updateDownloadPercent}%`;

    for (const el of this.shell.querySelectorAll<HTMLButtonElement>('[data-action="download-update-in-app"]')) {
      el.disabled = downloading;
    }
    if (this.els.updateBannerDismissBtn) {
      (this.els.updateBannerDismissBtn as HTMLButtonElement).disabled = downloading;
    }
  }

  private dismissUpdateBanner(): void {
    const version = this.latestUpdateVersion();
    if (version) localStorage.setItem(DISMISSED_UPDATE_KEY, version);
    this.updateBannerVisible = false;
    this.paintUpdateBanner();
  }

  private async openUpdateInBrowser(): Promise<void> {
    const url = this.updateResult?.release_page ?? this.updateResult?.download_url ?? this.appMeta().releases_url;
    await this.openExternal(url);
  }

  private async downloadUpdateInApp(): Promise<void> {
    if (this.updateDownloadState === "downloading") return;

    const url = this.updateResult?.download_url;
    if (!url) {
      await this.openUpdateInBrowser();
      return;
    }

    this.updateDownloadState = "downloading";
    this.updateDownloadPercent = 0;
    this.updateDownloadedBytes = 0;
    this.updateDownloadTotalBytes = 0;
    this.updateBannerVisible = true;
    this.clearUpdateStatusTimer();
    this.paintUpdateBanner();
    this.paintAboutSection();

    const unlisten = await onUpdateDownloadProgress((progress) => {
      this.updateDownloadPercent = progress.percent;
      this.updateDownloadedBytes = progress.downloaded;
      this.updateDownloadTotalBytes = progress.total;
      this.paintUpdateBanner();
      this.paintAboutSection();
    });

    try {
      const path = await downloadUpdate(url);
      await openDownloadedUpdate(path);
      this.showToast(this.ui.update_download_complete, "success");
      this.dismissUpdateBanner();
    } catch {
      this.showToast(this.ui.update_download_failed, "error");
      await this.openUpdateInBrowser();
    } finally {
      unlisten();
      this.updateDownloadState = "idle";
      this.paintUpdateBanner();
      this.paintAboutSection();
      if (this.updateState === "available") {
        this.scheduleUpdateStatusClear();
      }
    }
  }

  private async handleCheckUpdates(
    fromMenu: boolean,
    options: { silent?: boolean; fromStartup?: boolean } = {},
  ): Promise<void> {
    const silent = options.silent ?? false;
    const fromStartup = options.fromStartup ?? false;
    if (this.updateState === "checking") return;
    this.clearUpdateStatusTimer();
    this.updateState = "checking";
    this.paintAboutSection();
    try {
      const result = await checkForUpdates();
      this.updateResult = result;
      if (result.latest_version) {
        this.cachedLatestVersion = result.latest_version;
      }
      this.updateState = result.update_available ? "available" : "uptodate";
      if (fromMenu) {
        this.showToast(
          result.update_available
            ? this.ui.update_available.replace("{version}", result.latest_version ?? "")
            : this.ui.update_up_to_date,
        );
      }
      if (result.update_available) {
        if (fromStartup) this.maybeShowStartupUpdateBanner();
        else this.showUpdateBannerIfNeeded();
      }
    } catch {
      this.updateState = "error";
      if (!silent) this.showToast(this.ui.update_check_failed);
    } finally {
      this.paintAboutSection();
      if (
        this.updateState === "uptodate" ||
        this.updateState === "available" ||
        this.updateState === "error"
      ) {
        this.scheduleUpdateStatusClear();
      }
    }
  }

  private async openExternal(url: string | null | undefined): Promise<void> {
    if (!url) {
      this.showToast(this.ui.open_link_failed);
      return;
    }
    try {
      await openExternalUrl(url);
    } catch {
      this.showToast(this.ui.open_link_failed);
    }
  }

  private openRepository(): Promise<void> {
    const info = this.appMeta();
    return this.openExternal(info.repository || info.homepage);
  }

  private openReleaseNotes(): Promise<void> {
    return this.openExternal(this.appMeta().releases_url);
  }

  private openIssueTracker(): Promise<void> {
    return this.openExternal(this.appMeta().issues_url);
  }

  private openLicense(): Promise<void> {
    const repo = this.appMeta().repository;
    return this.openExternal(repo ? `${repo}/blob/main/LICENSE` : null);
  }

  private modelListKey(): string {
    return libraryTreeListKey(this.models, this.libraryRoots);
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

  private async handleExternalOpen(path: string): Promise<void> {
    try {
      path = await normalizeModelPath(path);
    } catch {
      /* keep original */
    }

    const kind = await pathKind(path);
    if (kind === "directory") {
      await this.loadFolder(path);
      return;
    }
    if (kind === "missing") {
      this.phase = "error";
      this.status = this.ui.error_unknown_file_type;
      this.summary = null;
      this.activePath = null;
      this.viewport.clear();
      this.paint();
      return;
    }

    await this.openPath(path, { addToList: true });
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
    this.inspectorHiddenAfterError = false;
    this.activePath = path;
    this.phase = "loading";
    this.loadPercent = 0;
    this.parseProgress = 0;
    this.packProgress = 0;
    this.loadingExpectsPreview = false;
    this.loadingStage = "parse";
    this.status = "";
    this.paint();

    await flushUi();

    let viewerPath: string | null = null;
    let summaryPromise: Promise<SceneSummary> | null = null;
    try {
      const cached = this.summaryCache.get(path);
      let fileSize = 0;
      try {
        fileSize = await modelFileSize(path);
      } catch {
        fileSize = this.modelFileSizeForPath(path);
      }
      this.loadingExpectsPreview = fileSize >= PREVIEW_OPTIMIZE_BYTES;

      this.loadingStage = !cached && !this.loadingExpectsPreview ? "parse" : "pack";
      this.parseProgress = cached ? 100 : 0;
      this.packProgress = 0;
      this.syncLoadingProgress();

      if (this.cinemaMode) {
        this.viewport.setAutoRotate(false);
        this.paintCinemaControls();
      }

      summaryPromise = cached
        ? Promise.resolve(cached)
        : loadModel(path).then((summary) => {
            this.summaryCache.set(path, summary);
            this.parseProgress = 100;
            if (token === this.loadToken && this.phase === "loading") {
              this.syncLoadingProgress();
            }
            return summary;
          });

      viewerPath = await resolveViewerModelPath(path);
      if (token !== this.loadToken) return;

      this.packProgress = 100;
      this.syncLoadingProgress();

      const summary = await summaryPromise;
      if (token !== this.loadToken) return;

      this.loadingStage = "render";
      this.loadPercent = 85;
      this.paintOverlay();

      const assetUrl = convertFileSrc(viewerPath, "asset");
      this.loadPercent = 92;
      this.paintOverlay();

      this.syncFramingInsets();
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
      this.syncSceneGuidesAfterModelReady();
      this.loadPercent = 100;
      this.paintOverlay();
      if (this.cinemaMode && !this.cinemaRotatePaused) {
        this.resetView();
        this.viewport.setAutoRotate(true);
      }
      this.viewport.focus();
      this.paintCinemaControls();
      if (isPreviewCachePath(viewerPath)) {
        const notice = this.ui.large_model_preview_notice.replace(
          "{size}",
          formatBytes(summary.file_size, this.ui),
        );
        this.showToast(notice);
      }
    } catch (err) {
      if (token !== this.loadToken) return;
      if (summaryPromise) {
        try {
          const summary = await summaryPromise;
          this.summaryCache.set(path, summary);
        } catch {
          /* metadata optional for error copy */
        }
      }
      this.loadFailure = {
        path,
        viewerPath,
        raw: err instanceof Error ? err.message : String(err),
      };
      this.phase = "error";
      this.status = resolveLoadFailureMessage(
        this.ui,
        path,
        err,
        viewerPath,
        (p) => this.modelFileSizeForPath(p),
      );
      const largeHint = this.largeModelLoadHint(path);
      if (largeHint && !this.loadingExpectsPreview) this.showToast(largeHint, "error");
      if (!this.summary) this.viewport.clear();
    }
    this.paint();
  }

  private paint(): void {
    const interactive = this.phase === "ready";
    const overlayVisible =
      this.phase === "loading" ||
      this.phase === "error" ||
      (this.phase === "empty" && this.models.length === 0);
    const switching = this.phase === "loading" && this.summary !== null;

    this.els.settingsBackdrop.classList.toggle("hidden", !this.settingsOpen);
    if (this.settingsOpen) {
      if (!this.cacheSizeFetchedForSettings) {
        this.cacheSizeFetchedForSettings = true;
        void this.refreshViewerCacheSize();
      }
      this.paintAboutSection();
      this.paintShortcutsSection();
      this.paintSceneSettings();
      this.paintUpdateSettings();
      this.paintCacheSection();
    } else {
      this.paintCacheSection(true);
    }
    this.syncLibraryClearPop();
    this.els.clearLibrary.classList.toggle("is-active", this.clearConfirmOpen);
    this.els.viewportMain.classList.toggle("is-interactive", interactive);
    const modelPreview =
      this.phase === "ready" || (this.phase === "loading" && this.activePath !== null);
    this.shell.classList.toggle("is-model-preview", modelPreview);
    if (this.phase === "ready") {
      if (!this.sceneGuidesSyncedForReady) {
        this.applySceneOptions();
        this.sceneGuidesSyncedForReady = true;
      }
    } else {
      this.sceneGuidesSyncedForReady = false;
    }
    this.viewport.setPresentationMode(this.phase === "ready");
    if (this.phase !== "ready" && this.cutoutMode) this.setCutoutMode(false);
    else this.paintCutoutModeUi();
    this.setGridParallaxDormant?.(modelPreview);
    this.els.overlay.classList.toggle("is-visible", overlayVisible);
    this.els.overlay.classList.toggle("is-empty", this.phase === "empty");
    this.els.overlay.classList.toggle("is-loading", this.phase === "loading");
    this.els.overlay.classList.toggle("is-switching", switching);
    this.els.overlay.classList.toggle("is-error", this.phase === "error");
    const showModelPanels = this.modelPanelsVisible();
    const hasLibrary = showModelPanels && this.models.length > 0;

    this.shell.classList.toggle("is-cinema", this.cinemaMode);
    this.shell.classList.toggle("is-explorer-collapsed", this.explorerCollapsed);
    this.shell.classList.toggle("is-inspector-collapsed", this.inspectorCollapsed);

    this.els.explorerDrawer.classList.toggle("is-visible", hasLibrary);
    this.els.explorerDrawer.classList.toggle("is-collapsed", this.explorerCollapsed);
    this.els.explorerDrawer.classList.toggle("is-clear-pop-open", this.libraryClearPopShown);
    const showInspector = showModelPanels && !this.inspectorHiddenAfterError;
    this.els.inspector.classList.toggle("is-visible", showInspector);
    this.els.inspector.classList.toggle("is-collapsed", this.inspectorCollapsed);

    this.els.viewportDock.classList.toggle("is-visible", interactive && !this.cinemaMode);
    this.axisWidget.setActive(this.phase === "ready");
    this.els.toolCinema.classList.toggle("is-active", this.cinemaMode);
    const sceneOpts = this.sceneOptions.get();
    this.els.toolPreviewGrid.classList.toggle("is-active", sceneOpts.previewGrid);
    this.els.toolSceneGuides.classList.toggle("is-active", sceneOpts.showGuides);
    const showInspectorTab =
      showModelPanels &&
      this.inspectorCollapsed &&
      !this.cinemaMode &&
      !this.inspectorHiddenAfterError;
    this.els.expandInspector.classList.toggle("is-visible", showInspectorTab);
    this.paintPanelToggles();
    if (this.cinemaMode) this.paintCinemaControls();

    this.paintSidebar();
    this.paintOverlay();
    this.paintInspector();
    this.scheduleFramingInsets();
    if (this.pendingStartupUpdateBanner && this.phase !== "loading") {
      this.pendingStartupUpdateBanner = false;
      this.showUpdateBannerIfNeeded();
    }
  }

  private paintInspector(): void {
    const body = this.els.inspectorBody;
    const loading = this.phase === "loading" && this.activePath !== null;
    const ready = this.phase === "ready" && this.summary !== null;
    const failedSummary =
      this.phase === "error" && this.activePath
        ? this.summaryCache.get(this.activePath)
        : undefined;
    const titleEntry = this.activePath
      ? this.models.find((m) => m.path === this.activePath)
      : undefined;
    const contentKey = loading
      ? `loading:${this.activePath}:${this.ui.locale}`
      : ready
        ? `model:${this.summary!.path}:${this.ui.locale}`
        : failedSummary
          ? `error:${failedSummary.path}:${this.ui.locale}`
          : "idle";

    this.els.inspectorTitle.textContent =
      titleEntry?.name ?? failedSummary?.name ?? this.summary?.name ?? "—";
    body.classList.toggle("is-loading", loading);
    body.classList.toggle("is-placeholder", !loading && !ready && !failedSummary);
    if (body.dataset.contentKey === contentKey) return;

    body.dataset.contentKey = contentKey;
    body.innerHTML = loading
      ? this.inspectorSkeletonHtml(this.ui)
      : ready
        ? this.inspectorHtml(this.ui, this.summary!)
        : failedSummary
          ? this.inspectorHtml(this.ui, failedSummary)
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
    if (this.sidebarItemAnimating) return;
    void this.removeModelAnimated(path);
  }

  private findModelRow(path: string): HTMLElement | null {
    return (
      this.els.sidebarBody.querySelector<HTMLElement>(
        `[data-action=remove-model][data-model-path="${CSS.escape(path)}"]`,
      )?.closest(".model-row") ?? null
    );
  }

  private animateListItemOut(el: HTMLElement): Promise<void> {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return Promise.resolve();
    }

    const height = el.getBoundingClientRect().height;
    el.style.overflow = "hidden";
    el.style.maxHeight = `${height}px`;

    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        el.removeEventListener("transitionend", onTransitionEnd);
        resolve();
      };

      const onTransitionEnd = (event: TransitionEvent) => {
        if (event.target !== el || event.propertyName !== "max-height") return;
        finish();
      };

      el.addEventListener("transitionend", onTransitionEnd);
      window.setTimeout(finish, 420);

      requestAnimationFrame(() => {
        el.classList.add("is-removing");
      });
    });
  }

  private async removeModelAnimated(path: string): Promise<void> {
    const index = this.models.findIndex((m) => m.path === path);
    if (index < 0) return;

    const wasActive = this.activePath === path;
    const row = this.findModelRow(path);

    this.sidebarItemAnimating = true;
    try {
      if (row) {
        await this.animateListItemOut(row);
        row.remove();
      }

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
    } finally {
      this.sidebarItemAnimating = false;
    }
  }

  private performClearLibrary(): void {
    if (this.models.length === 0) {
      this.dismissExplorerPopovers();
      this.paint();
      return;
    }
    this.dismissExplorerPopovers();
    this.models = [];
    this.summaryCache.clear();
    this.cameraByPath.clear();
    this.libraryRoots = [];
    this.collapsedFolders.clear();
    this.unloadScene();
  }

  private unloadScene(): void {
    this.loadToken++;
    this.activePath = null;
    this.summary = null;
    this.folderPath = null;
    this.libraryRoots = [];
    this.collapsedFolders.clear();
    this.explorerCollapsed = false;
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
    const activeFolderKey = activeModelFolderKey(active);
    for (const row of body.querySelectorAll<HTMLElement>(".model-row")) {
      const path = row
        .querySelector<HTMLElement>("[data-action=select-model]")
        ?.getAttribute("data-model-path");
      row.classList.toggle("active", path === active);
    }
    for (const folder of body.querySelectorAll<HTMLElement>(".lib-folder")) {
      const key = folder.getAttribute("data-folder-key");
      const containsActive = activeFolderKey !== null && key === activeFolderKey;
      folder.classList.toggle("contains-active", containsActive);
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
    const kind =
      this.phase === "empty"
        ? `empty:${this.ui.locale}`
        : `${this.phase}:${this.ui.locale}`;
    if (this.els.overlay.dataset.overlayKind !== kind) {
      this.els.overlay.dataset.overlayKind = kind;
      this.els.overlay.innerHTML = this.overlayHtml(this.ui);
    }
  }

  private syncLoadingProgress(): void {
    if (this.phase !== "loading" || this.loadingStage === "render") return;

    const parseDone = this.parseProgress >= 100;
    const optimizing = this.loadingExpectsPreview || this.packProgress > 0;
    if (!parseDone && !optimizing) {
      this.loadingStage = "parse";
      this.loadPercent = Math.min(
        40,
        Math.floor(this.parseProgress * 0.35 + this.packProgress * 0.05),
      );
    } else {
      this.loadingStage = "pack";
      const packPct = Math.max(this.packProgress, optimizing ? 2 : 0);
      this.loadPercent = Math.min(
        90,
        parseDone ? 10 + Math.floor(packPct * 0.8) : 5 + Math.floor(packPct * 0.75),
      );
    }
    this.paintOverlay();
  }

  private loadingLabel(): string {
    const stage =
      this.loadingStage === "parse"
        ? this.ui.loading_reading
        : this.loadingStage === "pack"
          ? this.loadingExpectsPreview
            ? this.ui.loading_optimizing_preview
            : this.ui.loading_packing
          : this.ui.loading_rendering;
    return `${stage} · ${this.loadPercent}%`;
  }

  private sidebarHtml(ui: UiBundle): string {
    return renderLibraryTree({
      models: this.models,
      roots: this.libraryRoots,
      activePath: this.activePath,
      collapsedFolders: this.collapsedFolders,
      ui,
    });
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
          <button type="button" class="error-dismiss" data-action="dismiss-error">${escapeHtml(ui.error_dismiss)}</button>
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
          <span class="mat-item-name" title="${escapeAttr(m.name)}">${escapeHtml(m.name)}</span>
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
  <div class="titlebar-drag" data-tauri-drag-region aria-hidden="true"></div>

  <div class="viewport-bg" aria-hidden="true">
    <div class="perspective-scene">
      <div class="perspective-grid perspective-grid--far"></div>
      <div class="perspective-grid perspective-grid--near"></div>
    </div>
    <div class="perspective-glow"></div>
  </div>

  <main class="viewport">
    <div class="viewport-host" tabindex="0"></div>
    <div class="overlay" data-bind="overlay"></div>
    <div class="axis-widget" data-bind="axis-widget" aria-hidden="true"></div>
  </main>

  <aside class="explorer-rail glass-capsule">
    <div class="rail-actions">
      <button type="button" class="rail-primary-btn" data-action="sidebar-open-file" aria-label="">
        <span class="material-symbols-outlined">add</span>
      </button>
      <button type="button" class="rail-icon-btn" data-action="sidebar-open-folder" aria-label="">
        <span class="material-symbols-outlined">folder_open</span>
      </button>
      <div class="rail-library-slot">
        <button type="button" class="rail-icon-btn rail-library-toggle" data-action="toggle-library" aria-label="">
          <span class="material-symbols-outlined">side_navigation</span>
        </button>
      </div>
    </div>
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
          <div
            class="library-clear-pop glass-capsule hidden"
            data-bind="clear-confirm"
            role="alertdialog"
            aria-modal="true"
          >
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
    <div class="inspector-body scroll-subtle" data-bind="inspector"></div>
  </aside>

  <footer class="bottom-dock glass-capsule" data-bind="viewport-dock">
    <div class="dock-group">
      <button type="button" class="dock-btn" data-action="toggle-preview-grid" aria-label="">
        <span class="material-symbols-outlined">grid_on</span>
      </button>
      <button type="button" class="dock-btn" data-action="toggle-scene-guides" aria-label="">
        <span class="dock-icon-axes" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="12" cy="13" r="1.4" fill="currentColor" opacity="0.55"/>
            <path d="M12 13V5.5" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>
            <path d="M12 5.5L10.2 8.2M12 5.5l1.8 2.7" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M12 13H19" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>
            <path d="M19 13l-2.4-1.5M19 13l-2.4 1.5" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M12 13L6.5 17.5" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>
            <path d="M6.5 17.5l1.9-2.2M6.5 17.5l2.8.3" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </span>
      </button>
    </div>
    <span class="dock-divider" aria-hidden="true"></span>
    <div class="dock-group">
      <button type="button" class="dock-btn" data-action="cinema-mode" aria-label="">
        <span class="material-symbols-outlined">360</span>
      </button>
    </div>
    <span class="dock-divider" aria-hidden="true"></span>
    <div class="dock-group">
      <button type="button" class="dock-btn" data-action="fit-view" aria-label="">
        <span class="material-symbols-outlined">fit_screen</span>
      </button>
      <button type="button" class="dock-btn" data-action="zoom-out" aria-label="">
        <span class="material-symbols-outlined">zoom_out</span>
      </button>
      <button type="button" class="dock-btn" data-action="zoom-in" aria-label="">
        <span class="material-symbols-outlined">zoom_in</span>
      </button>
      <button type="button" class="dock-btn" data-action="reset-view" aria-label="">
        <span class="material-symbols-outlined">restart_alt</span>
      </button>
      <button type="button" class="dock-btn" data-action="toggle-cutout-mode" aria-label="">
        <span class="dock-icon-cutout" aria-hidden="true">
          <span class="material-symbols-outlined">content_cut</span>
        </span>
      </button>
    </div>
  </footer>

  <div class="cutout-run-bar" data-bind="cutout-run-bar">
    <button type="button" class="cutout-run-btn glass-capsule" data-action="run-cutout-export">
      <span class="material-symbols-outlined" aria-hidden="true">content_cut</span>
      <span data-bind="cutout-run-label"></span>
    </button>
  </div>

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

  <div class="update-banner glass-capsule hidden" data-bind="update-banner" role="status" aria-live="polite">
    <span class="update-banner-icon" aria-hidden="true">
      <span class="material-symbols-outlined">new_releases</span>
    </span>
    <div class="update-banner-copy">
      <p class="update-banner-title" data-bind="update-banner-title"></p>
      <p class="update-banner-body" data-bind="update-banner-body"></p>
      <div class="update-banner-progress hidden" data-bind="update-download-progress">
        <div class="update-banner-progress-track">
          <div class="update-banner-progress-bar" data-bind="update-download-progress-bar"></div>
        </div>
      </div>
    </div>
    <button type="button" class="update-banner-action" data-action="download-update-in-app">
      <span class="material-symbols-outlined" aria-hidden="true">download</span>
      <span data-bind="update-banner-download-label"></span>
    </button>
    <button type="button" class="update-banner-dismiss" data-action="dismiss-update-banner" aria-label="">
      <span class="material-symbols-outlined" aria-hidden="true">close</span>
    </button>
  </div>

  <div class="app-toast glass-capsule" data-bind="toast" role="status" aria-live="polite">
    <span class="app-toast-icon" aria-hidden="true">
      <span class="material-symbols-outlined" data-bind="toast-icon"></span>
    </span>
    <span class="app-toast-text" data-bind="toast-text"></span>
  </div>

  <div class="settings-backdrop hidden" data-bind="settings">
    <div class="settings-panel glass-capsule" role="dialog" aria-modal="true" aria-labelledby="settings-heading">
      <header class="settings-header">
        <h2 id="settings-heading" data-bind="settings-title"></h2>
        <button type="button" class="settings-close" data-action="close-settings" aria-label="">
          <span class="material-symbols-outlined">close</span>
        </button>
      </header>
      <div class="settings-body scroll-subtle">
        <div class="settings-section">
          <label data-bind="language-label"></label>
          <div class="segmented" data-bind="locale-group"></div>
        </div>
        <div class="settings-section">
          <label data-bind="appearance-label"></label>
          <div class="segmented" data-bind="theme-group"></div>
        </div>
        <div class="settings-section">
          <div class="settings-section-head">
            <label data-bind="shortcuts-label"></label>
            <button type="button" class="settings-shortcut-reset-all" data-action="reset-shortcuts">
              <span class="material-symbols-outlined settings-shortcut-reset-all-icon" aria-hidden="true">restart_alt</span>
              <span class="settings-shortcut-reset-all-label" data-bind="shortcuts-reset-all-label"></span>
            </button>
          </div>
          <div class="settings-shortcuts" data-bind="shortcuts-list"></div>
        </div>
        <div class="settings-section">
          <label data-bind="scene-label"></label>
          <div class="settings-scene">
            <div class="settings-scene-grid" data-bind="scene-options-list"></div>
          </div>
        </div>
        <div class="settings-section">
          <label data-bind="updates-label"></label>
          <div class="settings-scene">
            <div class="settings-scene-grid" data-bind="update-settings-list"></div>
          </div>
        </div>
        <div class="settings-section" data-bind="storage-section">
          <label data-bind="storage-label"></label>
          <div class="settings-scene">
            <p class="settings-cache-hint" data-bind="cache-hint"></p>
            <div class="settings-scene-grid">
              <div class="settings-scene-row is-static settings-scene-row--full settings-cache-row">
                <span class="settings-scene-row-label">
                  <span class="material-symbols-outlined settings-scene-row-icon" aria-hidden="true">storage</span>
                  <span class="settings-scene-row-text settings-cache-row-text">
                    <span data-bind="cache-title"></span>
                    <span class="settings-cache-size" data-bind="cache-size">…</span>
                  </span>
                </span>
                <span class="settings-scene-row-actions">
                  <button type="button" class="settings-shortcut-reset-all" data-action="clear-cache" aria-expanded="false">
                    <span class="material-symbols-outlined settings-shortcut-reset-all-icon" aria-hidden="true">delete_sweep</span>
                    <span class="settings-shortcut-reset-all-label" data-bind="clear-cache-label"></span>
                  </button>
                </span>
              </div>
            </div>
          </div>
        </div>
        <div class="settings-divider" aria-hidden="true"></div>
        <div class="settings-section">
          <label data-bind="about-label"></label>
          <div class="settings-about">
            <p class="settings-about-name" data-bind="about-name"></p>
            <div class="settings-about-version-row">
              <span class="settings-about-version" data-bind="about-version"></span>
              <button type="button" class="settings-about-inline-action settings-about-inline-btn" data-action="check-updates">
                <span class="material-symbols-outlined settings-about-action-icon" data-bind="check-updates-icon" aria-hidden="true">refresh</span>
                <span class="settings-about-action-label" data-bind="check-updates-label"></span>
              </button>
              <button type="button" class="settings-about-inline-action settings-about-inline-action-primary settings-about-inline-btn hidden" data-action="download-update">
                <span class="material-symbols-outlined settings-about-action-icon" aria-hidden="true">download</span>
                <span class="settings-about-action-label" data-bind="download-update-label"></span>
              </button>
            </div>
            <p class="settings-about-hint settings-about-status hidden" data-bind="update-status">
              <span class="material-symbols-outlined settings-about-status-icon" data-bind="update-status-icon" aria-hidden="true"></span>
              <span class="settings-about-status-text" data-bind="update-status-text"></span>
            </p>
            <p class="settings-about-tagline" data-bind="about-tagline"></p>
            <p class="settings-about-desc" data-bind="about-desc"></p>
            <p class="settings-about-meta" data-bind="about-meta"></p>
          </div>
        </div>
        <div class="settings-section">
          <label data-bind="resources-label"></label>
          <div class="settings-links">
            <button type="button" class="settings-link" data-action="open-github">
              <span class="settings-link-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" focusable="false">
                  <path fill="currentColor" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2z"/>
                </svg>
              </span>
              <span data-bind="link-github"></span>
            </button>
            <button type="button" class="settings-link" data-action="open-releases">
              <span class="material-symbols-outlined" aria-hidden="true">new_releases</span>
              <span data-bind="link-releases"></span>
            </button>
            <button type="button" class="settings-link" data-action="open-issues">
              <span class="material-symbols-outlined" aria-hidden="true">bug_report</span>
              <span data-bind="link-issues"></span>
            </button>
            <button type="button" class="settings-link" data-action="open-license">
              <span class="material-symbols-outlined" aria-hidden="true">gavel</span>
              <span data-bind="link-license"></span>
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="cutout-backdrop hidden" data-bind="cutout-backdrop">
    <div
      class="cutout-panel cutout-preview-panel glass-capsule hidden"
      data-bind="cutout-preview-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cutout-preview-heading"
    >
      <header class="cutout-panel-header cutout-panel-drag-handle" data-bind="cutout-preview-header">
        <h2 id="cutout-preview-heading" data-bind="cutout-preview-title"></h2>
        <button type="button" class="cutout-panel-close" data-action="close-cutout-flow" aria-label="">
          <span class="material-symbols-outlined">close</span>
        </button>
      </header>
      <div class="cutout-preview-body">
        <div class="cutout-preview-stage" data-bind="cutout-preview-stage">
          <div class="cutout-preview-viewport" data-bind="cutout-preview-viewport">
            <img class="cutout-preview-image" data-bind="cutout-preview-image" alt="" />
          </div>
          <span class="cutout-preview-meta" data-bind="cutout-preview-meta"></span>
          <button type="button" class="cutout-preview-reset" data-action="cutout-preview-reset">
            <span class="material-symbols-outlined" aria-hidden="true">restart_alt</span>
          </button>
        </div>
      </div>
      <footer class="cutout-panel-footer">
        <button type="button" class="btn btn-secondary" data-action="cutout-preview-cancel"></button>
        <button type="button" class="btn btn-primary" data-action="cutout-preview-continue"></button>
      </footer>
      <div class="cutout-preview-resize-handle" data-bind="cutout-preview-resize" aria-hidden="true"></div>
    </div>
  </div>

  <div
    class="confirm-pop-shell library-clear-pop glass-capsule settings-cache-clear-pop hidden"
    data-bind="cache-clear-confirm"
    role="alertdialog"
    aria-modal="true"
  >
    <p class="library-clear-pop-text" data-bind="cache-clear-confirm-message"></p>
    <div class="library-clear-pop-actions">
      <button type="button" class="library-clear-pop-btn" data-action="clear-cache-cancel"></button>
      <button type="button" class="library-clear-pop-btn library-clear-pop-btn-primary" data-action="clear-cache-confirm"></button>
    </div>
  </div>
`;
