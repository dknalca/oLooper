# oLooper

A desktop app for DJs and turntablists to extract and practice with audio loops from legacy Flash `.swf` and projector `.exe` files.

## Features

- **SWF extraction** — drop a `.swf`, get all embedded MP3 loops as practice tracks
- **EXE projector extraction** — drop a projector `.exe`, locate the embedded SWF, same pipeline
- **Custom audio import** — WAV/MP3 drop or browse, instantly playable with BPM detection
- **Persistent library** — SQLite catalog survives restarts, deduplicates on import
- **Practice player** — play/pause/stop, gapless region looping, volume, seek
- **Waveform display** — scrolling DJ-style waveform with loop overlay and click-to-seek
- **4 cue/loop slots** — A-D slots per track, persisted to SQLite, auto-load on select
- **Keyboard shortcuts** — Space, S, arrows, L, [, ], Cmd+O for hands-free practice
- **Native file dialogs** — OS-native file pickers for import and library setup
- **Dark UI** — Tailwind CSS v4, sidebar layout, context menus, track stats
- **Custom icon** — waveform loop "O" design in Dock and Finder

## Requirements

- macOS 12+ (primary target; architecture is cross-platform)
- Rust 1.77+
- Node.js 22+
- pnpm 9+

## Build from source

```bash
# Install dependencies
pnpm install

# Development mode (hot-reload)
pnpm tauri dev

# Production build
./scripts/build.sh           # release, copies .app to project root
./scripts/build.sh --dev     # debug (faster, with logs)
```

The built `.app` bundle will be at `./oLooper.app` in the project root.

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `Space` | Play / Pause toggle |
| `S` | Stop (return to loop start) |
| `←` `→` | Seek ±5 seconds |
| `L` | Toggle loop on/off |
| `[` | Set loop start = current position |
| `]` | Set loop end = current position |
| `Cmd+O` | Open file picker for import |

Shortcuts are disabled while typing in text fields.

## Architecture

```
src/                     Frontend (React + TypeScript + Tailwind)
├── App.tsx              Root layout (sidebar + main area)
├── main.tsx             Entry point (CSS import)
├── index.css            Tailwind + design tokens
├── tauri.ts             Typed Tauri command bridge + dialog wrappers
├── hooks/               React hooks
│   └── useKeyboardShortcuts.ts
└── components/          UI components
    ├── TopBar.tsx       Header with version + library init + folder picker
    ├── Sidebar.tsx      Track list with search + context menu + stats
    ├── Player.tsx       Transport + scrub + loop + A-D slot selector
    ├── Waveform.tsx     Canvas waveform with playhead + loop overlay
    ├── ImportBar.tsx    File import with native browse buttons + drag-drop
    └── Logo.tsx         Waveform loop "O" logo component

src-tauri/               Backend (Rust)
├── src/lib.rs           Tauri commands + app builder
├── src/player/mod.rs    Audio engine (rodio, region loop)
├── src/library/mod.rs   SQLite catalog + file management + loop slots
├── src/import/          SWF/EXE parsers
├── src/waveform.rs      Peak computation
└── src/analysis.rs      BPM estimator

scripts/                 Build & utility scripts
├── build.sh             Build .app bundle (release or debug)
└── generate-icons.mjs   SVG → PNG + icns icon generation

specs/                   Feature specifications
├── 000-product-foundation.md
├── 010-library.md
├── 020-swf-extraction.md
├── 025-exe-extraction.md
├── 030-player.md
├── 040-waveform.md
├── 050-custom-loops.md
├── 060-keyboard-shortcuts.md
├── 060-reliability-hardening.md
├── 070-loop-slots.md
└── 080-portable-drop-import.md

docs/adr/                Architecture decision records
├── 0001-tauri-react-rust-sqlite.md
├── 0002-audio-backend-rodio.md
├── 0003-loopersflash-local-inbox.md
├── 0004-ui-redesign-tailwind.md
├── 0005-dialog-plugin.md
└── 0006-portable-storage-and-bundle-id.md
```

## License

Private — xFlare project.
