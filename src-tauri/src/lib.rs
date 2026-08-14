// ✅ 2026-07-17 Android dəstəyi: tray + pəncərə yerləşdirmə yalnız desktop-dadır —
// mobil build-də bu API-lər mövcud deyil, cfg(desktop) ilə qorunur.
#[cfg(desktop)]
use tauri::Manager;
#[cfg(desktop)]
use tauri::tray::TrayIconEvent;

// ✅ 2026-07-21: Native LAN çap körpüsü (olko-pos-dan köçürüldü). Mac/Windows kassa
// QZ Tray/RawBT olmadan birbaşa LAN printerə (IP:9100) TCP ilə çap edir.
// İki yol: (1) Tauri IPC komandaları (native_ping/test/print) — remote ERP səhifəsi
// withGlobalTauri + capability remote.urls ilə çağırır; (2) HTTP körpü 127.0.0.1:9631
// (IPC olmayan hallar üçün ehtiyat). ERP printing servisi əvvəl IPC-ni sınayır.
use std::io::Write;
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

use base64::Engine;
use serde::Deserialize;

const BRIDGE_PORT: u16 = 9631;

#[derive(Deserialize)]
struct PrintReq {
    ip: String,
    #[serde(default = "default_port")]
    port: u16,
    data_base64: String,
}

#[derive(Deserialize)]
struct TestReq {
    ip: String,
    #[serde(default = "default_port")]
    port: u16,
}

fn default_port() -> u16 {
    9100
}

fn resolve_addr(ip: &str, port: u16) -> Result<std::net::SocketAddr, String> {
    format!("{ip}:{port}")
        .to_socket_addrs()
        .map_err(|e| format!("ünvan xətası: {e}"))?
        .next()
        .ok_or_else(|| "ünvan həll olunmadı".to_string())
}

fn send_to_printer(ip: &str, port: u16, bytes: &[u8]) -> Result<(), String> {
    let addr = resolve_addr(ip, port)?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(5))
        .map_err(|e| format!("printerə qoşulmaq olmadı ({ip}:{port}): {e}"))?;
    stream.set_write_timeout(Some(Duration::from_secs(5))).ok();
    stream
        .write_all(bytes)
        .map_err(|e| format!("çap göndərmə xətası: {e}"))?;
    stream.flush().ok();
    Ok(())
}

fn cors_headers() -> Vec<tiny_http::Header> {
    vec![
        tiny_http::Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap(),
        tiny_http::Header::from_bytes(&b"Access-Control-Allow-Methods"[..], &b"POST, GET, OPTIONS"[..]).unwrap(),
        tiny_http::Header::from_bytes(&b"Access-Control-Allow-Headers"[..], &b"Content-Type"[..]).unwrap(),
        tiny_http::Header::from_bytes(&b"Access-Control-Allow-Private-Network"[..], &b"true"[..]).unwrap(),
        tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap(),
    ]
}

fn json_response(status: u16, body: &str) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    let mut resp = tiny_http::Response::from_string(body).with_status_code(status);
    for h in cors_headers() {
        resp.add_header(h);
    }
    resp
}

fn json_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string())
}

