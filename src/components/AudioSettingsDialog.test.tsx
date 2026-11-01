// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AudioSettingsDialog from "./AudioSettingsDialog";
import { audioOutputDevices, audioSetOutput, audioTestOutput, playerPlay, playerStatus, playerStop, type AudioOutputDevice, type PlayerStatus } from "../tauri";

vi.mock("../tauri", async (original) => ({
  ...await original<typeof import("../tauri")>(),
  audioOutputDevices: vi.fn(), audioSetOutput: vi.fn(), audioTestOutput: vi.fn(),
  playerPlay: vi.fn(), playerStatus: vi.fn(), playerStop: vi.fn(),
}));

const device: AudioOutputDevice = { id: "desk", name: "Desk", channels: 4, sample_rates: [44100, 48000], buffer_size_min: 128, buffer_size_max: 1024, is_default: true };
const status = { loaded: false, playing: false, output_left_level_pct: 0, output_right_level_pct: 0 } as PlayerStatus;
const selection = { deviceName: null, firstChannel: 0, sampleRate: null, bufferFrames: null };
const props = { open: true, selection, startupError: null, onSelectionChange: vi.fn(), copySourceOnImport: false, onCopySourceOnImportChange: vi.fn(), onPlayerStatusChange: vi.fn(), onOutputTestStarted: vi.fn(), onClose: vi.fn() };
beforeEach(() => {
  localStorage.clear();
  vi.mocked(audioOutputDevices).mockResolvedValue([device]);
  vi.mocked(playerStatus).mockResolvedValue(status);
  vi.mocked(playerStop).mockResolvedValue(status);
  vi.mocked(playerPlay).mockResolvedValue(status);
  vi.mocked(audioSetOutput).mockResolvedValue(status);
  vi.mocked(audioTestOutput).mockResolvedValue(status);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.resetAllMocks(); });

