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
        let name = {
            let l = ws_field(w, "label");
            if l.is_empty() { ws_field(w, "site") } else { l }
        };
        let kind = if ws_field(w, "kind") == "portal" { "Müştəri" } else { "İstifadəçi" };
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

fn ws_url(w: &serde_json::Value) -> String {
    let site = ws_field(w, "site");
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
fn ws_show_launcher(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main") {
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
            let _ = w.navigate(u);
        }
        Ok(())
    } else {
        Err("launcher pəncərəsi tapılmadı".into())
    }
}

/// İş sahəsini aç (varsa önə gətir). `workspace` TAM OBYEKT gəlir — fayla
/// upsert edilir, sonra açılır. Ona görə launcher-in async yazısını
/// gözləmək lazım gəlmir və fayl həmişə aktual qalır.
#[tauri::command]
fn ws_open(app: tauri::AppHandle, workspace: serde_json::Value) -> Result<(), String> {
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

    // Upsert + lastOpenedAt
    let mut list = ws_read(&app);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let mut w = workspace.clone();
    if let Some(obj) = w.as_object_mut() {
        obj.insert("lastOpenedAt".into(), serde_json::json!(now));
    }
    if let Some(pos) = list.iter().position(|x| ws_field(x, "id") == id) {
        list[pos] = w.clone();
    } else {
        list.push(w.clone());
    }
    let _ = ws_write(&app, &list);

    let label = ws_label(&id);
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.show();
        let _ = existing.unminimize();
        let _ = existing.set_focus();
        return Ok(());
    }

    let url: tauri::Url = ws_url(&w).parse().map_err(|e| format!("{e}"))?;
    let title = format!(
        "{} — {}",
        {
            let l = ws_field(&w, "label");
            if l.is_empty() { ws_field(&w, "site") } else { l }.to_string()
        },
        if ws_field(&w, "kind") == "portal" { "Müştəri" } else { "İstifadəçi" }
    );

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
        let mut b = tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::External(url.clone()))
            .title(&title)
            .inner_size(1440.0, 900.0)
            .min_inner_size(1024.0, 700.0)
            .center();
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
                                  if let Ok(url) = ws_url(&w).parse::<tauri::Url>() {
                                      // Eyni pəncərədə davam (v0.5.10 qərarı):
                                      // fokusdakı, yoxdursa `main`.
                                      let target = h
                                          .webview_windows()
                                          .into_values()
                                          .find(|x| x.is_focused().unwrap_or(false))
                                          .or_else(|| h.get_webview_window("main"));
                                      if let Some(win) = target {
                                          let _ = win.show();
                                          let _ = win.unminimize();
                                          let _ = win.set_focus();
                                          if let Err(e) = win.navigate(url) {
                                              log::warn!("iş sahəsinə keçid alınmadı [{ws_id}]: {e}");
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
                                    .webview_windows()
                                    .into_values()
                                    .find(|w| w.is_focused().unwrap_or(false))
                                    .or_else(|| h.get_webview_window("main"));
                                if let Some(w) = target {
                                    if let Err(e) = w.eval(CLEAR_CACHE_JS) {
                                        log::warn!("clear_cache eval xətası [{}]: {e}", w.label());
                                    }
                                    let _ = w.show();
                                    let _ = w.set_focus();
                                }
                            }
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
                          }
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
            native_print,
            ws_list,
            ws_save,
            ws_open,
            ws_show_launcher
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
