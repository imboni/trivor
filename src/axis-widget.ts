import { $scene } from "@google/model-viewer/lib/model-viewer-base.js";
import type { ModelScene } from "@google/model-viewer/lib/three-components/ModelScene.js";
import { Quaternion, Vector3 } from "three";
import { readSceneTheme } from "./scene-theme";

const BASIS = [
  new Vector3(1, 0, 0),
  new Vector3(0, 1, 0),
  new Vector3(0, 0, 1),
];

type ModelViewerLike = {
  loaded: boolean;
  src: string | null;
};

type ProjectedAxis = {
  id: string;
  color: string;
  x: number;
  y: number;
  depth: number;
};

export class AxisOrientationWidget {
  private readonly svg: SVGSVGElement;
  private rafId = 0;
  private active = false;
  private renderedAxes: string | null = null;

  constructor(
    private readonly host: HTMLElement,
    private readonly getViewer: () => ModelViewerLike | null,
  ) {
    this.svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.svg.setAttribute("viewBox", "-36 -36 72 72");
    this.svg.setAttribute("aria-hidden", "true");
    this.svg.classList.add("axis-widget-svg");
    this.host.appendChild(this.svg);
  }

  setActive(next: boolean): void {
    if (this.active === next) return;
    this.active = next;
    this.host.classList.toggle("is-visible", next);
    this.host.setAttribute("aria-hidden", next ? "false" : "true");
    if (next) this.start();
    else this.stop();
  }

  private start(): void {
    if (this.rafId) return;
    const tick = (): void => {
      if (!this.active) return;
      this.draw();
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stop(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.clearDrawing();
  }

  private clearDrawing(): void {
    if (this.renderedAxes === null) return;
    this.svg.replaceChildren();
    this.renderedAxes = null;
  }

  private draw(): void {
    const mv = this.getViewer();
    if (!mv?.src || !mv.loaded) {
      this.clearDrawing();
      return;
    }

    const theme = readSceneTheme();
    const axes = projectModelAxes(mv, theme);
    if (!axes) {
      this.clearDrawing();
      return;
    }

    const sorted = axes.sort((a, b) => a.depth - b.depth).map((axis) => ({
      id: axis.id,
      color: axis.color,
      x: axis.x.toFixed(2),
      y: axis.y.toFixed(2),
      labelX: (axis.x * 1.2).toFixed(2),
      labelY: (axis.y * 1.2).toFixed(2),
      opacity: (axis.depth > 0 ? theme.axisWidgetFront : theme.axisWidgetBack).toFixed(2),
    }));
    // Pure zoom and idle frames leave the projected axes unchanged. Compare
    // the exact displayed values, including depth order and theme colors.
    const renderedAxes = JSON.stringify(sorted);
    if (renderedAxes === this.renderedAxes) return;
    const frag = document.createDocumentFragment();

    const ring = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    ring.setAttribute("cx", "0");
    ring.setAttribute("cy", "0");
    ring.setAttribute("r", "30");
    ring.setAttribute("fill", "none");
    ring.setAttribute("class", "axis-widget-ring");
    frag.appendChild(ring);

    const hub = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    hub.setAttribute("cx", "0");
    hub.setAttribute("cy", "0");
    hub.setAttribute("r", "2.2");
    hub.setAttribute("class", "axis-widget-hub");
    frag.appendChild(hub);

    for (const axis of sorted) {
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", "0");
      line.setAttribute("y1", "0");
      line.setAttribute("x2", axis.x);
      line.setAttribute("y2", axis.y);
      line.setAttribute("stroke", axis.color);
      line.setAttribute("stroke-width", "2.4");
      line.setAttribute("stroke-linecap", "round");
      line.setAttribute("opacity", axis.opacity);
      frag.appendChild(line);

      const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
      label.setAttribute("x", axis.labelX);
      label.setAttribute("y", axis.labelY);
      label.setAttribute("fill", axis.color);
      label.setAttribute("opacity", axis.opacity);
      label.setAttribute("class", "axis-widget-label");
      label.textContent = axis.id.toUpperCase();
      frag.appendChild(label);
    }

    this.svg.replaceChildren(frag);
    this.renderedAxes = renderedAxes;
  }
}

function projectModelAxes(
  mv: ModelViewerLike,
  theme: ReturnType<typeof readSceneTheme>,
): ProjectedAxis[] | null {
  const modelScene = getModelScene(mv);
  if (!modelScene) return null;

  // Only these objects and their ancestors determine the orientation widget.
  // Traversing target's descendants would update the entire model every frame.
  modelScene.camera.updateWorldMatrix(true, false);
  modelScene.target.updateWorldMatrix(true, false);

  const right = new Vector3();
  const up = new Vector3();
  const forward = new Vector3();
  modelScene.camera.getWorldDirection(forward);
  right.setFromMatrixColumn(modelScene.camera.matrixWorld, 0).normalize();
  up.setFromMatrixColumn(modelScene.camera.matrixWorld, 1).normalize();

  const worldQuat = new Quaternion();
  modelScene.target.getWorldQuaternion(worldQuat);

  const axisColors = [
    { id: "x", color: theme.axisWidgetX },
    { id: "y", color: theme.axisWidgetY },
    { id: "z", color: theme.axisWidgetZ },
  ];

  const arm = 24;
  return axisColors.map(({ id, color }, index) => {
    const dir = BASIS[index]!.clone().applyQuaternion(worldQuat).normalize();
    const sx = dir.dot(right);
    const sy = -dir.dot(up);
    const depth = dir.dot(forward);
    const len = Math.hypot(sx, sy);
    const scale = len > 0.08 ? arm / len : arm;
    return {
      id,
      color,
      x: sx * scale,
      y: sy * scale,
      depth,
    };
  });
}

function getModelScene(mv: ModelViewerLike): ModelScene | null {
  const internal = mv as unknown as Record<symbol, ModelScene | undefined>;
  return internal[$scene] ?? null;
}
