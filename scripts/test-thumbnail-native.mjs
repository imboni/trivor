import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { buildQuickLookWeb } from "./build-quicklook-web.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = process.argv.slice(2);
if (options.includes("--help")) {
  console.log("Usage: node scripts/test-thumbnail-native.mjs [--build-only] [--reuse-resources]\nBuilds a sandboxed, windowless renderer test app and an OS-provider test CLI.\nWithout --build-only, runs the renderer tests. The separate generator CLI needs the real extension registered.");
  process.exit(0);
}
if (process.platform !== "darwin") throw new Error("Thumbnail native tests require macOS.");
function run(command, args, input, timeout = 120_000) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", input, timeout, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${command}: ${result.error?.message ?? result.stderr}\n${result.stdout}`);
  return result.stdout.trim();
}
const staging = path.join(root, "src-tauri/.bundle");
const app = path.join(staging, "TrivorThumbnailNativeTests.app");
const resources = path.join(app, "Contents/Resources");
mkdirSync(path.join(app, "Contents/MacOS"), { recursive: true });
mkdirSync(resources, { recursive: true });
if (!options.includes("--reuse-resources") || !existsSync(path.join(resources, "web/thumbnail.js"))) {
  await buildQuickLookWeb({ root, outDir: path.join(resources, "web") });
  run("python3", ["-", path.join(resources, "fixtures")], `
import importlib.util,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('quicklook_test',Path('tests/browser-quicklook.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
module.fixtures(Path(sys.argv[1]))
`);
}
function plist(identifier, executable) {
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identifier}</string><key>CFBundleName</key><string>${executable}</string><key>CFBundleExecutable</key><string>${executable}</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string><key>LSMinimumSystemVersion</key><string>13.0</string><key>LSUIElement</key><true/></dict></plist>`;
}
writeFileSync(path.join(app, "Contents/Info.plist"), plist("com.imboni.trivor.thumbnail-native-tests", "TrivorThumbnailNativeTests"));
const baseArguments = ["swiftc", "-swift-version", "5", "-O", "-target", `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos13.0`,
  "-sdk", run("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"]), "-module-cache-path", path.join(staging, "swift-module-cache"),
  "-framework", "AppKit", "-framework", "WebKit", "-framework", "QuickLookThumbnailing"];
const native = ["native/PreviewDocument.swift", "native/PreviewTaskDelivery.swift", "native/PreviewSchemeHandler.swift",
  "thumbnail/ThumbnailImage.swift", "thumbnail/ThumbnailRenderer.swift", "thumbnail/Tests/ImageAssertions.swift", "thumbnail/Tests/main.swift"];
const binary = path.join(app, "Contents/MacOS/TrivorThumbnailNativeTests");
run("/usr/bin/xcrun", [...baseArguments, ...native.map(name => path.join(root, "quick-look", name)), "-o", binary]);
run("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", "--entitlements", path.join(root, "quick-look/Entitlements.plist"), app]);
run("/usr/bin/codesign", ["--verify", "--strict", app]);

const generatorApp = path.join(staging, "TrivorThumbnailGeneratorTests.app");
mkdirSync(path.join(generatorApp, "Contents/MacOS"), { recursive: true });
writeFileSync(path.join(generatorApp, "Contents/Info.plist"), plist("com.imboni.trivor.thumbnail-generator-tests", "TrivorThumbnailGeneratorTests"));
const generator = path.join(generatorApp, "Contents/MacOS/TrivorThumbnailGeneratorTests");
run("/usr/bin/xcrun", [...baseArguments, path.join(root, "quick-look/thumbnail/Tests/ImageAssertions.swift"),
  path.join(root, "quick-look/thumbnail/Tests/Generator/main.swift"), "-o", generator]);
// The OS-provider caller is a local diagnostic CLI, not the distributed extension.
run("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", generatorApp]);
console.log(`Built windowless native tests: ${binary}`);
console.log(`Built actual OS-provider check: ${generator} /path/model.glb [pixels] [scale] [output-directory]`);
if (!options.includes("--build-only")) console.log(run(binary, [], undefined, 240_000));
