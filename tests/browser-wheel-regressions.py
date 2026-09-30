"""Measure actual model-viewer wheel response using the existing synthetic IPC fixture.

Run against an independent Vite server:
  TRIVOR_TEST_URL=http://127.0.0.1:1423 python3 tests/browser-wheel-regressions.py
Optional --max-settle-ms adds a performance regression budget. --output stores
all sampled frames and actual listener calls; no native UI or clipboard is used.
"""
import argparse
from collections import Counter
import importlib.util
import json
import os
from pathlib import Path
import tempfile

from playwright.sync_api import sync_playwright

spec = importlib.util.spec_from_file_location('browser_smoke', Path(__file__).with_name('browser-regressions.py'))
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)

PROBE = r"""
window.__wheelProbe = {calls: [], inputs: [], frames: [], active: false};
window.__cameraSample = () => {
  const mv = document.querySelector('model-viewer');
  if (!mv?.loaded) return null;
  const controls = mv[Object.getOwnPropertySymbols(mv).find(s => s.description === 'controls')];
  return {t:performance.now(), radius:mv.getCameraOrbit().radius, fov:mv.getFieldOfView(),
    goalRadius:controls?.goalSpherical.radius, goalFov:Math.exp(controls?.goalLogFov)};
};
const describe = node => {
  if (!node) return null;
  if (node === window) return 'window';
  if (node === document) return 'document';
  return (node.tagName?.toLowerCase() || node.constructor.name) +
    (node.id ? '#' + node.id : '') + (node.className && typeof node.className === 'string' ? '.' + node.className.trim().replaceAll(' ','.') : '') +
    (node.getRootNode?.() instanceof ShadowRoot ? ' [shadow]' : '');
};
const originalAdd = EventTarget.prototype.addEventListener;
const originalRemove = EventTarget.prototype.removeEventListener;
const wrappers = new WeakMap();
let listenerId = 0;
EventTarget.prototype.addEventListener = function(type, listener, options) {
  if (type !== 'wheel' || !listener) return originalAdd.call(this,type,listener,options);
  let map = wrappers.get(this);
  if (!map) wrappers.set(this, map = new WeakMap());
  let wrapped = map.get(listener);
  if (!wrapped) {
    const id = ++listenerId;
    wrapped = function(event) {
      if (!window.__wheelProbe.active) return typeof listener === 'function' ? listener.call(this,event) : listener.handleEvent(event);
      const call = {id, t:performance.now(), listener:describe(this), target:describe(event.target),
        trusted:event.isTrusted, composed:event.composed, deltaY:event.deltaY, deltaMode:event.deltaMode,
        before:window.__cameraSample()};
      window.__wheelProbe.calls.push(call);
      try { return typeof listener === 'function' ? listener.call(this,event) : listener.handleEvent(event); }
      finally { call.after=window.__cameraSample(); }
    };
    map.set(listener, wrapped);
  }
  return originalAdd.call(this,type,wrapped,options);
};
EventTarget.prototype.removeEventListener = function(type,listener,options) {
  return originalRemove.call(this,type,type === 'wheel' ? wrappers.get(this)?.get(listener) || listener : listener,options);
};
originalAdd.call(document,'wheel',event => {
  if (window.__wheelProbe.active && (event.isTrusted || event.composed)) window.__wheelProbe.inputs.push({
    t:performance.now(),trusted:event.isTrusted,deltaY:event.deltaY,deltaMode:event.deltaMode,target:describe(event.target),
    path:event.composedPath().map(describe),before:window.__cameraSample()});
},{capture:true,passive:true});
window.__beginWheelProbe = async (name, reset = true) => {
  if (reset) window.__app.viewport.reset();
  const mv=document.querySelector('model-viewer');
  // reset() applies the saved pose on the next animation frame.
  await new Promise(requestAnimationFrame);
  await mv.updateComplete;
  mv.jumpCameraToGoal();
  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);
  window.__wheelProbe={name,calls:[],inputs:[],frames:[],active:true,initial:window.__cameraSample()};
  const sample=()=>{
    if (!window.__wheelProbe.active) return;
    window.__wheelProbe.frames.push(window.__cameraSample());
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
};
window.__endWheelProbe=()=>{
  window.__wheelProbe.active=false;
  window.__wheelProbe.final=window.__cameraSample();
  return window.__wheelProbe;
};
"""


