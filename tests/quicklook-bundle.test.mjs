import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { quickLookBuildSettings } from "../scripts/build-quicklook.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "trivor-quicklook-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "src-tauri"));
  for (const name of ["tauri.conf.json", "tauri.macos.conf.json"]) {
    writeFileSync(path.join(root, "src-tauri", name), readFileSync(new URL(`../src-tauri/${name}`, import.meta.url)));
  }
  return root;
}

test("Quick Look follows the app version, signing override and selected architectures", (t) => {
  const root = fixture(t);
  const identity = "Developer ID Application: Example (TEAM123)";
  const settings = quickLookBuildSettings(root, {
    TAURI_ENV_TARGET_TRIPLE: "universal-apple-darwin", APPLE_SIGNING_IDENTITY: identity,
    TAURI_CONFIG: JSON.stringify({ version: "1.2.3", identifier: "com.example.preview", bundle: { macOS: { hardenedRuntime: true } } }),
  });
  assert.equal(settings.identity, identity);
  assert.equal(settings.hardenedRuntime, true);
  assert.equal(settings.version, "1.2.3");
  assert.equal(settings.identifier, "com.example.preview");
  assert.deepEqual(settings.architectures, ["arm64", "x86_64"]);
  assert.deepEqual(quickLookBuildSettings(root, { TAURI_ENV_TARGET_TRIPLE: "aarch64-apple-darwin" }).architectures, ["arm64"]);
  assert.deepEqual(quickLookBuildSettings(root, { TAURI_ENV_TARGET_TRIPLE: "x86_64-apple-darwin" }).architectures, ["x86_64"]);
});

test("Quick Look refuses ambiguous build targets and unsafe plist substitutions", (t) => {
  const root = fixture(t);
  for (const target of [undefined, "__proto__", "arm64", "x86_64-unknown-linux-gnu"]) {
    assert.throws(() => quickLookBuildSettings(root, { TAURI_ENV_TARGET_TRIPLE: target }), /unsupported/);
  }
  for (const override of [{ version: "<string>bad" }, { identifier: "com.test</string>" }]) {
    assert.throws(() => quickLookBuildSettings(root, { TAURI_ENV_TARGET_TRIPLE: "aarch64-apple-darwin", TAURI_CONFIG: JSON.stringify(override) }), /Invalid/);
  }
  assert.throws(() => quickLookBuildSettings(root, { TAURI_ENV_TARGET_TRIPLE: "aarch64-apple-darwin", APPLE_SIGNING_IDENTITY: "" }), /signing identity/);
});

test("the extension is embedded separately with read-only sandbox permissions", () => {
  const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.macos.conf.json", import.meta.url), "utf8"));
  assert.equal(config.bundle.macOS.files["PlugIns/TrivorQuickLook.appex"], ".bundle/TrivorQuickLook.appex");
  assert.equal(config.bundle.macOS.files["PlugIns/TrivorThumbnail.appex"], ".bundle/TrivorThumbnail.appex");
  const entitlements = readFileSync(new URL("../quick-look/Entitlements.plist", import.meta.url), "utf8");
  assert.deepEqual([...entitlements.matchAll(/<key>(.*?)<\/key>/g)].map((match) => match[1]), [
    "com.apple.security.app-sandbox", "com.apple.security.files.user-selected.read-only", "com.apple.security.network.client",
  ]);
});
