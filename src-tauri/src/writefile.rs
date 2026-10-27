//! The write path, and the only one in this crate. Foyer is read-only
//! everywhere except notes: a Markdown file (`.md`, `.markdown`, `.mdx`) can
//! be saved, created, renamed and moved to the Recycle Bin, and a folder can
//! be created, renamed and binned. Code, config and every other file stay
//! read-only; VS Code is one shortcut away for those.
//!
//! Every path goes through the same `resolve_in_root` as the reads, so no
//! write can leave the mount. Each function takes the mount root and touches
//! nothing but the disk under it, so all of them are tested against a
//! `tempfile` folder. Refusals carry a machine prefix the UI branches on:
//! `conflict:`, `exists:`, `invalid-name:`, `not-editable:`.

use crate::error::{AppError, AppResult};
use crate::rules::{is_ignored_dir, normalize_lexically, rel_from_abs, rel_path_is_ignored, resolve_in_root};
use crate::tree::modified_millis;
use serde::Serialize;
use std::ffi::OsStr;
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

/// Suffix of the temp file a save stages before renaming it over the note.
/// The watcher drops paths ending in it, so a save never flashes a row in the
/// tree; the tree listing itself still shows an orphan a crash left behind.
pub const TEMP_SUFFIX: &str = ".foyer.tmp";

/// Longest name a folder entry may have, in UTF-16 units: the NTFS limit, and
/// what JS `string.length` counts, so the UI's mirror of these rules agrees.
pub const NAME_MAX: usize = 255;

/// Extensions that make a file a note, compared case-insensitively.
const MARKDOWN_EXTS: &[&str] = &["md", "markdown", "mdx"];

/// Characters Windows refuses in a name. Control characters are checked
/// separately.
const FORBIDDEN_CHARS: &[char] = &['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

/// Names Windows reserves for devices, with or without an extension.
const DEVICE_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1",
    "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Characters of the note's own name kept in its temp name. Bounded so a note
/// near the length limit still gets a temp name the file system accepts.
const TEMP_NAME_KEEP: usize = 64;

/// What a save leaves on disk: the note's new mtime, which is the editor's
/// next `expected_modified`, and its size.
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub modified: u64,
    pub bytes: u64,
}

fn invalid(reason: impl std::fmt::Display) -> AppError {
    AppError::new(format!("invalid-name: {reason}"))
}

fn exists(name: &str) -> AppError {
    AppError::new(format!("exists: {name} already exists"))
}

fn gone() -> AppError {
    AppError::new("that file or folder no longer exists")
}

/// Refuse a name the file system would reject or quietly mangle. Checked here
/// rather than left to the OS so the UI gets one readable `invalid-name:`
/// reason instead of an OS error code, and so a name Windows would alter
/// (it strips a trailing dot or space) or never open (`con.md`) is caught
/// before it reaches the disk. The TS side mirrors these rules only for
/// inline feedback; this is the authority.
pub fn validate_name(name: &str) -> AppResult<()> {
    if name.is_empty() {
        return Err(invalid("a name is required"));
    }
    if name.encode_utf16().count() > NAME_MAX {
        return Err(invalid(format!("longer than {NAME_MAX} characters")));
    }
    if name == "." || name == ".." {
        return Err(invalid("`.` and `..` are not names"));
    }
    if let Some(c) = name.chars().find(|c| FORBIDDEN_CHARS.contains(c)) {
        return Err(invalid(format!("`{c}` is not allowed in a name")));
    }
    if name.chars().any(|c| (c as u32) < 0x20) {
        return Err(invalid("control characters are not allowed in a name"));
    }
    if name.ends_with(' ') || name.ends_with('.') {
        return Err(invalid("a name cannot end with a space or a dot"));
    }
    // Windows reads `con.md` and `con.tar.gz` as the device too, so the part
    // before the first dot is what counts.
    let stem = name.split('.').next().unwrap_or("").trim_end_matches(' ');
    if DEVICE_NAMES.iter().any(|d| d.eq_ignore_ascii_case(stem)) {
        return Err(invalid(format!("`{stem}` is a name Windows reserves for a device")));
    }
    Ok(())
}

