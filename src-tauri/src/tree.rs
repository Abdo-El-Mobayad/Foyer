//! One directory level of a mount, for the lazily loaded sidebar.

use crate::error::AppResult;
use crate::rules::is_ignored_dir;
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    /// Stable string id: the mount-relative path.
    pub id: String,
    pub name: String,
    /// Mount-relative, forward-slash path.
    pub path: String,
    pub is_dir: bool,
    /// Present (possibly empty) for directories; None for files.
    pub children: Option<Vec<TreeNode>>,
    /// Directories only: whether `children` is the real listing or the lazy
    /// placeholder. Always true for files.
    pub children_loaded: bool,
    /// Last-modified time, milliseconds since the Unix epoch; 0 when unknown.
    pub modified: u64,
    /// Bytes, 0 for directories.
    pub size: u64,
}

/// A directory entry's mtime in epoch millis, or 0 if it can't be read.
pub fn modified_millis(meta: Option<&std::fs::Metadata>) -> u64 {
    meta.and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// List one directory's immediate children. Sub-directories come back with an
/// empty `children` vec and `children_loaded: false`, files as leaves. Every
/// file is listed; only pruned directories (see `rules.rs`) are skipped.
/// Folders first, then files, each in case-insensitive name order (the UI
/// re-sorts with a natural collator; this order only has to be stable).
pub fn list_children(root: &Path, rel: &str) -> AppResult<Vec<TreeNode>> {
    let dir = if rel.is_empty() {
        root.to_path_buf()
    } else {
        root.join(rel)
    };
    let mut dirs: Vec<TreeNode> = Vec::new();
    let mut files: Vec<TreeNode> = Vec::new();

    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Ok(Vec::new()),
    };

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let child_rel = if rel.is_empty() {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };
        // `file_type` on a symlink reports the link; resolve through metadata
        // so a linked folder still lists as a folder.
        let meta = std::fs::metadata(entry.path()).ok();
        let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let is_file = meta.as_ref().map(|m| m.is_file()).unwrap_or(false);

        if is_dir {
            if is_ignored_dir(&name) {
                continue;
            }
            dirs.push(TreeNode {
                id: child_rel.clone(),
                name,
                path: child_rel,
                is_dir: true,
                children: Some(Vec::new()),
                children_loaded: false,
                modified: modified_millis(meta.as_ref()),
                size: 0,
            });
        } else if is_file {
            files.push(TreeNode {
                id: child_rel.clone(),
                name,
                path: child_rel,
                is_dir: false,
                children: None,
                children_loaded: true,
                modified: modified_millis(meta.as_ref()),
                size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
            });
        }
    }

    // One lowercase key per entry, not one per comparison.
    dirs.sort_by_cached_key(|n| n.name.to_lowercase());
    files.sort_by_cached_key(|n| n.name.to_lowercase());
    dirs.extend(files);
    Ok(dirs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn lists_every_file_and_every_wanted_dot_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join(".claude/skills")).unwrap();
        fs::write(root.join(".claude/skills/SKILL.md"), b"# skill").unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join(".git/config"), b"x").unwrap();
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        fs::write(root.join("node_modules/pkg/index.js"), b"x").unwrap();
        fs::create_dir_all(root.join("Vault")).unwrap();
        fs::write(root.join("Vault/INDEX.json"), b"{}").unwrap();
        fs::write(root.join(".gitignore"), b"node_modules").unwrap();
        fs::write(root.join(".env"), b"KEY=1").unwrap();
        fs::write(root.join("pnpm-lock.yaml"), b"lock").unwrap();
        fs::write(root.join("archive.zip"), b"PK").unwrap();
        fs::write(root.join("notes.md"), b"# n").unwrap();

        let top = list_children(root, "").unwrap();
        let names: Vec<&str> = top.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(
            names,
            vec![".claude", "Vault", ".env", ".gitignore", "archive.zip", "notes.md", "pnpm-lock.yaml"]
        );

        // Folders are lazy placeholders until listed.
        let claude = &top[0];
        assert!(claude.is_dir);
        assert!(!claude.children_loaded);
        let skills = list_children(root, ".claude/skills").unwrap();
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "SKILL.md");
        assert_eq!(skills[0].path, ".claude/skills/SKILL.md");
        assert_eq!(skills[0].size, 7);
        assert!(skills[0].modified > 0);
    }

    #[test]
    fn unreadable_dir_lists_as_empty_rather_than_failing() {
        let tmp = tempfile::tempdir().unwrap();
        let kids = list_children(tmp.path(), "does/not/exist").unwrap();
        assert!(kids.is_empty());
    }
}
