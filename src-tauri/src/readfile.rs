//! Reading a mounted file for preview and for the note editor. The only file
//! reads the app performs. Writes live in `writefile.rs`, and they are limited
//! to notes (Markdown) and folders.

use crate::error::{AppError, AppResult};
use crate::rules::resolve_in_root;
use crate::tree::modified_millis;
use serde::Serialize;
use std::path::Path;

/// Text past this is cut: a 4 MB pre block already stalls the webview, and a
/// bigger file wants VS Code.
pub const TEXT_CAP_BYTES: u64 = 4 * 1024 * 1024;
/// Spreadsheets are parsed in the webview from bytes; this bounds the IPC copy.
pub const BYTES_CAP: u64 = 32 * 1024 * 1024;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    pub text: String,
    /// True when the file was larger than `TEXT_CAP_BYTES` and `text` holds
    /// only the head.
    pub truncated: bool,
    pub bytes: u64,
    pub modified: u64,
    /// True when the bytes were not valid UTF-8 and `text` carries U+FFFD in
    /// their place. Saving that text back would destroy the original bytes,
    /// so the editor refuses to open such a file (D3).
    pub lossy: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PathStat {
    pub size: u64,
    pub modified: u64,
    pub is_dir: bool,
}

/// Read a file as text. Not-UTF-8 bytes decode leniently (U+FFFD) so a
/// Windows-1252 export still previews rather than failing.
pub fn read_text(root: &Path, rel: &str) -> AppResult<TextFile> {
    let abs = resolve_in_root(root, rel)?;
    let meta = std::fs::metadata(&abs)?;
    if meta.is_dir() {
        return Err(AppError::new("that path is a folder"));
    }
    let bytes = meta.len();
    let modified = modified_millis(Some(&meta));
    let truncated = bytes > TEXT_CAP_BYTES;
    let raw = if truncated {
        use std::io::Read;
        let mut f = std::fs::File::open(&abs)?;
        let mut buf = vec![0u8; TEXT_CAP_BYTES as usize];
        let n = f.read(&mut buf)?;
        buf.truncate(n);
        buf
    } else {
        std::fs::read(&abs)?
    };
    let (text, lossy) = match String::from_utf8(raw) {
        Ok(s) => (s, false),
        Err(e) => (String::from_utf8_lossy(e.as_bytes()).into_owned(), true),
    };
    Ok(TextFile {
        text,
        truncated,
        bytes,
        modified,
        lossy,
    })
}

/// Read a file's bytes, for the spreadsheet parser.
pub fn read_bytes(root: &Path, rel: &str) -> AppResult<Vec<u8>> {
    let abs = resolve_in_root(root, rel)?;
    let meta = std::fs::metadata(&abs)?;
    if meta.len() > BYTES_CAP {
        return Err(AppError::new(format!(
            "too-large: {} bytes, cap is {}",
            meta.len(),
            BYTES_CAP
        )));
    }
    Ok(std::fs::read(&abs)?)
}

pub fn stat_path(root: &Path, rel: &str) -> AppResult<PathStat> {
    let abs = resolve_in_root(root, rel)?;
    let meta = std::fs::metadata(&abs)?;
    Ok(PathStat {
        size: if meta.is_dir() { 0 } else { meta.len() },
        modified: modified_millis(Some(&meta)),
        is_dir: meta.is_dir(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn reads_utf8_and_decodes_other_encodings_leniently() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("a.md"), "# héllo").unwrap();
        let t = read_text(tmp.path(), "a.md").unwrap();
        assert_eq!(t.text, "# héllo");
        assert!(!t.truncated);
        assert_eq!(t.bytes, 8);

        // Windows-1252 é (0xE9) is not UTF-8: still readable, with U+FFFD.
        fs::write(tmp.path().join("cp.csv"), b"caf\xE9,1").unwrap();
        let t = read_text(tmp.path(), "cp.csv").unwrap();
        assert!(t.text.starts_with("caf\u{FFFD}"));
    }

    #[test]
    fn flags_a_lossy_decode_so_the_editor_can_refuse_it() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("a.md"), "# héllo").unwrap();
        assert!(!read_text(tmp.path(), "a.md").unwrap().lossy);

        fs::write(tmp.path().join("cp.md"), b"caf\xE9").unwrap();
        let t = read_text(tmp.path(), "cp.md").unwrap();
        assert!(t.lossy);
        assert_eq!(t.text, "caf\u{FFFD}");
    }

    #[test]
    fn refuses_traversal_and_folders() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(read_text(tmp.path(), "../x").is_err());
        assert!(read_text(tmp.path(), "").is_err());
    }

    #[test]
    fn stat_reports_size_and_kind() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join("d")).unwrap();
        fs::write(tmp.path().join("d/f.bin"), [0u8; 10]).unwrap();
        let f = stat_path(tmp.path(), "d/f.bin").unwrap();
        assert_eq!(f.size, 10);
        assert!(!f.is_dir);
        let d = stat_path(tmp.path(), "d").unwrap();
        assert!(d.is_dir);
    }
}
