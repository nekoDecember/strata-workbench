import { useState } from "react";
import {
  Braces,
  CalendarDays,
  Filter as FilterIcon,
  Hash,
  Plus,
  Search,
  Type,
  X,
} from "lucide-react";
import type { Column, Filter, Profile, View } from "./types";
import { format } from "./state";

const operatorLabels: Record<Filter["op"], string> = {
  eq: "等しい",
  ne: "等しくない",
  gt: "より大きい",
  ge: "以上",
  lt: "より小さい",
  le: "以下",
  contains: "含む",
  in: "いずれか",
  not_in: "いずれでもない",
  is_null: "欠損",
  not_null: "欠損以外",
};

type Props = {
  columns: Column[];
  profile: Profile | null;
  view: View;
  y: string;
  onY: (name: string) => void;
  onFilter: (filter: Filter) => void;
  onRemove: (i: number) => void;
  onClear: () => void;
  onColumn: (name: string) => void;
};
export default function Sidebar({
  columns,
  profile,
  view,
  y,
  onY,
  onFilter,
  onRemove,
  onClear,
  onColumn,
}: Props) {
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);
  const [col, setCol] = useState("");
  const [op, setOp] = useState<Filter["op"]>("eq");
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const activeColumn = columns.find((item) => item.name === col);
  const suggestedValues =
    activeColumn?.kind === "text"
      ? profile?.columns.find((item) => item.name === col)?.values || []
      : [];
  function add() {
    const c = columns.find((c) => c.name === col) || columns[0];
    if (!c) return;
    if (!['is_null', 'not_null'].includes(op) && !value.trim()) {
      setError(c.kind === "text" ? "値を選んでください。" : "値を入力してください。");
      return;
    }
    let parsed: any = value;
    if (
      c.kind === "number" &&
      op !== "contains" &&
      !["is_null", "not_null"].includes(op)
    ) {
      parsed = Number(value);
      if (!value.trim() || !Number.isFinite(parsed)) {
        setError("数値を入力してください。");
        return;
      }
    }
    onFilter({
      column: c.name,
      op,
      value: ["is_null", "not_null"].includes(op) ? null : parsed,
    });
    setValue("");
    setAdding(false);
    setError("");
  }
  return (
    <aside className="sidebar">
      <div className="sidebar-title">
        <span>列</span>
        <span className="count-label">{columns.length}</span>
      </div>
      <div className="search-field">
        <Search size={14} />
        <input
          aria-label="列を検索"
          placeholder="列を検索"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="columns-list">
        {columns
          .filter((c) => c.name.toLowerCase().includes(search.toLowerCase()))
          .map((c) => {
            const stats = profile?.columns.find((p) => p.name === c.name);
            const Icon =
              c.kind === "number"
                ? Hash
                : c.kind === "datetime"
                  ? CalendarDays
                  : Type;
            return (
              <button
                key={c.name}
                className={`column-item ${y === c.name ? "active" : ""}`}
                onClick={() => {
                  if (c.kind === "number") onY(c.name);
                  onColumn(c.name);
                }}
                title={`${c.name} · ${c.dtype}`}
              >
                <Icon size={15} className={c.kind} />
                <span className="column-name">
                  {c.name}
                  <small>
                    {c.kind === "number"
                      ? "連続"
                      : c.kind === "datetime"
                        ? "日時"
                        : "カテゴリ"}
                    {stats?.nulls ? ` · 欠損 ${stats.nulls}` : ""}
                  </small>
                </span>
                {y === c.name && <span className="axis-tag">Y</span>}
              </button>
            );
          })}
      </div>
      <div className="sidebar-title filter-title">
        <span>
          <FilterIcon size={14} /> 条件
          {view.filters.length > 0 && (
            <small className="filter-count">{view.filters.length}</small>
          )}
        </span>
        <div className="filter-heading-actions">
          {view.filters.length > 0 && (
            <button className="link-button" onClick={onClear}>
              解除
            </button>
          )}
          <button
            className="icon-button"
            title="フィルタを追加"
            onClick={() => {
              setAdding(!adding);
              if (!col && columns[0]) setCol(columns[0].name);
            }}
          >
            <Plus size={15} />
          </button>
        </div>
      </div>
      <div className="filter-list">
        {view.filters.length === 0 && !adding && (
          <p className="muted empty-small">全ての行が対象です</p>
        )}
        {view.filters.map((f, i) => (
          <div className="filter-chip" key={i}>
            <div>
              <b>{f.column}</b>
              <small>
                {operatorLabels[f.op]}
                {!["is_null", "not_null"].includes(f.op) &&
                  ` · ${format(f.value)}`}
              </small>
            </div>
            <button
              className="icon-button"
              aria-label={`${f.column}のフィルタを削除`}
              onClick={() => onRemove(i)}
            >
              <X size={13} />
            </button>
          </div>
        ))}
      </div>
      {adding && (
        <div className="filter-builder">
          <label>
            列
            <select
              value={col}
              onChange={(e) => {
                const next = columns.find((item) => item.name === e.target.value);
                setCol(e.target.value);
                setValue("");
                if (next?.kind === "number" && op === "contains") setOp("eq");
              }}
            >
              {columns.map((c) => (
                <option key={c.name}>{c.name}</option>
              ))}
            </select>
          </label>
          <label>
            条件
            <select
              value={op}
              onChange={(e) => setOp(e.target.value as Filter["op"])}
            >
              <option value="eq">等しい</option>
              <option value="ne">等しくない</option>
              <option
                value="contains"
                disabled={activeColumn?.kind === "number"}
              >
                含む
              </option>
              <option value="ge">以上</option>
              <option value="le">以下</option>
              <option value="gt">より大きい</option>
              <option value="lt">より小さい</option>
              <option value="is_null">欠損</option>
              <option value="not_null">欠損以外</option>
            </select>
          </label>
          {!["is_null", "not_null"].includes(op) && (
            activeColumn?.kind === "text" && suggestedValues.length > 0 ? (
              <select
                aria-label="条件の値"
                value={value}
                onChange={(e) => setValue(e.target.value)}
              >
                <option value="">値を選ぶ</option>
                {suggestedValues
                  .filter((item) => item.value !== null)
                  .map((item) => (
                    <option key={String(item.value)} value={String(item.value)}>
                      {format(item.value)} · {item.count.toLocaleString()}行
                    </option>
                  ))}
              </select>
            ) : (
              <input
                aria-label="条件の値"
                placeholder={activeColumn?.kind === "number" ? "数値" : "値"}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && add()}
              />
            )
          )}
          <button className="button primary small" onClick={add}>
            適用
          </button>
          {error && <p className="inline-error">{error}</p>}
        </div>
      )}
      <div className="sidebar-footer">
        <Braces size={15} />
        <span>
          数値列をクリックしてYに設定
          <br />
          グラフから元の行へ選択を連動
        </span>
      </div>
    </aside>
  );
}
