import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  BarChart3,
  BookOpen,
  Check,
  ChevronDown,
  Code2,
  Columns2,
  Database,
  FileUp,
  Filter,
  Hash,
  History,
  Layers3,
  LoaderCircle,
  LogOut,
  MousePointer2,
  PanelLeftClose,
  Pin as PinIcon,
  Play,
  Plus,
  RefreshCw,
  Save,
  ScatterChart,
  ShieldCheck,
  Table2,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { request, download, ApiError } from "./api";
import {
  applyRowChecks,
  dataQuery,
  defaultTimeColumn,
  format,
  initialWorkspace,
  mergeSelection,
  queryForChart,
} from "./state";
import type {
  ChartConfig,
  ChartData,
  Column,
  Dataset,
  Filter as DataFilter,
  Job,
  Pin,
  Profile,
  Row,
  View,
  Workspace,
} from "./types";
import Chart from "./Chart";
import DataTable from "./DataTable";
import Sidebar from "./Sidebar";
import Compare from "./Compare";
import PythonPane from "./PythonPane";
import Modal from "./Modal";
import ImportDialog from "./ImportDialog";

const kindLabels: Record<ChartConfig["kind"], string> = {
  scatter: "散布図",
  histogram: "ヒストグラム",
  box: "箱ひげ図",
  time: "時系列",
  correlation: "相関行列",
};
type Mode = "replace" | "add" | "subtract";

function Login({ onLogin }: { onLogin: () => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function login(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await request("/login", { token });
      setToken("");
      onLogin();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login-screen">
      <section className="login-intro">
        <div className="brand">
          <Layers3 size={29} />
          <span>
            strata<span className="brand-dot">.</span>
          </span>
        </div>
        <div>
          <div className="eyebrow">ANALYSIS WORKBENCH</div>
          <h1>
            一つの点から、
            <br />
            工程全体まで。
          </h1>
          <p>
            表で確かめ、グラフで捉え、Pythonで深める。
            <br />
            自分のデータを、自分の環境で。
          </p>
        </div>
        <div className="login-footer">
          <span>LOCAL FIRST</span>
          <span>OPEN SOURCE</span>
          <span>PYTHON CONNECTED</span>
        </div>
      </section>
      <section className="login-form">
        <div className="login-icon">
          <ShieldCheck size={24} />
        </div>
        <h2>ワークベンチを開く</h2>
        <p>セットアップ時に生成したアクセストークンを入力してください。</p>
        <form onSubmit={login}>
          <label>
            アクセストークン
            <input
              autoFocus
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="current-password"
              placeholder="secrets/app_token.txt の内容"
              required
            />
          </label>
          {error && <p className="inline-error">{error}</p>}
          <button className="button primary" disabled={busy}>
            {busy ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <ArrowRight size={16} />
            )}
            開く
          </button>
        </form>
        <small>トークンはブラウザの永続ストレージに保存しません。</small>
      </section>
    </main>
  );
}

