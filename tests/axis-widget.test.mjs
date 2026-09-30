import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as THREE from "three";

function fixture() {
  let created = 0;
  class Element {
    constructor(tag) {
      created++;
      this.tag = tag;
      this.attributes = new Map();
      this.children = [];
      this.replacements = 0;
      this.classList = { add() {}, toggle() {} };
    }
    setAttribute(name, value) { this.attributes.set(name, value); }
    appendChild(child) { this.children.push(child); }
    replaceChildren(...children) {
      this.replacements++;
      this.children = children.flatMap((node) => node.tag === "fragment" ? node.children : [node]);
    }
  }
  const $scene = Symbol("scene");
  const callbacks = new Map();
  let nextFrame = 0;
  const theme = {
    axisWidgetX: "#e07085", axisWidgetY: "#52c46e", axisWidgetZ: "#5498eb",
    axisWidgetFront: 0.88, axisWidgetBack: 0.38,
  };
  const code = ts.transpileModule(
    readFileSync(new URL("../src/axis-widget.ts", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const exports = {};
  vm.runInNewContext(code, {
    exports,
    require: (id) => {
      if (id === "three") return THREE;
      if (id === "@google/model-viewer/lib/model-viewer-base.js") return { $scene };
      if (id === "./scene-theme") return { readSceneTheme: () => theme };
      throw new Error(`Unexpected import: ${id}`);
    },
    document: {
      createElementNS: (_, tag) => new Element(tag),
      createDocumentFragment: () => new Element("fragment"),
    },
    requestAnimationFrame: (fn) => { callbacks.set(++nextFrame, fn); return nextFrame; },
    cancelAnimationFrame: (id) => callbacks.delete(id),
  });
  const target = new THREE.Object3D();
  const turntable = new THREE.Object3D();
  turntable.add(target);
  const camera = new THREE.PerspectiveCamera();
  camera.position.z = 10;
  const cameraParent = new THREE.Object3D();
  cameraParent.add(camera);
  const viewer = { src: "model.glb", loaded: true, [$scene]: { camera, target } };
  const host = new Element("div");
  const widget = new exports.AxisOrientationWidget(host, () => viewer);
  const svg = host.children[0];
  const frame = () => {
    const pending = [...callbacks.values()];
    callbacks.clear();
    for (const fn of pending) fn();
  };
  const axis = (id) => {
    const index = svg.children.findIndex((node) => node.tag === "text" && node.textContent === id);
    return svg.children[index - 1];
  };
  return { widget, svg, frame, axis, target, turntable, camera, cameraParent, viewer, theme, callbacks, created: () => created };
}

test("idle and zoom frames neither walk model descendants nor recreate the axis SVG", () => {
  const f = fixture();
  const model = new THREE.Object3D();
  f.target.add(model);
  for (let n = 0; n < 100; n++) {
    const mesh = new THREE.Object3D();
    mesh.updateMatrixWorld = () => assert.fail("widget traversed model descendants");
    mesh.updateWorldMatrix = () => assert.fail("widget traversed model descendants");
    model.add(mesh);
  }
  f.widget.setActive(true);
  f.frame();
  assert.equal(f.svg.children.length, 8, "ring, hub, three lines and labels remain unchanged");
  assert.equal(f.axis("X").attributes.get("x2"), "24.00");
  assert.equal(f.axis("Y").attributes.get("y2"), "-24.00");
  const created = f.created();
  for (let n = 0; n < 60; n++) {
    f.camera.position.z -= 0.01;
    f.frame();
  }
  assert.equal(f.svg.replacements, 1);
  assert.equal(f.created(), created, "unchanged frames allocate no DOM nodes");
});

test("ancestor rotation, theme changes and visibility still update the displayed axes", () => {
  const f = fixture();
  f.widget.setActive(true);
  f.frame();
  f.turntable.rotation.y = Math.PI / 2;
  f.frame();
  assert.equal(Number(f.axis("X").attributes.get("x2")), 0);
  assert.equal(f.axis("X").attributes.get("opacity"), "0.88", "turntable rotation changes front/back ordering");

  f.turntable.rotation.y = 0;
  f.cameraParent.rotation.z = Math.PI / 2;
  f.frame();
  assert.equal(Number(f.axis("X").attributes.get("x2")), 0);
  assert.equal(f.axis("X").attributes.get("y2"), "24.00", "camera ancestor orientation is current");
  f.theme.axisWidgetX = "#abcdef";
  f.theme.axisWidgetBack = 0.5;
  f.frame();
  assert.equal(f.axis("X").attributes.get("stroke"), "#abcdef");
  assert.equal(f.axis("X").attributes.get("opacity"), "0.50");
  const drawn = f.svg.replacements;
  f.frame();
  assert.equal(f.svg.replacements, drawn);

  f.viewer.loaded = false;
  f.frame();
  assert.equal(f.svg.children.length, 0);
  f.frame();
  assert.equal(f.svg.replacements, drawn + 1, "an absent model clears only once");
  f.viewer.loaded = true;
  f.frame();
  assert.equal(f.svg.children.length, 8);
  f.widget.setActive(false);
  assert.equal(f.callbacks.size, 0);
  assert.equal(f.svg.children.length, 0);
  f.widget.setActive(true);
  f.frame();
  assert.equal(f.svg.children.length, 8, "showing the widget restores the same orientation");
});
