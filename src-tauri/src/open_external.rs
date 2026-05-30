use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State};

pub struct PendingOpens(pub Mutex<Vec<String>>);
pub struct FrontendReady(pub Mutex<bool>);

pub fn allow_open_path(app: &AppHandle, path: &Path) {
    let scope = app.asset_protocol_scope();
    if path.is_dir() {
        let _ = scope.allow_directory(path, true);
    } else if path.is_file() {
        let _ = scope.allow_file(path);
    }
}

pub fn enqueue_external_open(app: &AppHandle, path: PathBuf) {
    allow_open_path(app, &path);
    let path_str = path.to_string_lossy().into_owned();
    let ready = *app.state::<FrontendReady>().0.lock().expect("frontend ready");
    if ready {
        let _ = app.emit_to("main", "open-path", &path_str);
    } else {
        app.state::<PendingOpens>()
            .0
            .lock()
            .expect("pending opens")
            .push(path_str);
    }
}

#[tauri::command]
pub fn complete_startup(
    pending: State<'_, PendingOpens>,
    ready: State<'_, FrontendReady>,
) -> Vec<String> {
    *ready.0.lock().expect("frontend ready") = true;
    std::mem::take(&mut *pending.0.lock().expect("pending opens"))
}

#[tauri::command]
pub fn path_kind(path: String) -> String {
    let path = Path::new(&path);
    if !path.exists() {
        return "missing".into();
    }
    if path.is_dir() {
        return "directory".into();
    }
    "file".into()
}
