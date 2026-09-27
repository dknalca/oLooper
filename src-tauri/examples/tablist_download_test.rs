//! Standalone Tablist downloader probe (no oLooper frontend bundle required).
//!
//! Run from `src-tauri/`:
//!   cargo run --example tablist_download_test -- \
//!     https://tablist.net/looper/sonny-kraft-friendly-melodies \
//!     https://tablist.net/looper/molotov-everyday-samurai-2 \
//!     https://tablist.net/looper/kurtz-bangz-skilzbeat-vol-1
//!
//! Downloads and decodes the tracks to `../.dev/tablist-downloads/`, printing
//! each URL, byte count, and decoded audio duration without building the app.

use std::path::{Path, PathBuf};
use tauri::Manager as _;

const EXAMPLE_URLS: &[&str] = &[
    "https://tablist.net/looper/sonny-kraft-friendly-melodies",
    "https://tablist.net/looper/molotov-everyday-samurai-2",
    "https://tablist.net/looper/kurtz-bangz-skilzbeat-vol-1",
];

fn output_directory() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri has repository parent")
        .join(".dev/tablist-downloads")
}

fn save_track(
    folder: &Path,
    title: &str,
    extension: &str,
    bytes: &[u8],
) -> Result<PathBuf, String> {
    let safe = olooper::library::sanitize_name(title);
    let mut path = folder.join(format!("{safe}.{extension}"));
    let mut suffix = 2;
    while path.exists() {
        path = folder.join(format!("{safe} ({suffix}).{extension}"));
        suffix += 1;
    }
    let tmp = path.with_extension(format!("{extension}.tmp"));
    std::fs::write(&tmp, bytes).map_err(|error| format!("write failed: {error}"))?;
    std::fs::rename(&tmp, &path).map_err(|error| format!("rename failed: {error}"))?;
    Ok(path)
}

fn run_probe(app: tauri::AppHandle, urls: Vec<String>) {
    let output = output_directory();
    if let Err(error) = std::fs::create_dir_all(&output) {
        eprintln!("Cannot create {}: {error}", output.display());
        app.exit(1);
        return;
    }
    let mut total = 0usize;
    let mut downloaded = 0usize;
    let mut decoded = 0usize;
    let mut decode_failures = 0usize;
    let mut failed = 0usize;
    for page_url in urls {
        println!("\nLooper: {page_url}");
        let page = match olooper::tablist::resolve_page(&page_url, &app) {
            Ok(page) => page,
            Err(error) => {
                eprintln!("  LOOKUP FAILED: {error}");
                failed += 1;
                continue;
            }
        };
        println!("  {} — {} tracks", page.title, page.tracks.len());
        let folder = output.join(olooper::library::sanitize_name(&page.title));
        if let Err(error) = std::fs::create_dir_all(&folder) {
            eprintln!("  Cannot create {}: {error}", folder.display());
            failed += page.tracks.len();
            continue;
        }
        for (index, track) in page.tracks.iter().enumerate() {
            total += 1;
            let audio_url = if track.path.starts_with("https://") {
                track.path.clone()
            } else {
                format!(
                    "https://files.tablist.net/{}",
                    track.path.trim_start_matches('/')
                )
            };
            println!(
                "  [{}/{}] {} — {} — ",
                index + 1,
                page.tracks.len(),
                track.title,
                audio_url
            );
            match olooper::tablist::download_track(track, &page_url) {
                Ok(bytes) => match save_track(&folder, &track.title, &track.extension, &bytes) {
                    Ok(path) => {
                        downloaded += 1;
                        match olooper::player::decode_bytes(&bytes) {
                            Ok(audio) => {
                                decoded += 1;
                                println!(
                                    "DOWNLOAD + DECODE OK: {} bytes, {} Hz, {} ms -> {}",
                                    bytes.len(),
                                    audio.rate,
                                    audio.duration_ms(),
                                    path.display()
                                );
                            }
                            Err(error) => {
                                decode_failures += 1;
                                println!(
                                    "DOWNLOADED ({} bytes), DECODE FAILED: {error} -> {}",
                                    bytes.len(),
                                    path.display()
                                );
                            }
                        }
                    }
                    Err(error) => {
                        eprintln!("SAVE FAILED: {error}");
                        failed += 1;
                    }
                },
                Err(error) => {
                    eprintln!("DOWNLOAD FAILED: {error}");
                    failed += 1;
                }
            }
        }
    }
    println!(
        "\nProbe summary: {total} tracks; {downloaded} downloaded; {decoded} decodable; {decode_failures} decode failures; {failed} download/save failures"
    );
    println!("Downloaded files: {}", output.display());
    app.exit(if failed == 0 && decode_failures == 0 {
        0
    } else {
        1
    });
}

fn main() {
    let urls: Vec<String> = std::env::args().skip(1).collect();
    let urls = if urls.is_empty() {
        EXAMPLE_URLS.iter().map(|url| (*url).to_string()).collect()
    } else {
        urls
    };
    tauri::Builder::default()
        .setup(move |app| {
            if let Some(main_window) = app.get_webview_window("main") {
                let _ = main_window.hide();
            }
            let handle = app.handle().clone();
            std::thread::spawn(move || run_probe(handle, urls));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Tablist probe runtime failed");
}
