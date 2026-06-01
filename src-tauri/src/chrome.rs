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
    use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};

    if let Err(e) = window.set_title_bar_style(TitleBarStyle::Overlay) {
        tracing::warn!(%e, "failed to set overlay title bar");
    }

    let material = NSVisualEffectMaterial::Sidebar;
    if let Err(e) = apply_vibrancy(
        window,
        material,
        Some(NSVisualEffectState::Active),
        None,
    ) {
        tracing::debug!(%e, "vibrancy not applied");
    }

    // Transparent webview: HTML paints viewport grid; native vibrancy frosts panels.
    if let Err(e) = window.set_background_color(Some(Color(0, 0, 0, 0))) {
        tracing::debug!(%e, "transparent webview background not applied");
        let _ = window.set_background_color(Some(viewport_background(dark)));
    }
}
