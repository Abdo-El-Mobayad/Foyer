//! The mount list, persisted as pretty JSON in the app's config directory.
//! Written atomically (temp file + rename) so a crash mid-write never leaves
//! an empty list behind.

use crate::error::AppResult;
use crate::rules::same_folder;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Mount {
    pub id: String,
    /// Absolute path, as picked.
    pub path: String,
    /// The folder's own name, or the trimmed path for a drive root (`D:`).
    pub name: String,
    pub added_at: u64,
    pub last_opened_at: u64,
    /// Computed at read time, never persisted: the folder is not on disk now.
    #[serde(default, skip_serializing)]
    pub missing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    #[serde(default = "one")]
    pub version: u32,
    #[serde(default)]
    pub mounts: Vec<Mount>,
    #[serde(default)]
    pub active_mount_id: Option<String>,
}

fn one() -> u32 {
    1
}

impl Default for AppConfig {
    fn default() -> Self {
        AppConfig {
            version: 1,
            mounts: Vec::new(),
            active_mount_id: None,
        }
    }
}

pub fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Label for a path with no `file_name` (a drive root): the path minus
/// trailing separators, so `D:\` reads "D:".
pub fn root_label(path: &str) -> String {
    let trimmed = path.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        path.to_string()
    } else {
        trimmed.to_string()
    }
}

pub fn name_for(path: &Path) -> String {
    match path.file_name().and_then(|s| s.to_str()) {
        Some(n) => n.to_string(),
        None => root_label(&path.to_string_lossy()),
    }
}

pub fn read(file: &Path) -> AppConfig {
    let mut cfg: AppConfig = std::fs::read_to_string(file)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    for m in &mut cfg.mounts {
        m.missing = !Path::new(&m.path).is_dir();
    }
    cfg
}

pub fn write(file: &Path, cfg: &AppConfig) -> AppResult<()> {
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp: PathBuf = file.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(cfg)?)?;
    if let Err(e) = std::fs::rename(&tmp, file) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }
    Ok(())
}

impl AppConfig {
    /// Add a folder, or return the existing mount for the same folder. The
    /// result is moved to the front and made active either way.
    pub fn add_or_activate(&mut self, path: &str) -> Mount {
        let now = now_ms();
        let pos = self.mounts.iter().position(|m| same_folder(&m.path, path));
        let mut mount = match pos {
            Some(i) => {
                let mut m = self.mounts.remove(i);
                m.last_opened_at = now;
                m
            }
            None => Mount {
                id: uuid::Uuid::new_v4().to_string(),
                path: path.to_string(),
                name: name_for(Path::new(path)),
                added_at: now,
                last_opened_at: now,
                missing: false,
            },
        };
        mount.missing = !Path::new(&mount.path).is_dir();
        self.mounts.insert(0, mount.clone());
        self.active_mount_id = Some(mount.id.clone());
        mount
    }

    /// Mark a mount opened: move it to the front, stamp it, make it active.
    pub fn touch(&mut self, id: &str) -> Option<Mount> {
        let i = self.mounts.iter().position(|m| m.id == id)?;
        let mut m = self.mounts.remove(i);
        m.last_opened_at = now_ms();
        m.missing = !Path::new(&m.path).is_dir();
        self.mounts.insert(0, m.clone());
        self.active_mount_id = Some(m.id.clone());
        Some(m)
    }

    pub fn remove(&mut self, id: &str) {
        self.mounts.retain(|m| m.id != id);
        if self.active_mount_id.as_deref() == Some(id) {
            self.active_mount_id = self.mounts.first().map(|m| m.id.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_through_disk_and_flags_missing_folders() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("cfg/config.json");
        let here = tmp.path().join("real");
        std::fs::create_dir_all(&here).unwrap();

        let mut cfg = AppConfig::default();
        let m = cfg.add_or_activate(here.to_str().unwrap());
        cfg.add_or_activate("/definitely/not/here");
        write(&file, &cfg).unwrap();

        let back = read(&file);
        assert_eq!(back.version, 1);
        assert_eq!(back.mounts.len(), 2);
        // Newest first.
        assert_eq!(back.mounts[0].path, "/definitely/not/here");
        assert!(back.mounts[0].missing);
        assert_eq!(back.mounts[1].id, m.id);
        assert!(!back.mounts[1].missing);
        assert_eq!(back.active_mount_id.as_deref(), Some(back.mounts[0].id.as_str()));
        assert!(!tmp.path().join("cfg/config.json.tmp").exists());
    }

    #[test]
    fn adding_the_same_folder_twice_activates_the_existing_mount() {
        let mut cfg = AppConfig::default();
        let a = cfg.add_or_activate("C:\\Users\\me\\.dotfiles");
        let b = cfg.add_or_activate("C:/Users/me/.dotfiles/");
        assert_eq!(a.id, b.id);
        assert_eq!(cfg.mounts.len(), 1);
        assert_eq!(cfg.mounts[0].name, ".dotfiles");
    }

    #[test]
    fn touch_and_remove_keep_the_active_id_sane() {
        let mut cfg = AppConfig::default();
        let a = cfg.add_or_activate("/a");
        let b = cfg.add_or_activate("/b");
        assert_eq!(cfg.active_mount_id.as_deref(), Some(b.id.as_str()));
        cfg.touch(&a.id);
        assert_eq!(cfg.mounts[0].id, a.id);
        assert_eq!(cfg.active_mount_id.as_deref(), Some(a.id.as_str()));
        cfg.remove(&a.id);
        assert_eq!(cfg.active_mount_id.as_deref(), Some(b.id.as_str()));
        cfg.remove(&b.id);
        assert_eq!(cfg.active_mount_id, None);
        assert!(cfg.touch("nope").is_none());
    }

    #[test]
    fn names_drive_roots_by_their_path() {
        assert_eq!(root_label("D:\\"), "D:");
        assert_eq!(root_label("/"), "/");
        assert_eq!(name_for(Path::new("/home/me/Notes")), "Notes");
    }

    #[test]
    fn a_missing_or_corrupt_file_reads_as_empty() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(read(&tmp.path().join("nope.json")), AppConfig::default());
        let bad = tmp.path().join("bad.json");
        std::fs::write(&bad, b"{not json").unwrap();
        assert_eq!(read(&bad), AppConfig::default());
    }
}
