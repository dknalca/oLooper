/** Schedule only dirty frames, continuing at 30 Hz while paint requests motion. */
export function createWaveformAnimation(
  paint: (now: number) => boolean,
  environment = {
    request: (callback: FrameRequestCallback) => requestAnimationFrame(callback),
    cancel: (id: number) => cancelAnimationFrame(id),
    visible: () => !document.hidden,
  },
) {
  let frame: number | null = null;
  let disposed = false;
  let lastPaint = -Infinity;
  const schedule = () => {
    if (!disposed && frame === null && environment.visible()) frame = environment.request(draw);
  };
  const draw = (now: number) => {
    frame = null;
    if (disposed || !environment.visible()) return;
    if (now - lastPaint < 1000 / 30) { schedule(); return; }
    lastPaint = now;
    if (paint(now)) schedule();
  };
  return {
    invalidate() {
      if (!environment.visible() && frame !== null) { environment.cancel(frame); frame = null; }
      schedule();
    },
    dispose() {
      disposed = true;
      if (frame !== null) environment.cancel(frame);
      frame = null;
    },
  };
}
