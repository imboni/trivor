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

pub fn apply(window: &WebviewWindow, theme: Theme) {
    let dark = theme == Theme::Dark;
    let _ = window.set_theme(if dark {
        Some(TauriTheme::Dark)
    } else {
        Some(TauriTheme::Light)
    });

    #[cfg(target_os = "macos")]
    apply_macos(window, dark);

    #[cfg(not(target_os = "macos"))]
    {
        let _ = window.set_background_color(Some(viewport_background(dark)));
    }
}

#[cfg(target_os = "macos")]
fn apply_macos(window: &WebviewWindow, dark: bool) {
    if let Err(e) = window.set_title_bar_style(TitleBarStyle::Overlay) {
        tracing::warn!(%e, "failed to set overlay title bar");
    }

    // Transparent webview: grid/gradient HTML paints the full window including the title bar zone.
    if let Err(e) = window.set_background_color(Some(Color(0, 0, 0, 0))) {
        tracing::debug!(%e, "transparent webview background not applied");
        let _ = window.set_background_color(Some(viewport_background(dark)));
    }
}
