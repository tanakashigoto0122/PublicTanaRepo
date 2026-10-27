# CLAUDE.md

Guidance for Claude Code and other AI assistants working in this repository.

## Project overview

ブラウザで遊べるミニゲーム集。静的サイトとして GitHub Pages で公開する。
ゲームは主に、定期実行される Claude Code セッションが `auto-dev` ラベル付きの
Issue を 1 件ずつ実装して増やしていく（[自動開発の手順](#自動開発の手順)）。

## Repository

| | |
|---|---|
| Remote | `https://github.com/tanakashigoto0122/PublicTanaRepo` |
| Visibility | Public |
| Base branch for PRs | `main` |

Because the repo is public, treat everything committed here as world-readable.
Never commit secrets, API keys, tokens, or personal data.

## Architecture

- **ビルド工程なし・外部依存なし。** 素の HTML / CSS / JavaScript（ES modules）だけで書く。
  npm パッケージ、CDN、フレームワークは使わない。テストも Node 標準の `node:test` のみ。
- **ロジックと描画を分ける。** 各ゲームの盤面・ルール・勝敗判定は DOM に触れない
  `logic.js` に純粋関数として書き、`main.js` は DOM の描画と入力処理だけを担う。
  `logic.js` は `tests/` から直接 import してテストする。
- **トップページは `games/registry.js` から一覧を生成する。** ゲームを追加したら必ず登録する。
  `tests/registry.test.js` が登録内容とディレクトリの対応を検証する。

## Directory layout

```
index.html              トップページ（ゲーム一覧）
assets/style.css        全ページ共通のスタイル。色は :root の CSS 変数（ダークモード対応）
games/registry.js       ゲーム一覧の登録先
games/<id>/index.html   各ゲームのページ（ページ固有のスタイルは <style> に書く）
games/<id>/logic.js     DOM に依存しないゲームロジック
games/<id>/main.js      描画と入力処理
tests/<id>.test.js      logic.js のテスト
.github/workflows/      ci.yml（テスト）、pages.yml（main へのマージで Pages にデプロイ）
```

`games/fifteen/`（15パズル）が見本の実装。新しいゲームはこの構成に合わせる。

## Common commands

```bash
npm test                          # 全テスト（node --test）
node --test tests/fifteen.test.js # 1 ファイルだけ
npm run serve                     # http://localhost:8000 で確認（python3 の http.server）
```

Node 20 以上が必要（CI は Node 22）。`npm install` は不要。

## Conventions

- 画面の文言は日本語。コードの識別子は英語、コメントは日本語で、必要な箇所だけ書く。
- ゲームの `id` は英小文字とハイフン（例: `minesweeper`, `lights-out`）。
- 各ゲームページの先頭に `<a href="../../">← ゲーム一覧</a>` を置く。
- スマホ幅（360px 程度）でも横スクロールせずに遊べるようにする。マウスとタッチの両方で操作できること。
- 色は `assets/style.css` の CSS 変数を使い、直接色コードを書かない。
- 乱数を使う関数は `random = Math.random` のように引数で差し替えられるようにし、テストを安定させる。

## Testing

- `logic.js` の公開関数はすべてテストする。初期状態、正しい手・不正な手、勝敗判定、境界（盤面の端など）を最低限カバーする。
- `npm test` が通らない変更はコミットしない。
- DOM 側の変更は、可能ならヘッドレスブラウザ（Playwright の Chromium がクラウド環境に入っている）で
  ページを開き、コンソールエラーがないことと基本操作ができることを確認する。

## CI

- `ci.yml`: PR と `main` への push で `npm test` を実行。
- `pages.yml`: `main` への push で `index.html`、`assets/`、`games/` を GitHub Pages にデプロイ。

## 自動開発の手順

定期実行のセッションは次の手順で動く。**1 回の実行で扱う Issue は 1 件だけ。**

1. `main` の最新を取得する。
2. `auto-dev` ラベルが付いた open な Issue のうち、番号が最も小さく、まだ対応する open な PR がないものを 1 件選ぶ。
   `blocked` ラベル付きは飛ばす。該当がなければ何もせず終了する。
3. `main` から `claude/issue-<番号>-<短い説明>` ブランチを作る。
4. Issue の内容を実装する。上の Architecture と Conventions に従い、テストを書き、`games/registry.js` に登録する。
5. `npm test` を通し、可能ならブラウザで動作確認する。
6. push して `main` 向けの PR を作る。本文には `Closes #<番号>`、遊び方、確認した内容を書く。
7. 仕様が曖昧で決めきれない点は、もっとも素直な解釈で実装し、PR 本文に「判断したこと」として書く。
   実装できない理由があれば、PR は作らずに Issue にコメントして `blocked` ラベルを付ける。

既存のゲームやトップページの変更は、その Issue に必要な範囲に留める。

## Working guidelines

- **Verify, don't assume.** Read the code and run the commands before
  documenting or describing behavior. Report results faithfully — if tests
  fail or a step was skipped, say so plainly.
- **Match surrounding style.** New code should read like the code already
  around it: same naming, same idioms, same comment density.
- **Keep scope tight.** Do what was asked; flag adjacent problems you notice
  instead of silently expanding the change.

Write commit messages in the imperative mood with a short subject line, and a
body explaining *why* when the reason is not obvious from the diff.

## Maintaining this file

Update this file when the commands, directory layout, conventions, or the
自動開発の手順 change, in the same commit as the change itself. Keep it
accurate over comprehensive: a stale instruction is worse than a missing one.
