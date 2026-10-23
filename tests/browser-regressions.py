"""Real WebGL smoke tests with a mocked native IPC boundary.

Run with Vite listening on 1420:
  python3 tests/browser-regressions.py
Requires Python Playwright and an installed Chromium browser. Native conversion
and save-dialog behavior are covered separately by the Rust tests.
"""
import argparse
import base64
import json
import os
from pathlib import Path
import re
import struct
import tempfile

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get("TRIVOR_TEST_URL", "http://127.0.0.1:1420")


def ui_bundle():
    source = (ROOT / "crates/i18n/src/lib.rs").read_text()
    messages = {
        key: json.loads(value)
        for key, value in re.findall(
            r'\(_, MessageKey::(\w+)\)\s*=>\s*(?:\{\s*)?("(?:[^"\\]|\\.)*")', source
        )
    }
    bundle = {
        key: messages[message]
        for key, message in re.findall(r'(\w+): t\(MessageKey::(\w+)\)', source)
    }
    bundle.update(locale="en", locale_pref="en", theme="dark", theme_pref="system", window_title="Trivor")
    return bundle


def cube_glb():
    # Non-square silhouette and a colored PBR material exercise crop/aspect/color.
    positions = [(-1, -0.6, -0.4), (1, -0.6, -0.4), (1, 0.6, -0.4), (-1, 0.6, -0.4),
                 (-1, -0.6, 0.4), (1, -0.6, 0.4), (1, 0.6, 0.4), (-1, 0.6, 0.4)]
    indices = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
               3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5]
    data = struct.pack('<24f', *[v for p in positions for v in p]) + struct.pack('<36H', *indices)
    doc = {"asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [0]}],
           "nodes": [{"mesh": 0}], "meshes": [{"primitives": [{"attributes": {"POSITION": 0}, "indices": 1, "material": 0}]}],
           "materials": [{"pbrMetallicRoughness": {"baseColorFactor": [0.7, 0.2, 0.1, 1], "metallicFactor": 0, "roughnessFactor": 0.7}}],
           "buffers": [{"byteLength": len(data)}], "bufferViews": [{"buffer": 0, "byteLength": 96}, {"buffer": 0, "byteOffset": 96, "byteLength": 72}],
           "accessors": [{"bufferView": 0, "componentType": 5126, "count": 8, "type": "VEC3", "min": [-1, -.6, -.4], "max": [1, .6, .4]},
                         {"bufferView": 1, "componentType": 5123, "count": 36, "type": "SCALAR"}]}
    encoded = json.dumps(doc).encode()
    encoded += b' ' * (-len(encoded) % 4)
    return struct.pack('<III', 0x46546C67, 2, 28 + len(encoded) + len(data)) + struct.pack('<II', len(encoded), 0x4E4F534A) + encoded + struct.pack('<II', len(data), 0x004E4942) + data


INIT = r"""
const callbacks = new Map(), listeners = new Map();
let next = 1;
window.__exports = [];
window.__viewerSources = [];
window.__holdExportDialog = false;
window.__pendingExport = null;
window.__releaseExportDialog = value => {
  const finish=window.__pendingExport;
  window.__pendingExport=null;
  window.__holdExportDialog=false;
  finish(value);
};
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
window.__TAURI_INTERNALS__ = {
  metadata: { currentWindow: {label: 'main'}, currentWebview: {label: 'main'} },
  transformCallback(fn) { const id = next++; callbacks.set(id, fn); return id; },
  unregisterCallback(id) { callbacks.delete(id); },
  convertFileSrc(path) { window.__viewerSources.push(path); return new URL('/fixtures/cube.glb', location.origin).href; },
  async invoke(cmd, args = {}) {
    if (cmd === 'plugin:event|listen') { listeners.set(args.event, callbacks.get(args.handler)); return next++; }
    if (cmd === 'get_ui_bundle' || cmd === 'set_theme') return window.__bundle;
    if (cmd === 'get_app_info') return {version:'0.3.0', build_date:'2026-06-03', repository:'', homepage:'', license:'MIT'};
    if (cmd === 'complete_startup') return ['/fixtures/cube.glb'];
    if (cmd === 'normalize_model_path') return args.path;
    if (cmd === 'resolve_viewer_model_path') return '/viewer-cache/cube-preview.glb';
    if (cmd === 'prepare_viewer_model') return {path:'/viewer-cache/cube-preview.glb', level:'original', next_level:null};
    if (cmd === 'cancel_viewer_preparation') return null;
    if (cmd === 'path_kind') return 'file';
    if (cmd === 'model_file_size') return 2048;
    if (cmd === 'load_model') return {path:args.path, name:'cube.glb', format:'glb', file_size:2048, vertex_count:8, triangle_count:12, mesh_count:1, material_count:1, materials:[], bounds_w:2, bounds_h:1.2, bounds_d:.8};
    if (cmd === 'viewer_cache_size') return 0;
    if (cmd === 'check_for_updates') return {update_available:false, latest_version:'0.3.0'};
    if (cmd === 'export_model_dialog') {
      window.__exports.push(args);
      if (window.__holdExportDialog) return new Promise(resolve => { window.__pendingExport=resolve; });
      return '/output/' + args.defaultFilename;
    }
    if (cmd === 'save_cutout_dialog') return '/output/cube.png';
    throw new Error('Unexpected IPC in smoke test: ' + cmd);
  }
};
window.__emit = (event, payload) => listeners.get(event)?.({event, payload});
"""

