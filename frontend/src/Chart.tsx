import { useEffect, useMemo, useRef, useState } from "react";
import type { ChartConfig, ChartData, Filter, Scalar } from "./types";
import { format } from "./state";
import { AlertCircle, LoaderCircle } from "lucide-react";

const PALETTE = [
  "#3157c7",
  "#b77836",
  "#765ca8",
  "#536273",
  "#b15b62",
  "#95743e",
  "#3e718a",
  "#7f8992",
];
function label(value: Scalar) {
  return value === null ? "(欠損)" : String(value);
}
function color(value: Scalar) {
  let h = 0;
  for (const c of String(value)) h = (h * 31 + c.charCodeAt(0)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}
type Selection = {
  ids?: number[];
  criteria?: Filter[];
  axes?: { x: string; y: string };
};
type Props = {
  data: ChartData;
  config: ChartConfig;
  selected: number[];
  onSelect?: (selection: Selection) => void;
  identity: string;
  range?: [number, number];
  compact?: boolean;
};

export function buildFigure(
  data: ChartData,
  config: ChartConfig,
  selected: number[],
) {
  const traces: any[] = [];
  const selectedSet = new Set(selected);
  if (config.kind === "scatter" || config.kind === "time") {
    const groups = new Map<
      string,
      { value: Scalar; points: NonNullable<ChartData["points"]> }
    >();
    for (const point of data.points || []) {
      const value = config.group ? point[config.group] : null;
      const key = JSON.stringify(value);
      if (!groups.has(key)) groups.set(key, { value, points: [] });
      groups.get(key)!.points.push(point);
    }
    for (const { value, points } of groups.values()) {
      const ys = points.map((p) => p[config.y]);
      const xs = points.map((p) => p[config.x] ?? p.__row_id);
      traces.push({
        type: config.kind === "scatter" ? "scattergl" : "scatter",
        mode: config.kind === "time" ? "lines+markers" : "markers",
        name: config.group ? label(value) : config.y,
        x: xs,
        y: ys,
        customdata: points.map((p) => p.__row_id),
        marker: {
          color: config.group ? color(value) : PALETTE[0],
          size: config.kind === "scatter" ? 6 : 4,
          opacity: 0.75,
        },
        line: { width: 1, color: config.group ? color(value) : PALETTE[0] },
        selectedpoints: selected.length
          ? points.flatMap((p, i) => (selectedSet.has(p.__row_id) ? [i] : []))
          : null,
        selected: { marker: { opacity: 1, size: 8 } },
        unselected: { marker: { opacity: 0.13 } },
        hovertemplate: `${config.x || "行ID"}: %{x}<br>${config.y}: %{y}<br>行ID: %{customdata}<extra>${config.group ? label(value) : ""}</extra>`,
      });
    }
  } else if (config.kind === "histogram") {
    const groups = new Map<string, NonNullable<ChartData["bins"]>>();
    for (const b of data.bins || []) {
      const key = JSON.stringify(b.group);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(b);
    }
    for (const bins of groups.values())
      traces.push({
        type: "bar",
        name: config.group ? label(bins[0].group) : "件数",
        x: bins.map((b) => (b.lo + b.hi) / 2),
        y: bins.map((b) => b.count),
        width: bins.map((b) => (b.hi - b.lo) * 0.96),
        customdata: bins,
        marker: {
          color: config.group ? color(bins[0].group) : PALETTE[0],
          opacity: bins.map((b) =>
            selected.length ? (b.selected ? 1 : 0.15) : 0.82,
          ),
        },
        hovertemplate:
          "値: %{x}<br>件数: %{y}<br>選択: %{customdata.selected}<extra>%{fullData.name}</extra>",
      });
  } else if (config.kind === "box") {
    const groups = data.groups || [];
    for (const g of groups)
      traces.push({
        type: "box",
        name: config.group ? label(g.group) : config.y,
        x: [config.group ? label(g.group) : config.y],
        q1: [g.q1],
        median: [g.median],
        q3: [g.q3],
        lowerfence: [g.low],
        upperfence: [g.high],
        mean: [g.mean],
        boxpoints: false,
        boxmean: true,
        opacity: selected.length ? (g.selected ? 1 : 0.18) : 1,
        marker: { color: config.group ? color(g.group) : PALETTE[0] },
        line: { width: 1.5 },
        fillcolor: config.group ? color(g.group) + "33" : "#3157c733",
        customdata: [g.group],
        hovertext: `n=${g.n.toLocaleString()} · 選択 ${g.selected || 0} · 平均 ${format(g.mean)} · SD ${format(g.std)}`,
        hoverinfo: "text+y+name",
      });
    if (data.outliers?.length)
      traces.push({
        type: "scatter",
        mode: "markers",
        name: "IQR外側の点",
        meta: "outliers",
        showlegend: false,
        x: data.outliers.map((p) =>
          config.group ? label(p[config.group]) : config.y,
        ),
        y: data.outliers.map((p) => p[config.y]),
        customdata: data.outliers.map((p) => p.__row_id),
        marker: {
          size: 5,
          color: data.outliers.map((p) =>
            config.group ? color(p[config.group]) : PALETTE[0],
          ),
          opacity: 0.7,
        },
        selectedpoints: selected.length
          ? data.outliers.flatMap((p, i) =>
              selectedSet.has(p.__row_id) ? [i] : [],
            )
          : null,
        selected: { marker: { opacity: 1, size: 8 } },
        unselected: { marker: { opacity: 0.15 } },
        hovertemplate:
          "%{x}<br>値: %{y}<br>行ID: %{customdata}<extra>IQR外側の点</extra>",
      });
  } else {
    traces.push({
      type: "heatmap",
      x: data.columns,
      y: data.columns,
      z: data.values,
      customdata: data.counts,
      colorscale: [
        [0, "#4a66ba"],
        [0.5, "#f4f4f2"],
        [1, "#b77836"],
      ],
      zmin: -1,
      zmax: 1,
      hovertemplate:
        "%{x} × %{y}<br>Pearson r = %{z:.3f}<br>有効ペア数: %{customdata}<extra></extra>",
      showscale: true,
    });
  }
  return traces;
}

export default function Chart({
  data,
  config,
  selected,
  onSelect,
  identity,
  range,
  compact,
}: Props) {
  const div = useRef<HTMLDivElement>(null);
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const traces = useMemo(
    () => buildFigure(data, config, selected),
    [data, config, selected],
  );
  useEffect(() => {
    let disposed = false;
    let plot: any;
    let observer: ResizeObserver | undefined;
    async function draw() {
      try {
        const module = await import("plotly.js-dist-min");
        plot = module.default || module;
        if (disposed || !div.current) return;
        const el = div.current as any;
        const xLabel =
          config.kind === "histogram"
            ? config.y
            : config.kind === "box"
              ? config.group || "全体"
              : config.x || "行ID";
        const yLabel = config.kind === "histogram" ? "件数" : config.y;
        await plot.react(
          el,
          traces,
          {
            autosize: true,
            margin: {
              l: compact ? 55 : 64,
              r: 22,
              t: 18,
              b: config.kind === "correlation" ? 85 : 54,
            },
            paper_bgcolor: "#fbfbf9",
            plot_bgcolor: "#fbfbf9",
            font: {
              family: 'Inter, "Noto Sans JP", system-ui, sans-serif',
              color: "#4f5157",
              size: 12,
            },
            xaxis: {
              title: {
                text: config.kind === "correlation" ? "" : xLabel,
                font: { size: 12 },
              },
              gridcolor: "#e7e7e3",
              zeroline: false,
              automargin: true,
            },
            yaxis: {
              title: {
                text: config.kind === "correlation" ? "" : yLabel,
                font: { size: 12 },
              },
              gridcolor: "#e7e7e3",
              zeroline: false,
              automargin: true,
              ...(range ? { range, autorange: false } : { autorange: true }),
            },
            showlegend: !!config.group && config.kind !== "box",
            legend: { orientation: "h", y: 1.1, x: 0, font: { size: 11 } },
            barmode: "stack",
            bargap: 0.03,
            dragmode: config.kind === "scatter" ? "lasso" : "zoom",
            uirevision: identity,
            selectionrevision: selected.join(","),
            hovermode: "closest",
          },
          {
            responsive: true,
            displaylogo: false,
            scrollZoom: false,
            modeBarButtonsToRemove: ["sendDataToCloud", "autoScale2d"],
            toImageButtonOptions: {
              format: "png",
              filename: "strata-chart",
              scale: 2,
            },
          },
        );
        if (disposed) return;
        el.removeAllListeners("plotly_selected");
        el.removeAllListeners("plotly_click");
        el.removeAllListeners("plotly_deselect");
        el.on("plotly_selected", (e: any) => {
          if (
            e?.points &&
            (config.kind === "scatter" || config.kind === "time")
          )
            selectRef.current?.({
              ids: e.points
                .map((p: any) => p.customdata)
                .filter((x: unknown) => typeof x === "number"),
            });
        });
        el.on("plotly_deselect", () => {
          if (config.kind === "scatter" || config.kind === "time")
            selectRef.current?.({ ids: [] });
        });
        el.on("plotly_click", (e: any) => {
          const p = e?.points?.[0];
          if (!p) return;
          if (config.kind === "scatter" || config.kind === "time")
            selectRef.current?.({ ids: [p.customdata] });
          else if (config.kind === "histogram") {
            const b = p.customdata;
            const criteria: Filter[] = [
              { column: config.y, op: "ge", value: b.lo },
              { column: config.y, op: b.last ? "le" : "lt", value: b.hi },
            ];
            if (config.group)
              criteria.push({ column: config.group, op: "eq", value: b.group });
            selectRef.current?.({ criteria });
          } else if (config.kind === "box") {
            if (p.data.meta === "outliers") {
              selectRef.current?.({ ids: [p.customdata] });
              return;
            }
            const g = data.groups?.[p.curveNumber];
            selectRef.current?.({
              criteria:
                config.group && g
                  ? [{ column: config.group, op: "eq", value: g.group }]
                  : [],
            });
          } else selectRef.current?.({ axes: { x: p.x, y: p.y } });
        });
        observer = new ResizeObserver(() => {
          if (!disposed && el.isConnected) plot.Plots.resize(el);
        });
        observer.observe(el);
        setReady(true);
        setError("");
      } catch (e) {
        if (!disposed) setError(String(e));
      }
    }
    draw();
    return () => {
      disposed = true;
      observer?.disconnect();
    };
  }, [traces, config, identity, range, data, selected]);
  useEffect(() => {
    const el = div.current;
    return () => {
      if (el)
        import("plotly.js-dist-min").then((m) => (m.default || m).purge(el));
    };
  }, []);
  return (
    <div className="chart-container">
      {!ready && !error && (
        <div className="chart-loader">
          <LoaderCircle className="spin" size={20} />
        </div>
      )}
      {error && (
        <div className="inline-error">
          <AlertCircle size={16} />
          {error}
        </div>
      )}
      <div ref={div} className="plot" />
    </div>
  );
}

export function PythonFigure({ url }: { url: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let stop = false;
    let p: any;
    let observer: ResizeObserver | undefined;
    const el = ref.current;
    Promise.all([
      fetch(url).then((r) => {
        if (!r.ok) throw Error("図を読み込めません。");
        return r.json();
      }),
      import("plotly.js-dist-min"),
    ])
      .then(([f, m]) => {
        if (stop || !el) return;
        p = m.default || m;
        return p
          .newPlot(
            el,
            f.data,
            { ...f.layout, autosize: true, height: 360, paper_bgcolor: "#fff" },
            { responsive: true, displaylogo: false },
          )
          .then(() => {
            observer = new ResizeObserver(() => p.Plots.resize(el));
            observer.observe(el);
          });
      })
      .catch((e) => setError(String(e)));
    return () => {
      stop = true;
      observer?.disconnect();
      if (p && el) p.purge(el);
    };
  }, [url]);
  return (
    <>
      {error && <p className="inline-error">{error}</p>}
      <div ref={ref} style={{ height: 360, width: "100%" }} />
    </>
  );
}
