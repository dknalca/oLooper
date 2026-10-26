// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useLayoutEffect } from "react";
import BpmReanalysisPanel from "./BpmReanalysisPanel";
import { requestBpmReanalysis } from "../bpmReanalysis";
import { bpmReanalysisStatus, cancelBpmReanalysis, listenBpmReanalysisProgress, reanalyzeBpm, type BpmReanalysisProgress } from "../tauri";

vi.mock("../tauri", () => ({
  bpmReanalysisStatus: vi.fn(), cancelBpmReanalysis: vi.fn(),
  listenBpmReanalysisProgress: vi.fn(), reanalyzeBpm: vi.fn(),
  newImportJobId: () => "bpm-test",
}));

let publish: (value: BpmReanalysisProgress) => void;
const release = vi.fn();
const props = { libraryRoot: "/library-a", libraryGeneration: 0, onUpdated: vi.fn(), onFinished: vi.fn() };
const completed: BpmReanalysisProgress = {
  job_id: "bpm-test", library_root: "/library-a", state: "completed", current_track_id: null,
  updated_track: null, error: null,
  report: { total: 1, processed: 1, updated: 1, protected: 0, changed_since_start: 0, no_estimate: 0, failed: 0, unprocessed: 0, errors: [] },
};

beforeEach(() => {
  vi.mocked(listenBpmReanalysisProgress).mockImplementation(async (handler) => { publish = handler; return release; });
  vi.mocked(bpmReanalysisStatus).mockResolvedValue(null);
  vi.mocked(cancelBpmReanalysis).mockResolvedValue(undefined);
  vi.mocked(reanalyzeBpm).mockResolvedValue("bpm-test");
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it("subscribes before admission and retains a completion emitted before the command resolves", async () => {
  vi.mocked(reanalyzeBpm).mockImplementation(async () => {
    expect(listenBpmReanalysisProgress).toHaveBeenCalledOnce();
    publish(completed);
    return "bpm-test";
  });
  render(<BpmReanalysisPanel {...props} />);
  await act(async () => { requestBpmReanalysis({ kind: "library" }, "All tracks"); });
  expect(reanalyzeBpm).toHaveBeenCalledWith({ kind: "library" }, "bpm-test");
  expect(screen.getByRole("status").textContent).toContain("BPM analysis completed");
  expect(props.onFinished).toHaveBeenCalledOnce();
});

it("repeats an early cancellation once admission finishes", async () => {
  let admit!: (value: string) => void;
  vi.mocked(reanalyzeBpm).mockImplementation(() => new Promise((resolve) => { admit = resolve; }));
  render(<BpmReanalysisPanel {...props} />);
  await act(async () => { requestBpmReanalysis({ kind: "library" }, "All tracks"); });
  fireEvent.click(screen.getByRole("button", { name: "Cancel analysis" }));
  await act(async () => { admit("bpm-test"); });
  expect(cancelBpmReanalysis).toHaveBeenCalledTimes(2);
});

it("ignores old-library progress and releases the subscription when switching roots", async () => {
  const view = render(<BpmReanalysisPanel {...props} />);
  await act(async () => { requestBpmReanalysis({ kind: "library" }, "All tracks"); });
  const oldPublish = publish;
  view.rerender(<BpmReanalysisPanel {...props} libraryRoot="/library-b" libraryGeneration={1} />);
  await act(async () => { oldPublish(completed); });
  expect(screen.queryByRole("status")).toBeNull();
  expect(props.onFinished).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalled();
});

it("rejects an old-root event during layout before passive subscription cleanup", async () => {
  const updated = vi.fn();
  let oldPublish: typeof publish;
  function Switching({ root }: { root: string }) {
    useLayoutEffect(() => {
      if (root === "/library-b") oldPublish({ ...completed, updated_track: { id: 1, bpm: 100 } as import("../tauri").Track });
    }, [root]);
    return <BpmReanalysisPanel {...props} libraryRoot={root} libraryGeneration={root === "/library-a" ? 0 : 1} onUpdated={updated} />;
  }
  const view = render(<Switching root="/library-a" />);
  await act(async () => {});
  oldPublish = publish;
  view.rerender(<Switching root="/library-b" />);
  expect(updated).not.toHaveBeenCalled();
  expect(props.onFinished).not.toHaveBeenCalled();
});
