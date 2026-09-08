# Strata Workbench

**表・グラフ・Pythonで同じ行を追いかける、個人用の探索的データ分析環境です。**

JMPの「グラフの気になる点から元の測定行へ戻り、別の切り口で確かめる」操作を中心に作っています。JMPとのファイル互換や全機能の再現ではなく、探索とPython分析の往復に焦点を当てた初版です。

React / TypeScript / Glide Data Grid / Plotly.js + FastAPI / Polars。全てOSSで構成し、本プロジェクトはMITライセンスです。外部AIサービスや有料サービスの契約は必要ありません。

## 起動

Docker Engine または Docker Desktop と Compose v2、初期設定用のPython 3が必要です。Linux、macOS、WindowsのDocker環境を想定しています。ソースを展開したディレクトリで実行します。

```bash
python3 scripts/setup.py
docker compose up --build -d
```

Windowsで `python3` がない場合は `python scripts/setup.py` を使ってください。

1. [http://localhost:8080](http://localhost:8080) を開く。
2. ローカルの `secrets/app_token.txt` を開き、その内容をログイン欄に入力する。
3. 「サンプルで試す」、または「データを読み込む」を選ぶ。

セットアップは再実行しても既存のトークン・接続設定を上書きしません。初回ビルドにはインターネット接続が必要です。通常のファイル分析は起動後ローカルで完結します。

```bash
docker compose ps
docker compose logs --tail=50 app worker
docker compose stop
docker compose start
```

標準ではホストの `127.0.0.1` にだけ公開します。ポート番号など秘密でない設定は `.env` で変更します。常用時の目安としてDockerへ8GB程度のメモリを割り当て、実データの幅・行数に応じて調整してください。これは性能保証値ではありません。

## 最初に試す一周

付属サンプルは **2,400行の合成データ** です。設備差、温度との関係、一部期間の変動、欠損を含みます。実在の工場のデータではありません。

1. 「散布図」で Y=`径_mm`、X=`温度_C`、層別=`設備` を選ぶ。
2. グラフの投げ縄で気になる点を囲む。表の該当行が色付きになり、右側で「対象」と「選択」の要約値を比べられる。
3. 「選択行のみ」を押すと、その集団を表で確認できる。押すまでは、選択によって母集団は変わらない。
4. 「箱ひげ図」に切り替え、「比較に固定」。層別を `勤務帯` に変え、もう一度固定する。
5. 「比較」で並べる。同じ測定列ならY軸の範囲を共通化できる。固定時のフィルタとリビジョンを保持する。
6. 「Python」で「集計と行へのリンク」を実行。出力した集約表の「選択」を押すと、元の測定群へ戻る。
7. 「派生列を表に戻す」を実行し「表に戻す」を押す。平均との差を加えたデータが新しい枝として開く。

## 実装した操作

| 領域 | 内容 |
|---|---|
| 読み込み | CSV / TSV / Parquet / XLSX、UTF-8 / CP932 / Shift JIS、Excelシート指定 |
| 表 | 仮想化描画、行・セル範囲選択、列幅変更、列移動、ヘッダでソート、コピー、500行単位のページ移動 |
| 列 | 型・欠損・ユニーク数の把握、厳密な型変換、数値・カテゴリ・日時によるフィルタ |
| 可視化 | 散布図、時系列、ヒストグラム、箱ひげ図、Pearson相関行列 |
| 相互選択 | 表↔点、ヒストグラムのビン→全該当行、箱→群、箱の外側の点→元の行、相関セル→散布図 |
| 集団の管理 | 選択の置換・追加・解除、名前付き選択、選択行のみ表示、分析対象からの除外と復元 |
| 比較 | 最大8個の条件を固定、同じリビジョンの選択連動、軸範囲の共通化、比較ごとのメモ |
| Python | エディタ、実行・中止・履歴、標準出力、表・Plotly図・Matplotlib図、行へのリンク、派生データ |
| 再現 | 不変のParquetリビジョン、セル編集履歴、元データと派生データの関係、フィルタとコードの保存 |
| 引き継ぎ | データ書き出し、状態を固定したNotebook出力、Python SDK、任意のJupyterLab起動 |
| DB | サーバー側に登録したPostgreSQLへの読み取り専用SQL取込 |

グラフとセル範囲の選択は上部の「置換／追加／解除」に従います。行のチェックはその行だけを追加・解除し、別ページやフィルタで見えない行の選択も保持します。左上のチェックは表示中のページに適用します。行の選択、表示の絞り込み、分析対象からの除外、データの編集は別の操作です。

セル編集は明示的にONにします。数値・文字列に対応し、日時はPythonまたは列型変換を使います。変更は新しいリビジョンに保存し、古いリビジョンへの書き込みは拒否します。整数列へ小数を入れる場合は、先に型を「数値（Float64）」へ変更してください。

## Pythonをどこに書くか

### 画面内のエディタ

毎回、新しいプロセスに以下を渡します。変数が前回の実行から残らないので、入力とコードの対応が明確になります。

| 名前 | 内容 |
|---|---|
| `df` | 表示条件に一致する **全行** のpandas DataFrame。グラフの描画サンプルではない |
| `selected` | `df` のうち選択した行。未選択なら空のDataFrame |
| `selection_mask` | `df` と同じインデックスのBoolean Series |
| `pd`, `pl`, `np` | pandas、Polars、NumPy |
| `context` | 選択したX/Y列、層別列、図の種類、データ名 |
| `wb` | 出力を画面に返すオブジェクト |

```python
value = context["y"]
out = df.copy()
out["平均との差"] = out[value] - out[value].mean()
wb.publish(out, name="平均との差を追加")
```

`wb.publish()` の出力は、画面の「表に戻す」を押したときに派生データとして登録します。元データは保持されます。元の観測との対応を維持したい場合は、予約列 `__row_id` をそのまま残してください。集計などで一行の意味を変えた結果には、その列を付けず新しい行IDを割り当てます。

```python
# 「抽象→具体」の往復：集約表の各行に元の測定行を紐付ける
group, value = context["group"], context["y"]
groups = list(df.groupby(group, dropna=False))
summary = pd.DataFrame([
    {group: key, "平均": part[value].mean(), "件数": len(part)}
    for key, part in groups
])
wb.show(summary, name="設備別の傾向",
        row_ids=[part["__row_id"].tolist() for _, part in groups])

# 条件をPythonで記述し、候補の行を画面で確認
wb.select(df.loc[df[value] > df[value].quantile(.99), "__row_id"].tolist(),
          name="上位1%の候補")
```

詳細は [Python連携](docs/PYTHON.md) に記載しています。

### 手元のNotebookやPythonスクリプト

プロジェクトルートでインストールします。

```bash
python3 -m venv .venv
# Linux / macOS
source .venv/bin/activate
python -m pip install -r requirements.lock
python -m pip install --no-deps -e .
```

Windowsでは `.venv\Scripts\Activate.ps1` で有効化します。`STRATA_TOKEN_FILE` は秘密ファイルのパス、`STRATA_URL` はAPIのURLです。既定値はプロジェクトルートの `secrets/app_token.txt` と `http://localhost:8080` です。コードやNotebookにトークンを直接書く必要はありません。

```python
from strata.sdk import Client

client = Client.from_env()
datasets = client.datasets()
dataset_id = datasets[0]["id"]

# 画面で保存された現在のリビジョン・条件を使う
df = client.frame(dataset_id)
selected = client.frame(dataset_id, selected=True)

df["new_value"] = df.select_dtypes("number").drop(columns="__row_id").mean(axis=1)
new_dataset = client.publish(df, name="Pythonで追加したデータ")
client.close()
```

外部のPythonから作ったデータは、画面右上の更新ボタンでデータ一覧に反映されます。SDKはローカル接続を意図し、環境のHTTPプロキシを既定で継承しません。必要な場合だけ `Client(..., trust_env=True)` を指定できます。

### Docker内のJupyterLab（任意）

```bash
docker compose --profile notebook up --build -d
```

[http://localhost:8888](http://localhost:8888) を開き、`secrets/notebook_token.txt` でログインします。API用とは別のトークンです。画面から書き出したNotebookをアップロードして使えます。APIとの接続は既に設定されています。

通常のPythonを書くセルでは、コード内の変数やライブラリを自分で管理できます。画面と同じ `wb.show` / `wb.publish` を使うコードは `client.run()` でワーカーへ送ります。

## クレデンシャルと実行環境の分離

| プロセス | 読める秘密 | データ | ネットワーク |
|---|---|---|---|
| API | アプリ認証トークン・登録DB接続 | データ保存領域・ジョブ領域 | DB接続を許可 |
| Pythonワーカー | **秘密ファイルをマウントしない** | 実行用スナップショット・出力領域 | **`network_mode: none`** |
| 任意のNotebook | アプリAPIトークン・Notebookトークン | Notebook保存領域。API経由でデータ取得 | APIへの接続を許可 |
| ブラウザ | 入力したログイントークンから発行するセッションCookie | 表示データ | 同一オリジンのAPI |

`secrets/` はGitとDockerビルドコンテキストから除外します。ホストではディレクトリを0700にし、Compose経由で非rootコンテナから読み込めるよう秘密ファイルのモードを設定します。Windowsでのアクセス権はローカルのACLにも依存します。Composeのfile secretsはローカル平文ファイルの読み取り専用マウントであり、暗号化保管サービスではありません。

ワーカーは非root、ルートファイルシステム読み取り専用、Dockerソケット無し、CPU・メモリ・プロセス数制限付きです。コード実行の制限は既定90秒の経過時間と60秒のCPU時間です。独立した実行プロセスを中止でき、前回の変数状態は継承しません。

**自分が信頼するコードを動かす個人用環境です。** 同じワーカーのジョブ領域は共有されるため、任意の悪意あるコードを他人から受け取るための強いジョブ間サンドボックスにはしていません。NotebookはAPI操作の権限を持ちます。公開マルチユーザーサービスとして使う場合は、ユーザー単位の分離と実行基盤を別途設計してください。

## PostgreSQL接続（任意）

`secrets/connections.json` に接続名とDSNを登録します。最初は `{}` なので、ファイル分析だけなら設定不要です。

```json
{
  "manufacturing_readonly": {
    "dsn": "postgresql://READONLY_USER:REPLACE_LOCALLY@DB_HOST:5432/DB_NAME"
  }
}
```

本物の値はこの秘密ファイルにだけ記載してください。DBユーザー自体も対象テーブルのSELECT権限のみにすることを推奨します。画面には接続名だけを返し、DSNやドライバの内部エラーは返しません。取込はread-onlyトランザクション、タイムアウト30秒、最大20万行です。取込後の分析ではDBへ都度問い合わせません。

Docker内からホスト側DBに接続する場合、`localhost` はコンテナ自身です。Docker Desktopでは `host.docker.internal`、LinuxではDockerネットワーク内のホストアドレスなど、自分の環境で到達できる名前を設定してください。

## データ量と表示の意味

- データ取込は128MiB / 200万行 / 1500列まで。行数上限は `.env` で調整できますが、メモリ限界は列幅や同時操作にも依存します。
- 表は **500行ずつ取得** し、そのページを仮想化描画します。検索・ソート・集計・Python入力はそのページだけに限定されません。
- 散布図と時系列は有効な行から最大5,000点を固定seedで抽出します。抽出時は画面に明示します。点の選択は描画した行に対して行います。時系列を細かく調べる場合は期間を絞ってください。
- ヒストグラム・箱ひげ図・列の要約は対象の全行で計算します。ヒストグラムのビン選択は全該当行を選びます。
- 箱ひげ図は線形補間による四分位点、1.5 IQR以内の実測値のひげです。外側の点は最大5,000点表示し、統計量は全件から計算します。IQR外側を自動的に異常とは判定しません。
- 相関はペアごとの欠損を除外したPearson相関で、ホバーで有効ペア数を確認できます。数値列の先頭20列を表示します。
- 一度の選択・除外は20万行まで。Pythonの集約表からのリンクは先頭100行・合計20万IDまでです。
- 数値のNaN/±Infは取込時に欠損へ正規化します。配列・構造体列はPythonで平坦化してから読み込んでください。
- Decimal列の元の値はParquetに保持し、ブラウザ描画・ヒストグラム・相関などはFloat64で扱います。厳密な桁の計算は元データをPythonへ取り出して行えます。
- `__row_id` は内部用の予約列名です。GUIからの通常取込でこの列がある場合はエラーにします。SDKによる再登録では明示的に維持できます。
- CSV出力はデータを変更せず出力します。型と値を保った再分析にはParquetを推奨します。

## 保存と再現

Composeのnamed volumeにデータを保存します。

| ボリューム | 内容 |
|---|---|
| `strata_workspace` | 元データ、変更ごとのParquet、データ一覧、画面状態、比較・メモ |
| `strata_jobs` | Pythonの入力スナップショット、コード、条件、出力、実行履歴 |
| `strata_notebooks` | 任意で起動するJupyterLabのNotebook |

`docker compose down` ではボリュームは残ります。**`docker compose down -v` はデータを削除するので、通常の停止には使わないでください。** ジョブ入力も再現のために保存するので、繰り返し実行するとディスク使用量が増えます。バックアップや保存期間は運用に合わせて管理してください。

APIはマニフェストの更新整合性を守るため **1プロセス** で起動します。`--workers` を増やす場合はストレージのロック設計も変更が必要です。

## 開発と検証

```bash
python -m pip install -r requirements-notebook.lock
python -m pip install -e '.[dev]'
cd frontend
npm ci
npm test
npm run build
cd ..
python -m pytest -q
```

開発時は `python scripts/dev.py` でAPIとワーカーを起動できます。別ターミナルで `cd frontend && npm run dev`。このモードは同じOSユーザーで実行し、Dockerの秘密情報分離は提供しません。

実施済みの検証と残る確認事項は [検証記録](docs/VALIDATION.md) を参照してください。

## 主な構成

- `frontend/src/` — 表、グラフ、比較、Python、選択状態のReact UI
- `strata/api.py` — 認証、取込、データ操作、実行キューAPI
- `strata/analysis.py` — 型付きフィルタ、全件集計、図のデータ作成
- `strata/storage.py` — Parquetリビジョンとatomic JSONマニフェスト
- `strata/worker.py` / `strata/runner.py` — 別コンテナ・別プロセスでのPython実行
- `strata/sdk.py` — Notebook・通常Pythonからの橋渡し
- `compose.yaml` / `Dockerfile` — ローカル起動・秘密情報と実行環境の分離
- `tests/` — データ整合性、実行の往復、認証、永続化、配備設定のテスト

依存パッケージは `requirements.lock`、`requirements-notebook.lock`、`frontend/package-lock.json` に固定しています。
