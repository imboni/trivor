//! Internationalization for Trivor (极视).

use serde::Serialize;
use trivor_core::{Locale, LocalePreference, Theme, ThemePreference};

pub struct I18n {
    locale: Locale,
}

impl I18n {
    pub fn new(preference: LocalePreference) -> Self {
        Self {
            locale: resolve_locale(preference),
        }
    }

    pub fn with_locale(locale: Locale) -> Self {
        Self { locale }
    }

    pub fn locale(&self) -> Locale {
        self.locale
    }

    pub fn set_preference(&mut self, preference: LocalePreference) {
        self.locale = resolve_locale(preference);
    }

    pub fn set_locale(&mut self, locale: Locale) {
        self.locale = locale;
    }

    pub fn t(&self, key: MessageKey) -> &'static str {
        match (self.locale, key) {
            // Brand
            (_, MessageKey::AppName) if self.locale == Locale::ZhHans => "极视",
            (_, MessageKey::AppName) => "Trivor",
            (Locale::ZhHans, MessageKey::AppTagline) => "所见即三维。",
            (_, MessageKey::AppTagline) => "See every dimension.",
            (Locale::ZhHans, MessageKey::AboutDescription) => {
                "一款轻量的3D模型查看器，支持 macOS。"
            }
            (_, MessageKey::AboutDescription) => {
                "A lightweight 3D model viewer, available for macOS."
            }

            // Shell
            (Locale::ZhHans, MessageKey::FileDialogFilter) => "glTF / GLB",
            (_, MessageKey::FileDialogFilter) => "glTF / GLB",
            (Locale::ZhHans, MessageKey::OpenFile) => "打开…",
            (_, MessageKey::OpenFile) => "Open…",
            (Locale::ZhHans, MessageKey::OpenFolder) => "文件夹…",
            (_, MessageKey::OpenFolder) => "Folder…",
            (Locale::ZhHans, MessageKey::Settings) => "设置",
            (_, MessageKey::Settings) => "Settings",
            (Locale::ZhHans, MessageKey::MenuHelp) => "帮助",
            (_, MessageKey::MenuHelp) => "Help",
            (Locale::ZhHans, MessageKey::MenuCheckUpdates) => "检查更新…",
            (_, MessageKey::MenuCheckUpdates) => "Check for Updates…",
            (Locale::ZhHans, MessageKey::MenuReleaseNotes) => "发行说明",
            (_, MessageKey::MenuReleaseNotes) => "Release Notes",
            (Locale::ZhHans, MessageKey::MenuViewOnGitHub) => "在 GitHub 上查看",
            (_, MessageKey::MenuViewOnGitHub) => "View on GitHub",
            (Locale::ZhHans, MessageKey::MenuReportIssue) => "报告问题…",
            (_, MessageKey::MenuReportIssue) => "Report an Issue…",
            (Locale::ZhHans, MessageKey::SettingsAbout) => "关于",
            (_, MessageKey::SettingsAbout) => "About",
            (Locale::ZhHans, MessageKey::SettingsUpdates) => "更新",
            (_, MessageKey::SettingsUpdates) => "Updates",
            (Locale::ZhHans, MessageKey::SettingsStorage) => "存储",
            (_, MessageKey::SettingsStorage) => "Storage",
            (Locale::ZhHans, MessageKey::ClearCacheTitle) => "预览缓存",
            (_, MessageKey::ClearCacheTitle) => "Preview cache",
            (Locale::ZhHans, MessageKey::ClearCacheHint) => "清除自动生成的预览与打包缓存。",
            (_, MessageKey::ClearCacheHint) => "Remove auto-generated preview and repack caches.",
            (Locale::ZhHans, MessageKey::ClearCacheEmpty) => "暂无预览缓存",
            (_, MessageKey::ClearCacheEmpty) => "No cached previews",
            (Locale::ZhHans, MessageKey::ClearCache) => "清除缓存",
            (_, MessageKey::ClearCache) => "Clear Cache",
            (Locale::ZhHans, MessageKey::ClearCacheConfirm) => {
                "清除全部预览缓存？原始模型文件不会被删除。"
            }
            (_, MessageKey::ClearCacheConfirm) => {
                "Clear all cached previews? Original model files are not deleted."
            }
            (Locale::ZhHans, MessageKey::ClearCacheSuccess) => "已清除 {size} 预览缓存。",
            (_, MessageKey::ClearCacheSuccess) => "Cleared {size} of cached previews.",
            (Locale::ZhHans, MessageKey::ClearCacheFailed) => "无法清除缓存，请稍后再试。",
            (_, MessageKey::ClearCacheFailed) => "Couldn't clear cache. Try again later.",
            (Locale::ZhHans, MessageKey::AutoCheckUpdatesOnLaunch) => "启动时自动检查更新",
            (_, MessageKey::AutoCheckUpdatesOnLaunch) => "Check for updates on launch",
            (Locale::ZhHans, MessageKey::SettingsResources) => "资源",
            (_, MessageKey::SettingsResources) => "Resources",
            (Locale::ZhHans, MessageKey::CheckForUpdates) => "检查更新",
            (_, MessageKey::CheckForUpdates) => "Check for Updates",
            (Locale::ZhHans, MessageKey::UpdateChecking) => "正在检查…",
            (_, MessageKey::UpdateChecking) => "Checking…",
            (Locale::ZhHans, MessageKey::UpdateUpToDate) => "已是最新版本。",
            (_, MessageKey::UpdateUpToDate) => "You're up to date.",
            (Locale::ZhHans, MessageKey::UpdateAvailable) => "发现新版本 {version}。",
            (_, MessageKey::UpdateAvailable) => "Version {version} is available.",
            (Locale::ZhHans, MessageKey::UpdateCheckFailed) => "无法检查更新，请稍后再试。",
            (_, MessageKey::UpdateCheckFailed) => "Couldn't check for updates. Try again later.",
            (Locale::ZhHans, MessageKey::OpenLinkFailed) => "无法打开链接。",
            (_, MessageKey::OpenLinkFailed) => "Couldn't open the link.",
            (Locale::ZhHans, MessageKey::DownloadUpdate) => "下载更新",
            (_, MessageKey::DownloadUpdate) => "Download Update",
            (Locale::ZhHans, MessageKey::UpdateBannerTitle) => "新版本 v{version} 已发布",
            (_, MessageKey::UpdateBannerTitle) => "Version {version} is ready",
            (Locale::ZhHans, MessageKey::UpdateBannerBody) => "下载后即可安装更新。",
            (_, MessageKey::UpdateBannerBody) => "Download to install the update.",
            (Locale::ZhHans, MessageKey::UpdateDismiss) => "暂不更新",
            (_, MessageKey::UpdateDismiss) => "Not Now",
            (Locale::ZhHans, MessageKey::UpdateDownloading) => "正在下载… {percent}%",
            (_, MessageKey::UpdateDownloading) => "Downloading… {percent}%",
            (Locale::ZhHans, MessageKey::UpdateDownloadComplete) => "下载完成，正在打开安装包…",
            (_, MessageKey::UpdateDownloadComplete) => "Download complete. Opening installer…",
            (Locale::ZhHans, MessageKey::UpdateDownloadFailed) => "应用内下载失败，已在浏览器打开发布页。",
            (_, MessageKey::UpdateDownloadFailed) => {
                "In-app download failed. Opening the release page…"
            }
            (Locale::ZhHans, MessageKey::ViewReleaseNotes) => "发行说明",
            (_, MessageKey::ViewReleaseNotes) => "Release Notes",
            (Locale::ZhHans, MessageKey::ReportIssue) => "报告问题",
            (_, MessageKey::ReportIssue) => "Report an Issue",
            (Locale::ZhHans, MessageKey::ViewOnGitHub) => "GitHub 仓库",
            (_, MessageKey::ViewOnGitHub) => "GitHub Repository",
            (Locale::ZhHans, MessageKey::LicenseMit) => "MIT 许可证",
            (_, MessageKey::LicenseMit) => "MIT License",
            (Locale::ZhHans, MessageKey::MenuFile) => "文件",
            (_, MessageKey::MenuFile) => "File",
            (Locale::ZhHans, MessageKey::MenuView) => "视图",
            (_, MessageKey::MenuView) => "View",
            (Locale::ZhHans, MessageKey::MenuOpen) => "打开…",
            (_, MessageKey::MenuOpen) => "Open…",
            (Locale::ZhHans, MessageKey::MenuOpenFolder) => "打开文件夹…",
            (_, MessageKey::MenuOpenFolder) => "Open Folder…",
            (Locale::ZhHans, MessageKey::MenuFit) => "适应窗口",
            (_, MessageKey::MenuFit) => "Fit to View",
            (Locale::ZhHans, MessageKey::MenuQuit) => "退出 Trivor",
            (_, MessageKey::MenuQuit) => "Quit Trivor",
            (Locale::ZhHans, MessageKey::SidebarModels) => "模型库",
            (_, MessageKey::SidebarModels) => "Library",
            (Locale::ZhHans, MessageKey::SidebarEmpty) => "打开或导入文件夹，模型会显示在这里。",
            (_, MessageKey::SidebarEmpty) => "Open a file or folder to build your library.",
            (Locale::ZhHans, MessageKey::RemoveModel) => "从列表移除",
            (_, MessageKey::RemoveModel) => "Remove from list",
            (Locale::ZhHans, MessageKey::ShowInFolder) => "在访达中显示",
            (_, MessageKey::ShowInFolder) => "Show in Finder",
            (Locale::ZhHans, MessageKey::RefreshFolder) => "刷新所在目录",
            (_, MessageKey::RefreshFolder) => "Refresh folder",
            (Locale::ZhHans, MessageKey::RefreshLibrary) => "刷新模型库",
            (_, MessageKey::RefreshLibrary) => "Refresh library",
            (Locale::ZhHans, MessageKey::RefreshLibraryUnavailable) => {
                "请先打开文件夹后再刷新模型库。"
            }
            (_, MessageKey::RefreshLibraryUnavailable) => {
                "Open a folder first to refresh the library."
            }
            (Locale::ZhHans, MessageKey::ClearLibrary) => "清空列表",
            (_, MessageKey::ClearLibrary) => "Clear list",
            (Locale::ZhHans, MessageKey::ClearLibraryConfirm) => "清空全部模型？",
            (_, MessageKey::ClearLibraryConfirm) => "Clear all models?",
            (Locale::ZhHans, MessageKey::Cancel) => "取消",
            (_, MessageKey::Cancel) => "Cancel",
            (Locale::ZhHans, MessageKey::InspectorTitle) => "属性",
            (_, MessageKey::InspectorTitle) => "Inspector",
            (Locale::ZhHans, MessageKey::ErrorTitle) => "无法加载",
            (_, MessageKey::ErrorTitle) => "Couldn't load",
            (Locale::ZhHans, MessageKey::ErrorDismiss) => "关闭",
            (_, MessageKey::ErrorDismiss) => "Close",
            (Locale::ZhHans, MessageKey::ModelCount) => "{n} 个模型",
            (_, MessageKey::ModelCount) => "{n} models",
            (Locale::ZhHans, MessageKey::PanelMaterials) => "材质",
            (_, MessageKey::PanelMaterials) => "Materials",
            (Locale::ZhHans, MessageKey::PanelDimensions) => "尺寸",
            (_, MessageKey::PanelDimensions) => "Dimensions",
            (Locale::ZhHans, MessageKey::InspectorPlaceholder) => "打开模型后，几何与材质数据会显示在这里。",
            (_, MessageKey::InspectorPlaceholder) => "Geometry and materials appear here once a model is open.",

            // Empty / loading
            (Locale::ZhHans, MessageKey::EmptyTitle) => "空阔如纸，等一笔山河。",
            (_, MessageKey::EmptyTitle) => "Blank as paper—awaiting the stroke of mountains.",
            (Locale::ZhHans, MessageKey::Loading) => "加载中…",
            (_, MessageKey::Loading) => "Loading…",
            (Locale::ZhHans, MessageKey::LoadingReading) => "正在读取",
            (_, MessageKey::LoadingReading) => "Reading",
            (Locale::ZhHans, MessageKey::LoadingPacking) => "正在准备",
            (_, MessageKey::LoadingPacking) => "Preparing",
            (Locale::ZhHans, MessageKey::LoadingOptimizingPreview) => {
                "模型较大，正在自动优化预览"
            }
            (_, MessageKey::LoadingOptimizingPreview) => {
                "Large model — auto-optimizing preview"
            }
            (Locale::ZhHans, MessageKey::LoadingRendering) => "正在渲染",
            (_, MessageKey::LoadingRendering) => "Rendering",
            (Locale::ZhHans, MessageKey::ErrorFolderEmpty) => {
                "该文件夹内没有 glTF / GLB 模型"
            }
            (_, MessageKey::ErrorFolderEmpty) => "No glTF / GLB models in this folder",
            (Locale::ZhHans, MessageKey::LibraryLimit) => {
                "模型库最多 {max} 个，另有 {n} 个未加入。"
            }
            (_, MessageKey::LibraryLimit) => {
                "Model library holds up to {max} models. {n} could not be added."
            }
            (Locale::ZhHans, MessageKey::ErrorUnknownFileType) => {
                "无法识别文件类型，请使用 .gltf 或 .glb"
            }
            (_, MessageKey::ErrorUnknownFileType) => "Unknown file type — use .gltf or .glb",
            (Locale::ZhHans, MessageKey::ErrorUnsupportedExt) => {
                "暂不支持 .{ext}。当前支持：.gltf（JSON + 外部 bin/贴图）、.glb（单文件）"
            }
            (_, MessageKey::ErrorUnsupportedExt) => {
                "Unsupported .{ext}. Supported: .gltf (JSON + sidecar files) and .glb (single file)"
            }
            (Locale::ZhHans, MessageKey::ErrorGltfSidecarHint) => {
                "提示：.gltf 需与 .bin、贴图等文件放在同一文件夹。"
            }
            (_, MessageKey::ErrorGltfSidecarHint) => {
                "Tip: keep .gltf together with its .bin and texture files in one folder."
            }
            (Locale::ZhHans, MessageKey::ErrorGltfpackMissing) => {
                "应用缺少大模型预览组件，安装可能不完整。请从 GitHub Release 下载最新完整版。"
            }
            (_, MessageKey::ErrorGltfpackMissing) => {
                "The large-model preview component is missing — the app install may be incomplete. Download the latest release from GitHub."
            }
            (Locale::ZhHans, MessageKey::ErrorGltfpackPreviewFailed) => {
                "原文件约 {size}，无法自动生成简化版。\n\n请导出更小的 GLB（缩小贴图、减少面数），或释放磁盘空间后重试。"
            }
            (_, MessageKey::ErrorGltfpackPreviewFailed) => {
                "Original file: about {size}. Could not build a simplified preview.\n\nExport a smaller GLB (smaller textures, fewer polygons) or free disk space, then try again."
            }
            (Locale::ZhHans, MessageKey::ErrorLargeModelHint) => {
                "原文件约 {size}，将先自动生成简化版再打开。"
            }
            (_, MessageKey::ErrorLargeModelHint) => {
                "Original file: about {size}. A simplified preview will be built first."
            }
            (Locale::ZhHans, MessageKey::LargeModelPreviewNotice) => {
                "原文件约 {size}，当前显示的是简化版，原文件未被修改。"
            }
            (_, MessageKey::LargeModelPreviewNotice) => {
                "Original file: about {size}. Showing a simplified preview; your file is unchanged."
            }
            (Locale::ZhHans, MessageKey::ErrorViewerLoad) => "无法显示这个模型。",
            (_, MessageKey::ErrorViewerLoad) => "This model could not be displayed.",
            (Locale::ZhHans, MessageKey::ErrorPreviewRenderFailed) => {
                "原文件约 {size}。已生成简化版，但窗口仍无法显示。\n\n可在「设置 → 存储」清除预览缓存后重试。"
            }
            (_, MessageKey::ErrorPreviewRenderFailed) => {
                "Original file: about {size}. A simplified preview was built, but it still could not be shown.\n\nClear preview cache in Settings → Storage and try again."
            }
            (Locale::ZhHans, MessageKey::ErrorLargeViewerFailed) => {
                "原文件约 {size}，窗口无法加载。"
            }
            (_, MessageKey::ErrorLargeViewerFailed) => {
                "Original file: about {size}. The viewer cannot load this file."
            }
            (Locale::ZhHans, MessageKey::LoadExportAdvice) => {
                "建议导出：单文件 ≤ {stable_size}、三角面 ≤ {stable_tris} 以内较稳；超过 {hard_size} 或 {hard_tris} 时可能无法显示（贴图过大请先缩小贴图分辨率）。"
            }
            (_, MessageKey::LoadExportAdvice) => {
                "Export guide: ≤ {stable_size} and ≤ {stable_tris} triangles usually works; above {hard_size} or {hard_tris} may fail (resize textures if the file stays large)."
            }
            (Locale::ZhHans, MessageKey::ToolZoomIn) => "放大 (+)",
            (_, MessageKey::ToolZoomIn) => "Zoom in (+)",
            (Locale::ZhHans, MessageKey::ToolZoomOut) => "缩小 (−)",
            (_, MessageKey::ToolZoomOut) => "Zoom out (−)",
            (Locale::ZhHans, MessageKey::ToolResetView) => "恢复打开时视角 (R)",
            (_, MessageKey::ToolResetView) => "Restore initial view (R)",
            (Locale::ZhHans, MessageKey::ToolFitView) => "适应可见区域 (F)",
            (_, MessageKey::ToolFitView) => "Fit visible area (F)",
            (Locale::ZhHans, MessageKey::ToolCinema) => "清屏预览",
            (_, MessageKey::ToolCinema) => "360 preview",
            (Locale::ZhHans, MessageKey::ToolExitCinema) => "退出清屏",
            (_, MessageKey::ToolExitCinema) => "Exit focus",
            (Locale::ZhHans, MessageKey::ToolPauseRotate) => "暂停旋转",
            (_, MessageKey::ToolPauseRotate) => "Pause rotation",
            (Locale::ZhHans, MessageKey::ToolResumeRotate) => "继续旋转",
            (_, MessageKey::ToolResumeRotate) => "Resume rotation",
            (Locale::ZhHans, MessageKey::ExpandInspector) => "展开属性",
            (_, MessageKey::ExpandInspector) => "Show inspector",
            (Locale::ZhHans, MessageKey::CollapsePanel) => "收起",
            (_, MessageKey::CollapsePanel) => "Collapse",
            (Locale::ZhHans, MessageKey::ExpandPanel) => "展开",
            (_, MessageKey::ExpandPanel) => "Expand",
            (Locale::ZhHans, MessageKey::ToggleLibrary) => "模型库",
            (_, MessageKey::ToggleLibrary) => "Library",
            (Locale::ZhHans, MessageKey::MetricAxisW) => "宽",
            (_, MessageKey::MetricAxisW) => "W",
            (Locale::ZhHans, MessageKey::MetricAxisH) => "高",
            (_, MessageKey::MetricAxisH) => "H",
            (Locale::ZhHans, MessageKey::MetricAxisD) => "深",
            (_, MessageKey::MetricAxisD) => "D",
            (Locale::ZhHans, MessageKey::CloseSettings) => "关闭",
            (_, MessageKey::CloseSettings) => "Close",

            // Metrics
            (Locale::ZhHans, MessageKey::MetricMeshes) => "网格",
            (_, MessageKey::MetricMeshes) => "Meshes",
            (Locale::ZhHans, MessageKey::MetricMaterials) => "材质",
            (_, MessageKey::MetricMaterials) => "Materials",
            (Locale::ZhHans, MessageKey::MetricVertices) => "顶点",
            (_, MessageKey::MetricVertices) => "Vertices",
            (Locale::ZhHans, MessageKey::MetricTriangles) => "三角面",
            (_, MessageKey::MetricTriangles) => "Triangles",
            (Locale::ZhHans, MessageKey::MetricNone) => "—",
            (_, MessageKey::MetricNone) => "—",
            (Locale::ZhHans, MessageKey::FormatGltf) => "glTF",
            (_, MessageKey::FormatGltf) => "glTF",
            (Locale::ZhHans, MessageKey::FormatGlb) => "GLB",
            (_, MessageKey::FormatGlb) => "GLB",
            (Locale::ZhHans, MessageKey::UnitMeter) => "米",
            (_, MessageKey::UnitMeter) => "m",
            (Locale::ZhHans, MessageKey::UnitBytesB) => "B",
            (_, MessageKey::UnitBytesB) => "B",
            (Locale::ZhHans, MessageKey::UnitBytesKb) => "KB",
            (_, MessageKey::UnitBytesKb) => "KB",
            (Locale::ZhHans, MessageKey::UnitBytesMb) => "MB",
            (_, MessageKey::UnitBytesMb) => "MB",
            (Locale::ZhHans, MessageKey::UnitBytesGb) => "GB",
            (_, MessageKey::UnitBytesGb) => "GB",

            // Settings
            (Locale::ZhHans, MessageKey::Language) => "语言",
            (_, MessageKey::Language) => "Language",
            (Locale::ZhHans, MessageKey::LangEn) => "English",
            (_, MessageKey::LangEn) => "English",
            (Locale::ZhHans, MessageKey::LangZh) => "简体中文",
            (_, MessageKey::LangZh) => "简体中文",
            (Locale::ZhHans, MessageKey::LangSystem) => "跟随系统",
            (_, MessageKey::LangSystem) => "System",
            (Locale::ZhHans, MessageKey::Appearance) => "外观",
            (_, MessageKey::Appearance) => "Appearance",
            (Locale::ZhHans, MessageKey::SettingsShortcuts) => "快捷键",
            (_, MessageKey::SettingsShortcuts) => "Shortcuts",
            (Locale::ZhHans, MessageKey::ShortcutsCategoryGeneral) => "通用",
            (_, MessageKey::ShortcutsCategoryGeneral) => "General",
            (Locale::ZhHans, MessageKey::ShortcutsCategoryViewer) => "查看器",
            (_, MessageKey::ShortcutsCategoryViewer) => "Viewer",
            (Locale::ZhHans, MessageKey::ShortcutsPressKeys) => "按下按键…",
            (_, MessageKey::ShortcutsPressKeys) => "Press keys…",
            (Locale::ZhHans, MessageKey::ShortcutsResetAll) => "恢复默认",
            (_, MessageKey::ShortcutsResetAll) => "Reset defaults",
            (Locale::ZhHans, MessageKey::ShortcutsRestore) => "恢复默认",
            (_, MessageKey::ShortcutsRestore) => "Restore default",
            (Locale::ZhHans, MessageKey::ShortcutsConflict) => "该快捷键已被占用",
            (_, MessageKey::ShortcutsConflict) => "That shortcut is already in use",
            (Locale::ZhHans, MessageKey::ShortcutsDoubleClickFit) => "双击视口适应",
            (_, MessageKey::ShortcutsDoubleClickFit) => "Double-click viewport to fit",
            (Locale::ZhHans, MessageKey::ThemeDark) => "深色",
            (_, MessageKey::ThemeDark) => "Dark",
            (Locale::ZhHans, MessageKey::ThemeLight) => "浅色",
            (_, MessageKey::ThemeLight) => "Light",
            (Locale::ZhHans, MessageKey::ThemeSystem) => "跟随系统",
            (_, MessageKey::ThemeSystem) => "System",
            (Locale::ZhHans, MessageKey::SettingsViewerScene) => "查看器场景",
            (_, MessageKey::SettingsViewerScene) => "Viewer scene",
            (Locale::ZhHans, MessageKey::ScenePreviewGrid) => "网格地面",
            (_, MessageKey::ScenePreviewGrid) => "Grid floor",
            (Locale::ZhHans, MessageKey::SceneGuides) => "中心与坐标轴",
            (_, MessageKey::SceneGuides) => "Center and axes",
            (Locale::ZhHans, MessageKey::ToolPreviewGrid) => "显示网格地面",
            (_, MessageKey::ToolPreviewGrid) => "Show grid floor",
            (Locale::ZhHans, MessageKey::ToolSceneGuides) => "显示中心与坐标轴",
            (_, MessageKey::ToolSceneGuides) => "Show center and axes",
        }
    }
}

