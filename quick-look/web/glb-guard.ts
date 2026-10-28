/** A bounded, offline-only envelope for Finder previews. The main app handles
 * larger assets with its cancellable preparation pipeline. This is a preflight,
 * not a replacement for the glTF decoder's validation of compressed payloads. */
export const THUMBNAIL_LIMITS = Object.freeze({
  file: 64 * 1024 * 1024,
  json: 4 * 1024 * 1024,
  geometry: 128 * 1024 * 1024,
  textures: 128 * 1024 * 1024,
  decoded: 256 * 1024 * 1024,
  triangles: 1_000_000,
  draws: 512,
  nodes: 10_000,
  depth: 128,
  animationChannels: 4096,
  animationSamplers: 4096,
  animationTracks: 8192,
});
export type PreviewLimits = { readonly [Key in keyof typeof THUMBNAIL_LIMITS]: number };
export const PREVIEW_LIMITS: PreviewLimits = Object.freeze({
  ...THUMBNAIL_LIMITS,
  file: 128 * 1024 * 1024,
  json: 8 * 1024 * 1024,
  geometry: 256 * 1024 * 1024,
  textures: 256 * 1024 * 1024,
  decoded: 384 * 1024 * 1024,
  triangles: 3_000_000,
  draws: 1024,
  nodes: 25_000,
});
export const MAX_PREVIEW_LIMITS: PreviewLimits = Object.freeze({
  ...PREVIEW_LIMITS,
  file: 512 * 1024 * 1024,
  json: 32 * 1024 * 1024,
  geometry: 1536 * 1024 * 1024,
  textures: 1536 * 1024 * 1024,
  decoded: 2304 * 1024 * 1024,
  triangles: 12_000_000,
  draws: 6144,
  nodes: 100_000,
});
export type PreviewTier = "standard" | "expanded" | "large" | "maximum";
export interface PreviewBudgetSnapshot { readonly tier: PreviewTier; readonly limits: PreviewLimits; }
const STANDARD_PREVIEW_BUDGET: PreviewBudgetSnapshot = Object.freeze({ tier: "standard", limits: PREVIEW_LIMITS });

/** The native host owns hardware selection. Accept only a complete, bounded
 * snapshot; a partially valid profile must never inherit larger limits. */
export function resolvePreviewBudget(value: unknown): PreviewBudgetSnapshot {
  function fields(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).length !== keys.length ||
        keys.some((key) => !Object.hasOwn(descriptors, key) || !("value" in descriptors[key]))) return null;
    return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
  }
  try {
    const budget = fields(value, ["tier", "limits"]);
    if (!budget || !["standard", "expanded", "large", "maximum"].includes(budget.tier as string)) return STANDARD_PREVIEW_BUDGET;
    const keys = Object.keys(MAX_PREVIEW_LIMITS) as Array<keyof PreviewLimits>;
    const limits = fields(budget.limits, keys);
    if (!limits || keys.some((key) => typeof limits[key] !== "number" || !Number.isSafeInteger(limits[key]) ||
        (limits[key] as number) <= 0 || (limits[key] as number) > MAX_PREVIEW_LIMITS[key])) return STANDARD_PREVIEW_BUDGET;
    return Object.freeze({ tier: budget.tier as PreviewTier, limits: Object.freeze(limits as unknown as PreviewLimits) });
  } catch {
    // Proxies/accessors are not produced by the native JSON bridge. Treat them
    // like other malformed input rather than letting profile selection throw.
    return STANDARD_PREVIEW_BUDGET;
  }
}
// Callers that omit a profile retain the conservative background-thumbnail limits.
export const LIMITS = THUMBNAIL_LIMITS;

