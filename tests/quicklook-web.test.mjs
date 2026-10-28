import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { createDefaultContainer, write as writeKtx } from "three/addons/libs/ktx-parse.module.js";

const source = readFileSync(new URL("../quick-look/web/glb-guard.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const exports = {};
vm.runInNewContext(code, { exports, TextDecoder, atob });
const { inspectGlb, LIMITS, THUMBNAIL_LIMITS, PREVIEW_LIMITS, MAX_PREVIEW_LIMITS, resolvePreviewBudget } = exports;

function box() {
  return {
    asset: { version: "2.0" },
    buffers: [{ byteLength: 168 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 96 }, { buffer: 0, byteOffset: 96, byteLength: 72 }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: "VEC3", min: [-1, -.6, -.4], max: [1, .6, .4] },
      { bufferView: 1, componentType: 5123, count: 36, type: "SCALAR" },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0,
  };
}
function glb(json, binary = new Uint8Array(168)) {
  const content = Buffer.from(JSON.stringify(json));
  const jsonSize = (content.length + 3) & ~3;
  const binSize = (binary.length + 3) & ~3;
  const result = new ArrayBuffer(20 + jsonSize + (binSize ? 8 + binSize : 0));
  const data = new Uint8Array(result), view = new DataView(result);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, data.length, true);
  view.setUint32(12, jsonSize, true);
  view.setUint32(16, 0x4e4f534a, true);
  data.fill(0x20, 20, 20 + jsonSize);
  data.set(content, 20);
  if (binSize) {
    view.setUint32(20 + jsonSize, binSize, true);
    view.setUint32(24 + jsonSize, 0x004e4942, true);
    data.set(binary, 28 + jsonSize);
  }
  return result;
}
function rejects(json, error, binary) {
  assert.throws(() => inspectGlb(glb(json, binary)), (e) => e.code === error, `expected ${error}`);
}
function pngHeader(width, height) {
  const png = Buffer.alloc(24);
  png.set([137,80,78,71,13,10,26,10]);
  png.writeUInt32BE(13, 8);
  png.write("IHDR", 12);
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

function rgbaMipBytes(width, height) {
  return Array.from({ length: 1 + Math.floor(Math.log2(Math.max(width, height))) }, (_, level) =>
    Math.max(1, Math.floor(width / 2 ** level)) * Math.max(1, Math.floor(height / 2 ** level)) * 4).reduce((sum, bytes) => sum + bytes, 0);
}

function compressedKtx(format, width, height, block, model) {
  const container = createDefaultContainer();
  Object.assign(container, { vkFormat: format, pixelWidth: width, pixelHeight: height, levelCount: 1 });
  const length = Math.max(block[3] ?? 1, Math.ceil(width / block[0])) * Math.max(block[3] ?? 1, Math.ceil(height / block[1])) * block[2];
  container.levels = [{ levelData: new Uint8Array(length), uncompressedByteLength: length }];
  Object.assign(container.dataFormatDescriptor[0], { colorModel: model, transferFunction: 1,
    texelBlockDimension: [block[0] - 1, block[1] - 1, 0, 0], bytesPlane: [block[2], 0, 0, 0, 0, 0, 0, 0] });
  return Buffer.from(writeKtx(container));
}

function ktxHeader(width, height, { format = 0, model = 163, scheme = 1, typeSize = 1 } = {}) {
  // One level and one DFD descriptor. Payload correctness is the decoder's job;
  // this bounded fixture exercises the preflight's format/allocation metadata.
  const raw = format !== 0;
  const length = model === 166 ? Math.ceil(width / 4) * Math.ceil(height / 4) * 16 : raw ? width * height * 4 : 1;
  const ktx = Buffer.alloc(148 + length);
  ktx.set([171,75,84,88,32,50,48,187,13,10,26,10]);
  for (const [offset, value] of [[12, format], [16, typeSize], [20, width], [24, height], [36, 1], [40, 1], [44, scheme], [48, 104], [52, 44], [104, 44]]) ktx.writeUInt32LE(value, offset);
  ktx.writeBigUInt64LE(148n, 80);
  ktx.writeBigUInt64LE(BigInt(length), 88);
  ktx.writeBigUInt64LE(BigInt(scheme === 1 ? 0 : length), 96);
  ktx.writeUInt16LE(2, 112);
  ktx.writeUInt16LE(40, 114);
  ktx[116] = model;
  if (format === 0) ktx.set([3, 3, 0, 0], 120);
  return ktx;
}

function texturedBox(count = 9, edge = 2048) {
  const json = box();
  json.images = Array.from({ length: count }, () => ({ uri: `data:image/png;base64,${pngHeader(edge, edge).toString("base64")}` }));
  json.textures = json.images.map((_, source) => ({ source }));
  return json;
}

function assertLimit(operation, metric, actual, limit) {
  assert.throws(operation, (error) => {
    assert.equal(error.code, "tooLarge");
    assert.equal(error.detail?.metric, metric);
    assert.equal(error.detail?.actual, actual);
    assert.equal(error.detail?.limit, limit);
    return true;
  });
}

function overlappingViews(count = 16, shared = false) {
  const size = 1024 * 1024;
  const json = {
    asset: { version: "2.0" }, buffers: [{ byteLength: size }],
    bufferViews: Array.from({ length: shared ? 1 : count }, () => ({ buffer: 0, byteOffset: 0, byteLength: size })),
    accessors: Array.from({ length: count }, (_, index) => ({ bufferView: shared ? 0 : index, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] })),
    meshes: Array.from({ length: count }, (_, index) => ({ primitives: [{ attributes: { POSITION: index } }] })),
    nodes: Array.from({ length: count }, (_, mesh) => ({ mesh })), scenes: [{ nodes: Array.from({ length: count }, (_, i) => i) }], scene: 0,
  };
  const binary = new Uint8Array(size);
  new Float32Array(binary.buffer, 0, 9).set([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  return glb(json, binary);
}

function webHarness(entry, payload, declaredBytes = payload.byteLength, { onFetch } = {}) {
  const messages = [], elements = new Map(), viewers = [], fetches = { bodyReads: 0 };
  const element = (tag) => {
    const listeners = new Map();
    const result = {
      dataset: {}, style: {}, attributes: {},
      setAttribute(name, value) { this.attributes[name] = value; },
      removeAttribute(name) { delete this.attributes[name]; },
      addEventListener(type, listener) { listeners.set(type, listener); },
      removeEventListener(type) { listeners.delete(type); },
      emit(type) { listeners.get(type)?.(); },
      append(child) { if (child.id) elements.set(`#${child.id}`, child); },
      pause() {}, remove() {},
      getCameraOrbit() { return { theta: 0, phi: 1, radius: 2 }; },
      getCameraTarget() { return { x: 0, y: 0, z: 0 }; },
      getFieldOfView() { return 30; },
    };
    if (tag === "model-viewer") viewers.push(result);
    return result;
  };
  const document = {
    baseURI: "http://preview.test/", documentElement: {},
    querySelector(selector) { if (!elements.has(selector)) elements.set(selector, element()); return elements.get(selector); },
    createElement: element,
    addEventListener() {},
  };
  const window = { addEventListener() {}, webkit: { messageHandlers: {
    preview: { postMessage(message) { messages.push(message); } },
    thumbnail: { postMessage(message) { messages.push(message); } },
  } } };
  const source = readFileSync(new URL(`../quick-look/web/${entry}.ts`, import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, {
    exports: {}, window, document, navigator: { language: "en" }, URL, Blob, AbortController, setTimeout, clearTimeout,
    requestAnimationFrame(callback) { callback(0); return 1; },
    require(name) {
      if (name === "./glb-guard") return exports;
      if (name === "@google/model-viewer") return { ModelViewerElement: class {} };
      return {};
    },
    async fetch() {
      onFetch?.();
      return { ok: true, headers: { get: () => String(declaredBytes) }, body: null, arrayBuffer: async () => { fetches.bodyReads++; return payload; } };
    },
  });
  return { window, messages, elements, viewers, fetches };
}

function animatedBox({ frames = 4096, channels = 32, normalized = true, weights = false, primitives = 1 } = {}) {
  const json = box();
  const width = weights ? 2 : 4;
  const componentBytes = normalized ? 1 : 4;
  const binary = new Uint8Array(168 + frames * 4 + frames * width * componentBytes);
  const times = new Float32Array(binary.buffer, 168, frames);
  for (let i = 0; i < frames; i++) times[i] = i / 60;
  const output = normalized
    ? new Uint8Array(binary.buffer, 168 + frames * 4)
    : new Float32Array(binary.buffer, 168 + frames * 4);
  for (let i = 0; i < frames; i++) output[i * width + width - 1] = normalized ? 255 : 1;
  json.buffers[0].byteLength = binary.length;
  json.bufferViews.push({ buffer: 0, byteOffset: 168, byteLength: frames * 4 },
    { buffer: 0, byteOffset: 168 + frames * 4, byteLength: output.byteLength });
  json.accessors.push({ bufferView: 2, componentType: 5126, count: frames, type: "SCALAR", min: [0], max: [(frames - 1) / 60] },
    { bufferView: 3, componentType: normalized ? 5121 : 5126, normalized, count: frames * (weights ? width : 1), type: weights ? "SCALAR" : "VEC4" });
  if (weights) json.meshes[0].primitives[0].targets = [{ POSITION: 0 }, { POSITION: 0 }];
  json.meshes[0].primitives = Array.from({ length: primitives }, () => structuredClone(json.meshes[0].primitives[0]));
  json.nodes = Array.from({ length: channels }, (_, i) => weights || i === 0 ? { mesh: 0 } : {});
  json.scenes[0].nodes = json.nodes.map((_, i) => i);
  json.animations = [{ samplers: [{ input: 2, output: 3 }], channels: json.nodes.map((_, node) => ({ sampler: 0, target: { node, path: weights ? "weights" : "rotation" } })) }];
  return { json, binary };
}

test("Quick Look budgets actual normalized animation expansion for every channel", async () => {
  const { json, binary } = animatedBox();
  const payload = glb(json, binary);
  const budget = inspectGlb(payload);
  const staticBudget = inspectGlb(glb({ ...json, animations: [] }, binary));
  const parsed = await new GLTFLoader().parseAsync(payload, "");
  const tracks = parsed.animations[0].tracks;
  assert.equal(tracks.length, 32);
  assert.equal(new Set(tracks.map((track) => track.values.buffer)).size, 32);
  const expandedBytes = tracks.reduce((bytes, track) => bytes + track.values.byteLength, 0);
  assert.equal(expandedBytes, 2 * 1024 * 1024);
  assert.equal(budget.geometryBytes, staticBudget.geometryBytes + expandedBytes);
});

test("Quick Look rejects small animation files whose channels would expand past the budget", () => {
  // Validate the declarations without allocating the 512 MiB decoded output.
  const { json, binary } = animatedBox({ frames: 16384, channels: 2048 });
  const payload = glb(json, binary);
  assert.ok(payload.byteLength < 512 * 1024);
  assert.throws(() => inspectGlb(payload), (error) => error.code === "tooLarge");
});

test("Quick Look preserves shared float animation outputs without charging each track again", async () => {
  const { json, binary } = animatedBox({ normalized: false });
  const payload = glb(json, binary);
  const parsed = await new GLTFLoader().parseAsync(payload, "");
  assert.equal(new Set(parsed.animations[0].tracks.map((track) => track.values.buffer)).size, 1);
  assert.equal(inspectGlb(payload).geometryBytes, inspectGlb(glb({ ...json, animations: [] }, binary)).geometryBytes);
});

test("Quick Look counts morph tracks across mesh instances but shares each channel's expanded values", async () => {
  const { json, binary } = animatedBox({ frames: 32, channels: 8, weights: true, primitives: 2 });
  const payload = glb(json, binary);
  const parsed = await new GLTFLoader().parseAsync(payload, "");
  const tracks = parsed.animations[0].tracks;
  assert.equal(tracks.length, 16);
  const arrays = new Set(tracks.map((track) => track.values.buffer));
  assert.equal(arrays.size, 8);
  const expandedBytes = [...arrays].reduce((bytes, array) => bytes + array.byteLength, 0);
  assert.equal(inspectGlb(payload).geometryBytes, inspectGlb(glb({ ...json, animations: [] }, binary)).geometryBytes + expandedBytes);
});

test("Quick Look bounds aggregate animation channels, samplers and generated morph tracks", () => {
  const { json, binary } = animatedBox({ frames: 2, channels: 128, weights: true, primitives: 4 });
  // 4096 channels fit, but four morph primitives produce 16384 tracks.
  json.animations = Array.from({ length: 32 }, () => json.animations[0]);
  rejects(json, "tooLarge", binary);
  const manyChannels = animatedBox({ frames: 2, channels: 1 });
  manyChannels.json.animations[0].channels = Array.from({ length: LIMITS.animationChannels + 1 }, () => manyChannels.json.animations[0].channels[0]);
  rejects(manyChannels.json, "tooLarge", manyChannels.binary);
  const manySamplers = animatedBox({ frames: 2, channels: 1 });
  manySamplers.json.animations[0].samplers = Array.from({ length: LIMITS.animationSamplers + 1 }, () => ({ input: 2, output: 3 }));
  rejects(manySamplers.json, "tooLarge", manySamplers.binary);
});

test("Quick Look validates animation references and output shape before loading", () => {
  for (const change of [
    (json) => { json.animations[0].channels[0].sampler = 99; },
    (json) => { json.animations[0].channels[0].target.node = 99; },
    (json) => { json.animations[0].samplers[0].output = 99; },
    (json) => { json.accessors[3].count--; },
    (json) => { json.animations[0].samplers[0].interpolation = "UNKNOWN"; },
    (json) => { json.animations[0].channels[0].target.path = "weights"; },
  ]) {
    const { json, binary } = animatedBox({ frames: 2, channels: 1 });
    change(json);
    rejects(json, "invalid", binary);
  }
});

test("Quick Look accepts a bounded self-contained GLB with exact geometry counts", () => {
  const result = inspectGlb(glb(box()));
  assert.equal(result.triangles, 12);
  assert.equal(result.draws, 1);
  assert.equal(result.geometryBytes, 8 * 3 * 4 + 36 * 4);
  assert.equal(result.textureBytes, 0);
});

test("Quick Look rejects truncated and inconsistent GLB headers and chunks", () => {
  const valid = glb(box());
  for (const size of [0, 4, 19, valid.byteLength - 1]) {
    assert.throws(() => inspectGlb(valid.slice(0, size)), (e) => e.code === "invalid");
  }
  for (const [offset, value] of [[0, 0], [4, 1], [8, 20], [12, 0xffffffff], [16, 0]]) {
    const copy = valid.slice(0);
    new DataView(copy).setUint32(offset, value, true);
    assert.throws(() => inspectGlb(copy), (e) => ["invalid", "tooLarge"].includes(e.code));
  }
});

test("Quick Look rejects oversized files before parsing and oversized JSON before decoding", () => {
  assert.throws(() => inspectGlb(new ArrayBuffer(LIMITS.file + 1)), (e) => e.code === "tooLarge");
  const payload = glb({ ...box(), extras: { padding: "x".repeat(LIMITS.json) } });
  assert.throws(() => inspectGlb(payload), (e) => e.code === "tooLarge");
});

test("Quick Look rejects network, local-file and executable resource URIs including extensions", () => {
  for (const uri of ["texture.png", "https://example.com/x.png", "file:///etc/passwd", "//example.com/x", "data:image/svg+xml;base64,PHN2Zz4=", "data:text/html;base64,PGgxPg=="]) {
    rejects({ ...box(), images: [{ uri }] }, "externalResources");
    rejects({ ...box(), extensions: { VENDOR: { resource: { uri } } } }, "externalResources");
  }
});

test("Quick Look checks embedded image dimensions and cumulative GPU texture cost", () => {
  const json = box();
  json.images = [{ uri: `data:image/png;base64,${pngHeader(1024, 1024).toString("base64")}` }];
  json.textures = [{ source: 0 }];
  assert.equal(inspectGlb(glb(json)).textureBytes, rgbaMipBytes(1024, 1024));
  json.textures = Array.from({ length: 25 }, () => ({ source: 0 }));
  rejects(json, "tooLarge");
  json.textures = [{ source: 0 }];
  json.images[0].uri = `data:image/png;base64,${pngHeader(16384, 16384).toString("base64")}`;
  rejects(json, "tooLarge");
});

test("Quick Look validates images stored inside the GLB BIN chunk", () => {
  const json = box();
  const binary = new Uint8Array(192);
  binary.set(pngHeader(512, 256), 168);
  json.buffers[0].byteLength = binary.length;
  json.bufferViews.push({ buffer: 0, byteOffset: 168, byteLength: 24 });
  json.images = [{ bufferView: 2, mimeType: "image/png" }];
  json.textures = [{ source: 0 }];
  assert.equal(inspectGlb(glb(json, binary)).textureBytes, rgbaMipBytes(512, 256));
  json.bufferViews[2].byteLength = 25;
  rejects(json, "invalid", binary);
});

test("Quick Look does not treat unknown texture sizes as zero", () => {
  for (const mime of ["image/png", "image/jpeg", "image/webp", "image/ktx2"]) {
    rejects({ ...box(), images: [{ uri: `data:${mime};base64,AAAA` }] }, "unsupported");
  }
});

test("Quick Look supports WebP and KTX2 texture dimensions without decoding pixels", () => {
  const webp = Buffer.alloc(30);
  webp.write("RIFF", 0); webp.write("WEBP", 8); webp.write("VP8X", 12);
  webp.writeUIntLE(511, 24, 3); webp.writeUIntLE(255, 27, 3);
  const ktx = ktxHeader(512, 256);
  for (const [mime, bytes] of [["image/webp", webp], ["image/ktx2", ktx]]) {
    const json = { ...box(), images: [{ uri: `data:${mime};base64,${bytes.toString("base64")}` }] };
    assert.equal(inspectGlb(glb(json)).textureBytes, rgbaMipBytes(512, 256));
  }
});

test("Quick Look rejects oversized decoded geometry even in a tiny sparse GLB", () => {
  const json = box();
  delete json.accessors[0].bufferView;
  json.accessors[0].count = LIMITS.geometry;
  rejects(json, "tooLarge");
  json.accessors[0].count = -1;
  rejects(json, "invalid");
  json.accessors[0].count = 1.1;
  rejects(json, "invalid");
});

test("Quick Look includes meshopt decompression and virtual fallback buffers in its budget", () => {
  const json = box();
  json.buffers.push({ byteLength: 96, extensions: { EXT_meshopt_compression: { fallback: true } } });
  json.bufferViews[0] = {
    buffer: 1, byteLength: 96,
    extensions: { EXT_meshopt_compression: { buffer: 0, byteOffset: 0, byteLength: 96, byteStride: 12, count: 8, mode: "ATTRIBUTES" } },
  };
  json.extensionsRequired = ["EXT_meshopt_compression"];
  assert.equal(inspectGlb(glb(json)).triangles, 12);
  json.bufferViews[0].extensions.EXT_meshopt_compression.count = LIMITS.geometry;
  rejects(json, "tooLarge");
});

test("Quick Look counts geometry for every scene instance, not only unique meshes", () => {
  const json = box();
  json.accessors[1].count = 6000;
  json.nodes = Array.from({ length: 501 }, () => ({ mesh: 0 }));
  json.scenes = [{ nodes: json.nodes.map((_, i) => i) }];
  rejects(json, "tooLarge");
});

test("Quick Look bounds GPU instancing and draw calls", () => {
  const json = box();
  json.accessors.push({ componentType: 5126, count: LIMITS.nodes + 1, type: "VEC3" });
  json.nodes[0].extensions = { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 2 } } };
  rejects(json, "tooLarge");
  delete json.nodes[0].extensions;
  json.nodes = Array.from({ length: 513 }, () => ({ mesh: 0 }));
  json.scenes = [{ nodes: json.nodes.map((_, i) => i) }];
  rejects(json, "tooLarge");
});

test("Quick Look rejects cyclic, multiply-parented and excessive-depth scene graphs", () => {
  const cyclic = box(); cyclic.nodes[0].children = [0];
  rejects(cyclic, "invalid");
  const shared = box(); shared.nodes = [{ children: [2] }, { children: [2] }, { mesh: 0 }];
  rejects(shared, "invalid");
  const deep = box();
  deep.nodes = Array.from({ length: 140 }, (_, i) => i < 139 ? { children: [i + 1] } : { mesh: 0 });
  rejects(deep, "tooLarge");
  deep.nodes = Array.from({ length: 140 }, (_, i) => i > 0 ? { children: [i - 1] } : { mesh: 0 });
  deep.scenes = [{ nodes: [139] }];
  rejects(deep, "tooLarge");
  // Animations can load nodes outside the selected scene. Reverse-ordered
  // descendants must not bypass the depth limit through cached DFS visits.
  const outsideScene = box();
  outsideScene.nodes = [{ mesh: 0 }, ...Array.from({ length: 140 }, (_, i) => i ? { children: [i] } : {})];
  rejects(outsideScene, "tooLarge");
});

test("Quick Look rejects out-of-range references and unknown required extensions", () => {
  const missingPosition = box(); missingPosition.meshes[0].primitives[0].attributes.POSITION = 3;
  rejects(missingPosition, "invalid");
  const missingNode = box(); missingNode.scenes[0].nodes = [9000];
  rejects(missingNode, "invalid");
  const extension = box(); extension.extensionsRequired = ["VENDOR_unavailable"];
  rejects(extension, "unsupported");
  rejects({ asset: { version: "2.0" }, scenes: [{ nodes: [] }] }, "unsupported", new Uint8Array());
});

test("Quick Look uses bundled decoder URLs and a restricted standalone document", () => {
  const main = readFileSync(new URL("../quick-look/web/main.ts", import.meta.url), "utf8");
  const html = readFileSync(new URL("../quick-look/web/index.html", import.meta.url), "utf8");
  for (const decoder of ["./decoders/draco/", "./decoders/basis/", "./decoders/meshopt/meshopt_decoder.js"]) assert.ok(main.includes(decoder));
  assert.ok(!main.includes("gstatic.com"));
  assert.ok(html.includes("default-src 'none'"));
  assert.ok(html.includes("object-src 'none'"));
  assert.ok(html.includes("base-uri 'none'"));
});

test("explicit previews allow larger textures while omitted profiles retain thumbnail limits", () => {
  const payload = glb(texturedBox());
  const decoded = 9 * rgbaMipBytes(2048, 2048);
  const preview = inspectGlb(payload, PREVIEW_LIMITS);
  assert.equal(preview.textureBytes, decoded);
  // Decoded image pixels must not be charged to geometry as well.
  assert.equal(preview.geometryBytes, inspectGlb(glb(box())).geometryBytes);
  assertLimit(() => inspectGlb(payload, THUMBNAIL_LIMITS), "textures", decoded, 128 * 1024 * 1024);
  assertLimit(() => inspectGlb(payload), "textures", decoded, 128 * 1024 * 1024);
  assert.equal(LIMITS, THUMBNAIL_LIMITS);
});

test("explicit preview profiles apply to larger JSON, node arrays and draw counts", () => {
  const largeJSON = glb({ ...box(), extras: { padding: "x".repeat(THUMBNAIL_LIMITS.json) } });
  assert.equal(inspectGlb(largeJSON, PREVIEW_LIMITS).draws, 1);
  assertLimit(() => inspectGlb(largeJSON), "json", new DataView(largeJSON).getUint32(12, true), THUMBNAIL_LIMITS.json);
  const manyNodes = box();
  manyNodes.nodes = [{ mesh: 0 }, ...Array.from({ length: THUMBNAIL_LIMITS.nodes }, () => ({}))];
  const nodes = glb(manyNodes);
  assert.equal(inspectGlb(nodes, PREVIEW_LIMITS).draws, 1);
  assertLimit(() => inspectGlb(nodes), "nodes", THUMBNAIL_LIMITS.nodes + 1, THUMBNAIL_LIMITS.nodes);
  const manyDraws = box();
  manyDraws.nodes = Array.from({ length: THUMBNAIL_LIMITS.draws + 1 }, () => ({ mesh: 0 }));
  manyDraws.scenes[0].nodes = manyDraws.nodes.map((_, i) => i);
  const draws = glb(manyDraws);
  assert.equal(inspectGlb(draws, PREVIEW_LIMITS).draws, 513);
  assertLimit(() => inspectGlb(draws), "draws", 513, 512);
});

test("budget boundaries accept exact limits and explain each exceeded resource", () => {
  const payload = glb(box());
  const exact = { ...THUMBNAIL_LIMITS, file: payload.byteLength, json: new DataView(payload).getUint32(12, true), geometry: 240, triangles: 12, draws: 1 };
  assert.equal(inspectGlb(payload, exact).draws, 1);
  for (const metric of ["file", "json", "geometry", "triangles", "draws"]) {
    assertLimit(() => inspectGlb(payload, { ...exact, [metric]: exact[metric] - 1 }), metric, exact[metric], exact[metric] - 1);
  }
  assertLimit(() => inspectGlb(glb({ ...box(), materials: Array.from({ length: 513 }, () => ({})) })), "entries", 513, 512);
  const nested = box();
  nested.extras = {};
  let child = nested.extras;
  for (let i = 0; i < 10; i++) { child.next = {}; child = child.next; }
  assertLimit(() => inspectGlb(glb(nested), { ...THUMBNAIL_LIMITS, depth: 8 }), "depth", 9, 8);
  const animation = animatedBox({ frames: 2, channels: 1 });
  for (const metric of ["animationChannels", "animationSamplers", "animationTracks"]) {
    assertLimit(() => inspectGlb(glb(animation.json, animation.binary), { ...THUMBNAIL_LIMITS, [metric]: 0 }), metric, 1, 0);
  }
});

test("Quick Look budgets the real copies made for overlapping buffer views", async () => {
  const payload = overlappingViews();
  const parsed = await new GLTFLoader().parseAsync(payload, "");
  const buffers = new Set();
  parsed.scene.traverse((object) => { if (object.isMesh) buffers.add(object.geometry.attributes.position.array.buffer); });
  assert.equal(buffers.size, 16);
  const copiedBytes = [...buffers].reduce((bytes, buffer) => bytes + buffer.byteLength, 0);
  assert.equal(copiedBytes, 16 * 1024 * 1024);
  assert.equal(inspectGlb(payload).geometryBytes, copiedBytes);
  // Inspect the amplified declaration without loading its 129/257 MiB copies.
  const thumbnailBomb = overlappingViews(129);
  assertLimit(() => inspectGlb(thumbnailBomb), "geometry", 129 * 1024 * 1024, THUMBNAIL_LIMITS.geometry);
  assert.equal(inspectGlb(thumbnailBomb, PREVIEW_LIMITS).geometryBytes, 129 * 1024 * 1024);
  assertLimit(() => inspectGlb(overlappingViews(257), PREVIEW_LIMITS), "geometry", 257 * 1024 * 1024, PREVIEW_LIMITS.geometry);
});

test("shared buffer views are only charged once across multiple accessors", async () => {
  const payload = overlappingViews(16, true);
  const parsed = await new GLTFLoader().parseAsync(payload, "");
  const buffers = new Set();
  parsed.scene.traverse((object) => { if (object.isMesh) buffers.add(object.geometry.attributes.position.array.buffer); });
  assert.equal(buffers.size, 1);
  assert.equal(inspectGlb(payload).geometryBytes, 1024 * 1024);
});

test("preview errors bridge the active limit and show localized measured values", async () => {
  const payload = glb(texturedBox(4, 4096));
  const actual = 4 * rgbaMipBytes(4096, 4096);
  for (const locale of ["zh-Hans", "en"]) {
    const { window, messages, elements } = webHarness("main", payload);
    await window.trivorQuickLook.loadModel({ url: "http://preview.test/model.glb", name: "test.glb", requestId: locale, locale });
    const error = messages.find((message) => message.type === "error");
    assert.equal(error.code, "tooLarge");
    assert.equal(error.requestId, locale);
    assert.equal(error.limit.metric, "textures");
    assert.equal(error.limit.actual, actual);
    assert.equal(error.limit.limit, PREVIEW_LIMITS.textures);
    const text = elements.get("#status-detail").textContent;
    assert.ok(text.includes("341.34 MiB") && text.includes("256 MiB") && text.includes("Trivor"), text);
    assert.ok(text.includes(locale.startsWith("zh") ? "纹理" : "texture"), text);
  }
});

test("thumbnail errors retain the smaller profile and bridge the same detail contract", async () => {
  const payload = glb(texturedBox());
  const { window, messages } = webHarness("thumbnail", payload);
  await window.trivorThumbnail.render({ url: "http://preview.test/model.glb", name: "test.glb", requestId: "thumbnail", size: 128 });
  const error = messages.find((message) => message.type === "error");
  assert.equal(error.code, "tooLarge");
  assert.equal(error.requestId, "thumbnail");
  assert.equal(error.limit.metric, "textures");
  assert.equal(error.limit.actual, 9 * rgbaMipBytes(2048, 2048));
  assert.equal(error.limit.limit, THUMBNAIL_LIMITS.textures);
});

test("file limits reject declared overflow before reading and never round it down to the cap", async () => {
  const { window, messages, elements } = webHarness("main", glb(box()), PREVIEW_LIMITS.file + 1);
  await window.trivorQuickLook.loadModel({ url: "http://preview.test/model.glb", name: "test.glb", requestId: "file-limit", locale: "zh-Hans" });
  const error = messages.find((message) => message.type === "error");
  assert.equal(error.limit.metric, "file");
  assert.equal(error.limit.actual, PREVIEW_LIMITS.file + 1);
  assert.equal(error.limit.limit, PREVIEW_LIMITS.file);
  const text = elements.get("#status-detail").textContent;
  assert.ok(text.includes("128.01 MiB") && text.includes("上限 128 MiB"), text);
});

test("native capacity snapshots accept known tiers, exact absolute bounds and GPU reductions", () => {
  for (const tier of ["standard", "expanded", "large", "maximum"]) {
    const snapshot = resolvePreviewBudget({ tier, limits: { ...MAX_PREVIEW_LIMITS } });
    assert.equal(snapshot.tier, tier);
    assert.deepEqual(JSON.parse(JSON.stringify(snapshot.limits)), JSON.parse(JSON.stringify(MAX_PREVIEW_LIMITS)));
    assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.limits));
  }
  const original = { tier: "standard", limits: { ...PREVIEW_LIMITS, file: 32 * 1024 * 1024, geometry: 64 * 1024 * 1024, textures: 64 * 1024 * 1024, decoded: 96 * 1024 * 1024 } };
  const snapshot = resolvePreviewBudget(original);
  assert.equal(snapshot.limits.decoded, 96 * 1024 * 1024);
  assert.equal(snapshot.limits.file, 32 * 1024 * 1024);
  original.limits.file = 1;
  assert.equal(snapshot.limits.file, 32 * 1024 * 1024);
  assert.throws(() => { snapshot.limits.file = 1; }, TypeError);
});

