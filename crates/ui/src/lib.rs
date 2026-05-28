//! Slint UI shell for Trivor (极视).

mod slint_ui {
    slint::include_modules!();
}

mod branding;
mod theme;

#[cfg(target_os = "macos")]
mod web_viewport;

use std::path::Path;
use std::sync::{Arc, Mutex};

use slint::{ComponentHandle, ModelRc, VecModel};
use slint_ui::{MainWindow, MaterialListItem, ModelListItem};
use trivor_core::{LoadedScene, LocalePreference, ThemePreference};
use trivor_i18n::{I18n, UiStrings};
use trivor_loaders::{load_model_with_progress, LoadError};

pub use slint::PlatformError;

struct AppState {
    locale: LocalePreference,
    theme: ThemePreference,
    loading: bool,
    native_chrome_applied: bool,
}

pub struct AppShell {
    state: Arc<Mutex<AppState>>,
}

impl AppShell {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(AppState {
                locale: LocalePreference::System,
                theme: ThemePreference::Dark,
                loading: false,
                native_chrome_applied: false,
            })),
        }
    }

    pub fn run(self) -> Result<(), PlatformError> {
        let ui = MainWindow::new()?;

        self.apply_theme_for_ui(&ui);
        let locale = self
            .state
            .lock()
            .map(|s| s.locale)
            .unwrap_or(LocalePreference::System);
        self.apply_strings(&ui, locale);
        self.wire_callbacks(&ui);

        ui.run()
    }

    fn try_attach_native_chrome(ui: &MainWindow, dark: bool) -> bool {
        #[cfg(target_os = "macos")]
        {
            use slint::winit_030::WinitWindowAccessor;
            if let Some(()) = ui.window().with_winit_window(|winit_window| {
                if let Some(icon) = branding::window_icon() {
                    winit_window.set_window_icon(Some(icon));
                }
                trivor_macos::on_window_ready(winit_window, dark);
            }) {
                return true;
            }
            false
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (ui, dark);
            false
        }
    }

    fn apply_theme_for_ui(&self, ui: &MainWindow) {
        let pref = self
            .state
            .lock()
            .map(|s| s.theme)
            .unwrap_or(ThemePreference::System);
        let resolved = pref.resolve(trivor_macos::system_prefers_dark());
        theme::apply_theme(ui, resolved);
        ui.set_theme_index(theme_index_from_preference(pref));
    }

    fn apply_strings(&self, ui: &MainWindow, preference: LocalePreference) {
        let i18n = I18n::new(preference);
        let s = UiStrings::from_i18n(&i18n);
        ui.set_window_title(s.window_title.into());
        ui.set_app_name(s.app_name.into());
        ui.set_tagline(s.tagline.into());
        ui.set_open_label(s.open_file.into());
        ui.set_settings_label(s.settings.clone().into());
        ui.set_search_placeholder(s.search_placeholder.into());
        ui.set_sidebar_title(s.sidebar_models.into());
        ui.set_sidebar_empty(s.sidebar_empty.into());
        ui.set_panel_model_title(s.panel_model.into());
        ui.set_panel_dimensions_title(s.panel_dimensions.into());
        ui.set_panel_materials_title(s.panel_materials.into());
        ui.set_empty_title(s.empty_title.into());
        ui.set_empty_subtitle(s.empty_subtitle.into());
        ui.set_metric_format_label(s.metric_format.into());
        ui.set_metric_size_label(s.metric_size.into());
        ui.set_metric_meshes_label(s.metric_meshes.into());
        ui.set_metric_materials_label(s.metric_materials.into());
        ui.set_metric_vertices_label(s.metric_vertices.into());
        ui.set_metric_triangles_label(s.metric_triangles.into());
        ui.set_settings_title(s.settings.clone().into());
        ui.set_language_label(s.language.into());
        ui.set_appearance_label(s.appearance.into());
        ui.set_locale_segment_labels(ModelRc::new(VecModel::from(vec![
            s.lang_en.into(),
            s.lang_zh.into(),
            s.lang_system.into(),
        ])));
        ui.set_theme_segment_labels(ModelRc::new(VecModel::from(vec![
            s.theme_dark.into(),
            s.theme_light.into(),
            s.theme_system.into(),
        ])));
        ui.set_locale_index(locale_index_from_preference(preference));
        ui.set_show_empty(true);
        ui.set_show_loading(false);
        ui.set_show_viewport(false);
        ui.set_loading_percent(0);
        ui.set_status_text("".into());
    }

    fn wire_callbacks(&self, ui: &MainWindow) {
        let ui_weak = ui.as_weak();
        let state = Arc::clone(&self.state);

        ui.on_frame_tick(move || {
            let Some(ui) = ui_weak.upgrade() else {
                return;
            };
            let mut st = state.lock().expect("app state");
            if !st.native_chrome_applied {
                let dark = st.theme.resolve(trivor_macos::system_prefers_dark())
                    == trivor_core::Theme::Dark;
                if AppShell::try_attach_native_chrome(&ui, dark) {
                    st.native_chrome_applied = true;
                }
            }
            #[cfg(target_os = "macos")]
            if st.native_chrome_applied {
                let _ = web_viewport::ensure_attached(&ui);
                web_viewport::sync(&ui);
            }
        });

        let ui_weak = ui.as_weak();
        let state_open = Arc::clone(&self.state);
        ui.on_open_file(move || {
            let Some(path) = rfd::FileDialog::new()
                .add_filter("3D Models", &["glb", "gltf", "obj", "stl"])
                .pick_file()
            else {
                return;
            };
            let locale = state_open
                .lock()
                .map(|s| s.locale)
                .unwrap_or(LocalePreference::System);
            if let Some(ui) = ui_weak.upgrade() {
                ui.set_show_empty(false);
                ui.set_show_viewport(false);
                ui.set_show_loading(true);
                ui.set_loading_percent(0);
                ui.set_status_text(loading_status_text(locale, 0).into());
            }
            {
                let mut st = state_open.lock().expect("app state");
                st.loading = true;
                #[cfg(target_os = "macos")]
                web_viewport::clear_model();
            }
            let ui_weak = ui_weak.clone();
            let state = Arc::clone(&state_open);
            std::thread::spawn(move || {
                let ui_for_progress = ui_weak.clone();
                let state_progress = Arc::clone(&state);
                let progress = move |pct: u8| {
                    let ui_weak = ui_for_progress.clone();
                    let state_progress = Arc::clone(&state_progress);
                    let _ = slint::invoke_from_event_loop(move || {
                        let Some(ui) = ui_weak.upgrade() else {
                            return;
                        };
                        let locale = state_progress
                            .lock()
                            .map(|s| s.locale)
                            .unwrap_or(LocalePreference::System);
                        ui.set_loading_percent(pct as i32);
                        ui.set_status_text(loading_status_text(locale, pct).into());
                    });
                };
                let result = load_model_with_progress(&path, Some(&progress));
                let _ = slint::invoke_from_event_loop(move || {
                    let Some(ui) = ui_weak.upgrade() else {
                        return;
                    };
                    let mut st = state.lock().expect("app state");
                    st.loading = false;
                    ui.set_show_loading(false);
                    ui.set_loading_percent(0);
                    match result {
                        Ok(scene) => {
                            let model_path = scene.source_path.clone();
                            tracing::info!(
                                path = %model_path,
                                verts = scene.stats.vertex_count,
                                tris = scene.stats.triangle_count,
                                materials = scene.stats.material_count,
                                "model loaded"
                            );
                            apply_scene_to_ui(&ui, &scene);
                            ui.set_show_empty(false);
                            ui.set_inspector_visible(true);
                            ui.set_show_viewport(true);
                            ui.set_status_text("".into());

                            #[cfg(target_os = "macos")]
                            {
                                let _ = web_viewport::ensure_attached(&ui);
                                if let Err(err) =
                                    web_viewport::load_model(Path::new(&model_path))
                                {
                                    tracing::warn!(%err, "model-viewer failed");
                                    ui.set_status_text(format!("Preview: {err}").into());
                                }
                                // Retry until page + model are ready (next frames also sync).
                                web_viewport::sync(&ui);
                            }
                        }
                        Err(err) => {
                            tracing::warn!(%err, "model load failed");
                            ui.set_show_empty(true);
                            ui.set_show_viewport(false);
                            ui.set_inspector_visible(false);
                            ui.set_model_list(ModelRc::new(VecModel::from(vec![])).into());
                            ui.set_material_list(ModelRc::new(VecModel::from(vec![])).into());
                            ui.set_status_text(format_load_error(&err).into());
                            #[cfg(target_os = "macos")]
                            {
                                web_viewport::clear_model();
                                web_viewport::sync(&ui);
                            }
                        }
                    }
                });
            });
        });

        let ui_weak = ui.as_weak();
        let state_loc = Arc::clone(&self.state);
        ui.on_locale_changed(move |index| {
            let preference = preference_from_index(index);
            if let Some(ui) = ui_weak.upgrade() {
                let shell = AppShell {
                    state: Arc::clone(&state_loc),
                };
                shell.apply_strings(&ui, preference);
                let mut st = state_loc.lock().expect("app state");
                st.locale = preference;
            }
        });

        let ui_weak = ui.as_weak();
        let state_theme = Arc::clone(&self.state);
        ui.on_theme_changed(move |index| {
            let preference = theme_preference_from_index(index);
            if let Some(ui) = ui_weak.upgrade() {
                let mut st = state_theme.lock().expect("app state");
                st.theme = preference;
                let shell = AppShell {
                    state: Arc::clone(&state_theme),
                };
                shell.apply_theme_for_ui(&ui);
            }
        });

        ui.on_model_selected(|_| {
            // Single-model selection for M1; multi-model history in M2.
        });
    }
}