pub fn resolve_locale(preference: LocalePreference) -> Locale {
    match preference {
        LocalePreference::En => Locale::En,
        LocalePreference::ZhHans => Locale::ZhHans,
        LocalePreference::System => sys_locale::get_locale()
            .map(|l| {
                if l.starts_with("zh") {
                    Locale::ZhHans
                } else {
                    Locale::En
                }
            })
            .unwrap_or(Locale::En),
    }
}

#[derive(Debug, Clone, Copy)]
pub enum MessageKey {
    AppName,
    AppTagline,
    AboutDescription,
    FileDialogFilter,
    OpenFile,
    OpenFolder,
    MenuFile,
    MenuView,
    MenuOpen,
    MenuOpenFolder,
    MenuFit,
    MenuQuit,
    Settings,
    MenuHelp,
    MenuCheckUpdates,
    MenuReleaseNotes,
    MenuViewOnGitHub,
    MenuReportIssue,
    SettingsAbout,
    SettingsUpdates,
    SettingsStorage,
    ClearCacheTitle,
    ClearCacheHint,
    ClearCacheEmpty,
    ClearCache,
    ClearCacheConfirm,
    ClearCacheSuccess,
    ClearCacheFailed,
    AutoCheckUpdatesOnLaunch,
    SettingsResources,
    CheckForUpdates,
    UpdateChecking,
    UpdateUpToDate,
    UpdateAvailable,
    UpdateCheckFailed,
    OpenLinkFailed,
    DownloadUpdate,
    UpdateBannerTitle,
    UpdateBannerBody,
    UpdateDismiss,
    UpdateDownloading,
    UpdateDownloadComplete,
    UpdateDownloadFailed,
    ViewReleaseNotes,
    ReportIssue,
    ViewOnGitHub,
    LicenseMit,
    SidebarModels,
    SidebarEmpty,
    RemoveModel,
    ShowInFolder,
    RefreshFolder,
    RefreshLibrary,
    RefreshLibraryUnavailable,
    ClearLibrary,
    ClearLibraryConfirm,
    Cancel,
    InspectorTitle,
    ErrorTitle,
    ErrorDismiss,
    ModelCount,
    PanelMaterials,
    PanelDimensions,
    InspectorPlaceholder,
    EmptyTitle,
    Loading,
    LoadingReading,
    LoadingPacking,
    LoadingOptimizingPreview,
    LoadingRendering,
    ErrorFolderEmpty,
    LibraryLimit,
    ErrorUnknownFileType,
    ErrorUnsupportedExt,
    ErrorGltfSidecarHint,
    ErrorGltfpackMissing,
    ErrorGltfpackPreviewFailed,
    ErrorLargeModelHint,
    LargeModelPreviewNotice,
    ErrorViewerLoad,
    ErrorPreviewRenderFailed,
    ErrorLargeViewerFailed,
    LoadExportAdvice,
    ToolZoomIn,
    ToolZoomOut,
    ToolResetView,
    ToolFitView,
    ToolCinema,
    ToolExitCinema,
    CollapsePanel,
    ExpandPanel,
    ToggleLibrary,
    ToolPauseRotate,
    ToolResumeRotate,
    ExpandInspector,
    MetricAxisW,
    MetricAxisH,
    MetricAxisD,
    CloseSettings,
    MetricMeshes,
    MetricMaterials,
    MetricVertices,
    MetricTriangles,
    MetricNone,
    FormatGltf,
    FormatGlb,
    UnitMeter,
    UnitBytesB,
    UnitBytesKb,
    UnitBytesMb,
    UnitBytesGb,
    Language,
    LangEn,
    LangZh,
    LangSystem,
    Appearance,
    SettingsShortcuts,
    ShortcutsCategoryGeneral,
    ShortcutsCategoryViewer,
    ShortcutsPressKeys,
    ShortcutsResetAll,
    ShortcutsRestore,
    ShortcutsConflict,
    ShortcutsDoubleClickFit,
    ThemeDark,
    ThemeLight,
    ThemeSystem,
    SettingsViewerScene,
    ScenePreviewGrid,
    SceneGuides,
    ToolPreviewGrid,
    ToolSceneGuides,
}

