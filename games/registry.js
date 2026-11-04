// トップページに表示するゲームの一覧。新しいゲームを追加したらここにも登録する。
// id は games/<id>/ のディレクトリ名と一致させること。
export const games = [
  {
    id: 'fifteen',
    title: '15パズル',
    description: '数字のタイルをスライドさせて 1〜15 の順に並べる定番パズル。',
  },
  {
    id: 'twenty-forty-eight',
    title: '2048',
    description: 'タイルを上下左右に寄せて同じ数字を合体させ、2048 を目指すパズル。',
  },
  {
    id: 'falling-blocks',
    title: 'ブロック落とし',
    description: '落ちてくるブロックを回して並べ、横一列をそろえて消すアクションパズル。',
  },
  {
    id: 'model-viewer',
    title: '3Dビューア',
    description: '3D モデル（glb / gltf / obj / stl）を指で回して眺める。光や色も変えられる。',
  },
  {
    id: 'block-builder',
    title: '3D積み木',
    description: '箱や球を置いて、動かす・大きさを変える・回す・色を塗る。作品は .glb で書き出せる。',
  },
  {
    id: 'physics-blocks',
    title: '物理積み木',
    description: '重力のある世界で積み木を積んで、つかんで揺らして、接着でくっつける。硬さや重力も変えられる。',
  },
  {
    id: 'soft-blocks',
    title: 'やわらか積み木',
    description: '物理積み木の、パーツごとに柔らかさを決められる版。しなる板・ロープ・ゼリーも置ける。',
  },
  {
    id: 'model-blocks',
    title: '自分の3D積み木',
    description: 'やわらか積み木に、自分の 3D モデル（glb / obj / stl）を持ち込んで積み木として置ける。',
  },
  {
    id: 'dominoes',
    title: 'ドミノ倒し',
    description: '床を指でなぞってドミノを並べ、連鎖で全部倒す。うずまきやハートのお手本もある。',
  },
  {
    id: 'model-lite',
    title: '3Dモデル軽量化',
    description: '3D モデルのポリゴンを減らし、テクスチャを小さくして、軽い .glb に書き出す。',
  },
  {
    id: 'mecha-blaster',
    title: 'メカ・ブラスター',
    description: '自分の 3D モデル（なければ仮のロボ）を動かして、60 秒で箱の塔を撃って崩すアクション。',
  },
];