STATS = r"""async () => {
  const img = document.querySelector('[data-bind=cutout-preview-image]');
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width=img.naturalWidth; canvas.height=img.naturalHeight;
  const ctx=canvas.getContext('2d'); ctx.drawImage(img,0,0);
  const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;
  let minX=canvas.width,minY=canvas.height,maxX=-1,maxY=-1,maxAlpha=0;
  for(let y=0;y<canvas.height;y++) for(let x=0;x<canvas.width;x++) {
    const a=pixels[(y*canvas.width+x)*4+3]; maxAlpha=Math.max(maxAlpha,a);
    if(a>1) {minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);}
  }
  const center=Array.from(pixels.slice((Math.floor(canvas.height/2)*canvas.width+Math.floor(canvas.width/2))*4)).slice(0,4);
  return {width:canvas.width,height:canvas.height,minX,minY,maxX,maxY,maxAlpha,center,cornerAlpha:pixels[3]};
}"""


def check_model_export(page, format_name, result):
    event = 'export-model-gltf' if format_name == 'gltf' else 'export-model'
    before = page.evaluate('window.__exports.length')
    page.evaluate("event => { window.__holdExportDialog=true; window.__emit('menu-action',event); }", event)
    page.wait_for_function('window.__app.modelExporting && window.__pendingExport !== null')
    invocation = page.evaluate('window.__exports.at(-1)')
    assert invocation['sourcePath'] == '/fixtures/cube.glb', invocation
    assert invocation['defaultFilename'] == f'cube.{format_name}', invocation
    assert invocation['format'] == format_name, invocation
    assert invocation.get('accessRequestId'), invocation
    # Either format must share the same guard while a real dialog would be pending.
    page.evaluate("() => { window.__emit('menu-action','export-model'); window.__emit('menu-action','export-model-gltf'); }")
    assert page.evaluate('window.__exports.length') == before + 1
    assert page.evaluate('window.__app.modelExporting')
    page.evaluate('result => window.__releaseExportDialog(result)', result)
    page.wait_for_function('!window.__app.modelExporting')
    toast = page.locator('[data-bind=toast]')
    assert not toast.evaluate("el => el.classList.contains('is-error')")
    assert toast.evaluate("el => el.classList.contains('is-success')") == (result is not None)
    if result is not None:
        assert result in page.locator('[data-bind=toast-text]').inner_text()


