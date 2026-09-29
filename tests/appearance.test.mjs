import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { Group, Mesh, MeshBasicMaterial, MeshPhysicalMaterial, MeshStandardMaterial, Texture } from "three";

function loadSource(name, globals = {}, dependencies = {}) {
  const source = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, {
    exports,
    require: (id) => {
      if (!(id in dependencies)) throw new Error(`Unexpected import: ${id}`);
      return dependencies[id];
    },
    ...globals,
  });
  return exports;
}

function appearance() {
  return loadSource("model-appearance", {}, {
    "./model-scene-access": { getModelScene: (host) => host.scene },
  });
}

function viewer(...materials) {
  const model = new Group();
  model.add(new Mesh(undefined, materials));
  const target = new Group();
  target.add(model);
  const scene = { model, target, renders: 0, queueRender() { this.renders++; } };
  return { loaded: true, scene };
}

function close(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
}

test("appearance changes only model content and applies to each loaded model", () => {
  const { syncModelAppearance } = appearance();
  const first = new MeshStandardMaterial({ color: 0xffffff });
  const host = viewer(first);
  const guides = new Group();
  guides.name = "trivor-scene-guides";
  const axis = new MeshBasicMaterial({ color: 0xff0000, opacity: 0.7, transparent: true });
  guides.add(new Mesh(undefined, axis));
  host.scene.target.add(guides);

  syncModelAppearance(host, { preset: "warm", opacity: 0.3 });
  close(first.color.r, 1.08);
  close(first.opacity, 0.3);
  assert.deepEqual(axis.color.toArray(), [1, 0, 0]);
  close(axis.opacity, 0.7);

  const next = new MeshStandardMaterial({ color: 0xffffff });
  host.scene.model = viewer(next).scene.model;
  syncModelAppearance(host, { preset: "warm", opacity: 0.3 });
  close(next.color.r, 1.08);
  close(next.opacity, 0.3);

  const other = new MeshStandardMaterial({ color: 0xffffff });
  syncModelAppearance(viewer(other), { preset: "warm", opacity: 0.3 });
  close(other.opacity, 0.3);
});

test("rapid tint and opacity changes restore masked materials without cumulative tint", () => {
  const { syncModelAppearance, resetModelAppearanceCache } = appearance();
  const mat = new MeshStandardMaterial({ color: 0xffffff, alphaTest: 0.5 });
  const host = viewer(mat, mat);
  syncModelAppearance(host, { preset: "warm", opacity: 0.2 });
  close(mat.alphaTest, 0.1);
  assert.equal(mat.transparent, true);
  assert.equal(mat.depthWrite, false);
  syncModelAppearance(host, { preset: "cool", opacity: 0.8 });
  close(mat.color.r, 0.92);
  close(mat.color.b, 1.08);
  resetModelAppearanceCache();
  syncModelAppearance(host, { preset: "original", opacity: 1 });
  assert.deepEqual(mat.color.toArray(), [1, 1, 1]);
  close(mat.alphaTest, 0.5);
  close(mat.opacity, 1);
  assert.equal(mat.transparent, false);
  assert.equal(mat.depthWrite, true);
  const version = mat.version;
  syncModelAppearance(host, { preset: "cool", opacity: 1 });
  assert.equal(mat.version, version, "a simple tint does not recompile the material");
});

test("clay retains texture alpha and restores PBR material fields and shader hooks", () => {
  const { syncModelAppearance } = appearance();
  const map = new Texture();
  const roughnessMap = new Texture();
  const mat = new MeshPhysicalMaterial({
    color: 0x123456, map, roughnessMap, vertexColors: true,
    roughness: 0.2, metalness: 0.8, emissive: 0x112233,
    transmission: 0.8, clearcoat: 1, sheen: 0.4, iridescence: 0.6,
    alphaTest: 0.4, opacity: 0.8, transparent: true, depthWrite: false,
  });
  const color = mat.color.toArray();
  const emissive = mat.emissive.toArray();
  const hook = mat.onBeforeCompile;
  const key = mat.customProgramCacheKey;
  const host = viewer(mat);

  syncModelAppearance(host, { preset: "clay", opacity: 0.5 });
  assert.deepEqual(mat.color.toArray(), [0.82, 0.8, 0.78]);
  assert.deepEqual(mat.emissive.toArray(), [0, 0, 0]);
  assert.equal(mat.metalness, 0);
  assert.equal(mat.roughness, 0.9);
  assert.equal(mat.roughnessMap, null);
  assert.equal(mat.transmission, 0);
  assert.equal(mat.map, map, "base texture alpha remains available");
  assert.equal(mat.vertexColors, true, "vertex alpha remains available");
  const shader = { fragmentShader: "#include <map_fragment>\n#include <color_fragment>\n#include <alphatest_fragment>" };
  mat.onBeforeCompile(shader, {});
  assert.match(shader.fragmentShader, /diffuseColor\.rgb = diffuse;/);
  assert.match(shader.fragmentShader, /#include <alphatest_fragment>/);

  syncModelAppearance(host, { preset: "original", opacity: 1 });
  assert.deepEqual(mat.color.toArray(), color);
  assert.deepEqual(mat.emissive.toArray(), emissive);
  assert.equal(mat.map, map);
  assert.equal(mat.roughnessMap, roughnessMap);
  assert.equal(mat.roughness, 0.2);
  assert.equal(mat.metalness, 0.8);
  assert.equal(mat.transmission, 0.8);
  assert.equal(mat.clearcoat, 1);
  assert.equal(mat.sheen, 0.4);
  assert.equal(mat.iridescence, 0.6);
  assert.equal(mat.onBeforeCompile, hook);
  assert.equal(mat.customProgramCacheKey, key);
  assert.equal(mat.opacity, 0.8);
  assert.equal(mat.depthWrite, false);
});

test("scene preferences migrate legacy guides and validate persisted appearance", () => {
  const values = new Map([["trivor.scene.v1", JSON.stringify({ previewGrid: false, showAxes: true })]]);
  const storage = {
    getItem: (key) => values.get(key),
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const { SceneOptionsStore } = loadSource("scene-options", { localStorage: storage });
  const legacy = new SceneOptionsStore();
  assert.equal(legacy.get().previewGrid, false);
  assert.equal(legacy.get().showGuides, true);
  assert.equal(legacy.get().colorPreset, "original");
  legacy.set({ modelOpacity: -3, colorPreset: "cool" });
  assert.equal(new SceneOptionsStore().get().modelOpacity, 0);
  assert.equal(new SceneOptionsStore().get().colorPreset, "cool");
  legacy.set({ modelOpacity: NaN, colorPreset: "unknown" });
  assert.equal(legacy.get().modelOpacity, 0);
  assert.equal(legacy.get().colorPreset, "cool");
  legacy.reset();
  assert.equal(values.size, 0);
  assert.equal(new SceneOptionsStore().get().showGuides, false);
});

test("blocked local storage does not prevent scene preference changes", () => {
  const fail = () => { throw new Error("Storage unavailable"); };
  const { SceneOptionsStore } = loadSource("scene-options", {
    localStorage: { getItem: fail, setItem: fail, removeItem: fail },
  });
  const store = new SceneOptionsStore();
  store.set({ colorPreset: "clay", modelOpacity: 0.5 });
  assert.equal(store.get().colorPreset, "clay");
  assert.equal(store.get().modelOpacity, 0.5);
  store.reset();
  assert.equal(store.get().colorPreset, "original");
});
