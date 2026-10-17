import { describe, expect, it } from "vitest";
import { copySourcePreference, elapsedLabel, fileName, importKindForPath } from "./importFlow";

describe("import flow helpers", () => {
  it("copies containers only when the saved preference is explicitly enabled", () => {
    expect(copySourcePreference(null)).toBe(false);
    expect(copySourcePreference("false")).toBe(false);
    expect(copySourcePreference("invalid")).toBe(false);
    expect(copySourcePreference("true")).toBe(true);
  });
  it("routes SWF and EXE case-insensitively while keeping audio separate", () => {
    expect(importKindForPath("/drop/Looper.SWF")).toBe("swf");
    expect(importKindForPath("C:\\drop\\Looper.exe")).toBe("exe");
    expect(importKindForPath("/drop/loop.wav")).toBe("audio");
  });

  it("formats file names and elapsed durations for progress summaries", () => {
    expect(fileName("C:\\drop\\Looper.exe")).toBe("Looper.exe");
    expect(elapsedLabel(65)).toBe("1:05");
  });
});
