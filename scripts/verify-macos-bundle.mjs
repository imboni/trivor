import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function run(command, args, input) {
  const result = spawnSync(command, args, { encoding: "utf8", input });
  if (result.error || result.status !== 0) throw new Error(`${path.basename(command)}: ${result.error?.message ?? result.stderr.trim()}`);
  return result.stdout;
}
function plist(file) {
  return JSON.parse(run("/usr/bin/plutil", ["-convert", "json", "-o", "-", file]));
}
function requireValue(condition, message) { if (!condition) throw new Error(message); }

const app = process.argv[2];
const expectedArchitectures = process.argv.slice(3).sort();
if (!app || !expectedArchitectures.length) throw new Error("Usage: node scripts/verify-macos-bundle.mjs /path/Trivor.app arm64 [x86_64]");
const contents = path.join(app, "Contents");
const info = plist(path.join(contents, "Info.plist"));
const extensions = [
  ["TrivorQuickLook", "quicklook", "preview", "PreviewViewController", "index.html", "preview.js"],
  ["TrivorThumbnail", "thumbnail", "thumbnail", "ThumbnailProvider", "thumbnail.html", "thumbnail.js"],
].map(([name, suffix, point, principal, html, script]) => {
  const bundle = path.join(contents, `PlugIns/${name}.appex`);
  const metadata = plist(path.join(bundle, "Contents/Info.plist"));
  requireValue(metadata.CFBundleIdentifier === `${info.CFBundleIdentifier}.${suffix}`, `${name} bundle ID does not belong to the main app.`);
  for (const key of ["CFBundleShortVersionString", "CFBundleVersion"]) requireValue(info[key] === metadata[key], `${name} ${key} differs from the app.`);
  requireValue(metadata.NSExtension?.NSExtensionPointIdentifier === `com.apple.quicklook.${point}`, `Missing ${name} extension point.`);
  requireValue(metadata.NSExtension?.NSExtensionPrincipalClass === principal, `Incorrect ${name} principal class.`);
  requireValue(metadata.NSExtension?.NSExtensionAttributes?.QLSupportedContentTypes?.includes("org.khronos.glb"), `Missing ${name} GLB association.`);
  const web = path.join(bundle, "Contents/Resources/web");
  if (point === "preview") requireValue(existsSync(path.join(web, "style.css")), "Missing preview stylesheet.");
  for (const resource of [html, script, "decoders/meshopt/meshopt_decoder.js", "decoders/basis/basis_transcoder.js", "decoders/basis/basis_transcoder.wasm", "decoders/draco/draco_wasm_wrapper.js", "decoders/draco/draco_decoder.wasm"]) {
    requireValue(existsSync(path.join(web, resource)), `Missing ${name} resource: ${resource}`);
  }
  requireValue(!readFileSync(path.join(web, html), "utf8").includes('src="https:'), `${name} HTML loads a remote script.`);
  return { bundle, executable: path.join(bundle, "Contents/MacOS", metadata.CFBundleExecutable) };
});
run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
for (const binary of [path.join(contents, "MacOS", info.CFBundleExecutable), path.join(contents, "MacOS/gltfpack"), ...extensions.map((extension) => extension.executable)]) {
  const actual = run("/usr/bin/lipo", ["-archs", binary]).trim().split(/\s+/).sort();
  requireValue(JSON.stringify(actual) === JSON.stringify(expectedArchitectures), `Unexpected architectures in ${binary}: ${actual.join(", ")}`);
}
for (const [bundle, keys] of [
  [app, ["com.apple.security.app-sandbox", "com.apple.security.files.user-selected.read-write", "com.apple.security.network.client"]],
  [path.join(contents, "MacOS/gltfpack"), ["com.apple.security.app-sandbox", "com.apple.security.inherit"]],
  ...extensions.map(({ bundle }) => [bundle, ["com.apple.security.app-sandbox", "com.apple.security.files.user-selected.read-only", "com.apple.security.network.client"]]),
]) {
  const actual = JSON.parse(run("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], run("/usr/bin/codesign", ["--display", "--entitlements", ":-", bundle])));
  requireValue(Object.keys(actual).length === keys.length && keys.every((key) => actual[key] === true), `Unexpected sandbox permissions: ${bundle}`);
}
console.log(`Verified Trivor ${info.CFBundleShortVersionString}, preview, thumbnail, helper, offline resources and sandbox signatures (${expectedArchitectures.join(" + ")}).`);
