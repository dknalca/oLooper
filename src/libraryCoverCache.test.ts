import { afterEach, expect, it, vi } from "vitest";
import { createLibraryCoverCache } from "./libraryCoverCache";

afterEach(() => vi.useRealTimers());
const scope = { generation: 1, revision: 0 };

it("shares pending reads and caches missing covers until expiry or explicit refresh", async () => {
  vi.useFakeTimers();
  const load = vi.fn().mockResolvedValue(null);
  const cache = createLibraryCoverCache(load);
  const first = cache.get(scope, "pack");
  expect(cache.get(scope, "pack")).toBe(first);
  await first;
  await cache.get(scope, "pack");
  expect(load).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(15_001);
  await cache.get(scope, "pack");
  expect(load).toHaveBeenCalledTimes(2);
  await cache.get({ ...scope, revision: 1 }, "pack");
  expect(load).toHaveBeenCalledTimes(3);
});

it("bounds concurrent IPC reads and continues after a failed image", async () => {
  const pending = new Map<string, { resolve: (value: string) => void; reject: (error: Error) => void }>();
  const load = vi.fn((hash: string) => new Promise<string>((resolve, reject) => pending.set(hash, { resolve, reject })));
  const cache = createLibraryCoverCache(load);
  const reads = Array.from({ length: 5 }, (_, i) => cache.get(scope, String(i)));
  const results = Promise.allSettled(reads);
  expect(load).toHaveBeenCalledTimes(4);
  pending.get("0")!.reject(new Error("missing"));
  await reads[0].catch(() => {});
  await Promise.resolve();
  expect(load).toHaveBeenCalledTimes(5);
  for (const [hash, request] of pending) if (hash !== "0") request.resolve(hash);
  expect((await results).filter((value) => value.status === "fulfilled")).toHaveLength(4);
});

it("never populates a new scope with an older response and skips obsolete queued reads", async () => {
  let finish!: (value: string) => void;
  const load = vi.fn().mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; })).mockResolvedValue("new");
  const cache = createLibraryCoverCache(load, { concurrency: 1, entries: 4, characters: 100 });
  const old = cache.get(scope, "same");
  const skipped = cache.get(scope, "obsolete");
  const nextScope = { generation: 2, revision: 1 };
  const next = cache.get(nextScope, "same");
  finish("old");
  await old;
  expect(await skipped).toBeNull();
  expect(await next).toBe("new");
  expect(await cache.get(nextScope, "same")).toBe("new");
  expect(await cache.get(scope, "same")).toBeNull();
  expect(load.mock.calls).toEqual([["same"], ["same"]]);
});

it("evicts by entry count and character budget using least-recently-used order", async () => {
  const load = vi.fn((hash: string) => Promise.resolve(hash.repeat(3)));
  const cache = createLibraryCoverCache(load, { concurrency: 4, entries: 2, characters: 6 });
  await cache.get(scope, "a");
  await cache.get(scope, "b");
  await cache.get(scope, "a");
  await cache.get(scope, "c");
  await cache.get(scope, "a");
  expect(load.mock.calls).toEqual([["a"], ["b"], ["c"]]);
  await cache.get(scope, "b");
  expect(load).toHaveBeenCalledTimes(4);
  // An individually oversized response can be displayed, but is never retained.
  await cache.get(scope, "large");
  await cache.get(scope, "large");
  expect(load).toHaveBeenCalledTimes(6);
});
