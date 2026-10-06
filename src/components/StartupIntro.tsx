import { useEffect, useRef, useState } from "react";
import Logo from "./Logo";
import { randomScratchQuote } from "../scratchQuotes";

interface Props {
  onComplete: () => void;
}

export default function StartupIntro({ onComplete }: Props) {
  const [quote] = useState(randomScratchQuote);
  const overlayRef = useRef<HTMLDivElement>(null);
  const movingLogoRef = useRef<HTMLDivElement>(null);
  const quoteRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const overlay = overlayRef.current;
    const movingLogo = movingLogoRef.current;
    const quoteElement = quoteRef.current;
    const targetLogo = document.querySelector<HTMLElement>("[data-app-logo]");
    if (!overlay || !movingLogo || !quoteElement) {
      onComplete();
      return;
    }

    let cancelled = false;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const duration = reducedMotion ? 450 : 3_600;
    const initial = movingLogo.getBoundingClientRect();
    Object.assign(movingLogo.style, {
      left: `${initial.left}px`,
      top: `${initial.top}px`,
      width: `${initial.width}px`,
      height: `${initial.height}px`,
      transform: "none",
    });

    const target = targetLogo?.getBoundingClientRect();
    const finishPosition = target ?? {
      left: window.innerWidth / 2 - 12,
      top: 8,
      width: 24,
      height: 24,
    };
    const deltaX = finishPosition.left - initial.left;
    const deltaY = finishPosition.top - initial.top;
    const scaleX = finishPosition.width / initial.width;
    const scaleY = finishPosition.height / initial.height;
    const travel = movingLogo.animate(
      [
        { transform: "translate3d(0, 0, 0) scale(1, 1)" },
        { transform: `translate3d(${deltaX}px, ${deltaY}px, 0) scale(${scaleX}, ${scaleY})` },
      ],
      { duration, easing: "cubic-bezier(0.45, 0, 0.55, 1)", fill: "forwards" },
    );
    const quoteFade = quoteElement.animate(
      [{ opacity: 1, transform: "translateY(0)" }, { opacity: 0, transform: "translateY(-16px)" }],
      { duration: reducedMotion ? 180 : 1_050, delay: reducedMotion ? 80 : 1_750, fill: "forwards" },
    );

    void travel.finished
      .then(async () => {
        if (cancelled) return;
        const fade = overlay.animate([{ opacity: 1 }, { opacity: 0 }], { duration: reducedMotion ? 100 : 650, fill: "forwards" });
        await fade.finished;
        if (!cancelled) onComplete();
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      travel.cancel();
      quoteFade.cancel();
    };
  }, [onComplete]);

  return (
    <div ref={overlayRef} className="fixed inset-0 z-[250] overflow-hidden bg-app" aria-label="oLooper startup">
      <div
        ref={movingLogoRef}
        className="fixed flex items-center justify-center rounded-full drop-shadow-[0_0_30px_rgba(74,163,255,0.3)]"
        style={{ left: "50%", top: "38%", width: 176, height: 176, transform: "translate(-50%, -50%)", transformOrigin: "top left" }}
        aria-hidden="true"
      >
        <div className="h-full w-full">
          <Logo className="h-full w-full object-contain" />
        </div>
      </div>
      <div ref={quoteRef} className="absolute left-1/2 top-[61%] w-[min(42rem,calc(100vw-3rem))] -translate-x-1/2 px-4 text-center">
        <p className="text-sm font-medium leading-relaxed text-text sm:text-base">“{quote.text}”</p>
        <p className="mt-3 text-[10px] uppercase tracking-[0.18em] text-accent">
          {quote.attribution}{quote.source ? ` · ${quote.source}` : ""}
        </p>
      </div>
    </div>
  );
}
