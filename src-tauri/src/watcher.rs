//! Debounced filesystem watcher. Raw `notify` events are filtered on the
//! notify thread (outside-mount and pruned paths never enter the queue),
//! funneled through a BOUNDED channel into a drain thread that collects a
//! de-duplicated dirty set until the disk goes quiet (or a batch has been
//! open too long), then patches the name index in one pass and emits ONE
//! `files-changed` event to the UI with every path in the batch.
//!
//! Two overflow valves keep a bulk change (a `git checkout`, an unzip, a
//! `pnpm install` outside the pruned dirs) from stalling anything: if the
//! channel fills or a batch exceeds `MAX_PENDING` distinct paths, the batch
//! is abandoned and the index is rebuilt from disk instead (off-lock), and
//! the UI is told to re-list what it has open (`rescan: true`).

use crate::name_index::{walk_dir_entries, IndexStats, NameIndex, Observed, MAX_ENTRIES};
use crate::rules::{rel_from_abs, rel_path_is_ignored};
use crate::writefile::TEMP_SUFFIX;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// Quiet period: flush once nothing has changed for this long.
const DEBOUNCE: Duration = Duration::from_millis(150);
/// Ceiling on how long the dirty set may keep growing before a flush anyway,
/// so a long copy still shows progress.
const MAX_WINDOW: Duration = Duration::from_millis(1000);
/// Distinct paths one batch may hold. Past it, patching path by path costs
/// more than a rebuild, so the batch becomes a rescan.
pub const MAX_PENDING: usize = 10_000;
/// Raw events buffered between notify's thread and the drain thread. A full
/// channel drops the event and flags a rescan rather than growing without
/// bound while the drain thread is busy.
pub const CHANNEL_CAP: usize = 4_096;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileChanged {
    /// Mount-relative path of the changed item.
    pub path: String,
    /// "modified" (exists now) | "removed" (gone now).
    pub kind: String,
}

/// Payload of the single `files-changed` event emitted per batch.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesChanged {
    pub mount_id: String,
    pub changes: Vec<FileChanged>,
    /// True when the batch overflowed: `changes` is empty, the index was
    /// rebuilt from disk, and the UI should re-list everything it has open.
    pub rescan: bool,
    /// The index counts after this batch, so the UI's totals stay current.
    /// None while the index is still being built.
    pub stats: Option<IndexStats>,
}

/// Owns the live watcher and its drain thread. Dropping it stops the thread
/// and joins it, so a mount switch never leaves a thread patching the index
/// of a mount that is no longer open.
pub struct MountWatcher {
    _watcher: RecommendedWatcher,
    stop: Arc<AtomicBool>,
    drain: Option<std::thread::JoinHandle<()>>,
}

impl Drop for MountWatcher {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(h) = self.drain.take() {
            let _ = h.join();
        }
    }
}

/// The notify-thread filter: absolute event paths to mount-relative ones,
/// dropping anything outside the mount, under a pruned directory, or a note
/// save's own temp file (`*.foyer.tmp`, alive for milliseconds; the rename
/// over the note is what gets reported). Pure.
pub fn filter_paths<I: IntoIterator<Item = PathBuf>>(root: &Path, paths: I) -> Vec<String> {
    let mut out = Vec::new();
    for abs in paths {
        let Ok(rel) = rel_from_abs(root, &abs) else { continue };
        // The suffix holds no `/`, so this is a test on the last segment.
        if rel.is_empty() || rel_path_is_ignored(&rel) || rel.ends_with(TEMP_SUFFIX) {
            continue;
        }
        out.push(rel);
    }
    out
}

/// A batch after planning: what to drop from the index, what was seen on
/// disk (already stat'd, so applying needs no I/O), and the UI rows.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Plan {
    pub removed: Vec<String>,
    pub observed: Vec<Observed>,
    pub changes: Vec<FileChanged>,
}

/// Turn a de-duplicated set of mount-relative paths into a plan. Every path
/// is stat'd exactly once, here, outside the index lock. Pure, for tests.
pub fn plan_batch<I: IntoIterator<Item = String>>(root: &Path, batch: I) -> Plan {
    let mut plan = Plan::default();
    for rel in batch {
        match Observed::stat(root, &rel) {
            Some(o) => {
                plan.changes.push(FileChanged { path: rel, kind: "modified".into() });
                plan.observed.push(o);
            }
            None => {
                plan.changes.push(FileChanged { path: rel.clone(), kind: "removed".into() });
                plan.removed.push(rel);
            }
        }
    }
    plan
}