export type PreviewErrorCode = "tooLarge" | "invalid" | "externalResources" | "unsupported" | "renderFailed";
export type PreviewLimitMetric = keyof PreviewLimits | "entries";
export interface PreviewLimitDetail { metric: PreviewLimitMetric; actual: number; limit: number; }
export class PreviewError extends Error {
  constructor(readonly code: PreviewErrorCode, readonly detail?: PreviewLimitDetail) { super(code); }
}
type Json = Record<string, any>;
function fail(code: PreviewErrorCode = "invalid"): never { throw new PreviewError(code); }
function bound(actual: number, limit: number, metric: PreviewLimitMetric): number {
  if (!Number.isSafeInteger(actual) || actual < 0) fail("tooLarge");
  if (actual > limit) throw new PreviewError("tooLarge", { metric, actual, limit });
  return actual;
}
const object = (value: unknown): Json => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : fail();
const integer = (value: unknown, max = Number.MAX_SAFE_INTEGER): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : fail();
function sum(total: number, value: number, limit: number, metric: PreviewLimitMetric): number {
  if (!Number.isSafeInteger(value) || value < 0) fail("tooLarge");
  return bound(total + value, limit, metric);
}
function ref<T>(items: T[], value: unknown): T {
  const i = integer(value);
  if (i >= items.length) fail();
  return items[i];
}

/** glTF extensions may contain URI fields too. No asset can escape into a
 * network request, another local file, or an HTML/SVG document. */
function checkUris(root: unknown, limits: PreviewLimits): void {
  const stack: Array<[unknown, number]> = [[root, 0]];
  while (stack.length) {
    const [value, depth] = stack.pop()!;
    if (value === null || typeof value !== "object") continue;
    bound(depth, limits.depth, "depth");
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === "number" && !Number.isFinite(child)) fail();
      if (key === "uri" && (typeof child !== "string" || !/^data:(?:application\/(?:octet-stream|gltf-buffer)|image\/(?:png|jpeg|webp|ktx2));base64,[A-Za-z0-9+/]*={0,2}$/i.test(child))) {
        fail("externalResources");
      }
      if (child !== null && typeof child === "object") stack.push([child, depth + 1]);
    }
  }
}

function dataBytes(uri: string, limits: PreviewLimits): Uint8Array {
  const encoded = uri.slice(uri.indexOf(",") + 1);
  if (encoded.length > limits.file * 4 / 3 || encoded.length % 4 !== 0) fail();
  let decoded: string;
  try { decoded = atob(encoded); } catch { return fail(); }
  return Uint8Array.from(decoded, (ch) => ch.charCodeAt(0));
}

type TextureBlock = readonly [width: number, height: number, bytes: number, minimumBlocks?: number];
const BLOCK_4X4_8: TextureBlock = [4, 4, 8];
const BLOCK_4X4_16: TextureBlock = [4, 4, 16];
const BLOCK_6X6_16: TextureBlock = [6, 6, 16];
const PVRTC_2BPP: TextureBlock = [8, 4, 8, 2];
const PVRTC_4BPP: TextureBlock = [4, 4, 8, 2];
// LDR compressed formats supported by Three's KTX2Loader FORMAT_MAP.
// Float/HDR formats and Zstd raw-texture allocation stay excluded below.
const KTX_LDR_BLOCKS: Readonly<Record<number, TextureBlock>> = Object.freeze({
  131: BLOCK_4X4_8, 132: BLOCK_4X4_8, 133: BLOCK_4X4_8, 134: BLOCK_4X4_8, // BC1
  137: BLOCK_4X4_16, 138: BLOCK_4X4_16, // BC3
  139: BLOCK_4X4_8, 140: BLOCK_4X4_8, // BC4
  141: BLOCK_4X4_16, 142: BLOCK_4X4_16, 145: BLOCK_4X4_16, 146: BLOCK_4X4_16, // BC5/7
  148: BLOCK_4X4_8, 152: BLOCK_4X4_16, // ETC2
  153: BLOCK_4X4_8, 154: BLOCK_4X4_8, 155: BLOCK_4X4_16, 156: BLOCK_4X4_16, // EAC
  157: BLOCK_4X4_16, 158: BLOCK_4X4_16, 165: BLOCK_6X6_16, 166: BLOCK_6X6_16, // ASTC
  1000054000: PVRTC_2BPP, 1000054004: PVRTC_2BPP,
  1000054001: PVRTC_4BPP, 1000054005: PVRTC_4BPP,
});

