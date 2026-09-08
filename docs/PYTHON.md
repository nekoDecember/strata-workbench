# Python連携

## 画面内の実行モデル

「実行」を押した時点のリビジョン、表示条件、選択行、コードをジョブとして保存します。APIはその条件の全データをParquetでワーカーに渡し、ワーカーが新しいPythonプロセスで実行します。画面で表示していないページの行も `df` に含まれます。

過去の実行は履歴から参照できます。出力した表の行リンク・選択を使えるのは、現在のデータIDとリビジョンがその実行時と一致する場合です。画面を切り替えても既に実行中のジョブの入力条件は変わりません。

## `wb.show(value, name="Result", row_ids=None)`

対応する出力:

- pandas / Polars DataFrame、pandas Series: 表。先頭100行を表示、全行をParquetに保存。
- Plotly Figure: JSONとして保存し、ブラウザで操作可能な図として描画。
- Matplotlib Figure: PNGに保存して表示。
- その他: プレーンテキスト。

`row_ids` は表の各行に対応する元の `__row_id` のリストです。表と同じ長さの「リストのリスト」を渡します。各IDは今回の `df` に含まれている必要があります。

```python
summary = pd.DataFrame({"group": ["選択", "それ以外"],
                        "mean": [selected[context["y"]].mean(),
                                 df.loc[~selection_mask, context["y"]].mean()]})
wb.show(summary, "選択の比較", row_ids=[
    selected["__row_id"].tolist(),
    df.loc[~selection_mask, "__row_id"].tolist(),
])
```

集計表をクリックして抽出されるのは紐付けた元の観測です。集計表の表示位置やDataFrameのインデックスを元データのIDとして推測しません。

## `wb.publish(frame, name="Python result")`

出力を派生データの候補として保存します。画面の「表に戻す」で登録されます。コード内で `df` を変更しただけでは元データは更新されません。

- 行レベルの変換: `__row_id` を保持。並べ替えや絞り込み後も同じ観測に戻れます。
- 集計や結合で行の意味が変わる場合: `__row_id` を取り除いて新しい観測単位として登録。
- `__row_id` の重複や欠損は拒否。

```python
out = df.copy()
out["設備中心化"] = out[context["y"]] - out.groupby(context["group"])[context["y"]].transform("mean")
wb.publish(out, "設備内の差を見る")
```

## `wb.select(ids, name="Python selection")`

Pythonで指定した行IDの集団を選択候補として出力します。画面のボタンを押すと探索画面で選択されます。データの削除や除外は行いません。

```python
mask = df[context["y"]].between(10.02, 10.05)
wb.select(df.loc[mask, "__row_id"].tolist(), "確認したい範囲")
```

## SDK

```python
from strata.sdk import Client
client = Client.from_env()
```

| メソッド | 動作 |
|---|---|
| `datasets()` | データ一覧を返す |
| `state(dataset_id)` | 保存された画面状態を返す |
| `frame(dataset_id, view=None, selected=False)` | 条件に一致する全件をpandasで取得 |
| `publish(frame, name, preserve_ids=True)` | DataFrameを新しいデータとして登録 |
| `run(dataset_id, code, view=None, context=None, wait=False, timeout=180)` | ワーカーへ分析を送る |
| `open_result(job_id, filename)` | `wb.publish` の出力を派生データとして登録 |
| `close()` | HTTP接続を閉じる |

`view=None` の場合は画面に最後に保存された状態を使います。再現性が必要な処理では、具体的なリビジョン・条件を固定して渡してください。

```python
view = {
    "revision": 1,
    "filters": [{"column": "設備", "op": "eq", "value": "MC-03"}],
    "selected_ids": [],
    "excluded_ids": [],
    "selection_only": False,
}
df = client.frame(dataset_id, view=view)
job = client.run(dataset_id, "wb.show(df.describe())", view=view, wait=True)
print(job["stdout"])
```

`wait=True` は完了状態を返します。Python内の例外はジョブの `status="failed"` と出力に記録され、HTTP通信エラーとは区別されます。確認せずに成功したものとして処理を進めないでください。

## ライブラリの追加

依存ライブラリは `pyproject.toml` に追加し、lockを更新してDockerイメージを再ビルドします。ワーカーはネットワークを持たないので、分析コードから実行時に `pip install` する運用にはしていません。

```bash
uv pip compile pyproject.toml -o requirements.lock
uv pip compile pyproject.toml --extra notebook -o requirements-notebook.lock
docker compose up --build -d
```

長い分析では `STRATA_PYTHON_TIMEOUT`（経過時間）を調整できます。CPU時間60秒の制限は `strata/runner.py` に定義しているので、必要に応じて両方を見直してください。大きな結果はメモリに加えて出力ファイルサイズの上限128MiBにも影響します。
