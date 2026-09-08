import { useEffect, useState } from "react";
import { Database, FileUp, LoaderCircle } from "lucide-react";
import Modal from "./Modal";
import { request } from "./api";
import type { Dataset } from "./types";
export default function ImportDialog({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: (d: Dataset) => void;
}) {
  const [tab, setTab] = useState<"file" | "sql">("file");
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [encoding, setEncoding] = useState("utf-8");
  const [sep, setSep] = useState(",");
  const [sheet, setSheet] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [connections, setConnections] = useState<string[]>([]);
  const [connection, setConnection] = useState("");
  const [sql, setSql] = useState("SELECT *\nFROM measurements\nLIMIT 10000");
  useEffect(() => {
    request<string[]>("/connections")
      .then((c) => {
        setConnections(c);
        setConnection(c[0] || "");
      })
      .catch((e) => setError(e.message));
  }, []);
  async function submit() {
    setBusy(true);
    setError("");
    try {
      let d: Dataset;
      if (tab === "file") {
        if (!file) throw Error("ファイルを選択してください。");
        if (file.size > 128 * 1024 * 1024)
          throw Error("ファイルの上限は128MiBです。");
        const f = new FormData();
        f.append("file", file);
        f.append("name", name);
        f.append("encoding", encoding);
        f.append("separator", sep);
        f.append("sheet", sheet);
        d = await request<Dataset>("/datasets", f);
      } else
        d = await request<Dataset>("/sql", {
          connection,
          query: sql,
          name: name || "SQL import",
        });
      onImported(d);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="データを読み込む" onClose={onClose}>
      <div className="segmented import-tabs">
        <button
          className={tab === "file" ? "active" : ""}
          onClick={() => setTab("file")}
        >
          <FileUp size={15} />
          ファイル
        </button>
        <button
          className={tab === "sql" ? "active" : ""}
          onClick={() => setTab("sql")}
        >
          <Database size={15} />
          PostgreSQL
        </button>
      </div>
      <div className="modal-body">
        {tab === "file" ? (
          <>
            <label
              className={`file-drop ${file ? "has-file" : ""}`}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                setFile(e.dataTransfer.files[0] || null);
              }}
            >
              <FileUp size={30} />
              <b>{file ? file.name : "ファイルをドロップ、または選択"}</b>
              <span>CSV / TSV / Parquet / XLSX · 最大128MiB</span>
              <input
                aria-label="データファイル"
                type="file"
                accept=".csv,.tsv,.txt,.parquet,.xlsx"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
              />
            </label>
            <div className="form-row">
              <label>
                CSVの文字コード
                <select
                  value={encoding}
                  onChange={(e) => setEncoding(e.target.value)}
                >
                  <option value="utf-8">UTF-8</option>
                  <option value="utf-8-sig">UTF-8 (BOM)</option>
                  <option value="cp932">CP932 / Windows日本語</option>
                  <option value="shift_jis">Shift JIS</option>
                </select>
              </label>
              <label>
                区切り
                <select value={sep} onChange={(e) => setSep(e.target.value)}>
                  <option value=",">カンマ</option>
                  <option value="\t">タブ</option>
                  <option value=";">セミコロン</option>
                </select>
              </label>
            </div>
            <label>
              Excelシート名
              <input
                value={sheet}
                onChange={(e) => setSheet(e.target.value)}
                placeholder="空欄なら先頭のシート"
              />
            </label>
          </>
        ) : (
          <>
            <label>
              登録済みの接続
              <select
                value={connection}
                onChange={(e) => setConnection(e.target.value)}
              >
                {!connections.length && <option value="">登録なし</option>}
                {connections.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            {!connections.length && (
              <p className="muted">
                接続先はサーバーの connections.json
                に登録します。DSNは画面やPython実行ワーカーには渡しません。
              </p>
            )}
            <label>
              読み取り専用SQL
              <textarea
                className="sql-editor"
                value={sql}
                onChange={(e) => setSql(e.target.value)}
                rows={7}
              />
            </label>
            <p className="muted">
              最大20万行・30秒。取込結果はスナップショットとして保存します。
            </p>
          </>
        )}
        <label>
          データ名
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={file?.name || "任意の名前"}
          />
        </label>
        {error && <p className="inline-error">{error}</p>}
        <div className="modal-actions">
          <button className="button" onClick={onClose}>
            キャンセル
          </button>
          <button
            className="button primary"
            disabled={busy || (tab === "file" ? !file : !connection)}
            onClick={submit}
          >
            {busy ? (
              <LoaderCircle size={15} className="spin" />
            ) : (
              <FileUp size={15} />
            )}
            読み込む
          </button>
        </div>
      </div>
    </Modal>
  );
}
