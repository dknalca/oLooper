import { expect, it } from "vitest";
import { prepareTrackMetadata } from "./trackMetadata";

const draft = { title: "  Beat  ", bpm: "98", tags: "  funk, loop  " };

it("trims metadata while keeping an unchanged BPM unconfirmed", () => {
  expect(prepareTrackMetadata(draft, 98, false)).toEqual({
    ok: true, title: "Beat", bpm: 98, tags: "funk, loop", confirmManualBpm: false,
  });
});

it("confirms a changed BPM or an explicitly confirmed unchanged BPM", () => {
  expect(prepareTrackMetadata(draft, 100, false)).toMatchObject({ ok: true, bpm: 98, confirmManualBpm: true });
  expect(prepareTrackMetadata(draft, 98, true)).toMatchObject({ ok: true, bpm: 98, confirmManualBpm: true });
});

it.each([null, 98])("an empty BPM retains %s without confirming it", (current) => {
  expect(prepareTrackMetadata({ ...draft, bpm: "   " }, current, true)).toMatchObject({
    ok: true, bpm: current, confirmManualBpm: false,
  });
});

it.each(["20", "300", "120.5"])("accepts valid BPM %s", (bpm) => {
  expect(prepareTrackMetadata({ ...draft, bpm }, null, false)).toMatchObject({
    ok: true, bpm: Number(bpm), confirmManualBpm: true,
  });
});

it.each(["19.99", "300.01", "NaN", "Infinity", "abc"])("rejects invalid BPM %s", (bpm) => {
  expect(prepareTrackMetadata({ ...draft, bpm }, null, false)).toEqual({ ok: false, error: "BPM must be between 20 and 300." });
});

it("reports an empty title before validating the BPM", () => {
  expect(prepareTrackMetadata({ ...draft, title: "  ", bpm: "bad" }, null, false)).toEqual({
    ok: false, error: "Loop title cannot be empty.",
  });
});