/// True if a name carries a Markdown extension, which makes it a note: the
/// only kind of file this app writes (D2). Case-insensitive, since `NOTES.MD`
/// is as much a note as `notes.md`.
pub fn is_markdown_name(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|ext| MARKDOWN_EXTS.iter().any(|m| ext.eq_ignore_ascii_case(m)))
}

/// The final path segment as UTF-8, for the Markdown and name checks.
fn file_name_of(abs: &Path) -> AppResult<String> {
    abs.file_name()
        .and_then(|n| n.to_str())
        .map(str::to_string)
        .ok_or_else(|| AppError::new("that path has no file name"))
}

/// Metadata if the path exists, None if it does not. Any other failure (a
/// permission error) is reported rather than read as "missing".
fn stat_opt(abs: &Path) -> AppResult<Option<fs::Metadata>> {
    match fs::metadata(abs) {
        Ok(m) => Ok(Some(m)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Save a note (D2, D4, D5). `expected_modified` is the mtime the editor
/// loaded: when the disk no longer matches it, something else wrote the file
/// since, and the save is refused with `conflict:` rather than overwriting
/// that change. `None` is the deliberate overwrite behind "Keep mine" and
/// "Restore my copy", and recreates a note deleted on disk. The bytes are
/// written exactly as given; reproducing line endings and a BOM is the
/// editor's job, so this layer never rewrites them.
pub fn write_text(root: &Path, rel: &str, text: &str, expected_modified: Option<u64>) -> AppResult<WriteResult> {
    let abs = resolve_in_root(root, rel)?;
    let name = file_name_of(&abs)?;
    if !is_markdown_name(&name) {
        return Err(AppError::new("not-editable: only Markdown files can be written"));
    }
    let current = stat_opt(&abs)?;
    if current.as_ref().is_some_and(|m| m.is_dir()) {
        return Err(AppError::new("that path is a folder"));
    }
    if let Some(expected) = expected_modified {
        match &current {
            None => return Err(AppError::new("conflict: deleted on disk")),
            Some(m) if modified_millis(Some(m)) != expected => {
                return Err(AppError::new("conflict: changed on disk"));
            }
            Some(_) => {}
        }
    }
    if current.is_none() {
        // This save creates the file, so it answers to the same name rules as
        // New note; an unconditional write is not a way around them.
        validate_name(&name)?;
        if !abs.parent().is_some_and(Path::is_dir) {
            return Err(AppError::new("the folder this note belongs in no longer exists"));
        }
    }
    replace_contents(&abs, &name, text.as_bytes())?;
    let after = fs::metadata(&abs)?;
    Ok(WriteResult {
        modified: modified_millis(Some(&after)),
        bytes: after.len(),
    })
}

/// Write `bytes` to `abs` so a reader, or a crash, sees the old note or the
/// new one, never half of each: stage the bytes in a temp file in the same
/// folder (same volume, so the rename is a rename and not a copy), flush it to
/// disk, then rename it over the note. If the rename fails, typically because
/// another program holds the note open without delete sharing, fall back to
/// writing in place, which that sharing mode still allows. A staging failure
/// (disk full, no right to create in the folder) is returned as is: writing
/// in place then could leave the note truncated. The temp file is removed on
/// every path.
///
/// A note that is itself a symlink is written in place through the link, so
/// the link survives; renaming over it would replace the link with a copy.
fn replace_contents(abs: &Path, name: &str, bytes: &[u8]) -> AppResult<()> {
    let is_link = fs::symlink_metadata(abs).is_ok_and(|m| m.file_type().is_symlink());
    if is_link {
        return Ok(write_in_place(abs, bytes)?);
    }
    let tmp = abs.with_file_name(temp_name(name));
    let result = stage(&tmp, bytes).and_then(|()| match fs::rename(&tmp, abs) {
        Ok(()) => Ok(()),
        Err(_) => write_in_place(abs, bytes),
    });
    let _ = fs::remove_file(&tmp);
    Ok(result?)
}

/// `.{name}.{uuid}.foyer.tmp`: unique per save, next to the note, and
/// recognisable by its suffix to the watcher and to anyone cleaning up after
/// a crash.
fn temp_name(name: &str) -> String {
    let keep: String = name.chars().take(TEMP_NAME_KEEP).collect();
    format!(".{keep}.{}{TEMP_SUFFIX}", uuid::Uuid::new_v4().simple())
}

/// Create the temp file (never an existing one), write it and flush it. The
/// handle closes on return, before the rename, which Windows requires.
fn stage(tmp: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut f = OpenOptions::new().write(true).create_new(true).open(tmp)?;
    f.write_all(bytes)?;
    f.sync_all()
}

fn write_in_place(abs: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut f = OpenOptions::new().write(true).create(true).truncate(true).open(abs)?;
    f.write_all(bytes)?;
    f.sync_all()
}

/// The folder something is created in; `dir` "" is the mount root. A pruned
/// folder (`node_modules`, `.git`, a build cache) is refused: the tree never
/// shows it, so whatever was created there would vanish from view. Checked on
/// the resolved path, so `./node_modules` and a backslash spelling are caught
/// too.
fn resolve_create_dir(root: &Path, dir: &str) -> AppResult<PathBuf> {
    if dir.is_empty() {
        return Ok(root.to_path_buf());
    }
    let abs = resolve_in_root(root, dir)?;
    if rel_path_is_ignored(&rel_from_abs(root, &abs)?) {
        return Err(AppError::new("not-editable: that folder is hidden from the tree"));
    }
    match stat_opt(&abs)? {
        Some(m) if m.is_dir() => Ok(abs),
        Some(_) => Err(AppError::new("that path is not a folder")),
        None => Err(AppError::new("that folder no longer exists")),
    }
}

/// An existing entry's path from a mount-relative path that names something
/// below the mount. The mount folder itself ("" or ".") is never renamed or
/// binned from inside the app.
fn resolve_entry(root: &Path, rel: &str) -> AppResult<PathBuf> {
    let abs = resolve_in_root(root, rel)?;
    if abs == normalize_lexically(root) {
        return Err(AppError::new("not-editable: the mount folder itself cannot be renamed or deleted"));
    }
    Ok(abs)
}

/// Create an empty note in `dir` and return its mount-relative path for the UI
/// to open. Never replaces anything: a file or folder already holding the name
/// is `exists:`, and the create itself (`create_new`) closes the window between
/// that check and the write.
pub fn create_note(root: &Path, dir: &str, name: &str) -> AppResult<String> {
    let folder = resolve_create_dir(root, dir)?;
    validate_name(name)?;
    if !is_markdown_name(name) {
        return Err(AppError::new("not-editable: a note must end in .md"));
    }
    let abs = folder.join(name);
    if fs::symlink_metadata(&abs).is_ok() {
        return Err(exists(name));
    }
    match OpenOptions::new().write(true).create_new(true).open(&abs) {
        Ok(_) => rel_from_abs(root, &abs),
        Err(e) if e.kind() == ErrorKind::AlreadyExists => Err(exists(name)),
        Err(e) => Err(e.into()),
    }
}

/// Create a folder in `dir` and return its mount-relative path. A name the
/// tree prunes (`node_modules`, `dist`, `.cache`) is refused, since the new
/// folder would never be shown.
pub fn create_folder(root: &Path, dir: &str, name: &str) -> AppResult<String> {
    let parent = resolve_create_dir(root, dir)?;
    validate_name(name)?;
    if is_ignored_dir(name) {
        return Err(invalid(format!("`{name}` is a build or cache folder name the tree hides")));
    }
    let abs = parent.join(name);
    match fs::create_dir(&abs) {
        Ok(()) => rel_from_abs(root, &abs),
        Err(e) if e.kind() == ErrorKind::AlreadyExists => Err(exists(name)),
        Err(e) => Err(e.into()),
    }
}

/// True if `dir` holds an entry named exactly `name`, byte for byte. Tells a
/// case-only rename (the "existing" destination is the entry itself, seen
/// through a case-insensitive file system) from a real clash with a
/// different entry on a case-sensitive one.
fn has_exact_entry(dir: &Path, name: &str) -> bool {
    fs::read_dir(dir).is_ok_and(|it| it.flatten().any(|e| e.file_name() == OsStr::new(name)))
}

/// Rename a note or folder in place (D9): name only, same parent, so a rename
/// cannot move anything out of the folder the user is looking at, let alone
/// out of the mount. A note keeps a Markdown extension. An existing
/// destination is refused, except the same entry under a new case
/// (`notes.md` to `Notes.md`), which a case-insensitive file system reports as
/// already existing. Returns the new mount-relative path.
pub fn rename_path(root: &Path, rel: &str, new_name: &str) -> AppResult<String> {
    let src = resolve_entry(root, rel)?;
    let meta = stat_opt(&src)?.ok_or_else(gone)?;
    validate_name(new_name)?;
    let old_name = file_name_of(&src)?;
    if meta.is_dir() {
        if is_ignored_dir(new_name) {
            return Err(invalid(format!("`{new_name}` is a build or cache folder name the tree hides")));
        }
    } else {
        if !is_markdown_name(&old_name) {
            return Err(AppError::new("not-editable: only Markdown files can be renamed"));
        }
        if !is_markdown_name(new_name) {
            return Err(invalid("a note must keep a Markdown extension"));
        }
    }
    if old_name == new_name {
        return rel_from_abs(root, &src);
    }
    let parent = src.parent().ok_or_else(gone)?;
    let dst = parent.join(new_name);
    if fs::symlink_metadata(&dst).is_ok() {
        let case_only = old_name.eq_ignore_ascii_case(new_name) && !has_exact_entry(parent, new_name);
        if !case_only {
            return Err(exists(new_name));
        }
    }
    fs::rename(&src, &dst)?;
    rel_from_abs(root, &dst)
}

/// Move a note or a folder to the Recycle Bin (D10), never a permanent delete,
/// so a mistaken delete is one Restore away. Any other file is refused, like
/// every other write.
pub fn trash_path(root: &Path, rel: &str) -> AppResult<()> {
    let abs = trashable(root, rel)?;
    trash::delete(&abs).map_err(|e| AppError::new(format!("could not move to the Recycle Bin: {e}")))
}

/// The refusals of `trash_path`, apart from the bin call so tests can prove
/// them without littering the real Recycle Bin.
fn trashable(root: &Path, rel: &str) -> AppResult<PathBuf> {
    let abs = resolve_entry(root, rel)?;
    let meta = stat_opt(&abs)?.ok_or_else(gone)?;
    if !meta.is_dir() && !is_markdown_name(&file_name_of(&abs)?) {
        return Err(AppError::new("not-editable: only Markdown files and folders can be deleted here"));
    }
    Ok(abs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, UNIX_EPOCH};

    fn msg<T: std::fmt::Debug>(r: AppResult<T>) -> String {
        r.unwrap_err().0
    }

    fn temps_in(dir: &Path) -> Vec<String> {
        fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(TEMP_SUFFIX))
            .collect()
    }

    fn names_in(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    /// Put a file's mtime in the past, so the next write is certain to move
    /// it, and return the mtime as the editor would have loaded it.
    fn backdate(path: &Path) -> u64 {
        let f = OpenOptions::new().write(true).open(path).unwrap();
        f.set_modified(UNIX_EPOCH + Duration::from_secs(1_600_000_000)).unwrap();
        drop(f);
        modified_millis(fs::metadata(path).ok().as_ref())
    }

    #[test]
    fn a_save_round_trips_and_leaves_no_temp_file() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("notes")).unwrap();
        fs::write(root.join("notes/a.md"), "old text").unwrap();

        let r = write_text(root, "notes/a.md", "# new", None).unwrap();
        assert_eq!(fs::read_to_string(root.join("notes/a.md")).unwrap(), "# new");
        assert_eq!(r.bytes, 5);
        assert_eq!(r.modified, modified_millis(fs::metadata(root.join("notes/a.md")).ok().as_ref()));
        assert!(temps_in(&root.join("notes")).is_empty());
        assert_eq!(names_in(&root.join("notes")), vec!["a.md"]);
    }

    #[test]
    fn crlf_and_a_bom_are_written_byte_for_byte() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let text = "\u{FEFF}# Title\r\n\r\nline one\r\nline two\n";
        write_text(root, "a.md", text, None).unwrap();
        let on_disk = fs::read(root.join("a.md")).unwrap();
        assert_eq!(on_disk, text.as_bytes());
        assert_eq!(&on_disk[..3], &[0xEF, 0xBB, 0xBF]);
    }

    #[test]
    fn a_matching_mtime_saves_and_returns_the_next_one() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::write(root.join("a.md"), "v1").unwrap();
        let loaded = backdate(&root.join("a.md"));

        let r = write_text(root, "a.md", "v2", Some(loaded)).unwrap();
        assert!(r.modified > loaded, "the save must move the mtime");
        assert_eq!(fs::read_to_string(root.join("a.md")).unwrap(), "v2");
        // What the save returned is what the next save expects.
        write_text(root, "a.md", "v3", Some(r.modified)).unwrap();
        assert_eq!(fs::read_to_string(root.join("a.md")).unwrap(), "v3");
    }

    #[test]
    fn a_stale_mtime_or_a_deleted_note_is_a_conflict() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::write(root.join("a.md"), "theirs").unwrap();
        let on_disk = backdate(&root.join("a.md"));

        assert_eq!(msg(write_text(root, "a.md", "mine", Some(on_disk + 1))), "conflict: changed on disk");
        assert_eq!(fs::read_to_string(root.join("a.md")).unwrap(), "theirs");

        assert_eq!(msg(write_text(root, "gone.md", "mine", Some(on_disk))), "conflict: deleted on disk");
        assert!(!root.join("gone.md").exists());

        // None is the deliberate overwrite, and it recreates a deleted note.
        write_text(root, "gone.md", "restored", None).unwrap();
        assert_eq!(fs::read_to_string(root.join("gone.md")).unwrap(), "restored");
        write_text(root, "a.md", "mine", None).unwrap();
        assert_eq!(fs::read_to_string(root.join("a.md")).unwrap(), "mine");
    }

    #[test]
    fn only_markdown_inside_the_mount_is_written() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::write(root.join("main.rs"), "fn main() {}").unwrap();
        fs::create_dir_all(root.join("folder.md")).unwrap();

        assert!(msg(write_text(root, "main.rs", "x", None)).starts_with("not-editable:"));
        assert_eq!(fs::read_to_string(root.join("main.rs")).unwrap(), "fn main() {}");
        assert!(msg(write_text(root, "notes.md.bak", "x", None)).starts_with("not-editable:"));
        assert!(write_text(root, "../x.md", "x", None).is_err());
        assert!(write_text(root, "", "x", None).is_err());
        assert_eq!(msg(write_text(root, "folder.md", "x", None)), "that path is a folder");
        assert!(write_text(root, "no/such/folder/a.md", "x", None).is_err());
        assert!(msg(write_text(root, "con.md", "x", None)).starts_with("invalid-name:"));

        for ok in ["README.MD", "b.markdown", "c.Mdx"] {
            write_text(root, ok, "x", None).unwrap();
        }
    }

    #[test]
    fn create_note_makes_an_empty_note_once() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        assert_eq!(create_note(root, "", "a.md").unwrap(), "a.md");
        assert_eq!(fs::read(root.join("a.md")).unwrap().len(), 0);
        fs::create_dir_all(root.join("sub/deeper")).unwrap();
        assert_eq!(create_note(root, "sub/deeper", "b.md").unwrap(), "sub/deeper/b.md");

        assert_eq!(msg(create_note(root, "", "a.md")), "exists: a.md already exists");
        fs::create_dir(root.join("dir.md")).unwrap();
        assert!(msg(create_note(root, "", "dir.md")).starts_with("exists:"));
    }

    #[test]
    fn create_note_refuses_bad_names_and_hidden_folders() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        assert_eq!(msg(create_note(root, "", "a.txt")), "not-editable: a note must end in .md");
        for bad in ["", "con.md", "a:b.md", "a/b.md", "x.md ", "x.md.", "q?.md"] {
            assert!(msg(create_note(root, "", bad)).starts_with("invalid-name:"), "{bad:?}");
        }
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        fs::create_dir_all(root.join("web/.next")).unwrap();
        for hidden in ["node_modules", "node_modules/pkg", "./node_modules", "web/.next"] {
            assert!(msg(create_note(root, hidden, "a.md")).starts_with("not-editable:"), "{hidden}");
        }
        assert!(!root.join("node_modules/pkg/a.md").exists());
        assert!(create_note(root, "missing", "a.md").is_err());
        assert!(create_note(root, "..", "a.md").is_err());
        fs::write(root.join("file.md"), "").unwrap();
        assert_eq!(msg(create_note(root, "file.md", "a.md")), "that path is not a folder");
    }

    #[test]
    fn create_folder_makes_a_folder_once_and_never_a_hidden_one() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        assert_eq!(create_folder(root, "", "Projects").unwrap(), "Projects");
        assert_eq!(create_folder(root, "Projects", "2026").unwrap(), "Projects/2026");
        assert!(root.join("Projects/2026").is_dir());

        assert_eq!(msg(create_folder(root, "", "Projects")), "exists: Projects already exists");
        for pruned in ["node_modules", "dist", ".cache", ".git"] {
            assert!(msg(create_folder(root, "", pruned)).starts_with("invalid-name:"), "{pruned}");
        }
        assert!(msg(create_folder(root, "", "a|b")).starts_with("invalid-name:"));
        fs::create_dir_all(root.join(".git")).unwrap();
        assert!(msg(create_folder(root, ".git", "x")).starts_with("not-editable:"));
    }

    #[test]
    fn rename_moves_a_note_or_a_folder_within_its_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("notes")).unwrap();
        fs::write(root.join("notes/a.md"), "x").unwrap();

        assert_eq!(rename_path(root, "notes/a.md", "b.md").unwrap(), "notes/b.md");
        assert_eq!(names_in(&root.join("notes")), vec!["b.md"]);
        assert_eq!(fs::read_to_string(root.join("notes/b.md")).unwrap(), "x");

        assert_eq!(rename_path(root, "notes", "Journal").unwrap(), "Journal");
        assert!(root.join("Journal/b.md").is_file());
        assert!(!root.join("notes").exists());

        // The same name is a no-op, not a clash with itself.
        assert_eq!(rename_path(root, "Journal/b.md", "b.md").unwrap(), "Journal/b.md");
    }

    #[test]
    fn a_case_only_rename_is_allowed() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::write(root.join("note.md"), "x").unwrap();
        fs::create_dir(root.join("docs")).unwrap();

        assert_eq!(rename_path(root, "note.md", "Note.md").unwrap(), "Note.md");
        assert_eq!(rename_path(root, "docs", "Docs").unwrap(), "Docs");
        assert_eq!(names_in(root), vec!["Docs", "Note.md"]);
        assert_eq!(fs::read_to_string(root.join("Note.md")).unwrap(), "x");
    }

    #[test]
    fn rename_refuses_clashes_non_notes_and_the_mount_itself() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::write(root.join("a.md"), "a").unwrap();
        fs::write(root.join("b.md"), "b").unwrap();
        fs::write(root.join("c.txt"), "c").unwrap();
        fs::create_dir(root.join("dir")).unwrap();

        assert_eq!(msg(rename_path(root, "a.md", "b.md")), "exists: b.md already exists");
        assert_eq!(fs::read_to_string(root.join("a.md")).unwrap(), "a");
        assert_eq!(fs::read_to_string(root.join("b.md")).unwrap(), "b");
        assert_eq!(msg(rename_path(root, "dir", "a.md")), "exists: a.md already exists");

        assert_eq!(
            msg(rename_path(root, "a.md", "a.txt")),
            "invalid-name: a note must keep a Markdown extension"
        );
        assert_eq!(msg(rename_path(root, "c.txt", "d.txt")), "not-editable: only Markdown files can be renamed");
        assert!(msg(rename_path(root, "c.txt", "c.md")).starts_with("not-editable:"));
        assert!(msg(rename_path(root, "a.md", "x/y.md")).starts_with("invalid-name:"));
        assert!(msg(rename_path(root, "dir", "node_modules")).starts_with("invalid-name:"));

        assert!(msg(rename_path(root, "", "x")).starts_with("not-editable:"));
        assert!(msg(rename_path(root, ".", "x")).starts_with("not-editable:"));
        assert!(rename_path(root, "missing.md", "x.md").is_err());
        assert!(rename_path(root, "../a.md", "x.md").is_err());
        assert_eq!(names_in(root), vec!["a.md", "b.md", "c.txt", "dir"]);
    }

    #[test]
    fn trash_refusals_never_reach_the_bin() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::write(root.join("main.rs"), "fn main() {}").unwrap();

        assert_eq!(
            msg(trash_path(root, "main.rs")),
            "not-editable: only Markdown files and folders can be deleted here"
        );
        assert!(root.join("main.rs").exists());
        assert!(msg(trash_path(root, "")).starts_with("not-editable:"));
        assert!(msg(trash_path(root, ".")).starts_with("not-editable:"));
        assert_eq!(msg(trash_path(root, "missing.md")), "that file or folder no longer exists");
        assert!(trash_path(root, "../x.md").is_err());
    }

    #[test]
    fn notes_and_folders_pass_the_trash_gate() {
        // The gate only: the bin call itself is not exercised in tests.
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::write(root.join("a.MD"), "").unwrap();
        fs::create_dir(root.join("dir")).unwrap();
        assert!(trashable(root, "a.MD").is_ok());
        assert!(trashable(root, "dir").is_ok());
    }

    #[test]
    fn validate_name_applies_every_rule() {
        for ok in [
            "note.md",
            "Meeting notes 2026-09-24.md",
            ".hidden.md",
            "a..b.md",
            "CONSOLE.md",
            "con-notes.md",
            "COM10",
            "caf\u{e9}.md",
        ] {
            assert!(validate_name(ok).is_ok(), "{ok:?} must be accepted");
        }
        for bad in [
            "", ".", "..", "a/b", "a\\b", "a:b", "a<b", "a>b", "a\"b", "a|b", "a?b", "a*b", "tab\there",
            "nul\u{0}byte", "name.", "name ", "con.md", "CON", "Prn.txt", "aux", "NUL.md", "COM1", "com9.md",
            "Lpt3.txt", "LPT9", "CON .md", "con.tar.gz",
        ] {
            assert!(msg(validate_name(bad)).starts_with("invalid-name:"), "{bad:?} must be refused");
        }
        assert!(validate_name(&"a".repeat(NAME_MAX)).is_ok());
        assert!(validate_name(&"a".repeat(NAME_MAX + 1)).is_err());
        // Counted in UTF-16 units, like Windows and JS: 128 emoji are 256.
        assert!(validate_name(&"\u{1F4DD}".repeat(128)).is_err());
    }

    #[test]
    fn markdown_names_by_extension_only() {
        for yes in ["a.md", "A.MD", "b.markdown", "c.Mdx", "v1.2.md"] {
            assert!(is_markdown_name(yes), "{yes}");
        }
        for no in ["a.txt", "md", "a.md.bak", ".md", "a", "a.mdown"] {
            assert!(!is_markdown_name(no), "{no}");
        }
    }

    #[test]
    fn temp_names_are_unique_and_carry_the_suffix() {
        let a = temp_name("note.md");
        let b = temp_name("note.md");
        assert_ne!(a, b);
        assert!(a.starts_with(".note.md.") && a.ends_with(TEMP_SUFFIX));
        let long = temp_name(&"x".repeat(250));
        assert!(long.encode_utf16().count() <= NAME_MAX);
    }
}