/// Serializable UI copy for the web shell.
#[derive(Debug, Clone, Serialize)]
pub struct UiBundle {
    /// Resolved UI language: `en` or `zh-Hans`.
    pub locale: &'static str,
    /// User preference: `en`, `zh-Hans`, or `system`.
    pub locale_pref: &'static str,
    /// Resolved theme: `dark` or `light`.
    pub theme: &'static str,
    /// User preference: `dark`, `light`, or `system`.
    pub theme_pref: &'static str,
    pub window_title: String,
    pub app_name: String,
    pub tagline: String,
    pub open_file: String,
    pub open_folder: String,
    pub settings: String,
    pub about_description: String,
    pub menu_help: String,
    pub menu_check_updates: String,
    pub menu_release_notes: String,
    pub menu_view_on_github: String,
    pub menu_report_issue: String,
    pub settings_about: String,
    pub settings_updates: String,
    pub settings_storage: String,
    pub clear_cache_title: String,
    pub clear_cache_hint: String,
    pub clear_cache_empty: String,
    pub clear_cache: String,
    pub clear_cache_confirm: String,
    pub clear_cache_success: String,
    pub clear_cache_failed: String,
    pub auto_check_updates_on_launch: String,
    pub settings_resources: String,
    pub check_for_updates: String,
    pub update_checking: String,
    pub update_up_to_date: String,
    pub update_available: String,
    pub update_check_failed: String,
    pub open_link_failed: String,
    pub download_update: String,
    pub update_banner_title: String,
    pub update_banner_body: String,
    pub update_dismiss: String,
    pub update_downloading: String,
    pub update_download_complete: String,
    pub update_download_failed: String,
    pub view_release_notes: String,
    pub report_issue: String,
    pub view_on_github: String,
    pub license_mit: String,
    pub sidebar_models: String,
    pub sidebar_empty: String,
    pub remove_model: String,
    pub show_in_folder: String,
    pub refresh_folder: String,
    pub refresh_library: String,
    pub refresh_library_unavailable: String,
    pub clear_library: String,
    pub clear_library_confirm: String,
    pub cancel: String,
    pub inspector_title: String,
    pub error_title: String,
    pub error_dismiss: String,
    pub model_count: String,
    pub panel_materials: String,
    pub panel_dimensions: String,
    pub inspector_placeholder: String,
    pub empty_title: String,
    pub loading: String,
    pub loading_reading: String,
    pub loading_packing: String,
    pub loading_optimizing_preview: String,
    pub loading_rendering: String,
    pub error_folder_empty: String,
    pub library_limit: String,
    pub error_unknown_file_type: String,
    pub error_unsupported_ext: String,
    pub error_gltf_sidecar_hint: String,
    pub error_gltfpack_missing: String,
    pub error_gltfpack_preview_failed: String,
    pub error_large_model_hint: String,
    pub large_model_preview_notice: String,
    pub error_viewer_load: String,
    pub error_preview_render_failed: String,
    pub error_large_viewer_failed: String,
    pub load_export_advice: String,
    pub tool_zoom_in: String,
    pub tool_zoom_out: String,
    pub tool_reset_view: String,
    pub tool_fit_view: String,
    pub tool_cinema: String,
    pub tool_exit_cinema: String,
    pub collapse_panel: String,
    pub expand_panel: String,
    pub toggle_library: String,
    pub tool_pause_rotate: String,
    pub tool_resume_rotate: String,
    pub expand_inspector: String,
    pub metric_axis_w: String,
    pub metric_axis_h: String,
    pub metric_axis_d: String,
    pub close_settings: String,
    pub file_dialog_filter: String,
    pub metric_meshes: String,
    pub metric_materials: String,
    pub metric_vertices: String,
    pub metric_triangles: String,
    pub metric_none: String,
    pub format_gltf: String,
    pub format_glb: String,
    pub unit_meter: String,
    pub unit_bytes_b: String,
    pub unit_bytes_kb: String,
    pub unit_bytes_mb: String,
    pub unit_bytes_gb: String,
    pub language: String,
    pub lang_en: String,
    pub lang_zh: String,
    pub lang_system: String,
    pub appearance: String,
    pub settings_shortcuts: String,
    pub shortcuts_category_general: String,
    pub shortcuts_category_viewer: String,
    pub shortcuts_press_keys: String,
    pub shortcuts_reset_all: String,
    pub shortcuts_restore: String,
    pub shortcuts_conflict: String,
    pub shortcuts_double_click_fit: String,
    pub theme_dark: String,
    pub theme_light: String,
    pub theme_system: String,
    pub settings_viewer_scene: String,
    pub scene_preview_grid: String,
    pub scene_guides: String,
    pub tool_preview_grid: String,
    pub tool_scene_guides: String,
}

