//! macOS-native integrations for Trivor (极视).

#[cfg(target_os = "macos")]
mod vibrancy;

/// macOS window hooks after the Slint window exists (icon, future chrome).
pub fn on_window_ready(window: &winit::window::Window, dark: bool) {
    #[cfg(target_os = "macos")]
    {
        // NSVisualEffectView currently blurs the entire Slint layer on this stack.
        // Glass look is handled in Slint (`GlassSurface` gradients) until per-panel vibrancy is wired.
        let _ = (window, dark);
        tracing::debug!(dark, "macOS window ready");
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, dark);
        tracing::warn!("Trivor targets macOS; vibrancy skipped on this platform");
    }
}

/// Whether macOS is currently using dark mode (best-effort).
#[cfg(target_os = "macos")]
pub fn system_prefers_dark() -> bool {
    std::process::Command::new("defaults")
        .args(["read", "-g", "AppleInterfaceStyle"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim() == "Dark")
        .unwrap_or(true)
}

#[cfg(not(target_os = "macos"))]
pub fn system_prefers_dark() -> bool {
    false
}
