import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verifyNativeBudgetProfiles } from "./check-quicklook-budget-contract.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "darwin") throw new Error("Quick Look native checks require macOS Command Line Tools.");
const temporary = mkdtempSync(path.join(os.tmpdir(), "trivor-quicklook-tests-"));
const cache = path.join(root, "src-tauri/.bundle/swift-module-cache");
mkdirSync(cache, { recursive: true });
try {
  const binary = path.join(temporary, "validation");
  const sources = ["PreviewDocument.swift", "PreviewEnvironment.swift", "PreviewTaskDelivery.swift", "Tests/main.swift"];
  const build = spawnSync("/usr/bin/xcrun", ["swiftc", "-swift-version", "5", "-target", `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos13.0`,
    "-module-cache-path", cache, "-framework", "Metal", ...sources.map((name) => path.join(root, "quick-look/native", name)), "-o", binary], { stdio: "inherit" });
  if (build.error || build.status !== 0) throw build.error ?? new Error("Native Quick Look test compilation failed.");
  if (process.argv.length === 2) {
    const profiles = spawnSync(binary, ["--print-budget-profiles"], { encoding: "utf8" });
    if (profiles.error || profiles.status !== 0) throw profiles.error ?? new Error("Could not read native budget profiles.");
    await verifyNativeBudgetProfiles(JSON.parse(profiles.stdout));
    console.log("Quick Look native/JavaScript budget contract passed");
  }
  const result = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" });
  if (result.error || result.status !== 0) throw result.error ?? new Error("Native Quick Look checks failed.");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
