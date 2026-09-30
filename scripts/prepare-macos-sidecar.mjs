import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const supportedTargets = new Set([
  "aarch64-apple-darwin", "x86_64-apple-darwin", "universal-apple-darwin",
]);

function checkedRun(command, args, input) {
  const result = spawnSync(command, args, { encoding: "utf8", input });
  if (result.error || result.status !== 0) {
    throw new Error(`${path.basename(command)} failed: ${result.error?.message ?? result.stderr.trim()}`);
  }
  return result.stdout;
}

/** Tauri 2.11 applies the app's entitlements to every externalBin. Pre-sign a
 * separate copy and bundle it through macOS.files, which preserves its signature.
 * No source sidecar or already-built .app is modified by this hook.
 */
export function prepareMacosSidecar({ root = projectRoot, env = process.env, run = checkedRun } = {}) {
  const target = env.TAURI_ENV_TARGET_TRIPLE;
  if (!supportedTargets.has(target)) {
    throw new Error(`Missing or unsupported TAURI_ENV_TARGET_TRIPLE: ${target ?? "(unset)"}`);
  }
  const tauriDir = path.join(root, "src-tauri");
  const config = JSON.parse(readFileSync(path.join(tauriDir, "tauri.conf.json"), "utf8"));
  const platform = JSON.parse(readFileSync(path.join(tauriDir, "tauri.macos.conf.json"), "utf8"));
  const override = JSON.parse(env.TAURI_CONFIG || "{}");
  const macos = {
    ...config.bundle?.macOS, ...platform.bundle?.macOS, ...override.bundle?.macOS,
  };
  const identity = env.APPLE_SIGNING_IDENTITY ?? macos.signingIdentity;
  if (typeof identity !== "string" || !identity.trim()) {
    throw new Error("Set APPLE_SIGNING_IDENTITY (or bundle.macOS.signingIdentity) before bundling the sandboxed helper.");
  }
  const source = path.join(tauriDir, "bin", `gltfpack-${target}`);
  if (!statSync(source, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Missing ${source}; run bash scripts/fetch-gltfpack.sh first.`);
  }
  const staging = path.join(tauriDir, ".bundle");
  mkdirSync(staging, { recursive: true });
  const temporary = mkdtempSync(path.join(staging, "gltfpack-"));
  const candidate = path.join(temporary, "gltfpack");
  const destination = path.join(staging, "gltfpack");
  try {
    copyFileSync(source, candidate);
    chmodSync(candidate, 0o755);
    const args = [
      "--force", "--sign", identity,
      "--entitlements", path.join(tauriDir, "Entitlements.sidecar.plist"),
      identity === "-" ? "--timestamp=none" : "--timestamp",
    ];
    if (macos.hardenedRuntime !== false) args.push("--options", "runtime");
    run("/usr/bin/codesign", [...args, candidate]);
    run("/usr/bin/codesign", ["--verify", "--strict", candidate]);
    const plist = run("/usr/bin/codesign", ["--display", "--entitlements", ":-", candidate]);
    const entitlements = JSON.parse(run("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], plist));
    const required = ["com.apple.security.app-sandbox", "com.apple.security.inherit"];
    if (Object.keys(entitlements).length !== required.length || required.some((key) => entitlements[key] !== true)) {
      throw new Error("gltfpack must have exactly app-sandbox + inherit entitlements; refusing to bundle it.");
    }
    renameSync(candidate, destination);
    return destination;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const destination = prepareMacosSidecar();
    console.log(`Prepared sandbox-inheriting gltfpack: ${destination}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
