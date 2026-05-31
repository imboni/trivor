/** Obstruction margins used when framing the camera (canvas stays full size). */

import { $scene } from "@google/model-viewer/lib/model-viewer-base.js";
import type { ModelScene } from "@google/model-viewer/lib/three-components/ModelScene.js";
import { Vector3 } from "three";

export type ViewportFramingContext = {
  cinemaMode: boolean;
  showDock: boolean;
  hasLibrary: boolean;
  explorerCollapsed: boolean;
  showInspector: boolean;
  inspectorCollapsed: boolean;
  showInspectorTab: boolean;
  showAxisWidget: boolean;
};

export type ViewportInsets = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

const EDGE_PAD = 14;

function parseCssPx(value: string): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

function visibleRect(el: Element | null): DOMRect | null {
  if (!el) return null;
  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return null;
  const rect = el.getBoundingClientRect();
  if (rect.width < 1 && rect.height < 1) return null;
  return rect;
}

function overlapsVertically(a: DOMRect, b: DOMRect): boolean {
  return a.bottom > b.top + 8 && a.top < b.bottom - 8;
}

function overlapsHorizontally(a: DOMRect, b: DOMRect): boolean {
  return a.right > b.left + 8 && a.left < b.right - 8;
}

export function measureViewportInsets(
  host: HTMLElement,
  shell: HTMLElement,
  ctx: ViewportFramingContext,
): ViewportInsets {
  const hostRect = host.getBoundingClientRect();
  let top = EDGE_PAD;
  let right = EDGE_PAD;
  let bottom = EDGE_PAD;
  let left = EDGE_PAD;

  const extendLeft = (rect: DOMRect | null): void => {
    if (!rect || !overlapsVertically(rect, hostRect)) return;
    left = Math.max(left, Math.ceil(rect.right - hostRect.left + EDGE_PAD));
  };

  const extendRight = (rect: DOMRect | null): void => {
    if (!rect || !overlapsVertically(rect, hostRect)) return;
    right = Math.max(right, Math.ceil(hostRect.right - rect.left + EDGE_PAD));
  };

  const extendBottom = (rect: DOMRect | null): void => {
    if (!rect || !overlapsHorizontally(rect, hostRect)) return;
    bottom = Math.max(bottom, Math.ceil(hostRect.bottom - rect.top + EDGE_PAD));
  };

  if (ctx.cinemaMode) {
    const cinemaRect = visibleRect(shell.querySelector(".cinema-controls"));
    if (cinemaRect) {
      extendBottom(cinemaRect);
      extendRight(cinemaRect);
    }
    return { top, right, bottom, left };
  }

  const contentTop = parseCssPx(
    getComputedStyle(document.documentElement).getPropertyValue("--content-top"),
  );
  top = Math.max(top, Math.ceil(contentTop + EDGE_PAD * 0.5));

  extendLeft(visibleRect(shell.querySelector(".explorer-rail")));

  if (ctx.hasLibrary && !ctx.explorerCollapsed) {
    extendLeft(visibleRect(shell.querySelector(".explorer-drawer")));
  }

  if (ctx.showInspector && !ctx.inspectorCollapsed) {
    extendRight(visibleRect(shell.querySelector(".inspector-panel")));
  } else if (ctx.showInspectorTab) {
    extendRight(visibleRect(shell.querySelector(".panel-expand-tab")));
  }

  if (ctx.showDock) {
    extendBottom(visibleRect(shell.querySelector(".bottom-dock")));
  }

  if (ctx.showAxisWidget) {
    const axisRect = visibleRect(shell.querySelector(".axis-widget"));
    if (axisRect) {
      extendRight(axisRect);
      extendBottom(axisRect);
    }
  }

  return { top, right, bottom, left };
}

type FramingViewer = HTMLElement & {
  clientWidth: number;
  clientHeight: number;
  getCameraOrbit(): { theta: number; phi: number; radius: number };
  getCameraTarget(): { x: number; y: number; z: number };
  cameraOrbit: string;
  cameraTarget: string;
};

function modelScene(mv: FramingViewer): ModelScene | null {
  return (mv as unknown as Record<symbol, ModelScene | undefined>)[$scene] ?? null;
}

/** Zoom/pan after model-viewer framing so the model fits the unobstructed viewport area. */
export function adjustCameraForViewportInsets(mv: FramingViewer, insets: ViewportInsets): void {
  const w = mv.clientWidth;
  const h = mv.clientHeight;
  if (w < 1 || h < 1) return;

  const visW = w - insets.left - insets.right;
  const visH = h - insets.top - insets.bottom;
  if (visW < 48 || visH < 48) return;

  const scene = modelScene(mv);
  if (!scene) return;

  const zoomFactor = Math.max(w / visW, h / visH);
  if (zoomFactor > 1.001) {
    const orbit = mv.getCameraOrbit();
    const baseRadius = scene.idealCameraDistance();
    mv.cameraOrbit = `${orbit.theta}rad ${orbit.phi}rad ${baseRadius * zoomFactor}m`;
  }

  const pxX = (insets.left - insets.right) / 2;
  const pxY = (insets.top - insets.bottom) / 2;
  if (Math.abs(pxX) < 0.5 && Math.abs(pxY) < 0.5) return;

  const camera = scene.camera;
  const target = scene.getTarget().clone();
  const distance = camera.position.distanceTo(target);
  if (distance < 1e-6) return;

  const right = new Vector3();
  const up = new Vector3();
  camera.updateMatrixWorld(true);
  camera.matrixWorld.extractBasis(right, up, new Vector3());

  const fovRad = (camera.fov * Math.PI) / 180;
  const worldPerPxY = (2 * Math.tan(fovRad / 2) * distance) / h;
  const worldPerPxX = worldPerPxY * camera.aspect;

  target.addScaledVector(right, -pxX * worldPerPxX);
  target.addScaledVector(up, pxY * worldPerPxY);
  mv.cameraTarget = `${target.x}m ${target.y}m ${target.z}m`;
}
