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
    error_model_preparation_cancelled: locale === "zh-Hans" ? "已取消模型预览。重新打开模型可重试。" : "Model preview was cancelled. Reopen the model to try again.",
    error_model_large_format: locale === "zh-Hans" ? "超大 OBJ/STL 暂不支持直接预览。请先转换为 GLB/glTF 后打开。" : "Very large OBJ/STL models cannot be previewed directly. Convert the model to GLB/glTF before opening it.",
    error_model_draco_preview: locale === "zh-Hans" ? "此模型需要简化，但目前无法简化 Draco 压缩数据。请先导出为未使用 Draco 压缩的 GLB/glTF，或降低模型复杂度后重试。" : "This model needs simplification, but Draco-compressed data cannot currently be simplified. Export GLB/glTF without Draco compression, or reduce the model's complexity and try again.",
    error_model_preview_budget: locale === "zh-Hans" ? "模型简化后仍超出预览预算。请减少面数、实例数量或贴图分辨率后重试。" : "The simplified model still exceeds the preview budget. Reduce polygon counts, instance counts, or texture resolution and try again.",
    error_model_preparation: locale === "zh-Hans" ? "无法生成模型预览。请检查模型及其引用资源，或降低模型复杂度后重新打开。" : "Could not prepare the model preview. Check the model and its referenced resources, or reduce its complexity and reopen it.",
    error_gltf_sidecar_hint: "Keep sidecars beside the model.",
    load_export_advice: "Preview advice: processing the original file still requires memory; reduce model complexity.",
    unit_bytes_b: "B", unit_bytes_kb: "KB", unit_bytes_mb: "MB", unit_bytes_gb: "GB",
  };
}

test("preview cache detection accepts all preparation stages and ignores parent directory names", () => {
  const { isPreviewCachePath } = loadSource("load-failure");
  for (const path of [
    "/cache/preview-v2-0.500-0123456789abcdef.glb",
    "C:\\cache\\preview-v2-0.250-0123456789abcdef.glb",
    "/cache/chair-12345-preview-0.500.glb",
    "/cache/structure-v1-0123456789abcdef.glb",
    "/cache/preview-budget-v1-0123456789abcdef.glb",
    "C:\\cache\\detail-budget-v1-0123456789abcdef.glb",
  ]) assert.equal(isPreviewCachePath(path), true, path);
  for (const path of [
    "/cache/packed-v2-0123456789abcdef.glb",
    "/cache/imported-obj-v2-0123456789abcdef.glb",
    "/models/chair.glb",
    "/models/my-preview-folder/chair.glb",
    "C:\\preview-v2-folder\\chair.glb",
    "/models/structure-v1-folder/chair.glb",
    "/models/preview-budget-v1-folder/chair.glb",
    "C:\\detail-budget-v1-folder\\chair.glb",
  ]) assert.equal(isPreviewCachePath(path), false, path);
});

test("render failures use the dedicated preview message for old and new cache names", () => {
  const { resolveLoadFailureMessage } = loadSource("load-failure");
  for (const name of ["preview-v2-0.500-abcdef.glb", "chair-12345-preview-0.500.glb",
    "structure-v1-abcdef.glb", "preview-budget-v1-abcdef.glb", "detail-budget-v1-abcdef.glb"]) {
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
  assert.ok(message.startsWith("Preview failed (250 MB).\n\nPreview advice:"));
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
    assert.ok(large.startsWith(`${copy.error_model_import}\n\nPreview advice:`));
    assert.doesNotMatch(large, /IMPORT_FAILED|\{(?:stable_size|stable_tris|hard_size|hard_tris)\}/);
  }
});