def summarize(record):
    inputs, frames = record['inputs'], record['frames']
    assert inputs and frames, record
    first, last = inputs[0], inputs[-1]
    initial, final = record['initial'], record['final']
    def changed(a, b, key):
        return abs(a[key] - b[key]) > max(abs(b[key]), 1) * 1e-6
    response = next((frame['t'] - first['t'] for frame in frames
                     if frame['t'] >= first['t'] and any(changed(frame, initial, key) for key in ('radius','fov'))), None)
    goals = {'radius': final['goalRadius'], 'fov': final['goalFov']}
    def near_goal(frame):
        return all(abs(frame[key] - goals[key]) <= max(abs(last['before'][key] - goals[key]) * .05, 1e-6)
                   for key in goals)
    post = [frame for frame in frames if frame['t'] >= last['t']]
    settled = next((frame['t'] - last['t'] for index, frame in enumerate(post)
                    if near_goal(frame) and all(near_goal(later) for later in post[index:])), None)
    directions = {key: 'increases' if final[key] > initial[key] + 1e-6 else
                  'decreases' if final[key] < initial[key] - 1e-6 else 'unchanged'
                  for key in ('radius', 'fov')}
    reversed_response = None
    wrong_way = None
    if inputs[-1]['deltaY'] * inputs[0]['deltaY'] < 0:
        previous = last['before']
        sign = 1 if last['deltaY'] > 0 else -1
        for frame in post:
            if sign * (frame['radius'] - previous['radius']) > 1e-6:
                reversed_response = frame['t'] - last['t']
                break
            previous = frame
        wrong_way = max([0] + [-sign * (frame['radius'] - last['before']['radius']) for frame in post])
    call_counts = Counter(f"{call['listener']} | {'trusted' if call['trusted'] else 'synthetic-shell' if call['composed'] else 'forwarded'}" for call in record['calls'])
    return {'case':record['name'], 'input_count':len(inputs),
            'trusted_inputs':all(event['trusted'] for event in inputs),
            'actual_input_intervals_ms':[round(b['t']-a['t'],2) for a,b in zip(inputs,inputs[1:])],
            'first_response_ms':None if response is None else round(response,2),
            'settle_95_after_last_input_ms':None if settled is None else round(settled,2),
            'reversal_response_ms':None if reversed_response is None else round(reversed_response,2),
            'reverse_wrong_way_radius':wrong_way,
            'start':{key:initial[key] for key in ('radius','fov')},
            'end':{key:final[key] for key in ('radius','fov')}, 'goal':goals,
            'directions':directions, 'listener_calls':dict(call_counts),
            'frame_count':len(frames)}


EDGE_CASES = r"""async () => {
  const mv=document.querySelector('model-viewer');
  const input=mv.shadowRoot.querySelector('.userInput');
  const sample=window.__cameraSample;
  const frame=()=>new Promise(requestAnimationFrame);
  const send=(deltaY,deltaMode=0)=>input.dispatchEvent(new WheelEvent('wheel',{
    deltaY,deltaMode,bubbles:true,composed:true,cancelable:true
  }));
  const reset=async()=>{await window.__beginWheelProbe('edge');window.__wheelProbe.active=false;return sample();};
  const jump=async()=>{await mv.updateComplete;mv.jumpCameraToGoal();await mv.updateComplete;await frame();await frame();return sample();};
  const one=async(delta,mode=0)=>{const start=await reset();send(delta,mode);const end=await jump();return {ratio:end.radius/start.radius,fovDelta:end.fov-start.fov};};
  const zero=await one(0);
  const small=await one(.1);
  const line=await one(3,1);
  const pixels54=await one(54);
  const page=await one(.05,2);
  const pagePixels=await one(.05*window.__app.viewport.host.clientHeight);
  const burstStart=await reset();
  for(let i=0;i<5;i++)send(100);
  const burstEnd=await jump();
  const burst={ratio:burstEnd.radius/burstStart.radius,fovDelta:burstEnd.fov-burstStart.fov};
  const limits=[];
  for(const sign of [1,-1]){
    const initial=await reset();
    for(let i=0;i<4;i++)send(sign*1e6);
    const boundary=await jump();
    const startTime=performance.now();
    send(-sign*100);
    await mv.updateComplete;
    let response=null,settled=null,final;
    for(let i=0;i<90;i++){
      await frame();final=sample();
      if(response===null&&-sign*(final.radius-boundary.radius)>1e-6)response=final.t-startTime;
      const distance=Math.abs(boundary.radius-final.goalRadius);
      if(settled===null&&Math.abs(final.radius-final.goalRadius)<=Math.max(1e-6,distance*.05))settled=final.t-startTime;
      if(final.t-startTime>400)break;
    }
    limits.push({limit:sign>0?'max':'min',boundaryRatio:boundary.radius/initial.radius,
      finalRatio:final.radius/boundary.radius,goalRatio:final.goalRadius/boundary.radius,
      response_ms:response,settle_95_ms:settled,fovDelta:final.fov-initial.fov});
  }
  return {zero,small,line,pixels54,page,pagePixels,burst,limits};
}"""