fn apply_scene_to_ui(ui: &MainWindow, scene: &LoadedScene) {
    let name = Path::new(&scene.source_path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("model");
    let subtitle = format!(
        "{} · {}",
        scene.format.to_uppercase(),
        format_size(scene.file_size)
    );

    ui.set_panel_model_title(name.into());
    ui.set_metric_format_value(scene.format.to_uppercase().into());
    ui.set_metric_size_value(format_size(scene.file_size).into());
    ui.set_metric_meshes_value(scene.stats.mesh_count.to_string().into());
    ui.set_metric_materials_value(scene.stats.material_count.to_string().into());
    ui.set_metric_vertices_value(scene.stats.vertex_count.to_string().into());
    ui.set_metric_triangles_value(scene.stats.triangle_count.to_string().into());
    let [w, h, d] = scene.stats.bounds_size;
    ui.set_metric_dim_w(format!("{w:.3}").into());
    ui.set_metric_dim_h(format!("{h:.3}").into());
    ui.set_metric_dim_d(format!("{d:.3}").into());

    ui.set_model_list(
        ModelRc::new(VecModel::from(vec![ModelListItem {
            title: name.into(),
            subtitle: subtitle.into(),
            selected: true,
        }]))
        .into(),
    );

    let materials: Vec<MaterialListItem> = scene
        .materials
        .iter()
        .map(|m| MaterialListItem {
            name: m.name.clone().into(),
            swatch: rgba_to_slint_color(m.base_color),
        })
        .collect();
    ui.set_material_list(ModelRc::new(VecModel::from(materials)).into());
}

fn rgba_to_slint_color(c: [f32; 4]) -> slint::Color {
    slint::Color::from_argb_f32(c[3], c[0], c[1], c[2])
}

fn format_size(bytes: u64) -> String {
    if bytes >= 1024 * 1024 {
        format!("{:.2} MB", bytes as f64 / (1024.0 * 1024.0))
    } else if bytes >= 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{bytes} B")
    }
}