function mipmapBytes(width: number, height: number, block?: TextureBlock): number {
  if (!width || !height) fail();
  let total = 0;
  for (;;) {
    total += block
      ? Math.max(block[3] ?? 1, Math.ceil(width / block[0])) * Math.max(block[3] ?? 1, Math.ceil(height / block[1])) * block[2]
      : width * height * 4;
    if (!Number.isSafeInteger(total)) fail("tooLarge");
    if (width === 1 && height === 1) return total;
    width = Math.max(1, Math.floor(width / 2));
    height = Math.max(1, Math.floor(height / 2));
  }
}

function imageSize(bytes: Uint8Array, mime: string): [number, number, number?] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const has = (offset: number, values: number[]) => offset + values.length <= bytes.length && values.every((n, i) => bytes[offset + i] === n);
  if (mime === "image/png" && bytes.length >= 24 && has(0, [137,80,78,71,13,10,26,10]) && view.getUint32(12) === 0x49484452) {
    return [view.getUint32(16), view.getUint32(20)];
  }
  if (mime === "image/ktx2" && has(0, [171,75,84,88,32,50,48,187,13,10,26,10])) {
    if (bytes.length < 80) fail();
    const u32 = (offset: number) => view.getUint32(offset, true);
    const u64 = (offset: number) => integer(u32(offset) + u32(offset + 4) * 2 ** 32);
    const width = u32(20), height = u32(24), levels = Math.max(1, u32(40));
    // A depth/layer count of one is still a 3D/array texture in KTX2.
    if (u32(28) !== 0 || u32(32) !== 0 || u32(36) !== 1) fail("unsupported");
    if (levels > 1 + Math.floor(Math.log2(Math.max(1, width, height)))) fail();
    if (80 + levels * 24 > bytes.length) fail();
    const dfd = u32(48), dfdLength = u32(52);
    if (dfd < 80 + levels * 24 || dfdLength < 28 || dfd + dfdLength > bytes.length ||
        u32(dfd) !== dfdLength || view.getUint16(dfd + 10, true) < 24 ||
        view.getUint16(dfd + 10, true) > dfdLength - 4) fail();
    const format = u32(12), scheme = u32(44), model = bytes[dfd + 12];
    // Our RGBA8 estimate covers ETC1S/UASTC LDR and explicit 8-bit formats.
    // HDR (including Basis colorModel 167) may expand to RGBA16F/32F. Raw
    // Zstd also allocates the untrusted level.uncompressedByteLength directly.
    // Those paths need a different accounting model and stay in the full app.
    const basisLdr = format === 0 && (model === 163 || model === 166);
    const raw8 = [9, 15, 16, 22, 37, 43].includes(format) && model === 1 && scheme === 0;
    const compressedBlock = KTX_LDR_BLOCKS[format];
    const compressedLdr = compressedBlock !== undefined && scheme === 0;
    if (u32(16) !== 1 || model === 167 || (!basisLdr && !raw8 && !compressedLdr)) fail("unsupported");
    if (basisLdr && ((model === 163 && scheme !== 1) || (model === 166 && ![0, 2].includes(scheme)))) fail("unsupported");
    if (basisLdr && !has(dfd + 16, [3, 3, 0, 0])) fail("unsupported");
    let levelBytes = 0;
    for (let level = 0; level < levels; level++) {
      const entry = 80 + level * 24;
      const offset = u64(entry), length = u64(entry + 8), unpacked = u64(entry + 16);
      if (!length || offset + length > bytes.length) fail();
      if (basisLdr && model === 166) {
        const expected = Math.ceil(Math.max(1, Math.floor(width / 2 ** level)) / 4) *
          Math.ceil(Math.max(1, Math.floor(height / 2 ** level)) / 4) * 16;
        if ((scheme === 2 && unpacked !== expected) || (scheme === 0 && length !== expected)) fail();
      }
      levelBytes += basisLdr && scheme === 2 ? unpacked : length;
      if (!Number.isSafeInteger(levelBytes)) fail("tooLarge");
    }
    const blockBytes = compressedBlock ? mipmapBytes(width, height, compressedBlock) : basisLdr
      // The transcoder selects a device-supported LDR target. Include block
      // padding and PVRTC's minimum footprint, especially for tiny mip levels.
      ? Math.max(mipmapBytes(width, height, BLOCK_4X4_16), mipmapBytes(width, height, PVRTC_4BPP)) : 0;
    return [width, height, Math.max(blockBytes, levelBytes)];
  }
  if (mime === "image/webp" && bytes.length >= 30 && has(0, [82,73,70,70]) && has(8, [87,69,66,80])) {
    if (has(12, [86,80,56,88])) {
      if (bytes[20] & 2) fail("unsupported"); // Animated WebP needs a different budget.
      const u24 = (at: number) => bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16;
      return [u24(24) + 1, u24(27) + 1];
    }
    if (has(12, [86,80,56,76]) && bytes[20] === 0x2f) {
      const packed = view.getUint32(21, true);
      return [(packed & 0x3fff) + 1, ((packed >>> 14) & 0x3fff) + 1];
    }
    if (has(12, [86,80,56,32]) && has(23, [157,1,42])) {
      return [view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff];
    }
  }
  if (mime === "image/jpeg" && has(0, [255,216])) {
    let at = 2;
    while (at + 3 < bytes.length) {
      if (bytes[at++] !== 255) fail();
      while (bytes[at] === 255) at++;
      const marker = bytes[at++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (at + 2 > bytes.length) fail();
      const length = view.getUint16(at);
      if (length < 2 || at + length > bytes.length) fail();
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
        if (length < 8) fail();
        return [view.getUint16(at + 5), view.getUint16(at + 3)];
      }
      at += length;
    }
  }
  return fail("unsupported");
}

