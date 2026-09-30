import "@google/model-viewer";

import { exportCutoutPng, type CutoutExportOptions } from "./cutout-export";
import {
  resetModelAppearanceCache,
  syncModelAppearance as applyModelAppearanceToModel,
  type ModelAppearanceOptions,
} from "./model-appearance";
import {
  resetSceneGuideSyncCache,
  syncSceneGuides as applySceneGuidesToModel,
  type SceneGuideSyncOptions,
} from "./scene-guides";
import { adjustCameraForViewportInsets, type ViewportInsets } from "./viewport-framing";

interface SphericalPosition {
  theta: number;
  phi: number;
  radius: number;
}

interface Vector3D {
  x: number;
  y: number;
  z: number;
  toString(): string;
}

interface ModelViewerElement extends HTMLElement {
  src: string | null;
  readonly loaded: boolean;
  cameraTarget: string;
  cameraOrbit: string;
  disableZoom: boolean;
  autoRotateDelay: number;
  getCameraOrbit(): SphericalPosition;
  getCameraTarget(): Vector3D;
  getFieldOfView(): number;
  fieldOfView: string;
  updateFraming(): Promise<void>;
  updateComplete: Promise<boolean>;
  readonly turntableRotation: number;
  resetTurntableRotation(theta?: number): void;
  jumpCameraToGoal(): void;
  getBoundingBoxCenter(): { x: number; y: number; z: number };
  getDimensions(): { x: number; y: number; z: number };
}

/** ~12% radius change per toolbar click. */
const ZOOM_STEP = 0.88;
/** A damping time constant, not a duration: 20ms reaches ~95% in 100ms. */
const INTERPOLATION_DECAY_MS = 20;
/** A 100px wheel delta changes distance by ~13%, independently of zoom range. */
const WHEEL_ZOOM_PER_PIXEL = 0.0012;
/** model-viewer attribute; default is 1. */
const ZOOM_SENSITIVITY = "0.82";
/** Degrees per second; model-viewer default feels fast in cinema mode. */
const AUTO_ROTATE_SPEED = "6deg";
const AUTO_ROTATE_DELAY_MS = 0;

const PRESENTATION = {
  shadowIntensity: "1.24",
  shadowSoftness: "0.68",
  exposure: "1.08",
  environmentImage: "neutral",
} as const;

const DEFAULT_SCENE = {
  shadowIntensity: "1",
  shadowSoftness: "1",
  exposure: "1",
  environmentImage: "neutral",
} as const;

function applyScenePresentation(mv: ModelViewerElement, enabled: boolean): void {
  const scene = enabled ? PRESENTATION : DEFAULT_SCENE;
  mv.setAttribute("shadow-intensity", scene.shadowIntensity);
  mv.setAttribute("shadow-softness", scene.shadowSoftness);
  mv.setAttribute("exposure", scene.exposure);
  mv.setAttribute("environment-image", scene.environmentImage);
  if (enabled) {
    mv.setAttribute("tone-mapping", "aces");
  } else {
    mv.removeAttribute("tone-mapping");
  }
}

