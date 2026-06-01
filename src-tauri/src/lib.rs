mod chrome;
mod commands;
mod menu;
mod open_external;

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{Manager, RunEvent};
use trivor_core::{LocalePreference, ThemePreference};
use trivor_loaders::{ensure_gltfpack_configured, set_gltfpack_dev_bundle, set_viewer_cache_dir};

use open_external::{enqueue_external_open, FrontendReady, PendingOpens};

pub struct AppState {
    pub locale: LocalePreference,
    pub theme: ThemePreference,
}

fn system_prefers_dark() -> bool {
    matches!(dark_light::detect(), Ok(dark_light::Mode::Dark))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "trivor=info".into()),
        )
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(Mutex::new(AppState {
            locale: LocalePreference::System,
            theme: ThemePreference::System,
        }))
        .manage(PendingOpens(Mutex::new(Vec::new())))
        .manage(FrontendReady(Mutex::new(false)))
        .invoke_handler(tauri::generate_handler![
            commands::get_ui_bundle,
            commands::set_locale,
            commands::set_theme,
            commands::normalize_model_path,
            commands::model_file_size,
            commands::viewer_cache_size,
            commands::clear_viewer_cache_cmd,
            commands::open_model_dialog,
            commands::open_folder_dialog,
            commands::scan_models_folder,
            commands::resolve_viewer_model_path,
            commands::load_model,
            commands::reveal_in_finder,
            commands::get_app_info,
            commands::check_for_updates,
            commands::download_update,
            commands::open_downloaded_update,
            open_external::complete_startup,
            open_external::path_kind,
        ])
        .setup(|app| {
            let handle = app.handle();

            if let Ok(cache) = handle.path().app_cache_dir() {
                let viewer_cache = cache.join("viewer");
                let _ = std::fs::create_dir_all(&viewer_cache);
                set_viewer_cache_dir(viewer_cache);
            }

            ensure_gltfpack_configured();
            set_gltfpack_dev_bundle(PathBuf::from(env!("CARGO_MANIFEST_DIR")));

            let window = app.get_webview_window("main").expect("main window");

            let icon = tauri::include_image!("icons/icon.png");
            let _ = window.set_icon(icon);

            let state = app.state::<Mutex<AppState>>();
            let guard = state.lock().expect("app state");
            let resolved = guard.theme.resolve(system_prefers_dark());
            drop(guard);
            chrome::apply(&window, resolved);

            menu::install(handle)?;

            Ok(())
        })
        .on_menu_event(|app, event| {
            menu::handle_event(app, &event);
        })
        .build(tauri::generate_context!())
        .expect("error building Trivor")
        .run(|app, event| {
            if let RunEvent::Opened { urls } = event {
                for url in urls {
                    if let Ok(path) = url.to_file_path() {
                        enqueue_external_open(app, path);
                    }
                }
            }
        });
}
