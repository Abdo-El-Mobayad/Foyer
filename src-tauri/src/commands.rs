//! The Tauri command surface. All disk I/O happens here or in the modules
//! these call; the UI never touches the filesystem directly. The only writes
//! inside a mount are notes (Markdown) and folders, bounded by the mount; see
//! `writefile.rs`.

use crate::config::{self, AppConfig, Mount};
use crate::error::{AppError, AppResult};
use crate::name_index::{IndexStats, NameIndex, SearchResult};
use crate::readfile::{self, PathStat, TextFile};
use crate::rules::resolve_in_root;
use crate::state::AppState;
use crate::tree::{self, TreeNode};
use crate::watcher;
use crate::writefile::{self, WriteResult};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

// ---- config ---------------------------------------------------------------

fn config_file(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::new(format!("no config dir: {e}")))?;
    Ok(dir.join("config.json"))
}

fn read_config(app: &AppHandle) -> AppResult<AppConfig> {
    Ok(config::read(&config_file(app)?))
}

fn write_config(app: &AppHandle, cfg: &AppConfig) -> AppResult<()> {
    config::write(&config_file(app)?, cfg)
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MountList {
    pub mounts: Vec<Mount>,
    pub active_mount_id: Option<String>,
}

#[tauri::command]
pub fn list_mounts(app: AppHandle) -> AppResult<MountList> {
    let cfg = read_config(&app)?;
    Ok(MountList {
        mounts: cfg.mounts,
        active_mount_id: cfg.active_mount_id,
    })
}

/// Native folder picker, then add (or re-activate) and open the mount.
/// Returns None if the dialog was cancelled.
#[tauri::command]
pub async fn add_mount(app: AppHandle, state: State<'_, AppState>) -> AppResult<Option<Mount>> {
    let Some(folder) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let path = folder
        .into_path()
        .map_err(|e| AppError::new(format!("invalid folder: {e}")))?;
    if !path.is_dir() {
        return Err(AppError::new("selected path is not a folder"));
    }
    let mut cfg = read_config(&app)?;
    let mount = cfg.add_or_activate(&path.to_string_lossy());
    write_config(&app, &cfg)?;
    open_mount_inner(&app, &state, &mount)?;
    Ok(Some(mount))
}

#[tauri::command]
pub fn remove_mount(app: AppHandle, state: State<'_, AppState>, id: String) -> AppResult<()> {
    let mut cfg = read_config(&app)?;
    cfg.remove(&id);
    write_config(&app, &cfg)?;
    let mut inner = state.inner.lock().unwrap();
    if inner.mount_id.as_deref() == Some(id.as_str()) {
        inner.clear();
    }
    Ok(())
}

/// Payload of the `index-ready` event.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IndexReady {
    pub mount_id: String,
    pub stats: IndexStats,
}

fn open_mount_inner(app: &AppHandle, state: &State<AppState>, mount: &Mount) -> AppResult<()> {
    let root = PathBuf::from(&mount.path);
    if !root.is_dir() {
        return Err(AppError::new(format!("folder is not available: {}", mount.path)));
    }

    // Let the webview stream files under this mount through `asset://`
    // (images, PDFs, HTML pages, media in the preview pane).
    let _ = app.asset_protocol_scope().allow_directory(&root, true);

    // Stop the previous mount's watcher, cancel its build and drop its index
    // BEFORE the new one starts, so nothing from the old mount lands in the
    // new state.
    {
        let mut inner = state.inner.lock().unwrap();
        inner.clear();
    }

    let index: Arc<Mutex<Option<NameIndex>>> = Arc::new(Mutex::new(None));
    let cancel = Arc::new(AtomicBool::new(false));
    let watcher = watcher::start(mount.id.clone(), root.clone(), index.clone(), app.clone())?;

    {
        let mut inner = state.inner.lock().unwrap();
        inner.mount_id = Some(mount.id.clone());
        inner.root = Some(root.clone());
        inner.index = Some(index.clone());
        inner.build_cancel = Some(cancel.clone());
        inner.watcher = Some(watcher);
    }

    // Build the index in the background; the sidebar walks the disk lazily and
    // needs nothing from it, so the mount is usable at once. One build per
    // open: switching mounts cancels the build in flight.
    let (bg_app, bg_id) = (app.clone(), mount.id.clone());
    std::thread::spawn(move || {
        let Some(built) = NameIndex::build_cancellable(&root, &cancel) else { return };
        let stats = built.stats();
        if let Ok(mut guard) = index.lock() {
            *guard = Some(built);
        }
        let _ = bg_app.emit("index-ready", IndexReady { mount_id: bg_id, stats });
    });
    Ok(())
}

