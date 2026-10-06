import { useCallback, useEffect, useRef, useState } from "react";
import TopBar from "./components/TopBar";
import Sidebar from "./components/Sidebar";
import Player from "./components/Player";
import Waveform from "./components/Waveform";
import ImportBar from "./components/ImportBar";
import TablistCatalog from "./components/TablistCatalog";
import MidiSettingsDialog, { MIDI_ACTIONS } from "./components/MidiSettingsDialog";
import AudioSettingsDialog from "./components/AudioSettingsDialog";
import StartupIntro from "./components/StartupIntro";
import useKeyboardShortcuts from "./hooks/useKeyboardShortcuts";
import {
  libraryRandomTrack,
  libraryList,
  libraryGroupCover,
  libraryMarkPlayed,
  audioSetOutput,
  listenAppMenuCommand,
  listenMidiMessage,
  midiConnect,
  midiDisconnect,
  playerAutoLoop,
  playerLoad,
  playerPause,
  playerPlay,
  playerSetLoopEnabled,
  playerSetLoopSnapped,
  playerSetSpeed,
  playerSetDiagnostics,
  playerStatus as getPlayerStatus,
  playerStop,
  type MidiAction,
  type MidiBinding,
  type AudioOutputSelection,
  type PlayerStatus,
  type Track,
} from "./tauri";
import { firstMidiStartTrack } from "./midiPlayback";
import { normalizeStereoPair } from "./audioOutputPreferences";

type TrackNavigator = (direction: -1 | 1) => void;
type MidiBindings = Partial<Record<MidiAction, MidiBinding>>;

function readAudioSelection(): AudioOutputSelection {
  try {
    const value: unknown = JSON.parse(localStorage.getItem("olooper.audio.output") ?? "null");
    if (!value || typeof value !== "object") return { deviceName: null, firstChannel: 0, sampleRate: null, bufferFrames: null };
    const selection = value as Partial<AudioOutputSelection>;
    const sampleRate = Number.isInteger(selection.sampleRate) && (selection.sampleRate ?? 0) > 0
      ? selection.sampleRate!
      : null;
    const bufferFrames = Number.isInteger(selection.bufferFrames) && (selection.bufferFrames ?? 0) > 0
      ? selection.bufferFrames!
      : null;
    if (
      (selection.deviceName === null || typeof selection.deviceName === "string")
      && Number.isInteger(selection.firstChannel)
      && (selection.firstChannel ?? -1) >= 0
      && (selection.firstChannel ?? 0) <= 62
    ) return {
      deviceName: selection.deviceName ?? null,
      firstChannel: normalizeStereoPair(selection.firstChannel!),
      sampleRate,
      bufferFrames,
    };
  } catch { /* Use the system default when the local preference is invalid. */ }
  return { deviceName: null, firstChannel: 0, sampleRate: null, bufferFrames: null };
}

function readMidiBindings(): MidiBindings {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem("olooper.midi.bindings") ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const values = parsed as Record<string, unknown>;
    const bindings: MidiBindings = {};
    for (const { id } of MIDI_ACTIONS) {
      const value = values[id];
      if (!value || typeof value !== "object") continue;
      const binding = value as Partial<MidiBinding>;
      if (
        typeof binding.inputId === "string" && typeof binding.inputName === "string"
        && (binding.kind === "note" || binding.kind === "cc")
        && Number.isInteger(binding.channel) && binding.channel! >= 1 && binding.channel! <= 16
        && Number.isInteger(binding.number) && binding.number! >= 0 && binding.number! <= 127
      ) bindings[id] = binding as MidiBinding;
    }
    return bindings;
  } catch {
    return {};
  }
}

function sameMidiBinding(left: MidiBinding, right: MidiBinding): boolean {
  return left.inputId === right.inputId && left.kind === right.kind
    && left.channel === right.channel && left.number === right.number;
}

