import { expect, it, vi } from "vitest";
import { ownSubscription } from "./subscription";

it("releases a native subscription which resolves after unmount", async () => {
  let resolve!: (off: () => void) => void;
  const registration = new Promise<() => void>((done) => { resolve = done; });
  const stop = ownSubscription(registration);
  stop();
  const off = vi.fn();
  resolve(off);
  await registration;
  expect(off).toHaveBeenCalledTimes(1);
  stop();
  expect(off).toHaveBeenCalledTimes(1);
});
