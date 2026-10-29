import { expect, it } from "vitest";
import { coverOriginTransform, fitCover } from "./coverGeometry";

it("fits a wide image and centers it vertically", () => {
  expect(fitCover({ width: 1000, height: 800 }, { width: 800, height: 400 })).toEqual({
    width: 1000, height: 500, left: 0, top: 150,
  });
});

it("fits a tall image and centers it horizontally", () => {
  expect(fitCover({ width: 1000, height: 800 }, { width: 400, height: 800 })).toEqual({
    width: 400, height: 800, left: 300, top: 0,
  });
});

it("centers a scaled image within the original cover rectangle", () => {
  const frame = fitCover({ width: 1000, height: 800 }, { width: 800, height: 400 });
  expect(coverOriginTransform(frame, { left: 20, top: 30, width: 100, height: 100 }))
    .toBe("translate(20px, -95px) scale(0.1)");
});

it("uses the fade fallback if the origin is missing or has no visible area", () => {
  const frame = { left: 0, top: 150, width: 1000, height: 500 };
  expect(coverOriginTransform(frame, null)).toBeNull();
  expect(coverOriginTransform(frame, { left: 10, top: 10, width: 0, height: 50 })).toBeNull();
  expect(coverOriginTransform(frame, { left: 10, top: 10, width: 50, height: 0 })).toBeNull();
});
