// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createLibraryCoverCache } from "../libraryCoverCache";
import { useLibraryCover } from "./useLibraryCover";

afterEach(cleanup);
it("coalesces readers and prevents old-library images appearing during a switch", async () => {
  let finishOld!: (value: string) => void;
  const load = vi.fn().mockImplementationOnce(() => new Promise<string>((resolve) => { finishOld = resolve; })).mockResolvedValue("new");
  const cache = createLibraryCoverCache(load);
  const first = renderHook(({ generation }) => useLibraryCover(cache, { generation, revision: 0 }, "same"), { initialProps: { generation: 1 } });
  const second = renderHook(({ generation }) => useLibraryCover(cache, { generation, revision: 0 }, "same"), { initialProps: { generation: 1 } });
  expect(load).toHaveBeenCalledTimes(1);
  first.rerender({ generation: 2 });
  second.rerender({ generation: 2 });
  expect(first.result.current).toMatchObject({ pending: true, src: null });
  await act(async () => {});
  await act(async () => finishOld("old"));
  expect(first.result.current).toMatchObject({ generation: 2, src: "new", pending: false });
  expect(second.result.current?.src).toBe("new");
  expect(load).toHaveBeenCalledTimes(2);
});

it("releases a hidden reader's image and never publishes a read after unmount", async () => {
  const load = vi.fn().mockResolvedValue("cover");
  const cache = createLibraryCoverCache(load);
  const view = renderHook(({ hash }) => useLibraryCover(cache, { generation: 1, revision: 0 }, hash), { initialProps: { hash: "one" as string | null } });
  await act(async () => {});
  expect(view.result.current?.src).toBe("cover");
  view.rerender({ hash: null });
  expect(view.result.current).toBeNull();
  let finish!: (value: string) => void;
  load.mockImplementation(() => new Promise<string>((resolve) => { finish = resolve; }));
  view.rerender({ hash: "two" });
  view.unmount();
  await act(async () => finish("late"));
});
