import { useCallback, useEffect, useRef, useState } from "react";
import { IDLE_COVER_DELAY_MS } from "../appPreferences";

export type IdleCoverPhase = "hidden" | "entering" | "visible" | "leaving";

interface Options {
  enabled: boolean;
  canEnter: boolean;
  canRemain: boolean;
  scopeKey: number;
  delayMs?: number;
}

/** Local-window inactivity only: this hook never calls the audio engine. */
export default function useIdleCover({ delayMs = IDLE_COVER_DELAY_MS, ...options }: Options) {
  const [phase, setPhase] = useState<IdleCoverPhase>("hidden");
  const phaseRef = useRef<IdleCoverPhase>("hidden");
  const config = useRef(options);
  config.current = options;
  const reconcile = useRef<() => void>(() => {});
  const change = useCallback((next: IdleCoverPhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);
  const dismiss = useCallback(() => {
    if (phaseRef.current === "entering" || phaseRef.current === "visible") change("leaving");
  }, [change]);
  const finishTransition = useCallback(() => {
    if (phaseRef.current === "entering") change("visible");
    else if (phaseRef.current === "leaving") { change("hidden"); reconcile.current(); }
  }, [change]);

  useEffect(() => {
    change("hidden");
    if (!options.enabled) return;
    let timer: number | undefined;
    let deadline = performance.now() + delayMs;
    let focused = document.hasFocus();
    let otherModal = false;
    let wasEligible = false;
    let composing = false;
    let dragging = false;
    const pointers = new Set<number>();
    const wakeKeys = new Set<string>();
    let swallowClick = false;
    let clickCleanup: number | undefined;
    const visible = () => document.visibilityState !== "hidden";
    const clear = () => { if (timer !== undefined) window.clearTimeout(timer); timer = undefined; };
    const allowed = () => config.current.enabled && focused && visible() && !otherModal;
    const arm = () => {
      if (!allowed() || !config.current.canEnter || composing || dragging || pointers.size || phaseRef.current !== "hidden") { clear(); return; }
      if (timer !== undefined) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        if (!allowed() || !config.current.canEnter || composing || dragging || pointers.size) return;
        if (performance.now() < deadline) { arm(); return; }
        change("entering");
      }, Math.max(1, deadline - performance.now()));
    };
    const reset = () => { deadline = performance.now() + delayMs; };
    reconcile.current = () => {
      const eligible = allowed() && config.current.canEnter;
      if (eligible && !wasEligible) reset();
      wasEligible = eligible;
      if (!allowed() || !config.current.canRemain) dismiss();
      if (!allowed() || !config.current.canEnter) { clear(); reset(); }
      arm();
    };
    const activity = () => {
      if (!focused || !visible()) return;
      reset(); dismiss(); arm();
    };
    const block = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation(); };
    const pointerDown = (event: PointerEvent) => {
      pointers.add(event.pointerId);
      clear();
      if (phaseRef.current !== "hidden") { swallowClick = true; block(event); }
      activity();
    };
    const pointerEnter = (event: PointerEvent) => { if (event.relatedTarget === null) activity(); };
    const pointerUp = (event: PointerEvent) => {
      pointers.delete(event.pointerId);
      if (swallowClick) {
        block(event);
        if (clickCleanup !== undefined) window.clearTimeout(clickCleanup);
        // click normally follows pointerup in the same task. Do not leave a
        // suppression flag behind if a cancelled/native gesture emits no click.
        clickCleanup = window.setTimeout(() => { swallowClick = false; }, 0);
      }
      activity();
    };
    const click = (event: MouseEvent) => {
      if (swallowClick || phaseRef.current !== "hidden") { block(event); swallowClick = false; activity(); }
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) { reset(); return; }
      if (phaseRef.current !== "hidden" || wakeKeys.has(event.code)) {
        wakeKeys.add(event.code); block(event);
      }
      activity();
    };
    const keyUp = (event: KeyboardEvent) => { if (wakeKeys.delete(event.code)) block(event); };
    const wheel = (event: WheelEvent) => { if (phaseRef.current !== "hidden") block(event); activity(); };
    const blur = () => { focused = false; pointers.clear(); wakeKeys.clear(); clear(); reset(); dismiss(); };
    const focus = () => { focused = true; reset(); reconcile.current(); };
    const visibility = () => { if (visible()) { focused = document.hasFocus(); reset(); reconcile.current(); } else blur(); };
    const compositionStart = () => { composing = true; clear(); };
    const compositionEnd = () => { composing = false; activity(); };
    const dragStart = () => { dragging = true; clear(); };
    const dragEnd = () => { dragging = false; activity(); };
    const modals = () => {
      const next = !!document.querySelector('[role="dialog"][aria-modal="true"]:not([data-idle-cover-overlay])');
      if (next !== otherModal) { otherModal = next; reset(); reconcile.current(); }
    };
    const observer = new MutationObserver(modals);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["role", "aria-modal"] });
    modals(); arm();
    window.addEventListener("pointermove", activity, true);
    window.addEventListener("pointerover", pointerEnter, true);
    window.addEventListener("pointerdown", pointerDown, true);
    window.addEventListener("pointerup", pointerUp, true);
    window.addEventListener("pointercancel", pointerUp, true);
    window.addEventListener("click", click, true);
    window.addEventListener("keydown", keyDown, true);
    window.addEventListener("keyup", keyUp, true);
    window.addEventListener("wheel", wheel, { capture: true, passive: false });
    window.addEventListener("blur", blur);
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", visibility);
    document.addEventListener("compositionstart", compositionStart);
    document.addEventListener("compositionend", compositionEnd);
    document.addEventListener("dragstart", dragStart);
    document.addEventListener("dragend", dragEnd);
    return () => {
      clear(); observer.disconnect();
      if (clickCleanup !== undefined) window.clearTimeout(clickCleanup);
      reconcile.current = () => {};
      window.removeEventListener("pointermove", activity, true);
      window.removeEventListener("pointerover", pointerEnter, true);
      window.removeEventListener("pointerdown", pointerDown, true);
      window.removeEventListener("pointerup", pointerUp, true);
      window.removeEventListener("pointercancel", pointerUp, true);
      window.removeEventListener("click", click, true);
      window.removeEventListener("keydown", keyDown, true);
      window.removeEventListener("keyup", keyUp, true);
      window.removeEventListener("wheel", wheel, true);
      window.removeEventListener("blur", blur);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", visibility);
      document.removeEventListener("compositionstart", compositionStart);
      document.removeEventListener("compositionend", compositionEnd);
      document.removeEventListener("dragstart", dragStart);
      document.removeEventListener("dragend", dragEnd);
    };
  }, [options.enabled, options.scopeKey, delayMs, change, dismiss]);

  useEffect(() => { reconcile.current(); }, [options.enabled, options.canEnter, options.canRemain]);
  return { phase, dismiss, finishTransition };
}
