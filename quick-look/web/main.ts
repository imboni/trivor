import { ModelViewerElement } from "@google/model-viewer";
import { inspectGlb, resolvePreviewBudget, PreviewError, type PreviewErrorCode, type PreviewLimitDetail, type PreviewLimitMetric, type PreviewLimits, type PreviewTier } from "./glb-guard";
import "./styles.css";

interface ModelRequest { url: string; name: string; locale?: string; requestId: string; budget?: unknown; }
interface NativeMessage { type: "boot" | "ready" | "error"; requestId?: string; code?: PreviewErrorCode; message?: string; limit?: PreviewLimitDetail; }
declare global {
  interface Window {
    trivorQuickLook: { loadModel(request: ModelRequest): Promise<void>; dispose(): void };
    webkit?: { messageHandlers?: { preview?: { postMessage(message: NativeMessage): void } } };
  }
}

// LoadingMixin reads this global configuration when the first element is
// constructed, overriding static setter values with its CDN defaults otherwise.
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

const text = {
  en: {
    loading: "Preparing preview…", fit: "Fit", hint: "Drag to rotate · Scroll to zoom",
    model: "3D model", open: "Open this model in Trivor to continue.",
    tooLarge: "This model needs the full viewer",
    invalid: "This GLB file could not be read",
    externalResources: "This model uses separate resources",
    unsupported: "This model needs the full viewer",
    renderFailed: "The preview could not be displayed",
  },
  zh: {
    loading: "正在准备预览…", fit: "适应", hint: "拖动旋转 · 滚动缩放",
    model: "三维模型", open: "请在 Trivor 中打开此模型以继续查看。",
    tooLarge: "此模型需要在完整查看器中打开",
    invalid: "无法读取此 GLB 文件",
    externalResources: "此模型包含外部资源",
    unsupported: "此模型需要在完整查看器中打开",
    renderFailed: "无法显示模型预览",
  },
};
const limitLabels: Record<"en" | "zh", Record<PreviewLimitMetric, string>> = {
  en: {
    file: "File size", json: "JSON data", geometry: "Estimated geometry/buffer memory", textures: "Estimated decoded texture memory",
    decoded: "Estimated combined geometry and texture memory",
    triangles: "Triangles", draws: "Draw calls", nodes: "Nodes or instances", depth: "Nesting depth",
    animationChannels: "Animation channels", animationSamplers: "Animation samplers", animationTracks: "Animation tracks", entries: "Data entries",
  },
  zh: {
    file: "文件大小", json: "JSON 数据大小", geometry: "几何及缓冲区预计占用", textures: "解码纹理预计占用",
    decoded: "几何与纹理合计预计占用",
    triangles: "三角形数量", draws: "绘制次数", nodes: "节点或实例数量", depth: "嵌套深度",
    animationChannels: "动画通道数量", animationSamplers: "动画采样器数量", animationTracks: "动画轨道数量", entries: "数据项数量",
  },
};
const tierLabels: Record<"en" | "zh", Record<PreviewTier, string>> = {
  en: { standard: "Standard", expanded: "Expanded", large: "Large capacity", maximum: "Maximum capacity" },
  zh: { standard: "标准", expanded: "扩展", large: "大容量", maximum: "超大容量" },
};
const root = document.querySelector<HTMLElement>("#preview")!;
const viewport = document.querySelector<HTMLElement>("#viewport")!;
const status = document.querySelector<HTMLElement>("#status")!;
const title = document.querySelector<HTMLElement>("#status-title")!;
const detail = document.querySelector<HTMLElement>("#status-detail")!;
const spinner = document.querySelector<HTMLElement>("#spinner")!;
const controls = document.querySelector<HTMLElement>("#controls")!;
const hint = document.querySelector<HTMLElement>("#hint")!;
const fit = document.querySelector<HTMLButtonElement>("#fit")!;
const budgetBadge = document.createElement("span");
budgetBadge.id = "budget-tier";
budgetBadge.hidden = true;
budgetBadge.tabIndex = 0;
root.append(budgetBadge);
let labels = text.en;
let generation = 0;
let abort: AbortController | null = null;
let viewer: ModelViewerElement | null = null;
let objectUrl: string | null = null;
let initialCamera: { orbit: string; target: string; fov: string } | null = null;
let detachEvents: (() => void) | null = null;

