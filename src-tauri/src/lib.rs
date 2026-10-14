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

// ═══ v0.5.18 (54.137) — USB / SİSTEM PRİNTERİNƏ RAW ÇAP ═══════════════════════════════
// Rasim: «termal printer (ZY307) birbaşa USB ilə kompa qoşulub … pəncərə açılmasın, çap et vuran
// kimi çap birbaşa getsin». Şəbəkə körpüsü (`native_print`) yalnız IP:9100 bilir; USB printer isə
// OS-in çap növbəsindədir. ESC/POS baytları növbəyə **RAW** gedir — sürücünün səhifə tərtibatı,
// dialoq yoxdur, kəsmə əmri işləyir. Windows: winspool (`OpenPrinterW` → `StartDocPrinterW` «RAW»
// → `WritePrinter`); macOS / Linux: CUPS (`lp -o raw`). Printer adı YALNIZ sistem siyahısından
// qəbul olunur — uzaq (tenant) səhifə sərbəst sətirlə başqa cihaza / fayla yazdıra bilməsin.

/// Çap işinin tavanı — ESC/POS çeki adətən < 50 KB (loqo ilə < 500 KB).
const USB_PRINT_MAX_BYTES: usize = 2 * 1024 * 1024;

#[cfg(windows)]
mod sysprint {
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Graphics::Printing::{
        ClosePrinter, EndDocPrinter, EndPagePrinter, EnumPrintersW, OpenPrinterW, StartDocPrinterW,
        StartPagePrinter, WritePrinter, DOC_INFO_1W, PRINTER_ENUM_CONNECTIONS, PRINTER_ENUM_LOCAL,
        PRINTER_INFO_4W,
    };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn last_err() -> String {
        std::io::Error::last_os_error().to_string()
    }

    unsafe fn from_wide(p: *const u16) -> Option<String> {
        if p.is_null() {
            return None;
        }
        let mut len = 0usize;
        while *p.add(len) != 0 {
            len += 1;
        }
        Some(String::from_utf16_lossy(std::slice::from_raw_parts(p, len)))
    }

    pub fn list() -> Result<Vec<String>, String> {
        let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
        let mut needed: u32 = 0;
        let mut returned: u32 = 0;
        unsafe {
            // 1-ci çağırış: lazım olan bufer ölçüsü (ERROR_INSUFFICIENT_BUFFER gözlənilir)
            EnumPrintersW(flags, std::ptr::null(), 4, std::ptr::null_mut(), 0, &mut needed, &mut returned);
            if needed == 0 {
                return Ok(Vec::new());
            }
            // u64 buferi — PRINTER_INFO_4W-nin göstəriciləri üçün düzgün hizalanma
            let mut buf: Vec<u64> = vec![0; (needed as usize + 7) / 8];
            if EnumPrintersW(flags, std::ptr::null(), 4, buf.as_mut_ptr() as *mut u8, needed, &mut needed, &mut returned) == 0 {
                return Err(format!("printer siyahısı alınmadı: {}", last_err()));
            }
            let infos = std::slice::from_raw_parts(buf.as_ptr() as *const PRINTER_INFO_4W, returned as usize);
            Ok(infos.iter().filter_map(|i| from_wide(i.pPrinterName)).collect())
        }
    }

    pub fn print_raw(printer: &str, data: &[u8]) -> Result<(), String> {
        let name = wide(printer);
        let mut doc_name = wide("Olko POS");
        let mut datatype = wide("RAW");
        unsafe {
            let mut h: HANDLE = std::ptr::null_mut();
            if OpenPrinterW(name.as_ptr(), &mut h, std::ptr::null()) == 0 {
                return Err(format!("printer açılmadı ({printer}): {}", last_err()));
            }
            let di = DOC_INFO_1W {
                pDocName: doc_name.as_mut_ptr(),
                pOutputFile: std::ptr::null_mut(),
                pDatatype: datatype.as_mut_ptr(),
            };
            if StartDocPrinterW(h, 1, &di) == 0 {
                let e = last_err();
                ClosePrinter(h);
                return Err(format!("çap işi başlamadı ({printer}): {e}"));
            }
            let mut result: Result<(), String> = Ok(());
            if StartPagePrinter(h) == 0 {
                result = Err(format!("səhifə başlamadı: {}", last_err()));
            } else {
                let mut written: u32 = 0;
                if WritePrinter(h, data.as_ptr() as *const core::ffi::c_void, data.len() as u32, &mut written) == 0 {
                    result = Err(format!("printerə yazılmadı: {}", last_err()));
                } else if written as usize != data.len() {
                    result = Err(format!("printerə yarımçıq yazıldı ({written}/{})", data.len()));
                }
                EndPagePrinter(h);
            }
            EndDocPrinter(h);
            ClosePrinter(h);
            result
        }
    }
}

#[cfg(all(unix, not(any(target_os = "android", target_os = "ios"))))]
mod sysprint {
    use std::io::Write;
    use std::process::{Command, Stdio};

    pub fn list() -> Result<Vec<String>, String> {
        // `lpstat -e` — növbə adları, sətir-sətir. Printer yoxdursa sıfırdan fərqli kodla çıxır → boş siyahı.
        let out = Command::new("lpstat").arg("-e").output().map_err(|e| format!("lpstat: {e}"))?;
        Ok(String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect())
    }

