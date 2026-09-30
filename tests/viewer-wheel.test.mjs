import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

function fixture() {
  const frames = [];
  class Element extends EventTarget {
    attributes = new Map();
    attributeWrites = [];
    style = {};
    clientHeight = 600;
    clientWidth = 800;
    children = [];
    setAttribute(name, value) { this.attributes.set(name, value); this.attributeWrites.push(name); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    hasAttribute(name) { return this.attributes.has(name); }
    removeAttribute(name) { this.attributes.delete(name); }
    appendChild(child) { this.children.push(child); }
    remove() {}
    focus() {}
  }
  class Viewer extends Element {
    src = null;
    loaded = true;
    shadowRoot = null;
    orbit = { theta: 0.2, phi: 1.2, radius: 10 };
    goal = { ...this.orbit };
    fov = 30;
    fovGoal = 30;
    aspectFactor = 1;
    fieldWrites = 0;
    turntableRotation = 0;
    updateComplete = Promise.resolve(true);
    getCameraOrbit() { return { ...this.orbit }; }
    getCameraTarget() { return { x: 0, y: 0, z: 0 }; }
    getFieldOfView() { return this.fov; }
    get cameraOrbit() { return `${this.goal.theta}rad ${this.goal.phi}rad ${this.goal.radius}m`; }
    set cameraOrbit(value) {
      this.goal = value.includes("auto")
        ? { theta: 0.2, phi: 1.2, radius: 10 }
        : Object.fromEntries(value.split(" ").map((number, index) => [["theta", "phi", "radius"][index], parseFloat(number)]));
    }
    get fieldOfView() { return `${this.fovGoal}deg`; }
    set fieldOfView(value) {
      this.fieldWrites++;
      const fov = value === "auto" ? 30 : parseFloat(value);
      // model-viewer interprets its fieldOfView property before aspect correction.
      this.fovGoal = 2 * Math.atan(Math.tan(fov * Math.PI / 360) * this.aspectFactor) * 180 / Math.PI;
    }
    resetTurntableRotation(value = 0) { this.turntableRotation = value; }
    async updateFraming() {}
    jumpCameraToGoal() { this.orbit = { ...this.goal }; this.fov = this.fovGoal; }
  }
  const source = readFileSync(new URL("../src/viewer.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, {
    exports, AbortController, Error,
    require: (id) => {
      if (id === "@google/model-viewer") return {};
      if (id === "./cutout-export") return {};
      if (id === "./model-appearance") return { resetModelAppearanceCache() {} };
      if (id === "./scene-guides") return { resetSceneGuideSyncCache() {} };
      if (id === "./viewport-framing") return { adjustCameraForViewportInsets() {} };
      throw new Error(`Unexpected import: ${id}`);
    },
    document: { createElement: (tag) => tag === "model-viewer" ? new Viewer() : new Element() },
    customElements: { whenDefined: async () => {} },
    requestAnimationFrame: (fn) => frames.push(fn),
    // Load's timeout race must not keep the Node test process alive.
    setTimeout: () => 0,
  });
  const host = new Element();
  const viewport = new exports.ModelViewport(host);
  const mv = viewport.element;
  mv.src = "initial.glb";
  viewport.importSnapshot({ targetX: 0, targetY: 0, targetZ: 0, theta: 0.2, phi: 1.2,
    radiusM: 10, fieldOfViewDeg: 30, turntableYaw: 0 });
  mv.attributeWrites.length = 0;
  const frame = () => { for (const fn of frames.splice(0)) fn(); };
  const complete = async (promise) => {
    let done = false;
    promise.finally(() => { done = true; });
    for (let n = 0; n < 100 && !done; n++) { frame(); await Promise.resolve(); }
    assert.equal(done, true, "operation should finish with the simulated frame clock");
    return promise;
  };
  return { viewport, mv, host, frame, complete };
}

test("rapid wheel input accumulates against its goal and opposite input is reversible", () => {
  const { viewport, mv } = fixture();
  for (let n = 0; n < 5; n++) viewport.stepZoomFromWheel(100);
  close(mv.orbit.radius, 10, "camera has not caught up yet");
  close(mv.goal.radius, 10 * Math.exp(0.6));
  for (let n = 0; n < 5; n++) viewport.stepZoomFromWheel(-100);
  close(mv.goal.radius, 10);
  viewport.zoomIn();
  viewport.zoomIn();
  close(mv.goal.radius, 10 * 0.88 ** 2);
  viewport.zoomOut();
  close(mv.goal.radius, 10 * 0.88);
});

test("wheel bounds do not accumulate unreachable zoom and units follow line/page mode", () => {
  const { viewport, mv } = fixture();
  for (let n = 0; n < 20; n++) viewport.stepZoomFromWheel(10000);
  close(mv.goal.radius, 50);
  viewport.stepZoomFromWheel(-100);
  close(mv.goal.radius, 50 * Math.exp(-0.12));
  for (let n = 0; n < 20; n++) viewport.stepZoomFromWheel(-10000);
  close(mv.goal.radius, 1.5);
  viewport.stepZoomFromWheel(100);
  close(mv.goal.radius, 1.5 * Math.exp(0.12));
  const line = fixture();
  line.viewport.stepZoomFromWheel(1, 1);
  close(line.mv.goal.radius, 10 * Math.exp(18 * 0.0012));
  const page = fixture();
  page.viewport.stepZoomFromWheel(1, 2);
  close(page.mv.goal.radius, 10 * Math.exp(600 * 0.0012));
});

test("wheel zoom keeps the current field of view even in a narrow viewport", () => {
  const { viewport, mv } = fixture();
  mv.aspectFactor = 2;
  mv.fov = mv.fovGoal = 20; // A prior pinch has reduced FOV below its limit.
  viewport.stepZoomFromWheel(100);
  mv.jumpCameraToGoal();
  close(mv.fov, 20);
  viewport.zoomIn();
  mv.jumpCameraToGoal();
  close(mv.fov, 20);
});

test("unchanged zoom bounds are not rewritten on every event", () => {
  const { viewport, mv } = fixture();
  viewport.stepZoomFromWheel(10);
  const boundsWrites = () => mv.attributeWrites.filter((name) => /^(min|max)-camera-orbit$/.test(name)).length;
  const first = boundsWrites();
  for (let n = 0; n < 20; n++) viewport.stepZoomFromWheel(10);
  assert.equal(boundsWrites(), first, "changing model-viewer bounds forces jumpCameraToGoal");
});

test("drag, keyboard, fit, reset and model loading invalidate the previous zoom goal", async () => {
  const { viewport, mv, host, frame, complete } = fixture();
  viewport.stepZoomFromWheel(100);
  host.dispatchEvent(new Event("pointerdown"));
  mv.orbit.radius = 20;
  viewport.stepZoomFromWheel(100);
  close(mv.goal.radius, 20 * Math.exp(0.12));
  host.dispatchEvent(new Event("keydown"));
  mv.orbit.radius = 15;
  viewport.zoomIn();
  close(mv.goal.radius, 15 * 0.88);
  await viewport.fit();
  viewport.stepZoomFromWheel(100);
  close(mv.goal.radius, 10 * Math.exp(0.12));
  assert.equal(viewport.reset(), true);
  frame();
  mv.jumpCameraToGoal();
  viewport.stepZoomFromWheel(100);
  close(mv.goal.radius, 10 * Math.exp(0.12));
  await complete(viewport.load("next.glb"));
  viewport.stepZoomFromWheel(100);
  close(mv.goal.radius, 10 * Math.exp(0.12));
  viewport.clear();
  const next = viewport.element;
  next.src = "third.glb";
  next.orbit.radius = 7;
  viewport.stepZoomFromWheel(100);
  close(next.goal.radius, 7 * Math.exp(0.12));
});

test("wheel handling consumes valid input once and ignores unloaded or invalid input", () => {
  const { viewport, mv, host } = fixture();
  viewport.attachWheelSurface(host);
  const wheel = (deltaY) => {
    const event = new Event("wheel", { cancelable: true });
    Object.assign(event, { deltaY, deltaMode: 0 });
    host.dispatchEvent(event);
    return event;
  };
  assert.equal(wheel(100).defaultPrevented, true);
  close(mv.goal.radius, 10 * Math.exp(0.12));
  for (const invalid of [0, NaN, Infinity]) assert.equal(wheel(invalid).defaultPrevented, false);
  close(mv.goal.radius, 10 * Math.exp(0.12));
  mv.loaded = false;
  assert.equal(wheel(100).defaultPrevented, false);
  close(mv.goal.radius, 10 * Math.exp(0.12));
});
