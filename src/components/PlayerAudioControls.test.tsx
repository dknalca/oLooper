// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PlayerStatus } from "../tauri";
import PlayerAudioControls from "./PlayerAudioControls";

afterEach(cleanup);

it("changes volume and limits pitch adjustments to the supported range", () => {
  const onVolume = vi.fn();
  const onSpeed = vi.fn();
  const view = render(<PlayerAudioControls status={{ volume_pct: 40, speed_pct: 52 } as PlayerStatus} loaded onVolume={onVolume} onSpeed={onSpeed} />);
  fireEvent.change(screen.getByLabelText("Volume"), { target: { value: "70" } });
  fireEvent.click(screen.getByTitle("Slower"));
  expect(onVolume).toHaveBeenCalledWith(70);
  expect(onSpeed).toHaveBeenLastCalledWith(50);
  view.rerender(<PlayerAudioControls status={{ volume_pct: 40, speed_pct: 198 } as PlayerStatus} loaded onVolume={onVolume} onSpeed={onSpeed} />);
  fireEvent.click(screen.getByTitle("Faster"));
  expect(onSpeed).toHaveBeenLastCalledWith(200);
});

it("keeps volume available but disables pitch without a loaded track", () => {
  render(<PlayerAudioControls status={null} loaded={false} onVolume={vi.fn()} onSpeed={vi.fn()} />);
  expect((screen.getByLabelText("Volume") as HTMLInputElement).value).toBe("80");
  expect((screen.getByTitle("Slower") as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByTitle("Faster") as HTMLButtonElement).disabled).toBe(true);
});
