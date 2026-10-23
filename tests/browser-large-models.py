"""Real WebGL checks for progressive loading, using real backend-generated LODs.

TRIVOR_TEST_URL=http://127.0.0.1:1423 python3 tests/browser-large-models.py \
  --structure <cache.glb> --preview <cache.glb> --detail <cache.glb>
Only native preparation IPC is mocked. Geometry decoding, rendering, camera
restoration, export and model disposal use the application's actual code.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import tempfile

from playwright.sync_api import sync_playwright

spec = importlib.util.spec_from_file_location('smoke', Path(__file__).with_name('browser-regressions.py'))
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)

INIT = r"""
const callbacks=new Map(), listeners=new Map(); let sequence=1;
window.__stages=[]; window.__cancelled=[]; window.__ignoreCancellation=false;
window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener(){}};
window.__TAURI_INTERNALS__={
 metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},
 transformCallback(fn){const id=sequence++;callbacks.set(id,fn);return id;},
 unregisterCallback(id){callbacks.delete(id);},
 convertFileSrc(path){return new URL(path,location.origin).href;},
 async invoke(cmd,args={}){
  if(cmd==='plugin:event|listen'){listeners.set(args.event,callbacks.get(args.handler));return sequence++;}
  if(cmd==='get_ui_bundle'||cmd==='set_theme')return window.__bundle;
  if(cmd==='get_app_info')return {version:'0.4.0',build_date:'2026-09-30',repository:'',homepage:'',license:'MIT'};
  if(cmd==='complete_startup')return ['/models/large.glb'];
  if(cmd==='normalize_model_path')return args.path;
  if(cmd==='path_kind')return 'file';
  if(cmd==='model_file_size')return args.path.includes('small')?2048:2147483648;
  if(cmd==='load_model')return {path:args.path,name:args.path.split('/').at(-1),format:'glb',file_size:2147483648,vertex_count:10000000,triangle_count:20000000,mesh_count:1,material_count:1,materials:[],bounds_w:2,bounds_h:2,bounds_d:2};
  if(cmd==='viewer_cache_size')return 0;
  if(cmd==='check_for_updates')return {update_available:false};
  if(cmd==='prepare_viewer_model'){
   if(args.path.includes('small'))return {path:'/test-assets/small.glb',level:'original',next_level:null};
   if(!args.level)return {path:'/test-assets/structure.glb',level:'structure',next_level:'preview'};
   return new Promise((resolve,reject)=>window.__stages.push({args,resolve,reject,settled:false}));
  }
  if(cmd==='cancel_viewer_preparation'){
   window.__cancelled.push(args.accessRequestId);
   if(!window.__ignoreCancellation)for(const stage of window.__stages){
    if(!stage.settled&&stage.args.accessRequestId===args.accessRequestId){stage.settled=true;stage.reject(new Error('MODEL_PREPARATION_CANCELLED'));}
   }
   return null;
  }
  throw Error('Unexpected IPC '+cmd);
 }
};
window.__emit=(event,payload)=>listeners.get(event)?.({event,payload});
window.__finishStage=(level,error=false)=>{
 const stage=window.__stages.find(s=>!s.settled&&s.args.level===level);
 if(!stage)throw Error('No pending '+level);
 stage.settled=true;
 if(error)stage.reject(new Error('fixture preparation failed'));
 else stage.resolve({path:'/test-assets/'+level+'.glb',level,next_level:level==='preview'?'detail':null});
};
"""


def wait_stage(page, level):
    page.wait_for_function("level=>window.__stages.some(s=>!s.settled&&s.args.level===level)", arg=level, timeout=120000)


def assert_pose(before, after):
    for key, value in before.items():
        tolerance = max(0.0002, abs(value) * 0.001)
        assert abs(value - after[key]) < tolerance, (key, before, after)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for level in ['structure', 'preview', 'detail']:
        parser.add_argument('--' + level, type=Path, required=True)
    args = parser.parse_args()
    payloads = {level: getattr(args, level).read_bytes() for level in ['structure', 'preview', 'detail']}
    payloads['small'] = smoke.cube_glb()
    with sync_playwright() as p:
        executable = os.environ.get('TRIVOR_CHROME')
        if not executable and Path('/Applications/Google Chrome.app').exists():
            executable = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
        browser = p.chromium.launch(headless=True, executable_path=executable,
            args=['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
        try:
            page = browser.new_page(viewport={'width':1280,'height':840})
            errors = []
            decoder_requests = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('request', lambda request: decoder_requests.append(request.url) if '/decoders/basis/' in request.url else None)
            page.route('https://www.gstatic.com/**', lambda route: route.abort())
            page.add_init_script('window.__bundle='+json.dumps(smoke.ui_bundle())+';'+INIT)
            for level, payload in payloads.items():
                page.route('**/test-assets/'+level+'.glb', lambda route, request, data=payload: route.fulfill(body=data, content_type='model/gltf-binary'))
            page.route('**/src/main.ts*', lambda route: route.fulfill(body=route.fetch().text()+'\nwindow.__app=app;',content_type='application/javascript'))
            page.goto(smoke.BASE)
            page.wait_for_load_state('networkidle')
            page.wait_for_function("window.__app?.phase==='ready'&&window.__app.preparedLevel==='structure'", timeout=60000)
            wait_stage(page, 'preview')
            assert 'bounding boxes' in page.locator('[data-bind=model-refinement-label]').inner_text()
            assert page.evaluate('customElements.get("model-viewer").modelCacheSize') == 0
            initial = page.evaluate('window.__app.viewport.exportSnapshot()')
            # Move the camera after loading started. Replacement must capture this pose.
            before = page.evaluate("""async()=>{
              const v=window.__app.viewport,m=v.element,o=m.getCameraOrbit();
              m.cameraOrbit=`${o.theta+.37}rad ${o.phi+.12}rad ${o.radius*.8}m`;
              await m.updateComplete;m.jumpCameraToGoal();
              await new Promise(requestAnimationFrame);return v.captureLiveCamera();
            }""")
            page.evaluate("window.__emit('pack-progress',{percent:77,request_id:'stale-request'})")
            assert page.evaluate('window.__app.refinementPercent') == 0
            page.evaluate("window.__finishStage('preview')")
            wait_stage(page, 'detail')
            assert page.evaluate('window.__app.preparedLevel') == 'preview'
            assert_pose(before, page.evaluate('window.__app.viewport.captureLiveCamera()'))
            assert page.evaluate('window.__app.viewport.exportSnapshot()') == initial
            assert page.locator('model-viewer').count() == 1
            if any(b'KHR_texture_basisu' in data for data in payloads.values()):
                assert any(url.endswith('basis_transcoder.wasm') for url in decoder_requests), decoder_requests
            assert page.evaluate('window.__app.viewport.element.loaded')
            print('PASS structure -> actual geometry, live camera/reset preserved, stale progress ignored', flush=True)

            page.evaluate("window.__finishStage('detail')")
            page.wait_for_function("window.__app.preparedLevel==='detail'&&window.__app.refinementState==='idle'",timeout=120000)
            assert_pose(before, page.evaluate('window.__app.viewport.captureLiveCamera()'))
            assert page.locator('model-viewer').count() == 1
            page.screenshot(path=str(Path(tempfile.gettempdir())/'trivor-large-detail.png'))
            print('PASS detailed geometry renders; only the current model-viewer remains', flush=True)

            # A broken detail cannot destroy the already rendered preview.
            page.evaluate("window.__app.openPath('/models/large-retry.glb',{addToList:true})")
            wait_stage(page,'preview')
            page.evaluate("window.__finishStage('preview')")
            wait_stage(page,'detail')
            page.evaluate("window.__finishStage('detail',true)")
            page.wait_for_function("window.__app.refinementState==='failed'")
            assert page.evaluate("window.__app.phase==='ready'&&window.__app.preparedLevel==='preview'&&window.__app.viewport.element.loaded")
            print('PASS detail failure retains an interactive geometry preview', flush=True)

            # Reopening the same failed file retries; stop keeps current stage.
            page.evaluate("window.__app.openPath('/models/large-retry.glb',{addToList:true})")
            wait_stage(page,'preview')
            page.locator('[data-action=stop-refinement]').click()
            page.wait_for_function("window.__app.refinementState==='stopped'")
            assert page.evaluate("window.__app.phase==='ready'&&window.__app.viewport.element.loaded")
            assert page.evaluate('window.__cancelled.length') >= 2
            print('PASS retry and stop refinement leave the visible stage intact', flush=True)

            # Simulate a native result arriving after cancellation despite the IPC race.
            page.evaluate("window.__ignoreCancellation=true;window.__app.openPath('/models/large-race.glb',{addToList:true})")
            wait_stage(page,'preview')
            page.evaluate("window.__app.openPath('/models/small.glb',{addToList:true})")
            page.wait_for_function("window.__app.activePath==='/models/small.glb'&&window.__app.phase==='ready'")
            page.evaluate("window.__finishStage('preview')")
            page.wait_for_function("window.__app.preparedLevel==='original'")
            assert page.evaluate("window.__app.viewport.element.src.endsWith('/test-assets/small.glb')")
            assert page.locator('model-viewer').count() == 1
            assert not errors, errors
            print('PASS a cancelled old result cannot replace the newly opened model; no browser errors', flush=True)
        finally:
            browser.close()


if __name__ == '__main__':
    main()