export interface SavedCamera {
  targetX: number;
  targetY: number;
  targetZ: number;
  theta: number;
  phi: number;
  radiusM: number;
  /** Degrees; wheel zoom couples FOV with orbit radius in model-viewer. */
  fieldOfViewDeg: number;
  /** Scene turntable yaw (rad); auto-rotate spins this, not cameraOrbit. */
  turntableYaw: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatOrbit(orbit: SphericalPosition): string {
  return `${orbit.theta}rad ${orbit.phi}rad ${orbit.radius}m`;
}

function formatTarget(target: Vector3D): string {
  return `${target.x}m ${target.y}m ${target.z}m`;
}

function formatFieldOfView(degrees: number): string {
  return `${degrees}deg`;
}

/** Pick equivalent angle so interpolation takes the short arc after auto-rotate. */
function thetaNearCurrent(current: number, target: number): number {
  const tau = Math.PI * 2;
  let t = target;
  while (t - current > Math.PI) t -= tau;
  while (t - current < -Math.PI) t += tau;
  return t;
}

function createModelViewerElement(): ModelViewerElement {
  const element = document.createElement("model-viewer") as ModelViewerElement;
  element.id = "viewport";
  element.setAttribute("camera-controls", "");
  element.setAttribute("touch-action", "none");
  element.setAttribute("shadow-intensity", "1");
  element.setAttribute("exposure", "1");
  element.setAttribute("environment-image", "neutral");
  element.setAttribute("interaction-prompt", "none");
  /** Tap on empty space otherwise triggers recenter() → zoom all the way out. */
  element.setAttribute("disable-tap", "");
  element.setAttribute("ar-modes", "");
  element.setAttribute("zoom-sensitivity", ZOOM_SENSITIVITY);
  element.setAttribute("interpolation-decay", String(INTERPOLATION_DECAY_MS));
  element.setAttribute("min-camera-orbit", "auto auto 8%");
  element.setAttribute("max-camera-orbit", "auto auto 800%");
  element.disableZoom = false;
  return element;
}

function waitFrames(count: number): Promise<void> {
  return new Promise((resolve) => {
    let left = count;
    const tick = () => {
      if (--left <= 0) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const SETTLE_TIMEOUT_MS = 8_000;
const LOAD_POLL_MS = 100;
const LOAD_TIMEOUT_MS = 120_000;

/** Wait until orbit radius and FOV stop changing (post-load interpolation). */
async function waitForCameraSettled(mv: ModelViewerElement): Promise<void> {
  let lastRadius = Number.NaN;
  let lastFov = Number.NaN;
  let stableFrames = 0;
  const maxFrames = 72;
  for (let i = 0; i < maxFrames; i++) {
    const { radius } = mv.getCameraOrbit();
    const fov = mv.getFieldOfView();
    const radiusStable =
      Number.isFinite(lastRadius) && Math.abs(radius - lastRadius) < 1e-4;
    const fovStable = Number.isFinite(lastFov) && Math.abs(fov - lastFov) < 1e-3;
    if (radiusStable && fovStable) {
      if (++stableFrames >= 4) return;
    } else {
      stableFrames = 0;
    }
    lastRadius = radius;
    lastFov = fov;
    await waitFrames(1);
  }
}

/** Reset camera + turntable before loading another model on the same viewer. */
async function prepareModelSwap(mv: ModelViewerElement): Promise<void> {
  mv.resetTurntableRotation(0);
  mv.cameraTarget = "auto auto auto";
  mv.cameraOrbit = "auto auto auto";
  mv.fieldOfView = "auto";
  if (mv.src) {
    mv.src = null;
    await waitFrames(2);
  }
  mv.jumpCameraToGoal();
  await mv.updateComplete;
}

/** Handle shell and viewer wheel input once, without model-viewer's FOV/radius coupling. */
function bindWheelZoom(target: HTMLElement, viewport: ModelViewport): void {
  const onWheel = (e: WheelEvent) => {
    const mv = viewport.element;
    if (!mv.src || !mv.loaded || !Number.isFinite(e.deltaY) || e.deltaY === 0) return;
    e.preventDefault();
    e.stopPropagation();
    viewport.stepZoomFromWheel(e.deltaY, e.deltaMode);
  };
  target.addEventListener("wheel", onWheel, { passive: false, capture: true });
}

export class ModelViewport {
  private mv: ModelViewerElement;
  readonly host: HTMLElement;

  private savedCamera: SavedCamera | null = null;
  private framingInsets: ViewportInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  private fitInFlight = false;
  private loadGen = 0;
  private loadAbort?: AbortController;
  private cursorHidden = false;
  private presentationMode = false;
  private zoomGoalRadius: number | null = null;

  constructor(host: HTMLElement) {
    this.host = host;
    this.mv = createModelViewerElement();
    host.appendChild(this.mv);
    // Drag, pan, pinch and model-viewer's keyboard controls establish a new pose.
    host.addEventListener("pointerdown", () => this.clearZoomGoal(), { capture: true });
    host.addEventListener("keydown", () => this.clearZoomGoal(), { capture: true });
  }

  get element(): ModelViewerElement {
    return this.mv;
  }

  hasSavedCamera(): boolean {
    return this.savedCamera !== null;
  }

  exportSnapshot(): SavedCamera | null {
    return this.savedCamera ? { ...this.savedCamera } : null;
  }

  importSnapshot(snapshot: SavedCamera | null): void {
    this.savedCamera = snapshot ? { ...snapshot } : null;
  }

  /** Single wheel binding on the viewport panel (avoid duplicate handlers). */
  attachWheelSurface(surface: HTMLElement): void {
    bindWheelZoom(surface, this);
  }

  focus(): void {
    this.host.focus();
  }

  setFramingInsets(insets: ViewportInsets): void {
    this.framingInsets = insets;
  }

  /** Exhibition-style lighting and ground shadow when previewing a model. */
  setPresentationMode(enabled: boolean): void {
    if (this.presentationMode === enabled) return;
    this.presentationMode = enabled;
    applyScenePresentation(this.mv, enabled);
  }

  isPresentationMode(): boolean {
    return this.presentationMode;
  }

  /** Optional grid floor, center marker, and XYZ axes in model space. */
  syncSceneGuides(opts: SceneGuideSyncOptions, force = false): void {
    applySceneGuidesToModel(this.mv, opts, force);
  }

  /** Global tint and opacity overrides (non-destructive). */
  syncModelAppearance(opts: ModelAppearanceOptions, force = false): void {
    void applyModelAppearanceToModel(this.mv, opts, force);
  }

  /** Hide OS cursor over the viewer (cinema idle); pierces model-viewer shadow DOM. */
  setCursorHidden(hidden: boolean): void {
    this.cursorHidden = hidden;
    this.applyCursorHidden();
    if (hidden && !this.mv.shadowRoot) {
      void customElements.whenDefined("model-viewer").then(() => {
        if (this.cursorHidden) this.applyCursorHidden();
      });
    }
  }

  private applyCursorHidden(): void {
    const hidden = this.cursorHidden;
    const cursor = hidden ? "none" : "";
    this.host.style.cursor = cursor;
    this.mv.style.cursor = cursor;

    const root = this.mv.shadowRoot;
    if (!root) return;

    const styleId = "trivor-cursor-hide";
    const existing = root.getElementById(styleId);
    if (hidden) {
      if (existing) return;
      const style = document.createElement("style");
      style.id = styleId;
      style.textContent =
        ":host, canvas, .userInput, .container, slot { cursor: none !important; }";
      root.appendChild(style);
      return;
    }
    existing?.remove();
  }

  /** Fresh element — only way to fully drop the previous model's camera in WKWebView. */
  private replaceViewerElement(): void {
    this.mv.remove();
    this.mv = createModelViewerElement();
    this.host.appendChild(this.mv);
    this.applyCursorHidden();
  }

  async load(assetUrl: string, loadErrorMessage = "Failed to load model"): Promise<void> {
    this.clearZoomGoal();
    await customElements.whenDefined("model-viewer");
    this.loadAbort?.abort();
    const abort = new AbortController();
    this.loadAbort = abort;
    const gen = ++this.loadGen;
    this.savedCamera = null;

    if (this.mv.src && this.mv.src !== assetUrl) {
      await prepareModelSwap(this.mv);
    }
    if (gen !== this.loadGen || abort.signal.aborted) return;

    const mv = this.mv;

    const settle = async (): Promise<void> => {
      if (gen !== this.loadGen || mv !== this.mv || !mv.src) return;
      mv.resetTurntableRotation(0);
      try {
        await Promise.race([
          (async () => {
            await this.reframeToVisibleArea(mv);
            if (gen !== this.loadGen || mv !== this.mv || !mv.src) return;
            await waitForCameraSettled(mv);
          })(),
          waitMs(SETTLE_TIMEOUT_MS),
        ]);
      } catch {
        /* framing is best-effort */
      }
      if (gen !== this.loadGen || mv !== this.mv || !mv.src) return;
      this.captureInitialCamera();
      this.setPresentationMode(true);
    };

    try {
      await new Promise<void>((resolve, reject) => {
        let done = false;
        const finish = (fn: () => void) => {
          if (done) return;
          if (gen !== this.loadGen) {
            done = true;
            resolve();
            return;
          }
          done = true;
          fn();
        };
        let modelReady = false;
        const onReady = () => {
          if (modelReady) return;
          modelReady = true;
          void settle().finally(() => finish(resolve));
        };
        const onError = (event?: Event) => {
          const detail = event
            ? (event as CustomEvent<{ sourceError?: Error }>).detail?.sourceError
            : undefined;
          const reason = detail?.message?.trim();
          finish(() => reject(new Error(reason || loadErrorMessage)));
        };
        abort.signal.addEventListener("abort", () => finish(resolve), { once: true });
        mv.addEventListener("load", onReady, { once: true, signal: abort.signal });
        mv.addEventListener("error", onError, { once: true, signal: abort.signal });

        mv.src = assetUrl;

        void (async () => {
          const deadline = Date.now() + LOAD_TIMEOUT_MS;
          while (!done && !abort.signal.aborted && gen === this.loadGen) {
            if (mv === this.mv && mv.src === assetUrl && mv.loaded) {
              onReady();
              return;
            }
            if (Date.now() >= deadline) break;
            await waitMs(LOAD_POLL_MS);
          }
          if (!done && gen === this.loadGen && !abort.signal.aborted) {
            onError();
          }
        })();
      });
    } finally {
      if (this.loadAbort === abort) this.loadAbort = undefined;
    }
  }

  /** Drop the WebGL scene; recreating the element is reliable in WKWebView. */
  clear(): void {
    this.clearZoomGoal();
    this.loadAbort?.abort();
    this.loadAbort = undefined;
    this.loadGen++;
    this.savedCamera = null;
    this.presentationMode = false;
    resetSceneGuideSyncCache();
    resetModelAppearanceCache();
    this.replaceViewerElement();
  }

  /** Positive wheel delta moves away; equal opposite input restores the same distance. */
  stepZoomFromWheel(deltaY: number, deltaMode = 0): void {
    if (!Number.isFinite(deltaY) || deltaY === 0) return;
    const unit = deltaMode === 1 ? 18 : deltaMode === 2 ? Math.max(1, this.host.clientHeight) : 1;
    this.stepZoom(Math.exp(clamp(deltaY * unit * WHEEL_ZOOM_PER_PIXEL, -4, 4)));
  }

  private clearZoomGoal(): void {
    this.zoomGoalRadius = null;
  }

  private setZoomBounds(base: number): void {
    const min = `auto auto ${base * 0.15}m`;
    const max = `auto auto ${base * 5}m`;
    // model-viewer jumps to the goal when these attributes are assigned, even
    // to the same value. Configure them once, not on every wheel event.
    if (this.mv.getAttribute("min-camera-orbit") !== min) this.mv.setAttribute("min-camera-orbit", min);
    if (this.mv.getAttribute("max-camera-orbit") !== max) this.mv.setAttribute("max-camera-orbit", max);
  }

  /** Smooth zoom in/out with a fixed relative step (toolbar buttons). */
  stepZoom(factor: number): void {
    const mv = this.mv;
    if (!mv.src || !mv.loaded || !Number.isFinite(factor) || factor <= 0 || factor === 1) return;
    const base = this.savedCamera?.radiusM ?? mv.getCameraOrbit().radius;
    if (!Number.isFinite(base) || base <= 0) return;

    const current = mv.getCameraOrbit();
    const minR = base * 0.15;
    const maxR = base * 5;
    // Accumulate against the pending goal so rapid wheel events are not lost
    // while the camera is still interpolating. Keep its clamps in sync to avoid
    // accumulating an unreachable goal that delays reversing at a limit.
    const radius = clamp((this.zoomGoalRadius ?? current.radius) * factor, minR, maxR);
    this.zoomGoalRadius = radius;
    this.setZoomBounds(base);
    mv.cameraOrbit = formatOrbit({
      theta: current.theta,
      phi: current.phi,
      radius,
    });
  }

  zoomIn(): void {
    this.stepZoom(ZOOM_STEP);
  }

  zoomOut(): void {
    this.stepZoom(1 / ZOOM_STEP);
  }

  /** Re-frame to bounds (double-click / F). Does not change the stored initial pose. */
  async fit(): Promise<void> {
    if (this.fitInFlight || !this.mv.src) return;
    this.fitInFlight = true;
    try {
      await this.reframeToVisibleArea(this.mv);
    } finally {
      this.fitInFlight = false;
    }
  }

  /** Restore the pose captured when this model finished loading. */
  reset(): boolean {
    this.clearZoomGoal();
    const snap = this.savedCamera;
    if (!this.mv.src || !snap) return false;

    this.setAutoRotate(false);
    this.mv.resetTurntableRotation(snap.turntableYaw ?? 0);
    this.syncCameraAttributesFromState();

    requestAnimationFrame(() => {
      if (!this.mv.src || !this.savedCamera) return;
      this.applySavedCamera();
    });
    return true;
  }

  /** Mirror live camera into attributes so a new goal can interpolate (needed after auto-rotate). */
  private syncCameraAttributesFromState(): void {
    const mv = this.mv;
    if (!mv.src) return;
    const orbit = mv.getCameraOrbit();
    const target = mv.getCameraTarget();
    const fov = mv.getFieldOfView();
    mv.cameraTarget = formatTarget(target);
    if (Number.isFinite(fov) && fov > 0) {
      mv.fieldOfView = formatFieldOfView(fov);
    }
    mv.cameraOrbit = formatOrbit(orbit);
  }

  private async reframeToVisibleArea(mv: ModelViewerElement): Promise<void> {
    this.clearZoomGoal();
    mv.setAttribute("min-camera-orbit", "auto auto 8%");
    mv.setAttribute("max-camera-orbit", "auto auto 800%");
    mv.cameraTarget = "auto auto auto";
    mv.cameraOrbit = "auto auto auto";
    mv.fieldOfView = "auto";
    await mv.updateFraming();
    await mv.updateComplete;
    adjustCameraForViewportInsets(mv, this.framingInsets);
    mv.jumpCameraToGoal();
    this.setZoomBounds(this.savedCamera?.radiusM ?? mv.getCameraOrbit().radius);
  }

  private applySavedCamera(): void {
    const snap = this.savedCamera;
    const mv = this.mv;
    if (!snap || !mv.src) return;
    const current = mv.getCameraOrbit();
    mv.cameraTarget = formatTarget({
      x: snap.targetX,
      y: snap.targetY,
      z: snap.targetZ,
    });
    if (Number.isFinite(snap.fieldOfViewDeg) && snap.fieldOfViewDeg > 0) {
      mv.fieldOfView = formatFieldOfView(snap.fieldOfViewDeg);
    }
    mv.cameraOrbit = formatOrbit({
      theta: thetaNearCurrent(current.theta, snap.theta),
      phi: snap.phi,
      radius: snap.radiusM,
    });
  }

  isAutoRotateActive(): boolean {
    return this.mv.hasAttribute("auto-rotate");
  }

  setAutoRotate(enabled: boolean): void {
    const mv = this.mv;
    if (enabled) {
      mv.autoRotateDelay = AUTO_ROTATE_DELAY_MS;
      mv.setAttribute("auto-rotate-delay", String(AUTO_ROTATE_DELAY_MS));
      mv.setAttribute("auto-rotate", "");
      mv.setAttribute("rotation-per-second", AUTO_ROTATE_SPEED);
    } else {
      mv.removeAttribute("auto-rotate");
      mv.removeAttribute("rotation-per-second");
    }
  }

  /** Transparent PNG cropped to the model silhouette at the current camera angle. */
  async exportCutout(
    guideOpts: SceneGuideSyncOptions,
    options?: CutoutExportOptions,
  ): Promise<Uint8Array> {
    return exportCutoutPng({
      mv: this.mv,
      guideOpts,
      syncGuides: (opts) => applySceneGuidesToModel(this.mv, opts),
      getPresentation: () => this.presentationMode,
      setPresentation: (enabled) => this.setPresentationMode(enabled),
      options,
    });
  }

  private captureInitialCamera(): void {
    const mv = this.mv;
    const orbit = mv.getCameraOrbit();
    const fov = mv.getFieldOfView();
    if (!Number.isFinite(orbit.radius) || orbit.radius <= 0) return;
    if (!Number.isFinite(fov) || fov <= 0) return;
    const target = mv.getCameraTarget();
    this.savedCamera = {
      targetX: target.x,
      targetY: target.y,
      targetZ: target.z,
      theta: orbit.theta,
      phi: orbit.phi,
      radiusM: orbit.radius,
      fieldOfViewDeg: fov,
      turntableYaw: mv.turntableRotation,
    };
    this.setZoomBounds(orbit.radius);
  }
}
