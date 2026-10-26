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
- Assignable actions: Play/Pause, Stop, Previous/Next, Random Loop, Volume ±5%,
  Toggle Metronome, CUE 1–4, and Clear CUE 2–4. CUE 1 recalls the start of the track.
- Library navigation has a relative CC encoder or separate Up/Down buttons,
  plus Intro/Back buttons. The encoder or buttons select All tracks, Favorites,
  playlists, and loopers at the collection level, then loops within the selected
  collection. Intro enters a collection and then loads/plays the selected loop;
  Back returns from loops to the collection level and is a no-op at the
  collection level. Loop navigation wraps: moving up from the first loop selects
  the last, and moving down from the last selects the first. Encoder values below
  64 move down, values above 64 move up, and 0/64 are ignored.
- Assignments and the selected input/output IDs persist in local application storage;
  no SQLite migration is required.
- MIDI Options includes a preset selector with **Load preset**, **Save preset**,
  and **Save as**. Initial templates are `Custom_map`, `pioneerS11_map`, and
  `Rane72map`; all ship empty until verified hardware maps are available.
  Existing assignments migrate into `Custom_map`. Saved snapshots and the active
  working mapping persist independently, including edits not yet saved to a preset.
  Loading explicitly replaces current assignments and cancels MIDI Learn.
- **Import MIDI map** and **Export MIDI map** use native JSON file dialogs.
  Export includes current assignments, including unsaved edits. Import creates
  and activates a new saved preset; name collisions get a numeric suffix so
  existing presets are preserved. Cancellation leaves the mapping unchanged.
- Loading or importing binds all assignments to the currently connected MIDI
  input. Offline import is supported; connect an input and load that preset to
  activate it. Input/output connection preferences are separate from presets.
- Bundled templates live in `src/midi-presets/*.json`, using the same portable
  file format as exported maps, so verified maps can be integrated directly.
- A separately selected MIDI output sends Note On/Off or CC 127/0 feedback for
  assigned pads. Feedback is cleared when an assignment is removed or the output
  disconnects. Hardware determines whether/how these messages illuminate pads;
  RGB colors and vendor SysEx are not configured by oLooper.

## Architecture

- `src-tauri/src/midi.rs` owns MIDI input/output enumeration and connection and
  parses incoming channel messages. CC values, including zero releases, are
  forwarded to the frontend; the input callback never calls player or library
  commands directly.
- Tauri MIDI commands and the `olooper:midi-message` event are bridged through
  `src/tauri.ts`.
- App maps one-to-one bindings to an explicit `MidiAction` allowlist and invokes
  the same transport/cue operations as the UI.
- The library sidebar owns navigation state and playback selection; App routes
  encoder direction and Intro/Back commands to the sidebar.
- App gates button CC actions on 0→nonzero edges while forwarding every nonzero
  value from the relative library encoder.
- Random Loop uses the same library-random playback flow as the player control;
  Library Up/Down call the sidebar navigation directly.
- Volume bindings use the player controls' bounded operations; metronome toggle
  is routed to the TopBar-owned metronome state.
- MIDI Learn temporarily captures the next supported Note On or discrete CC
  press, then saves the binding locally.
- `src/midiMaps.ts` owns preset preference migration, versioned JSON validation,
  and device rebinding. `src-tauri/src/midi_map_files.rs` owns native dialogs and
  bounded reads/atomic writes. Reads and writes are limited to 64 KiB; import
  rejects unsupported versions/actions, duplicate controls, invalid channel/note
  ranges, and invalid names before changing active assignments.

## Portable map format (v1)

```json
{
  "format": "olooper-midi-map",
  "version": 1,
  "name": "pioneerS11_map",
  "bindings": {
    "play-pause": { "kind": "note", "channel": 1, "number": 60 }
  }
}
```

The example assignment illustrates the format, not a verified S11 control.
Bindings use the `MidiAction` IDs from `src/tauri.ts`, channels 1–16, note/CC
numbers 0–127, and `note` or `cc` kinds. Files omit local input IDs/names and
output device selection. Empty `bindings` is valid. Names are 1–80 characters.

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
- [x] MIDI encoder navigates library collections and loops; Intro loads/plays and
  Back returns to collections.
- [x] Loop navigation wraps at both ends of a collection.
- [x] Library Up/Down can be mapped as individual buttons instead of an encoder;
  Random Loop is a mappable action.
- [x] Volume ±5% and metronome toggle are mappable.
- [x] Consecutive relative encoder turns are received even when the controller
  sends no zero value between detents; button CCs still trigger once per press.
- [x] MIDI input parsing is unit-tested without physical hardware.
- [x] Empty named templates, preset save/load, and legacy preference migration.
- [x] Portable MIDI map import/export with validation and input rebinding.
- [ ] Assignments send discrete output feedback and clear their LEDs when removed.

## Non-goals

- Continuous CC/fader control, RGB color programming/vendor SysEx, Note Off actions, and multiple
  simultaneous MIDI inputs.
