//! Borderless child `NSWindow` above Slint so WKWebView is not covered by the GL layer.

use objc2::msg_send;
use objc2::rc::Retained;
use objc2_app_kit::{NSColor, NSView, NSWindow, NSWindowOrderingMode, NSWindowStyleMask};
use objc2_foundation::{MainThreadMarker, NSRect, NSSize};
use raw_window_handle::{AppKitWindowHandle, HandleError, HasWindowHandle, RawWindowHandle, WindowHandle};
use std::ffi::c_void;
use std::ptr::NonNull;
use wry::WebViewBuilder;

use crate::{serve_trivor_request, ViewportRect};

/// Host view handle for `wry::WebViewBuilder::build_as_child`.
pub struct ChildContentHost {
    view: Retained<NSView>,
}

impl HasWindowHandle for ChildContentHost {
    fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
        let ptr = NonNull::new((&*self.view as *const NSView as *mut c_void))
            .ok_or(HandleError::Unavailable)?;
        Ok(unsafe {
            WindowHandle::borrow_raw(RawWindowHandle::AppKit(AppKitWindowHandle::new(ptr)))
        })
    }
}

pub struct MacOverlay {
    child_window: Retained<NSWindow>,
    webview: wry::WebView,
}

impl MacOverlay {
    pub fn attach(parent: &winit::window::Window) -> Result<Self, wry::Error> {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};

        crate::PAGE_READY.store(false, std::sync::atomic::Ordering::SeqCst);
        crate::NEED_LOAD.store(false, std::sync::atomic::Ordering::SeqCst);

        let mtm = MainThreadMarker::new().expect("main thread");
        let parent_window = parent
            .window_handle()
            .map_err(|e| wry::Error::Io(std::io::Error::other(e.to_string())))?;
        let RawWindowHandle::AppKit(appkit) = parent_window.as_raw() else {
            return Err(wry::Error::Io(std::io::Error::other(
                "expected AppKit parent window",
            )));
        };

        unsafe {
            let parent_ptr = appkit.ns_view.as_ptr() as *mut NSView;
            let Some(parent_view) = Retained::retain(parent_ptr) else {
                return Err(wry::Error::Io(std::io::Error::other("invalid parent NSView")));
            };
            let Some(parent_ns_window) = parent_view.window() else {
                return Err(wry::Error::Io(std::io::Error::other("no parent NSWindow")));
            };

            let initial = viewport_to_screen_frame(&parent_ns_window, ViewportRect {
                x: 280.0,
                y: 58.0,
                width: 600.0,
                height: 400.0,
            });

            let child = NSWindow::new(mtm);
            child.setStyleMask(NSWindowStyleMask::Borderless);
            child.setFrame_display(initial, false);
            child.setParentWindow(Some(&parent_ns_window));
            parent_ns_window.addChildWindow_ordered(&child, NSWindowOrderingMode::Above);
            child.setOpaque(false);
            child.setBackgroundColor(Some(&NSColor::clearColor()));
            child.setHasShadow(false);
            child.setIgnoresMouseEvents(false);
            child.setIsVisible(false);

            let content = child.contentView().expect("child content view");
            let host = ChildContentHost { view: content };

            let webview = WebViewBuilder::new()
                .with_url("trivor://viewer/index.html")
                .with_custom_protocol("trivor".into(), |_id, request| {
                    serve_trivor_request(&request)
                })
                .with_on_page_load_handler(|_event, url| {
                    if url.contains("trivor://viewer") {
                        tracing::debug!(%url, "model-viewer page ready (overlay)");
                        crate::PAGE_READY.store(true, std::sync::atomic::Ordering::SeqCst);
                    }
                })
                .with_background_color((10, 10, 15, 255))
                .build_as_child(&host)?;

            tracing::info!("model-viewer overlay window created");
            Ok(Self {
                child_window: child,
                webview,
            })
        }
    }

    pub fn set_visible(&self, parent: &winit::window::Window, visible: bool, rect: ViewportRect) {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};

        let _ = self.webview.set_visible(visible);
        self.child_window.setIsVisible(visible);

        if !visible || !rect.is_visible() {
            return;
        }

        if let Ok(handle) = parent.window_handle() {
            if let RawWindowHandle::AppKit(appkit) = handle.as_raw() {
                unsafe {
                    if let Some(parent_view) =
                        Retained::retain(appkit.ns_view.as_ptr() as *mut NSView)
                    {
                        if let Some(parent_ns_window) = parent_view.window() {
                            let frame = viewport_to_screen_frame(&parent_ns_window, rect);
                            tracing::debug!(
                                x = frame.origin.x,
                                y = frame.origin.y,
                                w = frame.size.width,
                                h = frame.size.height,
                                "overlay frame"
                            );
                            self.child_window.setFrame_display(frame, true);
                            parent_ns_window.addChildWindow_ordered(
                                &self.child_window,
                                NSWindowOrderingMode::Above,
                            );
                        }
                    }
                }
            }
        }
    }

    pub fn webview(&self) -> &wry::WebView {
        &self.webview
    }
}

/// Map viewport top-left logical rect to screen-space `NSRect`.
unsafe fn viewport_to_screen_frame(parent: &NSWindow, rect: ViewportRect) -> NSRect {
    let content = parent.contentView().unwrap();
    let scale = parent.backingScaleFactor();
    let local = NSRect::new(
        objc2_foundation::NSPoint::new(rect.x * scale, rect.y * scale),
        NSSize::new(rect.width * scale, rect.height * scale),
    );
    let in_window = content.convertRectToBase(local);
    parent.convertRectToScreen(in_window)
}
