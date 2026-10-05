import { describe, expect, it } from "vitest";
import { displayLibraryPath } from "./displayLibraryPath";

describe("displayLibraryPath", () => {
  it("hides the Windows extended-length prefix on local paths", () => {
    expect(displayLibraryPath("\\\\?\\C:\\Users\\DJ\\Music\\oLooper"))
      .toBe("C:\\Users\\DJ\\Music\\oLooper");
  });

  it("converts extended UNC paths to normal UNC paths", () => {
    expect(displayLibraryPath("\\\\?\\UNC\\server\\share\\oLooper"))
      .toBe("\\\\server\\share\\oLooper");
  });

  it("leaves ordinary paths unchanged", () => {
    expect(displayLibraryPath("/Users/DJ/Documents/oLooper_data"))
      .toBe("/Users/DJ/Documents/oLooper_data");
  });
});
