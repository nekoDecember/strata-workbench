import type { ChartConfig, Column, View, Workspace } from "./types";
export const INITIAL_CODE = `# df: 現在の表示条件に一致する全行（描画サンプルではありません）
# selected: そのうち選択されている行。pd / pl / np は読み込み済み。
# wb.show(...): 表・図を表示 / wb.publish(...): 派生データを画面へ

value = context["y"]
group = context.get("group")

if group:
    summary = df.groupby(group, dropna=False)[value].agg(
        ["count", "mean", "std", "min", "median", "max"]
    )
else:
    summary = df[[value]].describe()

wb.show(summary, name="現在の切り口で要約")
print(f"対象 {len(df):,} 行 / 選択 {len(selected):,} 行")`;

export function initialWorkspace(
  revision: number,
  schema: Column[],
): Workspace {
  const nums = schema.filter((c) => c.kind === "number");
  const group =
    schema.find((c) => c.name === "設備") ||
    schema.find((c) => c.kind === "text");
  const y = nums.find((c) => c.name === "径_mm") || nums[0];
  const x = nums.find((c) => c.name === "温度_C") || nums[1] || nums[0];
  return {
    view: {
      revision,
      filters: [],
      excluded_ids: [],
      selected_ids: [],
      selection_only: false,
      sort_by: null,
      descending: false,
    },
    config: {
      kind: "scatter",
      x: x?.name || "",
      y: y?.name || "",
      group: group?.name || "",
      bins: 24,
    },
    pins: [],
    code: INITIAL_CODE,
    notes: "",
    selections: [],
    activeTab: "explore",
  };
}
export function defaultTimeColumn(schema: Column[]) {
  return (
    schema.find((c) => c.kind === "datetime")?.name || schema[0]?.name || ""
  );
}
export function mergeSelection(
  previous: number[],
  incoming: number[],
  mode: "replace" | "add" | "subtract",
): number[] {
  if (mode === "replace") return [...new Set(incoming)];
  const ids = new Set(previous);
  for (const id of incoming) {
    if (mode === "add") ids.add(id);
    else ids.delete(id);
  }
  return [...ids];
}
// Checkboxes change only the rows actually toggled; they are independent of
// the brush mode and must preserve selections on other pages or hidden rows.
export function applyRowChecks(
  previous: number[],
  added: number[],
  removed: number[],
): number[] {
  return mergeSelection(
    mergeSelection(previous, removed, "subtract"),
    added,
    "add",
  );
}
export function queryForChart(view: View, config: ChartConfig) {
  return {
    ...view,
    ...config,
    x: config.x || null,
    group: config.group || null,
  };
}
export function dataQuery(view: View) {
  return {
    ...view,
    selected_ids: view.selection_only ? view.selected_ids : [],
  };
}
export function format(value: unknown, digits = 5): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number")
    return Number.isFinite(value)
      ? value.toLocaleString("ja-JP", { maximumFractionDigits: digits })
      : "—";
  return String(value);
}
export function selectionAfterRowRemoval(ids: number[], removed: number[]) {
  const blocked = new Set(removed);
  return ids.filter((id) => !blocked.has(id));
}