export default function App() {
  const [auth, setAuth] = useState<boolean | null>(null);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [ws, setWs] = useState<Workspace | null>(null);
  const [table, setTable] = useState<{ rows: Row[]; total: number }>({
    rows: [],
    total: 0,
  });
  const [offset, setOffset] = useState(0);
  const [tableLoading, setTableLoading] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [plot, setPlot] = useState<ChartData | null>(null);
  const [plotLoading, setPlotLoading] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [worker, setWorker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saveStatus, setSaveStatus] = useState("保存済み");
  const [importing, setImporting] = useState(false);
  const [history, setHistory] = useState(false);
  const [selectionDialog, setSelectionDialog] = useState(false);
  const [selectionName, setSelectionName] = useState("");
  const [mode, setMode] = useState<Mode>("replace");
  const [editMode, setEditMode] = useState(false);
  const [columnDetail, setColumnDetail] = useState("");
  const [showSidebar, setShowSidebar] = useState(true);
  const loadSequence = useRef(0);
  const latest = useRef({ dataset, ws });
  latest.current = { dataset, ws };
  const report = useCallback((e: unknown) => {
    if ((e as Error).name === "AbortError") return;
    if (e instanceof ApiError && e.status === 401) setAuth(false);
    setError((e as Error).message || String(e));
  }, []);
  const update = useCallback(
    (fn: (w: Workspace) => Workspace) => setWs((w) => (w ? fn(w) : w)),
    [],
  );
  const updateView = useCallback(
    (patch: Partial<View>) => {
      setOffset(0);
      update((w) => ({ ...w, view: { ...w.view, ...patch } }));
    },
    [update],
  );
  const updateConfig = useCallback(
    (patch: Partial<ChartConfig>) =>
      update((w) => ({ ...w, config: { ...w.config, ...patch } })),
    [update],
  );

  async function refreshList() {
    const ds = await request<Dataset[]>("/datasets");
    setDatasets(ds);
    return ds;
  }
  async function activate(id: string, latestRevision = false) {
    const seq = ++loadSequence.current;
    setBusy(true);
    setError("");
    try {
      const old = latest.current;
      if (old.dataset && old.ws)
        await request(`/datasets/${old.dataset.id}/state`, old.ws, "PUT");
      const [d, saved] = await Promise.all([
        request<Dataset>(`/datasets/${id}`),
        request<Partial<Workspace>>(`/datasets/${id}/state`),
      ]);
      if (seq !== loadSequence.current) return;
      const schema = d.schema || [];
      const initial = initialWorkspace(d.current_revision, schema);
      const next = {
        ...initial,
        ...saved,
        view: { ...initial.view, ...saved.view },
        config: { ...initial.config, ...saved.config },
      };
      if (
        latestRevision ||
        !d.versions.some((v) => v.revision === next.view.revision)
      )
        next.view.revision = d.current_revision;
      const actual =
        next.view.revision === d.current_revision
          ? d
          : await request<Dataset>(
              `/datasets/${id}?revision=${next.view.revision}`,
            );
      if (seq !== loadSequence.current) return;
      const actualSchema = actual.schema || [];
      const actualNames = new Set(actualSchema.map((c) => c.name));
      if (
        !actualSchema.some(
          (c) => c.name === next.config.y && c.kind === "number",
        )
      )
        next.config.y =
          actualSchema.find((c) => c.kind === "number")?.name || "";
      if (!actualNames.has(next.config.x))
        next.config.x = actualSchema[0]?.name || "";
      if (!actualNames.has(next.config.group)) next.config.group = "";
      next.view.filters = next.view.filters.filter((f) =>
        actualNames.has(f.column),
      );
      if (next.view.sort_by && !actualNames.has(next.view.sort_by))
        next.view.sort_by = null;
      setDataset(actual);
      setWs(next);
      setOffset(0);
      setTable({ rows: [], total: actual.rows });
      setProfile(null);
      setPlot(null);
      setColumnDetail("");
      setJob(null);
      setJobs([]);
      setEditMode(false);
      setSaveStatus("保存済み");
      localStorage.setItem("strata.activeDataset", id);
      request<Job[]>(`/jobs?dataset_id=${id}`)
        .then((js) => {
          if (seq === loadSequence.current) {
            setJobs(js);
            setJob(js[0] || null);
          }
        })
        .catch(report);
    } catch (e) {
      report(e);
    } finally {
      if (seq === loadSequence.current) setBusy(false);
    }
  }
  async function initialize() {
    try {
      const session = await request<{ worker_available: boolean }>("/session");
      setAuth(true);
      setWorker(session.worker_available);
      const ds = await refreshList();
      const remembered = localStorage.getItem("strata.activeDataset");
      const chosen = ds.find((d) => d.id === remembered) || ds[0];
      if (chosen) await activate(chosen.id);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setAuth(false);
      else report(e);
    }
  }
  useEffect(() => {
    initialize();
  }, []);
  useEffect(() => {
    if (!auth) return;
    const t = setInterval(
      () =>
        request<{ worker_available: boolean }>("/session")
          .then((s) => setWorker(s.worker_available))
          .catch(report),
      10000,
    );
    return () => clearInterval(t);
  }, [auth, report]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 3500);
    return () => clearTimeout(t);
  }, [notice]);
  const viewKey = ws ? JSON.stringify(dataQuery(ws.view)) : "";
  const profileKey = ws ? JSON.stringify(ws.view) : "";
  const chartKey = ws
    ? JSON.stringify({
        ...(["box", "histogram"].includes(ws.config.kind)
          ? ws.view
          : dataQuery(ws.view)),
        ...ws.config,
      })
    : "";
  useEffect(() => {
    if (!dataset || !ws) return;
    const controller = new AbortController();
    setTableLoading(true);
    request<{ rows: Row[]; total: number }>(
      `/datasets/${dataset.id}/table`,
      { ...dataQuery(ws.view), offset, limit: 500 },
      undefined,
      controller.signal,
    )
      .then((r) => {
        setTable(r);
        if (offset >= r.total && offset > 0) setOffset(0);
      })
      .catch(report)
      .finally(() => {
        if (!controller.signal.aborted) setTableLoading(false);
      });
    return () => controller.abort();
  }, [dataset?.id, viewKey, offset, report]);
  useEffect(() => {
    if (!dataset || !ws) return;
    const controller = new AbortController();
    const t = setTimeout(
      () =>
        request<Profile>(
          `/datasets/${dataset.id}/profile`,
          ws.view,
          undefined,
          controller.signal,
        )
          .then(setProfile)
          .catch(report),
      200,
    );
    return () => {
      clearTimeout(t);
      controller.abort();
    };
  }, [dataset?.id, profileKey, report]);
  useEffect(() => {
    if (!dataset || !ws || !ws.config.y) return;
    const controller = new AbortController();
    setPlotLoading(true);
    request<ChartData>(
      `/datasets/${dataset.id}/chart`,
      queryForChart(
        ["box", "histogram"].includes(ws.config.kind)
          ? ws.view
          : dataQuery(ws.view),
        ws.config,
      ),
      undefined,
      controller.signal,
    )
      .then(setPlot)
      .catch((e) => {
        if (e.name !== "AbortError") {
          setPlot(null);
          report(e);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setPlotLoading(false);
      });
    return () => controller.abort();
  }, [dataset?.id, chartKey, report]);
  useEffect(() => {
    if (!dataset || !ws) return;
    const controller = new AbortController();
    setSaveStatus("保存中…");
    const t = setTimeout(
      () =>
        request(`/datasets/${dataset.id}/state`, ws, "PUT", controller.signal)
          .then(() => setSaveStatus("保存済み"))
          .catch((e) => {
            if (e.name !== "AbortError") {
              setSaveStatus("保存失敗");
              report(e);
            }
          }),
      600,
    );
    return () => {
      clearTimeout(t);
      controller.abort();
    };
  }, [dataset?.id, ws, report]);
  useEffect(() => {
    if (!job || !["queued", "running"].includes(job.status)) return;
    const id = job.id;
    const t = setInterval(
      () =>
        request<Job>(`/jobs/${id}`)
          .then((j) => {
            setJob(j);
            setJobs((js) => [j, ...js.filter((x) => x.id !== id)]);
          })
          .catch(report),
      700,
    );
    return () => clearInterval(t);
  }, [job?.id, job?.status, report]);

  const selectIds = useCallback(
    (ids: number[], force = false) =>
      update((w) => {
        const next = mergeSelection(
          w.view.selected_ids,
          ids,
          force ? "replace" : mode,
        );
        if (next.length > 200000) {
          setError("選択の上限は20万行です。");
          return w;
        }
        return { ...w, view: { ...w.view, selected_ids: next } };
      }),
    [mode, update],
  );
  const checkRows = useCallback(
    (added: number[], removed: number[]) =>
      update((w) => {
        const next = applyRowChecks(w.view.selected_ids, added, removed);
        if (next.length > 200000) {
          setError("選択の上限は20万行です。");
          return w;
        }
        return { ...w, view: { ...w.view, selected_ids: next } };
      }),
    [update],
  );
  async function selectChart(
    s: {
      ids?: number[];
      criteria?: DataFilter[];
      axes?: { x: string; y: string };
    },
    pin?: Pin,
  ) {
    if (!dataset || !ws) return;
    if (s.axes) {
      updateConfig({ ...s.axes, kind: "scatter" });
      return;
    }
    if (s.ids) {
      selectIds(s.ids);
      return;
    }
    if (s.criteria) {
      try {
        const r = await request<{ ids: number[] }>(
          `/datasets/${dataset.id}/select`,
          { ...(pin?.view || ws.view), criteria: s.criteria },
        );
        if (
          latest.current.dataset?.id === dataset.id &&
          latest.current.ws?.view.revision === ws.view.revision
        )
          selectIds(r.ids);
      } catch (e) {
        report(e);
      }
    }
  }
  async function imported(d: Dataset) {
    setImporting(false);
    await refreshList();
    await activate(d.id, true);
    setNotice("データを読み込みました");
  }
  async function demo() {
    setBusy(true);
    try {
      await imported(await request<Dataset>("/demo", {}));
    } catch (e) {
      report(e);
      setBusy(false);
    }
  }
  async function run() {
    if (!dataset || !ws) return;
    setBusy(true);
    try {
      const j = await request<Job>(`/datasets/${dataset.id}/python`, {
        ...ws.view,
        code: ws.code,
        context: { ...ws.config, dataset_name: dataset.name },
      });
      setJob(j);
      setJobs((js) => [j, ...js]);
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  async function notebook() {
    if (!dataset || !ws) return;
    try {
      await download(
        `/datasets/${dataset.id}/notebook`,
        { view: ws.view, code: ws.code },
        "strata-analysis.ipynb",
      );
    } catch (e) {
      report(e);
    }
  }
  async function exportData(format: "parquet" | "csv") {
    if (!dataset || !ws) return;
    try {
      await download(
        `/datasets/${dataset.id}/export?format=${format}`,
        ws.view,
        `${dataset.name}.${format}`,
      );
    } catch (e) {
      report(e);
    }
  }
  async function edit(row_id: number, column: string, value: unknown) {
    if (!dataset || !ws) return;
    setBusy(true);
    try {
      const d = await request<Dataset>(`/datasets/${dataset.id}/edit`, {
        revision: ws.view.revision,
        row_id,
        column,
        value,
      });
      setDataset((prev) => ({ ...prev!, ...d }));
      updateView({ revision: d.current_revision });
      setNotice("変更を新しいリビジョンに保存しました");
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  async function switchRevision(revision: number) {
    if (!dataset) return;
    try {
      const d = await request<Dataset>(
        `/datasets/${dataset.id}?revision=${revision}`,
      );
      setDataset(d);
      setPlot(null);
      const schema = d.schema || [];
      const names = new Set(schema.map((c) => c.name));
      update((w) => ({
        ...w,
        view: {
          ...w.view,
          revision,
          selected_ids: [],
          excluded_ids: [],
          selection_only: false,
          filters: w.view.filters.filter((f) => names.has(f.column)),
          sort_by: names.has(w.view.sort_by || "") ? w.view.sort_by : null,
        },
        config:
          names.has(w.config.y) &&
          (!w.config.x || names.has(w.config.x)) &&
          (!w.config.group || names.has(w.config.group))
            ? w.config
            : initialWorkspace(revision, schema).config,
      }));
      setHistory(false);
      setOffset(0);
      setEditMode(false);
    } catch (e) {
      report(e);
    }
  }
  async function cast(dtype: "number" | "text" | "datetime") {
    if (!dataset || !ws) return;
    setBusy(true);
    try {
      await request(`/datasets/${dataset.id}/cast`, {
        revision: ws.view.revision,
        column: columnDetail,
        dtype,
      });
      await activate(dataset.id, true);
      setNotice("列の型を変更しました");
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  function pin() {
    if (!ws) return;
    if (ws.pins.length >= 8) {
      setError("比較は8個まで固定できます。");
      return;
    }
    update((w) => ({
      ...w,
      pins: [
        ...w.pins,
        {
          id: crypto.randomUUID(),
          title: `${w.config.y} / ${w.config.group || "全体"}`,
          config: { ...w.config },
          view: structuredClone(w.view),
          notes: "",
        },
      ],
    }));
    setNotice("比較に固定しました");
  }
  const schema = dataset?.schema || [];
  const columns = useMemo(() => {
    const rank = ws?.columnOrder || schema.map((c) => c.name);
    return [...schema].sort((a, b) => {
      const ai = rank.indexOf(a.name),
        bi = rank.indexOf(b.name);
      return (ai < 0 ? 9999 : ai) - (bi < 0 ? 9999 : bi);
    });
  }, [schema, ws?.columnOrder]);
  const valueProfile = profile?.columns.find(
    (c) => c.name === (columnDetail || ws?.config.y),
  );
  const selectedProfile = profile?.selected_columns.find(
    (c) => c.name === (columnDetail || ws?.config.y),
  );
  const selected = ws?.view.selected_ids || [];
  const dirtyRevision = !!(
    dataset &&
    ws &&
    dataset.current_revision !== ws.view.revision
  );
  const yStats = profile?.columns.find((c) => c.name === ws?.config.y);
  if (auth === null)
    return (
      <div className="initial-loading">
        <Layers3 size={32} />
        <LoaderCircle size={20} className="spin" />
        {error && <p>{error}</p>}
      </div>
    );
  if (!auth) return <Login onLogin={initialize} />;

  return (
    <div className="workbench">
      <header className="topbar">
        <div className="brand">
          <Layers3 size={23} />
          <span>
            strata<span className="brand-dot">.</span>
          </span>
        </div>
        <div className="topbar-divider" />
        <div className="dataset-picker">
          <Database size={16} />
          <select
            aria-label="データセット"
            value={dataset?.id || ""}
            disabled={busy}
            onChange={(e) => activate(e.target.value)}
          >
            {!dataset && <option value="">データを選択</option>}
            {datasets.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <ChevronDown size={13} />
        </div>
        <button
          className="button topbar-import"
          onClick={() => setImporting(true)}
        >
          <Plus size={14} />
          読み込む
        </button>
        <div className="topbar-spacer" />
        <span className="save-state">
          {saveStatus === "保存済み" ? <Check size={13} /> : <Save size={13} />}{" "}
          {saveStatus}
        </span>
        <button
          className="icon-button"
          title="データ一覧を更新"
          onClick={() => refreshList().catch(report)}
        >
          <RefreshCw size={16} />
        </button>
        <button
          className="icon-button"
          title="ログアウト"
          onClick={() =>
            request("/logout", {})
              .then(() => {
                setAuth(false);
                setDataset(null);
                setWs(null);
              })
              .catch(report)
          }
        >
          <LogOut size={16} />
        </button>
      </header>
      {error && (
        <div role="alert" className="error-banner">
          <span>{error}</span>
          <button
            className="icon-button"
            aria-label="エラーを閉じる"
            onClick={() => setError("")}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {notice && (
        <div role="status" className="toast">
          <Check size={16} />
          {notice}
        </div>
      )}
      {!dataset || !ws ? (
        <main className="welcome-workspace">
          <div className="welcome-icon">
            <Layers3 size={38} />
          </div>
          <div className="eyebrow">YOUR DATA, CONNECTED</div>
          <h1>データを眺めるところから。</h1>
          <p>
            表、グラフ、Pythonで同じ行を追いかける。
            <br />
            ファイルを開くか、工程測定サンプルで操作を試せます。
          </p>
          <div className="welcome-actions">
            <button
              className="button primary"
              onClick={() => setImporting(true)}
            >
              <FileUp size={17} />
              データを読み込む
            </button>
            <button className="button" disabled={busy} onClick={demo}>
              {busy ? (
                <LoaderCircle size={17} className="spin" />
              ) : (
                <Play size={17} />
              )}
              サンプルで試す
            </button>
          </div>
          <div className="welcome-note">
            サンプルは2,400行の合成データです。実際の製造データではありません。
          </div>
        </main>
      ) : (
        <>
          <div className="workspace-title">
            <div>
              <div className="eyebrow">
                WORKSPACE <span>/</span>{" "}
                {dataset.parent ? "DERIVED DATA" : "DATA EXPLORATION"}
              </div>
              <h1>{dataset.name}</h1>
            </div>
            <div className="workspace-meta">
              <span>
                <Table2 size={14} />
                {(
                  dataset.versions.find((v) => v.revision === ws.view.revision)
                    ?.rows || 0
                ).toLocaleString()}{" "}
                行
              </span>
              <span>{schema.length} 列</span>
              <button
                className={`revision-badge ${dirtyRevision ? "historical" : ""}`}
                onClick={() => setHistory(true)}
              >
                <History size={13} />r{ws.view.revision}
                <ChevronDown size={11} />
              </button>
              {dataset.parent && (
                <button
                  className="link-button"
                  onClick={() => activate(dataset.parent!.dataset_id)}
                >
                  元データへ
                </button>
              )}
            </div>
          </div>
          <nav className="workspace-nav">
            <button
              className="icon-button sidebar-toggle"
              title="列パネルを切り替え"
              onClick={() => setShowSidebar(!showSidebar)}
            >
              <PanelLeftClose size={17} />
            </button>
            {(
              [
                { id: "explore", label: "探索", icon: ScatterChart },
                { id: "compare", label: "比較", icon: Columns2 },
                { id: "python", label: "Python", icon: Code2 },
              ] as const
            ).map((t) => (
              <button
                key={t.id}
                className={`tab ${ws.activeTab === t.id ? "active" : ""}`}
                onClick={() => update((w) => ({ ...w, activeTab: t.id }))}
              >
                <t.icon size={16} />
                {t.label}
                {t.id === "compare" && ws.pins.length > 0 && (
                  <span className="tab-count">{ws.pins.length}</span>
                )}
              </button>
            ))}
            <div className="topbar-spacer" />
            <div
              className="selection-modes"
              title="グラフとセル範囲の選択に適用。行のチェックは個別に追加・解除します。"
            >
              <MousePointer2 size={13} />
              <span>選択</span>
              {(
                [
                  { id: "replace", name: "置換" },
                  { id: "add", name: "追加" },
                  { id: "subtract", name: "解除" },
                ] as const
              ).map((m) => (
                <button
                  key={m.id}
                  className={mode === m.id ? "active" : ""}
                  onClick={() => setMode(m.id)}
                >
                  {m.name}
                </button>
              ))}
            </div>
          </nav>
          <div
            className={`workspace-body ${!showSidebar ? "sidebar-hidden" : ""}`}
          >
            {showSidebar && (
              <Sidebar
                columns={schema}
                profile={profile}
                view={ws.view}
                y={ws.config.y}
                onY={(name) => updateConfig({ y: name })}
                onColumn={setColumnDetail}
                onFilter={(f) =>
                  updateView({ filters: [...ws.view.filters, f] })
                }
                onRemove={(i) =>
                  updateView({
                    filters: ws.view.filters.filter((_, idx) => idx !== i),
                  })
                }
              />
            )}
            <main className="main-workspace">
              {ws.activeTab === "explore" && (
                <section className="explore-pane">
                  <div className="chart-toolbar">
                    <div className="chart-type">
                      <BarChart3 size={16} />
                      <select
                        aria-label="グラフの種類"
                        value={ws.config.kind}
                        onChange={(e) => {
                          const kind = e.target.value as ChartConfig["kind"];
                          updateConfig({
                            kind,
                            ...(kind === "time"
                              ? { x: defaultTimeColumn(schema) }
                              : {}),
                          });
                        }}
                      >
                        {Object.entries(kindLabels).map(([v, l]) => (
                          <option key={v} value={v}>
                            {l}
                          </option>
                        ))}
                      </select>
                    </div>
                    <label className="axis-control">
                      <b>Y</b>
                      <select
                        aria-label="Y列"
                        value={ws.config.y}
                        onChange={(e) => {
                          updateConfig({ y: e.target.value });
                          setColumnDetail(e.target.value);
                        }}
                      >
                        {schema
                          .filter((c) => c.kind === "number")
                          .map((c) => (
                            <option key={c.name}>{c.name}</option>
                          ))}
                      </select>
                    </label>
                    {["scatter", "time"].includes(ws.config.kind) && (
                      <label className="axis-control">
                        <b>X</b>
                        <select
                          aria-label="X列"
                          value={ws.config.x}
                          onChange={(e) => updateConfig({ x: e.target.value })}
                        >
                          {schema.map((c) => (
                            <option key={c.name}>{c.name}</option>
                          ))}
                        </select>
                      </label>
                    )}
                    <label className="axis-control group-control">
                      <b>層別</b>
                      <select
                        aria-label="層別列"
                        value={ws.config.group}
                        onChange={(e) =>
                          updateConfig({ group: e.target.value })
                        }
                      >
                        <option value="">なし</option>
                        {schema.map((c) => (
                          <option key={c.name}>{c.name}</option>
                        ))}
                      </select>
                    </label>
                    <button
                      className="button pin-button"
                      disabled={!plot || plotLoading}
                      onClick={pin}
                    >
                      <PinIcon size={14} />
                      比較に固定
                    </button>
                  </div>
                  <div className="explore-content">
                    <div className="plot-panel">
                      <div className="plot-caption">
                        <b>{ws.config.y || "数値列を選択してください"}</b>
                        <span>
                          {kindLabels[ws.config.kind]}
                          {ws.config.group ? ` / ${ws.config.group}で層別` : ""}
                        </span>
                        <small>n = {table.total.toLocaleString()}</small>
                      </div>
                      <div className="main-plot">
                        {plotLoading ? (
                          <div className="chart-loader">
                            <LoaderCircle size={20} className="spin" />
                            <span>集計中…</span>
                          </div>
                        ) : plot ? (
                          <Chart
                            data={plot}
                            config={ws.config}
                            selected={selected}
                            onSelect={selectChart}
                            identity={`${dataset.id}-${ws.view.revision}-${ws.config.kind}-${ws.config.x}-${ws.config.y}-${ws.config.group}`}
                          />
                        ) : (
                          <div className="chart-loader">
                            数値列を選ぶとグラフを表示します
                          </div>
                        )}
                      </div>
                      <div className="plot-footnote">
                        <span>
                          {ws.config.kind === "box" && plot?.outlier_count
                            ? `IQR外側 ${plot.outlier_count.toLocaleString()}点 / 描画 ${plot.outliers?.length.toLocaleString()}点 · `
                            : ""}
                          {plot?.sampled
                            ? `描画 ${plot.rendered.toLocaleString()} / 有効 ${plot.valid.toLocaleString()} 行 · 点の選択は描画した行のみ`
                            : `${["box", "histogram", "correlation"].includes(ws.config.kind) ? "集計は対象の全行" : "有効な行を全点表示"} · 拡大はツールバーから`}
                        </span>
                        {ws.config.kind === "histogram" && (
                          <label>
                            ビン数
                            <select
                              aria-label="ヒストグラムのビン数"
                              value={ws.config.bins}
                              onChange={(e) =>
                                updateConfig({ bins: Number(e.target.value) })
                              }
                            >
                              {[10, 16, 24, 40, 60].map((n) => (
                                <option key={n}>{n}</option>
                              ))}
                            </select>
                          </label>
                        )}
                      </div>
                    </div>
                    <aside className="summary-panel">
                      <div className="summary-title">
                        <Hash size={14} />
                        <b>{columnDetail || ws.config.y}</b>
                      </div>
                      <small className="summary-subtitle">
                        全体と選択した集団
                      </small>
                      <table className="summary-table">
                        <thead>
                          <tr>
                            <th />
                            <th>対象</th>
                            <th className="teal">選択</th>
                          </tr>
                        </thead>
                        <tbody>
                          {[
                            ["件数", "count"],
                            ["欠損", "nulls"],
                            ["平均", "mean"],
                            ["標準偏差", "std"],
                            ["中央値", "median"],
                            ["最小", "min"],
                            ["最大", "max"],
                          ].map(([label, key]) => (
                            <tr key={key}>
                              <th>{label}</th>
                              <td>
                                {format(valueProfile?.[key as keyof Column])}
                              </td>
                              <td className="teal">
                                {format(selectedProfile?.[key as keyof Column])}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {valueProfile?.values && (
                        <div className="category-summary">
                          {valueProfile.values.slice(0, 8).map((v, i) => (
                            <button
                              key={i}
                              onClick={() =>
                                selectChart({
                                  criteria: [
                                    {
                                      column: valueProfile.name,
                                      op: "eq",
                                      value: v.value,
                                    },
                                  ],
                                })
                              }
                            >
                              <span>{format(v.value)}</span>
                              <b>{v.count.toLocaleString()}</b>
                            </button>
                          ))}
                        </div>
                      )}
                      <div className="summary-actions">
                        <label>
                          列の型
                          <select
                            aria-label="列の型を変更"
                            value=""
                            disabled={dirtyRevision || busy || !columnDetail}
                            onChange={(e) =>
                              cast(
                                e.target.value as
                                  | "number"
                                  | "text"
                                  | "datetime",
                              )
                            }
                          >
                            <option value="">変更…</option>
                            <option value="number">数値</option>
                            <option value="text">文字列</option>
                            <option value="datetime">日時</option>
                          </select>
                        </label>
                        <small>型の変更は新しいリビジョンに保存</small>
                      </div>
                    </aside>
                  </div>
                </section>
              )}
              {ws.activeTab === "compare" && (
                <Compare
                  datasetId={dataset.id}
                  pins={ws.pins}
                  revision={ws.view.revision}
                  selected={selected}
                  onSelect={(p, s) => selectChart(s, p)}
                  onUpdate={(p) =>
                    update((w) => ({
                      ...w,
                      pins: w.pins.map((x) => (x.id === p.id ? p : x)),
                    }))
                  }
                  onRemove={(id) =>
                    update((w) => ({
                      ...w,
                      pins: w.pins.filter((p) => p.id !== id),
                    }))
                  }
                  onError={report}
                />
              )}
              {ws.activeTab === "python" && (
                <PythonPane
                  dataset={dataset}
                  code={ws.code}
                  onCode={(code) => update((w) => ({ ...w, code }))}
                  job={job}
                  jobs={jobs}
                  onJob={setJob}
                  onRun={run}
                  onCancel={() =>
                    job && request(`/jobs/${job.id}/cancel`, {}).catch(report)
                  }
                  onNotebook={notebook}
                  onPublished={imported}
                  onSelect={(ids) => {
                    selectIds(ids, true);
                    update((w) => ({ ...w, activeTab: "explore" }));
                  }}
                  onError={report}
                  rows={table.total}
                  selected={profile?.selected_count || 0}
                  busy={busy}
                  revision={ws.view.revision}
                />
              )}
              <section
                className={`table-pane ${ws.activeTab === "python" ? "compact-table" : ""}`}
              >
                <div className="table-toolbar">
                  <div className="table-label">
                    <Table2 size={15} />
                    <b>データテーブル</b>
                    {tableLoading && (
                      <LoaderCircle size={12} className="spin" />
                    )}
                  </div>
                  <div className="selected-indicator">
                    <span className="selection-dot" />
                    {selected.length.toLocaleString()} 行選択
                  </div>
                  <button
                    className={`button small ${ws.view.selection_only ? "active-filter" : ""}`}
                    disabled={!selected.length && !ws.view.selection_only}
                    onClick={() =>
                      updateView({ selection_only: !ws.view.selection_only })
                    }
                  >
                    <Filter size={12} />
                    {ws.view.selection_only ? "選択行のみ表示中" : "選択行のみ"}
                  </button>
                  <button
                    className="icon-button"
                    title="選択をクリア"
                    disabled={!selected.length}
                    onClick={() =>
                      updateView({ selected_ids: [], selection_only: false })
                    }
                  >
                    <X size={14} />
                  </button>
                  <button
                    className="icon-button"
                    title="選択を保存・呼び出し"
                    onClick={() => setSelectionDialog(true)}
                  >
                    <Save size={14} />
                  </button>
                  <button
                    className="icon-button"
                    title="選択行を分析対象から除外"
                    disabled={!selected.length}
                    onClick={() =>
                      updateView({
                        excluded_ids: [
                          ...new Set([...ws.view.excluded_ids, ...selected]),
                        ],
                        selected_ids: [],
                        selection_only: false,
                      })
                    }
                  >
                    <Trash2 size={14} />
                  </button>
                  {ws.view.excluded_ids.length > 0 && (
                    <button
                      className="link-button"
                      onClick={() => updateView({ excluded_ids: [] })}
                    >
                      <Undo2 size={12} />
                      {ws.view.excluded_ids.length}行の除外を戻す
                    </button>
                  )}
                  <div className="topbar-spacer" />
                  <label className="edit-toggle">
                    <input
                      type="checkbox"
                      checked={editMode}
                      disabled={dirtyRevision}
                      onChange={(e) => setEditMode(e.target.checked)}
                    />
                    セル編集
                  </label>
                  <select
                    className="export-select"
                    aria-label="データをエクスポート"
                    value=""
                    onChange={(e) =>
                      exportData(e.target.value as "csv" | "parquet")
                    }
                  >
                    <option value="" disabled>
                      書き出し ↓
                    </option>
                    <option value="parquet">Parquet</option>
                    <option value="csv">CSV</option>
                  </select>
                </div>
                <DataTable
                  rows={table.rows}
                  columns={columns}
                  selected={selected}
                  onSelect={selectIds}
                  onCheck={checkRows}
                  onSort={(name) =>
                    updateView({
                      sort_by: name,
                      descending:
                        ws.view.sort_by === name ? !ws.view.descending : false,
                    })
                  }
                  onEdit={edit}
                  onColumns={(names) =>
                    update((w) => ({ ...w, columnOrder: names }))
                  }
                  sort={ws.view.sort_by}
                  descending={ws.view.descending}
                  editable={editMode && !busy}
                  disabled={tableLoading || busy}
                  offset={offset}
                />
                <div className="table-footer">
                  <span>
                    {table.total
                      ? `${(offset + 1).toLocaleString()}–${Math.min(offset + 500, table.total).toLocaleString()}`
                      : "0"}{" "}
                    / {table.total.toLocaleString()} 行
                    <small>行番号は表示内の位置 · 元の行IDを内部保持</small>
                  </span>
                  <div>
                    <button
                      className="icon-button"
                      disabled={offset === 0 || tableLoading}
                      onClick={() => setOffset(Math.max(0, offset - 500))}
                      title="前の500行"
                    >
                      <ArrowLeft size={14} />
                    </button>
                    <span>
                      {Math.floor(offset / 500) + 1} /{" "}
                      {Math.max(1, Math.ceil(table.total / 500))}
                    </span>
                    <button
                      className="icon-button"
                      disabled={offset + 500 >= table.total || tableLoading}
                      onClick={() => setOffset(offset + 500)}
                      title="次の500行"
                    >
                      <ArrowRight size={14} />
                    </button>
                  </div>
                </div>
              </section>
            </main>
          </div>
          <footer className="statusbar">
            <span>
              <span className={`worker-dot ${worker ? "online" : ""}`} />
              Python {worker ? "接続済み" : "未接続"}
            </span>
            <span>
              対象 {table.total.toLocaleString()} 行
              {yStats?.nulls ? ` · ${ws.config.y} 欠損 ${yStats.nulls} 件` : ""}
            </span>
            <div className="topbar-spacer" />
            <button onClick={notebook}>
              <BookOpen size={12} />
              Notebookに引き継ぐ
            </button>
          </footer>
        </>
      )}
      {importing && (
        <ImportDialog
          onClose={() => setImporting(false)}
          onImported={imported}
        />
      )}
      {history && dataset && ws && (
        <Modal title="データの履歴" onClose={() => setHistory(false)}>
          <div className="modal-body">
            <p className="muted">
              過去の状態を開いて確認できます。元のファイルと各リビジョンは保持されます。
            </p>
            <div className="revision-list">
              {[...dataset.versions].reverse().map((v) => (
                <button
                  className={v.revision === ws.view.revision ? "active" : ""}
                  key={v.revision}
                  onClick={() => switchRevision(v.revision)}
                >
                  <b>r{v.revision}</b>
                  <span>
                    {v.operation}
                    <small>
                      {new Date(v.created_at).toLocaleString("ja-JP")} ·{" "}
                      {v.rows.toLocaleString()}行
                    </small>
                  </span>
                  {v.revision === ws.view.revision && <Check size={16} />}
                </button>
              ))}
            </div>
            <label>
              分析メモ
              <textarea
                rows={5}
                value={ws.notes}
                placeholder="分かったこと、仮説、次の確認事項"
                onChange={(e) =>
                  update((w) => ({ ...w, notes: e.target.value }))
                }
              />
            </label>
          </div>
        </Modal>
      )}
      {selectionDialog && ws && (
        <Modal title="選択した集団" onClose={() => setSelectionDialog(false)}>
          <div className="modal-body">
            <p className="muted">選択は行IDとリビジョンの組で保存します。</p>
            <div className="form-row">
              <input
                aria-label="選択名"
                value={selectionName}
                placeholder="例: 夜勤・設備03の候補"
                onChange={(e) => setSelectionName(e.target.value)}
              />
              <button
                className="button primary"
                disabled={!selected.length || !selectionName.trim()}
                onClick={() => {
                  update((w) => ({
                    ...w,
                    selections: [
                      ...w.selections,
                      {
                        id: crypto.randomUUID(),
                        name: selectionName,
                        ids: [...selected],
                        revision: w.view.revision,
                      },
                    ],
                  }));
                  setSelectionName("");
                }}
              >
                保存
              </button>
            </div>
            <div className="saved-selections">
              {ws.selections.map((s) => (
                <div key={s.id}>
                  <button
                    disabled={s.revision !== ws.view.revision}
                    onClick={() => {
                      selectIds(s.ids, true);
                      setSelectionDialog(false);
                    }}
                  >
                    <b>{s.name}</b>
                    <small>
                      {s.ids.length.toLocaleString()}行 · r{s.revision}
                    </small>
                  </button>
                  <button
                    className="icon-button"
                    title="保存した選択を削除"
                    onClick={() =>
                      update((w) => ({
                        ...w,
                        selections: w.selections.filter((x) => x.id !== s.id),
                      }))
                    }
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
