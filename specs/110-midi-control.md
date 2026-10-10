# 110 — MIDI Controller Input

## Goal

Let users map MIDI pads/buttons to oLooper actions from **oLooper → MIDI
Options…**, with assignments remembered locally.

## User-visible behavior

- List available MIDI inputs, connect one input at a time, disconnect it, and
  restore the selected input on the next app launch when it is still available.
  USB and Bluetooth devices are supported when the operating system exposes
  them as MIDI inputs; Bluetooth pairing happens in system settings, then the
  user refreshes this list.
- **Learn** records a pad/button for a selected action. The assignment shows the
  input, channel, message type, and note/CC number. Learning a control already
  assigned elsewhere moves that binding to the new action.
- Note On with nonzero velocity triggers once per message; Note Off and
  zero-velocity Note On are ignored.
- CC is discrete: a transition from 0 to nonzero triggers once; a value of 0
  re-arms that control. Continuous CC values do not drive parameters.
- Assignable actions: Play/Pause, Stop, Previous/Next, Toggle Loop, AUTO loop,
  Speed ±5%, CUE 1–4, and Clear CUE 2–4. CUE 1 recalls the start of the track.
- Assignments and the selected input/output IDs persist in local application storage;
  no SQLite migration is required.
- A separately selected MIDI output sends Note On/Off or CC 127/0 feedback for
  assigned pads. Feedback is cleared when an assignment is removed or the output
  disconnects. Hardware determines whether/how these messages illuminate pads;
  RGB colors and vendor SysEx are not configured by oLooper.

## Architecture

- `src-tauri/src/midi.rs` owns MIDI input/output enumeration and connection and
  parses incoming channel messages. The input callback emits data only; it never
  calls player or library commands directly.
- Tauri MIDI commands and the `olooper:midi-message` event are bridged through
  `src/tauri.ts`.
- App maps one-to-one bindings to an explicit `MidiAction` allowlist and invokes
  the same transport/cue operations as the UI.
- MIDI Learn temporarily captures the next supported Note On or discrete CC
  press, then saves the binding locally.

## Failure behavior

- No available input, a disconnected device, or a failed connection is shown in
  MIDI Options; mappings remain saved when hardware is unavailable.
- Messages outside the supported Note On/CC subset are ignored.

## Acceptance criteria

- [x] MIDI inputs can be listed, connected, disconnected, and restored by ID.
- [x] OS-exposed Bluetooth MIDI inputs use the same device flow as USB.
- [x] MIDI Learn binds Note On and CC controls to supported app actions.
- [x] CC assignments trigger only on a zero-to-nonzero transition.
- [x] Duplicate control assignments move to the most recently learned action.
- [x] MIDI input parsing is unit-tested without physical hardware.
- [ ] Assignments send discrete output feedback and clear their LEDs when removed.

## Non-goals

- Continuous CC/fader control, RGB color programming/vendor SysEx, Note Off actions, and multiple
  simultaneous MIDI inputs.