test("malformed native capacity snapshots fall back atomically to standard", () => {
  const invalid = [undefined, null, [], "maximum", {}, { tier: "maximum" }, { limits: { ...MAX_PREVIEW_LIMITS } },
    { tier: "__proto__", limits: { ...MAX_PREVIEW_LIMITS } },
    { tier: "maximum", limits: { ...MAX_PREVIEW_LIMITS }, version: 1 },
    { tier: "maximum", limits: { ...MAX_PREVIEW_LIMITS, unexpected: 1 } },
    { tier: "maximum", limits: { ...MAX_PREVIEW_LIMITS, [Symbol("extra")]: 1 } },
    { tier: "maximum", limits: [] },
  ];
  for (const key of Object.keys(MAX_PREVIEW_LIMITS)) {
    const missing = { ...MAX_PREVIEW_LIMITS }; delete missing[key];
    invalid.push({ tier: "maximum", limits: missing });
    for (const value of [0, -1, 1.5, NaN, Infinity, "1", true, MAX_PREVIEW_LIMITS[key] + 1, Number.MAX_SAFE_INTEGER + 1]) {
      invalid.push({ tier: "maximum", limits: { ...MAX_PREVIEW_LIMITS, [key]: value } });
    }
  }
  let getterCalls = 0;
  invalid.push({ tier: "maximum", get limits() { getterCalls++; return MAX_PREVIEW_LIMITS; } });
  invalid.push(new Proxy({}, { ownKeys() { throw new Error("not a native JSON object"); } }));
  for (const value of invalid) {
    const snapshot = resolvePreviewBudget(value);
    assert.equal(snapshot.tier, "standard");
    assert.equal(snapshot.limits, PREVIEW_LIMITS);
  }
  assert.equal(getterCalls, 0);
});

