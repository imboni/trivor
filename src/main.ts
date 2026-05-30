import "./fonts";
import { App } from "./app";

/** WKWebView in Tauri sometimes ignores % height until innerHeight is applied. */
function lockViewportHeight(): void {
  const h = `${window.innerHeight}px`;
  document.documentElement.style.height = h;
  document.body.style.height = h;
}

lockViewportHeight();
window.addEventListener("resize", lockViewportHeight);

const root = document.getElementById("app");
if (!root) throw new Error("#app missing");

const app = new App(root);
void app.start();
