# ADR 0023 — Duration-aware tempo analysis and bounded reanalysis jobs

- Status: accepted
- Date: 2026-10-25

Release follow-up: DOC-A01–DOC-A06 are resolved in v0.8.0; the original follow-up
notes below describe the pre-fix review. See [release-0.8.0](../release-0.8.0.md).

## Context

Generic onset autocorrelation returns approximate tempi and can select a snare,
hi-hat or bar period. Most looper inputs already contain complete 4/4 phrases,
so their canonical PCM duration provides a more accurate tempo lattice, although
the number of bars and half/double-time interpretation remain ambiguous.

## Decision

- Keep generic estimation for arbitrary custom imports and AUTO. Introduce an
  explicit `PerfectLoop4_4` context for SWF/EXE preparation, unknown-tempo Tablist
  imports and user-requested library reanalysis.
- Generate candidate BPM as `240 * bars / (frames / rate)`, between 20 and 300,
  after existing canonical decode/trimming. Use full-track frames, not practice
  regions, rounded milliseconds or playback speed.
- Rank octave families using centered channel-energy onset correlation in at
  most three sixteen-second windows. A small conventional-phrase prior is not
  confidence evidence. Keep ambiguous estimates reviewable; prefer an octave
  representative within 65–150 when available.
- Reanalysis is an explicitly admitted, cancellable job on a separate connection
  owned by the captured library root. Permit one job globally, up to 100,000
  snapshot IDs, sequential decode and bounded error reports.
- Preserve confirmed/catalog/file-authored BPM. Revalidate the row and file
  identity under the library mutation mutex before committing an automatic value.
  No audio tags, cues, saved loops or playback controls are changed by the job.
- Subscribe before admission; progress carries root/job identity and a terminal
  partial report. Root switches cancel previous work. UI root/generation checks
  are intended to reject old results; DOC-A03 records a reproduced callback-ref
  race where the current implementation does not yet meet this decision.
- Individual metadata previews use the same canonical decoder and detector with
  one PCM-retaining preview at a time. They never persist or affect playback.
  The editor owns results by library generation, opening and draft revision.
- Half/original/double options are relative to an unchanged base and validate
  whole-bar interpretations before display rounding. Explicit selection,
  including unchanged original tempo, becomes manual only on Save.
- A title/tag-only metadata save preserves the latest catalog BPM rather than
  replaying a stale draft after concurrent reanalysis. Such saves do not trigger
  BPM tag synchronization.

## Consequences

- Closed loops receive sample-duration-derived tempo values without forcing the
  same assumption onto arbitrary recordings. Real fixtures are still needed to
  calibrate ranking and demonstrate an improvement beyond synthetic tests.
- Explicit reanalysis can update existing automatic values without reimporting
  audio, while preserving user edits made during analysis.
- Historical `analyzed` rows with no confidence are protected conservatively,
  since the current schema also uses that provenance for known Tablist values.
- A running guarded decode can delay another operation; completed updates survive
  cancellation. Partial counts distinguish protected, changed, absent-estimate
  and failed tracks.
- The follow-up audit reproduced unresolved manual/tag precedence and a
  root-scoped UI event race (DOC-A01–DOC-A04); they are not resolved by this ADR
  and must be fixed before treating the new BPM flow as audit-closed.

Implementation contracts and device-validation criteria are in specs 260 and 270.
