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
];
