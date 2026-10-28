import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { buildQuickLookWeb } from "./build-quicklook-web.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const architectures = {
  "aarch64-apple-darwin": ["arm64"],
  "x86_64-apple-darwin": ["x86_64"],
  "universal-apple-darwin": ["arm64", "x86_64"],
};

function run(command, args, input) {
  const result = spawnSync(command, args, { encoding: "utf8", input });
  if (result.error || result.status !== 0) {
    throw new Error(`${path.basename(command)} failed: ${result.error?.message ?? result.stderr.trim()}`);
  }
  return result.stdout;
}

function xml(value) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]);
}

export function quickLookBuildSettings(root = projectRoot, env = process.env) {
  const target = env.TAURI_ENV_TARGET_TRIPLE;
  if (!Object.hasOwn(architectures, target ?? "")) {
    throw new Error(`Missing or unsupported TAURI_ENV_TARGET_TRIPLE: ${target ?? "(unset)"}`);
  }
  const config = JSON.parse(readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"));
  const platform = JSON.parse(readFileSync(path.join(root, "src-tauri/tauri.macos.conf.json"), "utf8"));
  const override = JSON.parse(env.TAURI_CONFIG || "{}");
  const macos = { ...config.bundle?.macOS, ...platform.bundle?.macOS, ...override.bundle?.macOS };
  const identity = env.APPLE_SIGNING_IDENTITY ?? macos.signingIdentity;
  if (typeof identity !== "string" || !identity.trim()) throw new Error("Quick Look requires a signing identity (use '-' for a local ad-hoc build).");
  const version = override.version ?? config.version;
  const identifier = override.identifier ?? config.identifier;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(version)) throw new Error("Invalid app version for Quick Look.");
  if (typeof identifier !== "string" || !/^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+$/.test(identifier)) throw new Error("Invalid app identifier for Quick Look.");
  return { target, architectures: architectures[target], identity, version, identifier, hardenedRuntime: macos.hardenedRuntime !== false };
}

/** Build a real .appex with the CLT SDK. No Xcode project or developer cert is
 * required for local builds; the release signing identity is shared with the app.
 */
export async function buildQuickLook({ root = projectRoot, env = process.env, kind = "preview" } = {}) {
  if (!["preview", "thumbnail"].includes(kind)) throw new Error("Unknown Quick Look extension kind.");
  const thumbnail = kind === "thumbnail";
  const name = thumbnail ? "TrivorThumbnail" : "TrivorQuickLook";
  const settings = quickLookBuildSettings(root, env);
  run(process.execPath, [path.join(root, "node_modules/typescript/bin/tsc"), "-p", path.join(root, "quick-look/tsconfig.json")]);
  const staging = path.join(root, "src-tauri/.bundle");
  mkdirSync(staging, { recursive: true });
  const temporary = mkdtempSync(path.join(staging, "quicklook-"));
  const candidate = path.join(temporary, `${name}.appex`);
  const destination = path.join(staging, `${name}.appex`);
  try {
    const contents = path.join(candidate, "Contents");
    const macos = path.join(contents, "MacOS");
    mkdirSync(macos, { recursive: true });
    const resourceDir = path.join(contents, "Resources");
    mkdirSync(resourceDir, { recursive: true });
    await buildQuickLookWeb({ root, outDir: path.join(resourceDir, "web") });
    const template = readFileSync(path.join(root, thumbnail ? "quick-look/ThumbnailInfo.plist" : "quick-look/Info.plist"), "utf8");
    writeFileSync(path.join(contents, "Info.plist"), template.replaceAll("__VERSION__", xml(settings.version)).replaceAll("__IDENTIFIER__", xml(settings.identifier)));
    writeFileSync(path.join(contents, "PkgInfo"), "XPC!????");
    const sdk = run("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"]).trim();
    const sourceDir = path.join(root, "quick-look/native");
    const sources = readdirSync(sourceDir).filter((name) => name.endsWith(".swift") && (!thumbnail || name !== "PreviewViewController.swift")).sort().map((name) => path.join(sourceDir, name));
    if (thumbnail) {
      const thumbnailDir = path.join(root, "quick-look/thumbnail");
      sources.push(...readdirSync(thumbnailDir).filter((name) => name.endsWith(".swift")).sort().map((name) => path.join(thumbnailDir, name)));
    }
    if (!sources.length) throw new Error("No Quick Look Swift sources found.");
    const binaries = [];
    for (const architecture of settings.architectures) {
      const binary = path.join(temporary, `${name}-${architecture}`);
      run("/usr/bin/xcrun", ["swiftc", "-swift-version", "5", "-O", "-whole-module-optimization", "-parse-as-library",
        "-application-extension", "-module-name", name, "-target", `${architecture}-apple-macos13.0`,
        "-sdk", sdk, "-module-cache-path", path.join(staging, "swift-module-cache"),
        "-framework", "AppKit", "-framework", "QuickLookUI", "-framework", "WebKit", "-framework", "Metal",
        ...(thumbnail ? ["-framework", "QuickLookThumbnailing", "-framework", "ImageIO"] : []),
        "-Xlinker", "-e", "-Xlinker", "_NSExtensionMain",
        "-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks",
        ...sources, "-o", binary]);
      binaries.push(binary);
    }
    const executable = path.join(macos, name);
    if (binaries.length > 1) run("/usr/bin/lipo", ["-create", ...binaries, "-output", executable]);
    else cpSync(binaries[0], executable);
    const sign = ["--force", "--sign", settings.identity, "--entitlements", path.join(root, "quick-look/Entitlements.plist"),
      settings.identity === "-" ? "--timestamp=none" : "--timestamp"];
    if (settings.hardenedRuntime) sign.push("--options", "runtime");
    run("/usr/bin/codesign", [...sign, candidate]);
    run("/usr/bin/codesign", ["--verify", "--strict", candidate]);
    const actual = JSON.parse(run("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"],
      run("/usr/bin/codesign", ["--display", "--entitlements", ":-", candidate])));
    const expected = ["com.apple.security.app-sandbox", "com.apple.security.files.user-selected.read-only", "com.apple.security.network.client"];
    if (Object.keys(actual).length !== expected.length || expected.some((key) => actual[key] !== true)) {
      throw new Error("Quick Look must have App Sandbox, user-selected read-only file access and the WebKit client entitlement.");
    }
    rmSync(destination, { recursive: true, force: true });
    renameSync(candidate, destination);
    return destination;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    console.log(`Prepared Quick Look extension: ${await buildQuickLook()}`);
    console.log(`Prepared thumbnail extension: ${await buildQuickLook({ kind: "thumbnail" })}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
