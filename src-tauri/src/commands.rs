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
pub async fn resolve_viewer_model_path(
    path: String,
    window: WebviewWindow,
    state: State<'_, Mutex<AppState>>,
) -> Result<String, String> {
    let locale = state.lock().expect("app state").locale;
    let window = window.clone();
    async_runtime::spawn_blocking(move || {
        let i18n = I18n::new(locale);
        let progress = move |pct: u8| {
            let _ = window.emit("pack-progress", LoadProgress { percent: pct });
        };
        resolve_viewer_model(Path::new(&path), Some(&progress))
            .map(|p| p.to_string_lossy().into_owned())
            .map_err(|e| format_load_error(e, &i18n))
    })
    .await
    .map_err(|e| e.to_string())?
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

#[tauri::command]
pub fn reveal_in_finder(path: String) -> Result<(), String> {
    let path = Path::new(&path);
    if !path.exists() {
        return Err(format!("Path not found: {}", path.display()));
    }

    let status = reveal_path_in_file_manager(path).map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "Failed to reveal {} (exit {:?})",
            path.display(),
            status.code()
        ))
    }
}

fn reveal_path_in_file_manager(path: &Path) -> std::io::Result<std::process::ExitStatus> {
    use std::process::Command;

    #[cfg(target_os = "macos")]
    {
        if path.is_dir() {
            Command::new("open").arg(path).status()
        } else {
            Command::new("open").args(["-R"]).arg(path).status()
        }
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(format!("/select,{}", path.display()))
            .status()
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let target = if path.is_dir() {
            path
        } else {
            path.parent().unwrap_or(path)
        };
        Command::new("xdg-open").arg(target).status()
    }
}

#[derive(serde::Serialize)]
pub struct AppInfo {
    pub version: String,
    pub build_date: String,
    pub repository: String,
    pub homepage: String,
    pub issues_url: String,
    pub releases_url: String,
    pub license: String,
    pub copyright: String,
}

#[derive(serde::Serialize)]
pub struct UpdateCheckResult {
    pub current_version: String,
    pub latest_version: Option<String>,
    pub latest_published_at: Option<String>,
    pub update_available: bool,
    pub release_page: Option<String>,
    pub download_url: Option<String>,
}

#[derive(serde::Deserialize)]
struct GhRelease {
    tag_name: String,
    html_url: String,
    published_at: Option<String>,
    assets: Vec<GhAsset>,
    prerelease: bool,
    draft: bool,
}

#[derive(serde::Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
}

const APP_COPYRIGHT: &str = "Copyright © 2026 imboni and contributors.";
const APP_REPOSITORY: &str = "https://github.com/imboni/trivor";
const APP_GITHUB_REPO: &str = "imboni/trivor";

fn package_repository() -> String {
    let repo = env!("CARGO_PKG_REPOSITORY");
    if repo.is_empty() {
        APP_REPOSITORY.to_string()
    } else {
        repo.to_string()
    }
}

fn github_repo_path(repository: &str) -> String {
    let trimmed = repository
        .trim_start_matches("https://github.com/")
        .trim_end_matches(".git");
    if trimmed.is_empty() {
        APP_GITHUB_REPO.to_string()
    } else {
        trimmed.to_string()
    }
}

#[tauri::command]
pub fn get_app_info() -> AppInfo {
    let repository = package_repository();
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        build_date: env!("BUILD_DATE").to_string(),
        repository: repository.clone(),
        homepage: env!("CARGO_PKG_HOMEPAGE").to_string(),
        issues_url: format!("{repository}/issues"),
        releases_url: format!("{repository}/releases"),
        license: env!("CARGO_PKG_LICENSE").to_string(),
        copyright: APP_COPYRIGHT.to_string(),
    }
}

#[tauri::command]
pub fn check_for_updates() -> Result<UpdateCheckResult, String> {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let repository = package_repository();
    let repo_path = github_repo_path(&repository);

    let url = format!("https://api.github.com/repos/{repo_path}/releases/latest");
    let response = match ureq::get(&url)
        .set("Accept", "application/vnd.github+json")
        .set("User-Agent", "Trivor")
        .call()
    {
        Ok(response) => response,
        Err(ureq::Error::Status(404, _)) => return Ok(up_to_date_result(current)),
        Err(e) => return Err(format!("Network error: {e}")),
    };

    if response.status() != 200 {
        if response.status() == 404 {
            return Ok(up_to_date_result(current));
        }
        return Err(format!("GitHub API returned {}", response.status()));
    }

    let body = response.into_string().map_err(|e| e.to_string())?;
    let release: GhRelease = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    if release.draft || release.prerelease {
        return Ok(up_to_date_result(current));
    }

    let latest = release.tag_name.trim_start_matches('v').to_string();
    let update_available = is_version_newer(&latest, &current);
    let download_url = release
        .assets
        .iter()
        .find(|a| a.name.ends_with(".dmg"))
        .map(|a| a.browser_download_url.clone());
    let latest_published_at = release.published_at.map(|value| value[..10.min(value.len())].to_string());

    Ok(UpdateCheckResult {
        current_version: current,
        latest_version: Some(latest),
        latest_published_at,
        update_available,
        release_page: Some(release.html_url),
        download_url,
    })
}

fn up_to_date_result(current_version: String) -> UpdateCheckResult {
    UpdateCheckResult {
        current_version,
        latest_version: None,
        latest_published_at: None,
        update_available: false,
        release_page: None,
        download_url: None,
    }
}

fn is_version_newer(latest: &str, current: &str) -> bool {
    let latest_parts = parse_version(latest);
    let current_parts = parse_version(current);
    let len = latest_parts.len().max(current_parts.len());
    for i in 0..len {
        let l = *latest_parts.get(i).unwrap_or(&0);
        let c = *current_parts.get(i).unwrap_or(&0);
        if l > c {
            return true;
        }
        if l < c {
            return false;
        }
    }
    false
}

fn parse_version(version: &str) -> Vec<u32> {
    version
        .trim_start_matches('v')
        .split('.')
        .filter_map(|part| part.parse().ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{is_version_newer, up_to_date_result};

    #[test]
    fn up_to_date_result_has_no_update() {
        let result = up_to_date_result("0.0.2".to_string());
        assert!(!result.update_available);
        assert!(result.latest_version.is_none());
    }

    #[test]
    fn is_version_newer_compares_semver() {
        assert!(is_version_newer("0.0.3", "0.0.2"));
        assert!(is_version_newer("1.0.0", "0.9.9"));
        assert!(!is_version_newer("0.0.2", "0.0.2"));
        assert!(!is_version_newer("0.0.1", "0.0.2"));
    }
}