/// Feed a batch of raw event paths through the same de-duplication the drain
/// thread applies and plan it. The test entry point.
#[cfg(test)]
pub fn plan_paths<I: IntoIterator<Item = PathBuf>>(root: &Path, paths: I) -> Plan {
    let set: BTreeSet<String> = filter_paths(root, paths).into_iter().collect();
    plan_batch(root, set)
}

/// Patch the index with a plan: one locked pass for the batch, then the
/// walks of any new folders OFF the lock, then one more short locked insert.
/// Returns the index stats afterwards (None if there is no index yet).
pub fn apply_plan(index: &Mutex<Option<NameIndex>>, root: &Path, plan: &Plan) -> Option<IndexStats> {
    let (new_dirs, stats) = match index.lock() {
        Ok(mut guard) => match guard.as_mut() {
            Some(idx) => (idx.apply_batch(&plan.removed, &plan.observed), idx.stats()),
            None => return None,
        },
        Err(_) => return None,
    };
    if new_dirs.is_empty() {
        return Some(stats);
    }
    let mut found: Vec<Observed> = Vec::new();
    for d in &new_dirs {
        let room = MAX_ENTRIES.saturating_sub(found.len());
        if room == 0 {
            break;
        }
        found.extend(walk_dir_entries(root, d, room));
    }
    match index.lock() {
        Ok(mut guard) => guard.as_mut().map(|idx| {
            idx.insert_many(&found);
            idx.stats()
        }),
        Err(_) => Some(stats),
    }
}

