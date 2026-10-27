//! What the tree walk and the name index skip, and safe resolution of
//! mount-relative paths (traversal rejection).
//!
//! The one rule: show everything, except heavy generated output. Dotfolders
//! (`.claude`, `.agents`, `.codex`, `.github`) and dotfiles (`.env`,
//! `.gitignore`) are content and are always listed. Gitignored files are
//! listed; the app never reads `.gitignore`. The only things pruned are the
//! folders below, which are rebuilt by tooling and would otherwise flood a
//! mount with tens of thousands of entries nobody browses.

use crate::error::{AppError, AppResult};
use std::path::{Component, Path, PathBuf};

/// Names that are never walked, wherever they appear. `.git` is the store
/// itself, not the working tree, so its internals are never content.
pub const DENIED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "dist",
    "build",
    "target",
    "vendor",
    "__pycache__",
    "venv",
];

/// Derived and cache folders that start with a dot. Named individually because
/// the blanket "skip every dot-directory" rule is exactly what this app does
/// not have.
pub const DENIED_DOT_DIRS: &[&str] = &[
    // JS/TS build + cache output
    ".next",
    ".nuxt",
    ".output",
    ".cache",
    ".parcel-cache",
    ".turbo",
    ".svelte-kit",
    ".vercel",
    ".netlify",
    ".yarn",
    ".pnpm-store",
    ".angular",
    // Python
    ".venv",
    ".tox",
    ".eggs",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    // JVM / infra / editors
    ".gradle",
    ".terraform",
    ".idea",
    ".vs",
    ".bundle",
    ".dart_tool",
    // The index and CRDT store of the app this one was forked from. Some
    // mounts still carry one; it is derived data, never content.
    ".context",
];

/// True if a directory name is pruned by the tree walk, the index and the
/// watcher. Files are never pruned by name.
pub fn is_ignored_dir(name: &str) -> bool {
    DENIED_DIRS.contains(&name) || DENIED_DOT_DIRS.contains(&name)
}

/// True if any component of a mount-relative path is a pruned directory.
pub fn rel_path_is_ignored(rel: &str) -> bool {
    rel.split('/')
        .any(|seg| !seg.is_empty() && is_ignored_dir(seg))
}

/// Resolve a mount-relative path to an absolute path *inside* the mount,
/// rejecting `..` traversal, absolute inputs, and anything that escapes root.
pub fn resolve_in_root(root: &Path, rel: &str) -> AppResult<PathBuf> {
    let candidate = Path::new(rel);

    for comp in candidate.components() {
        match comp {
            Component::Normal(_) | Component::CurDir => {}
            Component::ParentDir => {
                return Err(AppError::new("path traversal ('..') is not allowed"));
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(AppError::new("absolute paths are not allowed"));
            }
        }
    }

    let joined = root.join(candidate);

    // Defense in depth: after lexical normalization the result must still be
    // within the root.
    let normalized = normalize_lexically(&joined);
    let root_norm = normalize_lexically(root);
    if !normalized.starts_with(&root_norm) {
        return Err(AppError::new("resolved path escapes the mount"));
    }
    Ok(normalized)
}

/// Lexical normalization (collapse `.` / `..`) without filesystem access.
pub fn normalize_lexically(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Compute a mount-relative, forward-slash path from an absolute path.
pub fn rel_from_abs(root: &Path, abs: &Path) -> AppResult<String> {
    let root_norm = normalize_lexically(root);
    let abs_norm = normalize_lexically(abs);
    let rel = abs_norm
        .strip_prefix(&root_norm)
        .map_err(|_| AppError::new("path is outside the mount"))?;
    Ok(rel
        .components()
        .filter_map(|c| c.as_os_str().to_str())
        .collect::<Vec<_>>()
        .join("/"))
}

/// Two paths name the same folder if they normalize to the same thing,
/// ignoring separator style and case on Windows.
pub fn same_folder(a: &str, b: &str) -> bool {
    fn key(s: &str) -> String {
        let n = normalize_lexically(Path::new(s))
            .to_string_lossy()
            .replace('\\', "/")
            .trim_end_matches('/')
            .to_string();
        if cfg!(windows) {
            n.to_lowercase()
        } else {
            n
        }
    }
    key(a) == key(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        PathBuf::from("/tmp/mount")
    }

    #[test]
    fn rejects_parent_traversal() {
        assert!(resolve_in_root(&root(), "../secret.md").is_err());
        assert!(resolve_in_root(&root(), "notes/../../etc/passwd").is_err());
    }

    #[test]
    fn rejects_absolute_paths() {
        assert!(resolve_in_root(&root(), "/etc/passwd").is_err());
    }

    #[test]
    fn accepts_nested_relative_paths() {
        let p = resolve_in_root(&root(), "sub/dir/note.md").unwrap();
        assert_eq!(p, PathBuf::from("/tmp/mount/sub/dir/note.md"));
    }

    #[test]
    fn every_wanted_dot_dir_is_surfaced() {
        for wanted in [".claude", ".agents", ".codex", ".cursor", ".github", ".obsidian", ".vscode"] {
            assert!(!is_ignored_dir(wanted), "{wanted} must be surfaced");
        }
        assert!(!rel_path_is_ignored(".claude/skills/git-commits/SKILL.md"));
        assert!(!rel_path_is_ignored(".agents/notes/plan.md"));
    }

    #[test]
    fn heavy_and_derived_dirs_are_pruned() {
        for denied in [
            "node_modules", ".git", "target", "dist", "build", ".venv", "venv", "__pycache__",
            ".next", ".turbo", ".cache", ".context", ".pytest_cache", ".gradle",
        ] {
            assert!(is_ignored_dir(denied), "{denied} must be pruned");
        }
        assert!(rel_path_is_ignored("web/.next/server/page.js"));
        assert!(rel_path_is_ignored("app/node_modules/pkg/index.js"));
        assert!(rel_path_is_ignored("a/.git/config"));
        assert!(!rel_path_is_ignored("a/b/note.md"));
        assert!(!is_ignored_dir("Projects"));
    }

    #[test]
    fn dotfiles_are_not_a_directory_rule() {
        // Files are never pruned by name: `.env`, `.gitignore`, `INDEX.json` and
        // a lockfile are all listed. Only directories are checked.
        for f in [".env", ".gitignore", ".npmrc", "pnpm-lock.yaml", "bundle.min.js", "id.pem"] {
            assert!(!is_ignored_dir(f), "{f} is a file name and must not be pruned");
        }
    }

    #[test]
    fn rel_from_abs_uses_forward_slashes() {
        let rel = rel_from_abs(&root(), Path::new("/tmp/mount/a/b.md")).unwrap();
        assert_eq!(rel, "a/b.md");
    }

    #[test]
    fn same_folder_ignores_separators_and_trailing_slash() {
        assert!(same_folder("C:\\Users\\me\\.dotfiles", "C:/Users/me/.dotfiles/"));
        assert!(!same_folder("C:/Users/me/.dotfiles", "C:/Users/me/.dotfiles2"));
    }
}
