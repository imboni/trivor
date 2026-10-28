import { ModelViewerElement } from "@google/model-viewer";
import { $updateSize } from "@google/model-viewer/lib/model-viewer-base.js";
import { captureCutoutFrameOffscreen } from "../../src/cutout-display-capture";
import { inspectGlb, THUMBNAIL_LIMITS, PreviewError, type PreviewErrorCode, type PreviewLimitDetail } from "./glb-guard";

interface ThumbnailRequest { url: string; name: string; requestId: string; size: number; locale?: string; }
type ThumbnailMessage =
  | { type: "boot" }
  | { type: "ready"; requestId: string; png: string }
  | { type: "error"; requestId: string; code: PreviewErrorCode | "timedOut"; limit?: PreviewLimitDetail };
declare global {
  interface Window {
    trivorThumbnail: { render(request: ThumbnailRequest): Promise<void>; dispose(): void };
  }
}

const decoders = {
  dracoDecoderLocation: new URL("./decoders/draco/", document.baseURI).href,
  ktx2TranscoderLocation: new URL("./decoders/basis/", document.baseURI).href,
  meshoptDecoderLocation: new URL("./decoders/meshopt/meshopt_decoder.js", document.baseURI).href,
};
(globalThis as typeof globalThis & { ModelViewerElement?: typeof decoders }).ModelViewerElement = decoders;
ModelViewerElement.dracoDecoderLocation = decoders.dracoDecoderLocation;
ModelViewerElement.ktx2TranscoderLocation = decoders.ktx2TranscoderLocation;
ModelViewerElement.meshoptDecoderLocation = decoders.meshoptDecoderLocation;
ModelViewerElement.modelCacheSize = 0;

const root = document.querySelector<HTMLElement>("#thumbnail")!;
const MAX_PNG_BASE64_LENGTH = 8 * 1024 * 1024;
let generation = 0;
let abort: AbortController | null = null;
let viewer: ModelViewerElement | null = null;
let objectUrl: string | null = null;
let detachEvents: (() => void) | null = null;
let deadline: ReturnType<typeof setTimeout> | null = null;

function post(message: ThumbnailMessage): void {
  const bridge = window as unknown as { webkit?: { messageHandlers?: { thumbnail?: { postMessage(value: ThumbnailMessage): void } } } };
  bridge.webkit?.messageHandlers?.thumbnail?.postMessage(message);
}

function release(): void {
  if (deadline !== null) clearTimeout(deadline);
  deadline = null;
  abort?.abort(); abort = null;
  detachEvents?.(); detachEvents = null;
  if (viewer) {
    viewer.pause();
    viewer.removeAttribute("src");
    viewer.remove();
    viewer = null;
  }
  if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
}

function dispose(): void { generation++; release(); }

async function fetchModel(url: URL, signal: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(url.href, { signal });
  if (!response.ok) throw new PreviewError("invalid");
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > THUMBNAIL_LIMITS.file) throw new PreviewError("tooLarge", Number.isSafeInteger(declared)
    ? { metric: "file", actual: declared, limit: THUMBNAIL_LIMITS.file } : undefined);
  if (!response.body) {
    const data = await response.arrayBuffer();
    if (data.byteLength > THUMBNAIL_LIMITS.file) throw new PreviewError("tooLarge", { metric: "file", actual: data.byteLength, limit: THUMBNAIL_LIMITS.file });
    return data;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > THUMBNAIL_LIMITS.file) throw new PreviewError("tooLarge", { metric: "file", actual: bytes, limit: THUMBNAIL_LIMITS.file });
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const data = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  return data.buffer;
}