impl UiBundle {
    pub fn from_prefs(
        i18n: &I18n,
        locale_pref: LocalePreference,
        theme_pref: ThemePreference,
        system_dark: bool,
    ) -> Self {
        let t = |k: MessageKey| i18n.t(k).to_string();
        let locale = match i18n.locale() {
            Locale::ZhHans => "zh-Hans",
            Locale::En => "en",
        };
        let locale_pref = match locale_pref {
            LocalePreference::En => "en",
            LocalePreference::ZhHans => "zh-Hans",
            LocalePreference::System => "system",
        };
        let theme = match theme_pref.resolve(system_dark) {
            Theme::Dark => "dark",
            Theme::Light => "light",
        };
        let theme_pref = match theme_pref {
            ThemePreference::Dark => "dark",
            ThemePreference::Light => "light",
            ThemePreference::System => "system",
        };
        Self {
            locale,
            locale_pref,
            theme,
            theme_pref,
            window_title: format!("{} — {}", t(MessageKey::AppName), t(MessageKey::AppTagline)),
            app_name: t(MessageKey::AppName),
            tagline: t(MessageKey::AppTagline),
            open_file: t(MessageKey::OpenFile),
            open_folder: t(MessageKey::OpenFolder),
            settings: t(MessageKey::Settings),
            about_description: t(MessageKey::AboutDescription),
            menu_help: t(MessageKey::MenuHelp),
            menu_check_updates: t(MessageKey::MenuCheckUpdates),
            menu_release_notes: t(MessageKey::MenuReleaseNotes),
            menu_view_on_github: t(MessageKey::MenuViewOnGitHub),
            menu_report_issue: t(MessageKey::MenuReportIssue),
            settings_about: t(MessageKey::SettingsAbout),
            settings_updates: t(MessageKey::SettingsUpdates),
            settings_storage: t(MessageKey::SettingsStorage),
            clear_cache_title: t(MessageKey::ClearCacheTitle),
            clear_cache_hint: t(MessageKey::ClearCacheHint),
            clear_cache_empty: t(MessageKey::ClearCacheEmpty),
            clear_cache: t(MessageKey::ClearCache),
            clear_cache_confirm: t(MessageKey::ClearCacheConfirm),
            clear_cache_success: t(MessageKey::ClearCacheSuccess),
            clear_cache_failed: t(MessageKey::ClearCacheFailed),
            auto_check_updates_on_launch: t(MessageKey::AutoCheckUpdatesOnLaunch),
            settings_resources: t(MessageKey::SettingsResources),
            check_for_updates: t(MessageKey::CheckForUpdates),
            update_checking: t(MessageKey::UpdateChecking),
            update_up_to_date: t(MessageKey::UpdateUpToDate),
            update_available: t(MessageKey::UpdateAvailable),
            update_check_failed: t(MessageKey::UpdateCheckFailed),
            open_link_failed: t(MessageKey::OpenLinkFailed),
            download_update: t(MessageKey::DownloadUpdate),
            update_banner_title: t(MessageKey::UpdateBannerTitle),
            update_banner_body: t(MessageKey::UpdateBannerBody),
            update_dismiss: t(MessageKey::UpdateDismiss),
            update_downloading: t(MessageKey::UpdateDownloading),
            update_download_complete: t(MessageKey::UpdateDownloadComplete),
            update_download_failed: t(MessageKey::UpdateDownloadFailed),
            view_release_notes: t(MessageKey::ViewReleaseNotes),
            report_issue: t(MessageKey::ReportIssue),
            view_on_github: t(MessageKey::ViewOnGitHub),
            license_mit: t(MessageKey::LicenseMit),
            sidebar_models: t(MessageKey::SidebarModels),
            sidebar_empty: t(MessageKey::SidebarEmpty),
            remove_model: t(MessageKey::RemoveModel),
            show_in_folder: t(MessageKey::ShowInFolder),
            refresh_folder: t(MessageKey::RefreshFolder),
            refresh_library: t(MessageKey::RefreshLibrary),
            refresh_library_unavailable: t(MessageKey::RefreshLibraryUnavailable),
            clear_library: t(MessageKey::ClearLibrary),
            clear_library_confirm: t(MessageKey::ClearLibraryConfirm),
            cancel: t(MessageKey::Cancel),
            inspector_title: t(MessageKey::InspectorTitle),
            error_title: t(MessageKey::ErrorTitle),
            error_dismiss: t(MessageKey::ErrorDismiss),
            model_count: t(MessageKey::ModelCount),
            panel_materials: t(MessageKey::PanelMaterials),
            panel_dimensions: t(MessageKey::PanelDimensions),
            inspector_placeholder: t(MessageKey::InspectorPlaceholder),
            empty_title: t(MessageKey::EmptyTitle),
            loading: t(MessageKey::Loading),
            loading_reading: t(MessageKey::LoadingReading),
            loading_packing: t(MessageKey::LoadingPacking),
            loading_optimizing_preview: t(MessageKey::LoadingOptimizingPreview),
            loading_rendering: t(MessageKey::LoadingRendering),
            error_folder_empty: t(MessageKey::ErrorFolderEmpty),
            library_limit: t(MessageKey::LibraryLimit),
            error_unknown_file_type: t(MessageKey::ErrorUnknownFileType),
            error_unsupported_ext: t(MessageKey::ErrorUnsupportedExt),
            error_gltf_sidecar_hint: t(MessageKey::ErrorGltfSidecarHint),
            error_gltfpack_missing: t(MessageKey::ErrorGltfpackMissing),
            error_gltfpack_preview_failed: t(MessageKey::ErrorGltfpackPreviewFailed),
            error_large_model_hint: t(MessageKey::ErrorLargeModelHint),
            large_model_preview_notice: t(MessageKey::LargeModelPreviewNotice),
            error_viewer_load: t(MessageKey::ErrorViewerLoad),
            error_preview_render_failed: t(MessageKey::ErrorPreviewRenderFailed),
            error_large_viewer_failed: t(MessageKey::ErrorLargeViewerFailed),
            load_export_advice: t(MessageKey::LoadExportAdvice),
            tool_zoom_in: t(MessageKey::ToolZoomIn),
            tool_zoom_out: t(MessageKey::ToolZoomOut),
            tool_reset_view: t(MessageKey::ToolResetView),
            tool_fit_view: t(MessageKey::ToolFitView),
            tool_cinema: t(MessageKey::ToolCinema),
            tool_exit_cinema: t(MessageKey::ToolExitCinema),
            collapse_panel: t(MessageKey::CollapsePanel),
            expand_panel: t(MessageKey::ExpandPanel),
            toggle_library: t(MessageKey::ToggleLibrary),
            tool_pause_rotate: t(MessageKey::ToolPauseRotate),
            tool_resume_rotate: t(MessageKey::ToolResumeRotate),
            expand_inspector: t(MessageKey::ExpandInspector),
            metric_axis_w: t(MessageKey::MetricAxisW),
            metric_axis_h: t(MessageKey::MetricAxisH),
            metric_axis_d: t(MessageKey::MetricAxisD),
            close_settings: t(MessageKey::CloseSettings),
            file_dialog_filter: t(MessageKey::FileDialogFilter),
            metric_meshes: t(MessageKey::MetricMeshes),
            metric_materials: t(MessageKey::MetricMaterials),
            metric_vertices: t(MessageKey::MetricVertices),
            metric_triangles: t(MessageKey::MetricTriangles),
            metric_none: t(MessageKey::MetricNone),
            format_gltf: t(MessageKey::FormatGltf),
            format_glb: t(MessageKey::FormatGlb),
            unit_meter: t(MessageKey::UnitMeter),
            unit_bytes_b: t(MessageKey::UnitBytesB),
            unit_bytes_kb: t(MessageKey::UnitBytesKb),
            unit_bytes_mb: t(MessageKey::UnitBytesMb),
            unit_bytes_gb: t(MessageKey::UnitBytesGb),
            language: t(MessageKey::Language),
            lang_en: t(MessageKey::LangEn),
            lang_zh: t(MessageKey::LangZh),
            lang_system: t(MessageKey::LangSystem),
            appearance: t(MessageKey::Appearance),
            settings_shortcuts: t(MessageKey::SettingsShortcuts),
            shortcuts_category_general: t(MessageKey::ShortcutsCategoryGeneral),
            shortcuts_category_viewer: t(MessageKey::ShortcutsCategoryViewer),
            shortcuts_press_keys: t(MessageKey::ShortcutsPressKeys),
            shortcuts_reset_all: t(MessageKey::ShortcutsResetAll),
            shortcuts_restore: t(MessageKey::ShortcutsRestore),
            shortcuts_conflict: t(MessageKey::ShortcutsConflict),
            shortcuts_double_click_fit: t(MessageKey::ShortcutsDoubleClickFit),
            theme_dark: t(MessageKey::ThemeDark),
            theme_light: t(MessageKey::ThemeLight),
            theme_system: t(MessageKey::ThemeSystem),
            settings_viewer_scene: t(MessageKey::SettingsViewerScene),
            scene_preview_grid: t(MessageKey::ScenePreviewGrid),
            scene_guides: t(MessageKey::SceneGuides),
            tool_preview_grid: t(MessageKey::ToolPreviewGrid),
            tool_scene_guides: t(MessageKey::ToolSceneGuides),
        }
    }

    pub fn from_i18n_with_pref(i18n: &I18n, locale_pref: LocalePreference) -> Self {
        Self::from_prefs(i18n, locale_pref, ThemePreference::System, true)
    }
}
