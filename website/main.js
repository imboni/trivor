const RELEASES_URL = "https://github.com/imboni/trivor/releases/latest";
const RELEASE_NOTES_URL = "https://github.com/imboni/trivor/releases/tag/v0.5.0";
const RELEASES_ALL_URL = "https://github.com/imboni/trivor/releases";
const REPO_URL = "https://github.com/imboni/trivor";
const ISSUES_URL = "https://github.com/imboni/trivor/issues";

const copy = {
  en: {
    metaDescription:
      "Trivor 0.5.0 for macOS: Finder GLB previews and thumbnails, adaptive preview capacity, progressive model loading, and transparent PNG export.",
    screenshotAlt: "Trivor app window showing a 3D model viewer on macOS",
    langToggle: "Switch to Chinese",
    themeToggle: "Toggle theme",
    download: "Download for macOS",
    releaseNotes: "New in 0.5.0 · Finder previews & thumbnails",
    heroBrandSub: "极视",
    heroTagline: "See every dimension.",
    heroQuote: "Blank as paper—awaiting the stroke of mountains.",
    heroDesc:
      "Inspect 3D models in a lightweight Mac app, or press Space in Finder for an interactive GLB preview. Keep your assets local.",
    heroMeta: "macOS 13+ · Apple Silicon & Intel · Free",
    linkFeatures: "Features",
    linkFaq: "FAQ",
    linkGitHub: "GitHub",
    featuresTitle: "Built for quick inspection",
    featureViewTitle: "Interactive viewing",
    featureViewDesc: "Orbit, zoom, and frame models with smooth camera controls.",
    featureBrowseTitle: "Files & folders",
    featureBrowseDesc: "Open glTF, GLB, OBJ or STL files, browse folders, and package supported assets as GLB or embedded glTF.",
    featureMacTitle: "Preview right in Finder",
    featureMacDesc: "Select a self-contained GLB and press Space to rotate, zoom and fit. See model thumbnails directly in Finder.",
    featureCutoutTitle: "Cutout export",
    featureCutoutDesc:
      "Export a transparent PNG from the current view — preview, pan/zoom, then save via the native dialog.",
    featureAdaptiveTitle: "More room on capable Macs",
    featureAdaptiveDesc: "Quick Look adjusts capacity to your memory, GPU and system conditions, with four file budgets from 128 to 512 MiB.",
    featureLargeTitle: "Large models, in stages",
    featureLargeDesc: "Start with a lightweight overview of large GLB or glTF assets in the app, then load more detail while keeping your view.",
    faqTitle: "FAQ",
    faqQ1: "How do I install Trivor?",
    faqA1: "Download the DMG, drag Trivor to Applications, then launch it from Launchpad or Finder.",
    faqQ2: "macOS says Trivor can't be opened — what should I do?",
    faqA2:
      "The current release is ad-hoc signed and has not been notarized by Apple. If macOS blocks it, try opening it once, then go to System Settings → Privacy & Security and choose Open Anyway for Trivor.",
    faqQ3: "Which file formats are supported?",
    faqA3: "The app opens glTF and GLB, and imports OBJ and STL through conversion. Finder previews and thumbnails support self-contained GLB files only.",
    faqQ4: "What are the system requirements?",
    faqA4: "macOS 13 Ventura or later. The universal app includes Apple Silicon and Intel builds; 0.5.0 was runtime-tested on macOS 27.2 with Apple Silicon.",
    faqQ6: "How large can a Finder preview be?",
    faqA6: "Space previews use file budgets of 128, 256, 384 or 512 MiB, selected automatically. Decoded textures, geometry and scene complexity also count; memory or thermal pressure can lower capacity. Background thumbnails keep a 64 MiB file limit. Open larger models in the app for progressive previews.",
    faqQ7: "How do I enable Finder previews?",
    faqA7: "Install Trivor 0.5.0 or later in Applications, select a self-contained GLB and press Space. If disabled, search System Settings for Extensions and enable Trivor GLB Preview and Trivor GLB Thumbnail under Quick Look. Other GLB extensions may affect which preview macOS uses.",
    faqQ5: "Where can I find previous releases?",
    faqA5: "Browse all releases on GitHub",
    footerCopy: "Copyright © 2026 imboni and contributors.",
    footerReleases: "Release history",
    footerIssues: "Feedback",
  },
  zh: {
    metaDescription: "Trivor（极视）0.5.0 — macOS 轻量 3D 模型查看器。访达 GLB 预览与缩略图、硬件自适应容量、大模型渐进加载及透明 PNG 导出。",
    screenshotAlt: "Trivor macOS 应用窗口，展示 3D 模型查看界面",
    langToggle: "Switch to English",
    themeToggle: "切换主题",
    download: "下载 macOS 版",
    releaseNotes: "0.5.0 新功能 · 访达预览与缩略图",
    heroBrandSub: "极视",
    heroTagline: "所见即三维。",
    heroQuote: "空阔如纸，等一笔山河。",
    heroDesc: "在轻量 Mac 应用中查看三维模型，也可在访达按空格直接预览 GLB，旋转、缩放。模型始终在本地处理。",
    heroMeta: "macOS 13+ · Apple Silicon 与 Intel · 免费",
    linkFeatures: "功能",
    linkFaq: "常见问题",
    linkGitHub: "GitHub",
    featuresTitle: "随手查看，不必折腾",
    featureViewTitle: "流畅查看",
    featureViewDesc: "旋转、缩放、一键框选，怎么看都顺手。",
    featureBrowseTitle: "文件与文件夹",
    featureBrowseDesc: "打开 glTF、GLB、OBJ 或 STL，浏览整个文件夹，并将支持的资产打包导出为 GLB 或单文件 glTF。",
    featureMacTitle: "访达里，空格即预览",
    featureMacDesc: "选中自包含 GLB，按空格即可旋转、缩放和适应视图；访达中也能直接看到模型缩略图。",
    featureCutoutTitle: "抠图导出",
    featureCutoutDesc: "从当前视角导出透明背景 PNG，预览后可缩放查看细节，再通过系统对话框保存。",
    featureAdaptiveTitle: "好硬件，更大预览容量",
    featureAdaptiveDesc: "根据内存、GPU 和系统状态自动选择四档 Quick Look 容量，文件预算从 128 到 512 MiB。",
    featureLargeTitle: "大模型，先概览再细化",
    featureLargeDesc: "在主应用中先查看大型 GLB、glTF 的轻量概览，再逐步加载细节，细化时保留当前观察视角。",
    faqTitle: "常见问题",
    faqQ1: "如何安装 Trivor？",
    faqA1: "下载 .dmg，将 Trivor 拖入「应用程序」，从启动台或访达打开即可。",
    faqQ2: "提示「应用程序 Trivor.app 无法打开」？",
    faqA2:
      "当前版本采用临时签名，尚未通过 Apple 公证。如果系统阻止打开，请先尝试启动一次，再前往「系统设置 → 隐私与安全性」，为 Trivor 选择「仍要打开」。",
    faqQ3: "支持哪些格式？",
    faqA3: "主应用支持 glTF、GLB，并通过转换导入 OBJ、STL。访达预览与缩略图仅支持资源全部内嵌的自包含 GLB。",
    faqQ4: "需要什么系统？",
    faqA4: "最低 macOS 13 Ventura。通用安装包包含 Apple Silicon 与 Intel 构建；0.5.0 已在 macOS 27.2 的 Apple Silicon 设备上实测。",
    faqQ6: "访达能预览多大的模型？",
    faqA6: "空格预览自动选择 128、256、384 或 512 MiB 文件预算，还会检查解码后的贴图、几何和场景复杂度。内存压力或过热时会收紧容量。后台缩略图保持 64 MiB 文件上限；更大的模型请在主应用中渐进预览。",
    faqQ7: "如何启用访达预览？",
    faqA7: "将 Trivor 0.5.0 或更新版本安装到「应用程序」，在访达选中自包含 GLB 后按空格。如扩展被禁用，在系统设置中搜索「扩展」，在 Quick Look 下启用 Trivor GLB Preview 和 Trivor GLB Thumbnail。其他 GLB 扩展可能影响系统选择的预览程序。",
    faqQ5: "如何获取历史版本？",
    faqA5: "在 GitHub 查看全部发布版本",
    footerCopy: "Copyright © 2026 imboni and contributors.",
    footerReleases: "版本记录",
    footerIssues: "反馈",
  },
};

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const THEME_META = {
  dark: {
    themeColor: "#121316",
    ogImage: "assets/screenshot-dark.png",
  },
  light: {
    themeColor: "#e8ebf2",
    ogImage: "assets/screenshot-light.png",
  },
};

