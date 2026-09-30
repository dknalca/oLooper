# ADR 0011 — MIDI input and discrete action mapping

- Status: accepted
- Date: 2026-09-29

## Context

Turntablists commonly use pad controllers for transport and cue triggering.
Mappings should be learnable in-app and survive restarts without adding MIDI
behavior to the audio thread.

## Decision

- Use `midir` for MIDI input discovery and a single active input connection.
- Accept USB, Bluetooth, and virtual inputs through the operating system's MIDI
  backend; device pairing/creation remains an operating-system responsibility.
- Parse Note On (nonzero velocity) and discrete CC presses (0 → nonzero; re-arm
  on zero). Ignore Note Off, zero-velocity Note On, continuous CC changes, and
  unsupported message types.
- Keep MIDI input callbacks limited to parsing and emitting
  `olooper:midi-message`. The frontend maps messages through a closed set of
  `MidiAction` values to existing app commands.
- Persist device identity and one-to-one action bindings in local application
  storage; no MIDI data or device dependency enters the SQLite catalog.
- Expose device selection and MIDI Learn in **oLooper → MIDI Options…**.

## Consequences

- Transport, cue, loop, AUTO, speed, and navigation actions can be driven from
  Note On or discrete CC controls.
- MIDI routing remains independent of audio device/output selection.
- Continuous faders, MIDI output, and concurrent input devices require separate
  design and testing before support is added.