test("preparation failures give localized actions without exposing internal codes or obsolete size limits", () => {
  const { resolveLoadFailureMessage, localizeBackendLoadError } = loadSource("load-failure");
  const cases = [
    ["MODEL_PREPARATION_CANCELLED", "error_model_preparation_cancelled"],
    ["MODEL_PREPARATION_LARGE_FORMAT_UNSUPPORTED", "error_model_large_format"],
    ["MODEL_PREPARATION_UNSUPPORTED_DRACO", "error_model_draco_preview"],
    ["MODEL_PREPARATION_BUDGET_EXCEEDED", "error_model_preview_budget"],
    ["MODEL_PREPARATION_INVALID_OUTPUT", "error_model_preparation"],
    ["MODEL_PREPARATION_EXTERNAL_ASSETS", "error_model_preparation"],
    ["MODEL_PREPARATION_EMPTY_OUTPUT", "error_model_preparation"],
    ["MODEL_PREPARATION_FUTURE_ERROR:details", "error_model_preparation"],
    ["MODEL_STRUCTURE_UNAVAILABLE", "error_model_preparation"],
    ["GLTFPACK_PREVIEW_FAILED:Permission denied (os error 13)", "error_model_preparation"],
  ];
  for (const locale of ["en", "zh-Hans"]) {
    const copy = ui(locale);
    for (const [raw, key] of cases) {
      assert.equal(localizeBackendLoadError(raw, copy), copy[key]);
      for (const path of ["/models/large.obj", "/models/large.stl", "/models/compressed.gltf"]) {
        for (const error of [raw, new Error(raw)]) {
          const message = resolveLoadFailureMessage(copy, path, error, null, () => 2 * 1024 ** 3);
          assert.ok(message.startsWith(copy[key]), `${locale}: ${raw}`);
          assert.doesNotMatch(message, /MODEL_PREPARATION_|MODEL_STRUCTURE_|GLTFPACK_|1 GB|hard_size|Keep sidecars/);
          if (raw.startsWith("MODEL_")) assert.equal(message, copy[key]);
        }
      }
    }
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
  await exportModelDialog("export.gltf", "/模型/原始.obj", "gltf");
  assert.deepEqual(calls, [
    { name: "load_model", path: "/模型/分离.gltf", accessRequestId: "open-attempt" },
    { name: "resolve_viewer_model_path", path: "/模型/分离.gltf", accessRequestId: "open-attempt" },
    { name: "export_model_dialog", defaultFilename: "export.glb", sourcePath: "/模型/分离.gltf", format: "glb", accessRequestId: "export-attempt" },
    { name: "export_model_dialog", defaultFilename: "export.gltf", sourcePath: "/模型/原始.obj", format: "gltf", accessRequestId: "export-attempt" },
  ]);
});

// Run real App methods without mounting WebGL or native dialogs.
function appMethods(names, globals) {
  const filename = new URL("../src/app.ts", import.meta.url);
  const file = ts.createSourceFile("app.ts", readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true);
  const appClass = file.statements.find((node) => ts.isClassDeclaration(node) && node.name.text === "App");
  const methods = appClass.members.filter((node) =>
    ts.isMethodDeclaration(node) && names.includes(node.name.getText(file)),
  );
  assert.equal(methods.length, names.length, "all tested App methods must exist");
  const code = ts.transpileModule(`class App { ${methods.map((node) => node.getText(file)).join("\n")} }; exports.App = App;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, Error, ...globals });
  return new exports.App();
}

function modelAccessApp() {
  const path = "/models/separate.gltf";
  const entry = { path, format: "gltf", file_size: 42 };
  const fresh = { ...entry, material_count: 2 };
  const calls = [];
  const cancelled = [];
  const toasts = [];
  const state = { denied: true, nextId: 0 };
  const noop = () => {};
  const app = appMethods(["openPath", "loadFolder", "cancelModelPreparation", "stopRefinement", "refineModel", "handleModelProgress"], {
    crypto: { randomUUID: () => `attempt-${++state.nextId}` },
    normalizeModelPath: async (path) => path,
    modelExtension: () => "gltf", isModelPath: () => true,
    modelFileSize: async () => 42, flushUi: async () => {},
    PREVIEW_OPTIMIZE_BYTES: 200 * 1024 ** 2,
    loadModel: async (path, id) => {
      calls.push({ operation: "metadata", id });
      if (state.denied) throw "MODEL_ASSETS_ACCESS_CANCELLED";
      if (state.metadata) return state.metadata;
      return fresh;
    },
    prepareViewerModel: async (path, id, level) => {
      calls.push({ operation: "viewer", id, level });
      if (state.denied) throw "MODEL_ASSETS_ACCESS_CANCELLED";
      if (state.prepare) return state.prepare(path, id, level);
      return { path: "/cache/packed.glb", level: "original", next_level: null };
    },
    cancelViewerPreparation: async (id) => { cancelled.push(id); },
    delay: async () => {},
    listModelsInFolder: async () => [entry],
    convertFileSrc: (path) => path,
    isPreviewCachePath: () => false,
    resolveLoadFailureMessage: loadSource("load-failure").resolveLoadFailureMessage,
    localizeBackendLoadError: loadSource("load-failure").localizeBackendLoadError,
  });
  Object.assign(app, {
    ui: ui(), loadToken: 0, openRequestToken: 0, phase: "empty", activePath: null, summary: null,
    activeLoadRequest: null, refinementState: "idle", refinementNext: null,
    models: [entry], summaryCache: new Map(), cinemaMode: false,
    paint: noop, syncLoadingProgress: noop, paintOverlay: noop, paintInspector: noop, paintRefinement: noop,
    syncFramingInsets: noop, saveInitialCameraForPath: noop,
    syncSceneGuidesAfterModelReady: noop, paintCinemaControls: noop,
    modelEntryFromPath: () => entry, tryUpsertModel: () => true,
    largeModelLoadHint: () => null, modelFileSizeForPath: () => 42,
    registerLibraryRoot: noop,
    showToast: (message, kind) => toasts.push({ message, kind }), paintCutoutModeUi: noop, cutoutFrameGuide: { scheduleUpdate: noop },
    els: { inspectorBody: { dataset: {} } },
    viewport: { clear: noop, load: async () => {}, focus: noop, cancelRefinement: noop, refine: async () => true },
  });
  return { app, state, calls, cancelled, toasts, path, fresh };
}

test("required Draco without a structure preview fails the initial open with a conversion suggestion", async () => {
  const { app, state, path } = modelAccessApp();
  state.denied = false;
  state.prepare = () => { throw "MODEL_PREPARATION_UNSUPPORTED_DRACO"; };
  await app.openPath(path);
  assert.equal(app.phase, "error");
  assert.equal(app.status, app.ui.error_model_draco_preview);
  assert.equal(app.refinementState, "idle");
});

test("cancelled load keeps its localized error and reopening refreshes metadata with a new attempt", async () => {
  const { app, state, calls, path, fresh } = modelAccessApp();
  await app.openPath(path);
  assert.equal(app.phase, "error");
  assert.equal(app.status, app.ui.error_model_access_cancelled);
  assert.equal(app.loadFailure.raw, "MODEL_ASSETS_ACCESS_CANCELLED");
  app.summaryCache.set(path, { ...fresh, material_count: 1 });
  state.denied = false;
  await app.openPath(path);
  assert.equal(app.phase, "ready");
  assert.equal(app.summary.material_count, 2);
  assert.equal(app.loadFailure, null);
  assert.equal(calls[1].id, calls[2].id);
  assert.notEqual(calls[0].id, calls[1].id);
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

test("structure is interactive before metadata and details finish; stop ignores late results and progress", async () => {
  const { app, state, path, cancelled, fresh } = modelAccessApp();
  state.denied = false;
  let details, metadata;
  state.metadata = new Promise((resolve) => { metadata = resolve; });
  state.prepare = (_path, _id, level) => level
    ? new Promise((resolve) => { details = resolve; })
    : { path: "/cache/bounds.glb", level: "structure", next_level: "preview" };
  let swaps = 0;
  app.viewport.refine = async () => { swaps++; return true; };
  await app.openPath(path);
  assert.equal(app.phase, "ready");
  assert.equal(app.summary, null, "metadata must not delay the first model");
  assert.equal(app.preparedLevel, "structure");
  assert.equal(app.refinementState, "preparing");
  const request = app.activeLoadRequest;
  app.handleModelProgress("pack", { request_id: "old-request", percent: 90 });
  assert.equal(app.refinementPercent, 0);
  app.handleModelProgress("pack", { request_id: request, percent: 30 });
  assert.equal(app.refinementPercent, 30);
  app.stopRefinement();
  assert.equal(app.phase, "ready");
  assert.equal(app.refinementState, "stopped");
  assert.deepEqual(cancelled, [request]);
  details({ path: "/cache/preview.glb", level: "preview", next_level: "detail" });
  metadata(fresh);
  await new Promise(setImmediate);
  assert.equal(swaps, 0);
  assert.equal(app.refinementState, "stopped");
  assert.equal(app.summary.material_count, 2);
  app.handleModelProgress("pack", { request_id: request, percent: 100 });
  assert.equal(app.refinementPercent, 30);
});

test("a failed detail replacement keeps the preview and reopening the same path retries", async () => {
  const { app, state, toasts, path } = modelAccessApp();
  state.denied = false;
  state.prepare = (_path, _id, level) => level
    ? Promise.reject(new Error("MODEL_PREPARATION_BUDGET_EXCEEDED"))
    : { path: "/cache/preview.glb", level: "preview", next_level: "detail" };
  await app.openPath(path);
  await new Promise(setImmediate);
  const oldRequest = app.activeLoadRequest;
  assert.equal(app.phase, "ready");
  assert.equal(app.refinementState, "failed");
  assert.equal(app.preparedLevel, "preview");
  assert.deepEqual(toasts.at(-1), { message: app.ui.error_model_preview_budget, kind: "error" });
  state.prepare = () => ({ path: "/cache/detail.glb", level: "detail", next_level: null });
  await app.openPath(path);
  assert.notEqual(app.activeLoadRequest, oldRequest);
  assert.equal(app.phase, "ready");
  assert.equal(app.refinementState, "idle");
  assert.equal(app.preparedLevel, "detail");
});

function cacheClearApp() {
  const state = { calls: 0, result: { bytes_cleared: 1234 } };
  const element = () => ({ classList: { toggle() {} }, setAttribute() {}, style: {} });
  const app = appMethods(["paintCacheSection", "performClearCache", "paintRefinement"], {
    formatBytes: (bytes) => `${bytes} B`,
    clearViewerCache: async () => { state.calls++; return state.result; },
  });
  Object.assign(app, {
    phase: "ready", refinementState: "idle", preparedLevel: "original",
    settingsOpen: true, viewerCacheBytes: 1234, cacheClearing: false, cacheConfirmOpen: true,
    ui: { clear_cache_success: "Cleared {size}", clear_cache_empty: "Empty", clear_cache_failed: "Failed" },
    els: { clearCacheBtn: element(), cacheClearConfirmOk: element(), cacheSize: element(), refinement: element() },
    syncCacheClearPop() {}, showToast() {}, refreshViewerCacheSize() {},
  });
  return { app, state };
}

test("cache cleanup is blocked during loading or refinement, including an already open confirmation", async () => {
  const { app, state } = cacheClearApp();
  for (const [phase, refinementState] of [["loading", "idle"], ["ready", "preparing"]]) {
    Object.assign(app, { phase, refinementState, cacheConfirmOpen: true });
    app.paintRefinement();
    assert.equal(app.els.clearCacheBtn.disabled, true);
    assert.equal(app.els.cacheClearConfirmOk.disabled, true);
    assert.equal(app.cacheConfirmOpen, false);
    await app.performClearCache();
    assert.equal(state.calls, 0, "even a stale click must not send cleanup IPC");
  }
  for (const refinementState of ["idle", "failed", "stopped"]) {
    Object.assign(app, { phase: "ready", refinementState, settingsOpen: false });
    app.paintRefinement();
    assert.equal(app.els.clearCacheBtn.disabled, false, "completion updates the button before settings reopen");
    assert.equal(app.els.cacheClearConfirmOk.disabled, false);
  }
});

test("idle cache cleanup still works and prevents concurrent cleanup requests", async () => {
  const { app, state } = cacheClearApp();
  let finish;
  state.result = new Promise(resolve => { finish = resolve; });
  const pending = app.performClearCache();
  assert.equal(state.calls, 1);
  assert.equal(app.cacheClearing, true);
  assert.equal(app.els.clearCacheBtn.disabled, true);
  assert.equal(app.els.cacheClearConfirmOk.disabled, true);
  await app.performClearCache();
  assert.equal(state.calls, 1);
  finish({ bytes_cleared: 1234 });
  await pending;
  assert.equal(app.cacheClearing, false);
  assert.equal(app.viewerCacheBytes, 0);
  assert.equal(app.els.clearCacheBtn.disabled, true, "empty cache remains disabled");
});

function modelExportApp() {
  const calls = [];
  const toasts = [];
  const state = { response: Promise.resolve(null) };
  const app = appMethods(["onMenuAction", "runShortcut", "exportActiveModel"], {
    exportModelDialog: (defaultFilename, sourcePath, format) => {
      calls.push({ defaultFilename, sourcePath, format });
      return state.response;
    },
    localizeBackendLoadError: loadSource("load-failure").localizeBackendLoadError,
  });
  Object.assign(app, {
    phase: "ready", activePath: "/模型/原始 chair.obj", modelExporting: false,
    viewerPath: "/cache/preview-v2-0.100-small.glb",
    ui: { ...ui(), cutout_no_model: "Open a model first.", export_model_exporting: "Exporting model…",
      export_model_saved: "Exported to {path}", export_model_failed: "Couldn't export the model." },
    showToast: (message, kind) => toasts.push({ message, kind }),
  });
  return { app, calls, toasts, state };
}

function updateDownloadApp() {
  const events = [];
  const state = { install: async () => {}, failSubscribe: false };
  const app = appMethods(["downloadUpdateInApp"], {
    onUpdateDownloadProgress: async () => {
      if (state.failSubscribe) throw new Error("event listener unavailable");
      return () => events.push("unlisten");
    },
    downloadUpdate: async () => { events.push("download"); return "/cache/updates/Trivor.dmg"; },
    installDownloadedUpdate: async (path) => {
      events.push(["open", path]);
      await state.install();
    },
  });
  Object.assign(app, {
    updateDownloadState: "idle", updateState: "available",
    updateResult: { download_url: "https://example.test/Trivor.dmg" },
    ui: { update_download_complete: "Installer opened. Install in Finder.", update_download_failed: "Couldn't download or open the installer." },
    clearUpdateStatusTimer() {}, paintUpdateBanner() {}, paintAboutSection() {}, scheduleUpdateStatusClear() {},
    showToast: (message, kind) => events.push(["toast", message, kind]),
    dismissUpdateBanner: () => events.push("dismiss"),
    openUpdateInBrowser: async () => events.push("fallback"),
  });
  return { app, events, state };
}

test("update success is reported only after the installer opens and duplicate requests are ignored", async () => {
  const { app, events, state } = updateDownloadApp();
  let opened;
  state.install = () => new Promise((resolve) => { opened = resolve; });
  const downloading = app.downloadUpdateInApp();
  await new Promise(setImmediate);
  assert.equal(app.updateDownloadState, "downloading");
  assert.equal(events.some((event) => Array.isArray(event) && event[0] === "toast"), false);
  await app.downloadUpdateInApp();
  assert.equal(events.filter((event) => event === "download").length, 1);
  opened();
  await downloading;
  assert.deepEqual(events, ["download", ["open", "/cache/updates/Trivor.dmg"],
    ["toast", app.ui.update_download_complete, "success"], "dismiss", "unlisten"]);
  assert.equal(app.updateDownloadState, "idle");
});

test("an installer open failure never reports success and releases download state for retry", async () => {
  const { app, events, state } = updateDownloadApp();
  state.install = async () => { throw new Error("opener failed"); };
  await app.downloadUpdateInApp();
  assert.deepEqual(events, ["download", ["open", "/cache/updates/Trivor.dmg"],
    ["toast", app.ui.update_download_failed, "error"], "fallback", "unlisten"]);
  assert.equal(app.updateDownloadState, "idle");
  events.length = 0;
  state.install = async () => {};
  await app.downloadUpdateInApp();
  assert.ok(events.some((event) => Array.isArray(event) && event[2] === "success"));
});

test("a download listener registration failure also clears the busy state", async () => {
  const { app, events, state } = updateDownloadApp();
  state.failSubscribe = true;
  await app.downloadUpdateInApp();
  assert.deepEqual(events, [["toast", app.ui.update_download_failed, "error"], "fallback"]);
  assert.equal(app.updateDownloadState, "idle");
});

test("glTF export uses the original path and its filename for every supported source format", async () => {
  const { app, calls } = modelExportApp();
  for (const sourcePath of [
    "/模型/原始 chair.obj", "/models/part.v2.STL", "/models/separate.gltf", "C:\\模型\\packed model.glb",
  ]) {
    app.activePath = sourcePath;
    await app.exportActiveModel("gltf");
  }
  assert.deepEqual(calls, [
    { defaultFilename: "原始 chair.gltf", sourcePath: "/模型/原始 chair.obj", format: "gltf" },
    { defaultFilename: "part.v2.gltf", sourcePath: "/models/part.v2.STL", format: "gltf" },
    { defaultFilename: "separate.gltf", sourcePath: "/models/separate.gltf", format: "gltf" },
    { defaultFilename: "packed model.gltf", sourcePath: "C:\\模型\\packed model.glb", format: "gltf" },
  ]);
});

test("the new native menu exports glTF while the existing menu and shortcut still export GLB", async () => {
  const { app, calls } = modelExportApp();
  app.onMenuAction("export-model-gltf");
  await new Promise(setImmediate);
  app.onMenuAction("export-model");
  await new Promise(setImmediate);
  assert.equal(app.runShortcut("export_model"), true);
  await new Promise(setImmediate);
  assert.deepEqual(calls.map(({ format, defaultFilename }) => [format, defaultFilename]), [
    ["gltf", "原始 chair.gltf"], ["glb", "原始 chair.glb"], ["glb", "原始 chair.glb"],
  ]);
});

test("export formats share the busy guard and cancellation releases it for retry", async () => {
  const { app, calls, toasts, state } = modelExportApp();
  let finish;
  state.response = new Promise((resolve) => { finish = resolve; });
  const pending = app.exportActiveModel("gltf");
  assert.equal(app.modelExporting, true);
  app.activePath = "/models/next.glb";
  await app.exportActiveModel();
  assert.equal(calls.length, 1, "a second export must not open another save dialog");
  assert.equal(calls[0].sourcePath, "/模型/原始 chair.obj", "in-flight source is captured");
  finish(null);
  await pending;
  assert.equal(app.modelExporting, false);
  assert.deepEqual(toasts, [{ message: app.ui.export_model_exporting, kind: undefined }]);
  state.response = Promise.resolve("/exports/next.gltf");
  await app.exportActiveModel("gltf");
  assert.equal(calls.length, 2);
  assert.equal(app.modelExporting, false);
  assert.deepEqual(toasts.at(-1), { message: "Exported to /exports/next.gltf", kind: "success" });
});

test("glTF failures keep localized errors and reset export state; unloaded models cannot export", async () => {
  const { app, calls, toasts, state } = modelExportApp();
  state.response = Promise.reject("MODEL_ASSETS_ACCESS_CANCELLED");
  await app.exportActiveModel("gltf");
  assert.equal(app.modelExporting, false);
  assert.deepEqual(toasts.at(-1), { message: app.ui.error_model_access_cancelled, kind: "error" });
  app.phase = "loading";
  await app.exportActiveModel("gltf");
  assert.equal(calls.length, 1);
  assert.equal(toasts.at(-1).message, app.ui.cutout_no_model);
  app.phase = "ready";
  state.response = Promise.reject(new Error("unrecognized failure"));
  await app.exportActiveModel("gltf");
  assert.equal(app.modelExporting, false);
  assert.deepEqual(toasts.at(-1), { message: app.ui.export_model_failed, kind: "error" });
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
