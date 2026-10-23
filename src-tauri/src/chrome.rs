use tauri::window::Color;
use tauri::{Theme as TauriTheme, TitleBarStyle, WebviewWindow};
use trivor_core::Theme;

/// Matches `--viewport-bg-top` in `src/styles/tokens.css` (fallback under transparent webview).
fn viewport_background(dark: bool) -> Color {
    if dark {
        Color(13, 14, 17, 255)
    } else {
        Color(220, 227, 240, 255)
    }
}

pub fn apply(window: &WebviewWindow, theme: Theme, follow_system: bool) {
    let dark = theme == Theme::Dark;
    // On macOS this sets NSApplication.appearance. An explicit appearance also
    // pins WKWebView's prefers-color-scheme, so System must restore inheritance.
    let native_theme = if follow_system {
        None
    } else if dark {
        Some(TauriTheme::Dark)
    } else {
        Some(TauriTheme::Light)
    };

    #[cfg(target_os = "macos")]
    {
        let native_window = window.clone();
        if let Err(e) = window.run_on_main_thread(move || {
            if let Err(e) = native_window.set_theme(native_theme) {
                tracing::warn!(%e, "failed to apply native theme");
            }
            apply_macos(&native_window, dark);
        }) {
            tracing::warn!(%e, "failed to update native window appearance");
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = window.set_theme(native_theme);
        let _ = window.set_background_color(Some(viewport_background(dark)));
    }
}

#[cfg(target_os = "macos")]
fn apply_macos(window: &WebviewWindow, dark: bool) {
    use window_vibrancy::{
        apply_vibrancy, clear_vibrancy, NSVisualEffectMaterial, NSVisualEffectState,
    };

    if let Err(e) = window.set_title_bar_style(TitleBarStyle::Overlay) {
        tracing::warn!(%e, "failed to set overlay title bar");
    }

    // window-vibrancy adds a new NSVisualEffectView on each call. Replace its
    // existing view so switching themes cannot accumulate full-window blurs.
    let vibrancy = clear_vibrancy(window).and_then(|_| {
        apply_vibrancy(
            window,
            NSVisualEffectMaterial::Sidebar,
            Some(NSVisualEffectState::FollowsWindowActiveState),
            None,
        )
    });
    if let Err(e) = vibrancy {
        tracing::debug!(%e, "vibrancy not applied");
    }

    // Transparent webview: HTML paints viewport grid; native vibrancy frosts panels.
    if let Err(e) = window.set_background_color(Some(Color(0, 0, 0, 0))) {
        tracing::debug!(%e, "transparent webview background not applied");
        let _ = window.set_background_color(Some(viewport_background(dark)));
    }
}
