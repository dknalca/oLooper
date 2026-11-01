# 300 — Lightweight derived UI without audio-engine changes

## Scope

Reduce accessory IPC, image retention, waveform work and repeated public catalog
searches. This increment changes frontend-derived state only: it must not change
PCM, sample rates, output buffers, transport commands, pitch algorithms, native
loop-boundary switching or import completion/cancellation protocols.

## Behavior

1. Persisting playback history from Sidebar does not reload tracks, playlists
   or looper ordering. Explicit catalog changes and load-error reconciliation
   retain their existing refresh behavior.
2. Active cover and sidebar thumbnails share an app-owned image cache. Requests
   are scoped by library generation and explicit catalog refresh revision.
   Older consumers cannot move the cache back to a previous scope.
3. Cache at most 64 completed cover results and 4 Mi characters of data URLs
   (an approximate 8 MiB UTF-16 string budget, not a total image-memory bound).
   Keep at most four native cover requests active. Reuse pending requests and
   evict least-recently-used completed entries. Individually oversized responses
   may be displayed by their consumer but are not retained in the shared cache.
4. Cache absent images for 15 seconds and present images for 60 seconds; explicit
   scope revision changes invalidate both immediately. Expiry is checked on the
   next read, not by a periodic background timer. Failed reads are not cached.
5. With IntersectionObserver, request thumbnails only while visible or within
   a 100 px prefetch margin; release the consumer's image when it leaves that
   region. Older environments without the observer retain eager loading as a
   compatibility fallback, with the same shared-cache and concurrency limits.
6. Waveform invalidation follows path, track ID and native audio generation, not
   general catalog refresh. Keep at most four peak resolutions in memory for
   the current loaded generation. This also benefits virtual embedded paths
   without creating audio files or claiming a persistent embedded cache.
7. Choose power-of-two peak resolutions between 256 and 8192 buckets, rounded
   up from the requested display density. Serialize native peak requests for
   the mounted waveform, and skip replaced queued requests. An invoked Rust
   operation may still finish; discard its stale result before publication.
8. Draw on changes while paused and continue at at most 30 Hz during playback.
   Do not keep scheduling frames in hidden documents or while the idle cover
   is fully visible. Redraw on return, resize, peaks, CUEs, loop preview, zoom
   and status changes. This suspension must never pause native playback,
   metronome, Random switching or status/error monitoring.
9. Visual position interpolation excludes paused time and uses active-buffer
   playback speed (1x with pitch lock). It does not command the audio engine.
10. Cache up to eight recently visited public Tablist pages for 30 seconds per
    mounted catalog. Continue refreshing library-owned download counts normally.
    Expired pages and failed requests must not be reused. No remote-page IPC,
    authentication or URL-validation behavior changes.

## Regression coverage

- Shared/pending/negative cover reads; LRU and size bounds; concurrency; obsolete
  libraries and queued requests; invisible thumbnail release.
- Playback persists history without a second full catalog fetch.
- Peak zoom reuse on embedded paths, generation invalidation, delayed results
  and suppression of intermediate queued zooms.
- Static versus continuous frame scheduling, 30 Hz limit, visibility, cover
  suspension, CUE invalidation and pitch-lock/pause interpolation.
- Tablist page reuse and expiry, plus existing import and ownership regressions.

## Validation limits and remaining work

Automated DOM tests count requests and scheduled work; they do not measure real
CPU/RAM savings or prove audio continuity on physical devices. Native A/B stress
validation remains necessary before making performance/continuity claims.

Outside this increment: incremental database APIs, a single player-status
coordinator, native Tablist webview cancellation/reuse, persistent embedded
peak keys, layered waveform drawing, decode-copy removal, worker priorities,
scrub coalescing, logger changes and callback/handoff redesign.
