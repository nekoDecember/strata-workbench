import { useCallback, useEffect, useMemo, useState } from "react";
import DataEditor, {
  CompactSelection,
  GridCellKind,
  type GridCell,
  type GridSelection,
  type Item,
  type EditableGridCell,
} from "@glideapps/glide-data-grid";
import type { Column, Row } from "./types";

type Props = {
  rows: Row[];
  columns: Column[];
  selected: number[];
  onSelect: (ids: number[]) => void;
  onCheck: (added: number[], removed: number[]) => void;
  onSort: (column: string) => void;
  onEdit: (row: number, column: string, value: unknown) => void;
  onColumns: (names: string[]) => void;
  sort: string | null;
  descending: boolean;
  editable: boolean;
  disabled: boolean;
  offset: number;
};

export default function DataTable({
  rows,
  columns,
  selected,
  onSelect,
  onCheck,
  onSort,
  onEdit,
  onColumns,
  sort,
  descending,
  editable,
  disabled,
  offset,
}: Props) {
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [current, setCurrent] = useState<GridSelection["current"]>();
  useEffect(() => setCurrent(undefined), [rows]);
  const ids = useMemo(() => new Set(selected), [selected]);
  const gridColumns = useMemo(
    () =>
      columns.map((c) => ({
        id: c.name,
        title: (c.name === sort ? (descending ? "↓ " : "↑ ") : "") + c.name,
        width:
          widths[c.name] ||
          (c.kind === "datetime" ? 190 : c.name.length > 9 ? 165 : 125),
        icon:
          c.kind === "number"
            ? "headerNumber"
            : c.kind === "datetime"
              ? "headerDate"
              : "headerString",
      })),
    [columns, widths, sort, descending],
  );
  const selection = useMemo(
    () => ({
      rows: rows.reduce(
        (s, r, i) => (ids.has(r.__row_id) ? s.add(i) : s),
        CompactSelection.empty(),
      ),
      columns: CompactSelection.empty(),
      current,
    }),
    [rows, ids, current],
  );
  const getCell = useCallback(
    ([c, r]: Item): GridCell => {
      const col = columns[c];
      const row = rows[r];
      if (!row || !col)
        return { kind: GridCellKind.Loading, allowOverlay: false };
      const val = row[col.name];
      if (col.kind === "number")
        return {
          kind: GridCellKind.Number,
          data: typeof val === "number" ? val : undefined,
          displayData: val === null ? "" : String(val),
          allowOverlay: editable,
          readonly: !editable,
        };
      return {
        kind: GridCellKind.Text,
        data: val === null ? "" : String(val),
        displayData: val === null ? "" : String(val),
        allowOverlay: editable && col.kind === "text",
        readonly: !editable || col.kind === "datetime",
      };
    },
    [columns, rows, editable],
  );
  const handleSelection = useCallback(
    (s: GridSelection) => {
      if (disabled) return;
      setCurrent(s.current);
      const added = s.rows.toArray().filter((i) => !selection.rows.hasIndex(i));
      const removed = selection.rows
        .toArray()
        .filter((i) => !s.rows.hasIndex(i));
      const rowIds = (indices: number[]) =>
        indices
          .map((i) => rows[i]?.__row_id)
          .filter((id): id is number => id !== undefined);
      if (added.length || removed.length) {
        onCheck(rowIds(added), rowIds(removed));
      } else if (
        s.current &&
        JSON.stringify(s.current) !== JSON.stringify(current)
      ) {
        const range = s.current.range;
        const ids = rows
          .slice(range.y, range.y + range.height)
          .map((r) => r.__row_id);
        onSelect(ids);
      }
    },
    [rows, onSelect, onCheck, current, selection.rows, disabled],
  );
  const cellEdited = useCallback(
    ([c, r]: Item, value: EditableGridCell) => {
      if (disabled || !editable || !rows[r] || !columns[c]) return;
      if (
        value.kind === GridCellKind.Text ||
        value.kind === GridCellKind.Number
      )
        onEdit(
          rows[r].__row_id,
          columns[c].name,
          value.data === "" || value.data === undefined ? null : value.data,
        );
    },
    [rows, columns, onEdit, disabled, editable],
  );
  return (
    <div className="data-grid" data-testid="data-grid" aria-busy={disabled}>
      <DataEditor
        columns={gridColumns}
        rows={rows.length}
        getCellContent={getCell}
        width="100%"
        height="100%"
        rowMarkers={{ kind: "both", startIndex: offset + 1 }}
        rowSelect="multi"
        rowSelectionMode="multi"
        rowSelectionBlending="mixed"
        rangeSelectionBlending="mixed"
        rangeSelect="rect"
        columnSelect="none"
        rowHeight={32}
        headerHeight={38}
        smoothScrollX
        smoothScrollY
        getCellsForSelection={true}
        gridSelection={selection}
        onGridSelectionChange={handleSelection}
        onHeaderClicked={(i) => {
          if (!disabled && columns[i]) onSort(columns[i].name);
        }}
        onColumnResize={(col, size) =>
          setWidths((w) => ({ ...w, [col.id!]: size }))
        }
        onColumnMoved={(start, end) => {
          const copy = columns.map((c) => c.name);
          const [v] = copy.splice(start, 1);
          copy.splice(end, 0, v);
          onColumns(copy);
        }}
        onCellEdited={cellEdited}
        getRowThemeOverride={(i) =>
          ids.has(rows[i]?.__row_id)
            ? { bgCell: "#edf1ff", bgCellMedium: "#edf1ff" }
            : i % 2
              ? { bgCell: "#fafaf8" }
              : undefined
        }
        theme={{
          accentColor: "#3157c7",
          accentLight: "#edf1ff",
          textDark: "#252629",
          textMedium: "#666862",
          textLight: "#92938d",
          bgHeader: "#f1f1ee",
          bgHeaderHovered: "#e9e9e5",
          bgHeaderHasFocus: "#e4e7f4",
          borderColor: "#deded9",
          horizontalBorderColor: "#e9e9e5",
          baseFontStyle: "13px",
          headerFontStyle: "600 12px",
          fontFamily: 'Inter, "Noto Sans JP", system-ui, sans-serif',
          cellHorizontalPadding: 12,
        }}
      />
      {disabled && (
        <div className="table-busy-overlay">データを読み込み中…</div>
      )}
    </div>
  );
}