export default function App() {
  useKeyboardShortcuts();
  const [libraryReady, setLibraryReady] = useState(false);
  const [startupIntroDone, setStartupIntroDone] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [playerStatus, setPlayerStatus] = useState<PlayerStatus | null>(null);
  const [activeTrackId, setActiveTrackId] = useState<number | null>(null);
  const [trackOpenGeneration, setTrackOpenGeneration] = useState(0);
  const [activeTrack, setActiveTrack] = useState<Track | null>(null);
  const [activeCover, setActiveCover] = useState<string | null>(null);
  const [trackNavigator, setTrackNavigator] = useState<TrackNavigator | null>(null);
  const [libraryView, setLibraryView] = useState<"local" | "tablist">("local");
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [loopEditing, setLoopEditing] = useState(false);
  const [midiOptionsOpen, setMidiOptionsOpen] = useState(false);
  const [audioOptionsOpen, setAudioOptionsOpen] = useState(false);
  const [audioSelection, setAudioSelection] = useState<AudioOutputSelection>(readAudioSelection);
  const [audioStartupError, setAudioStartupError] = useState<string | null>(null);
  const [midiInputId, setMidiInputId] = useState<string | null>(() => localStorage.getItem("olooper.midi.input"));
  const [midiBindings, setMidiBindings] = useState<MidiBindings>(readMidiBindings);
  const [midiLearningAction, setMidiLearningAction] = useState<MidiAction | null>(null);
  const [midiLearningConflict, setMidiLearningConflict] = useState<MidiAction | null>(null);
  const randomLoadGeneration = useRef(0);
  const midiBindingsRef = useRef(midiBindings);
  const midiLearningActionRef = useRef(midiLearningAction);
  const midiActionHandlerRef = useRef<(action: MidiAction) => void>(() => {});
  midiBindingsRef.current = midiBindings;
  midiLearningActionRef.current = midiLearningAction;

  const onLibraryReady = useCallback(() => setLibraryReady(true), []);
  const finishStartupIntro = useCallback(() => setStartupIntroDone(true), []);

  useEffect(() => {
    audioSetOutput(audioSelection)
      .catch((cause) => setAudioStartupError(`Saved audio output was not applied: ${String(cause)}. Reconnect the device and press Apply.`));
    // Set the saved output before the first playback request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshPlayerAfterAudioTest = useCallback(() => {
    window.setTimeout(() => {
      getPlayerStatus().then(setPlayerStatus).catch(() => {});
    }, 1100);
  }, []);
  const onImported = useCallback(
    () => setRefreshKey((k) => k + 1),
    [],
  );
  const onTrackSelected = useCallback((track: Track, status: PlayerStatus) => {
    randomLoadGeneration.current += 1;
    setActiveTrackId(track.id);
    setActiveTrack(track);
    setPlayerStatus(status);
    setTrackOpenGeneration((generation) => generation + 1);
  }, []);

  useEffect(() => {
    const updateActiveBpm = (event: Event) => {
      const { trackId, bpm } = (event as CustomEvent<{ trackId: number; bpm: number }>).detail;
      if (trackId === activeTrackId) {
        setActiveTrack((current) => current?.id === trackId ? { ...current, bpm } : current);
      }
    };
    window.addEventListener("olooper:track-bpm", updateActiveBpm);
    return () => window.removeEventListener("olooper:track-bpm", updateActiveBpm);
  }, [activeTrackId]);

  useEffect(() => {
    if (!playerStatus?.loaded || !activeTrack || activeTrack.source_type === "custom") {
      setActiveCover(null);
      return;
    }
    let cancelled = false;
    setActiveCover(null);
    libraryGroupCover(activeTrack.source_hash)
      .then((cover) => { if (!cancelled) setActiveCover(cover); })
      .catch(() => { if (!cancelled) setActiveCover(null); });
    return () => { cancelled = true; };
  }, [activeTrack?.source_hash, activeTrack?.source_type, playerStatus?.loaded]);

  const registerTrackNavigator = useCallback((navigate: TrackNavigator | null) => {
    setTrackNavigator(() => navigate);
  }, []);

  const onTrackLoading = useCallback(() => {
    randomLoadGeneration.current += 1;
  }, []);

  const playRandomTrack = useCallback(async () => {
    const generation = ++randomLoadGeneration.current;
    const track = await libraryRandomTrack(activeTrackId);
    if (!track) throw new Error("No playable tracks in the library");
    if (generation !== randomLoadGeneration.current) return;

    let status = await playerLoad(track.file_path);
    setPlayerStatus(status);
    const deadline = Date.now() + 120_000;
    while (status.loading && Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 150));
      if (generation !== randomLoadGeneration.current) return;
      status = await getPlayerStatus();
      setPlayerStatus(status);
    }
    if (generation !== randomLoadGeneration.current) return;
    if (status.loading) throw new Error("Random track load timed out");
    if (status.load_error) throw new Error(status.load_error);
    if (status.path !== track.file_path) return;
    const playing = await playerPlay();
    if (generation !== randomLoadGeneration.current) return;
    setActiveTrackId(track.id);
    setActiveTrack(track);
    setPlayerStatus(playing);
    setTrackOpenGeneration((current) => current + 1);
    window.dispatchEvent(new CustomEvent("olooper:reveal-library-track", {
      detail: { trackId: track.id, sourceHash: track.source_hash },
    }));
  }, [activeTrackId]);

  const playFirstLibraryTrack = useCallback(async () => {
    const generation = ++randomLoadGeneration.current;
    const tracks = await libraryList();
    if (generation !== randomLoadGeneration.current) return;
    const track = firstMidiStartTrack(tracks, localStorage.getItem("olooper.library.sort"));
    if (!track) return;

    let status = await playerLoad(track.file_path);
    setPlayerStatus(status);
    const deadline = Date.now() + 120_000;
    while (status.loading && Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 150));
      if (generation !== randomLoadGeneration.current) return;
      status = await getPlayerStatus();
      setPlayerStatus(status);
    }
    if (generation !== randomLoadGeneration.current) return;
    if (status.loading || status.load_error || status.path !== track.file_path) return;
    playerSetDiagnostics(track.loop_origin, track.loop_quality).catch(() => {});
    const playing = await playerPlay();
    if (generation !== randomLoadGeneration.current) return;
    onTrackSelected(track, playing);
    libraryMarkPlayed(track.id).then(onImported).catch(() => {});
  }, [onImported, onTrackSelected]);

  const executeMidiAction = useCallback((action: MidiAction) => {
    if (action === "play-pause" && !playerStatus?.loaded) {
      playFirstLibraryTrack().catch(() => {});
      return;
    }
    if (!playerStatus?.loaded) return;
    const publishStatus = (request: Promise<PlayerStatus>) => {
      request.then(setPlayerStatus).catch(() => {});
    };
    if (action === "play-pause") {
      publishStatus(playerStatus.playing ? playerPause() : playerPlay());
    } else if (action === "stop") {
      publishStatus(playerStop());
    } else if (action === "previous") {
      trackNavigator?.(-1);
    } else if (action === "next") {
      trackNavigator?.(1);
    } else if (action === "toggle-loop") {
      publishStatus(playerSetLoopEnabled(!playerStatus.loop_enabled));
    } else if (action === "speed-down") {
      publishStatus(playerSetSpeed(Math.max(50, playerStatus.speed_pct - 5)));
    } else if (action === "speed-up") {
      publishStatus(playerSetSpeed(Math.min(200, playerStatus.speed_pct + 5)));
    } else if (action === "auto-loop") {
      playerAutoLoop()
        .then((result) => {
          if (!result.candidate) throw new Error("No suitable loop found");
          return playerSetLoopSnapped(
            Math.round(result.candidate.start_frame * 1000 / result.sample_rate),
            Math.round(result.candidate.end_frame * 1000 / result.sample_rate),
          );
        })
        .then(setPlayerStatus)
        .catch(() => {});
    } else if (action.startsWith("clear-cue-")) {
      const slot = Number(action.slice("clear-cue-".length));
      window.dispatchEvent(new CustomEvent("olooper:cue-shortcut", { detail: { slot, clear: true } }));
    } else if (action.startsWith("cue-")) {
      const slot = Number(action.slice("cue-".length));
      window.dispatchEvent(new CustomEvent("olooper:cue-shortcut", { detail: { slot, clear: false } }));
    }
  }, [playerStatus, playFirstLibraryTrack, trackNavigator]);
  midiActionHandlerRef.current = executeMidiAction;

  // Listen for olooper:imported events from keyboard shortcut handler.
  useEffect(() => {
    const handler = () => onImported();
    window.addEventListener("olooper:imported", handler);
    return () => window.removeEventListener("olooper:imported", handler);
  }, [onImported]);

  useEffect(() => {
    localStorage.setItem("olooper.midi.bindings", JSON.stringify(midiBindings));
  }, [midiBindings]);

  useEffect(() => {
    if (midiInputId) localStorage.setItem("olooper.midi.input", midiInputId);
    else localStorage.removeItem("olooper.midi.input");
  }, [midiInputId]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listenMidiMessage((message) => {
      const learning = midiLearningActionRef.current;
      if (learning) {
        const binding: MidiBinding = {
          inputId: message.inputId,
          inputName: message.inputName,
          kind: message.kind,
          channel: message.channel,
          number: message.number,
        };
        const conflict = Object.entries(midiBindingsRef.current).find(([action, assigned]) =>
          action !== learning && assigned && sameMidiBinding(assigned, binding),
        )?.[0] as MidiAction | undefined;
        setMidiLearningConflict(conflict ?? null);
        setMidiBindings((current) => {
          const next = { ...current };
          for (const [action, assigned] of Object.entries(next)) {
            if (action !== learning && assigned && sameMidiBinding(assigned, binding)) {
              delete next[action as MidiAction];
            }
          }
          next[learning] = binding;
          return next;
        });
        setMidiLearningAction(null);
        return;
      }

      const assignment = Object.entries(midiBindingsRef.current).find(([, binding]) =>
        binding && binding.inputId === message.inputId
          && binding.kind === message.kind
          && binding.channel === message.channel
          && binding.number === message.number,
      );
      if (assignment) midiActionHandlerRef.current(assignment[0] as MidiAction);
    }).then((dispose) => {
      if (cancelled) {
        dispose();
        return;
      }
      unlisten = dispose;
      const savedInput = localStorage.getItem("olooper.midi.input");
      if (savedInput) midiConnect(savedInput).catch(() => {});
    }).catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
      midiDisconnect().catch(() => {});
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listenAppMenuCommand((command) => {
      if (command === "show-shortcuts") {
        setShortcutsOpen(true);
      } else if (command === "midi-options") {
        setMidiOptionsOpen(true);
      } else if (command === "audio-options") {
        setAudioOptionsOpen(true);
      } else if (command === "choose-library") {
        window.dispatchEvent(new Event("olooper:choose-library"));
      } else {
        window.dispatchEvent(new CustomEvent("olooper:import-command", { detail: command }));
      }
    }).then((dispose) => { unlisten = dispose; }).catch(() => {});
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    if (!shortcutsOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShortcutsOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [shortcutsOpen]);

  return (
    <div className="h-screen flex flex-col bg-app text-text overflow-hidden">
      <TopBar onLibraryReady={onLibraryReady} playing={playerStatus?.playing ?? false} trackBpm={activeTrack?.bpm ?? null} onAudioOptions={() => setAudioOptionsOpen(true)}>
        <ImportBar onImported={onImported} />
      </TopBar>

      <main className="flex flex-1 min-h-0 flex-col">
        <div className="h-1/5 min-h-36 shrink-0 p-3">
          <Waveform refreshKey={refreshKey} status={playerStatus} trackTitle={activeTrack?.title ?? null} trackCover={activeCover} trackId={activeTrack?.id ?? null} showCover={playerStatus?.loaded === true && activeTrack !== null} loopEditing={loopEditing} onStatusChange={setPlayerStatus} />
        </div>
        <Player
          status={playerStatus}
          trackId={activeTrackId}
          trackOpenGeneration={trackOpenGeneration}
          canRandom={libraryReady}
          onRandomTrack={playRandomTrack}
          canNavigateTracks={trackNavigator !== null}
          onPreviousTrack={() => trackNavigator?.(-1)}
          onNextTrack={() => trackNavigator?.(1)}
          loopEditing={loopEditing}
          onToggleLoopEditing={() => setLoopEditing((editing) => !editing)}
          onStatusChange={setPlayerStatus}
        />
        <section className="flex min-h-0 flex-1 flex-col border-t border-border">
          <div className="flex shrink-0 items-center gap-1 border-b border-border bg-surface px-3 pt-1.5" role="tablist" aria-label="Library views">
            <button
              role="tab"
              aria-selected={libraryView === "local"}
              onClick={() => setLibraryView("local")}
              className={`rounded-t px-3 py-1.5 text-[11px] ${libraryView === "local" ? "border border-border border-b-surface bg-surface text-text" : "text-text-secondary hover:text-text"}`}
            >
              My Library
            </button>
            <button
              role="tab"
              aria-selected={libraryView === "tablist"}
              onClick={() => setLibraryView("tablist")}
              className={`rounded-t px-3 py-1.5 text-[11px] ${libraryView === "tablist" ? "border border-border border-b-surface bg-surface text-text" : "text-text-secondary hover:text-text"}`}
            >
              Download new Loopers
            </button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col">
            {libraryView === "local" ? (
              <Sidebar
                libraryReady={libraryReady}
                refreshKey={refreshKey}
                activeTrackId={activeTrackId}
                onRegisterTrackNavigation={registerTrackNavigator}
                onTrackLoading={onTrackLoading}
                onTrackSelected={onTrackSelected}
              />
            ) : (
              <TablistCatalog libraryReady={libraryReady} refreshKey={refreshKey} onImported={onImported} />
            )}
          </div>
        </section>
      </main>
      {shortcutsOpen && (
        <div
          className="fixed inset-0 z-[120] flex items-center justify-center bg-app/80 p-4 backdrop-blur-sm"
          onClick={() => setShortcutsOpen(false)}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="shortcuts-title"
            className="w-full max-w-lg rounded-lg border border-border bg-surface p-5 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="mb-4 flex items-center justify-between gap-3">
              <h2 id="shortcuts-title" className="text-base font-semibold text-text">Keyboard Shortcuts</h2>
              <button
                onClick={() => setShortcutsOpen(false)}
                aria-label="Close keyboard shortcuts"
                className="rounded px-2 py-1 text-xs text-text-secondary hover:bg-border hover:text-text"
              >Close</button>
            </header>
            <div className="space-y-4 text-xs">
              <section aria-label="Playback shortcuts">
                <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-text-secondary">Playback</h3>
                <ShortcutRow keys="Space" action="Play / pause" />
                <ShortcutRow keys="S" action="Stop at loop start" />
                <ShortcutRow keys="← / →" action="Seek 5 seconds" />
                <ShortcutRow keys="L" action="Toggle looping" />
                <ShortcutRow keys="1–4" action="Recall a cue; save an empty cue at the current position" />
                <ShortcutRow keys="Shift + 2–4" action="Clear a saved cue" />
                <ShortcutRow keys="Shift + 1" action="Return to the fixed start cue" />
                <ShortcutRow keys="+ / −" action="Adjust playback speed by 5%" />
              </section>
              <section aria-label="Application shortcuts">
                <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-text-secondary">Application</h3>
                <ShortcutRow keys="⌘ / Ctrl + O" action="Open File → Import Files…" />
                <ShortcutRow keys="⌘ / Ctrl + W" action="Close window" />
                <ShortcutRow keys="⌘ / Ctrl + Q" action="Quit oLooper" />
                <ShortcutRow keys="⌘ + Z / ⇧⌘ + Z · Ctrl + Z / Ctrl + Y" action="Undo / redo text edits" />
                <ShortcutRow keys="⌘ / Ctrl + X / C / V / A" action="Cut / copy / paste / select all" />
              </section>
            </div>
            <p className="mt-4 text-[10px] text-text-secondary">Transport shortcuts are disabled while typing in text fields.</p>
          </section>
        </div>
      )}
      <MidiSettingsDialog
        open={midiOptionsOpen}
        inputId={midiInputId}
        bindings={midiBindings}
        learningAction={midiLearningAction}
        conflictAction={midiLearningConflict}
        onInputIdChange={setMidiInputId}
        onLearningChange={(action) => {
          setMidiLearningConflict(null);
          setMidiLearningAction(action);
        }}
        onClearBinding={(action) => {
          setMidiLearningConflict(null);
          setMidiBindings((current) => {
            const next = { ...current };
            delete next[action];
            return next;
          });
        }}
        onClose={() => {
          setMidiOptionsOpen(false);
          setMidiLearningAction(null);
          setMidiLearningConflict(null);
        }}
      />
      <AudioSettingsDialog
        open={audioOptionsOpen}
        selection={audioSelection}
        startupError={audioStartupError}
        onSelectionChange={(next) => {
          setAudioStartupError(null);
          setAudioSelection(next);
        }}
        onPlayerStatusChange={setPlayerStatus}
        onOutputTestStarted={refreshPlayerAfterAudioTest}
        onClose={() => setAudioOptionsOpen(false)}
      />
      {!startupIntroDone && <StartupIntro onComplete={finishStartupIntro} />}
    </div>
  );
}

function ShortcutRow({ keys, action }: { keys: string; action: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border/50 py-1.5 last:border-0">
      <kbd className="shrink-0 rounded bg-elevated px-1.5 py-0.5 font-mono text-[10px] text-text">{keys}</kbd>
      <span className="text-right text-text-secondary">{action}</span>
    </div>
  );
}
