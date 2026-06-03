use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use tauri::{AppHandle, Manager};

const APP_NAME: &str = "Trivor.app";
const VOLUMES_DIR: &str = "/Volumes";

/// Remove leftover installer DMG mounts such as `/Volumes/Trivor` and `/Volumes/Trivor 1`.
pub fn cleanup_stale_trivor_volumes() {
    let volumes = Path::new(VOLUMES_DIR);
    let Ok(entries) = fs::read_dir(volumes) else {
        return;
    };

    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !is_trivor_installer_volume(name) {
            continue;
        }
        let _ = Command::new("hdiutil")
            .args(["detach", "-force", "-quiet"])
            .arg(entry.path())
            .status();
    }
}

pub fn install_downloaded_dmg(dmg_path: &Path, app: &AppHandle) -> Result<(), String> {
    if !dmg_path.exists() {
        return Err(format!("File not found: {}", dmg_path.display()));
    }

    cleanup_stale_trivor_volumes();

    let updates_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("updates");
    fs::create_dir_all(&updates_dir).map_err(|e| e.to_string())?;

    let mount_dir = updates_dir.join("mount");
    let _ = detach_if_mounted(&mount_dir);
    let _ = fs::remove_dir_all(&mount_dir);
    fs::create_dir_all(&mount_dir).map_err(|e| e.to_string())?;

    let attach = Command::new("hdiutil")
        .args([
            "attach",
            "-nobrowse",
            "-readonly",
            "-noautoopen",
            "-mountpoint",
        ])
        .arg(&mount_dir)
        .arg(dmg_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !attach.status.success() {
        let _ = fs::remove_dir_all(&mount_dir);
        return Err(format!(
            "Failed to mount update image: {}",
            String::from_utf8_lossy(&attach.stderr)
        ));
    }

    // Some images still register a `/Volumes/Trivor` alias; remove it immediately.
    cleanup_stale_trivor_volumes();

    let source_app = match find_app_bundle(&mount_dir) {
        Ok(path) => path,
        Err(err) => {
            let _ = detach_if_mounted(&mount_dir);
            let _ = fs::remove_dir_all(&mount_dir);
            cleanup_stale_trivor_volumes();
            return Err(err);
        }
    };

    let target_app = resolve_install_target();
    let script_path = updates_dir.join("install-update.sh");
    write_install_script(
        &script_path,
        std::process::id(),
        &source_app,
        &target_app,
        &mount_dir,
    )?;

    Command::new("/bin/bash")
        .arg(&script_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;

    app.exit(0);
    Ok(())
}

fn is_trivor_installer_volume(name: &str) -> bool {
    name == "Trivor" || name.starts_with("Trivor ")
}

fn resolve_install_target() -> PathBuf {
    if let Some(current) = current_app_bundle() {
        return current;
    }
    PathBuf::from("/Applications").join(APP_NAME)
}

fn current_app_bundle() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let contents_macos = exe.parent()?;
    if contents_macos.file_name()?.to_str()? != "MacOS" {
        return None;
    }
    let contents = contents_macos.parent()?;
    if contents.file_name()?.to_str()? != "Contents" {
        return None;
    }
    Some(contents.parent()?.to_path_buf())
}

fn find_app_bundle(mount_dir: &Path) -> Result<PathBuf, String> {
    let direct = mount_dir.join(APP_NAME);
    if direct.is_dir() {
        return Ok(direct);
    }

    for entry in fs::read_dir(mount_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) == Some("app") {
            return Ok(path);
        }
    }

    Err("No application bundle found in update image".to_string())
}

fn write_install_script(
    script_path: &Path,
    parent_pid: u32,
    source_app: &Path,
    target_app: &Path,
    mount_dir: &Path,
) -> Result<(), String> {
    let mut script = fs::File::create(script_path).map_err(|e| e.to_string())?;
    writeln!(script, "#!/bin/bash").map_err(|e| e.to_string())?;
    writeln!(script, "set -euo pipefail").map_err(|e| e.to_string())?;
    writeln!(
        script,
        "cleanup_trivor_volumes() {{"
    )
    .map_err(|e| e.to_string())?;
    writeln!(script, "  local vol").map_err(|e| e.to_string())?;
    writeln!(
        script,
        "  for vol in /Volumes/Trivor /Volumes/Trivor\\ *; do"
    )
    .map_err(|e| e.to_string())?;
    writeln!(script, "    [ -e \"$vol\" ] || continue").map_err(|e| e.to_string())?;
    writeln!(
        script,
        "    hdiutil detach \"$vol\" -force -quiet 2>/dev/null || true"
    )
    .map_err(|e| e.to_string())?;
    writeln!(script, "  done").map_err(|e| e.to_string())?;
    writeln!(script, "}}").map_err(|e| e.to_string())?;
    writeln!(script, "PARENT_PID={parent_pid}").map_err(|e| e.to_string())?;
    writeln!(
        script,
        "while kill -0 \"$PARENT_PID\" 2>/dev/null; do sleep 0.2; done"
    )
    .map_err(|e| e.to_string())?;
    writeln!(script, "sleep 0.4").map_err(|e| e.to_string())?;
    writeln!(
        script,
        "ditto {} {}",
        shell_quote(&source_app.display().to_string()),
        shell_quote(&target_app.display().to_string())
    )
    .map_err(|e| e.to_string())?;
    writeln!(
        script,
        "hdiutil detach {} -quiet || hdiutil detach {} -force -quiet || true",
        shell_quote(&mount_dir.display().to_string()),
        shell_quote(&mount_dir.display().to_string())
    )
    .map_err(|e| e.to_string())?;
    writeln!(script, "cleanup_trivor_volumes").map_err(|e| e.to_string())?;
    writeln!(
        script,
        "open {}",
        shell_quote(&target_app.display().to_string())
    )
    .map_err(|e| e.to_string())?;
    writeln!(script, "rm -f \"$0\"").map_err(|e| e.to_string())?;

    use std::os::unix::fs::PermissionsExt;
    let mut perms = fs::metadata(script_path)
        .map_err(|e| e.to_string())?
        .permissions();
    perms.set_mode(0o755);
    fs::set_permissions(script_path, perms).map_err(|e| e.to_string())?;
    Ok(())
}

fn detach_if_mounted(mount_dir: &Path) -> Result<(), String> {
    if !mount_dir.exists() {
        return Ok(());
    }
    let status = Command::new("hdiutil")
        .args(["detach", "-force", "-quiet"])
        .arg(mount_dir)
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("Failed to detach update image".to_string())
    }
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::{is_trivor_installer_volume, shell_quote};

    #[test]
    fn shell_quote_escapes_single_quotes() {
        assert_eq!(shell_quote("Trivor.app"), "'Trivor.app'");
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
    }

    #[test]
    fn detects_trivor_installer_volume_names() {
        assert!(is_trivor_installer_volume("Trivor"));
        assert!(is_trivor_installer_volume("Trivor 1"));
        assert!(!is_trivor_installer_volume("TrivorX"));
        assert!(!is_trivor_installer_volume("Macintosh HD"));
    }
}
