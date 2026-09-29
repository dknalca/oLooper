# oLooper

A desktop app for DJs and turntablists to extract and practice with audio loops from legacy Flash `.swf` and projector `.exe` files.

## Features

- **SWF extraction** — drop a `.swf`, get all embedded MP3 and ADPCM loops as practice tracks
- **EXE projector extraction** — drop a projector `.exe`, locate the embedded SWF, same pipeline
- **Faster SWF/EXE imports** — decode and analyze up to four extracted tracks in parallel
- **Cover art** — extract embedded JPEG artwork from SWF/EXE or use Tablist looper artwork
- **Custom audio import** — drop or browse supported audio files, instantly playable
- **Tablist online catalog** — browse/search public loopers, import all tracks, or download a random looper
- **Persistent library** — SQLite catalog (schema v6) survives restarts, deduplicates on import
- **Practice player** — play/pause/stop, previous/next loop, gapless looping, volume, seek
- **Practice timer** — hours/minutes/seconds counted during playback, with reset
- **Timed random practice** — play a random local-library loop every 2 min, 5 min, or custom interval
- **Speed control** — 50–200% playback speed in 5% steps; each new track starts at 100%
- **BPM detection** — automatic energy-flux onset analysis, normalized to 65–150 BPM; manual BPM overrides are preserved
- **Waveform display** — current loop name, scrolling waveform, loop overlay, click-to-seek, and persistent disk cache
- **CUE 1–4** — cue 1 is track start; cues 2–4 are saved per track
- **Two-pane library** — select a looper or **Favoritos** on the left and browse its loops on the right
- **Favorites** — mark loops for the cross-library Favoritos view
- **Keyboard shortcuts** — Space, S, arrows, L, cues 1–4, Shift+2–4 to clear, +/−, Cmd+O; Help menu lists them
- **Library management** — search and filter loops; alphabetical order by default, clickable BPM sort, export, and context menus
- **Looper groups** — rename folders; removing a track/group deletes its library audio copy and cover while preserving original source files
- **Import progress** — per-file stage, elapsed time, and cancellation
- **Native file dialogs** — OS-native file pickers for import and library setup
- **Native app menus** — File import and library actions, standard Edit commands, and macOS window controls
- **Dark UI** — Tailwind CSS v4, two-pane library, context menus, track stats
- **App icon** — shared by the app bundle and in-app header
- **macOS release** — build script produces `.app`; optional DMG packaging via `package-dmg.sh`

## Requirements

- macOS 12+ (primary target; architecture is cross-platform)
- Rust 1.87+
- Node.js 22+
- pnpm 9+

## Build from source

```bash
# Install dependencies
pnpm install

# Development mode (hot-reload)
pnpm tauri dev

# Production build (generates icons + .app)
./scripts/build.sh           # release, copies .app to project root
./scripts/build.sh --dev     # debug (faster, with logs)

# Optional: package as DMG
./scripts/package-dmg.sh     # produces dist/oLooper-<version>-unsigned.dmg
```

The built `.app` bundle will be at `./oLooper.app` in the project root.

## Testing

```bash
# Rust unit tests (parser, player, library, waveform, analysis)
cargo test --manifest-path src-tauri/Cargo.toml

# Inspect SWF/EXE extraction and optionally dump audio + cover files
cargo run --manifest-path src-tauri/Cargo.toml --example inventory -- --dump /path/to/output path/to/looper.swf

# Probe Tablist downloads without building the desktop app
cargo run --manifest-path src-tauri/Cargo.toml --example tablist_download_test -- <Tablist URL...>
# Files are saved to .dev/tablist-downloads/

# Frontend tests (Vitest)
pnpm test

# Typecheck
pnpm run typecheck
```

Real SWF/EXE fixtures in `loopersFlash/` (gitignored) are used for manual validation via `#[ignore]` tests.

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `Space` | Play / Pause toggle |
| `S` | Stop (return to loop start) |
| `←` `→` | Seek ±5 seconds |
| `L` | Toggle loop on/off |
| `+` `-` | Change playback speed (5% steps, 50–200%) |
| `Cmd+O` | Open file picker for import |

Shortcuts are disabled while typing in text fields.

## Architecture

```
src/                     Frontend (React + TypeScript + Tailwind)
├── App.tsx              Root layout (player, library, Tablist catalog)
├── main.tsx             Entry point (CSS import)
├── index.css            Tailwind + design tokens
├── tauri.ts             Typed Tauri command bridge + dialog wrappers
├── importFlow.ts        Import routing helpers
├── hooks/               React hooks
│   └── useKeyboardShortcuts.ts
└── components/          UI components
    ├── TopBar.tsx       Header with version + practice timer + library setup
    ├── Sidebar.tsx      Two-pane local library: loopers, favorites, tracks
    ├── TablistCatalog.tsx Online looper search, pagination + import
    ├── Player.tsx       Transport + previous/next + speed + CUE 1–4
    ├── Waveform.tsx     Track title + canvas waveform + playhead/loop overlay
    ├── ImportBar.tsx    File import with browse buttons + drag-drop + inline progress
    └── Logo.tsx         Waveform loop "O" logo component

src-tauri/               Backend (Rust)
├── src/lib.rs           Tauri commands + app builder + portable storage
├── src/player/mod.rs    Audio engine (rodio, region loop, speed, pitch lock)
├── src/library/mod.rs   SQLite catalog (schema v6) + file management + loop slots + covers
├── src/import/          SWF/EXE parsers (MP3 + ADPCM + SoundStreamBlock)
├── src/tablist.rs       Tablist catalog, App Check, and audio/cover downloads
├── src/waveform.rs      Peak computation + persistent disk cache
└── src/analysis.rs      BPM estimator (energy-flux autocorrelation)

scripts/                 Build & utility scripts
├── build.sh             Generate icons + build .app bundle (release or debug)
├── generate-icons.mjs   SVG → PNG + icns icon generation
└── package-dmg.sh       Package .app as unsigned DMG

specs/                   Feature specifications
├── 000-product-foundation.md
├── 010-library.md
├── 020-swf-extraction.md
├── 025-exe-extraction.md
├── 030-player.md
├── 035-loop-fidelity.md
├── 040-waveform.md
├── 050-custom-loops.md
├── 060-keyboard-shortcuts.md
├── 060-reliability-hardening.md
├── 070-loop-slots.md
├── 080-portable-drop-import.md
├── 090-library-workflow-completion.md
├── 095-background-import.md
└── 100-tablist-import.md

docs/                    Documentation
├── adr/                 Architecture decision records (0001–0010)
└── macos-release.md     macOS signing and notarization guide
```

## License

Private — xFlare project.
