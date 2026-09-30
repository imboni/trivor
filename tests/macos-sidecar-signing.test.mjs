import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareMacosSidecar } from "../scripts/prepare-macos-sidecar.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helperEntitlements = { "com.apple.security.app-sandbox": true, "com.apple.security.inherit": true };

function fixture(t, targets = ["aarch64-apple-darwin"]) {
  const root = mkdtempSync(path.join(os.tmpdir(), "trivor-signing-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "src-tauri", "bin"), { recursive: true });
  for (const filename of ["tauri.conf.json", "tauri.macos.conf.json", "Entitlements.plist", "Entitlements.sidecar.plist"]) {
    writeFileSync(path.join(root, "src-tauri", filename), readFileSync(path.join(projectRoot, "src-tauri", filename)));
  }
  for (const target of targets) writeFileSync(path.join(root, "src-tauri", "bin", `gltfpack-${target}`), target);
  const calls = [];
  const run = (command, args) => {
    calls.push({ command, args });
    return command.endsWith("plutil") ? JSON.stringify(helperEntitlements) : "";
  };
  return { root, calls, run };
}

test("macOS preserves the helper signature through files and keeps the main sandbox permissions", () => {
  const config = JSON.parse(readFileSync(path.join(projectRoot, "src-tauri", "tauri.macos.conf.json"), "utf8"));
  assert.deepEqual(config.bundle.externalBin, []);
  assert.equal(config.build.beforeBundleCommand, "node scripts/prepare-macos-sidecar.mjs");
  assert.equal(config.bundle.macOS.files["MacOS/gltfpack"], ".bundle/gltfpack");
  assert.equal(config.bundle.macOS.entitlements, "./Entitlements.plist");
  const helper = readFileSync(path.join(projectRoot, "src-tauri", "Entitlements.sidecar.plist"), "utf8");
  assert.deepEqual([...helper.matchAll(/<key>(.*?)<\/key>/g)].map((match) => match[1]), Object.keys(helperEntitlements));
  const main = readFileSync(path.join(projectRoot, "src-tauri", "Entitlements.plist"), "utf8");
  assert.match(main, /com\.apple\.security\.files\.user-selected\.read-write/);
  assert.match(main, /com\.apple\.security\.network\.client/);
  assert.doesNotMatch(main, /com\.apple\.security\.inherit/);
});

test("all macOS architectures select the correct source and sign only a generated copy", (t) => {
  const targets = ["aarch64-apple-darwin", "x86_64-apple-darwin", "universal-apple-darwin"];
  const h = fixture(t, targets);
  for (const target of targets) {
    const destination = prepareMacosSidecar({ ...h, env: { TAURI_ENV_TARGET_TRIPLE: target } });
    assert.equal(destination, path.join(h.root, "src-tauri", ".bundle", "gltfpack"));
    assert.equal(readFileSync(destination, "utf8"), target);
    assert.equal(statSync(destination).mode & 0o777, 0o755);
    assert.equal(readFileSync(path.join(h.root, "src-tauri", "bin", `gltfpack-${target}`), "utf8"), target);
  }
  for (const call of h.calls.filter((call) => call.args[0] === "--force")) {
    assert.equal(call.args[2], "-");
    assert.ok(call.args.includes("--timestamp=none"));
    assert.equal(call.args.some((arg) => arg.endsWith(".app")), false);
    assert.equal(call.args.includes("--deep"), false);
  }
});

test("Developer ID and hardened-runtime overrides are passed as literal argv", (t) => {
  const h = fixture(t);
  const identity = "Developer ID Application: Example Name (TEAM123)";
  prepareMacosSidecar({ ...h, env: {
    TAURI_ENV_TARGET_TRIPLE: "aarch64-apple-darwin", APPLE_SIGNING_IDENTITY: identity,
    TAURI_CONFIG: JSON.stringify({ bundle: { macOS: { hardenedRuntime: true } } }),
  } });
  assert.equal(h.calls[0].args[2], identity);
  assert.ok(h.calls[0].args.includes("--timestamp"));
  assert.ok(h.calls[0].args.includes("runtime"));
  assert.deepEqual(h.calls[1].args.slice(0, 2), ["--verify", "--strict"]);
});

test("missing architectures and failed signatures abort without publishing an unsigned helper", (t) => {
  const h = fixture(t);
  assert.throws(() => prepareMacosSidecar({ ...h, env: { TAURI_ENV_TARGET_TRIPLE: "x86_64-apple-darwin" } }), /Missing.*gltfpack/);
  assert.throws(() => prepareMacosSidecar({ ...h, env: { TAURI_ENV_TARGET_TRIPLE: "aarch64-apple-darwin" },
    run: () => { throw new Error("codesign failed"); },
  }), /codesign failed/);
  assert.equal(existsSync(path.join(h.root, "src-tauri", ".bundle", "gltfpack")), false);
});

test("helper entitlement verification rejects accidental main-app permissions", (t) => {
  const h = fixture(t);
  assert.throws(() => prepareMacosSidecar({ ...h, env: { TAURI_ENV_TARGET_TRIPLE: "aarch64-apple-darwin" },
    run: (command) => command.endsWith("plutil") ? JSON.stringify({ ...helperEntitlements, "com.apple.security.network.client": true }) : "",
  }), /exactly app-sandbox \+ inherit/);
});
