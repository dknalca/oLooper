// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ImportProgress } from "../tauri";
import ImportProgressPanel from "./ImportProgressPanel";

afterEach(cleanup);
it("shows file progress and allows dismissing a completed job", () => {
  const progress: ImportProgress = { job_id: "job", stage: "done", current: 1, total: 2, detail: "", done: true, error: "partial error", report: null, custom_report: null };
  const dismiss = vi.fn();
  const view = render(<ImportProgressPanel progress={progress} files={[{ path: "/folder/one.swf", stage: "done", done: true, error: null }]} elapsed={65} onDismiss={dismiss} />);
  expect(screen.getByText("50%")).toBeTruthy();
  expect(screen.getByText("one.swf")).toBeTruthy();
  expect(screen.getByText("partial error")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(dismiss).toHaveBeenCalledOnce();
  view.rerender(<ImportProgressPanel progress={null} files={[]} elapsed={0} onDismiss={dismiss} />);
  expect(screen.queryByText("Importing")).toBeNull();
});
