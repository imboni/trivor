const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const THREE = require('three');

class ImageData {
  constructor(dataOrWidth, widthOrHeight, height) {
    if (typeof dataOrWidth === 'number') {
      this.width = dataOrWidth;
      this.height = widthOrHeight;
      this.data = new Uint8ClampedArray(this.width * this.height * 4);
    } else {
      this.data = dataOrWidth;
      this.width = widthOrHeight;
      this.height = height;
    }
  }
}

// Execute the real TypeScript modules with only browser/WebGL boundaries replaced.
// Run with: node --test tests/cutout.test.cjs
function loadModule(name, imports = {}, globals = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', name + '.ts'), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  const run = vm.runInNewContext('(function(require, exports) {' + code + '\n})', {
    ImageData, Uint8Array, Uint8ClampedArray, Blob, ...globals,
  });
  run((id) => {
    if (id in imports) return imports[id];
    if (id === 'three') return THREE;
    throw new Error('Unexpected import: ' + id);
  }, exports);
  return exports;
}

function captureHarness({ failRender = false } = {}) {
  const camera = new THREE.PerspectiveCamera(45, 10 / 6, 0.1, 100);
  camera.position.set(1, 2, 3);
  camera.layers.enable(1);
  const background = new THREE.Color('#345678');
  const scene = {
    width: 10, height: 6, scaleStep: 0, background,
    shadowIntensity: 0.7, exposure: 1, toneMapping: THREE.NeutralToneMapping,
    getCamera: () => camera,
    setShadowIntensity(value) { this.shadowIntensity = value; },
    queueRender() {}, renderShadow() {},
  };
  const viewport = new THREE.Vector4(1, 2, 3, 4);
  const scissor = new THREE.Vector4(5, 6, 7, 8);
  const originalTarget = { name: 'original' };
  const renderer = {
    capabilities: { maxTextureSize: 4 },
    xr: { enabled: true },
    autoClear: false, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 3,
    target: originalTarget, color: new THREE.Color('#abcdef'), alpha: 0.6,
    viewport: viewport.clone(), scissor: scissor.clone(), scissorTest: true,
    getContext: () => ({ isContextLost: () => false, MAX_RENDERBUFFER_SIZE: 1, getParameter: () => 4 }),
    getRenderTarget() { return this.target; },
    getActiveCubeFace: () => 2, getActiveMipmapLevel: () => 1,
    setRenderTarget(target, face, level) { this.target = target; this.face = face; this.level = level; },
    getViewport(out) { return out.copy(this.viewport); },
    setViewport(value) { this.viewport.copy(value); },
    getScissor(out) { return out.copy(this.scissor); },
    setScissor(value) { this.scissor.copy(value); },
    getScissorTest() { return this.scissorTest; },
    setScissorTest(value) { this.scissorTest = value; },
    getClearColor(out) { return out.copy(this.color); },
    getClearAlpha() { return this.alpha; },
    setClearColor(value, alpha) { this.color.set(value); this.alpha = alpha; },
    clear() {},
    render(capturedScene, capturedCamera) {
      assert.equal(capturedScene.background, null);
      assert.equal(capturedScene.shadowIntensity, 0);
      assert.equal(capturedCamera.layers.mask & (1 << 1), 0);
      assert.equal(camera.layers.mask & (1 << 1), 2);
      assert.notEqual(capturedCamera, camera);
      if (failRender) throw new Error('render failed');
    },
    readRenderTargetPixels(target, x, y, width, height, bytes) {
      for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
          bytes.set([row + 1, col + 1, 123, 255], (row * width + col) * 4);
        }
      }
    },
  };
  class OutputPass {
    constructor() { this.material = { fragmentShader: 'gl_FragColor = texture2D( tDiffuse, vUv );' }; }
    render(renderer, target) { renderer.setRenderTarget(target); }
    dispose() {}
  }
  const exportModule = loadModule('cutout-export', { './cutout-display-capture': {} });
  const capture = loadModule('cutout-display-capture', {
    'three/addons/postprocessing/OutputPass.js': { OutputPass },
    './cutout-export': exportModule,
    './scene-guides': { SCENE_GUIDE_RENDER_LAYER: 1 },
    './model-scene-access': {
      getModelScene: () => scene,
      getModelRenderer: () => ({ threeRenderer: renderer, dpr: 1 }),
    },
  });
  const host = { loaded: true, getAttribute: () => null };
  return { capture, renderer, scene, camera, host, background, originalTarget, viewport, scissor };
}

function checkRestored(h) {
  assert.equal(h.scene.background, h.background);
  assert.equal(h.scene.shadowIntensity, 0.7);
  assert.equal(h.renderer.target, h.originalTarget);
  assert.equal(h.renderer.face, 2);
  assert.equal(h.renderer.level, 1);
  assert.equal(h.renderer.autoClear, false);
  assert.equal(h.renderer.toneMapping, THREE.ACESFilmicToneMapping);
  assert.equal(h.renderer.toneMappingExposure, 3);
  assert.equal(h.renderer.xr.enabled, true);
  assert.equal(h.renderer.alpha, 0.6);
  assert.equal(h.renderer.color.getHexString(), 'abcdef');
  assert.deepEqual(h.renderer.viewport.toArray(), h.viewport.toArray());
  assert.deepEqual(h.renderer.scissor.toArray(), h.scissor.toArray());
  assert.equal(h.renderer.scissorTest, true);
  assert.equal(h.camera.layers.mask, 3);
}

