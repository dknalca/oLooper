/** Poll serially: a slow native request cannot build an unbounded IPC backlog. */
export function startPolling(task: () => Promise<void>, intervalMs: number, immediate = true): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const poll = async () => {
    try {
      await task();
    } catch {
      // A transient failure must not stop subsequent status updates.
    } finally {
      if (!stopped) timer = setTimeout(() => void poll(), intervalMs);
    }
  };
  if (immediate) void poll();
  else timer = setTimeout(() => void poll(), intervalMs);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