test("decoded memory enforces a shared geometry and texture cap with inclusive boundaries", () => {
  const payload = glb(texturedBox(1, 16));
  const budget = inspectGlb(payload, PREVIEW_LIMITS);
  const total = budget.geometryBytes + budget.textureBytes;
  assert.ok(budget.geometryBytes < total && budget.textureBytes < total);
  assert.equal(inspectGlb(payload, { ...PREVIEW_LIMITS, decoded: total }).textureBytes, budget.textureBytes);
  assertLimit(() => inspectGlb(payload, { ...PREVIEW_LIMITS, decoded: total - 1 }), "decoded", total, total - 1);
  assert.equal(THUMBNAIL_LIMITS.decoded, THUMBNAIL_LIMITS.geometry + THUMBNAIL_LIMITS.textures);
  assert.equal(PREVIEW_LIMITS.decoded, 384 * 1024 * 1024);
});

test("preview fetch and inspection retain one native snapshot despite caller mutation", async () => {
  const budget = { tier: "maximum", limits: { ...MAX_PREVIEW_LIMITS } };
  const payload = glb(box());
  const harness = webHarness("main", payload, PREVIEW_LIMITS.file + 1, { onFetch() {
    budget.limits.file = 1; budget.limits.decoded = 1;
  } });
  await harness.window.trivorQuickLook.loadModel({ url: "http://preview.test/model.glb", name: "test.glb", requestId: "snapshot", locale: "zh-Hans", budget });
  assert.equal(harness.fetches.bodyReads, 1);
  assert.equal(harness.messages.filter((message) => message.type === "error").length, 0);
  assert.equal(harness.elements.get("#preview").dataset.budgetTier, "maximum");
  const badge = harness.elements.get("#budget-tier");
  assert.equal(badge.hidden, true);
  harness.viewers[0].emit("load");
  assert.equal(badge.hidden, false);
  assert.equal(badge.textContent, "超大容量");
  assert.ok(badge.title.includes("512 MiB") && badge.title.includes("1,536 MiB"), badge.title);
  assert.equal(harness.messages.at(-1).type, "ready");
  harness.window.trivorQuickLook.dispose();
  assert.equal(badge.hidden, true);
});

