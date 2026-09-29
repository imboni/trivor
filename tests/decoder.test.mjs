import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

test("configured local meshopt script exists and decodes compressed glTF indices", async () => {
  const source = readFileSync(new URL("../src/model-viewer-decoders.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const context = vm.createContext({ exports: {} });
  vm.runInContext(code, context);
  const location = context.ModelViewerElement.meshoptDecoderLocation;
  assert.ok(location.startsWith("/decoders/"));
  assert.ok(location.endsWith(".js"), "model-viewer expects a script URL, not a directory");
  const script = readFileSync(new URL(`../public${location}`, import.meta.url), "utf8");
  vm.runInContext(script, context);
  const decoder = context.MeshoptDecoder;
  assert.equal(decoder.supported, true);
  await decoder.ready;
  const encoded = new Uint8Array([
    0xe0, 0xf0, 0x10, 0xfe, 0xff, 0xf0, 0x0c, 0xff, 0x02, 0x02, 0x02, 0x00,
    0x76, 0x87, 0x56, 0x67, 0x78, 0xa9, 0x86, 0x65, 0x89, 0x68, 0x98, 0x01, 0x69, 0x00, 0x00,
  ]);
  const decoded = new Uint16Array(12);
  decoder.decodeGltfBuffer(new Uint8Array(decoded.buffer), 12, 2, encoded, "TRIANGLES");
  assert.deepEqual(Array.from(decoded), [0, 1, 2, 2, 1, 3, 4, 6, 5, 7, 8, 9]);
});