test('frame measurement does not deadlock subsequent captures', { timeout: 2000 }, async () => {
  const h = captureHarness();
  const bounds = await h.capture.measureCutoutFrameBounds(h.host);
  assert.equal(bounds.frameWidth, 10);
  assert.equal(bounds.frameHeight, 6);
  assert.equal(bounds.maxX, 9);
  const image = await h.capture.captureCutoutFrameOffscreen(h.host);
  assert.equal(image.width, 10);
  assert.equal(image.height, 6);
  checkRestored(h);
});

test('tiled readback flips each tile and joins edge tiles without altering aspect', async () => {
  const h = captureHarness();
  const image = await h.capture.captureCutoutFrameOffscreen(h.host);
  const pixel = (x, y) => [...image.data.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)];
  assert.deepEqual(pixel(0, 0), [4, 1, 123, 255]);
  assert.deepEqual(pixel(3, 3), [1, 4, 123, 255]);
  assert.deepEqual(pixel(8, 4), [2, 1, 123, 255]);
  assert.deepEqual(pixel(9, 5), [1, 2, 123, 255]);
  checkRestored(h);
});

test('capture failure restores live scene/renderer and does not poison the queue', async () => {
  const h = captureHarness({ failRender: true });
  await assert.rejects(h.capture.captureCutoutFrameOffscreen(h.host), /render failed/);
  checkRestored(h);
  h.renderer.render = () => {};
  assert.equal((await h.capture.captureCutoutFrameOffscreen(h.host)).width, 10);
  checkRestored(h);
});

test('oversized/invalid captures fail explicitly instead of independently clamping axes', async () => {
  const h = captureHarness();
  for (const renderScale of [820, Infinity, NaN]) {
    await assert.rejects(h.capture.captureCutoutFrameOffscreen(h.host, { renderScale }),
      (error) => error.code === 'too_large');
  }
  const resized = await h.capture.captureCutoutFrameOffscreen(h.host, { renderScale: 0.5 });
  assert.equal(resized.width, 5);
  assert.equal(resized.height, 3);
});

function exportHarness({ blobFails = false } = {}) {
  const captures = [];
  const draws = [];
  const encoded = [];
  const api = loadModule('cutout-export', {
    './cutout-display-capture': {
      async captureCutoutFrameOffscreen(host, options) {
        captures.push(options);
        const image = new ImageData(20, 40);
        for (let y = 5; y < 35; y++) {
          for (let x = 5; x < 15; x++) image.data[(y * 20 + x) * 4 + 3] = 255;
        }
        return image;
      },
    },
  }, {
    document: {
      createElement() {
        return {
          width: 0, height: 0,
          getContext: () => ({ putImageData() {}, drawImage(...args) { draws.push(args); } }),
          toBlob(callback) {
            encoded.push({ width: this.width, height: this.height });
            callback({ arrayBuffer: () => blobFails ? Promise.reject(new Error('encode failed')) : Promise.resolve(new ArrayBuffer(4)) });
          },
        };
      },
    },
  });
  return { api, captures, draws, encoded };
}

test('2048 and 4096 exports use final 16px padding, a cropped camera region and real 2x sampling', async () => {
  for (const maxLongEdge of [2048, 4096]) {
    for (const superSampling of [1, 2]) {
      const h = exportHarness();
      await h.api.exportCutoutPng({ mv: {}, options: { maxLongEdge, superSampling } });
      assert.equal(h.encoded[0].height, maxLongEdge);
      assert.equal(h.encoded[0].width, Math.round((maxLongEdge - 32) / 3) + 32);
      assert.equal(h.draws[0][5], 16);
      assert.equal(h.draws[0][6], 16);
      assert.equal(h.draws[0][8], maxLongEdge - 32);
      assert.equal(h.captures[1].region.width, 12);
      assert.equal(h.captures[1].region.height, 32);
      assert.equal(h.captures[1].renderScale, (maxLongEdge - 32) / 32 * superSampling);
    }
  }
});

test('PNG byte conversion rejects an encoding failure instead of leaving export busy', async () => {
  const h = exportHarness({ blobFails: true });
  await assert.rejects(h.api.exportCutoutPng({ mv: {} }), /encode failed/);
});

test('unavailable persistence does not prevent selecting export settings', () => {
  const h = loadModule('cutout-options', {}, {
    localStorage: { getItem() { throw new Error('unavailable'); }, setItem() { throw new Error('quota'); } },
  });
  assert.equal(h.loadCutoutUserOptions().maxLongEdge, 2048);
  assert.doesNotThrow(() => h.saveCutoutUserOptions({ maxLongEdge: 4096, superSampling: 2 }));
});
