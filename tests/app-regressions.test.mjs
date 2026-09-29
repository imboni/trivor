import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

function loadSource(name, globals = {}, modules = new Map()) {
  if (modules.has(name)) return modules.get(name);
  const source = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  modules.set(name, exports);
  vm.runInNewContext(code, {
    exports,
    Error,
    require: (id) => {
      assert.ok(id.startsWith("./"), `Unexpected import: ${id}`);
      return loadSource(id.slice(2), globals, modules);
    },
    ...globals,
  });
  return exports;
}

function ui(locale = "en") {
  return {
    locale,
    error_model_import: locale === "zh-Hans" ? "无法导入模型。" : "Couldn't import the model.",
    error_viewer_load: "This model could not be displayed.",
    error_preview_render_failed: "Preview failed ({size}).",
    error_large_viewer_failed: "Large model failed ({size}).",
    error_gltfpack_missing: "Missing converter.",
    error_gltfpack_preview_failed: "Conversion failed ({size}).",
    error_gltf_sidecar_hint: "Keep sidecars beside the model.",
    load_export_advice: "Limits: {stable_size}, {stable_tris}, {hard_size}, {hard_tris}.",
    unit_bytes_b: "B", unit_bytes_kb: "KB", unit_bytes_mb: "MB", unit_bytes_gb: "GB",
  };
}

test("preview cache detection accepts both generations and ignores parent directory names", () => {
  const { isPreviewCachePath } = loadSource("load-failure");
  for (const path of [
    "/cache/preview-v2-0.500-0123456789abcdef.glb",
    "C:\\cache\\preview-v2-0.250-0123456789abcdef.glb",
    "/cache/chair-12345-preview-0.500.glb",
  ]) assert.equal(isPreviewCachePath(path), true, path);
  for (const path of [
    "/cache/packed-v2-0123456789abcdef.glb",
    "/cache/imported-obj-v2-0123456789abcdef.glb",
    "/models/chair.glb",
    "/models/my-preview-folder/chair.glb",
    "C:\\preview-v2-folder\\chair.glb",
  ]) assert.equal(isPreviewCachePath(path), false, path);
});

test("render failures use the dedicated preview message for old and new cache names", () => {
  const { resolveLoadFailureMessage } = loadSource("load-failure");
  for (const name of ["preview-v2-0.500-abcdef.glb", "chair-12345-preview-0.500.glb"]) {
    const message = resolveLoadFailureMessage(
      ui(), "/models/chair.glb", new Error("Failed to load model"), `/cache/${name}`,
      () => 1024 ** 2,
    );
    assert.equal(message, "Preview failed (1.00 MB).");
  }
  const message = resolveLoadFailureMessage(
    ui(), "/models/chair.glb", new Error("TypeError: Cannot read properties of undefined"),
    "/cache/preview-v2-0.500-abcdef.glb", () => 250 * 1024 ** 2,
  );
  assert.ok(message.startsWith("Preview failed (250 MB).\n\nLimits:"));
  assert.doesNotMatch(message, /TypeError|\{(?:size|stable_size|stable_tris|hard_size|hard_tris)\}/);
});

test("OBJ conversion errors are localized for both string IPC errors and Error objects", () => {
  const { resolveLoadFailureMessage } = loadSource("load-failure");
  for (const locale of ["en", "zh-Hans"]) {
    const copy = ui(locale);
    for (const error of ["IMPORT_FAILED:gltfpack", new Error("IMPORT_FAILED:gltfpack")]) {
      assert.equal(
        resolveLoadFailureMessage(copy, "/models/chair.obj", error, null, () => 1024),
        copy.error_model_import,
      );
    }
    const large = resolveLoadFailureMessage(
      copy, "/models/chair.obj", "IMPORT_FAILED:gltfpack", null, () => 250 * 1024 ** 2,
    );
    assert.ok(large.startsWith(`${copy.error_model_import}\n\nLimits:`));
    assert.doesNotMatch(large, /IMPORT_FAILED|\{(?:stable_size|stable_tris|hard_size|hard_tris)\}/);
  }
});

function shortcuts(overrides = {}) {
  const values = new Map([["trivor.shortcuts.v1", JSON.stringify(overrides)]]);
  const localStorage = {
    getItem: (key) => values.get(key),
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const module = loadSource("shortcuts", { localStorage });
  return { ...module, values, store: new module.ShortcutStore() };
}

const exportBinding = { key: "e", meta: true, shift: true };
const exportEvent = { key: "E", metaKey: true, shiftKey: true, ctrlKey: false, altKey: false };

test("native export shortcut is fixed even when storage contains an override", () => {
  const { store, shortcutDefinitions, values } = shortcuts({
    export_model: [{ key: "x", meta: true }],
  });
  assert.equal(shortcutDefinitions().find((def) => def.id === "export_model").customizable, false);
  assert.equal(store.match(exportEvent), "export_model");
  assert.equal(store.match({ ...exportEvent, key: "x", shiftKey: false }), null);
  assert.equal(store.bindingsFor("export_model")[0].key, "e");
  const before = values.get("trivor.shortcuts.v1");
  assert.equal(store.setBinding("export_model", { key: "x", meta: true }), false);
  assert.equal(values.get("trivor.shortcuts.v1"), before);
  store.resetAll();
  assert.equal(store.match(exportEvent), "export_model");
});

test("all customizable actions reject the reserved native export binding", () => {
  const { store, shortcutDefinitions, values, ShortcutStore } = shortcuts({
    export_model: [{ key: "x", meta: true }],
  });
  const before = values.get("trivor.shortcuts.v1");
  for (const def of shortcutDefinitions().filter((def) => def.customizable)) {
    assert.equal(store.setBinding(def.id, exportBinding), false, def.id);
  }
  assert.equal(values.get("trivor.shortcuts.v1"), before, "rejected bindings must not persist");
  assert.equal(store.setBinding("cutout_copy", { key: "k", meta: true, shift: true }), true);
  assert.equal(new ShortcutStore().match({ ...exportEvent, key: "K" }), "cutout_copy");
  assert.equal(store.match(exportEvent), "export_model");
});
