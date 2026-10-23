use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

/// Hand the downloaded image to macOS. Finder owns mounting and installation;
/// the sandboxed running application neither overwrites itself nor exits.
pub fn open_downloaded_dmg(dmg_path: &Path, app: &AppHandle) -> Result<(), String> {
    let updates_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("updates");
    let dmg_path = validated_downloaded_dmg(dmg_path, &updates_dir)?;
    let path = dmg_path
        .to_str()
        .ok_or_else(|| "Installer path is not valid UTF-8".to_string())?;
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| format!("Failed to open update image: {e}"))
}

fn validated_downloaded_dmg(dmg_path: &Path, updates_dir: &Path) -> Result<PathBuf, String> {
    let invalid = || "Expected a downloaded DMG in the update cache".to_string();
    if !dmg_path.is_absolute()
        || !dmg_path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("dmg"))
        || !fs::symlink_metadata(updates_dir)
            .map_err(|_| invalid())?
            .file_type()
            .is_dir()
        || !fs::symlink_metadata(dmg_path)
            .map_err(|_| invalid())?
            .file_type()
            .is_file()
    {
        return Err(invalid());
    }
    let updates_dir = updates_dir.canonicalize().map_err(|_| invalid())?;
    let dmg_path = dmg_path.canonicalize().map_err(|_| invalid())?;
    // The downloader writes direct children. Exact parent comparison also
    // rejects traversal, sibling-prefix paths and symlinked subdirectories.
    if dmg_path.parent() != Some(updates_dir.as_path()) {
        return Err(invalid());
    }

    let mut file = File::open(&dmg_path).map_err(|_| invalid())?;
    let metadata = file.metadata().map_err(|_| invalid())?;
    if !metadata.is_file() || metadata.len() < 512 {
        return Err(invalid());
    }
    // Tauri's hdiutil UDZO images use a 512-byte UDIF trailer. Check its magic,
    // version and size so a renamed script/executable is not passed to opener.
    // This is format validation, not an authenticity or signing assertion.
    let mut trailer = [0u8; 12];
    file.seek(SeekFrom::End(-512)).map_err(|_| invalid())?;
    file.read_exact(&mut trailer).map_err(|_| invalid())?;
    if &trailer[..4] != b"koly"
        || u32::from_be_bytes(trailer[4..8].try_into().unwrap()) != 4
        || u32::from_be_bytes(trailer[8..12].try_into().unwrap()) != 512
    {
        return Err("Downloaded file is not a supported DMG image".into());
    }
    Ok(dmg_path)
}

#[cfg(test)]
mod tests {
    use super::validated_downloaded_dmg;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "trivor-update-validation-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn updates(&self) -> PathBuf {
            let path = self.0.join("updates");
            fs::create_dir(&path).unwrap();
            path
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    // Only the format marker is needed here; tests never open or mount this file.
    fn write_dmg(path: &Path) {
        let mut data = [0u8; 1024];
        data[512..516].copy_from_slice(b"koly");
        data[516..520].copy_from_slice(&4u32.to_be_bytes());
        data[520..524].copy_from_slice(&512u32.to_be_bytes());
        fs::write(path, data).unwrap();
    }

    #[test]
    fn accepts_regular_udif_download_with_spaces_and_unicode() {
        let dir = TempDir::new();
        let updates = dir.updates();
        let dmg = updates.join("Trivor 更新 0.4.0.DMG");
        write_dmg(&dmg);
        assert_eq!(
            validated_downloaded_dmg(&dmg, &updates).unwrap(),
            dmg.canonicalize().unwrap()
        );
    }

    #[test]
    fn rejects_outside_traversal_sibling_directories_and_non_dmg_paths() {
        let dir = TempDir::new();
        let updates = dir.updates();
        let outside = dir.0.join("outside.dmg");
        write_dmg(&outside);
        assert!(validated_downloaded_dmg(&outside, &updates).is_err());
        assert!(validated_downloaded_dmg(&updates.join("../outside.dmg"), &updates).is_err());
        let sibling = dir.0.join("updates-other");
        fs::create_dir(&sibling).unwrap();
        let sibling_dmg = sibling.join("Trivor.dmg");
        write_dmg(&sibling_dmg);
        assert!(validated_downloaded_dmg(&sibling_dmg, &updates).is_err());
        let executable = updates.join("installer.app");
        write_dmg(&executable);
        assert!(validated_downloaded_dmg(&executable, &updates).is_err());
        let directory = updates.join("directory.dmg");
        fs::create_dir(&directory).unwrap();
        assert!(validated_downloaded_dmg(&directory, &updates).is_err());
        assert!(validated_downloaded_dmg(&updates.join("missing.dmg"), &updates).is_err());
    }

    #[test]
    fn rejects_symlinked_download_and_cache_directory() {
        use std::os::unix::fs::symlink;
        let dir = TempDir::new();
        let updates = dir.updates();
        let target = updates.join("Trivor.dmg");
        write_dmg(&target);
        let link = updates.join("linked.dmg");
        symlink(&target, &link).unwrap();
        assert!(validated_downloaded_dmg(&link, &updates).is_err());
        let linked_cache = dir.0.join("linked-cache");
        symlink(&updates, &linked_cache).unwrap();
        assert!(validated_downloaded_dmg(&linked_cache.join("Trivor.dmg"), &linked_cache).is_err());
    }

    #[test]
    fn rejects_empty_truncated_or_renamed_executable_downloads() {
        let dir = TempDir::new();
        let updates = dir.updates();
        let dmg = updates.join("Trivor.dmg");
        for bytes in [
            Vec::new(),
            vec![0u8; 511],
            vec![0u8; 1024],
            b"#!/bin/sh\necho renamed\n".to_vec(),
        ] {
            fs::write(&dmg, bytes).unwrap();
            assert!(validated_downloaded_dmg(&dmg, &updates).is_err());
        }
        write_dmg(&dmg);
        let mut malformed = fs::read(&dmg).unwrap();
        malformed[519] = 5; // Unsupported UDIF version.
        fs::write(&dmg, malformed).unwrap();
        assert!(validated_downloaded_dmg(&dmg, &updates).is_err());
    }
}
