# MediaPipe Tasks Vision（同梱）

- バージョン: 1.1.1（npm の `@mediapipe/tasks-vision` パッケージ）
- ライセンス: Apache-2.0（[LICENSE](LICENSE)）。手の検出モデルも同じく Apache-2.0
- てのひら粘土で、カメラに映った手の関節を見つけるのに使う。カメラの映像はブラウザの中だけで処理する

```
vision_bundle.mjs                 パッケージの vision_bundle.mjs（ほかのファイルを import しない ES module）
wasm/vision_wasm_internal.js      パッケージの wasm/ にある SIMD 版の本体
wasm/vision_wasm_internal.wasm
models/hand_landmarker.task       https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task
```

SIMD に対応していない古いブラウザ向けの `vision_wasm_nosimd_internal.*`（約 13 MB）は、リポジトリを重くしないため入れていない。
そのブラウザでは手の検出が始まらず、てのひら粘土は指で操作するモードになる。

ファイルは手で編集しない。更新するときは `https://registry.npmjs.org/@mediapipe/tasks-vision/-/tasks-vision-<version>.tgz` と
モデルを取得して同じパスのファイルを差し替え、このファイルのバージョンを書き換える。