def assert_edges(edges, budget):
    import math
    assert abs(edges['zero']['ratio'] - 1) < 1e-9, edges
    assert 1 < edges['small']['ratio'] < 1.001, edges
    assert abs(edges['line']['ratio'] - edges['pixels54']['ratio']) < 1e-9, edges
    assert abs(edges['page']['ratio'] - edges['pagePixels']['ratio']) < 1e-9, edges
    assert abs(edges['burst']['ratio'] - math.exp(.6)) < 1e-9, edges
    for name in ('zero','small','line','pixels54','page','pagePixels','burst'):
        assert abs(edges[name]['fovDelta']) < 1e-6, edges
    for limit in edges['limits']:
        expected_bound = 5 if limit['limit'] == 'max' else .15
        expected_reverse = math.exp(-.12 if limit['limit'] == 'max' else .12)
        assert abs(limit['boundaryRatio'] - expected_bound) < 1e-9, limit
        assert abs(limit['goalRatio'] - expected_reverse) < 1e-9, limit
        assert limit['response_ms'] is not None and limit['settle_95_ms'] is not None, limit
        assert abs(limit['fovDelta']) < 1e-6, limit
        if budget is not None:
            assert limit['settle_95_ms'] <= budget, limit



def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--max-settle-ms',type=float)
    parser.add_argument('--edges-only',action='store_true',help='Only run zero/unit/burst/limit behavior checks')
    parser.add_argument('--output',default=str(Path(tempfile.gettempdir())/'trivor-wheel-regressions.json'))
    args=parser.parse_args()
    records=[]
    with sync_playwright() as p:
        executable=os.environ.get('TRIVOR_CHROME')
        if not executable and Path('/Applications/Google Chrome.app').exists():
            executable='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
        browser=p.chromium.launch(headless=True,executable_path=executable,
                                 args=['--enable-webgl','--use-angle=swiftshader','--enable-unsafe-swiftshader'])
        try:
            page=browser.new_page(viewport={'width':1000,'height':720},device_scale_factor=1)
            errors=[]
            page.on('pageerror',lambda error:errors.append(str(error)))
            page.add_init_script('window.__bundle = '+json.dumps(smoke.ui_bundle())+';'+smoke.INIT+PROBE)
            page.route('**/fixtures/cube.glb',lambda route:route.fulfill(body=smoke.cube_glb(),content_type='model/gltf-binary'))
            page.route('**/src/main.ts*',lambda route:route.fulfill(body=route.fetch().text()+'\nwindow.__app=app;',content_type='application/javascript'))
            page.goto(smoke.BASE)
            page.wait_for_load_state('networkidle')
            page.wait_for_function('window.__app?.phase === "ready"',timeout=30000)
            surface=page.locator('model-viewer')
            box=surface.bounding_box()
            page.mouse.move(box['x']+box['width']/2,box['y']+box['height']/2)
            settings=surface.evaluate("mv => ({decay:mv.interpolationDecay, sensitivity:mv.zoomSensitivity, shell:mv.parentElement.outerHTML.slice(0,300)})")
            scenarios=[] if args.edges_only else [('single_100',[100],0),('continuous_5x100',[100]*5,60),('reverse_100_then_minus100',[100,-100],35),('reverse_controlled_35ms',[100,-100],35)]
            for name,deltas,interval in scenarios:
                page.evaluate('window.__beginWheelProbe',name)
                if name == 'reverse_controlled_35ms':
                    # Isolate damping reversal from CDP wheel dispatch latency. These
                    # explicitly synthetic inputs follow the same composed shell path.
                    page.evaluate('''async () => {
                      const input=document.querySelector('model-viewer').shadowRoot.querySelector('.userInput');
                      const send=deltaY=>input.dispatchEvent(new WheelEvent('wheel',{deltaY,bubbles:true,composed:true,cancelable:true}));
                      send(100);
                      await new Promise(resolve=>setTimeout(resolve,35));
                      send(-100);
                    }''')
                else:
                    for index,delta in enumerate(deltas):
                        if index:
                            page.wait_for_timeout(interval)
                        page.mouse.wheel(0,delta)
                page.wait_for_timeout(1200)
                record=page.evaluate('window.__endWheelProbe()')
                record['summary']=summarize(record)
                records.append(record)
                print(json.dumps(record['summary']),flush=True)
            edges=page.evaluate(EDGE_CASES)
            print('Edge cases:',json.dumps(edges),flush=True)
            if not args.edges_only:
                # Both side panels overlap the center in a narrow window.
                # Close them through the real UI before sending trusted input.
                for panel,action in [('.explorer-drawer','collapse-explorer'),('.inspector-panel','collapse-inspector')]:
                    if not page.locator(panel).evaluate("el=>el.classList.contains('is-collapsed')"):
                        page.locator('[data-action='+action+']').click()
                page.set_viewport_size({'width':420,'height':840})
                try:
                    page.wait_for_function('''() => {
                      const mv=document.querySelector('model-viewer'), box=mv.getBoundingClientRect();
                      return document.elementFromPoint(box.x+box.width/2,box.y+box.height/2)===mv;
                    }''',timeout=5000)
                except Exception:
                    print('Narrow hit target:',page.evaluate('''() => {
                      const mv=document.querySelector('model-viewer'), box=mv.getBoundingClientRect();
                      return document.elementFromPoint(box.x+box.width/2,box.y+box.height/2)?.outerHTML.slice(0,500);
                    }'''),flush=True)
                    raise
                narrow=page.evaluate('''async () => {
                  const mv=document.querySelector('model-viewer');
                  await window.__app.viewport.fit();
                  await mv.updateComplete;
                  await new Promise(requestAnimationFrame);
                  await new Promise(requestAnimationFrame);
                  const controls=mv[Object.getOwnPropertySymbols(mv).find(s=>s.description==='controls')];
                  // Mimic the non-default field of view produced by model-viewer
                  // pinch controls, without writing an aspect-adjusted attribute.
                  controls.setFieldOfView(17);
                  controls.jumpToGoal();
                  await new Promise(requestAnimationFrame);
                  await new Promise(requestAnimationFrame);
                  return {width:mv.clientWidth,height:mv.clientHeight,fov:mv.getFieldOfView()};
                }''')
                assert narrow['width'] < narrow['height'] and abs(narrow['fov']-17)<1e-6, narrow
                box=surface.bounding_box()
                page.mouse.move(box['x']+box['width']/2,box['y']+box['height']/2)
                page.evaluate("window.__beginWheelProbe('narrow_fov_17',false)")
                page.mouse.wheel(0,100)
                page.wait_for_timeout(1200)
                record=page.evaluate('window.__endWheelProbe()')
                record['viewport']=narrow
                record['summary']=summarize(record)
                records.append(record)
                print(json.dumps(record['summary']),flush=True)
            report={'settings':settings,'browser_errors':errors,'cases':records,'edges':edges}
            Path(args.output).write_text(json.dumps(report,indent=2))
            print('Report:',args.output,flush=True)
            assert not errors, errors
            assert_edges(edges,args.max_settle_ms)
            for record in records:
                summary=record['summary']
                assert summary['first_response_ms'] is not None, summary
                assert summary['settle_95_after_last_input_ms'] is not None, summary
                assert summary['input_count'] == (5 if 'continuous' in record['name'] else 2 if 'reverse' in record['name'] else 1), summary
                assert all(count <= summary['input_count'] for count in summary['listener_calls'].values()), summary
                assert abs(summary['end']['fov'] - summary['start']['fov']) < 1e-6, summary
                assert all(abs(frame['fov']-summary['start']['fov'])<1e-6 for frame in record['frames']), summary
                if 'reverse' in record['name']:
                    assert summary['reversal_response_ms'] is not None, summary
                    assert abs(summary['end']['radius'] / summary['start']['radius'] - 1) < .001, summary
                else:
                    assert summary['end']['radius'] > summary['start']['radius'], summary
                if args.max_settle_ms is not None:
                    assert summary['settle_95_after_last_input_ms'] <= args.max_settle_ms, summary
            print('PASS wheel direction, response, settling and browser errors',flush=True)
        finally:
            browser.close()


if __name__=='__main__':
    main()