test("GPU-reduced file and decoded limits govern the actual preview entry point", async () => {
  const payload = glb(texturedBox(1, 16));
  const selected = { tier: "large", limits: { ...MAX_PREVIEW_LIMITS, file: payload.byteLength - 1 } };
  const file = webHarness("main", payload);
  await file.window.trivorQuickLook.loadModel({ url: "http://preview.test/model.glb", requestId: "file", budget: selected });
  assert.equal(file.fetches.bodyReads, 0);
  assert.equal(file.messages.at(-1).limit.limit, payload.byteLength - 1);
  assert.equal(file.elements.get("#budget-tier").hidden, true);

  const estimate = inspectGlb(payload, PREVIEW_LIMITS);
  const total = estimate.geometryBytes + estimate.textureBytes;
  const combined = webHarness("main", payload);
  await combined.window.trivorQuickLook.loadModel({ url: "http://preview.test/model.glb", requestId: "decoded", locale: "zh-Hans",
    budget: { tier: "expanded", limits: { ...MAX_PREVIEW_LIMITS, decoded: total - 1 } } });
  const failure = combined.messages.at(-1);
  assert.equal(failure.limit.metric, "decoded");
  assert.equal(failure.limit.actual, total);
  assert.equal(failure.limit.limit, total - 1);
  assert.ok(combined.elements.get("#status-detail").textContent.includes("几何与纹理合计"));
  assert.equal(combined.elements.get("#budget-tier").hidden, true);
});

