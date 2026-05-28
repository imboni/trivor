use tauri::{Theme as TauriTheme, WebviewWindow};
use trivor_core::Theme;

pub fn apply(window: &WebviewWindow, theme: Theme) {
    let dark = theme == Theme::Dark;
    let _ = window.set_theme(if dark {
        Some(TauriTheme::Dark)
    } else {
        Some(TauriTheme::Light)
    });

    #[cfg(target_os = "macos")]
    apply_vibrancy_macos(window, dark);
}

#[cfg(target_os = "macos")]
fn apply_vibrancy_macos(window: &WebviewWindow, dark: bool) {
    use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};

    let material = if dark {
        NSVisualEffectMaterial::HudWindow
    } else {
        NSVisualEffectMaterial::Popover
    };
    if let Err(e) = apply_vibrancy(window, material, None, None) {
        tracing::debug!(%e, "vibrancy not applied");
    }
}
