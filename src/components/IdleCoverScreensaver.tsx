import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import useIdleCover, { type IdleCoverPhase } from "../hooks/useIdleCover";
import type { PlayerStatus, Track } from "../tauri";
import { coverOriginTransform, fitCover } from "../coverGeometry";
import { idleCoverContext, idleCoverEligibility, type ActiveCoverState } from "../idleCoverState";
export type { ActiveCoverState } from "../idleCoverState";

interface CoverImage {
  src: string;
  title: string;
  path: string;
  generation: number;
  width: number;
  height: number;
}

interface Props {
  onVisibilityChange?: (visible: boolean) => void;
  enabled: boolean;
  delayMs: number;
  ready: boolean;
  libraryGeneration: number;
  track: Track | null;
  status: PlayerStatus | null;
  cover: ActiveCoverState | null;
  originRef: RefObject<HTMLDivElement>;
}

export default function IdleCoverScreensaver({ enabled, delayMs, ready, libraryGeneration, track, status, cover, originRef, onVisibilityChange }: Props) {
  const [image, setImage] = useState<CoverImage | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const context = idleCoverContext(track, status, cover, libraryGeneration);
  const { committed, src, path, title, key } = context;

  useEffect(() => {
    if (!key || !src || !path || !committed) return;
    let cancelled = false;
    const preload = new Image();
    preload.onload = () => {
      if (cancelled || !preload.naturalWidth || !preload.naturalHeight) return;
      setImage({ src, title, path, generation: libraryGeneration, width: preload.naturalWidth, height: preload.naturalHeight });
      setLoadedKey(key); setFailedKey(null);
    };
    preload.onerror = () => { if (!cancelled) { setFailedKey(key); setLoadedKey(null); } };
    preload.src = src;
    return () => { cancelled = true; preload.onload = null; preload.onerror = null; };
  }, [key, src, path, committed, libraryGeneration, title]);

  const currentImage = image?.generation === libraryGeneration ? image : null;
  const { canEnter, canRemain } = idleCoverEligibility(context, track, status, ready, loadedKey, failedKey, !!currentImage);
  const { phase, dismiss, finishTransition } = useIdleCover({
    enabled,
    delayMs,
    canEnter,
    canRemain,
    scopeKey: libraryGeneration,
  });
  const visible = !!currentImage && phase === "visible";
  useEffect(() => { onVisibilityChange?.(visible); }, [visible, onVisibilityChange]);
  useEffect(() => () => onVisibilityChange?.(false), [onVisibilityChange]);
  if (!currentImage || phase === "hidden") return null;
  return <IdleCoverOverlay image={currentImage} phase={phase} originRef={originRef} onClose={dismiss} onTransitionEnd={finishTransition} />;
}

interface OverlayProps {
  image: CoverImage;
  phase: IdleCoverPhase;
  originRef: RefObject<HTMLDivElement>;
  onClose: () => void;
  onTransitionEnd: () => void;
}

export function IdleCoverOverlay({ image, phase, originRef, onClose, onTransitionEnd }: OverlayProps) {
  const imageRef = useRef<HTMLImageElement>(null);
  const backgroundRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  useEffect(() => {
    const resize = () => {
      setViewport({ width: window.innerWidth, height: window.innerHeight });
      if (phase !== "visible") onTransitionEnd();
    };
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [phase, onTransitionEnd]);

  useLayoutEffect(() => {
    const node = imageRef.current;
    const background = backgroundRef.current;
    if (!node || !background) return;
    const { width, height, left, top } = fitCover(viewport, image);
    const previousTransform = getComputedStyle(node).transform;
    Object.assign(node.style, { width: `${width}px`, height: `${height}px`, left: `${left}px`, top: `${top}px` });
    const rect = originRef.current?.getBoundingClientRect();
    const destination = coverOriginTransform({ width, height, left, top }, rect);
    if (phase === "visible") { node.style.transform = "none"; background.style.opacity = "1"; return; }
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (reduced || !node.animate) { node.style.transform = "none"; onTransitionEnd(); return; }
    const entering = phase === "entering";
    const animation = node.animate([
      { transform: entering ? destination ?? "none" : previousTransform, opacity: entering && !destination ? 0 : 1 },
      { transform: entering ? "none" : destination ?? "none", opacity: !entering && !destination ? 0 : 1 },
    ], { duration: 240, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)", fill: "forwards" });
    const fade = background.animate([
      { opacity: entering ? 0 : getComputedStyle(background).opacity },
      { opacity: entering ? 1 : 0 },
    ], { duration: 240, fill: "forwards" });
    animation.onfinish = onTransitionEnd;
    return () => {
      node.style.transform = getComputedStyle(node).transform;
      background.style.opacity = getComputedStyle(background).opacity;
      animation.onfinish = null;
      animation.cancel(); fade.cancel();
    };
  }, [phase, image.width, image.height, image.src, originRef, viewport, onTransitionEnd]);

  return createPortal(
    <section data-idle-cover-overlay="" role="dialog" aria-modal="true" aria-label="Looper cover" className="fixed inset-0 z-[110] overflow-hidden">
      <div ref={backgroundRef} className="absolute inset-0 bg-app" />
      <img ref={imageRef} src={image.src} alt={`Cover for ${image.title}`} draggable={false} className="pointer-events-none absolute select-none object-contain" style={{ transformOrigin: "top left" }} />
      <button onClick={onClose} className="dialog-close absolute bottom-5 left-1/2 -translate-x-1/2 rounded-lg bg-app/90 px-4 py-2 text-xs text-text shadow-lg">Return to player — move the pointer or press Escape</button>
    </section>, document.body,
  );
}