test("invalid request budgets use the standard tier for both fetch limits and UI", async () => {
  const harness = webHarness("main", glb(box()), PREVIEW_LIMITS.file + 1);
  await harness.window.trivorQuickLook.loadModel({ url: "http://preview.test/model.glb", requestId: "invalid-budget",
    budget: { tier: "maximum", limits: { file: MAX_PREVIEW_LIMITS.file } } });
  assert.equal(harness.fetches.bodyReads, 0);
  assert.equal(harness.messages.at(-1).limit.limit, PREVIEW_LIMITS.file);
  assert.equal(harness.elements.get("#preview").dataset.budgetTier, "standard");
  assert.equal(harness.elements.get("#budget-tier").textContent, "Standard");
});

test("KTX2 preflight accepts bounded LDR formats and refuses HDR and raw Zstd paths", () => {
  const inspect = (bytes) => inspectGlb(glb({ ...box(), images: [{ uri: `data:image/ktx2;base64,${bytes.toString("base64")}` }] }));
  for (const options of [{}, { model: 166, scheme: 0 }, { model: 166, scheme: 2 }, { format: 37, model: 1, scheme: 0 }]) {
    assert.equal(inspect(ktxHeader(16, 16, options)).textureBytes, rgbaMipBytes(16, 16));
  }
  for (const options of [
    { format: 97, model: 1, scheme: 2, typeSize: 2 }, // RGBA16F
    { format: 109, model: 1, scheme: 2, typeSize: 4 }, // RGBA32F
    { format: 1000066000, model: 167, scheme: 2 }, // ASTC/Basis HDR
    { model: 167 }, { format: 999, model: 1, scheme: 0 },
    { format: 37, model: 1, scheme: 2 }, // raw Zstd allocates the declared unpacked length
  ]) {
    assert.throws(() => inspect(ktxHeader(16, 16, options)), (error) => error.code === "unsupported");
  }
});

