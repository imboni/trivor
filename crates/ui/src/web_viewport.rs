//! Google model-viewer embedded over the central viewport (macOS).
//!
//! Stored on the UI thread only — `WebView` is not `Send`.

use std::cell::RefCell;

use slint::ComponentHandle;
use slint::winit_030::WinitWindowAccessor;

use crate::slint_ui::MainWindow;
use trivor_viewer::{ModelViewerWeb, ViewportRect};

thread_local! {
    static MODEL_VIEWER: RefCell<Option<ModelViewerWeb>> = const { RefCell::new(None) };
}

/// Logical layout of the central viewport (matches `TrivorTokens` + top bar in `main.slint`).
pub fn viewport_logical_rect(ui: &MainWindow) -> ViewportRect {
    let scale = ui.window().scale_factor() as f64;
    let win = ui.window().size();
    let w = win.width as f64 / scale;
    let h = win.height as f64 / scale;
    let sidebar = 280.0;
    let panel = 320.0;
    let top = 58.0;
    ViewportRect {
        x: sidebar,
        y: top,
        width: (w - sidebar - panel).max(64.0),
        height: (h - top).max(64.0),
    }
}

pub fn ensure_attached(ui: &MainWindow) -> bool {
    MODEL_VIEWER.with(|cell| {
        if cell.borrow().is_some() {
            return true;
        }
        let created = ui.window().with_winit_window(|winit_window| {
            ModelViewerWeb::attach(winit_window).ok()
        });
        if let Some(viewer) = created.flatten() {
            *cell.borrow_mut() = Some(viewer);
            true
        } else {
            false
        }
    })
}

pub fn sync(ui: &MainWindow) {
    let rect = viewport_logical_rect(ui);
    let show = ui.get_show_viewport() && !ui.get_show_loading();
    let _ = ui.window().with_winit_window(|winit_window| {
        MODEL_VIEWER.with(|cell| {
            if let Some(viewer) = cell.borrow().as_ref() {
                viewer.set_visible(winit_window, show, rect);
                let _ = viewer.flush_pending_load();
            }
        });
    });
}

pub fn load_model(path: &std::path::Path) -> Result<(), String> {
    with_viewer(|viewer| viewer.load_model(path))
        .ok_or_else(|| "model viewer not ready".to_string())?
}

fn with_viewer<R>(f: impl FnOnce(&ModelViewerWeb) -> R) -> Option<R> {
    MODEL_VIEWER.with(|cell| {
        let guard = cell.borrow();
        guard.as_ref().map(f)
    })
}

pub fn clear_model() {
    MODEL_VIEWER.with(|cell| {
        if let Some(viewer) = cell.borrow().as_ref() {
            viewer.clear_model();
        }
    });
}
