//! Byte formatting helpers for load errors and UI copy.

use std::path::Path;

use crate::LoadError;

pub fn file_size(path: &Path) -> Result<u64, LoadError> {
    std::fs::metadata(path)
        .map(|m| m.len())
        .map_err(|e| LoadError::Io {
            path: path.to_path_buf(),
            message: e.to_string(),
        })
}

pub fn format_bytes(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = KB * 1024.0;
    const GB: f64 = MB * 1024.0;
    let n = bytes as f64;
    if n >= GB {
        format!("{:.1} GB", n / GB)
    } else if n >= MB {
        format!("{:.0} MB", n / MB)
    } else if n >= KB {
        format!("{:.0} KB", n / KB)
    } else {
        format!("{bytes} B")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_bytes_scales() {
        assert_eq!(format_bytes(512), "512 B");
        assert_eq!(format_bytes(2048), "2 KB");
        assert_eq!(format_bytes(5 * 1024 * 1024), "5 MB");
    }
}