    pub fn print_raw(printer: &str, data: &[u8]) -> Result<(), String> {
        let mut child = Command::new("lp")
            .args(["-d", printer, "-o", "raw"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("lp: {e}"))?;
        child
            .stdin
            .take()
            .ok_or_else(|| "lp stdin yoxdur".to_string())?
            .write_all(data)
            .map_err(|e| format!("lp yazma: {e}"))?;
        let out = child.wait_with_output().map_err(|e| format!("lp: {e}"))?;
        if out.status.success() {
            Ok(())
        } else {
            Err(format!("lp: {}", String::from_utf8_lossy(&out.stderr).trim()))
        }
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
mod sysprint {
    pub fn list() -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
    pub fn print_raw(_printer: &str, _data: &[u8]) -> Result<(), String> {
        Err("bu platformada USB çap yoxdur".into())
    }
}

/// Printer adı sistem siyahısındadırmı (dəqiq uyğunluq). Boş ad — yox.
fn usb_printer_allowed(name: &str, list: &[String]) -> bool {
    !name.is_empty() && list.iter().any(|p| p == name)
}

#[tauri::command]
async fn native_list_printers() -> Result<Vec<String>, String> {
    sysprint::list()
}

#[tauri::command]
async fn native_print_usb(printer: String, data_base64: String) -> Result<(), String> {
    let printer = printer.trim().to_string();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.trim())
        .map_err(|e| format!("base64: {e}"))?;
    if bytes.is_empty() {
        return Err("boş data".to_string());
    }
    if bytes.len() > USB_PRINT_MAX_BYTES {
        return Err("çap işi çox böyükdür".to_string());
    }
    let list = sysprint::list()?;
    if !usb_printer_allowed(&printer, &list) {
        return Err(format!("printer tapılmadı: «{printer}» — Printer ayarında yenidən seçin"));
    }
    sysprint::print_raw(&printer, &bytes)
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

// ═════════════════════════════════════════════════════════════════
// İŞ SAHƏLƏRİ — fayl-əsaslı mənbə + Rust-dan pəncərə açma (Faza 45.47)
// ═════════════════════════════════════════════════════════════════
// 🔴 NİYƏ FAYL: siyahı əvvəl yalnız launcher-in localStorage-ında idi.
// ERP səhifəsindəki iş sahəsi zolağı (remote origin) ona ÇATA BİLMİR —
// origin ayrıdır. Fayl isə hər iki tərəfdən invoke ilə oxunur. Üstəlik
// localStorage iki dəfə itki verdi (45.41, 45.46) — fayl bərpa mənbəyidir.

/// Webview-də service worker + Cache Storage təmizləyən skript (v0.5.12).
///
/// 🔴 NİYƏ NATIVE TƏRƏFDƏ: keşi təmizləyən düymə indiyədək YALNIZ ERP səhifəsinin
/// içində idi — «bundle ilişib» vəziyyətində onu düzəldən alət də ilişirdi.
/// Tray bəndi bu asılılığı qırır, ÇÜNKİ düymə köhnə bundle-dan asılı deyil.
///
/// ⚠️ DƏQİQLƏŞDİRMƏ (audit): bu, «səhifə hər vəziyyətdə» işləyir demək DEYİL.
/// `eval` skripti səhifənin ÖZ JS növbəsinə qoyur — səhifə sonsuz döngədə
/// donubsa, skript də növbədə gözləyir. Həll etdiyi hal: köhnə/nasaz bundle-da
/// düymənin OLMAMASI, donmuş JS mühərriki yox.
///
/// 🔴 OFLAYN QORUMASI (audit tapıntısı, blocker): veb tətbiq PWA-dır —
/// `vite.config.ts`-də `VitePWA` + precache + `navigateFallback` var, yəni
/// OFLAYN AÇILIŞI MƏHZ service worker və Cache Storage təmin edir. Oflayn ikən
/// onları silmək tətbiqi ümumiyyətlə açılmaz edərdi (POS oflayn satış!).
/// Ona görə oflayn halda yalnız reload olunur, təmizləmə edilmir.
///
/// 🔴 `clear_all_browsing_data()` QƏSDƏN İŞLƏDİLMİR — cookie-ləri də silir,
/// yəni istifadəçini bütün iş sahələrindən çıxarardı.
///
/// 🔴 VAXT LİMİTİ: `await` PENDING promise-i əbədi gözləyir və `try/catch` onu
/// TUTMUR (yalnız reject-i tutur). `unregister()` ilişsə reload heç vaxt
/// işləməzdi — yəni bənd «heç nə etmir» görünərdi. Hər addım 2.5 san ilə
/// yarışdırılır, reload isə `finally`-dədir: HƏMİŞƏ icra olunur.
const CLEAR_CACHE_JS: &str = r#"(async()=>{
  const t=ms=>new Promise(r=>setTimeout(r,ms));
  const race=p=>Promise.race([Promise.resolve(p).catch(()=>{}),t(2500)]);
  try{
    if(navigator.onLine){
      if(navigator.serviceWorker&&navigator.serviceWorker.getRegistrations){
        await race(navigator.serviceWorker.getRegistrations().then(rs=>Promise.all(rs.map(r=>r.unregister()))));
      }
      if(window.caches&&caches.keys){
        await race(caches.keys().then(ks=>Promise.all(ks.map(k=>caches.delete(k)))));
      }
    }
  }catch(e){}
  finally{ try{ location.reload(); }catch(e){} }
})();"#;

/// Tray menyusunu iş sahələri ilə birlikdə qurur (v0.5.13).
///
/// 🔴 NİYƏ NATIVE (istifadəçi qərarı): iş sahələri siyahısı əvvəl ERP səhifəsində
/// üzən React komponenti idi. İki problemi var idi:
///   ① hər dəyişiklik veb deploy + KEŞ TƏMİZLƏMƏ tələb edirdi — istifadəçi:
///      «app yenilənməsi ilə gəlməli idi bu funksiya»;
///   ② üzən element səhifə məzmununun ÜSTÜNƏ düşürdü.
/// Native menyu hər ikisini həll edir: app yeniləməsi ilə gəlir və heç nəyi örtmür.
///
/// Menyu SONRADAN yenidən qurula bilir (`tray.set_menu`) — `ws_save` çağırılanda
/// yenilənir, yəni launcher-də iş sahəsi əlavə edilən kimi menyuda görünür.
fn build_tray_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder};

    let list = ws_read(app);
    let mut owned: Vec<tauri::menu::MenuItem<tauri::Wry>> = Vec::new();
    for w in &list {
        let id = ws_field(w, "id");
        if id.is_empty() {
            continue;
        }
        let name = ws_display_name(w);
        let kind = ws_kind_label(w);
        owned.push(
            MenuItemBuilder::with_id(format!("ws:{id}"), format!("{name} — {kind}")).build(app)?,
        );
    }

    let reset = MenuItemBuilder::with_id("reset_site", "İş sahələri…").build(app)?;
    let clear = MenuItemBuilder::with_id("clear_cache", "Keşi təmizlə (səhifəni yenilə)").build(app)?;
    let quit = MenuItemBuilder::with_id("quit_app", "Proqramdan çıx").build(app)?;

    let mut b = MenuBuilder::new(app);
    for it in &owned {
        b = b.item(it);
    }
    if !owned.is_empty() {
        b = b.separator();
    }
    b.items(&[&reset, &clear, &quit]).build()
}

