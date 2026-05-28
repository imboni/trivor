//! Trivor brand assets (logos, window icon).

/// Dock / title-bar icon from the transparent mark (`assets/logo.png`).
pub fn window_icon() -> Option<slint::winit_030::winit::window::Icon> {
    let img = image::load_from_memory(include_bytes!("../assets/logo.png")).ok()?;
    let rgba = img.to_rgba8();
    let (w, h) = rgba.dimensions();
    slint::winit_030::winit::window::Icon::from_rgba(rgba.into_raw(), w, h).ok()
}
