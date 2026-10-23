import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

function fixture() {
  const frames = [];
  const viewers = [];
  const effects = [];
  let capture = async () => new Uint8Array([1]);
  class Element extends EventTarget {
    style = {}; attributes = new Map(); children = []; parent = null;
    shadowRoot = null; clientWidth = 400; clientHeight = 800;
    setAttribute(k, v) { this.attributes.set(k, v); }
    getAttribute(k) { return this.attributes.get(k) ?? null; }
    hasAttribute(k) { return this.attributes.has(k); }
    removeAttribute(k) { this.attributes.delete(k); }
    appendChild(child) { child.remove(); this.children.push(child); child.parent = this; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); this.parent = null; }
    focus() {}
  }
  class Viewer extends Element {
    loaded = false; _src = null; disposed = 0; turntableRotation = 0;
    orbit = { theta: 0.2, phi: 1, radius: 10 }; goal = { ...this.orbit };
    target = { x: 0, y: 0, z: 0 }; targetGoal = { ...this.target };
    fov = 30; fovGoal = 30; _fieldOfView = "30deg";
    get src() { return this._src; }
    set src(value) { this._src = value; this.loaded = false; }
    get updateComplete() { return Promise.resolve(true); }
    getCameraOrbit() { return { ...this.orbit }; }
    getCameraTarget() { return { ...this.target }; }
    getFieldOfView() { return this.fov; }
    get fieldOfView() { return this._fieldOfView; }
    set fieldOfView(value) {
      this._fieldOfView = value;
      this.fovGoal = value === "auto" ? 30 : 2 * Math.atan(Math.tan(parseFloat(value) * Math.PI / 360) * 2) * 180 / Math.PI;
    }
    set cameraTarget(value) { this.targetGoal = value.includes("auto") ? { x: 0, y: 0, z: 0 } : Object.fromEntries(value.split(" ").map((v, i) => [["x", "y", "z"][i], parseFloat(v)])); }
    set cameraOrbit(value) { this.goal = value.includes("auto") ? { theta: 0.2, phi: 1, radius: 10 } : Object.fromEntries(value.split(" ").map((v, i) => [["theta", "phi", "radius"][i], parseFloat(v)])); }
    resetTurntableRotation(yaw = 0) { this.turntableRotation = yaw; }
    async updateFraming() {}
    jumpCameraToGoal() { this.orbit = { ...this.goal }; this.target = { ...this.targetGoal }; this.fov = this.fovGoal; }
  }
  const source = readFileSync(new URL("../src/viewer.ts", import.meta.url), "utf8");
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports, AbortController, Error,
    require: (id) => {
      if (id === "@google/model-viewer") return {};
      if (id === "./model-scene-access") return { getModelScene: (mv) => ({
        dispose: () => { mv.disposed++; },
        adjustedFoV: (degrees) => 2 * Math.atan(Math.tan(degrees * Math.PI / 360) * 2) * 180 / Math.PI,
      }) };
      if (id === "./cutout-export") return { exportCutoutPng: (args) => capture(args) };
      if (id === "./model-appearance") return { resetModelAppearanceCache() {}, syncModelAppearance: (mv, opts) => effects.push([mv, "appearance", opts]) };
      if (id === "./scene-guides") return { resetSceneGuideSyncCache() {}, syncSceneGuides: (mv, opts) => effects.push([mv, "guides", opts]) };
      if (id === "./viewport-framing") return { adjustCameraForViewportInsets() {} };
      throw new Error(`Unexpected module ${id}`);
    },
    document: { createElement: (tag) => { const el = tag === "model-viewer" ? new Viewer() : new Element(); if (tag === "model-viewer") viewers.push(el); return el; } },
    customElements: { whenDefined: async () => {} },
    requestAnimationFrame: (fn) => frames.push(fn), setTimeout: () => 0,
  });
  const host = new Element();
  const viewport = new exports.ModelViewport(host);
  const original = viewport.element;
  original.src = "structure.glb"; original.loaded = true;
  const initial = { targetX: 0, targetY: 0, targetZ: 0, theta: 0.2, phi: 1, radiusM: 10, fieldOfViewDeg: 30, turntableYaw: 0 };
  viewport.importSnapshot(initial);
  const tick = async () => { for (const fn of frames.splice(0)) fn(); await new Promise(setImmediate); };
  const settle = async (promise) => {
    let done = false;
    promise.then(() => { done = true; }, () => { done = true; });
    for (let i = 0; i < 100 && !done; i++) await tick();
    assert.equal(done, true, "viewer operation should settle");
    return promise;
  };
  const ready = (mv) => { mv.loaded = true; const event = new Event("load"); event.detail = { url: mv.src }; mv.dispatchEvent(event); };
  return { viewport, original, initial, host, viewers, effects, tick, settle, ready, setCapture: (fn) => { capture = fn; } };
}

