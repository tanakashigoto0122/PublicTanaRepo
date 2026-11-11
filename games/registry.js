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
  {
    id: 'launch-distance',
    title: 'ぶっ飛ばしチャレンジ',
    description: '自分の 3D モデルをパチンコのように飛ばして、どこまで行けるかを競う。トランポリンや加速パッドもある。',
  },
  {
    id: 'model-sculpt',
    title: 'ぐにゃぐにゃ工房',
    description: '3D モデルを指で引っぱって伸ばしたり、ふくらませたり、ならしたりして改造する。改造した形はキャラクターにできる。',
  },
  {
    id: 'hand-clay',
    title: 'てのひら粘土',
    description: 'カメラに映した自分の手で、3D モデルをつまんで引っぱったり、手を押し付けて手の形にへこませたりする。',
  },
  {
    id: 'jelly-lab',
    title: 'ぷるぷるラボ',
    description: '3D モデルがゼリーのような柔らかい体になる。つかんで振り回したり、投げたり、落としたりして遊ぶ。',
  },
  {
    id: 'jelly-catch',
    title: 'ぷるぷるキャッチ',
    description: 'ぷるぷるのキャラクターを指かカメラの手でつかんで投げ、床の的に乗せる。60 秒で何回乗せられるか。',
  },
  {
    id: 'character-room',
    title: 'キャラクター管理室',
    description: '3D モデルのキャラクターを何体も保存しておき、ゲームで使うものを切り替える。名前や正面の向きも直せる。',
  },
  {
    id: 'jelly-sumo',
    title: 'ぷるぷる相撲',
    description: 'ぷるぷるになったキャラクターどうしで押し合い、土俵の外へ出したら勝ち。CPU とも 2 人でも遊べる。',
  },
  {
    id: 'stair-tumble',
    title: 'ラグドール階段落ち',
    description: 'キャラクターを手足がぐにゃっと動く人形にして、階段から突き落とす。ぶつかった強さが点数になる。',
  },
  {
    id: 'giant-rampage',
    title: '巨大化パニック',
    description: '巨大なキャラクターになって、60 秒で箱のビル街をなぎ倒す。壊すほど大きくなる。',
  },
  {
    id: 'contraption',
    title: 'からくり装置',
    description: '板やドミノ、バネを置いて、玉がかごに入る仕掛けを作る物理パズル。5 面と、自由に作るモードがある。',
  },
  {
    id: 'photo-studio',
    title: 'キャラ写真スタジオ',
    description: 'キャラクターを並べて、背景・光・スタンプ・文字を付けて記念撮影。写真は画像で保存できる。',
  },
  {
    id: 'air-drum',
    title: 'エアドラム',
    description: 'カメラの前で人差し指を振り下ろすと太鼓やシンバルが鳴る。タップでも叩ける。録音してくり返し重ねられる。',
  },
  {
    id: 'model-stage',
    title: '3D展示ステージ',
    description: '作ったキャラクターや積み木作品を回転台に飾って、好きな角度で写真を撮る。',
  },
];
