import { useEffect, useRef, type MutableRefObject } from "react";
import { playerWaveformPeaks, type WaveformData } from "../tauri";

interface Options {
  loadedPath: string | null;
  loading: boolean | undefined;
  generation?: number;
  zoom: number;
  trackId: number | null;
  wrapRef: MutableRefObject<HTMLDivElement | null>;
  waveRef: MutableRefObject<WaveformData | null>;
  waveTrackIdRef: MutableRefObject<number | null>;
  wavePathRef: MutableRefObject<string | null>;
  setGenerating: (value: boolean) => void;
  setError: (value: string | null) => void;
  onReady?: () => void;
}

/** Fetch peaks after playback is ready and discard requests from old views. */
export function useWaveformPeaks({ loadedPath, loading, generation = 0, zoom, trackId, wrapRef, waveRef, waveTrackIdRef, wavePathRef, setGenerating, setError, onReady }: Options) {
  const cache = useRef({ key: "", values: new Map<number, WaveformData>() });
  const queue = useRef(Promise.resolve());
  const key = JSON.stringify([loadedPath, trackId, generation]);
  if (cache.current.key !== key) cache.current = { key, values: new Map() };
  useEffect(() => {
    if (!loadedPath || loading) {
      if (!loadedPath) waveRef.current = null;
      return;
    }
    let cancelled = false;
    const currentCache = cache.current;
    const timer = window.setTimeout(() => {
      const width = wrapRef.current?.clientWidth ?? 800;
      const density = window.devicePixelRatio || 1;
      // Stable resolution levels avoid one native cache entry per pixel width.
      const buckets = Math.min(8192, 2 ** Math.ceil(Math.log2(Math.max(256, width * density * zoom))));
      setGenerating(true);
      // At most one native request; replaced queued views never start work.
      queue.current = queue.current.then(async () => {
          if (cancelled) return;
          const wave = currentCache.values.get(buckets) ?? await playerWaveformPeaks(loadedPath, buckets);
          if (cache.current === currentCache) {
            currentCache.values.delete(buckets);
            currentCache.values.set(buckets, wave);
            if (currentCache.values.size > 4) currentCache.values.delete(currentCache.values.keys().next().value!);
          }
          if (cancelled || cache.current !== currentCache) return;
          waveRef.current = wave;
          waveTrackIdRef.current = trackId;
          wavePathRef.current = loadedPath;
          setError(null);
          onReady?.();
        })
        .catch((error) => {
          if (cancelled) return;
          // A newer track owns the work, or the previous peaks remain valid.
          if (String(error).includes("track changed")) return;
          setError(String(error));
        })
        .finally(() => { if (!cancelled) setGenerating(false); });
    }, 120);
    return () => {
      cancelled = true;
      setGenerating(false);
      window.clearTimeout(timer);
    };
  }, [loadedPath, loading, generation, zoom, trackId, wrapRef, waveRef, waveTrackIdRef, wavePathRef, setGenerating, setError, onReady]);
}
