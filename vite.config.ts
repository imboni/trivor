import { defineConfig, type Plugin } from "vite";

const host = process.env.TAURI_DEV_HOST;

const LATIN_UNICODE_RANGE =
  "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";

const LATIN_EXT_UNICODE_RANGE =
  "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF";

function fontsourceSubsetRange(id: string): string | undefined {
  if (id.includes("/latin-ext-") || id.endsWith("/latin-ext.css")) {
    return LATIN_EXT_UNICODE_RANGE;
  }
  if (id.includes("/latin-") || id.endsWith("/latin.css")) {
    return LATIN_UNICODE_RANGE;
  }
  return undefined;
}

/** macOS WebView supports woff2; align fontsource subset imports with unicode-range. */
function optimizeFontsource(): Plugin {
  return {
    name: "optimize-fontsource",
    enforce: "pre",
    transform(code, id) {
      if (!id.includes("@fontsource") || !id.endsWith(".css")) return;

      let next = code.replace(
        /,\s*url\([^)]+\.woff\)\s*format\(\s*["']woff["']\s*\)/g,
        "",
      );

      const range = fontsourceSubsetRange(id);
      if (range && !next.includes("unicode-range:")) {
        next = next.replace(
          /(\n\s*font-weight:[^;]+;)(\n\s*src:)/,
          `$1\n  unicode-range: ${range};$2`,
        );
      }

      return next === code ? undefined : next;
    },
  };
}

export default defineConfig({
  clearScreen: false,
  plugins: [optimizeFontsource()],
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: ["es2022", "chrome105", "safari13"],
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
});
