import { useEffect, useRef } from "react";
import {
  playerStatus as getPlayerStatus,
  playerPlay,
  playerPause,
  playerStop,
  playerSeek,
  playerSetLoopEnabled,
  type PlayerStatus,
} from "../tauri";

// Global player state ref — updated by Player component via exposePlayerState().
let currentPositionMs = 0;
let isPlaying = false;
let isLoaded = false;
let loopEnabled = false;
let durationMs = 0;

export function exposePlayerState(state: {
  position_ms: number;
  playing: boolean;
  loaded: boolean;
  loop_enabled: boolean;
  duration_ms: number;
}) {
  currentPositionMs = state.position_ms;
  isPlaying = state.playing;
  isLoaded = state.loaded;
  loopEnabled = state.loop_enabled;
  durationMs = state.duration_ms;
}

function isTextInput(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || (el as HTMLElement).isContentEditable;
}

export default function useKeyboardShortcuts() {
  const pendingRef = useRef<Promise<void>>(Promise.resolve());

  // Chain async player calls to avoid races.
  const chain = (fn: () => Promise<PlayerStatus>) => {
    pendingRef.current = pendingRef.current.then(async () => {
      const status = await fn();
      exposePlayerState(status);
      window.dispatchEvent(new CustomEvent<PlayerStatus>("olooper:player-status", { detail: status }));
    }).catch(async () => {
      try {
        const status = await getPlayerStatus();
        exposePlayerState(status);
        window.dispatchEvent(new CustomEvent<PlayerStatus>("olooper:player-status", { detail: status }));
      } catch {
        // Keep shortcuts responsive even when the audio engine is unavailable.
      }
    });
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Skip when typing in inputs.
      if (isTextInput(document.activeElement)) return;
      // Dialog controls own Space/Enter; tapping tempo must not toggle playback.
      if (document.activeElement?.closest('[role="dialog"]')) return;
      // Skip other modified shortcuts (allow Cmd+C, Cmd+V, etc.).
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const cueMatch = /^(?:Digit|Numpad)([1-4])$/.exec(e.code);
      if (cueMatch) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("olooper:cue-shortcut", {
          detail: { slot: Number(cueMatch[1]), clear: e.shiftKey },
        }));
        return;
      }

      switch (e.code) {
        case "Space": {
          e.preventDefault();
          if (isPlaying) {
            isPlaying = false;
            chain(() => playerPause());
          } else if (isLoaded) {
            isPlaying = true;
            chain(() => playerPlay());
          }
          break;
        }
        case "KeyS": {
          e.preventDefault();
          if (isLoaded) chain(() => playerStop());
          break;
        }
        case "ArrowLeft": {
          e.preventDefault();
          if (isLoaded) {
            const target = Math.max(0, currentPositionMs - 5000);
            chain(() => playerSeek(target));
          }
          break;
        }
        case "ArrowRight": {
          e.preventDefault();
          if (isLoaded) {
            const target = Math.min(durationMs, currentPositionMs + 5000);
            chain(() => playerSeek(target));
          }
          break;
        }
        case "KeyL": {
          e.preventDefault();
          if (isLoaded) {
            chain(() => playerSetLoopEnabled(!loopEnabled));
          }
          break;
        }
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}
