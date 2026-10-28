import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "darwin") throw new Error("Thumbnail queue checks require macOS Command Line Tools.");
const temporary = mkdtempSync(path.join(os.tmpdir(), "trivor-thumbnail-queue-"));
const cache = path.join(root, "src-tauri/.bundle/swift-module-cache");
mkdirSync(cache, { recursive: true });
function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`${command} failed (${result.status}).`);
}
try {
  const binary = path.join(temporary, "queue-tests");
  run("/usr/bin/xcrun", ["swiftc", "-swift-version", "5", "-target", `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos13.0`,
    "-module-cache-path", cache, "-framework", "CoreGraphics",
    ...["quick-look/native/PreviewDocument.swift", "quick-look/thumbnail/ThumbnailQueue.swift", "quick-look/thumbnail/QueueTests/main.swift"].map((file) => path.join(root, file)),
    "-o", binary]);
  run(binary, []);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
