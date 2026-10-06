# 180 — Animated startup intro and scratch quote

## Scope

Show a brief branded opening animation on app launch without delaying library
initialization or audio readiness.

## User-visible behavior

- Start with the oLooper logo large and centered, then animate it down to the
  logo's normal position in the main toolbar.
- Show one random scratcher quote from the curated list beneath the large logo,
  with its supplied author and source attribution where provided.
- Fade the quote before the logo reaches the toolbar, then fade the intro layer
  so the live app is revealed underneath.
- Respect the system reduced-motion preference with a shorter transition.

## Acceptance criteria

- [ ] Each app launch chooses one quote and displays the correct attribution.
- [ ] The logo lands over the toolbar logo without leaving a second logo or
  blocking the app after the intro completes.
- [ ] Library setup and audio initialization continue while the intro animates.
