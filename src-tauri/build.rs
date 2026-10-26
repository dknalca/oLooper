fn main() {
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=windows-manifest.rc");
    println!("cargo:rerun-if-changed=windows-app.manifest");
    let attributes = tauri_build::Attributes::new()
        .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    tauri_build::try_build(attributes).expect("Tauri build setup failed");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        // Tauri's normal resources link only to application binaries. IPC unit
        // tests also link Common Controls APIs and need the v6 manifest before
        // the Windows loader starts the test harness.
        embed_resource::compile_for_everything("windows-manifest.rc", embed_resource::NONE)
            .manifest_required()
            .expect("Cannot embed Windows Common Controls manifest");
    }
}