fn handle_request(mut req: tiny_http::Request) {
    let method = req.method().clone();
    let url = req.url().to_string();

    if method == tiny_http::Method::Options {
        let _ = req.respond(json_response(204, ""));
        return;
    }
    if method == tiny_http::Method::Get && url.starts_with("/health") {
        let _ = req.respond(json_response(200, r#"{"ok":true,"app":"olko-desktop"}"#));
        return;
    }
    if method == tiny_http::Method::Post && url.starts_with("/print") {
        let mut body = String::new();
        if req.as_reader().read_to_string(&mut body).is_err() {
            let _ = req.respond(json_response(400, r#"{"ok":false,"error":"body oxunmadı"}"#));
            return;
        }
        match serde_json::from_str::<PrintReq>(&body) {
            Ok(p) => match base64::engine::general_purpose::STANDARD.decode(p.data_base64.trim()) {
                Ok(bytes) if !bytes.is_empty() => match send_to_printer(&p.ip, p.port, &bytes) {
                    Ok(_) => {
                        let _ = req.respond(json_response(200, r#"{"ok":true}"#));
                    }
                    Err(e) => {
                        let body = format!(r#"{{"ok":false,"error":{}}}"#, json_str(&e));
                        let _ = req.respond(json_response(502, &body));
                    }
                },
                Ok(_) => {
                    let _ = req.respond(json_response(400, r#"{"ok":false,"error":"boş data"}"#));
                }
                Err(e) => {
                    let body = format!(r#"{{"ok":false,"error":{}}}"#, json_str(&format!("base64: {e}")));
                    let _ = req.respond(json_response(400, &body));
                }
            },
            Err(e) => {
                let body = format!(r#"{{"ok":false,"error":{}}}"#, json_str(&format!("json: {e}")));
                let _ = req.respond(json_response(400, &body));
            }
        }
        return;
    }
    if method == tiny_http::Method::Post && url.starts_with("/test") {
        let mut body = String::new();
        let _ = req.as_reader().read_to_string(&mut body);
        match serde_json::from_str::<TestReq>(&body) {
            Ok(t) => match resolve_addr(&t.ip, t.port)
                .and_then(|a| TcpStream::connect_timeout(&a, Duration::from_secs(4)).map_err(|e| e.to_string()))
            {
                Ok(_) => {
                    let _ = req.respond(json_response(200, r#"{"ok":true}"#));
                }
                Err(e) => {
                    let body = format!(r#"{{"ok":false,"error":{}}}"#, json_str(&e));
                    let _ = req.respond(json_response(502, &body));
                }
            },
            Err(_) => {
                let _ = req.respond(json_response(400, r#"{"ok":false,"error":"json"}"#));
            }
        }
        return;
    }
    let _ = req.respond(json_response(404, r#"{"ok":false,"error":"not found"}"#));
}

#[tauri::command]
fn native_ping() -> bool {
    true
}

#[tauri::command]
fn native_test(ip: String, port: Option<u16>) -> Result<(), String> {
    let p = port.unwrap_or(9100);
    let addr = resolve_addr(&ip, p)?;
    TcpStream::connect_timeout(&addr, Duration::from_secs(4))
        .map(|_| ())
        .map_err(|e| format!("printerə qoşulmaq olmadı ({ip}:{p}): {e}"))
}

#[tauri::command]
fn native_print(ip: String, port: Option<u16>, data_base64: String) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.trim())
        .map_err(|e| format!("base64: {e}"))?;
    if bytes.is_empty() {
        return Err("boş data".to_string());
    }
    send_to_printer(&ip, port.unwrap_or(9100), &bytes)
}

fn start_bridge() {
    std::thread::spawn(|| {
        match tiny_http::Server::http(("127.0.0.1", BRIDGE_PORT)) {
            Ok(server) => {
                log::info!("Olko çap körpüsü: http://127.0.0.1:{BRIDGE_PORT}");
                for req in server.incoming_requests() {
                    std::thread::spawn(move || handle_request(req));
                }
            }
            Err(e) => {
                log::error!("çap körpüsü başlamadı: {e}");
            }
        }
    });
}

#[tauri::command]
fn open_external(url: String) {
    // `open` crate-i yalnız desktop-da mövcuddur; mobil-də webview daxilində qalırıq
    #[cfg(desktop)]
    let _ = open::that(url);
    #[cfg(mobile)]
    let _ = url;
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init());

    // ✅ 2026-07-27: avtomatik yeniləmə (yalnız masaüstü — mobil platformalarda yoxdur).
    // İmza `tauri.conf.json`-dakı açıq açarla yoxlanır → saxta yeniləmə quraşdırıla bilməz.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    builder
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // ✅ Native çap körpüsünü başlat (127.0.0.1:9631) — IPC-nin ehtiyatı
            start_bridge();

            #[cfg(desktop)]
            {
                // ✅ 2026-07-27: pəncərəni ekranın SAĞ kənarına yerləşdirən blok SİLİNDİ.
                // Bubble dövründən qalmışdı və sabit 424×644 ölçüləri ilə hesablayırdı →
                // konfiqdəki `center: true` / `maximized: true` heç bir təsir göstərmirdi
                // ("proqram hər dəfə sağda açılır"). İndi mövqeyi OS/konfiq idarə edir.

                // System tray click -> toggle window
                // ✅ 2026-07-27 (macOS davranışı): qırmızı X pəncərəni GİZLƏDİR, proqramı
                // bağlamır — Dock ikonu qalır, ⌘Tab-da görünür (adi Mac proqramı kimi).
                // Əvvəl X proqramı tam söndürürdü və Dock-dan itirdi.
                // Tam çıxış: ⌘Q və ya tray → "Proqramdan çıx".
                #[cfg(target_os = "macos")]
                if let Some(window) = app.get_webview_window("main") {
                    let w = window.clone();
                    window.on_window_event(move |event| {
                        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                            api.prevent_close();
                            let _ = w.hide();
                        }
                    });
                }

                // ✅ Tray menyusu: app-daxili header götürüldüyü üçün sayt dəyişmə/çıxış
                // əməliyyatları buradan əlçatandır (sağ klik → menyu).
                {
                    use tauri::menu::{MenuBuilder, MenuItemBuilder};
                    // 🔴 Faza 1.0: app artıq tək sayta bağlı deyil — iş sahələri
                    //    (workspace) siyahısı var. Etiket «Saytı dəyiş» yanıldıcı
                    //    olardı: bu düymə heç nə silmir, sadəcə LAUNCHER-i qaytarır.
                    let reset = MenuItemBuilder::with_id("reset_site", "İş sahələri").build(app)?;
                    let quit = MenuItemBuilder::with_id("quit_app", "Proqramdan çıx").build(app)?;
                    let menu = MenuBuilder::new(app).items(&[&reset, &quit]).build()?;
                    if let Some(tray) = app.tray_by_id("main-tray") {
                        let _ = tray.set_menu(Some(menu));
                        let h = app.handle().clone();
                        tray.on_menu_event(move |_tray, event| match event.id().as_ref() {
                            "reset_site" => {
                                if let Some(w) = h.get_webview_window("main") {
                                    let _ = w.show();
                                    let _ = w.set_focus();
                                    // ⚠️ ERP uzaq domenində Tauri IPC yoxdur → hadisə yayımlamaq
                                    // fayda vermir. Ona görə webview-i app səhifəsinə QAYTARIRIQ;
                                    // `?setup=1` frontend-ə avtomatik keçidi dayandırmağı bildirir.
                                    #[cfg(target_os = "windows")]
                                    let home = "http://tauri.localhost/?setup=1";
                                    #[cfg(not(target_os = "windows"))]
                                    let home = "tauri://localhost/?setup=1";
                                    if let Ok(u) = home.parse() {
                                        let _ = w.navigate(u);
                                    }
                                }
                            }
                            "quit_app" => h.exit(0),
                            _ => {}
                        });
                    }
                }

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
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_external,
            native_ping,
            native_test,
            native_print
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            // ✅ macOS: Dock ikonuna klik (Reopen) — X ilə gizlədilmiş pəncərəni geri gətir.
            // Bu olmasa X-dən sonra Dock ikonu işə yaramır (pəncərə bir daha açılmır).
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                if let Some(w) = _app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        });
}
