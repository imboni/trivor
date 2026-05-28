import "@google/model-viewer";

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
}

/** ~12% radius change per toolbar click. */
const ZOOM_STEP = 0.88;
/** Default is 50ms; keep low so drag / pinch zoom feels immediate. */
const INTERPOLATION_DECAY_MS = 55;
/** Scale forwarded wheel delta (model-viewer default zoom is aggressive in WKWebView). */
const WHEEL_DELTA_SCALE = 0.55;
/** model-viewer attribute; default is 1. */
const ZOOM_SENSITIVITY = "0.82";
const AUTO_ROTATE_SPEED = "28deg";
const AUTO_ROTATE_DELAY_MS = 0;

export interface SavedCamera {
  targetX: number;
  targetY: number;
  targetZ: number;
  theta: number;
  phi: number;
  radiusM: number;
  /** Degrees; wheel zoom couples FOV with orbit radius in model-viewer. */
  fieldOfViewDeg: number;
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

function wheelInput(mv: ModelViewerElement): HTMLElement | null {
  return mv.shadowRoot?.querySelector<HTMLElement>(".userInput") ?? null;
}

function forwardWheel(mv: ModelViewerElement, source: WheelEvent): void {
  const input = wheelInput(mv);
  if (!input) return;
  input.dispatchEvent(
    new WheelEvent("wheel", {
      deltaY: source.deltaY * WHEEL_DELTA_SCALE,
      deltaX: source.deltaX * WHEEL_DELTA_SCALE,
      deltaMode: source.deltaMode,
      clientX: source.clientX,
      clientY: source.clientY,
      ctrlKey: source.ctrlKey,
      metaKey: source.metaKey,
      bubbles: true,
      cancelable: true,
    }),
  );
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

/** Wait until orbit radius and FOV stop changing (post-load interpolation). */
async function waitForCameraSettled(mv: ModelViewerElement): Promise<void> {
  let lastRadius = Number.NaN;
  let lastFov = Number.NaN;
  let stableFrames = 0;
  for (let i = 0; i < 90; i++) {
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

/** WKWebView eats wheel on the shell — forward to model-viewer's `.userInput` layer. */
function bindWheelZoom(target: HTMLElement, viewport: ModelViewport): void {
  const onWheel = (e: WheelEvent) => {
    const mv = viewport.element;
    if (!mv.src) return;
    e.preventDefault();
    e.stopPropagation();
    const input = wheelInput(mv);
    if (input) {
      forwardWheel(mv, e);
    } else {
      viewport.stepZoomFromWheel(e.deltaY);
    }
  };
  target.addEventListener("wheel", onWheel, { passive: false, capture: true });
}

export class ModelViewport {
  private mv: ModelViewerElement;
  readonly host: HTMLElement;

  private savedCamera: SavedCamera | null = null;
  private loadGen = 0;

  constructor(host: HTMLElement) {
    this.host = host;
    this.mv = createModelViewerElement();
    host.appendChild(this.mv);
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

  async load(assetUrl: string, loadErrorMessage = "Failed to load model"): Promise<void> {
    await customElements.whenDefined("model-viewer");
    const gen = ++this.loadGen;
    const mv = this.mv;

    const settle = async (): Promise<void> => {
      if (gen !== this.loadGen || !mv.src) return;
      await mv.updateFraming();
      await mv.updateComplete;
      if (gen !== this.loadGen || !mv.src) return;
      await waitForCameraSettled(mv);
      if (gen !== this.loadGen || !mv.src) return;
      this.captureInitialCamera();
    };

    this.savedCamera = null;
    mv.src = assetUrl;

    await new Promise<void>((resolve, reject) => {
      const onLoad = () => {
        void settle().then(resolve);
      };
      const onError = () => reject(new Error(loadErrorMessage));
      mv.addEventListener("load", onLoad, { once: true });
      mv.addEventListener("error", onError, { once: true });
    });
  }

  /** Drop the WebGL scene; recreating the element is reliable in WKWebView. */
  clear(): void {
    this.loadGen++;
    this.savedCamera = null;
    this.mv.remove();
    this.mv = createModelViewerElement();
    this.host.appendChild(this.mv);
  }

  /** Continuous zoom from wheel delta when shadow `.userInput` is unavailable. */
  stepZoomFromWheel(deltaY: number): void {
    const scaled = deltaY * WHEEL_DELTA_SCALE;
    const magnitude = clamp(Math.abs(scaled) / 140, 0.35, 2.2);
    const factor = scaled > 0 ? 0.93 ** magnitude : 1.07 ** magnitude;
    this.stepZoom(factor);
  }

  /** Smooth zoom in/out with a fixed relative step (toolbar buttons). */
  stepZoom(factor: number): void {
    const mv = this.mv;
    if (!mv.src) return;
    const base = this.savedCamera?.radiusM ?? mv.getCameraOrbit().radius;
    if (!Number.isFinite(base) || base <= 0) return;

    const current = mv.getCameraOrbit();
    const minR = base * 0.15;
    const maxR = base * 5;
    const radius = clamp(current.radius * factor, minR, maxR);
    if (Math.abs(radius - current.radius) < 1e-6) return;
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
    const mv = this.mv;
    if (!mv.src) return;
    mv.cameraTarget = "auto auto auto";
    await mv.updateFraming();
  }

  /** Restore the pose captured when this model finished loading. */
  reset(): boolean {
    if (!this.mv.src || !this.savedCamera) return false;
    this.applySavedCamera();
    return true;
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

  private applySavedCamera(): void {
    const snap = this.savedCamera;
    const mv = this.mv;
    if (!snap || !mv.src) return;
    mv.cameraTarget = formatTarget({
      x: snap.targetX,
      y: snap.targetY,
      z: snap.targetZ,
    });
    if (Number.isFinite(snap.fieldOfViewDeg) && snap.fieldOfViewDeg > 0) {
      mv.fieldOfView = formatFieldOfView(snap.fieldOfViewDeg);
    }
    mv.cameraOrbit = formatOrbit({
      theta: snap.theta,
      phi: snap.phi,
      radius: snap.radiusM,
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
    };
  }
}
