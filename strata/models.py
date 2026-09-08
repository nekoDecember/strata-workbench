from typing import Any, Literal

from pydantic import BaseModel, Field

ROW_ID = "__row_id"


class Filter(BaseModel):
    column: str
    op: Literal["eq", "ne", "gt", "ge", "lt", "le", "contains", "in", "not_in", "is_null", "not_null"]
    value: Any = None


class ViewQuery(BaseModel):
    revision: int | None = None
    filters: list[Filter] = Field(default_factory=list, max_length=100)
    excluded_ids: list[int] = Field(default_factory=list, max_length=200_000)
    selected_ids: list[int] = Field(default_factory=list, max_length=200_000)
    selection_only: bool = False
    sort_by: str | None = None
    descending: bool = False


class TableQuery(ViewQuery):
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=500, ge=1, le=2000)


class ChartQuery(ViewQuery):
    kind: Literal["scatter", "histogram", "box", "time", "correlation"] = "scatter"
    x: str | None = None
    y: str
    group: str | None = None
    bins: int = Field(default=24, ge=5, le=100)
    max_points: int = Field(default=5000, ge=100, le=20_000)
    highlight_ids: list[int] | None = Field(default=None, max_length=200_000)


class SelectionQuery(ViewQuery):
    criteria: list[Filter] = Field(default_factory=list, max_length=20)


class PythonRequest(ViewQuery):
    code: str = Field(min_length=1, max_length=100_000)
    context: dict[str, Any] = Field(default_factory=dict)


class CellEdit(BaseModel):
    revision: int
    row_id: int
    column: str
    value: Any


class CastColumn(BaseModel):
    revision: int
    column: str
    dtype: Literal["number", "text", "datetime"]


class ImportSql(BaseModel):
    connection: str
    query: str = Field(min_length=1, max_length=30_000)
    name: str = Field(default="SQL import", min_length=1, max_length=200)