function formatMemory(number: number): string {
  const locale = labels === text.zh ? "zh-CN" : "en-US";
  return number < 1024 * 1024
    ? `${new Intl.NumberFormat(locale).format(number)} B`
    : `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(Math.ceil(number / 1024 / 1024 * 100) / 100)} MiB`;
}

function limitMessage(value: PreviewLimitDetail): string {
  const chinese = labels === text.zh;
  const locale = chinese ? "zh-CN" : "en-US";
  const bytes = ["file", "json", "geometry", "textures", "decoded"].includes(value.metric);
  const format = (number: number) => bytes
    ? formatMemory(number)
    : new Intl.NumberFormat(locale).format(number);
  const name = limitLabels[chinese ? "zh" : "en"][value.metric];
  // A cumulative check may stop as soon as it crosses a budget, before visiting
  // every entry. Report that count as a lower bound, not a complete model total.
  const exact = value.metric === "file" || value.metric === "json";
  return chinese
    ? `${name}：${exact ? "" : "至少 "}${format(value.actual)}，上限 ${format(value.limit)}。`
    : `${name}: ${exact ? "" : "at least "}${format(value.actual)}; limit ${format(value.limit)}.`;
}

function post(message: NativeMessage): void {
  window.webkit?.messageHandlers?.preview?.postMessage(message);
}
function release(): void {
  budgetBadge.hidden = true;
  abort?.abort(); abort = null;
  detachEvents?.(); detachEvents = null;
  if (viewer) {
    viewer.pause();
    viewer.removeAttribute("src");
    viewer.remove();
    viewer = null;
  }
  if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
  initialCamera = null;
}
function dispose(): void { generation++; release(); }
function resetCamera(): void {
  if (!viewer || !initialCamera) return;
  viewer.cameraOrbit = initialCamera.orbit;
  viewer.cameraTarget = initialCamera.target;
  viewer.fieldOfView = initialCamera.fov;
}
fit.addEventListener("click", resetCamera);
viewport.addEventListener("dblclick", resetCamera);
document.addEventListener("keydown", (event) => {
  // Space belongs to Finder: leave it free to dismiss Quick Look.
  if (event.key.toLowerCase() === "f" && !event.metaKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault(); resetCamera();
  }
});
window.addEventListener("pagehide", dispose);

async function fetchModel(url: URL, signal: AbortSignal, limits: PreviewLimits): Promise<ArrayBuffer> {
  const response = await fetch(url.href, { signal });
  if (!response.ok) throw new PreviewError("invalid");
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > limits.file) throw new PreviewError("tooLarge", Number.isSafeInteger(declared)
    ? { metric: "file", actual: declared, limit: limits.file } : undefined);
  if (!response.body) {
    const data = await response.arrayBuffer();
    if (data.byteLength > limits.file) throw new PreviewError("tooLarge", { metric: "file", actual: data.byteLength, limit: limits.file });
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
      if (bytes > limits.file) throw new PreviewError("tooLarge", { metric: "file", actual: bytes, limit: limits.file });
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const combined = new Uint8Array(bytes);
  let at = 0;
  for (const chunk of chunks) { combined.set(chunk, at); at += chunk.byteLength; }
  return combined.buffer;
}

