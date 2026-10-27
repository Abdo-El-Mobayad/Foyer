//! Foyer desktop core. Rust owns all disk access; the React UI talks to it
//! through the typed commands registered here and reacts to the
//! `files-changed` and `index-ready` events. The only writes are notes
//! (Markdown) and folders inside the open mount; see `writefile.rs`.

mod commands;
mod config;
mod error;
pub mod name_index;
pub mod readfile;
pub mod rules;
mod state;
pub mod tree;
mod watcher;
pub mod writefile;

use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // One window per user: a second launch focuses the running instance.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        use tauri::Manager;
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
    }));

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::list_mounts,
            commands::add_mount,
            commands::remove_mount,
            commands::open_mount,
            commands::list_children,
            commands::read_text,
            commands::read_bytes,
            commands::stat_path,
            commands::abs_path,
            commands::write_text,
            commands::create_note,
            commands::create_folder,
            commands::rename_path,
            commands::trash_path,
            commands::search_names,
            commands::index_status,
            commands::open_in_default_app,
            commands::open_folder,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
