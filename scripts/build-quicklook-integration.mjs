import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { buildQuickLookWeb } from "./build-quicklook-web.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "darwin") throw new Error("Native Quick Look integration checks require macOS.");
function run(command, args, input) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", input });
  if (result.error || result.status !== 0) throw new Error(`${command}: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
}
const staging = path.join(root, "src-tauri/.bundle");
const app = path.join(staging, "TrivorQuickLookIntegration.app");
const contents = path.join(app, "Contents");
const resources = path.join(contents, "Resources");
mkdirSync(path.join(contents, "MacOS"), { recursive: true });
mkdirSync(resources, { recursive: true });
await buildQuickLookWeb({ root, outDir: path.join(resources, "web") });
run("python3", ["-", path.join(resources, "fixtures")], `
import importlib.util,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('quicklook_test',Path('tests/browser-quicklook.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
module.fixtures(Path(sys.argv[1]))
`);
writeFileSync(path.join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.imboni.trivor.quicklook-integration</string>
<key>CFBundleName</key><string>TrivorQuickLookIntegration</string>
<key>CFBundleExecutable</key><string>TrivorQuickLookIntegration</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>`);
const native = path.join(root, "quick-look/native");
// Use the production preview controller and its support classes unchanged.
const sources = ["PreviewDocument.swift", "PreviewEnvironment.swift", "PreviewTaskDelivery.swift", "PreviewSchemeHandler.swift", "PreviewViewController.swift", "IntegrationTests/main.swift"].map((name) => path.join(native, name));
run("/usr/bin/xcrun", ["swiftc", "-swift-version", "5", "-O", "-target", `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos13.0`,
  "-sdk", run("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"]), "-module-cache-path", path.join(staging, "swift-module-cache"),
  "-framework", "AppKit", "-framework", "QuickLookUI", "-framework", "WebKit", "-framework", "Metal", ...sources,
  "-o", path.join(contents, "MacOS/TrivorQuickLookIntegration")]);
run("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", "--entitlements", path.join(root, "quick-look/Entitlements.plist"), app]);
run("/usr/bin/codesign", ["--verify", "--strict", app]);
console.log(`Built ${app}`);
console.log("Launch this app through the native UI. It runs the unchanged preview controller and writes result.json to its sandbox Caches/TrivorQuickLookIntegration directory.");
