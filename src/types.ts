export interface UiBundle {
  locale: string;
  locale_pref: string;
  theme: string;
  theme_pref: string;
  window_title: string;
  app_name: string;
  tagline: string;
  open_file: string;
  open_folder: string;
  settings: string;
  about_description: string;
  menu_help: string;
  menu_check_updates: string;
  menu_release_notes: string;
  menu_view_on_github: string;
  menu_report_issue: string;
  settings_about: string;
  settings_updates: string;
  settings_storage: string;
  clear_cache_title: string;
  clear_cache_hint: string;
  clear_cache_empty: string;
  clear_cache: string;
  clear_cache_confirm: string;
  clear_cache_success: string;
  clear_cache_failed: string;
  auto_check_updates_on_launch: string;
  settings_resources: string;
  check_for_updates: string;
  update_checking: string;
  update_up_to_date: string;
  update_available: string;
  update_check_failed: string;
  open_link_failed: string;
  download_update: string;
  update_banner_title: string;
  update_banner_body: string;
  update_dismiss: string;
  update_downloading: string;
  update_download_complete: string;
  update_download_failed: string;
  view_release_notes: string;
  report_issue: string;
  view_on_github: string;
  license_mit: string;
  sidebar_models: string;
  sidebar_empty: string;
  remove_model: string;
  show_in_folder: string;
  refresh_folder: string;
  refresh_library: string;
  refresh_library_unavailable: string;
  clear_library: string;
  clear_library_confirm: string;
  cancel: string;
  inspector_title: string;
  error_title: string;
  error_dismiss: string;
  model_count: string;
  panel_materials: string;
  panel_dimensions: string;
  inspector_placeholder: string;
  empty_title: string;
  loading: string;
  loading_reading: string;
  loading_packing: string;
  loading_optimizing_preview: string;
  loading_rendering: string;
  error_folder_empty: string;
  library_limit: string;
  error_unknown_file_type: string;
  error_unsupported_ext: string;
  error_gltf_sidecar_hint: string;
  error_gltfpack_missing: string;
  error_gltfpack_preview_failed: string;
  error_large_model_hint: string;
  large_model_preview_notice: string;
  error_viewer_load: string;
  error_preview_render_failed: string;
  error_large_viewer_failed: string;
  load_export_advice: string;
  tool_zoom_in: string;
  tool_zoom_out: string;
  tool_reset_view: string;
  tool_fit_view: string;
  tool_cinema: string;
  tool_exit_cinema: string;
  collapse_panel: string;
  expand_panel: string;
  toggle_library: string;
  tool_pause_rotate: string;
  tool_resume_rotate: string;
  expand_inspector: string;
  metric_axis_w: string;
  metric_axis_h: string;
  metric_axis_d: string;
  close_settings: string;
  file_dialog_filter: string;
  metric_meshes: string;
  metric_materials: string;
  metric_vertices: string;
  metric_triangles: string;
  metric_none: string;
  format_gltf: string;
  format_glb: string;
  unit_meter: string;
  unit_bytes_b: string;
  unit_bytes_kb: string;
  unit_bytes_mb: string;
  unit_bytes_gb: string;
  language: string;
  lang_en: string;
  lang_zh: string;
  lang_system: string;
  appearance: string;
  settings_shortcuts: string;
  shortcuts_category_general: string;
  shortcuts_category_viewer: string;
  shortcuts_press_keys: string;
  shortcuts_reset_all: string;
  shortcuts_restore: string;
  shortcuts_conflict: string;
  shortcuts_double_click_fit: string;
  theme_dark: string;
  theme_light: string;
  theme_system: string;
  settings_viewer_scene: string;
  scene_preview_grid: string;
  scene_guides: string;
  tool_preview_grid: string;
  tool_scene_guides: string;
  tool_export_cutout: string;
  cutout_create: string;
  cutout_exporting: string;
  cutout_saved: string;
  cutout_failed: string;
  cutout_no_model: string;
  cutout_empty: string;
  cutout_preview_title: string;
  cutout_save_title: string;
}

export interface AppInfo {
  version: string;
  build_date: string;
  repository: string;
  homepage: string;
  issues_url: string;
  releases_url: string;
  license: string;
  copyright: string;
}

export interface UpdateCheckResult {
  current_version: string;
  latest_version: string | null;
  latest_published_at: string | null;
  update_available: boolean;
  release_page: string | null;
  download_url: string | null;
}

export interface ClearCacheResult {
  bytes_cleared: number;
}

export interface MaterialSummary {
  name: string;
  base_color: [number, number, number, number];
}

export interface ModelListEntry {
  path: string;
  name: string;
  format: string;
  file_size: number;
}

export interface SceneSummary {
  name: string;
  path: string;
  format: string;
  file_size: number;
  mesh_count: number;
  material_count: number;
  vertex_count: number;
  triangle_count: number;
  bounds_w: number;
  bounds_h: number;
  bounds_d: number;
  materials: MaterialSummary[];
}

export type AppPhase = "empty" | "loading" | "ready" | "error";
