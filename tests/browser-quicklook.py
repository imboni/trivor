"""Exercise the packaged Quick Look renderer in real headless Chromium.

Build with node scripts/build-quicklook-web.mjs, then serve
src-tauri/.bundle/quicklook-web on localhost. This test generates real Draco,
meshopt and KTX2 fixtures with the installed offline encoders and blocks external
requests. Native Quick Look registration and WKWebView are tested separately.
Repeat --model /absolute/path/model.glb to exercise real local models after the
regression fixtures. Large assets can use --serve-only plus --stream-models to
stream directly from a loopback server without copying bytes through Playwright.
"""
import argparse
import base64
import importlib.util
import io
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import tempfile
import threading
import time
from urllib.parse import urlsplit
import zlib

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("trivor_smoke", Path(__file__).with_name("browser-regressions.py"))
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)

INIT = r"""
window.__messages = [];
window.__loadStarts = {};
window.__messageTimes = {};
window.webkit = {messageHandlers:{preview:{postMessage(message){window.__messages.push(message);if(message.requestId)window.__messageTimes[message.requestId]=performance.now();}}}};
window.__modelBlobs = new Set();
const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
URL.createObjectURL = value => { const url=create(value); if(value.type==='model/gltf-binary')window.__modelBlobs.add(url); return url; };
URL.revokeObjectURL = url => { window.__modelBlobs.delete(url); return revoke(url); };
"""

DRACO = r"""
import fs from 'node:fs'; import vm from 'node:vm'; import { createRequire } from 'node:module';
const module={exports:{}};
const source='./node_modules/three/examples/jsm/libs/draco/gltf/draco_encoder.js';
vm.runInNewContext(fs.readFileSync(source,'utf8'),{module,exports:module.exports,require:createRequire(import.meta.url),process,console,setTimeout,clearTimeout,Buffer,__dirname:new URL('./node_modules/three/examples/jsm/libs/draco/gltf/',import.meta.url).pathname});
// Emscripten's legacy module is thenable: wrap it to avoid Promise assimilation.
const {draco}=await new Promise(resolve=>module.exports({onModuleLoaded:d=>resolve({draco:d})}));
const mesh=new draco.Mesh(), builder=new draco.MeshBuilder(), encoder=new draco.Encoder();
const positions=new Float32Array([-1,-.6,-.4,1,-.6,-.4,1,.6,-.4,-1,.6,-.4,-1,-.6,.4,1,-.6,.4,1,.6,.4,-1,.6,.4]);
const indices=new Uint32Array([0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,3,7,6,3,6,2,0,4,7,0,7,3,1,2,6,1,6,5]);
const position=builder.AddFloatAttributeToMesh(mesh,draco.POSITION,8,3,positions);
builder.AddFacesToMesh(mesh,12,indices);encoder.SetAttributeQuantization(draco.POSITION,14);encoder.SetSpeedOptions(5,5);
const out=new draco.DracoInt8Array(), len=encoder.EncodeMeshToDracoBuffer(mesh,out);
if(len<=0)throw Error('Draco encoding failed');
const data=Buffer.alloc(len);for(let i=0;i<len;i++)data[i]=out.GetValue(i);
fs.writeFileSync(process.argv[2],data); console.log(position);
for(const x of [out,encoder,builder,mesh])draco.destroy(x);
"""


def unpack_glb(payload):
    length = struct.unpack_from("<I", payload, 12)[0]
    doc = json.loads(payload[20:20 + length])
    binary = payload[28 + length:] if len(payload) > 20 + length else b""
    return doc, binary


def pack_glb(doc, binary=b""):
    encoded = json.dumps(doc, separators=(",", ":")).encode()
    encoded += b" " * (-len(encoded) % 4)
    binary += b"\0" * (-len(binary) % 4)
    body = struct.pack("<II", len(encoded), 0x4E4F534A) + encoded
    if binary:
        body += struct.pack("<II", len(binary), 0x004E4942) + binary
    return struct.pack("<III", 0x46546C67, 2, 12 + len(body)) + body


