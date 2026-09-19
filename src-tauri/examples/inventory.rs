//! Manual validation helper (dev only, never CI).
//!
//! Usage: `cargo run --example inventory -- [--dump DIR] <file.swf|file.exe> [...]`
//! Prints sounds detected / extracted / skipped per file. Reads real user
//! samples such as `loopersFlash/*` without modifying them.

use std::path::PathBuf;

fn report_swf(data: &[u8], dump: Option<&std::path::Path>) {
    match olooper::import::swf::parse(data) {
        Ok(s) => {
            println!("  SWF v{}: {} extracted, {} skipped", s.version, s.sounds.len(), s.skipped.len());
            for (i, x) in s.sounds.iter().enumerate() {
                println!(
                    "    id={} fmt={} samples={} bytes={}",
                    x.id,
                    x.format,
                    x.sample_count,
                    x.frames.len()
                );
                if let Some(dir) = dump {
                    let name = format!("{:02}_{}.mp3", i + 1, x.id);
                    std::fs::write(dir.join(name), &x.frames).expect("dump write failed");
                }
            }
            for x in &s.skipped {
                println!("    SKIP id={} fmt={} ({})", x.id, x.format, x.reason);
            }
        }
        Err(e) => println!("  SWF error: {}", olooper::import::swf::user_message(&e)),
    }
}

fn main() {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    let mut dump: Option<PathBuf> = None;
    let mut files: Vec<PathBuf> = Vec::new();
    let mut it = raw.into_iter();
    while let Some(a) = it.next() {
        if a == "--dump" {
            let dir = PathBuf::from(it.next().expect("--dump needs DIR"));
            std::fs::create_dir_all(&dir).expect("cannot create dump dir");
            dump = Some(dir);
        } else {
            files.push(PathBuf::from(a));
        }
    }
    if files.is_empty() {
        eprintln!("usage: inventory [--dump DIR] <file.swf|file.exe> [...]");
        std::process::exit(2);
    }
    for path in &files {
        let data = std::fs::read(path).expect("cannot read file");
        println!("{} ({} bytes)", path.display(), data.len());
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        if ext == "exe" {
            match olooper::import::exe::locate(&data) {
                Ok(f) => {
                    println!("  embedded SWF at offset {} len {}", f.offset, f.length);
                    report_swf(&data[f.offset..f.offset + f.length], dump.as_deref());
                }
                Err(e) => println!("  EXE: {}", olooper::import::exe::user_message(&e)),
            }
        } else {
            report_swf(&data, dump.as_deref());
        }
    }
}
