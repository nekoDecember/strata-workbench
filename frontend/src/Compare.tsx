import { useEffect, useState } from "react";
import { Columns2, Pin as PinIcon, Trash2 } from "lucide-react";
import Chart from "./Chart";
import { request } from "./api";
import type { ChartData, Filter, Pin } from "./types";
import { format, queryForChart } from "./state";

const operatorLabels: Record<Filter["op"], string> = {
  eq: "=",
  ne: "≠",
  gt: ">",
  ge: "≥",
  lt: "<",
  le: "≤",
  contains: "含む",
  in: "いずれか",
  not_in: "いずれでもない",
  is_null: "欠損",
  not_null: "欠損以外",
};

function describeFilter(filter: Filter) {
  if (["is_null", "not_null"].includes(filter.op))
    return `${filter.column} ${operatorLabels[filter.op]}`;
  const value = Array.isArray(filter.value)
    ? filter.value.map((item) => format(item)).join(", ")
    : format(filter.value);
  return `${filter.column} ${operatorLabels[filter.op]} ${value}`;
}
export default function Compare({
  datasetId,
  pins,
  selected,
  revision,
  onSelect,
  onUpdate,
  onRemove,
  onError,
}: {
  datasetId: string;
  pins: Pin[];
  selected: number[];
  revision: number;
  onSelect: (
    p: Pin,
    selection: { ids?: number[]; criteria?: Filter[] },
  ) => void;
  onUpdate: (p: Pin) => void;
  onRemove: (id: string) => void;
  onError: (e: unknown) => void;
}) {
  const [data, setData] = useState<Record<string, ChartData>>({});
  const [shared, setShared] = useState(true);
  const requests = JSON.stringify(
    pins.map((p) => ({
      id: p.id,
      config: p.config,
      view: p.view,
      highlight_ids: ["box", "histogram"].includes(p.config.kind)
        ? selected
        : [],
    })),
  );
  useEffect(() => {
    const controller = new AbortController();
    setData({});
    for (const p of pins)
      request<ChartData>(
        `/datasets/${datasetId}/chart`,
        { ...queryForChart(p.view, p.config), highlight_ids: selected },
        undefined,
        controller.signal,
      )
        .then((d) => setData((prev) => ({ ...prev, [p.id]: d })))
        .catch((e) => {
          if (e.name !== "AbortError") onError(e);
        });
    return () => controller.abort();
  }, [datasetId, requests]);
  const compatible =
    pins.length > 1 &&
    pins.every(
      (p) =>
        p.config.y === pins[0].config.y &&
        ["scatter", "time", "box"].includes(p.config.kind),
    );
  const extents = pins
    .map((p) => data[p.id]?.extent)
    .filter((e): e is [number, number] => !!e);
  const low = Math.min(...extents.map((e) => e[0])),
    high = Math.max(...extents.map((e) => e[1]));
  const padding = (high - low || 1) * 0.08;
  const range: [number, number] | undefined =
    shared && compatible && extents.length === pins.length
      ? [low - padding, high + padding]
      : undefined;
  if (!pins.length)
    return (
      <div className="compare-empty">
        <Columns2 size={36} />
        <h2>切り口を並べて比較</h2>
        <p>
          探索画面で「比較に固定」を押すと、
          <br />
          対象条件とリビジョンを保ったままここに追加されます。
        </p>
      </div>
    );
  return (
    <div className="compare-workspace">
      <div className="compare-toolbar">
        <span>
          <PinIcon size={14} />
          {pins.length} 個の切り口
        </span>
        {compatible && (
          <label>
            <input
              type="checkbox"
              checked={shared}
              onChange={(e) => setShared(e.target.checked)}
            />
            Y軸の範囲を揃える
          </label>
        )}
        <small>同じリビジョンの図では選択が連動します</small>
      </div>
      <div className="compare-grid">
        {pins.map((p) => (
          <article className="comparison-card" key={p.id}>
            <div className="panel-heading">
              <input
                aria-label="比較タイトル"
                value={p.title}
                onChange={(e) => onUpdate({ ...p, title: e.target.value })}
              />
              <button
                className="icon-button"
                title="比較から外す"
                onClick={() => onRemove(p.id)}
              >
                <Trash2 size={15} />
              </button>
            </div>
            <div className="snapshot-meta">
              <span>r{p.view.revision}</span>
              <span>{p.config.group || "層別なし"}</span>
              {p.view.filters.length > 0 && (
                <span className="snapshot-filter">
                  {p.view.filters.map(describeFilter).join(" · ")}
                </span>
              )}
              {p.view.selection_only ? " · 選択行のみ" : ""}
              {data[p.id] && ` · n=${data[p.id].total.toLocaleString()}`}
              {p.view.revision !== revision && " · 閲覧専用"}
            </div>
            <div className="comparison-plot">
              {data[p.id] ? (
                <Chart
                  data={data[p.id]}
                  config={p.config}
                  selected={p.view.revision === revision ? selected : []}
                  onSelect={(s) => {
                    if (p.view.revision === revision) onSelect(p, s);
                  }}
                  identity={p.id}
                  range={range}
                  compact
                />
              ) : (
                <div className="chart-loader">集計中…</div>
              )}
            </div>
            <textarea
              aria-label="比較メモ"
              placeholder="この切り口で分かったこと、次に確かめたいこと"
              value={p.notes}
              onChange={(e) => onUpdate({ ...p, notes: e.target.value })}
            />
          </article>
        ))}
      </div>
    </div>
  );
}
