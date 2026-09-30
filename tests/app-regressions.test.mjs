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
    error_model_access_cancelled: locale === "zh-Hans" ? "已取消文件夹授权。" : "Folder access was cancelled.",
    error_model_access_denied: locale === "zh-Hans" ? "无法读取：{path}。请重新选择模型文件夹。" : "Cannot read {path}. Select the model folder again.",
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

test("model folder access cancellation and denied resources are localized without generic sidecar advice", () => {
  const { resolveLoadFailureMessage, localizeBackendLoadError } = loadSource("load-failure");
  for (const locale of ["en", "zh-Hans"]) {
    const copy = ui(locale);
    const path = "/模型/材质 texture.png";
    for (const raw of ["MODEL_ASSETS_ACCESS_CANCELLED", `MODEL_ASSETS_ACCESS_DENIED:${path}`]) {
      const expected = raw.endsWith("CANCELLED")
        ? copy.error_model_access_cancelled
        : copy.error_model_access_denied.replace("{path}", path);
      assert.equal(localizeBackendLoadError(raw, copy), expected, "export error copy");
      for (const error of [raw, new Error(raw)]) {
        assert.equal(resolveLoadFailureMessage(copy, "/模型/分离.gltf", error, null, () => 1024), expected);
        assert.equal(resolveLoadFailureMessage(copy, "/模型/分离.gltf", error, null, () => 250 * 1024 ** 2), expected);
      }
    }
  }
});

test("parallel model commands forward one access attempt and export creates its own", async () => {
  const calls = [];
  const { loadModel, resolveViewerModelPath, exportModelDialog } = loadSource("bridge", {
    crypto: { randomUUID: () => "export-attempt" },
    require: (id) => {
      if (id === "@tauri-apps/api/core") return {
        invoke: async (name, args) => { calls.push({ name, ...args }); },
      };
      if (id === "@tauri-apps/api/event") return {};
      if (id === "@tauri-apps/plugin-opener") return {};
      throw new Error(`Unexpected module: ${id}`);
    },
  });
  await Promise.all([
    loadModel("/模型/分离.gltf", "open-attempt"),
    resolveViewerModelPath("/模型/分离.gltf", "open-attempt"),
  ]);
  await exportModelDialog("export.glb", "/模型/分离.gltf");
  assert.deepEqual(calls, [
    { name: "load_model", path: "/模型/分离.gltf", accessRequestId: "open-attempt" },
    { name: "resolve_viewer_model_path", path: "/模型/分离.gltf", accessRequestId: "open-attempt" },
    { name: "export_model_dialog", defaultFilename: "export.glb", sourcePath: "/模型/分离.gltf", accessRequestId: "export-attempt" },
  ]);
});

// Run the real load methods without mounting WebGL or native dialogs.
function modelAccessApp() {
  const filename = new URL("../src/app.ts", import.meta.url);
  const file = ts.createSourceFile("app.ts", readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true);
  const appClass = file.statements.find((node) => ts.isClassDeclaration(node) && node.name.text === "App");
  const methods = appClass.members.filter((node) =>
    ts.isMethodDeclaration(node) && ["openPath", "loadFolder"].includes(node.name.getText(file)),
  );
  const code = ts.transpileModule(`class App { ${methods.map((node) => node.getText(file)).join("\n")} }; exports.App = App;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const path = "/models/separate.gltf";
  const entry = { path, format: "gltf", file_size: 42 };
  const fresh = { ...entry, material_count: 2 };
  const calls = [];
  const state = { denied: true, nextId: 0 };
  const noop = () => {};
  const exports = {};
  vm.runInNewContext(code, {
    exports, Error,
    crypto: { randomUUID: () => `attempt-${++state.nextId}` },
    normalizeModelPath: async (path) => path,
    modelExtension: () => "gltf", isModelPath: () => true,
    modelFileSize: async () => 42, flushUi: async () => {},
    PREVIEW_OPTIMIZE_BYTES: 200 * 1024 ** 2,
    loadModel: async (path, id) => {
      calls.push({ operation: "metadata", id });
      if (state.denied) throw "MODEL_ASSETS_ACCESS_CANCELLED";
      return fresh;
    },
    resolveViewerModelPath: async (path, id) => {
      calls.push({ operation: "viewer", id });
      if (state.denied) throw "MODEL_ASSETS_ACCESS_CANCELLED";
      return "/cache/packed.glb";
    },
    listModelsInFolder: async () => [entry],
    convertFileSrc: (path) => path,
    isPreviewCachePath: () => false,
    resolveLoadFailureMessage: loadSource("load-failure").resolveLoadFailureMessage,
  });
  const app = new exports.App();
  Object.assign(app, {
    ui: ui(), loadToken: 0, phase: "empty", activePath: null, summary: null,
    models: [entry], summaryCache: new Map(), cinemaMode: false,
    paint: noop, syncLoadingProgress: noop, paintOverlay: noop,
    syncFramingInsets: noop, saveInitialCameraForPath: noop,
    syncSceneGuidesAfterModelReady: noop, paintCinemaControls: noop,
    modelEntryFromPath: () => entry, tryUpsertModel: () => true,
    largeModelLoadHint: () => null, modelFileSizeForPath: () => 42,
    registerLibraryRoot: noop,
    viewport: { clear: noop, load: async () => {}, focus: noop },
  });
  return { app, state, calls, path, fresh };
}

test("cancelled load keeps its localized error and reopening refreshes metadata with a new attempt", async () => {
  const { app, state, calls, path, fresh } = modelAccessApp();
  await app.openPath(path);
  assert.equal(app.phase, "error");
  assert.equal(app.status, app.ui.error_model_access_cancelled);
  assert.equal(app.loadFailure.raw, "MODEL_ASSETS_ACCESS_CANCELLED");
  assert.equal(calls[0].id, calls[1].id);
  app.summaryCache.set(path, { ...fresh, material_count: 1 });
  state.denied = false;
  await app.openPath(path);
  assert.equal(app.phase, "ready");
  assert.equal(app.summary.material_count, 2);
  assert.equal(app.loadFailure, null);
  assert.equal(calls[2].id, calls[3].id);
  assert.notEqual(calls[0].id, calls[2].id);
});

test("opening the containing folder retries its currently failed model", async () => {
  const { app, state, path } = modelAccessApp();
  await app.openPath(path);
  assert.equal(app.phase, "error");
  state.denied = false;
  await app.loadFolder("/models");
  assert.equal(app.phase, "ready");
  assert.equal(app.activePath, path);
  assert.equal(app.summary.material_count, 2);
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
