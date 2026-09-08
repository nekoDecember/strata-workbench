import { useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { python } from "@codemirror/lang-python";
import {
  ArrowUpRight,
  Download,
  History,
  LoaderCircle,
  Play,
  Square,
  Terminal,
} from "lucide-react";
import { PythonFigure } from "./Chart";
import type { Dataset, Job } from "./types";
import { request } from "./api";
import { format, INITIAL_CODE } from "./state";

const templates: Record<string, string> = {
  集計と行へのリンク: `# 集約した各行から、元の測定行へ戻れます。
value, group = context["y"], context.get("group")
if not group:
    raise ValueError("先に探索画面で層別列を選んでください。")
groups = list(df.groupby(group, dropna=False))
summary = pd.DataFrame([
    {group: key, "n": len(part), "mean": part[value].mean(),
     "std": part[value].std(), "median": part[value].median()}
    for key, part in groups
])
wb.show(summary, name="層別サマリー",
        row_ids=[part["__row_id"].tolist() for _, part in groups])`,
  派生列を表に戻す: `value, group = context["y"], context.get("group")
out = df.copy()
if group:
    out["層内平均との差"] = out[value] - out.groupby(group)[value].transform("mean")
else:
    out["平均との差"] = out[value] - out[value].mean()
# __row_id を残すことで元の測定行との対応を保持します。
wb.publish(out, name="平均からの差を追加")
wb.show(out.head(12), name="追加列のプレビュー")`,
  一元配置ANOVA: `from scipy import stats
value, group = context["y"], context.get("group")
if not group:
    raise ValueError("層別列を選んでください。")
parts = [p[value].dropna() for _, p in df.groupby(group, dropna=False)]
parts = [p for p in parts if len(p) >= 2]
if len(parts) < 2:
    raise ValueError("2行以上の有効値を持つ群が2つ以上必要です。")
f, p = stats.f_oneway(*parts)
wb.show(pd.DataFrame([{"F": f, "p": p, "群数": len(parts)}]), name="一元配置ANOVA")
print("独立性・等分散性などの前提を別途確認してください。時系列やロット内の依存に注意。")`,
  選択行とそれ以外を比較: `value = context["y"]
rest = df.loc[~selection_mask]
summary = pd.DataFrame({
    "選択": selected[value].describe(),
    "それ以外": rest[value].describe(),
})
wb.show(summary, name="選択した集団の特徴")`,
  Pythonから行を選択: `value = context["y"]
q1, q3 = df[value].quantile([0.25, 0.75])
iqr = q3 - q1
mask = (df[value] < q1 - 1.5*iqr) | (df[value] > q3 + 1.5*iqr)
wb.select(df.loc[mask, "__row_id"].tolist(), name="IQR基準の候補")
print("探索用の候補です。自動で除外や異常判定はしません。")`,
  Plotlyで描画: `import plotly.express as px
value, group = context["y"], context.get("group")
fig = px.box(df, x=group or None, y=value, color=group or None,
             points="outliers", title="Pythonから描画")
wb.show(fig, name="層別分布")`,
};
const statusLabel: Record<string, string> = {
  queued: "実行待ち",
  running: "実行中",
  succeeded: "完了",
  failed: "エラー",
  cancelled: "中止",
  timed_out: "時間切れ",
};

type Props = {
  dataset: Dataset;
  code: string;
  onCode: (s: string) => void;
  job: Job | null;
  jobs: Job[];
  onJob: (j: Job) => void;
  onRun: () => void;
  onCancel: () => void;
  onNotebook: () => void;
  onPublished: (d: Dataset) => void;
  onSelect: (ids: number[]) => void;
  onError: (e: unknown) => void;
  rows: number;
  selected: number;
  busy: boolean;
  revision: number;
};
export default function PythonPane(p: Props) {
  const [history, setHistory] = useState(false);
  const running = p.job && ["queued", "running"].includes(p.job.status);
  return (
    <section className="python-pane">
      <div className="python-editor">
        <div className="panel-heading">
          <span>
            <Terminal size={16} /> Python
          </span>
          <select
            aria-label="Pythonテンプレート"
            value=""
            onChange={(e) =>
              p.onCode(
                e.target.value === "summary"
                  ? INITIAL_CODE
                  : templates[e.target.value],
              )
            }
          >
            <option value="" disabled>
              スニペットを挿入
            </option>
            <option value="summary">基本の要約</option>
            {Object.keys(templates).map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </div>
        <div className="python-context">
          <code>df</code> {p.rows.toLocaleString()}行 <code>selected</code>{" "}
          {p.selected.toLocaleString()}行{" "}
          <span>r{p.revision} · 表示条件を固定して実行</span>
        </div>
        <div
          className="code-surface"
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
              e.preventDefault();
              if (!running && !p.busy) p.onRun();
            }
          }}
        >
          <CodeMirror
            value={p.code}
            onChange={p.onCode}
            extensions={[python()]}
            height="100%"
            theme="light"
            basicSetup={{
              lineNumbers: true,
              foldGutter: true,
              highlightActiveLine: true,
            }}
          />
        </div>
        <div className="editor-actions">
          <button className="button" onClick={p.onNotebook}>
            <Download size={14} />
            Notebook
          </button>
          <span className="muted">Ctrl / ⌘ + Enter</span>
          {running ? (
            <button className="button danger" onClick={p.onCancel}>
              <Square size={13} />
              中止
            </button>
          ) : (
            <button
              className="button primary"
              onClick={p.onRun}
              disabled={p.busy || !p.code.trim()}
            >
              <Play size={14} />
              実行
            </button>
          )}
        </div>
        <div className="python-help">
          <code>wb.show(table, row_ids=[...])</code>
          <span>集約表から元の行へ</span>
          <code>wb.publish(df, name="...")</code>
          <span>派生データとして開く</span>
          <code>wb.select(ids)</code>
          <span>Pythonの条件で行を選択</span>
        </div>
      </div>
      <div className="python-output">
        <div className="panel-heading">
          <span>
            出力{" "}
            {p.job && (
              <span className={`job-status ${p.job.status}`}>
                {running && <LoaderCircle size={12} className="spin" />}
                {statusLabel[p.job.status] || p.job.status}
              </span>
            )}
          </span>
          <button
            className="icon-button"
            onClick={() => setHistory(!history)}
            title="実行履歴"
          >
            <History size={17} />
          </button>
        </div>
        {history && (
          <div className="job-history">
            {p.jobs.map((j) => (
              <button
                key={j.id}
                className={j.id === p.job?.id ? "active" : ""}
                onClick={() => {
                  p.onJob(j);
                  setHistory(false);
                }}
              >
                <span>{new Date(j.created_at).toLocaleString("ja-JP")}</span>
                <small>
                  r{j.revision} · {statusLabel[j.status]}
                </small>
              </button>
            ))}
            {!p.jobs.length && (
              <p className="muted">実行履歴はまだありません</p>
            )}
          </div>
        )}
        {!p.job && (
          <div className="output-empty">
            <Terminal size={30} />
            <b>探索の続きをPythonで</b>
            <p>
              現在のデータと選択行をそのまま使えます。
              <br />
              表・図・派生列をここに返せます。
            </p>
          </div>
        )}
        {p.job && (
          <div className="output-content">
            <div className="output-meta">
              r{p.job.revision} · 入力 {p.job.rows.toLocaleString()} 行
              {p.job.duration_seconds !== undefined &&
                ` · ${p.job.duration_seconds}s`}
              <button
                className="link-button"
                onClick={() => p.onCode(p.job!.code)}
              >
                このコードを復元
              </button>
            </div>
            {p.job.error && <div className="inline-error">{p.job.error}</div>}
            {p.job.stdout && (
              <pre className="stdout">
                {p.job.stdout}
                {p.job.stdout_truncated ? "\n…出力を省略しました" : ""}
              </pre>
            )}
            {p.job.artifacts?.map((a) => (
              <div className="artifact" key={a.file}>
                <div className="artifact-heading">
                  <b>{a.name}</b>
                  {a.rows !== undefined && (
                    <small>{a.rows.toLocaleString()}行</small>
                  )}
                  <a
                    href={`/api/jobs/${p.job!.id}/artifacts/${a.file}`}
                    download={a.file}
                    className="icon-button"
                    title="出力を保存"
                  >
                    <Download size={14} />
                  </a>
                </div>
                {a.kind === "dataset" && (
                  <div className="published-card">
                    <div>
                      <span>{a.columns?.join(" · ")}</span>
                      <small>
                        元のデータを保持して新しいデータとして開きます
                      </small>
                    </div>
                    <button
                      className="button primary"
                      disabled={p.job!.status !== "succeeded"}
                      onClick={() =>
                        request<Dataset>(
                          `/jobs/${p.job!.id}/publish/${a.file}`,
                          {},
                        )
                          .then(p.onPublished)
                          .catch(p.onError)
                      }
                    >
                      表に戻す
                      <ArrowUpRight size={14} />
                    </button>
                  </div>
                )}
                {a.kind === "table" && (
                  <div className="result-table-wrap">
                    <table className="result-table">
                      <thead>
                        <tr>
                          {a.row_ids && <th>元の行</th>}
                          {a.columns?.map((c) => (
                            <th key={c}>{c}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {a.preview?.map((r, i) => (
                          <tr key={i}>
                            {a.row_ids && (
                              <td>
                                <button
                                  className="link-button"
                                  disabled={
                                    p.revision !== p.job?.revision ||
                                    p.dataset.id !== p.job.dataset_id
                                  }
                                  onClick={() =>
                                    p.onSelect(a.row_ids![i] || [])
                                  }
                                >
                                  選択 ({a.row_ids![i]?.length || 0})
                                </button>
                              </td>
                            )}
                            {a.columns?.map((c) => (
                              <td key={c}>{format(r[c])}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {(a.rows || 0) > 100 && (
                      <p className="muted">
                        先頭100行を表示。保存ファイルには全行が含まれます。
                      </p>
                    )}
                  </div>
                )}
                {a.kind === "selection" && (
                  <button
                    className="button"
                    disabled={
                      p.revision !== p.job?.revision ||
                      p.dataset.id !== p.job.dataset_id
                    }
                    onClick={() => p.onSelect(a.ids || [])}
                  >
                    探索画面で {a.ids?.length.toLocaleString()} 行を選択
                    <ArrowUpRight size={14} />
                  </button>
                )}
                {a.kind === "plotly" && (
                  <PythonFigure
                    url={`/api/jobs/${p.job!.id}/artifacts/${a.file}`}
                  />
                )}
                {a.kind === "image" && (
                  <img
                    className="python-image"
                    alt={a.name}
                    src={`/api/jobs/${p.job!.id}/artifacts/${a.file}`}
                  />
                )}
                {a.kind === "text" && <pre className="stdout">{a.text}</pre>}
              </div>
            ))}
            {p.job.status === "succeeded" &&
              !p.job.stdout &&
              !p.job.artifacts?.length && (
                <p className="muted">
                  実行は完了しました。出力するには print() / wb.show() /
                  wb.publish() を使ってください。
                </p>
              )}
          </div>
        )}
      </div>
    </section>
  );
}
