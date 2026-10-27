# tripo-export

Tripo AI の **API** で生成した3Dモデルを一括ダウンロードし、新しいモデルの生成もできるツールです。
**Windows アプリ**（ダブルクリックで起動）と、コマンドラインツールの両方で使えます。
公式 Python SDK [`tripo3d`](https://github.com/VAST-AI-Research/tripo-python-sdk)（Tripo API v3）を使っています。

## できること

| コマンド | 内容 |
|---|---|
| `tripo-export export` | アカウントの生成履歴にあるモデルを**全部**ダウンロード |
| `tripo-export create text "..."` | テキストからモデルを生成してダウンロード |
| `tripo-export create image cat.png` | 画像からモデルを生成してダウンロード |
| `tripo-export view` | 保存したモデルをブラウザで一覧表示（3Dでぐるぐる回して見られる） |
| `tripo-export history` | 生成履歴の一覧 |
| `tripo-export balance` | APIクレジット残高 |

## Windows アプリ（Tripo Model Manager）

一覧ビューワー・一括エクスポート・モデル生成をまとめた Windows アプリです。Python のインストールは不要です。

### 入手方法

1. GitHub のこのリポジトリの **Actions** タブ →「Windows app」→ 一番上（最新）の成功した実行を開く
2. 下の **Artifacts** にある `TripoModelManager-windows` をダウンロード（GitHub へのログインが必要）
3. zip を展開して `TripoModelManager.exe` をダブルクリック

電子署名のないアプリなので、初回は「Windows によって PC が保護されました」と出ます。「詳細情報」→「実行」で起動できます。
自分のPCでビルドする場合は `packaging\windows\build.ps1` を実行してください（Python 3.9 以上が必要）。

### 使い方

- 初回起動時に設定画面が開くので、Tripo API キー（`tsk_...`）を入力します。キーは Windows の資格情報マネージャーに保存されます
- **フォルダを変更…**：一覧に表示するフォルダ（既定: `ドキュメント\TripoModels`）。エクスポートと生成の保存先も同じフォルダです
- **API から一括エクスポート**：API で作ったモデルを全部このフォルダにダウンロード。進み具合は画面下に表示されます
- **モデルを生成**：テキストか画像から生成して、このフォルダに保存
- **設定**：API キー、中国リージョン、クレジット残高の確認
- モデルをクリックすると3D表示。ファイルは「エクスプローラーで表示」から開けます
- 閲覧はネットなしでも動きます（エクスポートと生成は Tripo API を使うのでネット接続が必要）

設定は `%APPDATA%\TripoModelManager` に保存されます。

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
- 形式変換（FBX などへの変換）のタスクは履歴に出ても対象外です。同じモデルを二重に保存したり、変換し直してクレジットを使ったりしません。
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

### 一覧ビューワーで見る

```bash
tripo-export view                    # ./tripo_models を一覧表示（ブラウザが自動で開く）
tripo-export view ~/Desktop/models   # 別のフォルダを表示
```

- サムネイル一覧から、クリックで3D表示（ドラッグで回転、ホイールで拡大、← → で前後のモデル）
- プロンプト・ファイル名・タスクIDで検索、日付・名前・サイズで並べ替え
- `--preview` で保存したプレビュー画像がないモデルは、初回にブラウザがサムネイルを自動で作って記憶します
- Studio から手作業で落とした GLB も、同じフォルダ（サブフォルダ可）に入れれば一緒に表示されます
- 表示できるのは GLB / glTF です。FBX・OBJ などは同じカードからダウンロードだけできます
- GLB などのファイルを一覧にドラッグ＆ドロップすると、フォルダに追加されます（同じ名前があるときは上書きせず「名前 (2)」にします）
- 3D表示の画面で、名前の変更と削除ができます。削除したファイルはごみ箱（Windows 以外ではフォルダ内の `.trash`）に移ります
- 背景（標準・白・グレー・黒・グリーン、または好きな画像・HDR）、ライト、明るさ、光の向き、ツヤ（ザラザラ〜ツルツル）、金属感を切り替えられます。ツヤと金属感を両方左いっぱいにすると、完全なツヤ消しになります。表示だけの調整でファイルは変わりません。設定は次回も残り、「戻す」で最初に戻ります
- 背景の画像は「画像を選ぶ…」で選ぶと、フォルダ内の `.backgrounds` に保存され、その画像の光でモデルが照らされます
- 「寸法線」にチェックすると、幅・高さ・奥行の線と長さをモデルに重ねて表示します
- 「STL に変換」「OBJ に変換」で、クレジットを使わずに PC 上で変換できます。STL は 3D プリント向け（mm 単位・Z が上・床に接地）、OBJ は MTL とベースカラーのテクスチャ付きで新しいフォルダに書き出します（Draco などで圧縮された GLB は変換できません）
- 「一周動画を保存」で、モデルが 8 秒で一周する動画（WebM）を `screenshots` に保存します
- 「この角度をサムネイルに」で、今の表示をそのモデルの一覧用画像として保存できます
- モデルの大きさ（幅・高さ・奥行）を表示します。アニメーション付きのモデル（リグ付きなど）は再生・一時停止・切り替えができます
- エクスプローラーなどでフォルダにファイルを足したり消したりすると、数秒で一覧に反映されます
- ★お気に入りとメモを付けられます。お気に入りだけの表示に絞り込め、メモは検索の対象になります（フォルダ内の `.tripo-viewer.json` に保存されるので、フォルダごと別の PC に移しても残ります）
- サブフォルダがあるときは、フォルダで絞り込めます
- タグ（「キャラ」「ゲーム用」など複数可）を付けて、タグで絞り込めます。選択モードでまとめて付けることもできます
- 「重複チェック」で、中身がまったく同じモデルファイルを探せます。2 個目以降をまとめて選んで削除できます
- 3D表示の画面の「テクスチャ」欄で、モデルに入っている画像（ベースカラー・法線など）を用途・解像度つきで確認し、`textures/` に書き出せます
- ポリゴン数（三角形・頂点）、メッシュ・マテリアル・テクスチャの数、リグとアニメーションの有無を表示します
- 「画像として保存」で、今の表示を PNG としてフォルダ内の `screenshots` に保存できます
- 「選択」ボタン（または Ctrl+クリック）で複数のモデルを選び、まとめてお気に入り・フォルダへ移動・削除できます。2 個選ぶと「並べて比較」で、同じ角度で見比べられます
- zip ファイルも追加・取り込みできます。中身はフォルダに展開されるので、FBX や OBJ のテクスチャもそのまま入ります
- アプリでは、ダウンロードフォルダにまだ取り込んでいないモデルがあると「ダウンロードから取り込む」ボタンに件数が出ます
- アプリでは「ダウンロードから取り込む…」で、Studio などからダウンロードフォルダに保存したモデルを選んでコピー（または移動）できます
- サーバーは自分のPC（127.0.0.1）でだけ動くので、モデルが外に送られることはありません。表示用のライブラリ（Google の model-viewer）も同梱しているので、ネットなしでも見られます
- 終了は Ctrl+C

主なオプション（`export` / `create`）：

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

Windows アプリを Python から直接起動する場合：

```bash
pip install -e ".[app]"
tripo-model-manager
```