test("KTX2 preflight rejects arrays, volumes, cubes and unchecked decompression sizes", () => {
  const inspect = (bytes) => inspectGlb(glb({ ...box(), images: [{ uri: `data:image/ktx2;base64,${bytes.toString("base64")}` }] }));
  for (const [offset, value] of [[28, 1], [32, 1], [36, 6]]) {
    const bytes = ktxHeader(16, 16); bytes.writeUInt32LE(value, offset);
    assert.throws(() => inspect(bytes), (error) => error.code === "unsupported");
  }
  const zstd = ktxHeader(16, 16, { model: 166, scheme: 2 });
  zstd.writeBigUInt64LE(1n << 40n, 96);
  assert.throws(() => inspect(zstd), (error) => error.code === "invalid");
  const truncated = ktxHeader(16, 16).subarray(0, 48);
  assert.throws(() => inspect(truncated), (error) => error.code === "invalid");
  const missingDFD = ktxHeader(16, 16); missingDFD.writeUInt32LE(missingDFD.length + 1, 48);
  assert.throws(() => inspect(missingDFD), (error) => error.code === "invalid");
});

test("texture memory sums exact power-of-two, NPOT and narrow mip chains", () => {
  for (const [width, height, expected] of [[1, 1, 4], [2, 2, 20], [3, 5, 72], [7, 1, 44], [1, 1024, 8188], [4096, 4096, 89478484]]) {
    const json = { ...box(), images: [{ uri: `data:image/png;base64,${pngHeader(width, height).toString("base64")}` }] };
    assert.equal(inspectGlb(glb(json), PREVIEW_LIMITS).textureBytes, expected, `${width}×${height}`);
  }
  const payload = glb(texturedBox(12, 4096));
  const limits = { ...MAX_PREVIEW_LIMITS, textures: 1024 * 1024 * 1024, decoded: 1536 * 1024 * 1024 };
  // The old per-image ceil(4/3 × base) rejected this 1 GiB case by eight bytes.
  const expected = 1073741808;
  assert.equal(inspectGlb(payload, limits).textureBytes, expected);
  assertLimit(() => inspectGlb(payload, { ...limits, textures: expected - 1 }), "textures", expected, expected - 1);
  const geometry = inspectGlb(payload, limits).geometryBytes;
  assertLimit(() => inspectGlb(payload, { ...limits, decoded: geometry + expected - 1 }), "decoded", geometry + expected, geometry + expected - 1);
});

