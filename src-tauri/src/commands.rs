use std::path::Path;
use std::sync::Mutex;

use tauri::{async_runtime, Emitter, State, WebviewWindow};
use trivor_core::{LocalePreference, ModelListEntry, SceneSummary, ThemePreference};
use trivor_i18n::{I18n, MessageKey, UiBundle};
use trivor_loaders::{list_models_in_folder, load_scene_summary, resolve_viewer_model, LoadError};

use crate::chrome;
use crate::menu;
use crate::AppState;

#[derive(serde::Serialize, Clone)]
pub struct LoadProgress {
    pub percent: u8,
}

fn system_prefers_dark() -> bool {
    matches!(dark_light::detect(), Ok(dark_light::Mode::Dark))
}

fn build_bundle(state: &AppState) -> UiBundle {
    let i18n = trivor_i18n::I18n::new(state.locale);
    UiBundle::from_prefs(
        &i18n,
        state.locale,
        state.theme,
        system_prefers_dark(),
    )
}

#[tauri::command]
pub fn get_ui_bundle(state: State<'_, Mutex<AppState>>) -> UiBundle {
    let state = state.lock().expect("app state");
    build_bundle(&state)
}

#[tauri::command]
pub fn set_locale(
    preference: String,
    app: tauri::AppHandle,
    state: State<'_, Mutex<AppState>>,
) -> UiBundle {
    let pref = match preference.as_str() {
        "en" => LocalePreference::En,
        "zh-Hans" => LocalePreference::ZhHans,
        "system" => LocalePreference::System,
        _ => LocalePreference::System,
    };
    let mut guard = state.lock().expect("app state");
    guard.locale = pref;
    let bundle = build_bundle(&guard);
    drop(guard);
    if let Err(e) = menu::install(&app) {
        tracing::warn!(%e, "failed to rebuild app menu after locale change");
    }
    bundle
}

#[tauri::command]
pub fn set_theme(
    preference: String,
    window: WebviewWindow,
    state: State<'_, Mutex<AppState>>,
) -> UiBundle {
    let pref = match preference.as_str() {
        "dark" => ThemePreference::Dark,
        "light" => ThemePreference::Light,
        "system" => ThemePreference::System,
        _ => ThemePreference::System,
    };
    {
        let mut guard = state.lock().expect("app state");
        guard.theme = pref;
    }
    let bundle = build_bundle(&state.lock().expect("app state"));
    let resolved = match bundle.theme {
        "light" => trivor_core::Theme::Light,
        _ => trivor_core::Theme::Dark,
    };
    chrome::apply(&window, resolved);
    bundle
}

fn canonicalize_path(path: &Path) -> String {
    path.canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

#[tauri::command]
pub fn normalize_model_path(path: String) -> Result<String, String> {
    Ok(canonicalize_path(Path::new(&path)))
}

#[tauri::command]
pub fn open_model_dialog(state: State<'_, Mutex<AppState>>) -> Option<String> {
    let state = state.lock().expect("app state");
    let i18n = I18n::new(state.locale);
    let filter = i18n.t(MessageKey::FileDialogFilter);
    rfd::FileDialog::new()
        .add_filter(filter, &["gltf", "glb"])
        .pick_file()
        .map(|p| canonicalize_path(&p))
}

#[tauri::command]
pub fn open_folder_dialog() -> Option<String> {
    rfd::FileDialog::new().pick_folder().map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn scan_models_folder(
    dir: String,
    state: State<'_, Mutex<AppState>>,
) -> Result<Vec<ModelListEntry>, String> {
    let state = state.lock().expect("app state");
    let i18n = I18n::new(state.locale);
    list_models_in_folder(Path::new(&dir)).map_err(|e| format_load_error(e, &i18n))
}

/// Returns a path model-viewer can load (packs separate `.gltf` into a cached `.glb`).
#[tauri::command]
pub fn resolve_viewer_model_path(
    path: String,
    state: State<'_, Mutex<AppState>>,
) -> Result<String, String> {
    let state = state.lock().expect("app state");
    let i18n = I18n::new(state.locale);
    resolve_viewer_model(Path::new(&path))
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| format_load_error(e, &i18n))
}

#[tauri::command]
pub async fn load_model(
    path: String,
    window: WebviewWindow,
    state: State<'_, Mutex<AppState>>,
) -> Result<SceneSummary, String> {
    let _ = window.emit("load-progress", LoadProgress { percent: 0 });

    let locale = state.lock().expect("app state").locale;
    let window = window.clone();
    async_runtime::spawn_blocking(move || {
        let i18n = I18n::new(locale);
        let progress = move |pct: u8| {
            let _ = window.emit("load-progress", LoadProgress { percent: pct });
        };
        load_scene_summary(Path::new(&path), Some(&progress))
            .map_err(|e| format_load_error(e, &i18n))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn format_load_error(err: LoadError, i18n: &I18n) -> String {
    match err {
        LoadError::UnsupportedFormat(ext) => i18n
            .t(MessageKey::ErrorUnsupportedExt)
            .replace("{ext}", &ext),
        LoadError::Io { message, .. } | LoadError::Parse { message, .. } => message,
    }
}
