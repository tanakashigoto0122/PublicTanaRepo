# ミニゲーム集

ブラウザで遊べる小さなゲームを集めたサイトです。
新しいゲームは主に Claude Code が GitHub の Issue をもとに少しずつ実装していきます。

## 遊ぶ

GitHub Pages で公開しています（`main` へのマージで自動デプロイ）。

ローカルで遊ぶ場合:

```bash
npm run serve   # http://localhost:8000 を開く
```

## ゲームを追加してほしいとき

`auto-dev` ラベルを付けた Issue を作ると、定期実行される Claude Code が 1 件ずつ実装して PR を出します。
遊び方やルールを具体的に書くほど、イメージ通りに仕上がります。

## 開発

```bash
npm test        # ゲームロジックのテスト（依存パッケージ不要）
```

開発ルールは [CLAUDE.md](CLAUDE.md) を参照してください。
