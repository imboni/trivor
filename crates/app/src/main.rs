//! Trivor (极视) — native 3D model viewer for macOS.

fn main() {
    // Tracing is initialized in trivor_ui::run (M0).
    if let Err(err) = trivor_ui::run() {
        eprintln!("Trivor failed to start: {err}");
        std::process::exit(1);
    }
}
