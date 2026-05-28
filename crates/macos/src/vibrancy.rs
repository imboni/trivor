//! Reserved: per-panel `NSVisualEffectView` (disabled — full-window blur broke Slint compositing).
#![allow(dead_code)]

use objc2::rc::Retained;
use objc2::msg_send;
use objc2_app_kit::{
    NSAutoresizingMaskOptions, NSView, NSVisualEffectBlendingMode, NSVisualEffectMaterial,
    NSVisualEffectState, NSVisualEffectView, NSWindowOrderingMode,
};
use objc2_foundation::{MainThreadMarker, NSRect};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};

pub fn apply_vibrancy(window: &winit::window::Window, dark: bool) {
    let handle = match window.window_handle() {
        Ok(h) => h,
        Err(e) => {
            tracing::warn!(%e, "no window handle for vibrancy");
            return;
        }
    };
    let RawWindowHandle::AppKit(appkit) = handle.as_raw() else {
        tracing::warn!("expected AppKit window handle");
        return;
    };

    let mtm = MainThreadMarker::new().expect("must run on main thread");

    unsafe {
        let ns_view_ptr = appkit.ns_view.as_ptr() as *mut NSView;
        if ns_view_ptr.is_null() {
            return;
        }
        let Some(ns_view) = Retained::retain(ns_view_ptr) else {
            return;
        };
        let Some(ns_window) = ns_view.window() else {
            tracing::warn!("no NSWindow for Slint view");
            return;
        };
        let Some(content) = ns_window.contentView() else {
            return;
        };

        let effect = NSVisualEffectView::new(mtm);
        let material = if dark {
            NSVisualEffectMaterial::HUDWindow
        } else {
            NSVisualEffectMaterial::Popover
        };
        effect.setMaterial(material);
        // WithinWindow: blur behind Slint content without requiring a fully transparent window.
        effect.setBlendingMode(NSVisualEffectBlendingMode::WithinWindow);
        effect.setState(NSVisualEffectState::Active);

        let frame: NSRect = msg_send![&*content, bounds];
        effect.setFrame(frame);
        effect.setAutoresizingMask(
            NSAutoresizingMaskOptions::NSViewWidthSizable
                | NSAutoresizingMaskOptions::NSViewHeightSizable,
        );

        content.addSubview_positioned_relativeTo(
            &effect,
            NSWindowOrderingMode::NSWindowBelow,
            None,
        );

    }
}
