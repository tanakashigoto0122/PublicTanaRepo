# tripo-export

Tripo AI の **API** で生成した3Dモデルを一括ダウンロードし、新しいモデルの生成もできるコマンドラインツールです。
公式 Python SDK [`tripo3d`](https://github.com/VAST-AI-Research/tripo-python-sdk)（Tripo API v3）を使っています。

## できること

| コマンド | 内容 |
|---|---|
| `tripo-export export` | アカウントの生成履歴にあるモデルを**全部**ダウンロード |
| `tripo-export create text "..."` | テキストからモデルを生成してダウンロード |
| `tripo-export create image cat.png` | 画像からモデルを生成してダウンロード |
| `tripo-export history` | 生成履歴の一覧 |
| `tripo-export balance` | APIクレジット残高 |

## 注意（最初に読んでください）

- **API と Tripo Studio（Webサイト）は別物です。** このツールで取得できるのは API で生成したモデルだけです。
  Studio で作ったモデルは API からは見えません。Studio のモデルは、Pro / Max プランの Studio 側の一括エクスポート機能を使ってください。
- **APIクレジットは Studio のクレジットとは別です。** Studio の有料プランでも、Studio のクレジットで API は使えません。
  Pro / Max 会員は 1,000 APIクレジットを一度だけ受け取れます（API アカウントのメールアドレスを Studio と同じにする必要あり）。
- **GLB以外の形式（FBX / OBJ など）は、モデルごとに API で変換するのでクレジットを消費します。** GLB はそのままダウンロードするだけなので無料です。
- ダウンロードURLは約5分で期限切れになりますが、ツール側で少しずつ取得してすぐ保存するので気にしなくて大丈夫です。

## セットアップ

Python 3.9 以上が必要です。

```bash
git clone https://github.com/tanakashigoto0122/PublicTanaRepo.git
cd PublicTanaRepo
python3 -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -e .
```

[Tripo API プラットフォーム](https://platform.tripo3d.ai/) で API キー（`tsk_` で始まる文字列）を作成し、環境変数に入れます。

```bash
export TRIPO_API_KEY=tsk_xxxxxxxx     # Windows (PowerShell): $env:TRIPO_API_KEY="tsk_xxxxxxxx"
```

API キーは他人に見せたり、Git にコミットしたりしないでください。

## 使い方

### 全モデルを一括エクスポート

```bash
tripo-export export                       # ./tripo_models に GLB で保存
tripo-export export -o ~/Desktop/models   # 保存先を指定
tripo-export export --preview             # プレビュー画像も保存
tripo-export export -f FBX                # FBX に変換して保存（クレジット消費、確認あり）
```

- 途中で止まっても、**同じコマンドをもう一度実行すれば続きから**再開します（保存済みのものはスキップ）。
- 保存した内容は保存先の `manifest.json` に記録されます。
- ファイル名は `生成日時_タスクID.glb` です。

特定のタスクだけエクスポートしたいとき：

```bash
tripo-export export 6ffdb041-55c6-... 1a2b3c4d-...
tripo-export export --ids-file ids.txt    # 1行に1つのタスクID（CSVなら1列目）
```

### モデルを生成

```bash
tripo-export create text "a cute red panda"
tripo-export create image ./cat.png -f FBX --preview
tripo-export create text "wooden chair" --detailed --face-limit 20000
```

生成したモデルは `manifest.json` に記録されるので、あとで `export` を実行しても二重にダウンロードされません。

主なオプション：

| オプション | 内容 |
|---|---|
| `-o DIR` | 保存先（既定: `tripo_models`） |
| `-f FORMAT` | `GLB`（既定）, `GLTF`, `USDZ`, `FBX`, `OBJ`, `STL`, `3MF` |
| `--preview` | プレビュー画像も保存 |
| `-y` | クレジット消費の確認を省略 |
| `--model-version` | 生成モデルのバージョン（既定: `v3.1-20260211`） |
| `--china` | 中国リージョンのエンドポイントを使用 |

## 開発

```bash
PYTHONPATH=src python3 -m unittest discover -s tests -v
```

テストは偽のクライアントで動くので、APIキーもネットワークも不要です。
