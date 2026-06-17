use tauri::{
    Manager,
    tray::TrayIconEvent,
};

#[tauri::command]
fn open_external(url: String) {
    let _ = open::that(url);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // System tray click -> toggle window
            let handle = app.handle().clone();
            if let Some(tray) = app.tray_by_id("main-tray") {
                tray.on_tray_icon_event(move |_tray, event| {
                    if let TrayIconEvent::Click { .. } = event {
                        if let Some(window) = handle.get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![open_external])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
