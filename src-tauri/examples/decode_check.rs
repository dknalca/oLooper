//! Manual decode smoke test (dev only, never CI).
//!
//! Usage: `cargo run --example decode_check -- <dir-with-mp3> [...]`
//! Decodes each `.mp3` fully via rodio and prints channels/rate/samples.
//! Proves extractor output is actually playable ahead of the player phase.

use rodio::Source as _;
use std::path::PathBuf;

fn main() {
    let dirs: Vec<PathBuf> = std::env::args().skip(1).map(PathBuf::from).collect();
    if dirs.is_empty() {
        eprintln!("usage: decode_check <dir> [...]");
        std::process::exit(2);
    }
    let mut ok = 0;
    let mut fail = 0;
    for dir in &dirs {
        let mut entries: Vec<PathBuf> = std::fs::read_dir(dir)
            .expect("cannot list dir")
            .filter_map(|e| e.ok().map(|x| x.path()))
            .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("mp3"))
            .collect();
        entries.sort();
        for path in entries {
            let file = std::fs::File::open(&path).expect("cannot open dump");
            match rodio::Decoder::new(std::io::BufReader::new(file)) {
                Ok(src) => {
                    let (ch, rate) = (src.channels(), src.sample_rate());
                    let n: u64 = src.count() as u64;
                    println!(
                        "{}: ch={} rate={} samples={} ({:.1}s)",
                        path.file_name().unwrap().to_str().unwrap(),
                        ch,
                        rate,
                        n,
                        n as f64 / (ch as f64 * rate as f64)
                    );
                    ok += 1;
                }
                Err(e) => {
                    println!("FAIL {}: {e}", path.display());
                    fail += 1;
                }
            }
        }
    }
    println!("decoded ok: {ok}, failed: {fail}");
    if fail > 0 {
        std::process::exit(1);
    }
}
