// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import AudioOutputMeter from "./AudioOutputMeter";

afterEach(cleanup);
it("clamps digital levels and announces the active test channel", () => {
  const view = render(<AudioOutputMeter levels={{ left: -5, right: 120 }} testChannel="left" />);
  expect(screen.getByRole("meter", { name: "L digital output level" }).getAttribute("aria-valuenow")).toBe("0");
  expect(screen.getByRole("meter", { name: "R digital output level" }).getAttribute("aria-valuenow")).toBe("100");
  expect(screen.getByRole("status").textContent).toContain("Testing left channel");
  view.rerender(<AudioOutputMeter levels={{ left: 15, right: 25 }} testChannel={null} />);
  expect(screen.queryByRole("status")).toBeNull();
});
