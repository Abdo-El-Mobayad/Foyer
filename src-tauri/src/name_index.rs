//! The filename index: every path under a mount, names only, in memory.
//!
//! Built once per open on a background thread and patched by the watcher.
//! Nothing is persisted; a rebuild of a 50,000-entry mount takes well under a
//! second, and a stale on-disk cache would only ever be wrong.
//!
//! Patching is batch-shaped on purpose: a `git checkout` reports thousands of
//! paths at once, and applying them one at a time cost a full pass over the
//! index per deletion. `apply_batch` does one pass for the whole batch, and
//! the disk work (stats, walks of new folders) happens in the caller, outside
//! the index lock.

use crate::rules::is_ignored_dir;
use crate::tree::modified_millis;
use serde::Serialize;
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;
use walkdir::WalkDir;

/// Hard ceiling on entries. Past it the walk stops and the index reports
/// `truncated`, so a mount pointed at a drive root cannot exhaust memory.
pub const MAX_ENTRIES: usize = 500_000;
/// Most hits a query returns.
pub const MAX_HITS: usize = 200;
/// How often a build checks its cancel flag, in entries.
const CANCEL_CHECK_EVERY: usize = 1024;

#[derive(Debug, Clone)]
pub struct IndexEntry {
    /// Forward-slash path relative to the mount root.
    pub rel: String,
    pub rel_lower: String,
    pub name_lower: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: u64,
}

/// One path as the watcher saw it on disk, stat'd outside the index lock.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Observed {
    pub rel: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: u64,
}

impl Observed {
    /// Stat `rel` under `root`. None if it is gone (or unreadable).
    pub fn stat(root: &Path, rel: &str) -> Option<Observed> {
        let meta = std::fs::metadata(root.join(rel)).ok()?;
        let is_dir = meta.is_dir();
        Some(Observed {
            rel: rel.to_string(),
            is_dir,
            size: if is_dir { 0 } else { meta.len() },
            modified: modified_millis(Some(&meta)),
        })
    }
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct IndexStats {
    pub files: u64,
    pub dirs: u64,
    pub built_ms: u64,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: u64,
    pub score: i32,
}

/// One query's answer: the capped hits plus how many entries matched before
/// the cap, so the UI can say "newest 200 of 1,412" rather than implying that
/// 200 is all there is.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub hits: Vec<SearchHit>,
    pub total: usize,
}

#[derive(Debug)]
pub struct NameIndex {
    root: PathBuf,
    entries: Vec<IndexEntry>,
    by_rel: HashMap<String, usize>,
    stats: IndexStats,
}

fn entry_for(rel: String, is_dir: bool, size: u64, modified: u64) -> IndexEntry {
    let name_lower = rel
        .rsplit('/')
        .next()
        .unwrap_or(&rel)
        .to_lowercase();
    IndexEntry {
        rel_lower: rel.to_lowercase(),
        rel,
        name_lower,
        is_dir,
        size,
        modified,
    }
}

fn rel_of(root: &Path, abs: &Path) -> Option<String> {
    let rel = abs
        .strip_prefix(root)
        .ok()?
        .components()
        .filter_map(|c| c.as_os_str().to_str())
        .collect::<Vec<_>>()
        .join("/");
    if rel.is_empty() {
        None
    } else {
        Some(rel)
    }
}

/// Walk one folder of a mount (pruned dirs skipped, links not followed) and
/// return what is under it. Pure disk work; holds no lock. `limit` bounds the
/// number of entries returned.
pub fn walk_dir_entries(root: &Path, rel: &str, limit: usize) -> Vec<Observed> {
    let mut out = Vec::new();
    let walker = WalkDir::new(root.join(rel))
        .follow_links(false)
        .min_depth(1)
        .into_iter()
        .filter_entry(|e| !(e.file_type().is_dir() && is_ignored_dir(&e.file_name().to_string_lossy())));
    for entry in walker.flatten() {
        if out.len() >= limit {
            break;
        }
        let Some(sub_rel) = rel_of(root, entry.path()) else { continue };
        let meta = entry.metadata().ok();
        let is_dir = entry.file_type().is_dir();
        out.push(Observed {
            rel: sub_rel,
            is_dir,
            size: if is_dir { 0 } else { meta.as_ref().map(|m| m.len()).unwrap_or(0) },
            modified: modified_millis(meta.as_ref()),
        });
    }
    out
}

