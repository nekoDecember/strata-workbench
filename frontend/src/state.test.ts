import { describe, it, expect } from "vitest";
import {
  applyRowChecks,
  dataQuery,
  initialWorkspace,
  mergeSelection,
  queryForChart,
} from "./state";
import { buildFigure } from "./Chart";
import type { ChartConfig, ChartData } from "./types";
describe("linked selection contract", () => {
  it("keeps off-page and filtered-out selections when checking a row", () => {
    expect(applyRowChecks([42, 99, 1500], [7], [])).toEqual([42, 99, 1500, 7]);
  });
  it("unchecks only the toggled rows, including the last checked row", () => {
    expect(applyRowChecks([42, 99, 1500], [], [99])).toEqual([42, 1500]);
    expect(applyRowChecks([42], [], [42])).toEqual([]);
  });
  it("selects and clears a page without losing another page's rows", () => {
    expect(applyRowChecks([1500, 42], [99, 7], [])).toEqual([1500, 42, 99, 7]);
    expect(applyRowChecks([1500, 42, 99, 7], [], [42, 99, 7])).toEqual([1500]);
  });
  it("uses stable row IDs and never substitutes positions", () => {
    expect(mergeSelection([42, 99], [99, 100], "add")).toEqual([42, 99, 100]);
    expect(mergeSelection([42, 99], [42], "subtract")).toEqual([99]);
    expect(mergeSelection([42, 99], [], "replace")).toEqual([]);
  });
  it("keeps selection separate from filtering", () => {
    const w = initialWorkspace(1, [
      { name: "v", kind: "number", dtype: "Float64" },
    ]);
    w.view.selected_ids = [42];
    expect(dataQuery(w.view).selected_ids).toEqual([]);
    w.view.selection_only = true;
    expect(dataQuery(w.view).selected_ids).toEqual([42]);
    expect(queryForChart(w.view, w.config).revision).toBe(1);
  });
  it("links sorted chart points to original rows", () => {
    const config: ChartConfig = {
      kind: "scatter",
      x: "x",
      y: "y",
      group: "",
      bins: 24,
    };
    const data: ChartData = {
      kind: "scatter",
      total: 2,
      valid: 2,
      rendered: 2,
      sampled: false,
      points: [
        { __row_id: 99, x: 1, y: 5 },
        { __row_id: 42, x: 2, y: 7 },
      ],
    };
    const [trace] = buildFigure(data, config, [42]);
    expect(trace.customdata).toEqual([99, 42]);
    expect(trace.selectedpoints).toEqual([1]);
  });
  it("dims groups without selected rows without dropping them", () => {
    const config: ChartConfig = {
      kind: "histogram",
      x: "",
      y: "v",
      group: "",
      bins: 5,
    };
    const data: ChartData = {
      kind: "histogram",
      total: 30,
      valid: 30,
      rendered: 30,
      sampled: false,
      bins: [
        { lo: 0, hi: 1, count: 20, selected: 3, last: false, group: null },
        { lo: 1, hi: 2, count: 10, selected: 0, last: true, group: null },
      ],
    };
    const [trace] = buildFigure(data, config, [42]);
    expect(trace.y).toEqual([20, 10]);
    expect(trace.marker.opacity).toEqual([1, 0.15]);
  });
});