def png():
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
    scanlines = bytearray()
    for y in range(32):
        scanlines.append(0)
        for x in range(32):
            scanlines.extend((230, 55, 25, 255) if (x // 4 + y // 4) % 2 else (25, 180, 90, 255))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 32, 32, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(scanlines)) + chunk(b"IEND", b"")


def fixtures(destination):
    destination.mkdir(parents=True, exist_ok=True)
    payloads = {"cube": smoke.cube_glb(), "broken": b"not a GLB"}
    doc, binary = unpack_glb(payloads["cube"])
    external = json.loads(json.dumps(doc))
    external["images"] = [{"uri": "https://example.invalid/texture.png"}]
    payloads["external"] = pack_glb(external, binary)
    enormous = json.loads(json.dumps(doc))
    # Exceeds even the maximum interactive tier without allocating vertex data.
    enormous["accessors"][0]["count"] = 200_000_000
    payloads["budget"] = pack_glb(enormous, binary)

    draco_bin = destination / "draco.bin"
    encoded = subprocess.run(["node", "--input-type=module", "-", str(draco_bin)], input=DRACO,
                             cwd=ROOT, text=True, capture_output=True, check=True, timeout=30)
    draco_position = int(encoded.stdout.strip())
    draco_doc = json.loads(json.dumps(doc))
    draco_data = draco_bin.read_bytes()
    draco_doc["buffers"] = [{"byteLength": len(draco_data)}]
    draco_doc["bufferViews"] = [{"buffer": 0, "byteLength": len(draco_data)}]
    for accessor in draco_doc["accessors"]:
        accessor.pop("bufferView", None)
    draco_doc["extensionsUsed"] = draco_doc["extensionsRequired"] = ["KHR_draco_mesh_compression"]
    draco_doc["meshes"][0]["primitives"][0]["extensions"] = {"KHR_draco_mesh_compression": {"bufferView": 0, "attributes": {"POSITION": draco_position}}}
    payloads["draco"] = pack_glb(draco_doc, draco_data)

    texture_doc = json.loads(json.dumps(doc))
    uv = struct.pack("<16f", *([0, 0, 1, 0, 1, 1, 0, 1] * 2))
    image = png()
    texture_data = binary + uv + image
    texture_doc["buffers"][0]["byteLength"] = len(texture_data)
    texture_doc["bufferViews"] += [{"buffer": 0, "byteOffset": len(binary), "byteLength": len(uv)},
                                    {"buffer": 0, "byteOffset": len(binary) + len(uv), "byteLength": len(image)}]
    texture_doc["accessors"].append({"bufferView": 2, "componentType": 5126, "count": 8, "type": "VEC2"})
    texture_doc["meshes"][0]["primitives"][0]["attributes"]["TEXCOORD_0"] = 2
    texture_doc["images"] = [{"bufferView": 3, "mimeType": "image/png"}]
    texture_doc["textures"] = [{"source": 0}]
    texture_doc["materials"][0]["pbrMetallicRoughness"]["baseColorFactor"] = [1, 1, 1, 1]
    texture_doc["materials"][0]["pbrMetallicRoughness"]["baseColorTexture"] = {"index": 0}
    payloads["textured"] = pack_glb(texture_doc, texture_data)
    for name, data in payloads.items():
        (destination / (name + ".glb")).write_bytes(data)

    arch = "aarch64" if os.uname().machine == "arm64" else "x86_64"
    helper = ROOT / "src-tauri/bin" / ("gltfpack-" + arch + "-apple-darwin")
    for name, source, extra in [("meshopt", "cube", ["-c"]), ("ktx2", "textured", ["-c", "-tc", "-tj", "1"])]:
        subprocess.run([str(helper), "-i", str(destination / (source + ".glb")), "-o", str(destination / (name + ".glb")), *extra],
                       cwd=destination, check=True, capture_output=True, timeout=60)
        payloads[name] = (destination / (name + ".glb")).read_bytes()
    assert b"EXT_meshopt_compression" in payloads["meshopt"]
    assert b"KHR_texture_basisu" in payloads["ktx2"] and b"\xabKTX 20\xbb\r\n\x1a\n" in payloads["ktx2"]
    return payloads


def camera(page):
    return page.evaluate("""() => { const m=document.querySelector('model-viewer'),o=m.getCameraOrbit(),t=m.getCameraTarget();return {theta:o.theta,phi:o.phi,radius:o.radius,x:t.x,y:t.y,z:t.z,fov:m.getFieldOfView()}; }""")


def load(page, base, name, request_id, locale="en", display_name=None, budget=None):
    request = {"url": base + "/test-models/" + name + ".glb", "name": display_name or name + ".glb", "locale": locale, "requestId": request_id}
    if budget is not None:
        request["budget"] = budget
    page.evaluate("r => {window.__loadStarts[r.requestId]=performance.now();return window.trivorQuickLook.loadModel(r)}", request)
    page.wait_for_function("id => window.__messages.some(m => m.requestId===id)", arg=request_id, timeout=30000)
    return page.evaluate("id => window.__messages.find(m => m.requestId===id)", request_id)


def resolved_budget(page, expected_tier):
    value = page.evaluate("""() => {
      const root=document.querySelector('#preview'), badge=document.querySelector('#budget-tier');
      return {tier:root.dataset.budgetTier,label:badge?.textContent,tooltip:badge?.title,visible:badge ? !badge.hidden : false};
    }""")
    assert value["tier"] == expected_tier, value
    assert value["visible"] and value["label"] and value["tooltip"], value
    assert "File limit" in value["tooltip"] and "Texture limit" in value["tooltip"], value
    return value


def render_check(page, output):
    assert page.locator("model-viewer").count() == 1
    dimensions = page.evaluate("() => {const {x,y,z}=document.querySelector('model-viewer').getDimensions();return {x,y,z}}")
    for key, expected in {"x": 2, "y": 1.2, "z": .8}.items():
        assert abs(dimensions[key] - expected) < .02, dimensions
    screenshot = page.screenshot(path=str(output))
    image = Image.open(io.BytesIO(screenshot)).convert("RGB")
    colored = sum(1 for r, g, b in image.getdata() if max(r, g, b) - min(r, g, b) > 45 and max(r, g, b) > 60)
    assert colored > 500, ("no model surface rendered", colored)


def model_canvas_check(page, output):
    """Inspect the model's actual canvas, independent of UI colors or geometry."""
    assert page.locator("model-viewer").count() == 1
    dimensions = page.evaluate("() => {const {x,y,z}=document.querySelector('model-viewer').getDimensions();return {x,y,z}}")
    assert all(type(value) in (int, float) and math.isfinite(value) and value >= 0
               for value in dimensions.values()), dimensions
    assert max(dimensions.values()) > 0, dimensions
    data_url = page.evaluate("document.querySelector('model-viewer').toDataURL('image/png')")
    prefix = "data:image/png;base64,"
    assert data_url.startswith(prefix), "model canvas did not produce a PNG"
    png_data = base64.b64decode(data_url[len(prefix):], validate=True)
    image = Image.open(io.BytesIO(png_data)).convert("RGBA")
    alpha = image.getchannel("A")
    visible = sum(alpha.histogram()[1:])
    assert image.width > 0 and image.height > 0 and visible > 0, "model canvas is entirely transparent"
    output.write_bytes(png_data)
    return {"dimensions": dimensions, "canvasPixels": {"width": image.width, "height": image.height},
            "nonTransparentPixels": visible, "alphaBounds": alpha.getbbox(), "pngBytes": len(png_data)}


def model_interaction_check(page):
    """Use relative camera tolerances so large and tiny real models both work."""
    initial = camera(page)
    assert initial["radius"] > 0 and all(math.isfinite(value) for value in initial.values()), initial
    bounds = page.locator("#viewport").bounding_box()
    assert bounds and bounds["width"] > 0 and bounds["height"] > 0, bounds
    x, y = bounds["x"] + bounds["width"] * .5, bounds["y"] + bounds["height"] * .5
    page.mouse.move(x, y)
    page.mouse.wheel(0, -150)
    page.wait_for_function("r => document.querySelector('model-viewer').getCameraOrbit().radius < r*.98", arg=initial["radius"])
    zoomed = camera(page)
    page.get_by_role("button", name="Fit", exact=True).click()
    page.wait_for_function("r => Math.abs(document.querySelector('model-viewer').getCameraOrbit().radius-r) <= Math.max(r*.001,1e-8)", arg=initial["radius"])
    page.mouse.move(x, y)
    page.mouse.down()
    page.mouse.move(x + bounds["width"] * .12, y + bounds["height"] * .06, steps=8)
    page.mouse.up()
    page.wait_for_function("theta => Math.abs(document.querySelector('model-viewer').getCameraOrbit().theta-theta)>.05", arg=initial["theta"])
    orbited = camera(page)
    page.keyboard.press("f")
    page.wait_for_function("theta => Math.abs(document.querySelector('model-viewer').getCameraOrbit().theta-theta)<.001", arg=initial["theta"])
    return {"initial": initial, "zoomed": zoomed, "orbited": orbited, "restored": camera(page)}


def budget_detail_check(result, detail):
    limit = result.get("limit")
    assert isinstance(limit, dict) and limit.get("metric") == "geometry", result
    actual, maximum = limit.get("actual"), limit.get("limit")
    assert all(type(value) in (int, float) and math.isfinite(value) and value > 0
               for value in (actual, maximum)), limit
    assert actual > maximum, limit
    assert "几何" in detail and "上限" in detail and "Trivor" in detail, detail
    # Group separators and whitespace differ by locale. Match numeric MiB values
    # within the formatter's two-decimal upward rounding, not a fixed message.
    displayed = [float(re.sub(r"[,\s]", "", number))
                 for number in re.findall(r"([0-9][0-9,\s]*(?:\.[0-9]+)?)\s*MiB", detail)]
    for expected in (actual / 1024**2, maximum / 1024**2):
        assert any(expected - 1e-8 <= value <= expected + .01000001 for value in displayed), (limit, detail, displayed)


def serve_models(address, models):
    """Expose only explicitly mapped model URLs; never copy user assets into the repo."""
    routes = {"/test-models/local-" + str(index) + ".glb": model for index, model in enumerate(models, 1)}

    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(ROOT / "src-tauri/.bundle/quicklook-web"), **kwargs)

        def send_head(self):
            model = routes.get(self.path)
            if model is None:
                return super().send_head()
            try:
                source = model.open("rb")
                self.send_response(200)
                self.send_header("Content-Type", "model/gltf-binary")
                self.send_header("Content-Length", str(os.fstat(source.fileno()).st_size))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                return source
            except OSError:
                if "source" in locals():
                    source.close()
                self.send_error(404)
                return None

        def copyfile(self, source, outputfile):
            # A standard-tier request rejects the Content-Length before consuming
            # an oversized body. The resulting connection close is expected.
            try:
                shutil.copyfileobj(source, outputfile, length=1024 * 1024)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def log_message(self, _format, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", address.port or 80), Handler)
    print(f"Serving Quick Look and {len(routes)} explicit local model mapping(s) on {address.geturl()}", flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


def close_test_browser(playwright, browser, page, timeout=10):
    """Bound tool teardown separately from model/rendering deadlines.

    Playwright's public close APIs have no timeout. Its own driver process is
    the narrow cleanup boundary: terminating it closes only this launch's pipe
    and browser, never an unrelated user browser session.
    """
    driver = playwright._impl_obj._connection._transport._proc
    forced = threading.Event()
    started = time.monotonic()

    def terminate_driver():
        forced.set()
        print("Test teardown exceeded its deadline; terminating this test's Playwright driver", flush=True)
        try:
            # Let the child-process handle check whether it already exited;
            # avoid signalling a PID that the OS could have reused.
            driver.terminate()
        except ProcessLookupError:
            pass

    watchdog = threading.Timer(timeout, terminate_driver)
    watchdog.daemon = True
    watchdog.start()
    print("Closing test routes, page and browser", flush=True)
    try:
        if page is not None and not page.is_closed():
            page.unroute_all(behavior="ignoreErrors")
            page.close()
        browser.close()
    except Exception:
        if not forced.is_set():
            raise
    finally:
        watchdog.cancel()
    result = {"status": "completed", "forcedDriverTermination": forced.is_set(),
              "elapsedMs": round((time.monotonic() - started) * 1000, 2)}
    print("Test browser teardown completed" + (" with driver termination" if forced.is_set() else " normally"), flush=True)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default=os.environ.get("TRIVOR_QUICKLOOK_URL", "http://127.0.0.1:1434"))
    parser.add_argument("--output", type=Path, default=Path(tempfile.gettempdir()) / "trivor-quicklook-browser")
    parser.add_argument("--model", action="append", type=Path, default=[], metavar="PATH",
                        help="Additional local GLB; repeat to test multiple models after the full regression suite")
    parser.add_argument("--budget-json", type=Path, metavar="PATH",
                        help="One native {tier,limits} snapshot to inject into normal preview requests")
    parser.add_argument("--compare-standard", action="store_true",
                        help="Also record each additional model's real standard-tier ready or budget rejection")
    parser.add_argument("--serve-only", action="store_true",
                        help="Serve built assets and exact --model URL mappings on --base (HTTP 127.0.0.1 only)")
    parser.add_argument("--stream-models", action="store_true",
                        help="Load real models from the same-origin streaming mappings provided by --serve-only")
    args = parser.parse_args()
    base = args.base.rstrip("/")
    address = urlsplit(base)
    if (address.scheme not in ("http", "https") or address.hostname not in ("localhost", "127.0.0.1", "::1")
            or address.username or address.password or address.query or address.fragment):
        parser.error("--base must be a loopback HTTP(S) test server; remote hosts are forbidden")
    models = []
    for model in args.model:
        model = model.expanduser().resolve()
        if not model.is_file() or model.suffix.lower() != ".glb":
            parser.error("--model must name an existing local GLB file: " + str(model))
        models.append(model)
    if args.serve_only:
        if address.scheme != "http" or address.hostname != "127.0.0.1" or address.path not in ("", "/"):
            parser.error("--serve-only requires an HTTP 127.0.0.1 base with no path")
        serve_models(address, models)
        return
    budget = None
    if args.budget_json:
        try:
            budget = json.loads(args.budget_json.expanduser().read_text())
        except (OSError, ValueError) as error:
            parser.error("could not read --budget-json: " + str(error))
        if (not isinstance(budget, dict) or not isinstance(budget.get("limits"), dict)
                or budget.get("tier") not in ("standard", "expanded", "large", "maximum")):
            parser.error("--budget-json must contain one native {tier,limits} snapshot, not a profile array")
    expected_tier = budget["tier"] if budget else "standard"
    payloads = fixtures(args.output / "fixtures")
    with sync_playwright() as p:
        executable = os.environ.get("TRIVOR_CHROME")
        if not executable and Path("/Applications/Google Chrome.app").exists():
            executable = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        browser = p.chromium.launch(headless=True, executable_path=executable,
                                   args=["--enable-webgl", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        page, report = None, None
        try:
            page = browser.new_page(viewport={"width": 900, "height": 640}, color_scheme="light")
            errors, blocked, requests, console_errors = [], [], [], []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
            page.on("request", lambda request: requests.append(request.url))

            def network(route):
                if route.request.url.startswith(base + "/"):
                    route.continue_()
                else:
                    blocked.append(route.request.url)
                    route.abort()

            page.route("**/*", network)
            for name, data in payloads.items():
                page.route("**/test-models/" + name + ".glb", lambda route, request, body=data: route.fulfill(body=body, content_type="model/gltf-binary"))
            if not args.stream_models:
                for index, model in enumerate(models, 1):
                    # Small fixtures can use direct fulfillment. Larger models
                    # use the same-origin stream to avoid giant protocol messages.
                    page.route(base + "/test-models/local-" + str(index) + ".glb",
                               lambda route, request, path=model: route.fulfill(body=path.read_bytes(), content_type="model/gltf-binary"))
            page.add_init_script(INIT)
            page.goto(base)
            page.wait_for_load_state("networkidle")
            page.wait_for_function("window.trivorQuickLook && window.__messages.some(m => m.type==='boot')")

            assert load(page, base, "cube", "fallback-default")["type"] == "ready"
            default_budget = resolved_budget(page, "standard")
            invalid_budget = {"tier": "maximum", "limits": {"file": 512 * 1024**2}}
            assert load(page, base, "cube", "fallback-invalid", budget=invalid_budget)["type"] == "ready"
            rejected_budget = resolved_budget(page, "standard")
            assert rejected_budget["tooltip"] == default_budget["tooltip"], (default_budget, rejected_budget)
            print("PASS absent and invalid native budgets fall back to the standard tier", flush=True)

            active_budget = None
            for name in ["cube", "meshopt", "draco", "ktx2"]:
                result = load(page, base, name, "decode-" + name, budget=budget)
                assert result["type"] == "ready", (result, console_errors, blocked)
                active_budget = resolved_budget(page, expected_tier)
                render_check(page, args.output / (name + ".png"))
                assert page.evaluate("window.__modelBlobs.size") == 1
                print("PASS real " + name + " renders with offline resources", flush=True)
            for decoder in ["meshopt/meshopt_decoder.js", "draco/draco_decoder.wasm", "basis/basis_transcoder.wasm"]:
                assert any(url.endswith("/decoders/" + decoder) for url in requests), (decoder, requests)

            before = camera(page)
            page.mouse.move(450, 300)
            page.mouse.wheel(0, -150)
            page.wait_for_function("radius => document.querySelector('model-viewer').getCameraOrbit().radius < radius*.98", arg=before["radius"])
            page.get_by_role("button", name="Fit", exact=True).click()
            page.wait_for_function("radius => Math.abs(document.querySelector('model-viewer').getCameraOrbit().radius-radius)<.001", arg=before["radius"])
            page.mouse.move(450, 300)
            page.mouse.down()
            page.mouse.move(520, 340, steps=8)
            page.mouse.up()
            page.wait_for_function("theta => Math.abs(document.querySelector('model-viewer').getCameraOrbit().theta-theta)>.1", arg=before["theta"])
            page.keyboard.press("f")
            page.wait_for_function("theta => Math.abs(document.querySelector('model-viewer').getCameraOrbit().theta-theta)<.001", arg=before["theta"])
            print("PASS mouse orbit/zoom and Fit/F restore the initial framing", flush=True)

            light = page.evaluate("getComputedStyle(document.documentElement).backgroundColor")
            page.emulate_media(color_scheme="dark")
            page.wait_for_function("value => getComputedStyle(document.documentElement).backgroundColor!==value", arg=light)
            page.set_viewport_size({"width": 360, "height": 420})
            page.screenshot(path=str(args.output / "dark-narrow.png"))
            assert page.get_by_role("button", name="Fit", exact=True).is_visible()
            assert page.evaluate("document.documentElement.scrollWidth") == 360
            print("PASS system light/dark appearance and narrow layout", flush=True)

            for name, code in [("broken", "invalid"), ("external", "externalResources"), ("budget", "tooLarge")]:
                result = load(page, base, name, "error-" + name, "zh-Hans", budget=budget)
                assert result["type"] == "error" and result["code"] == code, result
                assert page.locator("model-viewer").count() == 0
                assert page.evaluate("window.__modelBlobs.size") == 0
                detail = page.locator("#status-detail").inner_text()
                assert "Trivor" in detail
                assert "此模型" in result["message"] or "GLB" in result["message"]
                if name == "budget":
                    budget_detail_check(result, detail)
            print("PASS corrupt/external-resource/decoded-budget rejection with localized errors", flush=True)

            held = []
            page.route("**/test-models/delayed.glb", lambda route: held.append(route))
            with page.expect_request("**/test-models/delayed.glb"):
                page.evaluate("r => {void window.trivorQuickLook.loadModel(r)}", {"url": base + "/test-models/delayed.glb", "name": "delayed.glb", "locale": "en", "requestId": "stale", **({"budget": budget} if budget else {})})
            page.wait_for_function("document.querySelector('#preview').dataset.state==='loading'")
            assert load(page, base, "cube", "replacement", budget=budget)["type"] == "ready"
            assert held, "replacement must interrupt an in-flight request"
            for route in held:
                try:
                    route.fulfill(body=payloads["broken"], content_type="model/gltf-binary")
                except Exception:
                    pass  # The superseded fetch has already been aborted.
            page.wait_for_load_state("networkidle")
            assert not page.evaluate("window.__messages.some(m => m.requestId==='stale')")
            assert page.evaluate("document.querySelector('#preview').dataset.state") == "ready"
            assert page.locator("model-viewer").count() == 1
            assert page.evaluate("window.__modelBlobs.size") == 1
            page.evaluate("window.trivorQuickLook.dispose()")
            assert page.locator("model-viewer").count() == 0
            assert page.evaluate("window.__modelBlobs.size") == 0
            assert load(page, base, "cube", "after-dispose", budget=budget)["type"] == "ready"
            print("PASS replacement request identity, stale-result cancellation and dispose/reopen", flush=True)

            model_results = []
            if models:
                page.set_viewport_size({"width": 900, "height": 640})
                page.emulate_media(color_scheme="light")
            for index, model in enumerate(models, 1):
                request_id = "local-" + str(index)
                standard_result = None
                if args.compare_standard:
                    standard_id = request_id + "-standard"
                    baseline = load(page, base, request_id, standard_id, display_name=model.name)
                    assert page.evaluate("document.querySelector('#preview').dataset.budgetTier") == "standard"
                    standard_result = {"message": baseline, "tier": "standard"}
                    if baseline["type"] == "ready":
                        standard_result["budget"] = resolved_budget(page, "standard")
                        standard_result["readyMs"] = round(page.evaluate("id => window.__messageTimes[id]-window.__loadStarts[id]", standard_id), 2)
                    else:
                        assert baseline["type"] == "error" and baseline["code"] == "tooLarge", baseline
                        evidence = baseline.get("limit", {})
                        assert evidence.get("actual", 0) > evidence.get("limit", 0) > 0, baseline
                        standard_result["detail"] = page.locator("#status-detail").inner_text()
                        assert "Trivor" in standard_result["detail"]
                    page.evaluate("window.trivorQuickLook.dispose()")
                    assert page.locator("model-viewer").count() == 0
                    assert page.evaluate("window.__modelBlobs.size") == 0
                    print(f"PASS standard comparison {model.name}: {baseline['type']}" + (f" ({baseline['limit']['metric']})" if baseline["type"] == "error" else ""), flush=True)
                result = load(page, base, request_id, request_id, display_name=model.name, budget=budget)
                assert result["type"] == "ready", (str(model), result, console_errors, blocked)
                model_budget = resolved_budget(page, expected_tier)
                ready_ms = page.evaluate("id => window.__messageTimes[id]-window.__loadStarts[id]", request_id)
                assert math.isfinite(ready_ms) and ready_ms >= 0, ready_ms
                slug = re.sub(r"[^A-Za-z0-9_-]+", "-", model.stem).strip("-")[:80] or "model"
                filename = "local-" + str(index) + "-" + slug + ".png"
                rendered = model_canvas_check(page, args.output / filename)
                interactions = model_interaction_check(page)
                assert page.evaluate("window.__modelBlobs.size") == 1
                assert not errors, (str(model), errors)
                page.evaluate("window.trivorQuickLook.dispose()")
                assert page.locator("model-viewer").count() == 0
                assert page.evaluate("window.__modelBlobs.size") == 0
                model_results.append({"path": str(model), "bytes": model.stat().st_size, "readyMs": round(ready_ms, 2),
                                      "png": filename, **rendered, "camera": interactions, "budget": model_budget,
                                      "standardComparison": standard_result, "disposed": True})
                print(f"PASS local model {model.name}: ready {ready_ms:.1f} ms, visible canvas, orbit/zoom/Fit and cleanup", flush=True)

            assert not blocked, blocked
            external_attempts = [url for url in requests if not url.startswith((base + "/", "blob:", "data:"))]
            assert not external_attempts, external_attempts
            assert not errors, errors
            print("PASS no external network and no uncaught JavaScript errors", flush=True)
            report = {"messages": page.evaluate("window.__messages"), "models": model_results,
                      "modelTransport": "http-stream" if args.stream_models else "route-fulfill",
                      "budget": budget, "resolvedBudget": active_budget,
                      "fallbackBudgets": {"default": default_budget, "invalid": rejected_budget},
                      "decoderRequests": [url for url in requests if "/decoders/" in url],
                      "blocked": blocked, "pageErrors": errors, "consoleErrors": console_errors,
                      "cleanup": {"status": "pending"}}
            (args.output / "result.json").write_text(json.dumps(report, indent=2))
        finally:
            cleanup = close_test_browser(p, browser, page)
            if report is not None:
                report["cleanup"] = cleanup
                (args.output / "result.json").write_text(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