fn loading_status_text(locale: LocalePreference, percent: u8) -> String {
    match I18n::new(locale).locale() {
        trivor_core::Locale::ZhHans => format!("正在加载… {percent}%"),
        _ => format!("Loading… {percent}%"),
    }
}

fn format_load_error(err: &LoadError) -> String {
    match err {
        LoadError::UnsupportedFormat(ext) => format!("Unsupported format: {ext}"),
        LoadError::Io { message, .. } | LoadError::Parse { message, .. } => message.clone(),
    }
}

fn locale_index_from_preference(pref: LocalePreference) -> i32 {
    match pref {
        LocalePreference::En => 0,
        LocalePreference::ZhHans => 1,
        LocalePreference::System => 2,
    }
}

fn preference_from_index(index: i32) -> LocalePreference {
    match index {
        0 => LocalePreference::En,
        1 => LocalePreference::ZhHans,
        _ => LocalePreference::System,
    }
}

fn theme_index_from_preference(pref: ThemePreference) -> i32 {
    match pref {
        ThemePreference::Dark => 0,
        ThemePreference::Light => 1,
        ThemePreference::System => 2,
    }
}

fn theme_preference_from_index(index: i32) -> ThemePreference {
    match index {
        0 => ThemePreference::Dark,
        1 => ThemePreference::Light,
        _ => ThemePreference::System,
    }
}

/// Run the Trivor application.
pub fn run() -> Result<(), PlatformError> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "trivor=info".into()),
        )
        .init();

    AppShell::new().run()
}