/// Start watching `root`. Returns a handle that must be kept alive.
pub fn start(
    mount_id: String,
    root: PathBuf,
    index: Arc<Mutex<Option<NameIndex>>>,
    app: AppHandle,
) -> crate::error::AppResult<MountWatcher> {
    let (tx, rx) = mpsc::sync_channel::<Vec<String>>(CHANNEL_CAP);
    let overflow = Arc::new(AtomicBool::new(false));

    let cb_root = root.clone();
    let cb_overflow = overflow.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        let rels = filter_paths(&cb_root, event.paths);
        if rels.is_empty() {
            return;
        }
        if tx.try_send(rels).is_err() {
            cb_overflow.store(true, Ordering::Relaxed);
        }
    })?;
    watcher.watch(&root, RecursiveMode::Recursive)?;

    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = stop.clone();
    let drain = std::thread::spawn(move || {
        let mut dirty: BTreeSet<String> = BTreeSet::new();
        let mut rescan = false;
        let mut opened_at: Option<Instant> = None;
        loop {
            if thread_stop.load(Ordering::Relaxed) {
                break;
            }
            match rx.recv_timeout(DEBOUNCE) {
                Ok(rels) => {
                    if opened_at.is_none() {
                        opened_at = Some(Instant::now());
                    }
                    if !rescan {
                        dirty.extend(rels);
                        if dirty.len() > MAX_PENDING {
                            rescan = true;
                            dirty.clear();
                        }
                    }
                    let too_long = opened_at
                        .map(|t| t.elapsed() >= MAX_WINDOW)
                        .unwrap_or(false);
                    if !too_long {
                        continue;
                    }
                }
                Err(RecvTimeoutError::Timeout) => {
                    if dirty.is_empty() && !rescan && !overflow.load(Ordering::Relaxed) {
                        continue;
                    }
                }
                Err(RecvTimeoutError::Disconnected) => break,
            }

            if overflow.swap(false, Ordering::Relaxed) {
                rescan = true;
                dirty.clear();
            }
            let batch = std::mem::take(&mut dirty);
            opened_at = None;

            if rescan {
                rescan = false;
                // Rebuild from disk, off the lock, so search keeps answering
                // from the old index until the new one is ready. A build in
                // progress (index still None) already reflects the disk.
                let building = index.lock().map(|g| g.is_none()).unwrap_or(true);
                let mut stats = None;
                if !building {
                    if let Some(built) = NameIndex::build_cancellable(&root, &thread_stop) {
                        stats = Some(built.stats());
                        if let Ok(mut guard) = index.lock() {
                            *guard = Some(built);
                        }
                    } else {
                        break;
                    }
                }
                let _ = app.emit(
                    "files-changed",
                    FilesChanged { mount_id: mount_id.clone(), changes: Vec::new(), rescan: true, stats },
                );
                continue;
            }

            let plan = plan_batch(&root, batch);
            if plan.changes.is_empty() {
                continue;
            }
            let stats = apply_plan(&index, &root, &plan);
            let _ = app.emit(
                "files-changed",
                FilesChanged {
                    mount_id: mount_id.clone(),
                    changes: plan.changes,
                    rescan: false,
                    stats,
                },
            );
        }
    });

    Ok(MountWatcher {
        _watcher: watcher,
        stop,
        drain: Some(drain),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn plan_dedupes_classifies_and_drops_pruned_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("notes")).unwrap();
        fs::write(root.join("notes/a.md"), b"a").unwrap();
        fs::create_dir_all(root.join("node_modules/x")).unwrap();
        fs::write(root.join("node_modules/x/i.js"), b"x").unwrap();

        let plan = plan_paths(
            root,
            vec![
                root.join("notes/a.md"),
                root.join("notes/a.md"),
                root.join("notes/gone.md"),
                root.join("node_modules/x/i.js"),
                PathBuf::from("/somewhere/else/file.md"),
                root.to_path_buf(),
            ],
        );
        assert_eq!(
            plan.changes,
            vec![
                FileChanged { path: "notes/a.md".into(), kind: "modified".into() },
                FileChanged { path: "notes/gone.md".into(), kind: "removed".into() },
            ]
        );
        assert_eq!(plan.removed, vec!["notes/gone.md".to_string()]);
        assert_eq!(plan.observed.len(), 1);
        assert_eq!(plan.observed[0].rel, "notes/a.md");
        assert!(!plan.observed[0].is_dir);
        assert_eq!(plan.observed[0].size, 1);
    }

    #[test]
    fn filter_drops_pruned_and_outside_paths_before_they_are_queued() {
        let root = Path::new("/tmp/mount");
        let kept = filter_paths(
            root,
            vec![
                PathBuf::from("/tmp/mount/src/a.rs"),
                PathBuf::from("/tmp/mount/node_modules/pkg/index.js"),
                PathBuf::from("/tmp/mount/.git/index"),
                PathBuf::from("/tmp/mount/web/.next/x.js"),
                PathBuf::from("/tmp/other/b.rs"),
                PathBuf::from("/tmp/mount"),
                PathBuf::from("/tmp/mount/.claude/skills/x/SKILL.md"),
                PathBuf::from("/tmp/mount/notes/.a.md.3f2b9c0d1e4a4b6f8c7d5e2a1b0c9d8e.foyer.tmp"),
            ],
        );
        assert_eq!(kept, vec!["src/a.rs".to_string(), ".claude/skills/x/SKILL.md".to_string()]);
    }

    #[test]
    fn a_bulk_batch_is_applied_in_one_pass_and_new_folders_are_walked_off_lock() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        // 300 files in 30 folders, then a checkout-like change: 10 folders
        // vanish, 100 files change, one new folder with contents appears.
        for d in 0..30 {
            fs::create_dir_all(root.join(format!("pkg{d}"))).unwrap();
            for f in 0..10 {
                fs::write(root.join(format!("pkg{d}/f{f}.ts")), b"x").unwrap();
            }
        }
        let index = Mutex::new(Some(NameIndex::build(root)));
        assert_eq!(index.lock().unwrap().as_ref().unwrap().len(), 330);

        let mut paths: Vec<PathBuf> = Vec::new();
        for d in 0..10 {
            fs::remove_dir_all(root.join(format!("pkg{d}"))).unwrap();
            paths.push(root.join(format!("pkg{d}")));
            for f in 0..10 {
                paths.push(root.join(format!("pkg{d}/f{f}.ts")));
            }
        }
        for d in 10..20 {
            for f in 0..10 {
                fs::write(root.join(format!("pkg{d}/f{f}.ts")), b"changed").unwrap();
                paths.push(root.join(format!("pkg{d}/f{f}.ts")));
            }
        }
        fs::create_dir_all(root.join("fresh/sub")).unwrap();
        fs::write(root.join("fresh/sub/new.ts"), b"n").unwrap();
        paths.push(root.join("fresh"));

        let plan = plan_paths(root, paths);
        assert_eq!(plan.removed.len(), 110);
        assert_eq!(plan.observed.len(), 101);
        let stats = apply_plan(&index, root, &plan).unwrap();
        assert_eq!(stats.files, 201);

        let guard = index.lock().unwrap();
        let idx = guard.as_ref().unwrap();
        // 20 folders x 10 files + fresh, fresh/sub, fresh/sub/new.ts
        assert_eq!(idx.len(), 200 + 20 + 3);
        assert!(!idx.contains("pkg0"));
        assert!(!idx.contains("pkg0/f0.ts"));
        assert!(idx.contains("pkg10/f0.ts"));
        assert!(idx.contains("fresh/sub/new.ts"));
        let stats = idx.stats();
        assert_eq!(stats.files, 201);
        assert_eq!(stats.dirs, 22);
        assert_eq!(idx.search("f0.ts", None).hits.len(), 20);
        // The changed files carry their new size.
        assert_eq!(idx.search("pkg10/f0.ts", None).hits[0].size, 7);
    }
}
