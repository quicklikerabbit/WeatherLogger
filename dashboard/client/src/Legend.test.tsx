import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Legend } from "./Overview";

// See LineChart.test.tsx: without test.globals, cleanup must be registered.
afterEach(cleanup);

describe("Legend", () => {
  it("renders nothing for a single series, which the panel title already names", () => {
    const { container } = render(
      <Legend series={[{ key: "a", label: "Humidity", color: "var(--series-1)", mark: "line" }]} />,
    );
    expect(container.textContent).toBe("");
  });

  it("lays the items out in a wrapping row", () => {
    // Regression: overriding the legend's style dropped visx's default
    // display: flex, which silently stacked the items vertically.
    const { container } = render(
      <Legend
        series={[
          { key: "a", label: "Temperature", color: "var(--series-1)", mark: "line" },
          { key: "b", label: "Dewpoint", color: "var(--series-1)", mark: "dashed" },
        ]}
      />,
    );
    const legend = container.querySelector(".visx-legend") as HTMLElement;
    expect(legend.style.display).toBe("flex");
    expect(legend.style.flexDirection).toBe("row");
    // Wrapping comes from a Tailwind class (jsdom doesn't compute those
    // into styles), so check the class itself.
    expect(legend.classList.contains("flex-wrap")).toBe(true);
  });

  it("labels each series and keys it by how it is drawn", () => {
    const { container } = render(
      <Legend
        series={[
          { key: "a", label: "Wind Speed", color: "var(--series-1)", mark: "line" },
          { key: "b", label: "Wind Gust", color: "var(--series-1)", mark: "dots" },
          { key: "c", label: "Dewpoint", color: "var(--series-1)", mark: "dashed" },
        ]}
      />,
    );
    expect(screen.getByText("Wind Speed")).toBeTruthy();
    expect(screen.getByText("Wind Gust")).toBeTruthy();
    expect(container.querySelectorAll("line")).toHaveLength(2);
    expect(container.querySelectorAll("circle")).toHaveLength(1);
    // The dashed series keeps its dash in the key, and the CSS-variable
    // color rides on style (where it resolves), not the stroke attribute.
    const dashed = container.querySelectorAll("line")[1] as SVGLineElement;
    expect(dashed.style.strokeDasharray).toBe("6,4");
    expect(dashed.style.stroke).toBe("var(--series-1)");
  });
});
