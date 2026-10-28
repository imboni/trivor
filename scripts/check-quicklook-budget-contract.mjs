import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// Compare values emitted by the compiled native policy with the actual browser
// validator. This detects bridge drift without maintaining a third tier table.
export function verifyNativeBudgetProfiles(profiles) {
  const source = readFileSync(new URL("../quick-look/web/glb-guard.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, TextDecoder, atob });
  const plain = (value) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(profiles.preview.map(({ tier }) => tier), ["standard", "expanded", "large", "maximum"]);
  for (const profile of profiles.preview) {
    const accepted = exports.resolvePreviewBudget(profile);
    assert.deepEqual(plain(accepted), profile, `native ${profile.tier} must survive the browser bridge unchanged`);
    assert(Object.isFrozen(accepted) && Object.isFrozen(accepted.limits), "request budgets must be immutable");
  }
  assert.deepEqual(profiles.preview[0].limits, plain(exports.PREVIEW_LIMITS), "standard fallback must match native");
  assert.deepEqual(profiles.preview[3].limits, plain(exports.MAX_PREVIEW_LIMITS), "absolute caps must match native");
  assert.deepEqual(profiles.thumbnail, plain(exports.THUMBNAIL_LIMITS), "thumbnail budgets must match native");
  // GPU-constrained caps must also survive; falling back would raise the limits.
  const constrained = structuredClone(profiles.preview[0]);
  constrained.limits.geometry = constrained.limits.textures = constrained.limits.decoded = 64 * 1024 * 1024;
  assert.deepEqual(plain(exports.resolvePreviewBudget(constrained)), constrained);
  console.log("Native/browser budget contract passed for all four tiers, GPU clamping and thumbnails.");
}