/// Tray menyusunu yenidən qurub tətbiq edir (siyahı dəyişəndən sonra).
fn refresh_tray_menu(app: &tauri::AppHandle) {
    if let Some(tray) = app.tray_by_id("main-tray") {
        match build_tray_menu(app) {
            Ok(menu) => { let _ = tray.set_menu(Some(menu)); }
            Err(e) => log::warn!("tray menyusu yenilənmədi: {e}"),
        }
    }
}

// ═════════════════════════════════════════════════════════════════
// İŞ SAHƏLƏRİ PANELİ — AYRICA NATIVE WEBVIEW (v0.5.15, multi-webview)
// ═════════════════════════════════════════════════════════════════
// 🔴 NİYƏ BELƏ (istifadəçi, dördüncü iterasiya): v0.5.14-də panel uzaq
// səhifəyə JS ilə yeridilirdi və `position:fixed` elementlər (tapşırıq
// çəkməcəsi, modallar) `html.marginRight`-ə tabe olmadığı üçün panelin
// ALTINA girirdi. İndi pəncərə NATIVE səviyyədə iki webview-ə bölünür:
//   • «content» — launcher/ERP (eni = pəncərə − 56px);
//   • «rail»    — public/rail.html (sabit 56px, hover-də 264px-ə genişlənir).
// Üst-üstə düşmə fiziki mümkün deyil: ERP öz webview-inin sərhədini görmür.
// Genişlənmiş hal QƏSDƏN örtmədir (müvəqqəti hover) — rail sonradan əlavə
// olunduğu üçün native qatda üstdədir.
// Tələb: tauri "unstable" feature (Window::add_child).

#[cfg(desktop)]
const RAIL_W: f64 = 56.0;

#[cfg(desktop)]
static RAIL_CUR: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(56);

/// content+rail webview-lərini pəncərə ölçüsünə görə düz (resize + hover-genişlənmə).
#[cfg(desktop)]
fn layout_main(app: &tauri::AppHandle, rail_w: f64) {
    let Some(win) = app.get_window("main") else { return };
    let scale = win.scale_factor().unwrap_or(1.0);
    let Ok(size) = win.inner_size() else { return };
    let w = size.width as f64 / scale;
    let h = size.height as f64 / scale;
    if let Some(content) = app.get_webview("content") {
        let _ = content.set_position(tauri::LogicalPosition::new(0.0, 0.0));
        let _ = content.set_size(tauri::LogicalSize::new((w - RAIL_W).max(200.0), h));
    }
    if let Some(rail) = app.get_webview("rail") {
        let _ = rail.set_position(tauri::LogicalPosition::new((w - rail_w).max(0.0), 0.0));
        let _ = rail.set_size(tauri::LogicalSize::new(rail_w.min(w), h));
    }
}

/// «main» pəncərəsində naviqasiya olunan webview. Multi-webview quruluşunda
/// pəncərə «main», məzmun webview-i isə «content» adlanır; ws-* pəncərələri
/// tək-webview qaldığı üçün onların webview etiketi pəncərə etiketi ilə eynidir.
#[cfg(desktop)]
fn content_webview_of(app: &tauri::AppHandle, window_label: &str) -> Option<tauri::Webview<tauri::Wry>> {
    if window_label == "main" {
        app.get_webview("content")
    } else {
        app.get_webview(window_label)
    }
}

fn ws_store_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("workspaces.json"))
}

fn ws_read(app: &tauri::AppHandle) -> Vec<serde_json::Value> {
    ws_store_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<Vec<serde_json::Value>>(&s).ok())
        .unwrap_or_default()
}

