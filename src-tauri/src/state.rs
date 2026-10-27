//! Shared application state: the open mount, its name index, and the watcher
//! handle. One mutex; commands clone what they need and release it quickly.
//! The index sits behind its own lock so a search never waits on a tree read
//! and the background build never blocks the UI.

use crate::name_index::NameIndex;
use crate::watcher::MountWatcher;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub struct AppState {
    pub inner: Mutex<Inner>,
}

#[derive(Default)]
pub struct Inner {
    pub mount_id: Option<String>,
    pub root: Option<PathBuf>,
    /// `None` while the background build is still running.
    pub index: Option<Arc<Mutex<Option<NameIndex>>>>,
    /// Set to stop the background build of `index` (a mount switch, a
    /// removal). Each open gets a fresh flag.
    pub build_cancel: Option<Arc<AtomicBool>>,
    pub watcher: Option<MountWatcher>,
}

impl Inner {
    /// Forget the open mount: cancel its index build, stop its watcher
    /// (joined on drop), drop its index.
    pub fn clear(&mut self) {
        if let Some(flag) = self.build_cancel.take() {
            flag.store(true, std::sync::atomic::Ordering::Relaxed);
        }
        self.watcher = None;
        self.index = None;
        self.root = None;
        self.mount_id = None;
    }
}
