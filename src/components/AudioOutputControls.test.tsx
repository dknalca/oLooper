// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { audioDeviceOptions } from "../audioDeviceOptions";
import type { AudioOutputDevice } from "../tauri";
import AudioOutputControls from "./AudioOutputControls";

afterEach(cleanup);
const device: AudioOutputDevice = { id: "desk", name: "Desk", channels: 5, sample_rates: [44100, 48000], buffer_size_min: 128, buffer_size_max: 1024, is_default: true };
const callbacks = () => ({ onSampleRate: vi.fn(), onBufferFrames: vi.fn(), onFirstChannel: vi.fn() });
const base = { deviceName: "", loading: false, busy: false, sampleRate: "", bufferFrames: "", firstChannel: 0 };

it("offers supported rates, buffers and complete stereo pairs for the default device", () => {
  const actions = callbacks();
  render(<AudioOutputControls {...base} {...actions} options={audioDeviceOptions([device], "")} />);
  expect(screen.getByRole("status").textContent).toContain("Desk available · 5 output channels");
  const pairs = screen.getByLabelText("Stereo output pair") as HTMLSelectElement;
  expect(Array.from(pairs.options).map((option) => option.textContent)).toEqual(["Output 1–2", "Output 3–4"]);
  expect(screen.getByRole("option", { name: "128 frames" })).toBeTruthy();
  expect(screen.queryByRole("option", { name: "64 frames" })).toBeNull();
  fireEvent.change(screen.getByLabelText("Device sample rate"), { target: { value: "48000" } });
  fireEvent.change(screen.getByLabelText("Buffer size"), { target: { value: "256" } });
  fireEvent.change(pairs, { target: { value: "2" } });
  expect(actions.onSampleRate).toHaveBeenCalledWith("48000");
  expect(actions.onBufferFrames).toHaveBeenCalledWith("256");
  expect(actions.onFirstChannel).toHaveBeenCalledWith(2);
});

it("keeps saved unsupported values visible rather than silently replacing them", () => {
  render(<AudioOutputControls {...base} {...callbacks()} sampleRate="96000" bufferFrames="777" options={audioDeviceOptions([device], "")} />);
  expect(screen.getByRole("option", { name: "Saved 96 kHz (unsupported)" })).toBeTruthy();
  expect(screen.getByRole("option", { name: "Saved 777 frames" })).toBeTruthy();
});

it("explains unavailable or mono devices and disables the relevant selectors", () => {
  const view = render(<AudioOutputControls {...base} {...callbacks()} deviceName="missing" options={audioDeviceOptions([device], "missing")} />);
  expect(screen.getByRole("status").textContent).toContain("disconnected");
  expect((screen.getByLabelText("Device sample rate") as HTMLSelectElement).disabled).toBe(true);
  view.rerender(<AudioOutputControls {...base} {...callbacks()} options={audioDeviceOptions([{ ...device, channels: 1 }], "")} />);
  expect(screen.getByRole("status").textContent).toContain("does not expose a stereo output pair");
  expect((screen.getByLabelText("Stereo output pair") as HTMLSelectElement).disabled).toBe(true);
});

it("does not offer buffer presets when device buffer limits are unknown", () => {
  expect(audioDeviceOptions([{ ...device, buffer_size_min: null }], "").bufferPresets).toEqual([]);
  expect(audioDeviceOptions([], "").selectedAvailable).toBe(false);
});
