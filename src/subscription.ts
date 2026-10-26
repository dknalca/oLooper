/** Own an asynchronous subscription even if cleanup precedes registration. */
export function ownSubscription(registration: Promise<() => void>, onError: (error: unknown) => void = () => {}): () => void {
  let disposed = false;
  let release: (() => void) | undefined;
  const safeRelease = (off: () => void) => {
    try { off(); } catch (error) { if (!disposed) onError(error); }
  };
  void registration.then((off) => {
    if (disposed) safeRelease(off);
    else release = off;
  }, (error) => { if (!disposed) onError(error); });
  return () => { disposed = true; const off = release; release = undefined; if (off) safeRelease(off); };
}