impl NameIndex {
    /// Walk `root` and build the index. Pruned directories are never entered.
    pub fn build(root: &Path) -> NameIndex {
        let never = AtomicBool::new(false);
        Self::build_cancellable(root, &never).expect("uncancellable build")
    }

    /// `build`, aborting (None) as soon as `cancel` is set: a mount that was
    /// switched away from mid-build stops burning disk and CPU.
    pub fn build_cancellable(root: &Path, cancel: &AtomicBool) -> Option<NameIndex> {
        let started = Instant::now();
        let mut entries: Vec<IndexEntry> = Vec::new();
        let mut truncated = false;
        let mut files = 0u64;
        let mut dirs = 0u64;

        let walker = WalkDir::new(root)
            .follow_links(false)
            .min_depth(1)
            .into_iter()
            .filter_entry(|e| {
                // `file_type` here is the link type for symlinks; a linked dir
                // is not followed (follow_links false), so it lists as a leaf.
                !(e.file_type().is_dir() && is_ignored_dir(&e.file_name().to_string_lossy()))
            });

        for entry in walker.flatten() {
            if entries.len() >= MAX_ENTRIES {
                truncated = true;
                break;
            }
            if entries.len() % CANCEL_CHECK_EVERY == 0 && cancel.load(Ordering::Relaxed) {
                return None;
            }
            let Some(rel) = rel_of(root, entry.path()) else { continue };
            let meta = entry.metadata().ok();
            let is_dir = entry.file_type().is_dir();
            if is_dir {
                dirs += 1;
            } else {
                files += 1;
            }
            let size = if is_dir { 0 } else { meta.as_ref().map(|m| m.len()).unwrap_or(0) };
            entries.push(entry_for(rel, is_dir, size, modified_millis(meta.as_ref())));
        }

        entries.sort_by(|a, b| a.rel_lower.cmp(&b.rel_lower));
        let by_rel = entries
            .iter()
            .enumerate()
            .map(|(i, e)| (e.rel.clone(), i))
            .collect();

        Some(NameIndex {
            root: root.to_path_buf(),
            entries,
            by_rel,
            stats: IndexStats {
                files,
                dirs,
                built_ms: started.elapsed().as_millis() as u64,
                truncated,
            },
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn stats(&self) -> IndexStats {
        self.stats.clone()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn contains(&self, rel: &str) -> bool {
        self.by_rel.contains_key(rel)
    }

    /// Search the index. `since` picks the mode, and the two modes are
    /// deliberately different questions:
    ///
    /// * `None` asks "which paths match these words", answered by relevance.
    /// * `Some(cutoff)` asks "which files changed since then", answered by
    ///   recency, with the words (if any) narrowing that set.
    ///
    /// The recency filter has to live here rather than over a relevance
    /// response, because relevance discards its losers at the cap: a file
    /// modified a minute ago that ranked 201st by name would never reach the
    /// caller to be filtered.
    pub fn search(&self, query: &str, since: Option<u64>) -> SearchResult {
        let terms: Vec<String> = query
            .split_whitespace()
            .map(|t| t.to_lowercase())
            .filter(|t| !t.is_empty())
            .collect();
        match since {
            Some(cutoff) => self.by_recency(&terms, cutoff),
            None => self.by_relevance(&terms),
        }
    }

    fn hit_at(&self, i: usize, score: i32) -> SearchHit {
        let e = &self.entries[i];
        SearchHit {
            path: e.rel.clone(),
            name: e.rel.rsplit('/').next().unwrap_or(&e.rel).to_string(),
            is_dir: e.is_dir,
            size: e.size,
            modified: e.modified,
            score,
        }
    }

    /// Every term must appear in the relative path (case-insensitive, any
    /// order). Ranked so that a name match beats a folder-only match, a prefix
    /// beats a substring, and shallower paths come first on ties.
    ///
    /// The scan is one pass; only the best `MAX_HITS` are kept (a bounded heap),
    /// so a query matching 300,000 paths never sorts 300,000 hits.
    fn by_relevance(&self, terms: &[String]) -> SearchResult {
        if terms.is_empty() {
            return SearchResult { hits: Vec::new(), total: 0 };
        }
        let whole = terms.join(" ");
        let first = &terms[0];
        let mut total = 0usize;

        // Max-heap of Reverse(goodness): the top is the WORST kept hit, which
        // is the one to drop when a better hit arrives. Goodness = (score,
        // Reverse(index)) so equal scores keep the earlier (sorted) path.
        let mut kept: BinaryHeap<Reverse<(i32, Reverse<usize>)>> = BinaryHeap::with_capacity(MAX_HITS + 1);
        for (i, e) in self.entries.iter().enumerate() {
            if !terms.iter().all(|t| e.rel_lower.contains(t.as_str())) {
                continue;
            }
            total += 1;
            let mut score = if e.name_lower == whole {
                100
            } else if e.name_lower.starts_with(first.as_str()) {
                60
            } else if e.name_lower.contains(first.as_str()) {
                40
            } else {
                10
            };
            // Every term in the name itself is worth more than terms spread
            // across the folders above it.
            if terms.len() > 1 && terms.iter().all(|t| e.name_lower.contains(t.as_str())) {
                score += 15;
            }
            // Shallower first, and files well ahead of folders: a query is
            // nearly always for a file, and the folder holding it is one
            // click away in the tree.
            score -= e.rel_lower.matches('/').count().min(10) as i32;
            if e.is_dir {
                score -= 8;
            }
            let key = Reverse((score, Reverse(i)));
            if kept.len() < MAX_HITS {
                kept.push(key);
            } else if let Some(worst) = kept.peek() {
                if key < *worst {
                    kept.pop();
                    kept.push(key);
                }
            }
        }
        let mut hits: Vec<(i32, usize)> = kept.into_iter().map(|Reverse((s, Reverse(i)))| (s, i)).collect();
        hits.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
        SearchResult {
            hits: hits.into_iter().map(|(score, i)| self.hit_at(i, score)).collect(),
            total,
        }
    }

    /// Files whose mtime is at or after `cutoff`, newest first. An empty
    /// `terms` matches every file in the window, which is the point: this is a
    /// browsing surface, not a search.
    ///
    /// Directories never appear. A directory's mtime moves when a child is
    /// added or removed but NOT when a child's contents change, so listing
    /// folders here would answer a different question than the one asked.
    /// A `modified` of 0 means the stat failed, which is not evidence that the
    /// file is old, so those are excluded too rather than treated as 1970.
    ///
    /// Ties break on the lowercased path, not on index order, so two files
    /// written in the same millisecond hold their position across calls. That
    /// stability is what keeps the UI's keyboard cursor from moving under the
    /// user when a watcher batch re-runs the query; index order would drift as
    /// the watcher appends.
    fn by_recency(&self, terms: &[String], cutoff: u64) -> SearchResult {
        let mut total = 0usize;
        // Goodness = (modified, Reverse(path)): newer wins, and on a tie the
        // alphabetically earlier path wins. Same bounded-heap shape as above.
        let mut kept: BinaryHeap<Reverse<(u64, Reverse<&str>, usize)>> = BinaryHeap::with_capacity(MAX_HITS + 1);
        for (i, e) in self.entries.iter().enumerate() {
            if e.is_dir || e.modified == 0 || e.modified < cutoff {
                continue;
            }
            if !terms.iter().all(|t| e.rel_lower.contains(t.as_str())) {
                continue;
            }
            total += 1;
            let key = Reverse((e.modified, Reverse(e.rel_lower.as_str()), i));
            if kept.len() < MAX_HITS {
                kept.push(key);
            } else if let Some(worst) = kept.peek() {
                if key < *worst {
                    kept.pop();
                    kept.push(key);
                }
            }
        }
        let mut hits: Vec<(u64, &str, usize)> = kept
            .into_iter()
            .map(|Reverse((m, Reverse(p), i))| (m, p, i))
            .collect();
        hits.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(b.1)));
        SearchResult {
            // Score is a relevance number and means nothing here; the UI must
            // not display or sort by it in this mode.
            hits: hits.into_iter().map(|(_, _, i)| self.hit_at(i, 0)).collect(),
            total,
        }
    }

    /// Apply one watcher batch: every path in `removed` is dropped (a folder
    /// takes everything under it), every `observed` path is updated or added.
    /// Removals are ONE pass over the entries and ONE rebuild of the path map,
    /// whatever the batch size. Returns the folders that are new to the index;
    /// the caller walks them (off-lock) and feeds the result to `insert_many`.
    pub fn apply_batch(&mut self, removed: &[String], observed: &[Observed]) -> Vec<String> {
        if !removed.is_empty() {
            let gone_set: HashSet<&str> = removed.iter().map(|s| s.as_str()).collect();
            let mut files = 0u64;
            let mut dirs = 0u64;
            let before = self.entries.len();
            self.entries.retain(|e| {
                let rel = e.rel.as_str();
                let gone = gone_set.contains(rel)
                    || rel
                        .match_indices('/')
                        .any(|(i, _)| gone_set.contains(&rel[..i]));
                if gone {
                    if e.is_dir {
                        dirs += 1;
                    } else {
                        files += 1;
                    }
                }
                !gone
            });
            if self.entries.len() != before {
                self.stats.files = self.stats.files.saturating_sub(files);
                self.stats.dirs = self.stats.dirs.saturating_sub(dirs);
                self.by_rel = self
                    .entries
                    .iter()
                    .enumerate()
                    .map(|(i, e)| (e.rel.clone(), i))
                    .collect();
            }
        }

        let mut new_dirs = Vec::new();
        for o in observed {
            if o.rel.is_empty() || crate::rules::rel_path_is_ignored(&o.rel) {
                continue;
            }
            if let Some(&i) = self.by_rel.get(&o.rel) {
                let e = &mut self.entries[i];
                e.is_dir = o.is_dir;
                e.size = o.size;
                e.modified = o.modified;
                continue;
            }
            if self.push(o) && o.is_dir {
                // A folder that appeared whole (a move, an unzip) brings its
                // contents with it; the watcher only reports the top.
                new_dirs.push(o.rel.clone());
            }
        }
        new_dirs
    }

    /// Add entries the caller found by walking new folders. Paths already
    /// indexed are skipped.
    pub fn insert_many(&mut self, entries: &[Observed]) {
        for o in entries {
            if !self.by_rel.contains_key(&o.rel) {
                self.push(o);
            }
        }
    }

    fn push(&mut self, o: &Observed) -> bool {
        if self.entries.len() >= MAX_ENTRIES {
            self.stats.truncated = true;
            return false;
        }
        self.entries.push(entry_for(o.rel.clone(), o.is_dir, o.size, o.modified));
        self.by_rel.insert(o.rel.clone(), self.entries.len() - 1);
        if o.is_dir {
            self.stats.dirs += 1;
        } else {
            self.stats.files += 1;
        }
        true
    }

    /// Single-path patch: (re)stat one path and insert or update it, walking
    /// it if it is a new folder. The batch form above is what the watcher
    /// uses; this is the convenience for one change. Returns true if the
    /// index changed.
    pub fn upsert(&mut self, rel: &str) -> bool {
        if rel.is_empty() || crate::rules::rel_path_is_ignored(rel) {
            return false;
        }
        let Some(o) = Observed::stat(&self.root, rel) else {
            return self.remove(rel);
        };
        let existed = self.by_rel.contains_key(rel);
        let before = self.entries.len();
        let new_dirs = self.apply_batch(&[], std::slice::from_ref(&o));
        for d in new_dirs {
            let room = MAX_ENTRIES.saturating_sub(self.entries.len());
            let found = walk_dir_entries(&self.root, &d, room);
            self.insert_many(&found);
        }
        existed || self.entries.len() > before
    }

    /// Single-path patch: drop a path and, if it was a folder, everything
    /// under it. Returns true if the index changed.
    pub fn remove(&mut self, rel: &str) -> bool {
        if !self.by_rel.contains_key(rel) {
            return false;
        }
        let before = self.entries.len();
        self.apply_batch(&[rel.to_string()], &[]);
        self.entries.len() != before
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn fixture() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join(".claude/skills/wiki-skill")).unwrap();
        fs::write(root.join(".claude/skills/wiki-skill/SKILL.md"), b"# skill").unwrap();
        fs::create_dir_all(root.join(".claude/commands")).unwrap();
        fs::write(root.join(".claude/commands/wiki.md"), b"# wiki").unwrap();
        fs::create_dir_all(root.join("Vault/output")).unwrap();
        fs::write(root.join("Vault/INDEX.json"), b"{}").unwrap();
        fs::write(root.join("Vault/output/sales-dashboard.html"), b"<html>").unwrap();
        fs::create_dir_all(root.join("node_modules/skill-pkg")).unwrap();
        fs::write(root.join("node_modules/skill-pkg/skill.js"), b"x").unwrap();
        fs::create_dir_all(root.join(".git/objects")).unwrap();
        fs::write(root.join(".git/HEAD"), b"ref").unwrap();
        fs::write(root.join(".gitignore"), b"node_modules").unwrap();
        fs::write(root.join("CLAUDE.md"), b"# rules").unwrap();
        tmp
    }

    #[test]
    fn build_indexes_names_only_and_prunes_heavy_dirs() {
        let tmp = fixture();
        let idx = NameIndex::build(tmp.path());
        let stats = idx.stats();
        // Files: SKILL.md, wiki.md, INDEX.json, sales-dashboard.html, .gitignore, CLAUDE.md
        assert_eq!(stats.files, 6, "{:?}", idx.entries.iter().map(|e| &e.rel).collect::<Vec<_>>());
        // Dirs: .claude, skills, wiki-skill, commands, Vault, output
        assert_eq!(stats.dirs, 6);
        assert!(!stats.truncated);
        assert!(idx.by_rel.contains_key(".gitignore"));
        assert!(idx.by_rel.contains_key(".claude/skills/wiki-skill/SKILL.md"));
        assert!(!idx.by_rel.contains_key("node_modules"));
        assert!(!idx.by_rel.contains_key(".git/HEAD"));
    }

    #[test]
    fn build_aborts_when_cancelled() {
        let tmp = fixture();
        let cancelled = AtomicBool::new(true);
        assert!(NameIndex::build_cancellable(tmp.path(), &cancelled).is_none());
        let live = AtomicBool::new(false);
        assert!(NameIndex::build_cancellable(tmp.path(), &live).is_some());
    }

    #[test]
    fn search_matches_every_term_anywhere_in_the_path_and_ranks_names_first() {
        let tmp = fixture();
        let idx = NameIndex::build(tmp.path());

        let hits = idx.search("skill", None).hits;
        let paths: Vec<&str> = hits.iter().map(|h| h.path.as_str()).collect();
        // The file whose NAME starts with the term outranks the folder that
        // merely contains it, and node_modules never appears.
        assert_eq!(paths[0], ".claude/skills/wiki-skill/SKILL.md");
        assert!(paths.contains(&".claude/skills"));
        assert!(paths.contains(&".claude/skills/wiki-skill"));
        assert!(!paths.iter().any(|p| p.contains("node_modules")));

        // Two terms, any order, across folders.
        let hits = idx.search("dashboard output", None).hits;
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "Vault/output/sales-dashboard.html");
        assert!(!hits[0].is_dir);

        // Case-insensitive, and an exact name is the top hit.
        let hits = idx.search("index.JSON", None).hits;
        assert_eq!(hits[0].path, "Vault/INDEX.json");
        assert_eq!(hits[0].score, 100 - 1);

        assert!(idx.search("   ", None).hits.is_empty());
        assert!(idx.search("nothing-here", None).hits.is_empty());
    }