test("known LDR BC and ASTC containers accepted by Three keep their preview support", async () => {
  for (const [format, model, block] of [[131, 128, [4, 4, 8]], [145, 134, [4, 4, 16]], [157, 162, [4, 4, 16]], [165, 162, [6, 6, 16]]]) {
    const ktx = compressedKtx(format, 16, 16, block, model);
    const texture = await new KTX2Loader()._createTexture(ktx.buffer.slice(ktx.byteOffset, ktx.byteOffset + ktx.byteLength));
    assert.equal(texture.isCompressedTexture, true);
    assert.equal(texture.image.width, 16);
    const json = { ...box(), images: [{ uri: `data:image/ktx2;base64,${ktx.toString("base64")}` }] };
    assert.equal(inspectGlb(glb(json)).textureBytes, 1364);
    texture.dispose();
  }
});

test("tiny compressed textures retain their minimum block allocation through every mip", () => {
  for (const [format, model, block, width, height, expected] of [
    [131, 128, [4, 4, 8], 1, 1, 8],
    [145, 134, [4, 4, 16], 1, 1, 16],
    [157, 162, [4, 4, 16], 1, 1, 16],
    [145, 134, [4, 4, 16], 2, 2, 32],
    [145, 134, [4, 4, 16], 1, 7, 64],
    [1000054001, 164, [4, 4, 8, 2], 1, 1, 32],
  ]) {
    const ktx = compressedKtx(format, width, height, block, model);
    const json = { ...box(), images: [{ uri: `data:image/ktx2;base64,${ktx.toString("base64")}` }] };
    const payload = glb(json);
    assert.equal(inspectGlb(payload).textureBytes, expected, `format ${format}, ${width}×${height}`);
    assertLimit(() => inspectGlb(payload, { ...PREVIEW_LIMITS, textures: expected - 1 }), "textures", expected, expected - 1);
  }
  const raw = ktxHeader(1, 1, { format: 37, model: 1, scheme: 0 });
  const padded = Buffer.concat([raw, Buffer.alloc(60)]);
  padded.writeBigUInt64LE(64n, 88);
  const json = { ...box(), images: [{ uri: `data:image/ktx2;base64,${padded.toString("base64")}` }] };
  assert.equal(inspectGlb(glb(json)).textureBytes, 64, "retained level data is not hidden by smaller image dimensions");
});