function applyThemeMeta(theme) {
  const meta = THEME_META[theme];
  if (!meta) return;
  const themeColor = document.getElementById("theme-color");
  const ogImage = document.getElementById("og-image");
  if (themeColor) themeColor.setAttribute("content", meta.themeColor);
  if (ogImage) ogImage.setAttribute("content", meta.ogImage);
}

function detectLang() {
  const saved = localStorage.getItem("trivor-site-lang");
  if (saved === "en" || saved === "zh") return saved;
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language];
  return langs.some((lang) => lang.toLowerCase().startsWith("zh")) ? "zh" : "en";
}

function detectTheme() {
  const saved = localStorage.getItem("trivor-site-theme");
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function langToggleLabel(lang) {
  return lang === "zh" ? "EN" : "中文";
}

function applyLang(lang) {
  const strings = copy[lang];
  document.documentElement.lang = lang === "zh" ? "zh-Hans" : "en";

  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    if (!key || !(key in strings)) return;
    el.textContent = strings[key];
  });

  document.querySelectorAll("[data-i18n-alt]").forEach((el) => {
    const key = el.getAttribute("data-i18n-alt");
    if (!key || !(key in strings)) return;
    el.setAttribute("alt", strings[key]);
  });

  const meta = document.querySelector('meta[name="description"]');
  if (meta) meta.setAttribute("content", strings.metaDescription);
  const ogDescription = document.querySelector('meta[property="og:description"]');
  if (ogDescription) ogDescription.setAttribute("content", strings.metaDescription);

  document.title =
    lang === "zh" ? "Trivor — macOS 3D 模型查看器" : "Trivor — macOS 3D Model Viewer";

  const brandSub = document.querySelector(".hero-brand-sub");
  if (brandSub) brandSub.hidden = lang !== "zh";

  const langToggle = document.getElementById("lang-toggle");
  if (langToggle) {
    langToggle.textContent = langToggleLabel(lang);
    langToggle.setAttribute("aria-label", strings.langToggle);
  }

  const themeToggle = document.getElementById("theme-toggle");
  if (themeToggle) themeToggle.setAttribute("aria-label", strings.themeToggle);

  localStorage.setItem("trivor-site-lang", lang);
}