it("applies the selected output settings and persists them", async () => {
  const onSelectionChange = vi.fn();
  render(<AudioSettingsDialog {...props} onSelectionChange={onSelectionChange} />);
  await act(async () => {});
  fireEvent.change(screen.getByLabelText("Device sample rate"), { target: { value: "48000" } });
  fireEvent.change(screen.getByLabelText("Buffer size"), { target: { value: "256" } });
  fireEvent.change(screen.getByLabelText("Stereo output pair"), { target: { value: "2" } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Apply" })); });
  const expected = { deviceName: null, firstChannel: 2, sampleRate: 48000, bufferFrames: 256 };
  expect(audioSetOutput).toHaveBeenCalledExactlyOnceWith(expected);
  expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith(expected);
  expect(JSON.parse(localStorage.getItem("olooper.audio.output")!)).toEqual(expected);
});

it("disables applying output settings when no device is available", async () => {
  vi.mocked(audioOutputDevices).mockResolvedValue([]);
  render(<AudioSettingsDialog {...props} />);
  await act(async () => {});
  expect(screen.getByRole("status").textContent).toContain("No system-default output");
  expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Test L/R" }) as HTMLButtonElement).disabled).toBe(true);
  expect(audioSetOutput).not.toHaveBeenCalled();
});

it("switches devices using their remembered pair and clears unsupported settings", async () => {
  vi.mocked(audioOutputDevices).mockResolvedValue([device, {
    ...device, id: "other", name: "Other", channels: 4, sample_rates: [44100], buffer_size_min: 512, buffer_size_max: 2048, is_default: false,
  }]);
  localStorage.setItem("olooper.audio.output-pairs", JSON.stringify({ other: 2 }));
  render(<AudioSettingsDialog {...props} selection={{ ...selection, sampleRate: 48000, bufferFrames: 256 }} />);
  await act(async () => {});
  fireEvent.change(screen.getByLabelText("Output device"), { target: { value: "other" } });
  expect((screen.getByLabelText("Stereo output pair") as HTMLSelectElement).value).toBe("2");
  expect((screen.getByLabelText("Device sample rate") as HTMLSelectElement).value).toBe("");
  expect((screen.getByLabelText("Buffer size") as HTMLSelectElement).value).toBe("");
});

it("does not persist a rejected output change", async () => {
  const onSelectionChange = vi.fn();
  vi.mocked(audioSetOutput).mockRejectedValueOnce(new Error("device unavailable"));
  render(<AudioSettingsDialog {...props} onSelectionChange={onSelectionChange} />);
  await act(async () => {});
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Apply" })); });
  expect(screen.getByRole("alert").textContent).toContain("device unavailable");
  expect(onSelectionChange).not.toHaveBeenCalled();
  expect(localStorage.getItem("olooper.audio.output")).toBeNull();
});

it("stops active playback for routing and resumes it on close", async () => {
  vi.mocked(playerStatus).mockResolvedValue({ ...status, loaded: true, playing: true });
  const onPlayerStatusChange = vi.fn();
  const view = render(<AudioSettingsDialog {...props} onPlayerStatusChange={onPlayerStatusChange} />);
  await act(async () => {});
  expect(playerStop).toHaveBeenCalledOnce();
  view.rerender(<AudioSettingsDialog {...props} open={false} onPlayerStatusChange={onPlayerStatusChange} />);
  await act(async () => {});
  expect(playerPlay).toHaveBeenCalledOnce();
  expect(onPlayerStatusChange).toHaveBeenCalledWith(status);
});

it("does not resume playback after an output test fails", async () => {
  vi.mocked(playerStatus).mockResolvedValue({ ...status, loaded: true, playing: true });
  vi.mocked(audioTestOutput).mockRejectedValue(new Error("test failed"));
  const onSelectionChange = vi.fn();
  const view = render(<AudioSettingsDialog {...props} onSelectionChange={onSelectionChange} />);
  await act(async () => {});
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Test L/R" })); });
  expect(screen.getByRole("alert").textContent).toContain("test failed");
  expect(onSelectionChange).not.toHaveBeenCalled();
  view.rerender(<AudioSettingsDialog {...props} open={false} onSelectionChange={onSelectionChange} />);
  await act(async () => {});
  expect(playerPlay).not.toHaveBeenCalled();
});

it("shows left then right test feedback and clears the timers when closed", async () => {
  vi.useFakeTimers();
  const onOutputTestStarted = vi.fn();
  const view = render(<AudioSettingsDialog {...props} onOutputTestStarted={onOutputTestStarted} />);
  await act(async () => {});
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Test L/R" })); });
  expect(screen.getByText("Testing left channel…")).toBeTruthy();
  expect(onOutputTestStarted).toHaveBeenCalledOnce();
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  expect(screen.getByText("Testing right channel…")).toBeTruthy();
  view.rerender(<AudioSettingsDialog {...props} open={false} onOutputTestStarted={onOutputTestStarted} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  view.rerender(<AudioSettingsDialog {...props} onOutputTestStarted={onOutputTestStarted} />);
  await act(async () => {});
  expect(screen.queryByText(/Testing (left|right) channel/)).toBeNull();
  expect((screen.getByRole("button", { name: "Test L/R" }) as HTMLButtonElement).disabled).toBe(false);
});

it("ignores an in-flight level poll after the dialog closes", async () => {
  let finishPoll!: (value: PlayerStatus) => void;
  vi.mocked(playerStatus).mockResolvedValueOnce(status)
    .mockImplementationOnce(() => new Promise((resolve) => { finishPoll = resolve; }));
  const onPlayerStatusChange = vi.fn();
  const view = render(<AudioSettingsDialog {...props} onPlayerStatusChange={onPlayerStatusChange} />);
  await act(async () => {});
  const countBeforeClose = onPlayerStatusChange.mock.calls.length;
  view.rerender(<AudioSettingsDialog {...props} open={false} onPlayerStatusChange={onPlayerStatusChange} />);
  await act(async () => { finishPoll({ ...status, playing: true, output_left_level_pct: 90 }); });
  expect(onPlayerStatusChange).toHaveBeenCalledTimes(countBeforeClose);
});