/// Open a known mount by id: mark it active, start its watcher and index.
#[tauri::command]
pub async fn open_mount(app: AppHandle, state: State<'_, AppState>, id: String) -> AppResult<Mount> {
    let mut cfg = read_config(&app)?;
    let mount = cfg
        .touch(&id)
        .ok_or_else(|| AppError::new("unknown mount"))?;
    open_mount_inner(&app, &state, &mount)?;
    write_config(&app, &cfg)?;
    Ok(mount)
}

// ---- reads ----------------------------------------------------------------

/// The root of the mount the caller thinks is open. A stale id (the user
/// switched mounts while a read was in flight) is refused rather than
/// answered with the other mount's files.
fn require_root(state: &State<AppState>, id: &str) -> AppResult<PathBuf> {
    let inner = state.inner.lock().unwrap();
    if inner.mount_id.as_deref() != Some(id) {
        return Err(AppError::new("mount-mismatch: that mount is not open"));
    }
    inner
        .root
        .clone()
        .ok_or_else(|| AppError::new("no mount is open"))
}

/// Disk work runs on the blocking pool, never on an async runtime worker or
/// the main thread, so a slow read cannot stall other commands or the UI.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> AppResult<T> + Send + 'static) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::new(format!("disk task failed: {e}")))?
}

#[tauri::command]
pub async fn list_children(
    state: State<'_, AppState>,
    id: String,
    rel: String,
) -> AppResult<Vec<TreeNode>> {
    let root = require_root(&state, &id)?;
    if !rel.is_empty() {
        resolve_in_root(&root, &rel)?;
    }
    blocking(move || tree::list_children(&root, &rel)).await
}

#[tauri::command]
pub async fn read_text(state: State<'_, AppState>, id: String, rel: String) -> AppResult<TextFile> {
    let root = require_root(&state, &id)?;
    blocking(move || readfile::read_text(&root, &rel)).await
}

