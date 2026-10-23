"""Check overlay-titlebar hit testing with the real app markup and styles.

Run: python3 tests/browser-chrome.py
Requires Python Playwright and Chromium (or TRIVOR_CHROME). No server or build.
Native traffic lights, vibrancy and system appearance need a macOS app check.
"""
import os
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def main():
    source = (ROOT / "src/app.ts").read_text()
    shell = source.split("const SHELL_HTML = `", 1)[1].split("`;", 1)[0]
    assert "${" not in shell, "App markup now needs template evaluation"
    styles = "\n".join((ROOT / f"src/styles/{name}.css").read_text()
                       for name in ("tokens", "layout", "components"))
    executable = os.environ.get("TRIVOR_CHROME")
    if not executable and Path("/Applications/Google Chrome.app").exists():
        executable = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=executable)
        try:
            page = browser.new_page(reduced_motion="reduce")
            for width, height in [(1024, 680), (1280, 840)]:
                page.set_viewport_size({"width": width, "height": height})
                for theme in ("light", "dark"):
                    page.set_content(
                        f'<html class="is-macos-overlay-titlebar" data-theme="{theme}">'
                        f'<head><style>{styles}</style></head>'
                        f'<body><div id="app"><div class="shell">{shell}</div></div></body></html>'
                    )
                    assert page.evaluate("document.elementFromPoint(400, 20).classList.contains('titlebar-drag')")

                    # Settings should intercept its entire backdrop, including
                    # the titlebar area, instead of accidentally moving the app.
                    page.locator(".settings-backdrop").evaluate("el => el.classList.remove('hidden')")
                    assert page.evaluate("!!document.elementFromPoint(400, 20).closest('.settings-backdrop')")
                    page.locator(".settings-backdrop").evaluate("el => el.classList.add('hidden')")

                    page.locator(".cutout-backdrop").evaluate("el => el.classList.remove('hidden')")
                    page.locator(".cutout-panel").evaluate("el => el.classList.remove('hidden')")
                    close = page.locator('[data-action="close-cutout-flow"]')
                    close.evaluate("el => { window.closeClicks = 0; el.addEventListener('click', () => window.closeClicks++); }")
                    rect = close.bounding_box()
                    assert rect and rect["y"] < 52, "Exercise the titlebar overlap"
                    for offset in (2, rect["height"] / 2, rect["height"] - 2):
                        x, y = rect["x"] + rect["width"] / 2, rect["y"] + offset
                        hit = page.evaluate("([x,y]) => document.elementFromPoint(x,y)?.closest('[data-action]')?.dataset.action", [x, y])
                        assert hit == "close-cutout-flow", (width, height, theme, x, y, hit)
                        page.mouse.click(x, y)
                    assert page.evaluate("window.closeClicks") == 3
                    print(f"PASS overlay modal controls: {width}x{height} {theme}")
        finally:
            browser.close()


if __name__ == "__main__":
    main()
