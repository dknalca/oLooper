//! Manual audible check (dev only, never CI).
//!
//! Usage: `cargo run --example play_check -- <file> [seconds]`
//! Loads, plays, polls status, then stops. Requires an audio device.

fn main() {
    let path = std::env::args().nth(1).expect("usage: play_check <file> [secs]");
    let secs: u64 = std::env::args()
        .nth(2)
        .and_then(|s| s.parse().ok())
        .unwrap_or(3);
    let client = olooper::player::spawn();
    let st = client.load(path).expect("load failed");
    println!(
        "loaded: duration={}ms loop=[{}..{}]",
        st.duration_ms, st.loop_start_ms, st.loop_end_ms
    );
    let st = client.play().expect("play failed");
    assert!(st.playing);
    for _ in 0..secs * 4 {
        std::thread::sleep(std::time::Duration::from_millis(250));
        let s = client.status().expect("status failed");
        println!("  pos={}ms playing={}", s.position_ms, s.playing);
        assert!(s.playing);
    }
    let st = client.stop().expect("stop failed");
    assert!(!st.playing && st.position_ms == st.loop_start_ms);
    // Loop wrap: 1 s region played for 2.5 s must stay inside it.
    client.set_loop(0, 1000).expect("set_loop failed");
    client.play().expect("play failed");
    let mut wrapped = false;
    let mut prev = 0u64;
    for _ in 0..10 {
        std::thread::sleep(std::time::Duration::from_millis(250));
        let s = client.status().expect("status failed");
        assert!(s.position_ms < 1000, "escaped loop: {}", s.position_ms);
        if s.position_ms < prev {
            wrapped = true; // position decreased => wrapped around
        }
        prev = s.position_ms;
    }
    assert!(wrapped, "never observed loop wrap");
    client.stop().expect("stop failed");
    println!("play_check OK (incl. loop wrap)");
}
