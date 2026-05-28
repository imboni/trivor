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
  getCameraOrbit(): SphericalPosition;
  getCameraTarget(): Vector3D;
  updateFraming(): Promise<void>;
}

/** ~12% radius change per toolbar click. */
const ZOOM_STEP = 0.88;
/** Default is 50ms; keep low so drag / pinch zoom feels immediate. */
const INTERPOLATION_DECAY_MS = 55;
/** Scale forwarded wheel delta (model-viewer default zoom is aggressive in WKWebView). */
const WHEEL_DELTA_SCALE = 0.55;
/** model-viewer attribute; default is 1. */
const ZOOM_SENSITIVITY = "0.82";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatOrbit(orbit: SphericalPosition): string {
  return `${orbit.theta}rad ${orbit.phi}rad ${orbit.radius}m`;
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
  readonly element: ModelViewerElement;
  readonly host: HTMLElement;

  private initialOrbit = "0deg 75deg 105%";
  private initialTarget = "auto auto auto";
  private initialRadius = 1;

  constructor(host: HTMLElement) {
    this.host = host;
    this.element = document.createElement("model-viewer") as ModelViewerElement;
    this.element.id = "viewport";
    this.element.setAttribute("camera-controls", "");
    this.element.setAttribute("touch-action", "none");
    this.element.setAttribute("shadow-intensity", "1");
    this.element.setAttribute("exposure", "1");
    this.element.setAttribute("environment-image", "neutral");
    this.element.setAttribute("interaction-prompt", "none");
    /** Tap on empty space otherwise triggers recenter() → zoom all the way out. */
    this.element.setAttribute("disable-tap", "");
    this.element.setAttribute("ar-modes", "");
    this.element.setAttribute("zoom-sensitivity", ZOOM_SENSITIVITY);
    this.element.setAttribute("interpolation-decay", String(INTERPOLATION_DECAY_MS));
    this.element.setAttribute("min-camera-orbit", "auto auto 8%");
    this.element.setAttribute("max-camera-orbit", "auto auto 800%");
    this.element.disableZoom = false;
    host.appendChild(this.element);
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
    if (this.element.getAttribute("src") === assetUrl) {
      await this.element.updateFraming();
      this.captureInitialCamera();
      return;
    }
    this.element.src = assetUrl;
    await new Promise<void>((resolve, reject) => {
      const onLoad = () => {
        void this.element.updateFraming().then(() => {
          requestAnimationFrame(() => {
            this.captureInitialCamera();
            resolve();
          });
        });
      };
      const onError = () => reject(new Error(loadErrorMessage));
      this.element.addEventListener("load", onLoad, { once: true });
      this.element.addEventListener("error", onError, { once: true });
    });
  }

  clear(): void {
    this.element.removeAttribute("src");
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
    if (!this.element.src) return;
    const current = this.element.getCameraOrbit();
    const minR = this.initialRadius * 0.15;
    const maxR = this.initialRadius * 5;
    const radius = clamp(current.radius * factor, minR, maxR);
    if (Math.abs(radius - current.radius) < 1e-6) return;
    this.element.cameraOrbit = formatOrbit({
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

  /** Re-frame to bounds (double-click / F). Uses damped interpolation, no jump. */
  async fit(): Promise<void> {
    this.element.cameraTarget = "auto auto auto";
    await this.element.updateFraming();
  }

  /** Return to the camera pose captured right after this model finished loading. */
  reset(): void {
    this.element.cameraTarget = this.initialTarget;
    this.element.cameraOrbit = this.initialOrbit;
  }

  private captureInitialCamera(): void {
    const orbit = this.element.getCameraOrbit();
    this.initialRadius = orbit.radius;
    this.initialOrbit =
      this.element.cameraOrbit?.trim() || formatOrbit(orbit);
    this.initialTarget =
      this.element.cameraTarget?.trim() || this.element.getCameraTarget().toString();
  }
}