function applyTheme(theme, { animate = false } = {}) {
  document.documentElement.dataset.theme = theme;
  applyThemeMeta(theme);

  const toggle = document.getElementById("theme-toggle");
  if (toggle) {
    toggle.textContent = theme === "dark" ? "☀" : "☾";
    if (animate && !reducedMotion()) {
      toggle.classList.remove("is-spinning");
      void toggle.offsetWidth;
      toggle.classList.add("is-spinning");
    }
  }

  localStorage.setItem("trivor-site-theme", theme);
}

function bindExternalLinks() {
  const map = {
    releases: RELEASES_URL,
    "release-notes": RELEASE_NOTES_URL,
    "releases-all": RELEASES_ALL_URL,
    repo: REPO_URL,
    issues: ISSUES_URL,
  };

  document.querySelectorAll("[data-href]").forEach((el) => {
    const key = el.getAttribute("data-href");
    const href = key ? map[key] : null;
    if (!href) return;
    el.setAttribute("href", href);
    el.setAttribute("target", "_blank");
    el.setAttribute("rel", "noopener noreferrer");
  });
}

/** Mouse parallax for the perspective grid background. */
function bindGridParallax() {
  if (reducedMotion()) return;

  const viewportBg = document.getElementById("viewport-bg");
  const scene = document.getElementById("perspective-scene");
  const layerFar = document.getElementById("grid-far");
  const layerNear = document.getElementById("grid-near");
  const glow = document.getElementById("perspective-glow");
  if (!viewportBg || !scene || !layerFar || !layerNear || !glow) return;

  const target = { x: 0, y: 0 };
  const current = { x: 0, y: 0 };
  let idleTimer = null;
  let ticking = false;
  const epsilon = 0.0008;

  const applyParallax = () => {
    const tiltX = 61 + current.y * -1.6;
    const driftX = current.x * 22;
    const driftZ = current.y * 12;
    const glowX = 50 + current.x * 14;
    const glowY = 70 + current.y * 6;

    scene.style.perspectiveOrigin = `${50 + current.x * 7}% ${30 + current.y * 5}%`;
    glow.style.setProperty("--grid-glow-x", `${glowX}%`);
    glow.style.setProperty("--grid-glow-y", `${glowY}%`);

    layerNear.style.transform =
      `rotateX(${tiltX}deg) rotateZ(${current.x * -0.7}deg) translate3d(${driftX}px, -150px, ${driftZ}px)`;
    layerFar.style.transform =
      `rotateX(${tiltX}deg) rotateZ(${current.x * -0.35}deg) translate3d(${driftX * 0.4}px, -150px, ${driftZ * 0.4 - 70}px)`;
  };

  const needsTick = () =>
    Math.abs(target.x - current.x) > epsilon || Math.abs(target.y - current.y) > epsilon;

  const tick = () => {
    ticking = false;
    current.x += (target.x - current.x) * 0.07;
    current.y += (target.y - current.y) * 0.07;
    applyParallax();
    if (needsTick()) scheduleTick();
  };

  const scheduleTick = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(tick);
  };

  const markActive = () => {
    viewportBg.classList.remove("is-grid-idle");
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => viewportBg.classList.add("is-grid-idle"), 2200);
  };

  window.addEventListener(
    "mousemove",
    (e) => {
      target.x = e.clientX / window.innerWidth - 0.5;
      target.y = e.clientY / window.innerHeight - 0.5;
      markActive();
      scheduleTick();
    },
    { passive: true },
  );

  applyParallax();
}

