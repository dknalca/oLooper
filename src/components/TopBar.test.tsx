// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import TopBar from "./TopBar";
import { getAppStatus, libraryDefaultRoot, libraryInit, libraryRestore, playerSetMetronome, type PlayerStatus } from "../tauri";

vi.mock("../tauri", () => ({
  getAppStatus: vi.fn(), libraryDefaultRoot: vi.fn(), libraryInit: vi.fn(),
  libraryRestore: vi.fn(), playerSetMetronome: vi.fn(), pickDirectory: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(getAppStatus).mockResolvedValue({ version: "0.8.0", platform: "test", library_set: false });
  vi.mocked(libraryDefaultRoot).mockResolvedValue("/default");
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it("does not let an older restore overwrite a newer library selection", async () => {
  const restore = deferred<string | null>();
  const manual = deferred<string>();
  vi.mocked(libraryRestore).mockReturnValue(restore.promise);
  vi.mocked(libraryInit).mockReturnValue(manual.promise);
  const onLibraryReady = vi.fn();
  render(<TopBar onLibraryReady={onLibraryReady} playing={false} trackBpm={null} onAudioOptions={vi.fn()} onMidiOptions={vi.fn()} onShortcuts={vi.fn()} onPreferences={vi.fn()} />);

  await act(async () => { window.dispatchEvent(new Event("olooper:choose-library")); });
  fireEvent.change(screen.getByLabelText("Library root path"), { target: { value: "/new" } });
  fireEvent.click(screen.getByRole("button", { name: "Use this folder" }));
  await act(async () => { manual.resolve("/new"); });
  expect(onLibraryReady).toHaveBeenCalledOnce();
  expect(onLibraryReady).toHaveBeenLastCalledWith("/new");

  await act(async () => { restore.resolve("/old"); });
  expect(onLibraryReady).toHaveBeenCalledOnce();
  expect(localStorage.getItem("olooper.library.root")).toBe("/new");
  expect(screen.getByText("/new")).toBeTruthy();
});

it("ignores an older restore failure while the newer selection is pending", async () => {
  const restore = deferred<string | null>();
  const manual = deferred<string>();
  vi.mocked(libraryRestore).mockReturnValue(restore.promise);
  vi.mocked(libraryInit).mockReturnValue(manual.promise);
  const onLibraryReady = vi.fn();
  render(<TopBar onLibraryReady={onLibraryReady} playing={false} trackBpm={null} onAudioOptions={vi.fn()} onMidiOptions={vi.fn()} onShortcuts={vi.fn()} onPreferences={vi.fn()} />);

  await act(async () => { window.dispatchEvent(new Event("olooper:choose-library")); });
  fireEvent.change(screen.getByLabelText("Library root path"), { target: { value: "/new" } });
  fireEvent.click(screen.getByRole("button", { name: "Use this folder" }));
  await act(async () => { restore.reject(new Error("old failure")); });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(onLibraryReady).not.toHaveBeenCalled();
  await act(async () => { manual.resolve("/new"); });
  expect(onLibraryReady).toHaveBeenCalledOnce();
  expect(onLibraryReady).toHaveBeenCalledWith("/new");
});

it("connects the metronome to the current track BPM and the MIDI toggle event", async () => {
  vi.mocked(libraryRestore).mockResolvedValue(null);
  vi.mocked(playerSetMetronome).mockResolvedValue({} as PlayerStatus);
  const view = render(<TopBar onLibraryReady={vi.fn()} playing={false} trackBpm={110} onAudioOptions={vi.fn()} onMidiOptions={vi.fn()} onShortcuts={vi.fn()} onPreferences={vi.fn()} />);
  await act(async () => { window.dispatchEvent(new Event("olooper:metronome-toggle")); });
  expect(playerSetMetronome).toHaveBeenCalledExactlyOnceWith(true, 110);
  view.rerender(<TopBar onLibraryReady={vi.fn()} playing={false} trackBpm={125} onAudioOptions={vi.fn()} onMidiOptions={vi.fn()} onShortcuts={vi.fn()} onPreferences={vi.fn()} />);
  await act(async () => {});
  expect(playerSetMetronome).toHaveBeenLastCalledWith(true, 125);
});
