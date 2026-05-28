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
  search_placeholder: string;
  sidebar_models: string;
  sidebar_empty: string;
  remove_model: string;
  clear_library: string;
  clear_library_confirm: string;
  cancel: string;
  inspector_title: string;
  viewport_hints: string;
  empty_hint: string;
  error_title: string;
  model_count: string;
  panel_materials: string;
  panel_model: string;
  panel_dimensions: string;
  inspector_placeholder: string;
  empty_title: string;
  empty_subtitle: string;
  loading: string;
  loading_reading: string;
  loading_rendering: string;
  error_folder_empty: string;
  library_limit: string;
  error_unknown_file_type: string;
  error_unsupported_ext: string;
  error_gltf_sidecar_hint: string;
  error_viewer_load: string;
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
  metric_format: string;
  metric_size: string;
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
  language: string;
  lang_en: string;
  lang_zh: string;
  lang_system: string;
  appearance: string;
  theme_dark: string;
  theme_light: string;
  theme_system: string;
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
