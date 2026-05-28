//! Embedded [Google model-viewer](https://github.com/google/model-viewer) in a native WebView.

use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use wry::dpi::{LogicalPosition, LogicalSize, Position, Size};
use wry::http::{header::CONTENT_TYPE, Request, Response};
use wry::{Rect, WebView};

#[cfg(not(target_os = "macos"))]
use wry::{PageLoadEvent, WebViewBuilder};

#[cfg(target_os = "macos")]
mod macos_overlay;

pub(crate) const VIEWER_HTML: &str = include_str!("../assets/index.html");
pub(crate) const MODEL_VIEWER_JS: &[u8] = include_bytes!("../assets/model-viewer.min.js");

static MODEL_FILE: Mutex<Option<PathBuf>> = Mutex::new(None);
static PAGE_READY: AtomicBool = AtomicBool::new(false);
static NEED_LOAD: AtomicBool = AtomicBool::new(false);

/// Logical-pixel rectangle for the viewport region inside the host window.
#[derive(Debug, Clone, Copy)]
pub struct ViewportRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl ViewportRect {
    pub fn is_visible(&self) -> bool {
        self.width > 1.0 && self.height > 1.0
    }

    fn to_wry_rect(self) -> Rect {
        Rect {
            position: Position::Logical(LogicalPosition::new(self.x, self.y)),
            size: Size::Logical(LogicalSize::new(
                self.width.max(0.0),
                self.height.max(0.0),
            )),
        }
    }
}

/// Child WebView running model-viewer (camera-controls, PBR, HDR environment).
pub struct ModelViewerWeb {
    #[cfg(target_os = "macos")]
    overlay: macos_overlay::MacOverlay,
    #[cfg(not(target_os = "macos"))]
    webview: WebView,
    #[cfg(not(target_os = "macos"))]
    parent: std::marker::PhantomData<winit::window::Window>,
}

impl ModelViewerWeb {
    /// Attach to an existing winit window.
    pub fn attach(parent: &winit::window::Window) -> Result<Self, wry::Error> {
        PAGE_READY.store(false, Ordering::SeqCst);
        NEED_LOAD.store(false, Ordering::SeqCst);

        #[cfg(target_os = "macos")]
        {
            let overlay = macos_overlay::MacOverlay::attach(parent)?;
            return Ok(Self { overlay });
        }

        #[cfg(not(target_os = "macos"))]
        {
            let webview = WebViewBuilder::new()
                .with_url("trivor://viewer/index.html")
                .with_custom_protocol("trivor".into(), |_id, request| {
                    serve_trivor_request(&request)
                })
                .with_on_page_load_handler(|event, url| {
                    if matches!(PageLoadEvent::Finished, event) && url.starts_with("trivor://") {
                        PAGE_READY.store(true, Ordering::SeqCst);
                    }
                })
                .with_background_color((10, 10, 15, 255))
                .build_as_child(parent)?;
            Ok(Self {
                webview,
                parent: std::marker::PhantomData,
            })
        }
    }

    pub fn set_bounds(&self, _rect: ViewportRect) {
        #[cfg(not(target_os = "macos"))]
        let _ = self.webview.set_bounds(_rect.to_wry_rect());
    }

    pub fn set_visible(&self, parent: &winit::window::Window, visible: bool, rect: ViewportRect) {
        #[cfg(target_os = "macos")]
        {
            self.overlay.set_visible(parent, visible, rect);
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = self.webview.set_visible(visible);
            if visible && rect.is_visible() {
                self.set_bounds(rect);
            }
        }
        if visible {
            let _ = self.flush_pending_load();
        }
    }

    pub fn load_model(&self, path: &Path) -> Result<(), String> {
        let canonical = path
            .canonicalize()
            .map_err(|e| format!("canonicalize {}: {e}", path.display()))?;
        *MODEL_FILE
            .lock()
            .map_err(|_| "model file lock poisoned".to_string())? = Some(canonical);
        NEED_LOAD.store(true, Ordering::SeqCst);
        self.flush_pending_load()
    }

    pub fn clear_model(&self) {
        NEED_LOAD.store(false, Ordering::SeqCst);
        if let Ok(mut slot) = MODEL_FILE.lock() {
            *slot = None;
        }
        let _ = self.webview().evaluate_script(
            "window.trivorReset && window.trivorReset();",
        );
    }

    pub fn flush_pending_load(&self) -> Result<(), String> {
        if !NEED_LOAD.load(Ordering::SeqCst) || !PAGE_READY.load(Ordering::SeqCst) {
            return Ok(());
        }
        let has_file = MODEL_FILE
            .lock()
            .ok()
            .map(|g| g.is_some())
            .unwrap_or(false);
        if !has_file {
            return Ok(());
        }

        self.webview()
            .evaluate_script(
                "window.trivorLoadModel && window.trivorLoadModel('trivor://model/asset');",
            )
            .map_err(|e| e.to_string())?;
        NEED_LOAD.store(false, Ordering::SeqCst);
        tracing::info!("model-viewer loading asset");
        Ok(())
    }

    fn webview(&self) -> &WebView {
        #[cfg(target_os = "macos")]
        return self.overlay.webview();
        #[cfg(not(target_os = "macos"))]
        return &self.webview;
    }

    pub fn raise_using_parent(&self, parent: &winit::window::Window) {
        #[cfg(target_os = "macos")]
        let _ = parent;
        #[cfg(not(target_os = "macos"))]
        let _ = (self, parent);
    }
}

fn protocol_response(
    status: u16,
    mime: &str,
    body: Cow<'static, [u8]>,
) -> Response<Cow<'static, [u8]>> {
    let len = body.len();
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, mime)
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Allow-Methods", "GET")
        .header("Content-Length", len.to_string())
        .body(body)
        .unwrap()
}

pub(crate) fn serve_trivor_request(request: &Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let uri = request.uri().to_string();
    let path = request.uri().path().trim_start_matches('/');

    tracing::trace!(%uri, %path, "trivor protocol request");

    if uri.contains("model-viewer.min.js") || path.ends_with("model-viewer.min.js") {
        return protocol_response(
            200,
            "application/javascript",
            Cow::Borrowed(MODEL_VIEWER_JS),
        );
    }

    if uri.contains("model/asset") || path == "model/asset" {
        let bytes = MODEL_FILE
            .lock()
            .ok()
            .and_then(|g| g.clone())
            .and_then(|p| std::fs::read(&p).ok())
            .unwrap_or_default();
        if bytes.is_empty() {
            tracing::warn!("model asset requested but file missing");
            return protocol_response(404, "text/plain", Cow::Borrowed(b"not found"));
        }
        let mime = MODEL_FILE
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|p| mime_for_model(p)))
            .unwrap_or("model/gltf-binary");
        tracing::info!(bytes = bytes.len(), %mime, "serving model asset");
        return protocol_response(200, mime, Cow::Owned(bytes));
    }

    if uri.contains("index.html") || path.is_empty() || path == "viewer" || path == "viewer/index.html"
    {
        return protocol_response(
            200,
            "text/html; charset=utf-8",
            Cow::Borrowed(VIEWER_HTML.as_bytes()),
        );
    }

    tracing::warn!(%uri, %path, "unknown trivor:// asset");
    protocol_response(404, "text/plain", Cow::Borrowed(b"not found"))
}

fn mime_for_model(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("gltf") => "model/gltf+json",
        Some("glb") => "model/gltf-binary",
        _ => "application/octet-stream",
    }
}
