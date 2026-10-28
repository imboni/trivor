"""Render real Quick Look thumbnails with animation frames and observers stopped.

Build with npm run build:quicklook:web and serve src-tauri/.bundle/quicklook-web.
Requires Python Playwright, Pillow, Chromium and the installed offline encoders.
"""
import argparse
import base64
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("quicklook", Path(__file__).with_name("browser-quicklook.py"))
quicklook = importlib.util.module_from_spec(spec)
spec.loader.exec_module(quicklook)

INIT = r"""
window.__messages = [];
window.webkit = {messageHandlers:{thumbnail:{postMessage(value){window.__messages.push(value);}}}};
window.__rafCalls = 0;
window.requestAnimationFrame = () => ++window.__rafCalls;
window.cancelAnimationFrame = () => {};
window.ResizeObserver = class { observe(){} unobserve(){} disconnect(){} };
window.IntersectionObserver = class { observe(){} unobserve(){} disconnect(){} };
window.__blobs = new Set();
const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
URL.createObjectURL = value => { const url=create(value); if(value.type==='model/gltf-binary')window.__blobs.add(url); return url; };
URL.revokeObjectURL = url => { window.__blobs.delete(url); return revoke(url); };
"""


def render(page, base, name, request_id, size=512, url=None):
    page.evaluate("r => window.trivorThumbnail.render(r)", {
        "url": url or (base + "/test-models/" + name + ".glb"),
        "name": name + ".glb", "requestId": request_id, "size": size, "locale": "en",
    })
    page.wait_for_function("id => window.__messages.some(m => m.requestId===id)", arg=request_id, polling=100, timeout=20000)
    return page.evaluate("id => window.__messages.find(m => m.requestId===id)", request_id)


def check_image(message, size, path):
    assert message["type"] == "ready", message
    data = base64.b64decode(message["png"], validate=True)
    path.write_bytes(data)
    image = Image.open(io.BytesIO(data)).convert("RGBA")
    assert image.size == (size, size), image.size
    pixels = list(image.getdata())
    alpha = [p[3] for p in pixels]
    assert min(alpha) == 0 and max(alpha) == 255, (min(alpha), max(alpha))
    drawn = sum(1 for value in alpha if value > 30)
    assert size * size * .05 < drawn < size * size * .95, ("empty or unframed thumbnail", drawn)
    colored = sum(1 for r, g, b, a in pixels if a > 30 and max(r, g, b) - min(r, g, b) > 45)
    assert colored > size * size * .04, ("no colored model surface", colored)
    bounds = image.getchannel("A").getbbox()
    assert bounds and all(value > 0 for value in bounds[:2]) and bounds[2] < size and bounds[3] < size, bounds
    return {"size": size, "bytes": len(data), "drawnPixels": drawn, "bounds": bounds}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default=os.environ.get("TRIVOR_QUICKLOOK_URL", "http://127.0.0.1:1434"))
    parser.add_argument("--output", type=Path, default=Path(tempfile.gettempdir()) / "trivor-thumbnail-browser")
    args = parser.parse_args()
    base = args.base.rstrip("/")
    payloads = quicklook.fixtures(args.output / "fixtures")
    with sync_playwright() as p:
        executable = os.environ.get("TRIVOR_CHROME")
        if not executable and Path("/Applications/Google Chrome.app").exists():
            executable = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        browser = p.chromium.launch(headless=True, executable_path=executable,
                                   args=["--enable-webgl", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        try:
            page = browser.new_page(viewport={"width": 900, "height": 640}, device_scale_factor=2)
            errors, blocked, requests, results = [], [], [], {}
            page.on("pageerror", lambda error: errors.append(str(error)))
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
            page.add_init_script(INIT)
            page.goto(base + "/thumbnail.html")
            page.wait_for_load_state("networkidle")
            page.wait_for_function("window.trivorThumbnail && window.__messages.some(m => m.type==='boot')", polling=100)
            for name in ["cube", "meshopt", "draco", "ktx2"]:
                message = render(page, base, name, "decode-" + name)
                results[name] = check_image(message, 512, args.output / (name + ".png"))
                assert page.locator("model-viewer").count() == 0
                assert page.evaluate("window.__blobs.size") == 0
                print("PASS transparent " + name + " thumbnail without RAF or observers", flush=True)
            for size in [128, 1024]:
                results[str(size)] = check_image(render(page, base, "cube", "size-" + str(size), size), size, args.output / ("cube-" + str(size) + ".png"))
            assert page.evaluate("window.devicePixelRatio") == 2
            print("PASS requested output dimensions independent of DPR", flush=True)
            for name, code in [("broken", "invalid"), ("external", "externalResources"), ("budget", "tooLarge")]:
                result = render(page, base, name, "error-" + name)
                assert result["type"] == "error" and result["code"] == code, result
            for index, size in enumerate([0, 1025, 1.5]):
                result = render(page, base, "cube", "invalid-size-" + str(index), size)
                assert result["type"] == "error" and result["code"] == "invalid", result
            result = render(page, base, "cube", "remote-url", url="https://example.invalid/model.glb")
            assert result["type"] == "error" and result["code"] == "externalResources", result
            print("PASS invalid files, external resources, budgets and dimensions", flush=True)

            held = []
            page.route("**/test-models/delayed.glb", lambda route: held.append(route))
            with page.expect_request("**/test-models/delayed.glb"):
                page.evaluate("r => {void window.trivorThumbnail.render(r)}", {
                    "url": base + "/test-models/delayed.glb", "name": "delayed.glb", "requestId": "stale", "size": 512,
                })
            assert render(page, base, "cube", "replacement")["type"] == "ready"
            for route in held:
                try:
                    route.fulfill(body=payloads["broken"], content_type="model/gltf-binary")
                except Exception:
                    pass
            page.wait_for_load_state("networkidle")
            assert not page.evaluate("window.__messages.some(m => m.requestId==='stale')")
            page.evaluate("window.trivorThumbnail.dispose()")
            assert render(page, base, "cube", "after-dispose")["type"] == "ready"
            assert page.locator("model-viewer").count() == 0 and page.evaluate("window.__blobs.size") == 0
            print("PASS replacement cancellation, cleanup and reopen", flush=True)
            for decoder in ["meshopt/meshopt_decoder.js", "draco/draco_decoder.wasm", "basis/basis_transcoder.wasm"]:
                assert any(url.endswith("/decoders/" + decoder) for url in requests), (decoder, requests)
            assert not blocked, blocked
            assert not errors, errors
            assert page.evaluate("window.__rafCalls") > 0, "model-viewer attempted RAF, but none executed"
            summary = {"images": results, "decoderRequests": [url for url in requests if "/decoders/" in url], "blocked": blocked, "pageErrors": errors}
            (args.output / "result.json").write_text(json.dumps(summary, indent=2))
            print("PASS offline decoder requests and no uncaught JavaScript errors", flush=True)
        finally:
            browser.close()


if __name__ == "__main__":
    main()
