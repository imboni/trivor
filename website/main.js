const RELEASES_URL = "https://github.com/imboni/trivor/releases/latest";
const RELEASES_ALL_URL = "https://github.com/imboni/trivor/releases";
const REPO_URL = "https://github.com/imboni/trivor";
const ISSUES_URL = "https://github.com/imboni/trivor/issues";

const copy = {
  en: {
    metaDescription:
      "Trivor — a lightweight 3D model viewer for macOS. Open glTF and GLB files directly from Finder.",
    screenshotAlt: "Trivor app window showing a 3D model viewer on macOS",
    langToggle: "Switch to Chinese",
    themeToggle: "Toggle theme",
    download: "Download for macOS",
    heroBrandSub: "极视",
    heroTagline: "See every dimension.",
    heroQuote: "Blank as paper—awaiting the stroke of mountains.",
    heroDesc:
      "A lightweight 3D model viewer for macOS. Open glTF and GLB files and inspect them in seconds.",
    heroMeta: "macOS 13+ · glTF / GLB · Free",
    linkFeatures: "Features",
    linkFaq: "FAQ",
    linkGitHub: "GitHub",
    featuresTitle: "Built for quick inspection",
    featureViewTitle: "Interactive viewing",
    featureViewDesc: "Orbit, zoom, and frame models with smooth camera controls.",
    featureBrowseTitle: "Files & folders",
    featureBrowseDesc: "Open a single model or an entire folder, then switch between files in the sidebar.",
    featureMacTitle: "Native on macOS",
    featureMacDesc: "Open from Finder, use the menu bar, and rely on familiar keyboard shortcuts.",
    faqTitle: "FAQ",
    faqQ1: "How do I install Trivor?",
    faqA1: "Download the DMG, drag Trivor to Applications, then launch it from Launchpad or Finder.",
    faqQ2: "macOS won't open the app — what should I do?",
    faqA2:
      "Trivor is not distributed through the App Store. Control-click the app, choose Open, confirm once, and it will open normally afterward.",
    faqQ3: "Which file formats are supported?",
    faqA3: "glTF and GLB — the standard formats for real-time 3D content.",
    faqQ4: "What are the system requirements?",
    faqA4: "macOS 13 Ventura or later, on Apple Silicon or Intel.",
    faqQ5: "Where can I find previous releases?",
    faqA5: "Browse all releases on GitHub",
    footerCopy: "Copyright © 2026 imboni and contributors.",
    footerReleases: "Release history",
    footerIssues: "Feedback",
  },
  zh: {
    metaDescription: "Trivor（极视）— macOS 轻量 3D 模型查看器。打开 glTF / GLB，访达即用。",
    screenshotAlt: "Trivor macOS 应用窗口，展示 3D 模型查看界面",
    langToggle: "Switch to English",
    themeToggle: "切换主题",
    download: "下载 macOS 版",
    heroBrandSub: "极视",
    heroTagline: "所见即三维。",
    heroQuote: "空阔如纸，等一笔山河。",
    heroDesc: "macOS 上的轻量 3D 模型查看器。打开文件，看一眼，继续干活。",
    heroMeta: "macOS 13+ · glTF / GLB · 免费",
    linkFeatures: "功能",
    linkFaq: "常见问题",
    linkGitHub: "GitHub",
    featuresTitle: "随手查看，不必折腾",
    featureViewTitle: "流畅查看",
    featureViewDesc: "旋转、缩放、一键框选，怎么看都顺手。",
    featureBrowseTitle: "文件与文件夹",
    featureBrowseDesc: "打开单个模型或整个目录，在侧栏里快速切换。",
    featureMacTitle: "融入 Mac",
    featureMacDesc: "原生应用体验 — 访达打开、菜单栏、熟悉的快捷键。",
    faqTitle: "常见问题",
    faqQ1: "如何安装 Trivor？",
    faqA1: "下载 .dmg，将 Trivor 拖入「应用程序」，从启动台或访达打开即可。",
    faqQ2: "提示「无法打开」或「无法验证开发者」？",
    faqA2: "暂未上架 App Store。按住 Control 点按 Trivor → 打开，确认一次后即可正常使用。",
    faqQ3: "支持哪些格式？",
    faqA3: "glTF 与 GLB，常用的实时 3D 资产格式。",
    faqQ4: "需要什么系统？",
    faqA4: "macOS 13 Ventura 或更高版本，Apple Silicon 与 Intel 均可。",
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
