# meshoptimizer（同梱）

- バージョン: 1.3.0（npm の `meshoptimizer` パッケージ）
- ライセンス: MIT（[LICENSE.md](LICENSE.md)）
- 3Dモデル軽量化で、ポリゴンを減らすのに使う。`meshopt_simplifier.js` だけをパッケージ内と同じ名前で置いている
  （WebAssembly を中に含む 1 ファイル完結の ES module で、ほかのファイルを読み込まない）

ファイルは手で編集しない。更新するときは `https://registry.npmjs.org/meshoptimizer/-/meshoptimizer-<version>.tgz` を
取得して同じファイルを差し替え、このファイルのバージョンを書き換える。
