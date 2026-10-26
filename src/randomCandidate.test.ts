import { expect, it } from "vitest";
import { takeRandomCandidate } from "./randomCandidate";
import type { Track } from "./tauri";

const track = (id: number, exists = true): Track => ({ id, exists }) as Track;

it("uses a prepared target only for the same scope and not the current track", () => {
  const candidate = { track: track(2), key: "0|local|" };
  expect(takeRandomCandidate(candidate, "0|local|", 1)?.id).toBe(2);
  expect(takeRandomCandidate(candidate, "1|local|", 1)).toBeNull();
  expect(takeRandomCandidate(candidate, "0|local|", 2)).toBeNull();
  expect(takeRandomCandidate({ track: track(2, false), key: "0|local|" }, "0|local|", 1)).toBeNull();
  expect(takeRandomCandidate(null, "0|local|", 1)).toBeNull();
});
