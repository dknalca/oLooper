/** One random action and one clock shared by manual and timed playback. */
export function createRandomPlayback(options: {
  action: () => Promise<void>;
  onRemaining: (seconds: number | null) => void;
  onSuccess: () => void;
  onError: (error: unknown) => void;
}) {
  let intervalMs: number | null = null;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let pending: Promise<void> | null = null;

  const clear = () => {
    clearTimeout(timeout);
    clearInterval(ticker);
  };
  const schedule = () => {
    clear();
    if (intervalMs === null) {
      options.onRemaining(null);
      return;
    }
    const deadline = Date.now() + intervalMs;
    const update = () => options.onRemaining(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    update();
    ticker = setInterval(update, 1000);
    timeout = setTimeout(() => void trigger(), intervalMs);
  };
  const trigger = (): Promise<void> => {
    if (pending) return pending;
    clear();
    if (intervalMs !== null) options.onRemaining(0);
    pending = Promise.resolve()
      .then(() => options.action())
      .then(options.onSuccess, options.onError)
      .finally(() => {
        pending = null;
        schedule();
      });
    return pending;
  };

  return {
    trigger,
    configure(nextIntervalMs: number | null) {
      intervalMs = nextIntervalMs;
      clear();
      if (!pending) schedule();
      else options.onRemaining(intervalMs === null ? null : 0);
    },
  };
}
