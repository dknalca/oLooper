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
  return tag === "input" || tag === "textarea" || tag === "select" || (el as HTMLElement).isContentEditable;
}

type Chain = (fn: () => Promise<PlayerStatus>) => void;

function shortcutIsBlocked(event: KeyboardEvent): boolean {
  if (isTextInput(document.activeElement)) return true;
  // Dialogs, sliders and tab lists own their respective keyboard controls.
  if (document.querySelector('[role="dialog"][aria-modal="true"]')
    || document.activeElement?.closest('[role="slider"]')) return true;
  if (event.target instanceof Element && event.target.closest('[role="tablist"]')) return true;
  return event.metaKey || event.ctrlKey || event.altKey;
}

function handleCueShortcut(event: KeyboardEvent): boolean {
  const match = /^(?:Digit|Numpad)([1-4])$/.exec(event.code);
  if (!match) return false;
  event.preventDefault();
  window.dispatchEvent(new CustomEvent("olooper:cue-shortcut", {
    detail: { slot: Number(match[1]), clear: event.shiftKey },
  }));
  return true;
}

function handleNavigationShortcut(event: KeyboardEvent, enabled: boolean, chain: Chain): boolean {
  switch (event.code) {
    case "ArrowLeft":
    case "ArrowRight": {
      event.preventDefault();
      const left = event.code === "ArrowLeft";
      if (enabled && !event.shiftKey) {
        window.dispatchEvent(new CustomEvent("olooper:library-navigation", { detail: left ? "back" : "intro" }));
      } else if (isLoaded) {
        const target = left ? Math.max(0, currentPositionMs - 5000) : Math.min(durationMs, currentPositionMs + 5000);
        chain(() => playerSeek(target));
      }
      return true;
    }
    case "ArrowUp":
    case "ArrowDown":
      if (enabled) {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent("olooper:library-navigation", {
          detail: event.code === "ArrowUp" ? "up" : "down",
        }));
      }
      return true;
    default:
      return false;
  }
}

function handleTransportShortcut(event: KeyboardEvent, chain: Chain): void {
  switch (event.code) {
    case "Space":
      event.preventDefault();
      if (isPlaying) {
        isPlaying = false;
        chain(() => playerPause());
      } else if (isLoaded) {
        isPlaying = true;
        chain(() => playerPlay());
      }
      break;
    case "KeyS":
      event.preventDefault();
      if (isLoaded) chain(() => playerStop());
      break;
    case "KeyR":
      event.preventDefault();
      window.dispatchEvent(new Event("olooper:random-loop"));
      break;
    case "KeyL":
      event.preventDefault();
      if (isLoaded) chain(() => playerSetLoopEnabled(!loopEnabled));
      break;
  }
}

export default function useKeyboardShortcuts(libraryNavigationEnabled = true) {
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
      if (shortcutIsBlocked(e) || handleCueShortcut(e)) return;
      if (handleNavigationShortcut(e, libraryNavigationEnabled, chain)) return;
      handleTransportShortcut(e, chain);
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [libraryNavigationEnabled]);
}
