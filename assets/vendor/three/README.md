# Three.js（同梱）

- バージョン: 0.186.1（npm の `three` パッケージ）
- ライセンス: MIT（[LICENSE](LICENSE)）
- 3D ビューアなどで使う分だけを、パッケージ内と同じパスで置いている

```
build/three.module.js, build/three.core.js
examples/jsm/controls/OrbitControls.js
examples/jsm/loaders/GLTFLoader.js, OBJLoader.js, STLLoader.js
examples/jsm/utils/BufferGeometryUtils.js, SkeletonUtils.js   (GLTFLoader が使う)
```

ファイルは手で編集しない。更新するときは `https://registry.npmjs.org/three/-/three-<version>.tgz` を
取得して同じパスのファイルを差し替え、このファイルのバージョンを書き換える。