async function loadModel(request: ModelRequest): Promise<void> {
  const token = ++generation;
  release();
  const requestId = typeof request?.requestId === "string" ? request.requestId : "";
  const budget = resolvePreviewBudget(request?.budget);
  const { limits } = budget;
  labels = (request?.locale ?? navigator.language).toLowerCase().startsWith("zh") ? text.zh : text.en;
  document.documentElement.lang = labels === text.zh ? "zh-Hans" : "en";
  document.title = typeof request?.name === "string" ? request.name : "Trivor Preview";
  title.textContent = labels.loading;
  detail.textContent = "";
  fit.textContent = labels.fit;
  fit.title = `${labels.fit} (F)`;
  hint.textContent = labels.hint;
  const chinese = labels === text.zh;
  budgetBadge.textContent = tierLabels[chinese ? "zh" : "en"][budget.tier];
  budgetBadge.title = chinese
    ? `文件上限 ${formatMemory(limits.file)} · 纹理上限 ${formatMemory(limits.textures)}`
    : `File limit ${formatMemory(limits.file)} · Texture limit ${formatMemory(limits.textures)}`;
  budgetBadge.setAttribute("aria-label", `${budgetBadge.textContent} — ${budgetBadge.title}`);
  status.hidden = false;
  spinner.hidden = false;
  controls.hidden = true;
  root.setAttribute("aria-busy", "true");
  root.dataset.state = "loading";
  root.dataset.budgetTier = budget.tier;
  let settled = false;
  const failed = (code: PreviewErrorCode, limit?: PreviewLimitDetail) => {
    if (token !== generation || settled) return;
    settled = true;
    release();
    root.setAttribute("aria-busy", "false");
    root.dataset.state = "error";
    spinner.hidden = true;
    title.textContent = labels[code];
    detail.textContent = limit ? `${limitMessage(limit)} ${labels.open}` : labels.open;
    status.hidden = false;
    post({ type: "error", code, requestId, message: labels[code], ...(limit ? { limit } : {}) });
  };
  try {
    const url = new URL(request.url);
    const base = new URL(document.baseURI);
    // Keep a same-origin HTTP route for the local browser regression server.
    const native = url.protocol === "trivor-preview:" && url.hostname === "bundle" && url.pathname === "/model.glb";
    const localTest = ["http:", "https:"].includes(base.protocol) && url.origin === base.origin;
    if ((!native && !localTest) || url.username || url.password || url.search || url.hash) throw new PreviewError("externalResources");
    abort = new AbortController();
    const data = await fetchModel(url, abort.signal, limits);
    if (token !== generation) return;
    inspectGlb(data, limits);
    const blob = new Blob([data], { type: "model/gltf-binary" });
    objectUrl = URL.createObjectURL(blob);
    const mv = document.createElement("model-viewer");
    viewer = mv;
    mv.alt = labels.model;
    mv.setAttribute("camera-controls", "");
    mv.setAttribute("disable-tap", "");
    mv.setAttribute("interaction-prompt", "none");
    mv.setAttribute("loading", "eager");
    mv.setAttribute("reveal", "auto");
    mv.setAttribute("environment-image", "neutral");
    mv.setAttribute("shadow-intensity", "0.6");
    mv.setAttribute("interpolation-decay", "20");
    mv.setAttribute("touch-action", "none");
    const onError = () => failed("renderFailed");
    const onLoad = () => {
      // Let the loaded scene be drawn before telling Quick Look it is ready.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (token !== generation || viewer !== mv || settled) return;
        settled = true;
        mv.pause();
        const orbit = mv.getCameraOrbit(), target = mv.getCameraTarget();
        initialCamera = {
          orbit: `${orbit.theta}rad ${orbit.phi}rad ${orbit.radius}m`,
          target: `${target.x}m ${target.y}m ${target.z}m`,
          fov: `${mv.getFieldOfView()}deg`,
        };
        root.setAttribute("aria-busy", "false");
        root.dataset.state = "ready";
        status.hidden = true;
        controls.hidden = false;
        budgetBadge.hidden = false;
        post({ type: "ready", requestId });
      }));
    };
    mv.addEventListener("load", onLoad);
    mv.addEventListener("error", onError);
    detachEvents = () => { mv.removeEventListener("load", onLoad); mv.removeEventListener("error", onError); };
    viewport.append(mv);
    mv.src = objectUrl;
  } catch (error) {
    if (token !== generation) return;
    failed(error instanceof PreviewError ? error.code : "renderFailed", error instanceof PreviewError ? error.detail : undefined);
  }
}

window.trivorQuickLook = { loadModel, dispose };
post({ type: "boot" });