fn ws_write(app: &tauri::AppHandle, list: &[serde_json::Value]) -> Result<(), String> {
    let p = ws_store_path(app)?;
    let body = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    std::fs::write(p, body).map_err(|e| e.to_string())
}

/// 🔴 TS `sessionBytes` İLƏ BİRƏBİR EYNİ OLMALIDIR (workspaces.ts) —
/// fərqlənsə mövcud istifadəçilərin pəncərə sessiyası itər (yeni boş qab).
fn ws_session_bytes(id: &str) -> [u8; 16] {
    let mut out = [0u8; 16];
    for (i, u) in id.encode_utf16().enumerate() {
        let k = i % 16;
        out[k] = ((out[k] as u32 * 31 + u as u32) % 256) as u8;
    }
    if !out.iter().any(|b| *b != 0) {
        out[0] = 1;
    }
    out[6] = (out[6] & 0x0f) | 0x40;
    out[8] = (out[8] & 0x3f) | 0x80;
    out
}

fn ws_field<'a>(w: &'a serde_json::Value, key: &str) -> &'a str {
    w.get(key).and_then(|v| v.as_str()).unwrap_or("")
}

/// 🔴 `ws_open` REMOTE səhifədən çağırıla bilir → host formatı ciddi yoxlanır
/// (yalnız host: sxem, yol, port, boşluq yox). resolveSiteHost-dakı qayda ilə eyni.
fn ws_valid_host(h: &str) -> bool {
    !h.is_empty()
        && h.len() <= 253
        && h.contains('.')
        && h.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-')
        && !h.starts_with(['.', '-'])
        && !h.ends_with(['.', '-'])
}

/// v0.5.16 — POS terminal linki (`https://{host}/pos/<terminal>?token=…`) → açılacaq ünvan.
/// JS `parsePosLink` ilə EYNİ qaydalar, burada TƏKRAR yoxlanır: `ws_open` uzaq (tenant) səhifədən də
/// çağırıla bilir. Yalnız https (http → https), istifadəçi adı/şifrə hissəsi YOX (`https://x@host` hostu
/// gizlədir), port yox, host `ws_valid_host`, master sayt yox, yol `/pos/<terminal>`.
/// `olko_native_print=1` — POS səhifəsi çapı app-ın printer körpüsünə yönləndirir.
fn ws_pos_url(link: &str) -> Option<(String, String)> {
    let raw = link.trim();
    if raw.is_empty() {
        return None;
    }
    let with_scheme = if raw.starts_with("https://") || raw.starts_with("http://") {
        raw.to_string()
    } else {
        format!("https://{raw}")
    };
    let mut u: tauri::Url = with_scheme.parse().ok()?;
    if !u.username().is_empty() || u.password().is_some() || u.port().is_some() {
        return None;
    }
    if u.scheme() == "http" {
        u.set_scheme("https").ok()?;
    }
    if u.scheme() != "https" {
        return None;
    }
    let host = u.host_str()?.to_ascii_lowercase();
    if !ws_valid_host(&host) || host == "olkoerp.com" || host == "www.olkoerp.com" {
        return None;
    }
    let path = u.path().trim_end_matches('/').to_string();
    let terminal = path.strip_prefix("/pos/")?;
    if terminal.is_empty() || terminal.contains('/') {
        return None;
    }
    let pairs: Vec<(String, String)> = u
        .query_pairs()
        .filter(|(k, _)| k != "olko_native_print")
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    {
        let mut q = u.query_pairs_mut();
        q.clear();
        for (k, v) in &pairs {
            q.append_pair(k, v);
        }
        q.append_pair("olko_native_print", "1");
    }
    Some((u.to_string(), host))
}

/// Tray / pəncərə başlığı üçün tərəf adı.
fn ws_kind_label(w: &serde_json::Value) -> &'static str {
    match ws_field(w, "kind") {
        "portal" => "Müştəri",
        "pos" => "POS",
        _ => "İstifadəçi",
    }
}

/// Tray / başlıq üçün ad. POS-da ad yoxdursa terminal kodu — 🔴 token heç vaxt.
fn ws_display_name(w: &serde_json::Value) -> String {
    let l = ws_field(w, "label");
    if !l.is_empty() {
        return l.to_string();
    }
    if ws_field(w, "kind") == "pos" {
        if let Some(t) = ws_field(w, "posLink").split("/pos/").nth(1) {
            let t = t.split(['?', '#', '/']).next().unwrap_or("");
            if !t.is_empty() {
                return format!("{t} · {}", ws_field(w, "site"));
            }
        }
    }
    ws_field(w, "site").to_string()
}

fn ws_url(w: &serde_json::Value) -> String {
    let site = ws_field(w, "site");
    if ws_field(w, "kind") == "pos" {
        return ws_pos_url(ws_field(w, "posLink"))
            .map(|(u, _)| u)
            .unwrap_or_else(|| format!("https://{}", site));
    }
    if ws_field(w, "kind") == "portal" {
        let ps = ws_field(w, "portalSite");
        format!("https://{}/portal", if ps.is_empty() { site } else { ps })
    } else {
        format!("https://{}", site)
    }
}

fn ws_label(id: &str) -> String {
    let clean: String = id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
    format!("ws-{clean}")
}

#[tauri::command]
fn ws_list(app: tauri::AppHandle) -> Vec<serde_json::Value> {
    ws_read(&app)
}