export interface PreviewBudget { triangles: number; draws: number; geometryBytes: number; textureBytes: number; }

export function inspectGlb(data: ArrayBuffer, limits: PreviewLimits = THUMBNAIL_LIMITS): PreviewBudget {
  function list(value: unknown, max: number = limits.nodes, metric: PreviewLimitMetric = "entries"): any[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) fail();
    bound(value.length, max, metric);
    return value;
  }
  bound(data.byteLength, limits.file, "file");
  if (data.byteLength < 20) fail();
  const view = new DataView(data);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== data.byteLength) fail();
  const jsonLength = view.getUint32(12, true);
  bound(jsonLength, limits.json, "json");
  if (jsonLength % 4 !== 0 || 20 + jsonLength > data.byteLength || view.getUint32(16, true) !== 0x4e4f534a) fail();
  let json: Json;
  try { json = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(data, 20, jsonLength)))); }
  catch { return fail(); }
  if (object(json.asset).version !== "2.0") fail("unsupported");
  checkUris(json, limits);
  const supported = new Set([
    "KHR_draco_mesh_compression", "KHR_mesh_quantization", "EXT_meshopt_compression", "EXT_mesh_gpu_instancing",
    "KHR_texture_basisu", "EXT_texture_webp", "KHR_texture_transform", "KHR_lights_punctual",
    "KHR_materials_unlit", "KHR_materials_clearcoat", "KHR_materials_dispersion", "KHR_materials_iridescence",
    "KHR_materials_sheen", "KHR_materials_transmission", "KHR_materials_volume", "KHR_materials_ior",
    "KHR_materials_specular", "KHR_materials_anisotropy", "KHR_materials_emissive_strength", "KHR_materials_variants",
    "EXT_materials_bump",
  ]);
  for (const extension of list(json.extensionsRequired, 64)) if (!supported.has(extension)) fail("unsupported");
  let binary = new Uint8Array(0);
  let at = 20 + jsonLength;
  let chunks = 0;
  while (at < data.byteLength) {
    if (++chunks > 16 || at + 8 > data.byteLength) fail();
    const length = view.getUint32(at, true);
    const type = view.getUint32(at + 4, true);
    if (length % 4 !== 0 || at + 8 + length > data.byteLength || type === 0x4e4f534a) fail();
    if (type === 0x004e4942) {
      if (binary.length || chunks !== 1) fail();
      binary = new Uint8Array(data, at + 8, length);
    }
    at += 8 + length;
  }
  const buffers = list(json.buffers, 64).map(object);
  let decodedBuffers = 0;
  for (let i = 0; i < buffers.length; i++) {
    const buffer = buffers[i];
    const size = integer(buffer.byteLength);
    decodedBuffers = sum(decodedBuffers, size, limits.geometry, "geometry");
    // The meshopt extension may declare a URI-less virtual fallback buffer.
    if (buffer.uri === undefined && !(buffer.extensions?.EXT_meshopt_compression?.fallback === true)) {
      if (i !== 0 || size > binary.byteLength || binary.byteLength - size > 3) fail();
    }
    if (buffer.uri !== undefined && Math.floor(buffer.uri.split(",")[1].length / 4) * 3 < size) fail();
  }
  const bufferViews = list(json.bufferViews).map(object);
  let copiedBufferViews = 0;
  for (const entry of bufferViews) {
    const buffer = ref(buffers, entry.buffer);
    const end = integer(entry.byteOffset ?? 0) + integer(entry.byteLength);
    if (end > integer(buffer.byteLength)) fail();
    const compression = entry.extensions?.EXT_meshopt_compression;
    let copiedBytes = integer(entry.byteLength);
    if (compression !== undefined) {
      const c = object(compression);
      const packed = ref(buffers, c.buffer);
      if (integer(c.byteOffset ?? 0) + integer(c.byteLength) > integer(packed.byteLength)) fail();
      copiedBytes = integer(c.count) * integer(c.byteStride);
    }
    // GLTFLoader slices each distinct bufferView, including overlapping views
    // of one source buffer. Meshopt replaces that slice with its decoded buffer.
    // Image views contribute only their encoded bytes here; decoded pixels are
    // counted separately under the texture budget below.
    copiedBufferViews = sum(copiedBufferViews, copiedBytes, limits.geometry, "geometry");
  }
  const widths: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
  const accessors = list(json.accessors).map(object);
  let geometryBytes = 0;
  for (const entry of accessors) {
    if (!Object.hasOwn(widths, entry.type) || ![5120,5121,5122,5123,5125,5126].includes(entry.componentType)) fail();
    geometryBytes = sum(geometryBytes, integer(entry.count) * widths[entry.type] * 4, limits.geometry, "geometry");
    if (entry.bufferView !== undefined) ref(bufferViews, entry.bufferView);
    if (entry.sparse !== undefined && integer(object(entry.sparse).count) > entry.count) fail();
  }
  geometryBytes = Math.max(geometryBytes, decodedBuffers, copiedBufferViews);

  let preparedTriangles = 0, preparedDraws = 0;
  const meshes = list(json.meshes, limits.draws, "draws").map((mesh) => {
    let triangles = 0, morphDraws = 0, morphTargets = 0;
    const primitives = list(object(mesh).primitives, limits.draws, "draws");
    for (const item of primitives) {
      const primitive = object(item);
      const attributes = object(primitive.attributes);
      const position = ref(accessors, attributes.POSITION);
      if (position.type !== "VEC3") fail();
      for (const index of Object.values(attributes)) ref(accessors, index);
      const count = integer(primitive.indices === undefined ? position.count : ref(accessors, primitive.indices).count);
      const mode = integer(primitive.mode ?? 4, 6);
      // Lines and points also cost work; bound their element counts similarly.
      triangles = sum(triangles, mode === 4 ? Math.ceil(count / 3) : count, limits.triangles, "triangles");
      const targets = list(primitive.targets, 64);
      if (targets.length) morphDraws++;
      morphTargets = Math.max(morphTargets, targets.length);
      for (const target of targets) for (const index of Object.values(object(target))) ref(accessors, index);
    }
    preparedTriangles = sum(preparedTriangles, triangles, limits.triangles, "triangles");
    preparedDraws = sum(preparedDraws, primitives.length, limits.draws, "draws");
    return { triangles, draws: primitives.length, morphDraws, morphTargets };
  });
  const nodes = list(json.nodes, limits.nodes, "nodes").map(object);
  const children = nodes.map((node) => list(node.children, limits.nodes, "nodes").map((index) => { ref(nodes, index); return index as number; }));
  const parents = new Uint8Array(nodes.length);
  for (const group of children) for (const i of group) { if (parents[i]) fail(); parents[i] = 1; }
  const state = new Uint8Array(nodes.length);
  const heights = new Uint16Array(nodes.length);
  function visit(index: number, depth: number): number {
    bound(depth, limits.depth, "depth");
    if (state[index] === 1) fail();
    if (state[index] === 2) {
      bound(depth + heights[index], limits.depth, "depth");
      return heights[index];
    }
    state[index] = 1;
    let height = 0;
    for (const child of children[index]) height = Math.max(height, 1 + visit(child, depth + 1));
    bound(depth + height, limits.depth, "depth");
    heights[index] = height;
    state[index] = 2;
    return height;
  }
  nodes.forEach((_, i) => visit(i, 0));
  let triangles = 0, draws = 0, instances = 0;
  const sceneNodes = list(json.scenes, 64).flatMap((scene) => list(object(scene).nodes, limits.nodes, "nodes"));
  const roots = sceneNodes.length ? sceneNodes.map((index) => { ref(nodes, index); return index as number; }) : nodes.flatMap((_, i) => parents[i] ? [] : [i]);
  const queue = roots.map((index) => ({ index, depth: 0 }));
  while (queue.length) {
    instances = sum(instances, 1, limits.nodes, "nodes");
    const { index, depth } = queue.pop()!;
    bound(depth, limits.depth, "depth");
    const node = nodes[index];
    let copies = 1;
    const instancing = node.extensions?.EXT_mesh_gpu_instancing;
    if (instancing !== undefined) {
      const attributes = Object.values(object(object(instancing).attributes));
      if (!attributes.length) fail();
      copies = integer(ref(accessors, attributes[0]).count);
      for (const attr of attributes) if (ref(accessors, attr).count !== copies) fail();
      instances = sum(instances, Math.max(0, copies - 1), limits.nodes, "nodes");
    }
    if (node.mesh !== undefined) {
      const mesh = ref(meshes, node.mesh);
      triangles = sum(triangles, mesh.triangles * copies, limits.triangles, "triangles");
      draws = sum(draws, mesh.draws, limits.draws, "draws");
    }
    for (const child of children[index]) queue.push({ index: child, depth: depth + 1 });
  }

  // Animations are parsed even when the preview keeps their initial static pose.
  // GLTFLoader expands normalized outputs to a fresh Float32Array per channel;
  // counting the unique source accessors alone misses this multiplication.
  const morphTracks = new Map<number, number>();
  function countMorphTracks(index: number): number {
    const cached = morphTracks.get(index);
    if (cached !== undefined) return cached;
    const node = nodes[index];
    let count = node.mesh === undefined ? 0 : ref(meshes, node.mesh).morphDraws;
    // GLTFLoader creates a weights track for every morph primitive below the
    // target, but shares one expanded output array among those tracks.
    for (const child of children[index]) count = sum(count, countMorphTracks(child), limits.animationTracks, "animationTracks");
    morphTracks.set(index, count);
    return count;
  }
  let animationChannels = 0, animationSamplers = 0, animationTracks = 0;
  for (const value of list(json.animations, 128)) {
    const animation = object(value);
    const channels = list(animation.channels, limits.animationChannels, "animationChannels").map(object);
    const samplers = list(animation.samplers, limits.animationSamplers, "animationSamplers").map(object);
    animationChannels = sum(animationChannels, channels.length, limits.animationChannels, "animationChannels");
    animationSamplers = sum(animationSamplers, samplers.length, limits.animationSamplers, "animationSamplers");
    for (const channel of channels) {
      const sampler = ref(samplers, channel.sampler);
      const target = object(channel.target);
      // The core loader skips channels without a node (extension-only targets).
      if (target.node === undefined) continue;
      const node = ref(nodes, target.node);
      const input = ref(accessors, sampler.input), output = ref(accessors, sampler.output);
      if (input.type !== "SCALAR" || input.componentType !== 5126 || input.normalized === true || !input.count) fail();
      const interpolation = sampler.interpolation ?? "LINEAR";
      if (!["LINEAR", "STEP", "CUBICSPLINE"].includes(interpolation)) fail();
      let components = 1, tracks = 1;
      if (target.path === "weights") {
        if (node.mesh === undefined || output.type !== "SCALAR") fail();
        components = ref(meshes, node.mesh).morphTargets;
        if (!components) fail();
        tracks = countMorphTracks(target.node);
      } else if (target.path === "rotation") {
        if (output.type !== "VEC4") fail();
      } else if (target.path === "translation" || target.path === "scale") {
        if (output.type !== "VEC3" || output.componentType !== 5126) fail();
      } else fail("unsupported");
      const normalized = [5120, 5121, 5122, 5123].includes(output.componentType) && output.normalized === true;
      if ((!normalized && output.componentType !== 5126) || (output.componentType === 5126 && output.normalized === true)) fail();
      if (output.count !== input.count * components * (interpolation === "CUBICSPLINE" ? 3 : 1)) fail();
      animationTracks = sum(animationTracks, tracks, limits.animationTracks, "animationTracks");
      if (normalized) geometryBytes = sum(geometryBytes, output.count * widths[output.type] * 4, limits.geometry, "geometry");
    }
  }

  const images = list(json.images, 256).map(object);
  const bufferCache = new Map<number, Uint8Array>();
  const imageSizes = images.map((image) => {
    let bytes: Uint8Array;
    let mime: string;
    if (image.uri !== undefined) {
      bytes = dataBytes(image.uri, limits);
      mime = image.uri.slice(5, image.uri.indexOf(";")).toLowerCase();
    } else {
      const entry = ref(bufferViews, image.bufferView);
      if (entry.extensions?.EXT_meshopt_compression) fail("unsupported");
      const buffer = ref(buffers, entry.buffer);
      let contents = bufferCache.get(entry.buffer);
      if (!contents) {
        contents = buffer.uri === undefined ? binary : dataBytes(buffer.uri, limits);
        bufferCache.set(entry.buffer, contents);
      }
      const offset = integer(entry.byteOffset ?? 0), length = integer(entry.byteLength);
      if (offset + length > contents.byteLength) fail();
      bytes = contents.subarray(offset, offset + length);
      mime = image.mimeType;
    }
    const [width, height, resourceBytes = 0] = imageSize(bytes, mime);
    if (!width || !height) fail();
    // Sum each mip exactly. The 4/3 approximation overcounts power-of-two
    // chains at exact caps and undercounts narrow textures and padded blocks.
    const size = Math.max(mipmapBytes(width, height), resourceBytes);
    bound(size, limits.textures, "textures");
    return size;
  });
  let textureBytes = bound(imageSizes.reduce((total, bytes) => total + bytes, 0), limits.textures, "textures");
  // Different sampler/source entries can allocate separate GPU textures.
  const textures = list(json.textures, 256).map(object);
  let sampledBytes = 0;
  for (const texture of textures) {
    const source = texture.extensions?.KHR_texture_basisu?.source ?? texture.extensions?.EXT_texture_webp?.source ?? texture.source;
    sampledBytes += ref(imageSizes, source);
  }
  bound(sampledBytes, limits.textures, "textures");
  textureBytes = Math.max(textureBytes, sampledBytes);
  sum(geometryBytes, textureBytes, limits.decoded, "decoded");
  list(json.materials, 512);
  list(json.skins, 512);
  if (!draws || !triangles) fail("unsupported");
  return { triangles, draws, geometryBytes, textureBytes };
}
