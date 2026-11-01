import { midiEncoderDirection } from "./midiLibraryNavigation";
import { playerPause, playerPlay, playerSetVolume, playerStop, type MidiAction, type MidiMessage, type PlayerStatus } from "./tauri";

interface MidiActionContext {
  status: PlayerStatus | null;
  navigateLibrary: (command: "up" | "down" | "intro" | "back") => void;
  navigateTrack: ((direction: -1 | 1) => void) | null;
  playFirstTrack: () => Promise<void>;
  onStatus: (status: PlayerStatus) => void;
}

/** Dispatch mapped MIDI actions without owning device subscriptions or track loading. */
export function executeMidiAction(action: MidiAction, message: MidiMessage | undefined, context: MidiActionContext): void {
  const { status, navigateLibrary, navigateTrack, playFirstTrack, onStatus } = context;
  if (action === "library-encoder") {
    if (message?.kind !== "cc") return;
    const direction = midiEncoderDirection(message.value);
    if (direction !== 0) navigateLibrary(direction > 0 ? "down" : "up");
    return;
  }
  if (action === "library-up") { navigateLibrary("up"); return; }
  if (action === "library-down") { navigateLibrary("down"); return; }
  if (action === "library-intro") { navigateLibrary("intro"); return; }
  if (action === "library-back") { navigateLibrary("back"); return; }
  if (action === "metronome-toggle") { window.dispatchEvent(new Event("olooper:metronome-toggle")); return; }
  if (action === "volume-down" || action === "volume-up") {
    const currentVolume = status?.volume_pct ?? 80;
    const volume = action === "volume-down" ? Math.max(0, currentVolume - 5) : Math.min(100, currentVolume + 5);
    playerSetVolume(volume).then(onStatus).catch(() => {});
    return;
  }
  if (action === "random-loop") { window.dispatchEvent(new Event("olooper:random-loop")); return; }
  if (action === "play-pause" && !status?.loaded) { playFirstTrack().catch(() => {}); return; }
  if (!status?.loaded) return;
  const publishStatus = (request: Promise<PlayerStatus>) => { request.then(onStatus).catch(() => {}); };
  if (action === "play-pause") publishStatus(status.playing ? playerPause() : playerPlay());
  else if (action === "stop") publishStatus(playerStop());
  else if (action === "previous") navigateTrack?.(-1);
  else if (action === "next") navigateTrack?.(1);
  else if (action.startsWith("clear-cue-")) {
    const slot = Number(action.slice("clear-cue-".length));
    window.dispatchEvent(new CustomEvent("olooper:cue-shortcut", { detail: { slot, clear: true } }));
  } else if (action.startsWith("cue-")) {
    const slot = Number(action.slice("cue-".length));
    window.dispatchEvent(new CustomEvent("olooper:cue-shortcut", { detail: { slot, clear: false } }));
  }
}
