type Receiver<T> = (value: T) => void;

interface Consumer<T> {
  prepare: () => Receiver<T>;
  intervalMs: number;
  firstAt: number;
  started: boolean;
}

/** Fresh values at the fastest requested cadence for all started consumers.
 * No cached replay; commands and one-shot reads stay separate.
 */
export function createSharedPolling<T>(read: () => Promise<T>) {
  const consumers = new Set<Consumer<T>>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let finishedAt = 0;

  const schedule = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (running || consumers.size === 0) return;
    let nextAt = Infinity;
    for (const consumer of consumers) {
      nextAt = Math.min(nextAt, consumer.started
        ? finishedAt + consumer.intervalMs : consumer.firstAt);
    }
    const delay = Math.ceil(Math.max(0, nextAt - performance.now()));
    if (delay === 0) void poll();
    else timer = setTimeout(() => { timer = null; void poll(); }, delay);
  };

  const poll = async () => {
    running = true;
    const now = performance.now();
    const receivers: { consumer: Consumer<T>; receive: Receiver<T> }[] = [];
    for (const consumer of consumers) {
      if (!consumer.started && consumer.firstAt > now) continue;
      consumer.started = true;
      try {
        // Capture playback ownership when THIS request starts, not at delivery.
        receivers.push({ consumer, receive: consumer.prepare() });
      } catch {
        // One consumer must not stop the others or the next polling attempt.
      }
    }
    try {
      if (receivers.length === 0) return;
      const value = await read();
      for (const { consumer, receive } of receivers) {
        if (!consumers.has(consumer)) continue;
        try { receive(value); } catch { /* Isolate consumer failures. */ }
      }
    } catch {
      // Match serial polling: transient IPC errors do not stop future attempts.
    } finally {
      finishedAt = performance.now();
      running = false;
      schedule();
    }
  };

  return {
    subscribe(prepare: () => Receiver<T>, intervalMs: number, immediate = true): () => void {
      if (!Number.isFinite(intervalMs) || intervalMs <= 0 || intervalMs > 2_147_483_647) {
        throw new RangeError("poll interval must be a positive timer duration");
      }
      const consumer: Consumer<T> = {
        prepare, intervalMs, started: false,
        firstAt: performance.now() + (immediate ? 0 : intervalMs),
      };
      consumers.add(consumer);
      schedule();
      return () => { if (consumers.delete(consumer)) schedule(); };
    },
  };
}