test("detail replacement keeps the live pose, reset pose, presentation and appearance; releases prior LOD", async () => {
  const f = fixture();
  const { viewport, original, viewers, host } = f;
  viewport.setPresentationMode(true);
  viewport.setAutoRotate(true);
  viewport.syncSceneGuides({ previewGrid: true, showGuides: false });
  viewport.syncModelAppearance({ preset: "clay", opacity: 0.6 });
  const replacing = viewport.refine("detail.glb");
  await f.tick();
  const incoming = viewers.at(-1);
  assert.equal(viewport.element, original);
  assert.equal(original.parent, host, "preview remains available while details load");
  assert.equal(incoming.constructor.modelCacheSize, 0);
  original.orbit = { theta: 2.3, phi: 0.6, radius: 7 };
  original.target = { x: 1, y: 2, z: -3 };
  original.fov = 23;
  original.turntableRotation = 1.4;
  const before = viewport.captureLiveCamera();
  f.ready(incoming);
  assert.equal(await f.settle(replacing), true);
  const after = viewport.captureLiveCamera();
  for (const key of Object.keys(before)) close(after[key], before[key]);
  assert.deepEqual(JSON.parse(JSON.stringify(viewport.exportSnapshot())), f.initial);
  assert.equal(viewport.element, incoming);
  assert.equal(viewport.isAutoRotateActive(), true);
  assert.equal(original.parent, null);
  assert.ok(original.disposed > 0);
  assert.equal(host.children.length, 1);
  assert.ok(f.effects.some(([mv, effect, opts]) => mv === incoming && effect === "appearance" && opts.opacity === 0.6));
  assert.ok(f.effects.some(([mv, effect]) => mv === incoming && effect === "guides"));
});

test("failed or cancelled details preserve the foreground and cannot be committed by late load events", async () => {
  const f = fixture();
  const failed = f.viewport.refine("broken.glb");
  await f.tick();
  f.viewers.at(-1).dispatchEvent(new Event("error"));
  await assert.rejects(f.settle(failed), /Failed to load model/);
  assert.equal(f.viewport.element, f.original);
  assert.equal(f.host.children.length, 1);
  const cancelled = f.viewport.refine("late.glb");
  await f.tick();
  const late = f.viewers.at(-1);
  f.viewport.cancelRefinement();
  assert.equal(await f.settle(cancelled), false);
  f.ready(late);
  assert.equal(f.viewport.element, f.original);
  assert.equal(f.host.children.length, 1);
  assert.ok(late.disposed >= 2, "late decoded resources are released too");
  const releasedAfterLoad = late.disposed;
  late.dispatchEvent(new Event("error"));
  assert.equal(late.disposed, releasedAfterLoad, "load cleanup removes the error listener too");
});

test("cancelled refinement also releases resources on late errors and removes both cleanup listeners", async () => {
  const f = fixture();
  const pending = f.viewport.refine("late-error.glb");
  await f.tick();
  const late = f.viewers.at(-1);
  f.viewport.cancelRefinement();
  assert.equal(await f.settle(pending), false);
  const disposed = late.disposed;
  late.dispatchEvent(new Event("error"));
  assert.equal(late.disposed, disposed + 1, "setupScene can allocate before failing after removal");
  f.ready(late);
  late.dispatchEvent(new Event("error"));
  assert.equal(late.disposed, disposed + 1, "error cleanup removes both listeners");
  assert.equal(f.viewport.element, f.original);
  assert.equal(f.original.disposed, 0);
});

test("a detail swap waits for active cutout capture and keeps capturing the original scene", async () => {
  const f = fixture();
  let finishCapture;
  f.setCapture(({ mv }) => {
    assert.equal(mv, f.original);
    return new Promise((resolve) => { finishCapture = resolve; });
  });
  const capture = f.viewport.exportCutout({ previewGrid: true, showGuides: false });
  await f.tick();
  const replacing = f.viewport.refine("detail.glb");
  await f.tick();
  f.ready(f.viewers.at(-1));
  for (let i = 0; i < 20; i++) await f.tick();
  assert.equal(f.viewport.element, f.original);
  assert.equal(f.original.disposed, 0);
  finishCapture(new Uint8Array([42]));
  assert.equal((await capture)[0], 42);
  assert.equal(await f.settle(replacing), true);
  assert.notEqual(f.viewport.element, f.original);
});

test("clearing before custom-element readiness prevents an obsolete load from starting", async () => {
  const f = fixture();
  const loading = f.viewport.load("obsolete.glb");
  f.viewport.clear();
  const cleared = f.viewport.element;
  await f.settle(loading);
  assert.equal(cleared.src, null);
  assert.equal(f.viewport.hasSavedCamera(), false);
});

test("stopping refinement in the same turn does not start a decoder on the removed viewer", async () => {
  const f = fixture();
  const replacing = f.viewport.refine("obsolete-detail.glb");
  const removed = f.viewers.at(-1);
  f.viewport.cancelRefinement();
  assert.equal(await f.settle(replacing), false);
  assert.equal(removed.src, null);
  assert.equal(f.viewport.element, f.original);
  assert.equal(f.original.disposed, 0);
});

test("a completed old Fit cannot change the cleared viewer's camera bounds", async () => {
  const f = fixture();
  let framed;
  f.original.updateFraming = () => new Promise((resolve) => { framed = resolve; });
  const fitting = f.viewport.fit();
  f.viewport.clear();
  const cleared = f.viewport.element;
  const before = [cleared.getAttribute("min-camera-orbit"), cleared.getAttribute("max-camera-orbit")];
  framed();
  await f.settle(fitting);
  assert.deepEqual([cleared.getAttribute("min-camera-orbit"), cleared.getAttribute("max-camera-orbit")], before);
});