    #[test]
    fn search_keeps_the_best_hits_when_more_match_than_the_cap() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        // 600 matching files across nested folders, one exact-name match.
        for i in 0..600 {
            let dir = root.join(format!("d{}/e{}", i % 7, i % 3));
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join(format!("note-{i:03}.md")), b"x").unwrap();
        }
        fs::write(root.join("note.md"), b"top").unwrap();
        let idx = NameIndex::build(root);
        let hits = idx.search("note", None).hits;
        assert_eq!(hits.len(), MAX_HITS);
        // The exact name at the root wins; scores never increase down the list.
        assert_eq!(hits[0].path, "note.md");
        assert!(hits.windows(2).all(|w| w[0].score >= w[1].score));
        // Within equal scores, the order is the sorted path order.
        let same: Vec<&SearchHit> = hits.iter().filter(|h| h.score == hits[1].score).collect();
        assert!(same.windows(2).all(|w| w[0].path.to_lowercase() < w[1].path.to_lowercase()));
    }

    #[test]
    fn upsert_and_remove_keep_the_index_and_stats_consistent() {
        let tmp = fixture();
        let mut idx = NameIndex::build(tmp.path());
        let before = idx.len();

        fs::write(tmp.path().join("Vault/new-note.md"), b"# new").unwrap();
        assert!(idx.upsert("Vault/new-note.md"));
        assert_eq!(idx.len(), before + 1);
        assert_eq!(idx.search("new-note", None).hits[0].path, "Vault/new-note.md");
        assert_eq!(idx.stats().files, 7);

        // A whole folder arriving at once is absorbed with its contents.
        fs::create_dir_all(tmp.path().join("Incoming/deep")).unwrap();
        fs::write(tmp.path().join("Incoming/deep/file.txt"), b"x").unwrap();
        assert!(idx.upsert("Incoming"));
        assert!(idx.by_rel.contains_key("Incoming/deep/file.txt"));
        assert_eq!(idx.stats().dirs, 8);

        // Removing a folder drops everything under it.
        assert!(idx.remove("Incoming"));
        assert!(!idx.by_rel.contains_key("Incoming/deep/file.txt"));
        assert_eq!(idx.stats().dirs, 6);
        assert_eq!(idx.stats().files, 7);

        // A path under a pruned dir never enters, and a vanished path is a remove.
        assert!(!idx.upsert("node_modules/x.js"));
        assert!(!idx.upsert("Vault/ghost.md"));
        assert!(!idx.remove("Vault/ghost.md"));
    }

    #[test]
    fn apply_batch_removes_many_in_one_pass_and_absorbs_new_folders() {
        let tmp = fixture();
        let mut idx = NameIndex::build(tmp.path());

        // Delete a folder and a file in the same batch, plus a path that was
        // never indexed (harmless), plus a folder whose entry itself is gone
        // but whose children are still indexed (a checkout that replaced it).
        let removed = vec![
            ".claude/skills".to_string(),
            "CLAUDE.md".to_string(),
            "never/indexed.md".to_string(),
        ];
        let new_dirs = idx.apply_batch(&removed, &[]);
        assert!(new_dirs.is_empty());
        assert!(!idx.contains(".claude/skills"));
        assert!(!idx.contains(".claude/skills/wiki-skill/SKILL.md"));
        assert!(!idx.contains("CLAUDE.md"));
        assert!(idx.contains(".claude/commands/wiki.md"));
        assert_eq!(idx.stats().files, 4);
        assert_eq!(idx.stats().dirs, 4);
        // The map was rebuilt: every surviving path resolves to itself.
        for (rel, &i) in &idx.by_rel {
            assert_eq!(&idx.entries[i].rel, rel);
        }

        // A batch of observed paths: one update, one new file, one new folder
        // that the caller then walks and feeds back.
        fs::create_dir_all(tmp.path().join("Incoming/deep")).unwrap();
        fs::write(tmp.path().join("Incoming/deep/file.txt"), b"x").unwrap();
        fs::write(tmp.path().join("Vault/fresh.md"), b"x").unwrap();
        let observed = vec![
            Observed::stat(tmp.path(), "Vault/INDEX.json").unwrap(),
            Observed::stat(tmp.path(), "Vault/fresh.md").unwrap(),
            Observed::stat(tmp.path(), "Incoming").unwrap(),
        ];
        let new_dirs = idx.apply_batch(&[], &observed);
        assert_eq!(new_dirs, vec!["Incoming".to_string()]);
        assert!(idx.contains("Vault/fresh.md"));
        assert!(!idx.contains("Incoming/deep/file.txt"));
        let walked = walk_dir_entries(tmp.path(), "Incoming", MAX_ENTRIES);
        assert_eq!(walked.len(), 2);
        idx.insert_many(&walked);
        assert!(idx.contains("Incoming/deep"));
        assert!(idx.contains("Incoming/deep/file.txt"));
        assert_eq!(idx.stats().files, 6);
        assert_eq!(idx.stats().dirs, 6);
        // Feeding the same walk twice adds nothing.
        idx.insert_many(&walked);
        assert_eq!(idx.stats().files, 6);
    }

    // ---- recency mode ----------------------------------------------------

    /// A fixed instant, so these tests never depend on the wall clock.
    const T: u64 = 1_700_000_000_000;
    const MINUTE: u64 = 60_000;
    const HOUR: u64 = 60 * MINUTE;
    const DAY: u64 = 24 * HOUR;

    /// Write a file and pin its mtime, so recency assertions are exact.
    fn write_at(root: &Path, rel: &str, ms: u64) {
        let p = root.join(rel);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(&p, b"x").unwrap();
        let f = fs::File::options().write(true).open(&p).unwrap();
        f.set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms))
            .unwrap();
    }

    fn timed_fixture() -> (tempfile::TempDir, NameIndex) {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write_at(root, "fresh.md", T);
        write_at(root, "notes/recent-note.md", T - MINUTE);
        write_at(root, "notes/stale-note.md", T - 2 * HOUR);
        write_at(root, "ancient.md", T - 30 * DAY);
        let idx = NameIndex::build(root);
        (tmp, idx)
    }

    #[test]
    fn recency_windows_the_mount_and_never_lists_folders() {
        let (_tmp, idx) = timed_fixture();

        // One hour back: the two newest files, newest first, and NOT the
        // `notes` folder, whose own mtime is current because it was just
        // written into.
        let r = idx.search("", Some(T - HOUR));
        let paths: Vec<&str> = r.hits.iter().map(|h| h.path.as_str()).collect();
        assert_eq!(paths, vec!["fresh.md", "notes/recent-note.md"]);
        assert_eq!(r.total, 2);
        assert!(r.hits.iter().all(|h| !h.is_dir));
        assert!(idx.contains("notes"), "the folder is indexed, just not listed");

        // Widening reaches further back, still newest first.
        let r = idx.search("", Some(T - DAY));
        let paths: Vec<&str> = r.hits.iter().map(|h| h.path.as_str()).collect();
        assert_eq!(paths, vec!["fresh.md", "notes/recent-note.md", "notes/stale-note.md"]);

        // A window that reaches nothing is empty, not an error.
        let r = idx.search("", Some(T + MINUTE));
        assert!(r.hits.is_empty());
        assert_eq!(r.total, 0);
    }

    #[test]
    fn recency_excludes_unreadable_mtimes_rather_than_dating_them_to_1970() {
        let (_tmp, mut idx) = timed_fixture();
        // 0 is what `modified_millis` returns when the stat failed. It is not
        // evidence the file is old, so it must not surface in any window.
        for e in idx.entries.iter_mut() {
            if e.rel == "fresh.md" {
                e.modified = 0;
            }
        }
        let r = idx.search("", Some(0));
        let paths: Vec<&str> = r.hits.iter().map(|h| h.path.as_str()).collect();
        assert!(!paths.contains(&"fresh.md"));
        assert_eq!(r.total, 3);
    }

    #[test]
    fn recency_and_terms_intersect() {
        let (_tmp, idx) = timed_fixture();
        let r = idx.search("note", Some(T - DAY));
        let paths: Vec<&str> = r.hits.iter().map(|h| h.path.as_str()).collect();
        assert_eq!(paths, vec!["notes/recent-note.md", "notes/stale-note.md"]);
        assert_eq!(r.total, 2);

        // A term that matches nothing in the window yields nothing, even
        // though the term matches a file outside it.
        let r = idx.search("ancient", Some(T - DAY));
        assert!(r.hits.is_empty());
        assert_eq!(idx.search("ancient", None).total, 1);
    }

    #[test]
    fn equal_mtimes_hold_their_order_across_calls() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        // Same millisecond, deliberately written in reverse alphabetical order
        // so insertion order and path order disagree.
        for name in ["zebra.md", "middle.md", "alpha.md"] {
            write_at(root, name, T);
        }
        let mut idx = NameIndex::build(root);
        let first: Vec<String> = idx.search("", Some(T - HOUR)).hits.into_iter().map(|h| h.path).collect();
        assert_eq!(first, vec!["alpha.md", "middle.md", "zebra.md"]);

        // A watcher batch appends to `entries`, so index order drifts from
        // path order. The ordering must not drift with it, or the UI cursor
        // jumps to a different row on every refresh.
        write_at(root, "beta.md", T);
        assert!(idx.upsert("beta.md"));
        let second: Vec<String> = idx.search("", Some(T - HOUR)).hits.into_iter().map(|h| h.path).collect();
        assert_eq!(second, vec!["alpha.md", "beta.md", "middle.md", "zebra.md"]);
    }

    #[test]
    fn the_cap_keeps_the_newest_not_an_arbitrary_two_hundred() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        // 300 files, oldest first, so a naive scan order would keep the wrong
        // ones. File i is i minutes old.
        for i in 0..300u64 {
            write_at(root, &format!("d{}/f{:03}.md", i % 5, i), T - i * MINUTE);
        }
        let idx = NameIndex::build(root);
        let r = idx.search("", Some(T - 24 * HOUR));

        assert_eq!(r.total, 300, "total counts every match, not just the kept ones");
        assert_eq!(r.hits.len(), MAX_HITS);
        // Strictly newest-first, and the oldest kept hit is the 200th newest.
        assert!(r.hits.windows(2).all(|w| w[0].modified >= w[1].modified));
        assert_eq!(r.hits[0].modified, T);
        assert_eq!(r.hits[MAX_HITS - 1].modified, T - (MAX_HITS as u64 - 1) * MINUTE);
    }

    #[test]
    fn relevance_mode_is_unchanged_and_now_reports_its_own_total() {
        let tmp = fixture();
        let idx = NameIndex::build(tmp.path());

        // The pre-0.4.0 contract: empty query returns nothing in relevance
        // mode, and ranking is untouched.
        let r = idx.search("", None);
        assert!(r.hits.is_empty());
        assert_eq!(r.total, 0);

        let r = idx.search("skill", None);
        assert_eq!(r.hits[0].path, ".claude/skills/wiki-skill/SKILL.md");
        // Three paths contain "skill"; all three are counted and all fit.
        assert_eq!(r.total, r.hits.len());
        assert_eq!(r.total, 3);
    }
}
