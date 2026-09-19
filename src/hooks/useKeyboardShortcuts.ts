import { useEffect, useRef } from "react";
import {
  playerPlay,
  playerPause,
  playerStop,
  playerSeek,
  playerSetLoop,
  playerSetLoopEnabled,
  pickFiles,
  importCustom,
  importExe,
  importSwf,
} from "../tauri";

// Global player state ref — updated by Player component via exposePlayerState().
let currentPositionMs = 0;
let isPlaying = false;
let isLoaded = false;
let loopEnabled = false;
let durationMs = 0;
let loopStartMs = 0;
let loopEndMs = 0;

export function exposePlayerState(state: {
  position_ms: number;
  playing: boolean;
  loaded: boolean;
  loop_enabled: boolean;
  duration_ms: number;
  loop_start_ms: number;
  loop_end_ms: number;
}) {
  currentPositionMs = state.position_ms;
  isPlaying = state.playing;
  isLoaded = state.loaded;
  loopEnabled = state.loop_enabled;
  durationMs = state.duration_ms;
  loopStartMs = state.loop_start_ms;
  loopEndMs = state.loop_end_ms;
}

function isTextInput(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || (el as HTMLElement).isContentEditable;
}

export default function useKeyboardShortcuts() {
  const pendingRef = useRef<Promise<unknown>>(Promise.resolve());

  // Chain async player calls to avoid races.
  const chain = (fn: () => Promise<unknown>) => {
    pendingRef.current = pendingRef.current.then(fn).catch(() => {});
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Skip when typing in inputs.
      if (isTextInput(document.activeElement)) return;
      if ((e.metaKey || e.ctrlKey) && e.code === "KeyO") {
        e.preventDefault();
        chain(async () => {
          const files = await pickFiles([
            { name: "Audio", extensions: ["mp3", "wav", "flac", "ogg", "aac", "m4a"] },
            { name: "Flash files", extensions: ["swf"] },
            { name: "Projector files", extensions: ["exe"] },
          ]);
          for (const file of files) {
            const ext = file.split(".").pop()?.toLowerCase();
            if (ext === "swf") await importSwf(file);
            else if (ext === "exe") await importExe(file);
            else await importCustom([file]);
          }
          if (files.length > 0) window.dispatchEvent(new CustomEvent("olooper:imported"));
        });
        return;
      }
      // Skip other modified shortcuts (allow Cmd+C, Cmd+V, etc.).
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      switch (e.code) {
        case "Space": {
          e.preventDefault();
          if (isPlaying) {
            chain(() => playerPause());
          } else if (isLoaded) {
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
        case "BracketLeft": {
          e.preventDefault();
          if (isLoaded) {
            chain(() => playerSetLoop(currentPositionMs, loopEndMs));
          }
          break;
        }
        case "BracketRight": {
          e.preventDefault();
          if (isLoaded) {
            chain(() => playerSetLoop(loopStartMs, currentPositionMs));
          }
          break;
        }
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}