#[tauri::command]
fn ws_save(app: tauri::AppHandle, list: Vec<serde_json::Value>) -> Result<(), String> {
    ws_write(&app, &list)?;
    // ✅ v0.5.13: siyahı dəyişən kimi tray menyusu yenilənir — əks halda yeni iş
    // sahəsi yalnız proqram yenidən açılandan sonra menyuda görünərdi.
    refresh_tray_menu(&app);
    Ok(())
}

#[tauri::command]
fn rail_set_width(app: tauri::AppHandle, width: f64) -> Result<(), String> {
    #[cfg(desktop)]
    {
        let w = width.clamp(RAIL_W, 320.0);
        RAIL_CUR.store(w as u32, std::sync::atomic::Ordering::Relaxed);
        layout_main(&app, w);
    }
    #[cfg(not(desktop))]
    let _ = (app, width);
    Ok(())
}

/// Rail «hansı sahə aktivdir» nöqtəsini göstərmək üçün content webview-inin hostu.
#[tauri::command]
fn ws_current(app: tauri::AppHandle) -> String {
    #[cfg(desktop)]
    {
        return app
            .get_webview("content")
            .and_then(|wv| wv.url().ok())
            .and_then(|u| u.host_str().map(|h| h.to_string()))
            .unwrap_or_default();
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        String::new()
    }
}

/// Eyni pəncərədə iş sahəsinə keçid (rail-dən): upsert + content naviqasiyası.
/// ⌘-klik ayrıca pəncərə istəyəndə rail `ws_open` çağırır (aşağıda).
#[tauri::command]
fn ws_activate(app: tauri::AppHandle, workspace: serde_json::Value) -> Result<(), String> {
    // v0.5.16 — POS HƏMİŞƏ öz pəncərəsində (öz sessiyası): eyni hostlu işçi panelinin cookie-sini əzməsin.
    // v0.5.17 — ana thread-dən kənarda (bax `ws_open`).
    if ws_field(&workspace, "kind") == "pos" {
        ws_open_detached(&app, workspace);
        return Ok(());
    }
    #[cfg(desktop)]
    {
        let w = ws_upsert(&app, workspace)?;
        let url: tauri::Url = ws_url(&w).parse().map_err(|e| format!("{e}"))?;
        let wv = app
            .get_webview("content")
            .ok_or_else(|| "content webview tapılmadı".to_string())?;
        wv.navigate(url).map_err(|e| e.to_string())?;
        if let Some(win) = app.get_window("main") {
            let _ = win.show();
            let _ = win.set_focus();
        }
        Ok(())
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, workspace);
        Err("yalnız masaüstü".into())
    }
}

#[tauri::command]
fn ws_show_launcher(app: tauri::AppHandle) -> Result<(), String> {
    // v0.5.15: «main» artıq multi-webview PƏNCƏRƏDİR — görünüş pəncərəyə,
    // naviqasiya isə «content» webview-inə gedir.
    if let Some(w) = app.get_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        // 🔴 v0.5.11: FOKUS TƏK BAŞINA BƏS ETMİR.
        //
        // v0.5.10-a qədər «main» pəncərəsi HƏMİŞƏ launcher idi, iş sahələri isə
        // ayrı pəncərələrdə açılırdı — ona görə sadəcə fokuslamaq kifayət edirdi.
        // v0.5.10-da keçid eyni pəncərədə olmağa başladı, yəni «main» artıq uzaq
        // ERP səhifəsini göstərə bilər. Nəticədə bu komanda İSTİFADƏÇİNİN ARTIQ
        // İÇİNDƏ OLDUĞU pəncərəni fokuslayırdı və «düymə heç nə etmir» görünürdü.
        //
        // Tray menyusundakı «İş sahələri» bəndi bunu onsuz da düzgün edirdi
        // (`w.navigate(home)`) — həmin məntiq buraya da gətirildi ki, iki yol
        // eyni davransın.
        #[cfg(target_os = "windows")]
        let home = "http://tauri.localhost/?setup=1";
        #[cfg(not(target_os = "windows"))]
        let home = "tauri://localhost/?setup=1";
        if let Ok(u) = home.parse() {
            if let Some(wv) = app.get_webview("content") {
                let _ = wv.navigate(u);
            }
        }
        Ok(())
    } else {
        Err("launcher pəncərəsi tapılmadı".into())
    }
}

/// İş sahəsini aç (varsa önə gətir). `workspace` TAM OBYEKT gəlir — fayla
/// upsert edilir, sonra açılır. Ona görə launcher-in async yazısını
/// gözləmək lazım gəlmir və fayl həmişə aktual qalır.
/// Doğrulama + fayla upsert (lastOpenedAt ilə). `ws_open` və `ws_activate`
/// üçün TƏK MƏNBƏ — iki yol ayrılsa siyahı davranışı da ayrılar.
fn ws_upsert(app: &tauri::AppHandle, workspace: serde_json::Value) -> Result<serde_json::Value, String> {
    let id = ws_field(&workspace, "id").to_string();
    if id.is_empty() {
        return Err("id boşdur".into());
    }
    for key in ["site", "portalSite"] {
        let h = ws_field(&workspace, key);
        if !h.is_empty() && !ws_valid_host(h) {
            return Err(format!("yanlış host: {h}"));
        }
    }
    if ws_field(&workspace, "site").is_empty() {
        return Err("site boşdur".into());
    }
    // v0.5.16 — POS: link etibarlı olmalı və host `site` ilə üst-üstə düşməlidir
    if ws_field(&workspace, "kind") == "pos" {
        match ws_pos_url(ws_field(&workspace, "posLink")) {
            Some((_, host)) if host == ws_field(&workspace, "site") => {}
            _ => return Err("POS linki yanlışdır".into()),
        }
    }

    let mut list = ws_read(app);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let mut w = workspace;
    if let Some(obj) = w.as_object_mut() {
        obj.insert("lastOpenedAt".into(), serde_json::json!(now));
    }
    if let Some(pos) = list.iter().position(|x| ws_field(x, "id") == id) {
        list[pos] = w.clone();
    } else {
        list.push(w.clone());
    }
    let _ = ws_write(app, &list);
    Ok(w)
}

