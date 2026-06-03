import { measureCutoutFrameBounds } from "./cutout-display-capture";
import { DEFAULT_CUTOUT_OPTIONS } from "./cutout-export";
import { getWebGLCanvas, type ModelViewerCaptureHost } from "./model-scene-access";

export type CutoutFrameGuideDeps = {
  getModelViewer: () => ModelViewerCaptureHost | null;
};

export class CutoutFrameGuide {
  private readonly overlay: HTMLElement;
  private enabled = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private updateGen = 0;
  private measuring = false;
  private boundMv: ModelViewerCaptureHost | null = null;
  private cameraListenerAttached = false;
  private readonly onCameraChange = () => this.scheduleUpdate(120);

  constructor(
    private readonly viewportHost: HTMLElement,
    private readonly deps: CutoutFrameGuideDeps,
  ) {
    this.overlay = document.createElement("div");
    this.overlay.className = "cutout-frame-guide hidden";
    this.overlay.setAttribute("aria-hidden", "true");
    viewportHost.appendChild(this.overlay);
  }

  bind(): void {
    window.addEventListener("resize", () => this.scheduleUpdate(120));
  }

  private bindModelViewer(mv: ModelViewerCaptureHost | null): void {
    if (this.boundMv === mv && (mv == null) === !this.cameraListenerAttached) return;
    if (this.boundMv && this.cameraListenerAttached) {
      this.boundMv.removeEventListener("camera-change", this.onCameraChange);
      this.cameraListenerAttached = false;
    }
    this.boundMv = mv;
    if (mv) {
      mv.addEventListener("camera-change", this.onCameraChange);
      this.cameraListenerAttached = true;
    }
  }

  setVisible(visible: boolean): void {
    if (this.enabled === visible) {
      if (visible) this.bindModelViewer(this.deps.getModelViewer());
      return;
    }
    this.enabled = visible;
    if (!visible) {
      this.bindModelViewer(null);
      this.cancelSchedule();
      this.overlay.classList.add("hidden");
      return;
    }
    this.bindModelViewer(this.deps.getModelViewer());
    this.scheduleUpdate(200);
  }

  scheduleUpdate(debounceMs = 120): void {
    if (!this.enabled) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.update();
    }, debounceMs);
  }

  cancelSchedule(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.updateGen++;
  }

  private async update(): Promise<void> {
    if (!this.enabled || this.measuring) return;
    const mv = this.deps.getModelViewer();
    if (!mv?.loaded) {
      this.overlay.classList.add("hidden");
      return;
    }

    const gen = ++this.updateGen;
    this.measuring = true;
    try {
      const bounds = await measureCutoutFrameBounds(mv);
      if (gen !== this.updateGen || !this.enabled) return;
      if (!bounds) {
        this.overlay.classList.add("hidden");
        return;
      }

      const canvas = getWebGLCanvas(mv);
      if (!canvas) {
        this.overlay.classList.add("hidden");
        return;
      }

      const canvasRect = canvas.getBoundingClientRect();
      const hostRect = this.viewportHost.getBoundingClientRect();
      if (canvasRect.width < 1 || canvasRect.height < 1) {
        this.overlay.classList.add("hidden");
        return;
      }

      const scaleX = canvasRect.width / canvas.width;
      const scaleY = canvasRect.height / canvas.height;
      const pad = DEFAULT_CUTOUT_OPTIONS.paddingPx;

      const left = canvasRect.left - hostRect.left + bounds.minX * scaleX - pad;
      const top = canvasRect.top - hostRect.top + bounds.minY * scaleY - pad;
      const width = (bounds.maxX - bounds.minX + 1) * scaleX + pad * 2;
      const height = (bounds.maxY - bounds.minY + 1) * scaleY + pad * 2;

      this.overlay.style.left = `${Math.max(0, left)}px`;
      this.overlay.style.top = `${Math.max(0, top)}px`;
      this.overlay.style.width = `${Math.max(1, width)}px`;
      this.overlay.style.height = `${Math.max(1, height)}px`;
      this.overlay.classList.remove("hidden");
    } catch {
      if (gen === this.updateGen) this.overlay.classList.add("hidden");
    } finally {
      this.measuring = false;
    }
  }
}
