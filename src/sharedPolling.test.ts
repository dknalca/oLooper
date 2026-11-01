import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSharedPolling } from "./sharedPolling";

const stops: (() => void)[] = [];
const keep = (stop: () => void) => { stops.push(stop); return stop; };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => { stops.splice(0).forEach((stop) => stop()); vi.useRealTimers(); });

it("does no work without consumers and preserves the delayed first read", async () => {
  const read = vi.fn().mockResolvedValue(1);
  const receive = vi.fn();
  const polling = createSharedPolling<number>(read);
  await vi.advanceTimersByTimeAsync(1000);
  expect(read).not.toHaveBeenCalled();
  const stop = keep(polling.subscribe(() => receive, 250, false));
  await vi.advanceTimersByTimeAsync(249);
  expect(read).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledOnce();
  expect(receive).toHaveBeenCalledExactlyOnceWith(1);
  stop();
  stop();
  await vi.advanceTimersByTimeAsync(1000);
  expect(read).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("shares the fastest cadence rather than adding 100 ms and 250 ms poll loops", async () => {
  const read = vi.fn().mockResolvedValue(1);
  const slow = vi.fn();
  const fast = vi.fn();
  const polling = createSharedPolling<number>(read);
  keep(polling.subscribe(() => slow, 250, false));
  const stopFast = keep(polling.subscribe(() => fast, 100));
  await vi.advanceTimersByTimeAsync(250);
  expect(slow).toHaveBeenCalledOnce();
  expect(read).toHaveBeenCalledTimes(4); // 0, 100, 200, delayed first at 250.
  read.mockClear(); slow.mockClear(); fast.mockClear();
  await vi.advanceTimersByTimeAsync(1000);
  expect(read).toHaveBeenCalledTimes(10);
  expect(slow).toHaveBeenCalledTimes(10);
  expect(fast).toHaveBeenCalledTimes(10);
  stopFast();
  read.mockClear(); slow.mockClear();
  await vi.advanceTimersByTimeAsync(249);
  expect(read).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledOnce();
  expect(slow).toHaveBeenCalledOnce();
  expect(fast).toHaveBeenCalledTimes(10);
});

it("never overlaps slow reads or accumulates missed timer ticks", async () => {
  const pending = deferred<number>();
  const read = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(2);
  const receive = vi.fn();
  const polling = createSharedPolling<number>(read);
  keep(polling.subscribe(() => receive, 100));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(read).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  pending.resolve(1);
  await vi.advanceTimersByTimeAsync(0);
  expect(receive).toHaveBeenCalledExactlyOnceWith(1);
  await vi.advanceTimersByTimeAsync(99);
  expect(read).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(2);
});

it("a consumer joining an in-flight read waits for its own fresh request", async () => {
  const first = deferred<number>();
  const second = deferred<number>();
  const read = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const oldReceive = vi.fn();
  const newReceive = vi.fn();
  const prepareNew = vi.fn(() => newReceive);
  const polling = createSharedPolling<number>(read);
  keep(polling.subscribe(() => oldReceive, 250));
  await vi.advanceTimersByTimeAsync(50);
  keep(polling.subscribe(prepareNew, 100));
  await vi.advanceTimersByTimeAsync(500);
  expect(read).toHaveBeenCalledOnce();
  expect(prepareNew).not.toHaveBeenCalled();
  first.resolve(1);
  await vi.advanceTimersByTimeAsync(0);
  expect(oldReceive).toHaveBeenCalledExactlyOnceWith(1);
  expect(newReceive).not.toHaveBeenCalled();
  expect(read).toHaveBeenCalledTimes(2);
  second.resolve(2);
  await vi.advanceTimersByTimeAsync(0);
  expect(newReceive).toHaveBeenCalledExactlyOnceWith(2);
  expect(oldReceive).toHaveBeenLastCalledWith(2);
});

it("closing and reopening during a read cannot deliver the old subscription's result", async () => {
  const pending = deferred<number>();
  const read = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(2);
  const receive = vi.fn();
  const polling = createSharedPolling<number>(read);
  const close = keep(polling.subscribe(() => receive, 100));
  close();
  keep(polling.subscribe(() => receive, 100));
  expect(read).toHaveBeenCalledOnce();
  pending.resolve(1);
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(2);
  expect(receive).toHaveBeenCalledExactlyOnceWith(2);
});

it("removing the last consumer suppresses late results and all future polling", async () => {
  const pending = deferred<number>();
  const read = vi.fn().mockReturnValue(pending.promise);
  const receive = vi.fn();
  const polling = createSharedPolling<number>(read);
  const stop = keep(polling.subscribe(() => receive, 100));
  stop();
  pending.resolve(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(receive).not.toHaveBeenCalled();
  expect(read).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("captures ownership before each read, not after a newer track opens", async () => {
  const pending = deferred<number>();
  const read = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(2);
  const receive = vi.fn();
  const polling = createSharedPolling<number>(read);
  let owner = 1;
  keep(polling.subscribe(() => {
    const requestedOwner = owner;
    return (value) => { if (owner === requestedOwner) receive(value); };
  }, 100));
  owner = 2;
  pending.resolve(1);
  await vi.advanceTimersByTimeAsync(0);
  expect(receive).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(100);
  expect(receive).toHaveBeenCalledExactlyOnceWith(2);
});

it("retries transient IPC failures without replaying a previous successful value", async () => {
  const read = vi.fn().mockResolvedValueOnce(1).mockRejectedValueOnce(new Error("busy")).mockResolvedValue(3);
  const receive = vi.fn();
  const polling = createSharedPolling<number>(read);
  keep(polling.subscribe(() => receive, 100));
  await vi.advanceTimersByTimeAsync(200);
  expect(read).toHaveBeenCalledTimes(3);
  expect(receive.mock.calls).toEqual([[1], [3]]);
});

it("isolates failed preparations and receivers from the other consumers", async () => {
  const read = vi.fn().mockResolvedValue(1);
  const receive = vi.fn();
  const polling = createSharedPolling<number>(read);
  keep(polling.subscribe(() => { throw new Error("prepare failed"); }, 100, false));
  keep(polling.subscribe(() => () => { throw new Error("receiver failed"); }, 100, false));
  keep(polling.subscribe(() => receive, 100, false));
  await vi.advanceTimersByTimeAsync(200);
  expect(read).toHaveBeenCalledTimes(2);
  expect(receive).toHaveBeenCalledTimes(2);
});

it("checks removal again before each receiver, even when another receiver closes it", async () => {
  const read = vi.fn().mockResolvedValue(1);
  const removed = vi.fn();
  const polling = createSharedPolling<number>(read);
  let close = () => {};
  keep(polling.subscribe(() => () => close(), 100, false));
  close = keep(polling.subscribe(() => removed, 100, false));
  await vi.advanceTimersByTimeAsync(100);
  expect(read).toHaveBeenCalledOnce();
  expect(removed).not.toHaveBeenCalled();
});

it("does not retain or replay a snapshot across idle periods", async () => {
  const read = vi.fn().mockResolvedValueOnce(1).mockResolvedValue(2);
  const receive = vi.fn();
  const polling = createSharedPolling<number>(read);
  const stop = keep(polling.subscribe(() => receive, 100));
  await vi.advanceTimersByTimeAsync(0);
  stop();
  receive.mockClear();
  keep(polling.subscribe(() => receive, 100, false));
  await vi.advanceTimersByTimeAsync(99);
  expect(receive).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(receive).toHaveBeenCalledExactlyOnceWith(2);
});

it("uses a monotonic cadence independent of wall-clock changes", async () => {
  const read = vi.fn().mockResolvedValue(1);
  const polling = createSharedPolling<number>(read);
  keep(polling.subscribe(() => () => {}, 100));
  await vi.advanceTimersByTimeAsync(0);
  vi.setSystemTime(new Date("2000-01-01"));
  await vi.advanceTimersByTimeAsync(100);
  expect(read).toHaveBeenCalledTimes(2);
});

it.each([0, -1, NaN, Infinity, 2_147_483_648])("rejects invalid timer duration %s", (interval) => {
  const read = vi.fn();
  const polling = createSharedPolling<number>(read);
  expect(() => polling.subscribe(() => () => {}, interval)).toThrow(RangeError);
  expect(read).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