/// 🔴 v0.5.17 — ASİNXRON əmr. Sinxron əmrlər ana thread-də işləyir; Windows-da pəncərəni ana
/// thread-dən (əmrin içindən) yaratmaq Tauri sənədlərində tövsiyə olunmur (wry#583 — WebView2
/// mühiti ana thread-in mesaj dövrəsini gözləyir). 0.5.16-da Windows-da POS pəncərəsi AĞ qaldı və
/// serverə heç bir sorğu getmədi. Gövdə `ws_open_impl`-dədir — tray və `ws_activate` onu
/// `async_runtime::spawn` ilə çağırır (onlar da ana thread-dədir).
#[tauri::command]
async fn ws_open(app: tauri::AppHandle, workspace: serde_json::Value) -> Result<(), String> {
    ws_open_impl(&app, workspace)
}

/// POS-u ana thread-dən KƏNARDA aç (tray / `ws_activate` ana thread-dədir).
fn ws_open_detached(app: &tauri::AppHandle, workspace: serde_json::Value) {
    let h = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = ws_open_impl(&h, workspace) {
            log::warn!("iş sahəsi pəncərəsi açılmadı: {e}");
        }
    });
}

fn ws_open_impl(app: &tauri::AppHandle, workspace: serde_json::Value) -> Result<(), String> {
    let app = app.clone();
    let w = ws_upsert(&app, workspace)?;
    let id = ws_field(&w, "id").to_string();

    let label = ws_label(&id);
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.show();
        let _ = existing.unminimize();
        let _ = existing.set_focus();
        return Ok(());
    }

    let url: tauri::Url = ws_url(&w).parse().map_err(|e| format!("{e}"))?;
    let title = format!("{} — {}", ws_display_name(&w), ws_kind_label(&w));

    /* 🔴 v0.5.11 — WINDOWS AĞ EKRAN DÜZƏLİŞİ.
       Əvvəl `data_directory(PathBuf::from(&label))` yazılırdı, yəni NİSBİ yol
       («ws-abc»). WebView2 istifadəçi-data qovluğunu MÜTLƏQ yol kimi gözləyir;
       nisbi yol prosesin cari qovluğuna görə həll olunur və quraşdırılmış app
       üçün bu, yazma icazəsi olmayan qovluq olur → WebView2 başlaya bilmir.
       Pəncərə YARANIR (ona görə aşağıdakı fallback işə düşmür), məzmun isə
       yüklənmir: istifadəçi DONMUŞ AĞ pəncərə görür.
       İndi app-ın öz yerli data qovluğunun altında mütləq yol qurulur. */
    #[cfg(not(target_os = "macos"))]
    let data_dir: Option<std::path::PathBuf> = app
        .path()
        .app_local_data_dir()
        .ok()
        .map(|d| d.join("webviews").join(&label))
        .inspect(|d| { let _ = std::fs::create_dir_all(d); });

    let build = |isolated: bool| -> tauri::Result<tauri::WebviewWindow> {
        // 🔴 v0.5.20 (ERP 54.163): Tauri-nin drag-drop handler-i OS-dan sürüşdürülən faylı ÖZÜ tutur və səhifəyə
        // HTML5 `drop` (fayllı) ÖTÜRMÜR — ERP söhbətinə fayl sürüşdürüb atma tətbiqdə işləmirdi (brauzerdə işləyir).
        // Tətbiq drag-drop hadisəsindən istifadə etmir → söndürmək təhlükəsizdir.
        let mut b = tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::External(url.clone()))
            .title(&title)
            .inner_size(1440.0, 900.0)
            .min_inner_size(1024.0, 700.0)
            .center()
            .disable_drag_drop_handler();
        if isolated {
            #[cfg(target_os = "macos")]
            {
                b = b.data_store_identifier(ws_session_bytes(&id));
            }
            #[cfg(not(target_os = "macos"))]
            {
                // Mütləq yol alınmasa izolyasiyasız davam edirik — donmuş ağ
                // pəncərə göstərməkdənsə ümumi sessiya ilə İŞLƏYƏN pəncərə yaxşıdır.
                if let Some(d) = data_dir.as_ref() {
                    b = b.data_directory(d.clone());
                }
            }
        }
        b.build()
    };

    // Əvvəl izolyasiya ilə, alınmasa onsuz (JS tərəfdəki qayda ilə eyni)
    match build(true) {
        Ok(_) => Ok(()),
        Err(_) => build(false).map(|_| ()).map_err(|e| e.to_string()),
    }
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

    // (v0.5.15: səhifəyə JS yeridilməsi LƏĞV EDİLDİ — panel ayrıca native
    //  webview-dədir, bax RAIL bölməsi. on_page_load qarmağı silindi.)


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
                // ✅ v0.5.15 — MAIN PƏNCƏRƏSİ KODDAN QURULUR (multi-webview):
                // konfiqdəki windows[] boşdur; «content» (launcher/ERP) + «rail»
                // (iş sahələri paneli) native olaraq yan-yana yerləşir. Panel
                // məzmunun üstünə düşə bilməz — bu, 45.95→v0.5.14 iterasiyalarının
                // kök həllidir (istifadəçi: «tauri-nin daxilində olsun»).
                {
                    use tauri::webview::WebviewBuilder;
                    use tauri::{LogicalPosition, LogicalSize, WebviewUrl};

                    let win = tauri::window::WindowBuilder::new(app, "main")
                        .title("Olko ERP")
                        .inner_size(1440.0, 900.0)
                        .min_inner_size(1024.0, 700.0)
                        .center()
                        .build()?;
                    let scale = win.scale_factor().unwrap_or(1.0);
                    let size = win.inner_size()?;
                    let w = size.width as f64 / scale;
                    let h = size.height as f64 / scale;
                    // v0.5.20: ERP bu webview-də açılır → HTML5 fayl drop-u səhifəyə çatsın (yuxarıdakı qeydə bax)
                    win.add_child(
                        WebviewBuilder::new("content", WebviewUrl::App("index.html".into())).disable_drag_drop_handler(),
                        LogicalPosition::new(0.0, 0.0),
                        LogicalSize::new((w - RAIL_W).max(200.0), h),
                    )?;
                    // rail SONRA əlavə olunur → native qatda üstdədir (hover genişlənməsi)
                    win.add_child(
                        WebviewBuilder::new("rail", WebviewUrl::App("rail.html".into())),
                        LogicalPosition::new(w - RAIL_W, 0.0),
                        LogicalSize::new(RAIL_W, h),
                    )?;

                    let wh = app.handle().clone();
                    let wv = win.clone();
                    win.on_window_event(move |event| {
                        if matches!(event, tauri::WindowEvent::Resized(_)) {
                            let rw = RAIL_CUR.load(std::sync::atomic::Ordering::Relaxed) as f64;
                            layout_main(&wh, rw);
                        }
                        // macOS: qırmızı X GİZLƏDİR (Dock-da qalır) — köhnə davranış qorunur
                        #[cfg(target_os = "macos")]
                        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                            api.prevent_close();
                            let _ = wv.hide();
                        }
                        #[cfg(not(target_os = "macos"))]
                        let _ = &wv;
                    });
                }

                // ✅ Tray menyusu: app-daxili header götürüldüyü üçün sayt dəyişmə/çıxış
                // əməliyyatları buradan əlçatandır (sağ klik → menyu).
                {
                    // ✅ v0.5.13: menyu İŞ SAHƏLƏRİ ilə birlikdə qurulur (bax
                    // `build_tray_menu`). Siyahı dəyişəndə `ws_save` onu yeniləyir.
                    let menu = build_tray_menu(&app.handle().clone())?;
                    if let Some(tray) = app.tray_by_id("main-tray") {
                        let _ = tray.set_menu(Some(menu));
                        let h = app.handle().clone();
                        tray.on_menu_event(move |_tray, event| {
                          let raw = event.id().as_ref().to_string();
                          // 🔴 İş sahəsi bəndləri `ws:<id>` prefiksi ilə gəlir — sabit
                          // `match` qollarından ƏVVƏL yoxlanır.
                          if let Some(ws_id) = raw.strip_prefix("ws:") {
                              if let Some(w) = ws_read(&h).into_iter().find(|x| ws_field(x, "id") == ws_id) {
                                  // v0.5.16 — POS öz pəncərəsində açılır (naviqasiya yox)
                                  if ws_field(&w, "kind") == "pos" {
                                      ws_open_detached(&h, w);
                                      return;
                                  }
                                  if let Ok(url) = ws_url(&w).parse::<tauri::Url>() {
                                      // Eyni pəncərədə davam (v0.5.10 qərarı):
                                      // fokusdakı, yoxdursa `main`.
                                      // v0.5.15: «main» WebviewWindow deyil — pəncərələr
                                      // üzərində gəzib naviqasiyanı müvafiq WEBVIEW-ə veririk.
                                      let target = h
                                          .windows()
                                          .into_values()
                                          .find(|x| x.is_focused().unwrap_or(false))
                                          .or_else(|| h.get_window("main"));
                                      if let Some(win) = target {
                                          let _ = win.show();
                                          let _ = win.unminimize();
                                          let _ = win.set_focus();
                                          match content_webview_of(&h, win.label()) {
                                              Some(wv) => {
                                                  if let Err(e) = wv.navigate(url) {
                                                      log::warn!("iş sahəsinə keçid alınmadı [{ws_id}]: {e}");
                                                  }
                                              }
                                              None => log::warn!("webview tapılmadı [{}]", win.label()),
                                          }
                                      }
                                  }
                              }
                              return;
                          }
                          match raw.as_str() {
                            "clear_cache" => {
                                // 🔴 YALNIZ FOKUSDAKİ pəncərə (audit tapıntısı, blocker).
                                // Əvvəl BÜTÜN pəncərələrə tətbiq olunurdu. Bu qabıqda
                                // `beforeunload` dialoqu GÖSTƏRİLMİR (wry WKUIDelegate-də
                                // müvafiq metod yoxdur), yəni fon pəncərəsindəki
                                // saxlanmamış iş XƏBƏRDARLIQSIZ itərdi — məsələn POS
                                // səbəti hələ React state-də ola bilər.
                                // Fokusda pəncərə yoxdursa (tray-ə arxa fondan basılıb)
                                // `main`-ə düşürük.
                                let target = h
                                    .windows()
                                    .into_values()
                                    .find(|w| w.is_focused().unwrap_or(false))
                                    .or_else(|| h.get_window("main"));
                                if let Some(w) = target {
                                    if let Some(wv) = content_webview_of(&h, w.label()) {
                                        if let Err(e) = wv.eval(CLEAR_CACHE_JS) {
                                            log::warn!("clear_cache eval xətası [{}]: {e}", w.label());
                                        }
                                    }
                                    let _ = w.show();
                                    let _ = w.set_focus();
                                }
                            }
                            "reset_site" => {
                                if let Some(w) = h.get_window("main") {
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
                                        if let Some(wv) = h.get_webview("content") {
                                            let _ = wv.navigate(u);
                                        }
                                    }
                                }
                            }
                            "quit_app" => h.exit(0),
                            _ => {}
                          }
                        });
                    }
                }

                let handle = app.handle().clone();
                if let Some(tray) = app.tray_by_id("main-tray") {
                    tray.on_tray_icon_event(move |_tray, event| {
                        if let TrayIconEvent::Click { .. } = event {
                            if let Some(window) = handle.get_window("main") {
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

            #[cfg(mobile)]
            {
                // Konfiqdəki windows[] boşdur (desktop multi-webview üçün) —
                // mobil pəncərə burada adi tək-webview kimi qurulur.
                tauri::WebviewWindowBuilder::new(
                    app,
                    "main",
                    tauri::WebviewUrl::App("index.html".into()),
                )
                .build()?;
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_external,
            native_ping,
            native_test,
            native_print,
            native_list_printers,
            native_print_usb,
            ws_list,
            ws_save,
            ws_open,
            ws_show_launcher,
            ws_activate,
            ws_current,
            rail_set_width
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            // ✅ macOS: Dock ikonuna klik (Reopen) — X ilə gizlədilmiş pəncərəni geri gətir.
            // Bu olmasa X-dən sonra Dock ikonu işə yaramır (pəncərə bir daha açılmır).
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                if let Some(w) = _app.get_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        });
}

#[cfg(test)]
mod pos_link_tests {
    //! v0.5.16 — `ws_pos_url` JS `parsePosLink` ilə EYNİ qərarı verməlidir (iki qayda olmasın).
    use super::{ws_display_name, ws_kind_label, ws_pos_url};

    #[test]
    fn accepts_terminal_links_and_forces_native_print() {
        let (u, h) = ws_pos_url("https://moonmobile.olkoerp.com/pos/POS-00003?token=abc123").unwrap();
        assert_eq!(u, "https://moonmobile.olkoerp.com/pos/POS-00003?token=abc123&olko_native_print=1");
        assert_eq!(h, "moonmobile.olkoerp.com");
        let (u, _) = ws_pos_url("moonmobile.olkoerp.com/pos/POS-00003?token=abc").unwrap();
        assert!(u.starts_with("https://moonmobile.olkoerp.com/pos/POS-00003?token=abc"));
        let (u, _) = ws_pos_url("http://qurman.olkoerp.com/pos/POS-00001?token=t&olko_native_print=0").unwrap();
        assert_eq!(u, "https://qurman.olkoerp.com/pos/POS-00001?token=t&olko_native_print=1");
        assert!(ws_pos_url("https://control.admedia.az/pos/POS-00001/?token=z").is_some());
    }

    #[test]
    fn rejects_unsafe_or_foreign_links() {
        for bad in [
            "https://x@olkoerp.com/pos/POS-1?token=t",   // istifadəçi adı hissəsi hostu gizlədir
            "https://olkoerp.com/pos/POS-1?token=t",     // master sayt
            "https://a.olkoerp.com/app/pos/POS-1",       // yol /pos/ ilə başlamır
            "https://a.olkoerp.com:8443/pos/POS-1",      // port
            "https://a.olkoerp.com/pos/",                // terminal yoxdur
            "https://a.olkoerp.com/pos/A/B",             // artıq seqment
            "javascript:alert(1)",
            "",
        ] {
            assert!(ws_pos_url(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn labels_never_show_token() {
        let w = serde_json::json!({"kind": "pos", "site": "moonmobile.olkoerp.com",
            "posLink": "https://moonmobile.olkoerp.com/pos/POS-00003?token=SECRET"});
        let name = ws_display_name(&w);
        assert_eq!(name, "POS-00003 · moonmobile.olkoerp.com");
        assert!(!name.contains("SECRET"));
        assert_eq!(ws_kind_label(&w), "POS");
    }
}

#[cfg(test)]
mod usb_print_tests {
    //! v0.5.18 — printer adı yalnız sistem siyahısından (uzaq səhifə sərbəst sətirlə başqa növbəyə yazdırmasın).
    use super::usb_printer_allowed;

    #[test]
    fn only_exact_names_from_system_list() {
        let list = vec!["ZY307".to_string(), "Microsoft Print to PDF".to_string()];
        assert!(usb_printer_allowed("ZY307", &list));
        assert!(usb_printer_allowed("Microsoft Print to PDF", &list));
        assert!(!usb_printer_allowed("zy307", &list), "dəqiq uyğunluq");
        assert!(!usb_printer_allowed("", &list));
        assert!(!usb_printer_allowed("\\\\server\\share", &list));
        assert!(!usb_printer_allowed("ZY307", &[]));
    }
}
