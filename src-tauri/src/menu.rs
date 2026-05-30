use tauri::menu::{AboutMetadata, MenuBuilder, MenuEvent, MenuItem, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager};

use trivor_i18n::{I18n, MessageKey};

use crate::AppState;

struct MenuText {
    app_name: String,
    about_description: String,
    file: String,
    view: String,
    help: String,
    open: String,
    open_folder: String,
    fit: String,
    settings: String,
    check_updates: String,
    release_notes: String,
    view_on_github: String,
    report_issue: String,
    zoom_in: String,
    zoom_out: String,
    reset_view: String,
}

fn menu_texts(app: &AppHandle) -> tauri::Result<MenuText> {
    let state = app.state::<std::sync::Mutex<AppState>>();
    let guard = state.lock().map_err(|_| tauri::Error::FailedToReceiveMessage)?;
    let i18n = I18n::new(guard.locale);
    let s = |k: MessageKey| i18n.t(k).to_string();
    Ok(MenuText {
        app_name: s(MessageKey::AppName),
        about_description: s(MessageKey::AboutDescription),
        file: s(MessageKey::MenuFile),
        view: s(MessageKey::MenuView),
        help: s(MessageKey::MenuHelp),
        open: s(MessageKey::MenuOpen),
        open_folder: s(MessageKey::MenuOpenFolder),
        fit: s(MessageKey::MenuFit),
        settings: s(MessageKey::Settings),
        check_updates: s(MessageKey::MenuCheckUpdates),
        release_notes: s(MessageKey::MenuReleaseNotes),
        view_on_github: s(MessageKey::MenuViewOnGitHub),
        report_issue: s(MessageKey::MenuReportIssue),
        zoom_in: s(MessageKey::ToolZoomIn),
        zoom_out: s(MessageKey::ToolZoomOut),
        reset_view: s(MessageKey::ToolResetView),
    })
}

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let t = menu_texts(app)?;
    let version = env!("CARGO_PKG_VERSION");

    let app_menu = SubmenuBuilder::new(app, &t.app_name)
        .about(Some(AboutMetadata {
            name: Some(t.app_name.clone()),
            version: Some(version.into()),
            copyright: Some("Copyright © 2026 imboni and contributors".into()),
            comments: Some(t.about_description.clone()),
            ..Default::default()
        }))
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let file_menu = SubmenuBuilder::new(app, &t.file)
        .item(&MenuItem::with_id(
            app,
            "open-file",
            &t.open,
            true,
            Some("CmdOrCtrl+O"),
        )?)
        .item(&MenuItem::with_id(
            app,
            "open-folder",
            &t.open_folder,
            true,
            Some("CmdOrCtrl+Shift+O"),
        )?)
        .separator()
        .item(&MenuItem::with_id(
            app,
            "settings",
            &t.settings,
            true,
            Some("CmdOrCtrl+,"),
        )?)
        .build()?;

    let view_menu = SubmenuBuilder::new(app, &t.view)
        .item(&MenuItem::with_id(
            app,
            "zoom-in",
            &t.zoom_in,
            true,
            Some("CmdOrCtrl+="),
        )?)
        .item(&MenuItem::with_id(
            app,
            "zoom-out",
            &t.zoom_out,
            true,
            Some("CmdOrCtrl+-"),
        )?)
        .item(&MenuItem::with_id(
            app,
            "reset-view",
            &t.reset_view,
            true,
            Some("CmdOrCtrl+R"),
        )?)
        .separator()
        .item(&MenuItem::with_id(app, "fit-view", &t.fit, true, Some("CmdOrCtrl+0"))?)
        .build()?;

    let no_shortcut: Option<&str> = None;

    let help_menu = SubmenuBuilder::new(app, &t.help)
        .item(&MenuItem::with_id(
            app,
            "check-updates",
            &t.check_updates,
            true,
            no_shortcut,
        )?)
        .item(&MenuItem::with_id(
            app,
            "release-notes",
            &t.release_notes,
            true,
            no_shortcut,
        )?)
        .separator()
        .item(&MenuItem::with_id(
            app,
            "view-github",
            &t.view_on_github,
            true,
            no_shortcut,
        )?)
        .item(&MenuItem::with_id(
            app,
            "report-issue",
            &t.report_issue,
            true,
            no_shortcut,
        )?)
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .separator()
        .item(&PredefinedMenuItem::fullscreen(app, None)?)
        .build()?;

    let menu = MenuBuilder::new(app)
        .items(&[
            &app_menu,
            &file_menu,
            &edit_menu,
            &view_menu,
            &window_menu,
            &help_menu,
        ])
        .build()?;

    app.set_menu(menu)?;
    Ok(())
}

pub fn handle_event(app: &AppHandle, event: &MenuEvent) {
    let id = event.id().0.as_str();
    let _ = app.emit_to("main", "menu-action", id);
}