function revealGroup(group) {
  group.classList.add("is-in");
  group.querySelectorAll(".motion-child").forEach((child, index) => {
    child.style.setProperty("--motion-delay", `${index * 90}ms`);
  });
}

function revealElement(el) {
  el.classList.add("is-in");
}

function bindScrollMotion() {
  const targets = document.querySelectorAll("[data-reveal-group], .motion-scroll");
  if (!targets.length) return;

  if (reducedMotion()) {
    targets.forEach((el) => {
      if (el.hasAttribute("data-reveal-group")) revealGroup(el);
      else revealElement(el);
    });
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const el = entry.target;
        if (el.hasAttribute("data-reveal-group")) revealGroup(el);
        else revealElement(el);
        observer.unobserve(el);
      });
    },
    { threshold: 0.08, rootMargin: "0px 0px -5% 0px" },
  );

  targets.forEach((el) => observer.observe(el));

  // Catch elements already in view (e.g. short pages).
  requestAnimationFrame(() => {
    targets.forEach((el) => {
      if (el.classList.contains("is-in")) return;
      const rect = el.getBoundingClientRect();
      if (rect.top < window.innerHeight && rect.bottom > 0) {
        if (el.hasAttribute("data-reveal-group")) revealGroup(el);
        else revealElement(el);
        observer.unobserve(el);
      }
    });
  });
}

function init() {
  applyLang(detectLang());
  applyTheme(detectTheme());
  bindExternalLinks();
  bindGridParallax();
  bindScrollMotion();

  document.getElementById("lang-toggle")?.addEventListener("click", () => {
    const next = document.documentElement.lang === "zh-Hans" ? "en" : "zh";
    applyLang(next);
  });

  document.getElementById("theme-toggle")?.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(next, { animate: true });
  });
}

init();
