# Google ドライブにキャラクターを保存する（保留中の計画）

キャラクター管理室（`games/character-room/`）のキャラクターを、自分の Google アカウントの
Google ドライブにも保存できるようにする計画。**OAuth クライアント ID がまだないので保留中。**
ID が用意できたら、この手順で進める。

## なぜ
キャラクターはブラウザの IndexedDB にしかないので、端末やブラウザをまたいで使えず、
サイトのデータを消すとなくなる（iPhone の Safari は、7 日ほど開かないと消すこともある）。
いまは `.mgchar` のバックアップファイル（「全部バックアップ」「バックアップから戻す」）で手動で守っている。

## しくみ（予定）
- サーバーは使わず、GitHub Pages の静的サイトのまま動かす。
- ログインは Google Identity Services のトークン方式（`google.accounts.oauth2.initTokenClient`）。
  アクセストークンは 1 時間ほどで切れるので、切れたらもう一度ログインしてもらう。
- スコープは `https://www.googleapis.com/auth/drive.appdata` だけ。ドライブの中の、
  このアプリ専用の隠しフォルダ（appDataFolder）にしか触れない。
- 保存するのは、バックアップと同じ `.mgchar` 1 ファイル（`packBackup` / `unpackBackup` を使い回す）。
  Drive API v3 の `files` を `spaces=appDataFolder` で一覧・作成・更新する。
- 画面：キャラクター管理室に「Google でログイン」「ドライブに保存」「ドライブから読み込む」を足す。
  読み込みは「バックアップから戻す」と同じ（同じ id は上書き、ないものは追加）。

## 決めること・ルールの変更
- Google のログイン用スクリプト（`https://accounts.google.com/gsi/client`）は同梱できないので、
  CLAUDE.md の「CDN を使わない」の例外として書き足す。読み込むのはキャラクター管理室だけにする。
- クライアント ID は公開してよい値なので、リポジトリに入れてよい。**クライアント シークレットは使わないし、入れない。**

## 用意してもらうもの（Google Cloud Console）
画面の名前は変わることがあるので、近いものを選ぶ。

1. https://console.cloud.google.com/ で新しいプロジェクトを作る（例: `mini-games`）。
2. 「API とサービス」→「ライブラリ」で **Google Drive API** を有効にする。
3. 「Google Auth Platform」（または「OAuth 同意画面」）を設定する。
   - アプリ名（例: `ミニゲーム集`）、サポートメール
   - 対象：**外部**、公開ステータス：**テスト**のまま
   - **テストユーザー**に自分の Gmail を追加する
   - データアクセス（スコープ）に `.../auth/drive.appdata` を追加する
4. 「クライアント」→「クライアントを作成」→ 種類は **ウェブアプリケーション**。
   - 承認済みの JavaScript 生成元：`https://tanakashigoto0122.github.io`
     （ローカルで試すなら `http://localhost:8000` も）
   - リダイレクト URI は空でよい
5. できた **クライアント ID**（`〜.apps.googleusercontent.com`）を渡す。
