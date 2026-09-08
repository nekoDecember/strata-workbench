export type Scalar = string | number | boolean | null;
export type Row = Record<string, Scalar> & { __row_id: number };
export type Column = {
  name: string;
  dtype: string;
  kind: "number" | "text" | "datetime";
  nulls?: number;
  unique?: number;
  count?: number;
  mean?: number;
  std?: number;
  min?: number;
  max?: number;
  median?: number;
  q1?: number;
  q3?: number;
  values?: { value: Scalar; count: number }[];
};
export type Dataset = {
  id: string;
  name: string;
  rows: number;
  columns: number;
  current_revision: number;
  revision?: number;
  updated_at: string;
  schema?: Column[];
  versions: {
    revision: number;
    operation: string;
    rows: number;
    created_at: string;
  }[];
  parent?: { dataset_id: string; revision: number; job_id?: string };
};
export type Filter = {
  column: string;
  op:
    | "eq"
    | "ne"
    | "gt"
    | "ge"
    | "lt"
    | "le"
    | "contains"
    | "in"
    | "not_in"
    | "is_null"
    | "not_null";
  value: Scalar | Scalar[];
};
export type View = {
  revision: number;
  filters: Filter[];
  excluded_ids: number[];
  selected_ids: number[];
  selection_only: boolean;
  sort_by: string | null;
  descending: boolean;
};
export type ChartConfig = {
  kind: "scatter" | "histogram" | "box" | "time" | "correlation";
  x: string;
  y: string;
  group: string;
  bins: number;
};
export type ChartData = {
  outliers?: Row[];
  outlier_count?: number;
  kind: ChartConfig["kind"];
  total: number;
  valid: number;
  rendered: number;
  sampled: boolean;
  extent?: [number, number];
  points?: Row[];
  bins?: {
    lo: number;
    hi: number;
    count: number;
    selected: number;
    last: boolean;
    group: Scalar;
  }[];
  groups?: {
    group: Scalar;
    n: number;
    selected: number;
    q1: number;
    median: number;
    q3: number;
    mean: number;
    std: number;
    min: number;
    max: number;
    low: number;
    high: number;
  }[];
  columns?: string[];
  values?: (number | null)[][];
  counts?: number[][];
};
export type Pin = {
  id: string;
  title: string;
  config: ChartConfig;
  view: View;
  notes: string;
};
export type Artifact = {
  kind: "dataset" | "table" | "plotly" | "image" | "text" | "selection";
  file: string;
  name: string;
  rows?: number;
  columns?: string[];
  preview?: Record<string, Scalar>[];
  text?: string;
  row_ids?: number[][];
  ids?: number[];
};
export type Job = {
  id: string;
  dataset_id: string;
  revision: number;
  code: string;
  context: Record<string, unknown>;
  status: string;
  stdout?: string;
  stdout_truncated?: boolean;
  artifacts?: Artifact[];
  error?: string;
  duration_seconds?: number;
  created_at: string;
  rows: number;
};
export type Profile = {
  total: number;
  selected_count: number;
  columns: Column[];
  selected_columns: Column[];
};
export type Workspace = {
  view: View;
  config: ChartConfig;
  pins: Pin[];
  code: string;
  notes: string;
  selections: { id: string; name: string; ids: number[]; revision: number }[];
  activeTab: "explore" | "compare" | "python";
  columnOrder?: string[];
};
