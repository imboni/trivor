type CutoutPreviewPanelOptions = {
  backdrop: HTMLElement;
  panel: HTMLElement;
  header: HTMLElement;
  stage: HTMLElement;
  viewport: HTMLElement;
  image: HTMLImageElement;
  resizeHandle: HTMLElement;
  resetButton: HTMLElement;
  meta: HTMLElement;
};

type DragMode = "panel" | "resize" | "pan";

const MIN_PANEL_W = 360;
const MIN_PANEL_H = 320;
const MIN_SCALE = 0.25;
const MAX_SCALE = 8;
const BACKDROP_PAD = 24;
const STAGE_PAD = 40;
const ZOOM_EPSILON = 0.01;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function backdropContentBox(backdrop: HTMLElement): { width: number; height: number } {
  const rect = backdrop.getBoundingClientRect();
  return {
    width: Math.max(0, rect.width - BACKDROP_PAD * 2),
    height: Math.max(0, rect.height - BACKDROP_PAD * 2),
  };
}

export class CutoutPreviewPanel {
  private scale = 1;
  private panX = 0;
  private panY = 0;
  private panelLeft = 0;
  private panelTop = 0;
  private panelWidth = 0;
  private panelHeight = 0;
  private layoutReady = false;
  private dimensions = "";
  private loadGeneration = 0;
  private layoutRaf = 0;
  private transformRaf = 0;
  private drag: {
    pointerId: number;
    mode: DragMode;
    target: HTMLElement;
    startX: number;
    startY: number;
    originLeft: number;
    originTop: number;
    originWidth: number;
    originHeight: number;
    originPanX: number;
    originPanY: number;
  } | null = null;

  private readonly onPointerMove = (e: PointerEvent) => this.handlePointerMove(e);
  private readonly onPointerUp = (e: PointerEvent) => this.handlePointerUp(e);

  constructor(private readonly opts: CutoutPreviewPanelOptions) {}