def check_reopened_gltf(page, path, index):
    """Load a real backend artifact; do not manufacture a browser-only export."""
    payload = path.read_bytes()
    doc = json.loads(payload)
    views = doc.get('bufferViews', [])
    compressed_views = [view for view in views
                        if 'EXT_meshopt_compression' in view.get('extensions', {})]
    compressed_payload_buffers = {
        view['extensions']['EXT_meshopt_compression']['buffer'] for view in compressed_views
    }
    for section in ('buffers', 'images'):
        for asset_index, asset in enumerate(doc.get(section, [])):
            uri = asset.get('uri')
            assert uri is None or uri.startswith('data:'), (path, section, uri)
            if section == 'buffers':
                references = [view for view in views if view.get('buffer') == asset_index]
                # The meshopt fallback marker is optional. URI-free decoded storage
                # is valid when every reference is supplied by the compressed data.
                virtual = (uri is None and references
                           and asset_index not in compressed_payload_buffers
                           and all(view in compressed_views for view in references))
                if virtual:
                    assert uri is None, (path, asset)
                else:
                    assert uri and ';base64,' in uri, (path, asset)
                    data = base64.b64decode(uri.split(',', 1)[1], validate=True)
                    assert len(data) == asset['byteLength'], (path, len(data), asset)
    if 'compressed' in path.stem.lower():
        assert compressed_views and 'EXT_meshopt_compression' in doc.get('extensionsRequired', []), path
    if 'obj' in path.stem.lower():
        assert len(doc.get('materials', [])) == 2 and len(doc.get('images', [])) == 1, path
    url = f'{BASE}/fixtures/exported-{index}.gltf'
    page.route(url, lambda route: route.fulfill(body=payload, content_type='model/gltf+json'))
    stats = page.evaluate("""async url => {
        const mv=document.querySelector('model-viewer');
        await new Promise((resolve,reject)=>{
            const abort=new AbortController();
            const timer=setTimeout(()=>{abort.abort();reject(new Error('Exported glTF load timed out'));},30000);
            const finish=callback=>{clearTimeout(timer);abort.abort();callback();};
            mv.addEventListener('load',()=>finish(resolve),{once:true,signal:abort.signal});
            mv.addEventListener('error',event=>finish(()=>reject(new Error(event.detail?.sourceError?.message || 'Exported glTF load failed'))),{once:true,signal:abort.signal});
            mv.src=url;
        });
        for(let i=0;i<4;i++) await new Promise(requestAnimationFrame);
        const scene=mv[Object.getOwnPropertySymbols(mv).find(s=>s.description==='scene')];
        let triangles=0,meshes=0;
        const textures=new Set();
        scene.model.traverse(object=>{
            if(!object.isMesh)return;
            meshes++;
            triangles+=(object.geometry.index?.count ?? object.geometry.attributes.position.count)/3;
            for(const material of Array.isArray(object.material)?object.material:[object.material]){
                for(const key of ['map','normalMap','roughnessMap','metalnessMap','emissiveMap','aoMap','alphaMap']){
                    if(material[key]?.image)textures.add(material[key].source);
                }
            }
        });
        const dimensions=mv.getDimensions();
        return {loaded:mv.loaded,meshes,triangles,materials:mv.model.materials.length,
                textureImages:textures.size,dimensions:[dimensions.x,dimensions.y,dimensions.z]};
    }""", url)
    assert stats['loaded'] and stats['triangles'] == 12, (path, stats)
    declared_materials = len(doc.get('materials', []))
    # A material-free STL export uses glTF's implicit default material; the
    # renderer may expose that material even though the JSON declares none.
    assert stats['materials'] in ({declared_materials} if declared_materials else {0, 1}), (path, stats)
    assert all(abs(actual - expected) < .005 for actual, expected in zip(stats['dimensions'], [2, 1.2, .8])), (path, stats)
    if doc.get('images'):
        assert stats['textureImages'] >= 1, (path, stats)
    print('PASS real self-contained glTF reopens:', str(path), json.dumps(stats), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reopen-gltf', type=Path, action='append', default=[],
                        help='Reopen an actual Rust-exported self-contained box fixture (repeatable)')
    args = parser.parse_args()
    with sync_playwright() as p:
        executable = os.environ.get("TRIVOR_CHROME")
        if not executable and Path('/Applications/Google Chrome.app').exists():
            executable = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
        browser = p.chromium.launch(headless=True, executable_path=executable, args=['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
        try:
            page = browser.new_page(viewport={"width": 1280, "height": 840}, device_scale_factor=1)
            errors = []
            page.on('pageerror', lambda error: (errors.append(str(error)), print('BROWSER ERROR:', str(error), flush=True)))
            page.on('console', lambda message: print('CONSOLE:', message.text, flush=True) if message.type == 'error' else None)
            page.on('requestfailed', lambda request: print('REQUEST FAILED:', request.url, request.failure, flush=True))
            page.add_init_script('window.__bundle = ' + json.dumps(ui_bundle()) + ';' + INIT)
            page.route('**/fixtures/cube.glb', lambda route: route.fulfill(body=cube_glb(), content_type='model/gltf-binary'))
            # Expose the existing instance only in this intercepted test response.
            page.route('**/src/main.ts*', lambda route: route.fulfill(body=route.fetch().text() + '\nwindow.__app = app;', content_type='application/javascript'))
            page.goto(BASE)
            page.wait_for_load_state('networkidle')
            try:
                page.wait_for_function('window.__app?.phase === "ready"', timeout=30000)
            except Exception:
                print('LOAD STATE:', page.evaluate('({phase:window.__app?.phase, status:window.__app?.status, failure:window.__app?.loadFailure})'), flush=True)
                raise
            assert page.evaluate('customElements.get("model-viewer").meshoptDecoderLocation').endswith('/meshopt_decoder.js')
            print('PASS model loads with bundled meshopt decoder', flush=True)

            page.locator('[data-action=settings]').click()
            page.locator('[data-appearance-preset]').select_option('warm')
            page.locator('[data-appearance-opacity]').evaluate("el => { el.value = 50; el.dispatchEvent(new Event('input', {bubbles:true})); }")
            assert page.locator('[data-appearance-value]').inner_text() == '50%'
            assert page.evaluate('window.__app.sceneOptions.get().modelOpacity') == .5
            page.locator('[data-action=reset-appearance]').click()
            assert page.evaluate('window.__app.sceneOptions.get().modelOpacity') == 1
            assert page.evaluate('window.__app.sceneOptions.get().colorPreset') == 'original'
            page.keyboard.press('Escape')
            print('PASS live opacity and reset appearance', flush=True)

            assert page.evaluate("window.__viewerSources.includes('/viewer-cache/cube-preview.glb')")
            check_model_export(page, 'glb', '/output/cube.glb')
            check_model_export(page, 'gltf', '/output/cube.gltf')
            check_model_export(page, 'gltf', None)
            # A cancelled native dialog must allow a later export to start.
            check_model_export(page, 'gltf', '/output/cube-after-cancel.gltf')
            print('PASS GLB/glTF menus use original source, format and filename; success/cancel reset busy state', flush=True)

            page.locator('[data-action=toggle-cutout-mode]').click()
            page.wait_for_function("document.querySelector('.cutout-frame-guide') && !document.querySelector('.cutout-frame-guide').classList.contains('hidden')", timeout=15000)
            results=[]
            for size, sampling, viewport in [(2048, 1, (1280, 840)), (4096, 2, (800, 600))]:
                page.set_viewport_size({'width':viewport[0], 'height':viewport[1]})
                page.locator('[data-bind=cutout-max-edge]').select_option(str(size))
                page.locator('[data-bind=cutout-supersampling]').set_checked(sampling == 2)
                page.locator('[data-action=run-cutout-export]').click()
                page.wait_for_function('window.__app.cutoutPreviewOpen && !window.__app.cutoutExporting', timeout=60000)
                stats=page.evaluate(STATS)
                assert max(stats['width'], stats['height']) == size, stats
                assert stats['cornerAlpha'] == 0 and stats['maxAlpha'] == 255, stats
                assert 13 <= stats['minX'] <= 19 and 13 <= stats['minY'] <= 19, stats
                assert stats['center'][0] > stats['center'][2] and stats['center'][0] > 50, stats
                results.append(stats)
                page.screenshot(path=str(Path(tempfile.gettempdir()) / f'trivor-cutout-{size}.png'))
                page.locator('[data-action=cutout-preview-cancel]').click()
            print('PASS 2048/1x and 4096/2x PNG export at different window sizes:', json.dumps(results), flush=True)
            # Appearance must survive real shader compilation and PNG color conversion.
            for preset, opacity in [('clay', 1), ('original', .5), ('original', 1)]:
                page.evaluate("([preset, opacity]) => { const app=window.__app; app.sceneOptions.set({colorPreset:preset, modelOpacity:opacity}); app.applySceneOptions(); }", [preset, opacity])
                page.locator('[data-bind=cutout-max-edge]').select_option('2048')
                page.locator('[data-bind=cutout-supersampling]').set_checked(False)
                page.locator('[data-action=run-cutout-export]').click()
                page.wait_for_function('window.__app.cutoutPreviewOpen && !window.__app.cutoutExporting', timeout=60000)
                stats=page.evaluate(STATS)
                if preset == 'clay':
                    assert max(stats['center'][:3]) - min(stats['center'][:3]) < 15, stats
                elif opacity == .5:
                    assert 120 <= stats['center'][3] <= 135, stats
                    assert all(abs(stats['center'][i] - results[0]['center'][i]) < 5 for i in range(3)), stats
                else:
                    assert stats['center'] == results[0]['center'], stats
                page.locator('[data-action=cutout-preview-cancel]').click()
            print('PASS clay shaders, transparent PNG color, original material restoration', flush=True)

            cancelled = page.evaluate("""async () => {
                const app=window.__app;
                const original=app.viewport.exportCutout;
                let finish;
                app.viewport.exportCutout=() => new Promise(resolve => { finish=resolve; });
                try {
                    const pending=app.beginCutoutExport();
                    while (!finish) await new Promise(requestAnimationFrame);
                    app.setCutoutMode(false);
                    finish(new Uint8Array([1,2,3]));
                    await pending;
                    return !app.cutoutPreviewOpen && app.cutoutPendingBytes === null;
                } finally { app.viewport.exportCutout=original; }
            }""")
            assert cancelled
            print('PASS cancelled export cannot reopen stale preview', flush=True)
            for index, path in enumerate(args.reopen_gltf):
                check_reopened_gltf(page, path, index)
            assert not errors, errors
            print('PASS no uncaught browser errors', flush=True)
        finally:
            browser.close()


if __name__ == '__main__':
    main()