/// Raw bytes as a binary IPC response (an ArrayBuffer in the webview), not a
/// JSON array of numbers: a 30 MB workbook is 30 MB on the wire, not a
/// 100 MB JSON string that then becomes millions of JS array elements.
#[tauri::command]
pub async fn read_bytes(state: State<'_, AppState>, id: String, rel: String) -> AppResult<tauri::ipc::Response> {
    let root = require_root(&state, &id)?;
    let bytes = blocking(move || readfile::read_bytes(&root, &rel)).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn stat_path(state: State<'_, AppState>, id: String, rel: String) -> AppResult<PathStat> {
    let root = require_root(&state, &id)?;
    blocking(move || readfile::stat_path(&root, &rel)).await
}

/// The OS-native absolute path of a mount-relative path, for Copy path, the
/// VS Code URL and Explorer reveal. `rel` may be "" for the mount itself.
#[tauri::command]
pub async fn abs_path(state: State<'_, AppState>, id: String, rel: String) -> AppResult<String> {
    let root = require_root(&state, &id)?;
    let abs = if rel.is_empty() { root } else { resolve_in_root(&root, &rel)? };
    Ok(abs.to_string_lossy().to_string())
}

// ---- writes (notes and folders only, see writefile.rs) --------------------

/// Save a note. `expected_modified` (JS `expectedModified`) is the mtime the
/// editor loaded, so a file changed on disk since is refused with
/// `conflict:` instead of overwritten; null is the deliberate overwrite.
#[tauri::command]
pub async fn write_text(
    state: State<'_, AppState>,
    id: String,
    rel: String,
    text: String,
    expected_modified: Option<u64>,
) -> AppResult<WriteResult> {
    let root = require_root(&state, &id)?;
    blocking(move || writefile::write_text(&root, &rel, &text, expected_modified)).await
}

/// Create an empty note in `dir` ("" for the mount root). Returns its
/// mount-relative path so the UI can open it straight away.
#[tauri::command]
pub async fn create_note(state: State<'_, AppState>, id: String, dir: String, name: String) -> AppResult<String> {
    let root = require_root(&state, &id)?;
    blocking(move || writefile::create_note(&root, &dir, &name)).await
}

/// Create a folder in `dir` ("" for the mount root). Returns its
/// mount-relative path.
#[tauri::command]
pub async fn create_folder(state: State<'_, AppState>, id: String, dir: String, name: String) -> AppResult<String> {
    let root = require_root(&state, &id)?;
    blocking(move || writefile::create_folder(&root, &dir, &name)).await
}

/// Rename a note or folder within its own folder. Returns the new
/// mount-relative path, which the UI moves its tabs and sessions to.
#[tauri::command]
pub async fn rename_path(state: State<'_, AppState>, id: String, rel: String, name: String) -> AppResult<String> {
    let root = require_root(&state, &id)?;
    blocking(move || writefile::rename_path(&root, &rel, &name)).await
}

/// Move a note or folder to the Recycle Bin. On the blocking pool like every
/// other disk call: the shell operation behind it can take a while on a big
/// folder.
#[tauri::command]
pub async fn trash_path(state: State<'_, AppState>, id: String, rel: String) -> AppResult<()> {
    let root = require_root(&state, &id)?;
    blocking(move || writefile::trash_path(&root, &rel)).await
}

// ---- index ----------------------------------------------------------------

fn require_index(state: &State<AppState>, id: &str) -> AppResult<Arc<Mutex<Option<NameIndex>>>> {
    let inner = state.inner.lock().unwrap();
    if inner.mount_id.as_deref() != Some(id) {
        return Err(AppError::new("mount-mismatch: that mount is not open"));
    }
    inner
        .index
        .clone()
        .ok_or_else(|| AppError::new("no mount is open"))
}

#[tauri::command]
/// `since_ms` (JS `sinceMs`) switches the index from relevance to recency:
/// Some(epoch millis) lists files modified at or after that instant, newest
/// first, and an empty `query` is then legal.
pub async fn search_names(
    state: State<'_, AppState>,
    id: String,
    query: String,
    since_ms: Option<u64>,
) -> AppResult<SearchResult> {
    let index = require_index(&state, &id)?;
    let guard = index.lock().unwrap();
    match guard.as_ref() {
        Some(idx) => Ok(idx.search(&query, since_ms)),
        None => Err(AppError::new("index-building")),
    }
}

#[tauri::command]
pub async fn index_status(state: State<'_, AppState>, id: String) -> AppResult<Option<IndexStats>> {
    let index = require_index(&state, &id)?;
    let guard = index.lock().unwrap();
    Ok(guard.as_ref().map(|i| i.stats()))
}

// ---- launching ------------------------------------------------------------

/// Open a mounted file with whatever the OS uses for it. From Rust rather than
/// the opener plugin's own command because that one is capability-scoped to
/// $HOME, and a mount under C:\Github is outside it; the boundary here is the
/// mount, enforced by `resolve_in_root`.
#[tauri::command]
pub async fn open_in_default_app(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    rel: String,
) -> AppResult<()> {
    use tauri_plugin_opener::OpenerExt;
    let root = require_root(&state, &id)?;
    let abs = resolve_in_root(&root, &rel)?;
    app.opener()
        .open_path(abs.to_string_lossy().to_string(), None::<String>)
        .map_err(|e| AppError::new(format!("open failed: {e}")))?;
    Ok(())
}

/// Open a folder in the OS file manager. Same scope reasoning as above.
#[tauri::command]
pub async fn open_folder(app: AppHandle, state: State<'_, AppState>, id: String, rel: String) -> AppResult<()> {
    use tauri_plugin_opener::OpenerExt;
    let root = require_root(&state, &id)?;
    let abs = if rel.is_empty() { root } else { resolve_in_root(&root, &rel)? };
    if !Path::new(&abs).is_dir() {
        return Err(AppError::new("not a folder"));
    }
    app.opener()
        .open_path(abs.to_string_lossy().to_string(), None::<String>)
        .map_err(|e| AppError::new(format!("open failed: {e}")))?;
    Ok(())
}
