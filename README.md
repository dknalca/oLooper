# oLooper

A desktop app for DJs and turntablists to extract and practice with audio loops from legacy Flash `.swf` and projector `.exe` files.

## Features

- **SWF extraction** — drop a `.swf`, get all embedded MP3 and ADPCM loops as practice tracks
- **EXE projector extraction** — drop a projector `.exe`, locate the embedded SWF, same pipeline
- **Custom audio import** — WAV/MP3 drop or browse, instantly playable
- **Persistent library** — SQLite catalog (schema v6) survives restarts, deduplicates on import
- **Practice player** — play/pause/stop, gapless region looping, volume, seek
- **Speed control** — 50–200% playback speed in 5% steps, with optional pitch lock (WSOLA time-stretching)
- **BPM detection** — automatic energy-flux onset analysis, normalized to 65–150 BPM; manual BPM overrides are preserved
- **Waveform display** — scrolling DJ-style waveform with loop overlay, click-to-seek, and persistent disk cache
- **4 cue/loop slots** — A-D slots per track, persisted to SQLite, auto-load on select
- **Favorites** — mark loops as favorites for quick access
- **Keyboard shortcuts** — Space, S, arrows, L, [, ], +, -, Cmd+O for hands-free practice
- **Library management** — search, filter (source/BPM/duration), sort, favorites-only, context menus (reveal in Finder, edit metadata, remove)
- **Looper groups** — rename source folders, remove groups (preserves audio on disk)
- **Import modal** — staged progress UI with per-file status, elapsed time, and cancel support
- **Native file dialogs** — OS-native file pickers for import and library setup
- **Dark UI** — Tailwind CSS v4, sidebar layout, context menus, track stats
- **Custom icon** — waveform loop "O" design with large "O" background in Dock and Finder
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
# Rust unit tests (60 tests: parser, player, library, waveform, analysis)
cd src-tauri && cargo test

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
| `[` | Set loop start = current position |
| `]` | Set loop end = current position |
| `+` `-` | Change playback speed (5% steps, 50–200%) |
| `Cmd+O` | Open file picker for import |

Shortcuts are disabled while typing in text fields.

## Architecture

```
src/                     Frontend (React + TypeScript + Tailwind)
├── App.tsx              Root layout (sidebar + main area)
├── main.tsx             Entry point (CSS import)
├── index.css            Tailwind + design tokens
├── tauri.ts             Typed Tauri command bridge + dialog wrappers
├── importFlow.ts        Import routing helpers
├── hooks/               React hooks
│   └── useKeyboardShortcuts.ts
└── components/          UI components
    ├── TopBar.tsx       Header with version + library init + folder picker
    ├── Sidebar.tsx      Track list with search/filter/sort + context menus
    ├── Player.tsx       Transport + scrub + loop + speed + A-D slot selector
    ├── Waveform.tsx     Canvas waveform with playhead + loop overlay
    ├── ImportBar.tsx    File import with browse buttons + drag-drop + inline progress
    └── Logo.tsx         Waveform loop "O" logo component

src-tauri/               Backend (Rust)
├── src/lib.rs           Tauri commands + app builder + portable storage
├── src/player/mod.rs    Audio engine (rodio, region loop, speed, pitch lock)
├── src/library/mod.rs   SQLite catalog (schema v6) + file management + loop slots
├── src/import/          SWF/EXE parsers (MP3 + ADPCM + SoundStreamBlock)
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
└── 095-background-import.md

docs/                    Documentation
├── adr/                 Architecture decision records (0001–0008)
└── macos-release.md     macOS signing and notarization guide
```

## License

Private — xFlare project.