  bind(): void {
    const { header, stage, resizeHandle, resetButton } = this.opts;

    header.addEventListener("pointerdown", (e) => this.onHeaderPointerDown(e));
    resizeHandle.addEventListener("pointerdown", (e) => this.onResizePointerDown(e));
    stage.addEventListener("pointerdown", (e) => this.onStagePointerDown(e));
    stage.addEventListener("wheel", (e) => this.onStageWheel(e), { passive: false });
    stage.addEventListener("dblclick", (e) => {
      e.preventDefault();
      this.resetView();
    });
    resetButton.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.resetPreview();
    });

    window.addEventListener(
      "resize",
      () => {
        if (this.opts.backdrop.classList.contains("hidden")) return;
        this.scheduleLayout();
      },
      { passive: true },
    );
  }

  /** Full teardown when the preview flow closes. */
  reset(): void {
    this.loadGeneration++;
    this.scale = 1;
    this.panX = 0;
    this.panY = 0;
    this.panelLeft = 0;
    this.panelTop = 0;
    this.panelWidth = 0;
    this.panelHeight = 0;
    this.layoutReady = false;
    this.dimensions = "";
    this.endDrag();
    this.clearPanelGeometry();
    this.opts.image.removeAttribute("src");
    this.opts.image.onload = null;
    this.updateMeta();
    this.applyViewTransform(true);
  }

  /** User-triggered reset: view zoom/pan and panel size/position. */
  resetPreview(): void {
    this.resetView();
    this.panelWidth = 0;
    this.panelHeight = 0;
    this.layoutReady = false;
    this.scheduleLayout();
  }

  show(imageUrl: string): void {
    const gen = ++this.loadGeneration;
    this.resetView();
    this.panelWidth = 0;
    this.panelHeight = 0;
    this.layoutReady = false;
    this.opts.image.onload = () => {
      if (gen !== this.loadGeneration) return;
      const w = this.opts.image.naturalWidth;
      const h = this.opts.image.naturalHeight;
      this.dimensions = w > 0 && h > 0 ? `${w} × ${h} px` : "";
      this.updateMeta();
      this.scheduleLayout();
    };
    this.opts.image.src = imageUrl;
    this.scheduleLayout();
  }

  scheduleLayout(): void {
    if (this.layoutRaf) cancelAnimationFrame(this.layoutRaf);
    this.layoutRaf = requestAnimationFrame(() => {
      this.layoutRaf = 0;
      if (this.opts.backdrop.classList.contains("hidden")) return;
      this.layout();
    });
  }

  private layout(): void {
    if (this.layoutReady && this.panelWidth > 0 && this.panelHeight > 0) {
      this.clampPanelToBackdrop();
      return;
    }
    this.centerPanel();
  }

  private clearPanelGeometry(): void {
    const { panel } = this.opts;
    panel.style.left = "";
    panel.style.top = "";
    panel.style.width = "";
    panel.style.height = "";
    this.layoutReady = false;
  }

  private centerPanel(): void {
    const { panel } = this.opts;
    this.clearPanelGeometry();

    const content = backdropContentBox(this.opts.backdrop);
    const panelRect = panel.getBoundingClientRect();
    if (panelRect.width <= 0 || panelRect.height <= 0 || content.width <= 0 || content.height <= 0) {
      return;
    }

    this.panelWidth = clamp(panelRect.width, MIN_PANEL_W, content.width);
    this.panelHeight = clamp(panelRect.height, MIN_PANEL_H, content.height);
    this.panelLeft = Math.max(0, (content.width - this.panelWidth) / 2);
    this.panelTop = Math.max(0, (content.height - this.panelHeight) / 2);
    this.applyPanelGeometry();
  }

  private applyPanelGeometry(): void {
    const { panel } = this.opts;
    panel.style.left = `${this.panelLeft}px`;
    panel.style.top = `${this.panelTop}px`;
    panel.style.width = `${this.panelWidth}px`;
    panel.style.height = `${this.panelHeight}px`;
    this.layoutReady = true;
  }

  private clampPanelToBackdrop(): void {
    const content = backdropContentBox(this.opts.backdrop);
    if (content.width <= 0 || content.height <= 0) return;

    const maxW = Math.max(MIN_PANEL_W, content.width);
    const maxH = Math.max(MIN_PANEL_H, content.height);
    this.panelWidth = clamp(this.panelWidth, MIN_PANEL_W, maxW);
    this.panelHeight = clamp(this.panelHeight, MIN_PANEL_H, maxH);
    this.panelLeft = clamp(this.panelLeft, 0, Math.max(0, content.width - this.panelWidth));
    this.panelTop = clamp(this.panelTop, 0, Math.max(0, content.height - this.panelHeight));
    this.applyPanelGeometry();
  }

  private syncPanelGeometryFromDom(): void {
    const { panel, backdrop } = this.opts;
    const panelRect = panel.getBoundingClientRect();
    const backdropRect = backdrop.getBoundingClientRect();
    if (panelRect.width <= 0 || panelRect.height <= 0) return;

    this.panelWidth = panelRect.width;
    this.panelHeight = panelRect.height;
    this.panelLeft = panelRect.left - backdropRect.left - BACKDROP_PAD;
    this.panelTop = panelRect.top - backdropRect.top - BACKDROP_PAD;
    this.applyPanelGeometry();
  }

  private onHeaderPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button, a, input, select, textarea")) return;

    e.preventDefault();
    this.syncPanelGeometryFromDom();
    this.beginDrag("panel", this.opts.header, e);
  }

  private onResizePointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    this.syncPanelGeometryFromDom();
    this.beginDrag("resize", this.opts.resizeHandle, e);
  }

  private onStagePointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("[data-action=cutout-preview-reset]")) return;
    if (this.scale <= 1 + ZOOM_EPSILON) return;

    e.preventDefault();
    e.stopPropagation();
    this.beginDrag("pan", this.opts.stage, e);
  }

  private onStageWheel(e: WheelEvent): void {
    e.preventDefault();
    const rect = this.opts.stage.getBoundingClientRect();
    const localX = e.clientX - rect.left - rect.width / 2;
    const localY = e.clientY - rect.top - rect.height / 2;
    const factor = Math.exp(-e.deltaY * 0.0015);
    const nextScale = clamp(this.scale * factor, MIN_SCALE, MAX_SCALE);
    const ratio = nextScale / this.scale;
    this.panX = localX - (localX - this.panX) * ratio;
    this.panY = localY - (localY - this.panY) * ratio;
    this.scale = nextScale;
    this.clampPan();
    this.scheduleViewTransform();
    this.updateMeta();
  }

  private beginDrag(mode: DragMode, target: HTMLElement, e: PointerEvent): void {
    this.endDrag();
    this.drag = {
      pointerId: e.pointerId,
      mode,
      target,
      startX: e.clientX,
      startY: e.clientY,
      originLeft: this.panelLeft,
      originTop: this.panelTop,
      originWidth: this.panelWidth,
      originHeight: this.panelHeight,
      originPanX: this.panX,
      originPanY: this.panY,
    };
    target.addEventListener("pointermove", this.onPointerMove);
    target.addEventListener("pointerup", this.onPointerUp);
    target.addEventListener("pointercancel", this.onPointerUp);
    target.setPointerCapture(e.pointerId);
    if (mode === "pan") {
      this.opts.stage.classList.add("is-panning", "is-interacting");
      this.opts.viewport.classList.add("is-interacting");
    }
  }

  private handlePointerMove(e: PointerEvent): void {
    if (!this.drag || e.pointerId !== this.drag.pointerId) return;

    const dx = e.clientX - this.drag.startX;
    const dy = e.clientY - this.drag.startY;

    if (this.drag.mode === "panel") {
      this.panelLeft = this.drag.originLeft + dx;
      this.panelTop = this.drag.originTop + dy;
      this.clampPanelToBackdrop();
      return;
    }

    if (this.drag.mode === "resize") {
      const content = backdropContentBox(this.opts.backdrop);
      const maxW = Math.max(MIN_PANEL_W, content.width - this.panelLeft);
      const maxH = Math.max(MIN_PANEL_H, content.height - this.panelTop);
      this.panelWidth = clamp(this.drag.originWidth + dx, MIN_PANEL_W, maxW);
      this.panelHeight = clamp(this.drag.originHeight + dy, MIN_PANEL_H, maxH);
      this.applyPanelGeometry();
      return;
    }

    this.panX = this.drag.originPanX + dx;
    this.panY = this.drag.originPanY + dy;
    this.clampPan();
    this.scheduleViewTransform();
  }

  private handlePointerUp(e: PointerEvent): void {
    if (!this.drag || e.pointerId !== this.drag.pointerId) return;
    this.endDrag();
  }

  private endDrag(): void {
    if (!this.drag) return;
    const { target, pointerId } = this.drag;
    target.removeEventListener("pointermove", this.onPointerMove);
    target.removeEventListener("pointerup", this.onPointerUp);
    target.removeEventListener("pointercancel", this.onPointerUp);
    if (target.hasPointerCapture(pointerId)) {
      target.releasePointerCapture(pointerId);
    }
    this.drag = null;
    this.opts.stage.classList.remove("is-panning", "is-interacting");
    this.opts.viewport.classList.remove("is-interacting");
  }

  private resetView(): void {
    this.scale = 1;
    this.panX = 0;
    this.panY = 0;
    this.applyViewTransform(true);
    this.updateMeta();
  }

  private fittedImageSize(): { width: number; height: number } {
    const stageRect = this.opts.stage.getBoundingClientRect();
    const availW = Math.max(0, stageRect.width - STAGE_PAD);
    const availH = Math.max(0, stageRect.height - STAGE_PAD);
    const nw = this.opts.image.naturalWidth;
    const nh = this.opts.image.naturalHeight;
    if (nw <= 0 || nh <= 0 || availW <= 0 || availH <= 0) {
      return { width: availW, height: availH };
    }
    const fit = Math.min(availW / nw, availH / nh, 1);
    return { width: nw * fit, height: nh * fit };
  }

  private clampPan(): void {
    if (this.scale <= 1 + ZOOM_EPSILON) {
      this.panX = 0;
      this.panY = 0;
      return;
    }
    const fitted = this.fittedImageSize();
    const maxPanX = Math.max(0, (fitted.width * this.scale - fitted.width) / 2);
    const maxPanY = Math.max(0, (fitted.height * this.scale - fitted.height) / 2);
    this.panX = clamp(this.panX, -maxPanX, maxPanX);
    this.panY = clamp(this.panY, -maxPanY, maxPanY);
  }

  private scheduleViewTransform(): void {
    if (this.transformRaf) return;
    this.transformRaf = requestAnimationFrame(() => {
      this.transformRaf = 0;
      this.applyViewTransform(false);
    });
  }

  private applyViewTransform(force = false): void {
    const { viewport, stage } = this.opts;
    viewport.style.transform = `translate3d(${this.panX}px, ${this.panY}px, 0) scale(${this.scale})`;
    const zoomed =
      this.scale > 1 + ZOOM_EPSILON || Math.abs(this.panX) > 1 || Math.abs(this.panY) > 1;
    if (force || stage.classList.contains("is-zoomed") !== zoomed) {
      stage.classList.toggle("is-zoomed", zoomed);
    }
  }

  private updateMeta(): void {
    const zoomLabel = this.scale > 1 + ZOOM_EPSILON ? ` · ${Math.round(this.scale * 100)}%` : "";
    const next = this.dimensions ? `${this.dimensions}${zoomLabel}` : "";
    if (this.opts.meta.textContent !== next) {
      this.opts.meta.textContent = next;
    }
  }
}