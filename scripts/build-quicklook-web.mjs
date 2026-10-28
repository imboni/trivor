import { copyFileSync, cpSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Build the same model-viewer renderer as the app, with no CDN dependencies.
 * A classic IIFE avoids module-origin restrictions in WKURLSchemeHandler pages.
 */
export async function buildQuickLookWeb({ root = projectRoot, outDir } = {}) {
  const destination = outDir ?? path.join(root, "src-tauri/.bundle/quicklook-web");
  await build({
    configFile: false,
    root,
    publicDir: false,
    base: "./",
    build: {
      outDir: destination,
      emptyOutDir: true,
      target: "safari16",
      lib: {
        entry: path.join(root, "quick-look/web/main.ts"),
        name: "TrivorQuickLook",
        formats: ["iife"],
        fileName: () => "preview.js",
        cssFileName: "style",
      },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  });
  copyFileSync(path.join(root, "quick-look/web/index.html"), path.join(destination, "index.html"));
  await build({
    configFile: false,
    root,
    publicDir: false,
    base: "./",
    build: {
      outDir: destination,
      emptyOutDir: false,
      target: "safari16",
      lib: {
        entry: path.join(root, "quick-look/web/thumbnail.ts"),
        name: "TrivorThumbnail",
        formats: ["iife"],
        fileName: () => "thumbnail.js",
      },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  });
  copyFileSync(path.join(root, "quick-look/web/thumbnail.html"), path.join(destination, "thumbnail.html"));
  for (const name of ["meshopt", "basis"]) {
    cpSync(path.join(root, "public/decoders", name), path.join(destination, "decoders", name), { recursive: true });
  }
  const draco = path.join(destination, "decoders/draco");
  mkdirSync(draco, { recursive: true });
  for (const name of ["draco_decoder.js", "draco_decoder.wasm", "draco_wasm_wrapper.js"]) {
    copyFileSync(path.join(root, "node_modules/three/examples/jsm/libs/draco/gltf", name), path.join(draco, name));
  }
  copyFileSync(path.join(root, "node_modules/three/examples/jsm/libs/draco/README.md"), path.join(draco, "README.md"));
  // Draco and Basis both use the unmodified Apache-2.0 license text.
  copyFileSync(path.join(root, "public/decoders/basis/LICENSE"), path.join(draco, "LICENSE"));
  return destination;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await buildQuickLookWeb();
}
