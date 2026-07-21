fn main() {
    // ✅ 2026-07-21: App komandalarını ACL-ə qeyd et ki, remote ERP səhifəsi (capability
    // remote.urls) onları çağıra bilsin. Hər komanda üçün `allow-<command>` icazəsi
    // yaranır; capabilities/default.json onları verir. Olmasa: "not allowed by ACL".
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new()
                .commands(&["open_external", "native_ping", "native_test", "native_print"]),
        ),
    )
    .expect("failed to run tauri-build");
}
