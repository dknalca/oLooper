# ADR 0026 — Keep macOS releases unsigned

- Status: accepted
- Date: 2026-10-26

## Context

Developer ID signing and notarization require an active Apple Developer Program
membership, certificate/key custody and a notarization credential in release CI.
The project owner has decided not to purchase or use that membership.

## Decision

- Publish the Universal 2 macOS app and DMG unsigned and unnotarized as a standing
  release policy. Do not add signing identities, notarization credentials or
  automated signing steps to GitHub Actions.
- Explain the first-launch Gatekeeper exception in the README: Control-click the
  app and choose Open; if needed, use Open Anyway in Privacy & Security. Scope the
  exception to oLooper; never tell users to disable Gatekeeper globally.
- Keep CI checks for Universal 2 architecture, minimum deployment target,
  successful bundling and DMG integrity. These checks do not claim an Apple
  Developer ID, notarization, or physical-device validation.

## Consequences

- macOS warns that it cannot verify oLooper on first launch. Users approve the
  app locally using the documented Gatekeeper flow.
- Updating source code or release versions does not imply signing. A future
  change to this policy requires explicit owner approval and a separate decision
  about certificate ownership, CI secrets and notarization.