async function render(request: ThumbnailRequest): Promise<void> {
  const token = ++generation;
  release();
  const requestId = typeof request?.requestId === "string" ? request.requestId : "";
  root.dataset.state = "loading";
  root.setAttribute("aria-busy", "true");
  let settled = false;
  const failed = (code: PreviewErrorCode | "timedOut", limit?: PreviewLimitDetail) => {
    if (token !== generation || settled) return;
    settled = true;
    release();
    root.dataset.state = "error";
    root.setAttribute("aria-busy", "false");
    post({ type: "error", requestId, code, ...(limit ? { limit } : {}) });
  };
  deadline = setTimeout(() => failed("timedOut"), 15_000);
  try {
    const size = request?.size;
    if (!requestId || !Number.isInteger(size) || size < 1 || size > 1024) throw new PreviewError("invalid");
    const url = new URL(request.url);
    const base = new URL(document.baseURI);
    const native = url.protocol === "trivor-preview:" && url.hostname === "bundle" && url.pathname === "/model.glb" && !url.port;
    const localTest = ["http:", "https:"].includes(base.protocol) && url.origin === base.origin;
    if ((!native && !localTest) || url.username || url.password || url.search || url.hash) throw new PreviewError("externalResources");
    document.title = typeof request.name === "string" ? request.name : "Trivor Thumbnail";
    document.documentElement.lang = request.locale?.toLowerCase().startsWith("zh") ? "zh-Hans" : "en";
    root.style.width = `${size}px`;
    root.style.height = `${size}px`;
    abort = new AbortController();
    const data = await fetchModel(url, abort.signal);
    if (token !== generation || settled) return;
    inspectGlb(data, THUMBNAIL_LIMITS);
    objectUrl = URL.createObjectURL(new Blob([data], { type: "model/gltf-binary" }));
    const mv = document.createElement("model-viewer");
    viewer = mv;
    mv.setAttribute("loading", "eager");
    mv.setAttribute("reveal", "auto");
    mv.setAttribute("interaction-prompt", "none");
    mv.setAttribute("environment-image", "neutral");
    mv.setAttribute("camera-orbit", "30deg 65deg auto");
    mv.setAttribute("shadow-intensity", "0");
    mv.setAttribute("interpolation-decay", "0");
    let capturing = false;
    const capture = async () => {
      if (capturing || token !== generation || viewer !== mv || settled) return;
      capturing = true;
      try {
        await mv.updateComplete;
        if (token !== generation || viewer !== mv || settled) return;
        // ResizeObserver and animation frames can be suspended in a thumbnail
        // process. Set the scene size directly, then settle its camera via Lit's
        // microtasks and render into our existing offscreen export target.
        mv[$updateSize]({ width: size, height: size });
        mv.jumpCameraToGoal();
        await mv.updateComplete;
        await Promise.resolve();
        if (token !== generation || viewer !== mv || settled) return;
        mv.pause();
        const pixels = await captureCutoutFrameOffscreen(mv, {
          includeShadow: false,
          region: { x: 0, y: 0, width: size, height: size, fullWidth: size, fullHeight: size },
        });
        if (token !== generation || viewer !== mv || settled) return;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext("2d");
        if (!context) throw new PreviewError("renderFailed");
        context.putImageData(pixels, 0, 0);
        const prefix = "data:image/png;base64,";
        const png = canvas.toDataURL("image/png");
        if (!png.startsWith(prefix) || png.length - prefix.length > MAX_PNG_BASE64_LENGTH) throw new PreviewError("renderFailed");
        settled = true;
        release();
        root.dataset.state = "ready";
        root.setAttribute("aria-busy", "false");
        post({ type: "ready", requestId, png: png.slice(prefix.length) });
      } catch (error) {
        failed(error instanceof PreviewError ? error.code : "renderFailed", error instanceof PreviewError ? error.detail : undefined);
      }
    };
    const onReady = () => { void capture(); };
    const onError = () => failed("renderFailed");
    // before-render fires after geometry, textures and environment have loaded,
    // before model-viewer waits on requestAnimationFrame to emit its load event.
    mv.addEventListener("before-render", onReady);
    mv.addEventListener("load", onReady);
    mv.addEventListener("error", onError);
    detachEvents = () => {
      mv.removeEventListener("before-render", onReady);
      mv.removeEventListener("load", onReady);
      mv.removeEventListener("error", onError);
    };
    root.append(mv);
    mv.src = objectUrl;
  } catch (error) {
    if (token !== generation || settled) return;
    failed(error instanceof PreviewError ? error.code : "renderFailed", error instanceof PreviewError ? error.detail : undefined);
  }
}

window.addEventListener("pagehide", dispose);
window.trivorThumbnail = { render, dispose };
post({ type: "boot" });
