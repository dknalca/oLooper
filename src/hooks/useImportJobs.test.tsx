// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cancelImport, listenImportProgress, newImportJobId, type ImportProgress } from "../tauri";
import { useImportJobs } from "./useImportJobs";

vi.mock("../tauri", async (original) => ({
  ...await original<typeof import("../tauri")>(),
  cancelImport: vi.fn(), listenImportProgress: vi.fn(), newImportJobId: vi.fn(),
}));

let onProgress: (progress: ImportProgress) => void;
const event = (job_id: string, stage: string): ImportProgress => ({
  job_id, stage, current: 1, total: 2, detail: "working", done: false, error: null, report: null, custom_report: null,
});
beforeEach(() => {
  vi.mocked(listenImportProgress).mockImplementation(async (handler) => { onProgress = handler; return () => {}; });
  vi.mocked(newImportJobId).mockReturnValueOnce("one").mockReturnValueOnce("two");
  vi.mocked(cancelImport).mockResolvedValue();
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it("accepts only progress for the owned job and cancels that job and queued files", async () => {
  const setError = vi.fn();
  const view = renderHook(() => useImportJobs(setError));
  await act(async () => {});
  let finish!: () => void;
  let job!: Promise<void>;
  act(() => {
    view.result.current.beginImport(["one.swf", "two.swf"]);
    job = view.result.current.runOwnedJob("one.swf", () => new Promise<void>((resolve) => { finish = resolve; }));
  });
  act(() => onProgress(event("other", "stale")));
  expect(view.result.current.progress?.stage).toBe("preparing import");
  act(() => onProgress(event("one", "extracting")));
  expect(view.result.current.files.map((file) => file.stage)).toEqual(["extracting", "Queued"]);
  act(() => view.result.current.requestCancel());
  expect(cancelImport).toHaveBeenCalledExactlyOnceWith("one");
  expect(view.result.current.cancelQueue.current).toBe(true);
  expect(view.result.current.files[1]).toMatchObject({ stage: "Cancelled", done: true });
  await act(async () => { finish(); await job; });
  act(() => onProgress(event("one", "late")));
  expect(view.result.current.progress?.stage).toBe("extracting");
});

it("does not clear a newer job when an earlier job finishes", async () => {
  const setError = vi.fn();
  const view = renderHook(() => useImportJobs(setError));
  let finishFirst!: () => void;
  let finishSecond!: () => void;
  let first!: Promise<void>;
  let second!: Promise<void>;
  act(() => {
    view.result.current.beginImport(["one", "two"]);
    first = view.result.current.runOwnedJob("one", () => new Promise<void>((resolve) => { finishFirst = resolve; }));
    second = view.result.current.runOwnedJob("two", () => new Promise<void>((resolve) => { finishSecond = resolve; }));
  });
  await act(async () => { finishFirst(); await first; });
  act(() => { onProgress(event("two", "new job")); view.result.current.requestCancel(); });
  expect(view.result.current.progress?.stage).toBe("new job");
  expect(cancelImport).toHaveBeenCalledExactlyOnceWith("two");
  await act(async () => { finishSecond(); await second; });
});

it("releases a progress subscription registered after unmount", async () => {
  const release = vi.fn();
  let finish!: (release: () => void) => void;
  vi.mocked(listenImportProgress).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const view = renderHook(() => useImportJobs(vi.fn()));
  view.unmount();
  await act(async () => { finish(release); });
  expect(release).toHaveBeenCalledOnce();
});
