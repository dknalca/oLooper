// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_IDLE_COVER_DELAY_MINUTES, IDLE_COVER_DELAY_KEY, IDLE_COVER_KEY, idleCoverDelayMs, readIdleCoverDelayMinutes, readIdleCoverEnabled, saveIdleCoverDelayMinutes, saveIdleCoverEnabled } from "./appPreferences";

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });
it("defaults on, rejects corrupt preferences and persists an explicit choice", () => {
  expect(readIdleCoverEnabled()).toBe(true);
  localStorage.setItem(IDLE_COVER_KEY, "corrupt");
  expect(readIdleCoverEnabled()).toBe(false);
  expect(saveIdleCoverEnabled(true)).toBeNull();
  expect(readIdleCoverEnabled()).toBe(true);
  expect(saveIdleCoverEnabled(false)).toBeNull();
  expect(readIdleCoverEnabled()).toBe(false);
});
it("storage errors do not prevent startup and explain session-only changes", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("unavailable"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("unavailable"); });
  expect(readIdleCoverEnabled()).toBe(true);
  expect(saveIdleCoverEnabled(true)).toContain("this session");
  expect(readIdleCoverDelayMinutes()).toBe(DEFAULT_IDLE_COVER_DELAY_MINUTES);
  expect(saveIdleCoverDelayMinutes(10)).toContain("this session");
});

it("defaults the screensaver delay to two minutes and persists a valid minute choice", () => {
  expect(readIdleCoverDelayMinutes()).toBe(DEFAULT_IDLE_COVER_DELAY_MINUTES);
  expect(idleCoverDelayMs(readIdleCoverDelayMinutes())).toBe(120_000);
  expect(saveIdleCoverDelayMinutes(15)).toBeNull();
  expect(readIdleCoverDelayMinutes()).toBe(15);
  expect(idleCoverDelayMs(15)).toBe(900_000);
  expect(saveIdleCoverDelayMinutes(4)).toContain("between 1 and 60");
  localStorage.setItem(IDLE_COVER_DELAY_KEY, "999");
  expect(readIdleCoverDelayMinutes()).toBe(DEFAULT_IDLE_COVER_DELAY_MINUTES);
});
