import { prepareMacosSidecar } from "./prepare-macos-sidecar.mjs";
import { buildQuickLook } from "./build-quicklook.mjs";

try {
  console.log(`Prepared sandbox-inheriting gltfpack: ${prepareMacosSidecar()}`);
  console.log(`Prepared Quick Look extension: ${await buildQuickLook()}`);
  console.log(`Prepared thumbnail extension: ${await buildQuickLook({ kind: "thumbnail" })}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
