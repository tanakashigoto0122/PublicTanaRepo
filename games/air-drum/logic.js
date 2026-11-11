// エアドラムの計算部分。DOM・Web Audio・MediaPipe に依存しないので node:test から直接テストできる。
// 位置は画面の幅・高さに対する割合（0〜1）。左右は鏡に映したとき（自分から見た向き）で持つ。

export { INDEX_TIP, LANDMARK_COUNT } from '../hand-clay/logic.js';

// 太鼓の並び。r は画面の短い辺に対する半径の割合
export const PADS = [
  { id: 'crash', label: 'シンバル', x: 0.16, y: 0.3, r: 0.15, color: '--piece-o' },
  { id: 'hihat', label: 'ハイハット', x: 0.12, y: 0.66, r: 0.13, color: '--piece-s' },
  { id: 'snare', label: 'スネア', x: 0.36, y: 0.74, r: 0.15, color: '--piece-j' },
  { id: 'tom', label: 'タム', x: 0.5, y: 0.42, r: 0.12, color: '--piece-t' },
  { id: 'floor', label: 'フロアタム', x: 0.64, y: 0.74, r: 0.15, color: '--piece-i' },
  { id: 'ride', label: 'ライド', x: 0.84, y: 0.3, r: 0.15, color: '--piece-l' },
  { id: 'kick', label: 'バスドラ', x: 0.86, y: 0.7, r: 0.13, color: '--piece-z' },
];

// 点 [x, y] がどの太鼓の上か。重なっていれば真ん中に近いほう。なければ null。
// aspect は画面の幅 / 高さ（半径は短い辺に対する割合なので、縦横で距離の重みを変える）
export function padAt([x, y], aspect, pads = PADS) {
  let best = null;
  let bestDistance = Infinity;
  const shortSide = Math.min(aspect, 1);
  for (const pad of pads) {
    const dx = (x - pad.x) * aspect;
    const dy = y - pad.y;
    const distance = Math.hypot(dx, dy) / shortSide;
    if (distance <= pad.r && distance < bestDistance) {
      best = pad;
      bestDistance = distance;
    }
  }
  return best;
}

// 指先が太鼓をたたいたか。下向きに速く動いて太鼓の上に入ったときに 1 回だけ鳴らし、
// 指を上げる（上向きに動く）か太鼓から出るまでは次を鳴らさない。
// state は { y, time, armed, pad }。speed は 1 秒に画面の高さの何倍動いたか
export const STRIKE_SPEED = 1.2;
export const REARM_SPEED = 0.3;

export function updateStrike(state, { y, time, pad }) {
  if (!state) return { state: { y, time, armed: true, pad: pad?.id ?? null }, hit: null };
  const dt = Math.max(1e-3, time - state.time);
  const speed = (y - state.y) / dt;
  let { armed } = state;
  let hit = null;
  if (armed && pad && speed >= STRIKE_SPEED) {
    hit = { pad, speed };
    armed = false;
  } else if (!armed && (speed <= -REARM_SPEED || !pad || pad.id !== state.pad)) {
    armed = true;
  }
  return { state: { y, time, armed, pad: pad?.id ?? null }, hit };
}

// たたいた速さを音の大きさ（0.2〜1）にする
export function strikeGain(speed) {
  if (!(speed > 0)) return 0.2;
  return Math.min(1, Math.max(0.2, 0.2 + (speed - STRIKE_SPEED) * 0.2));
}

// ---- 録音とくり返し ----
// 録音は [{ pad, time, gain }]（time は録音を始めてからの秒）。length 秒でくり返す

export function addHit(recording, pad, time, gain) {
  return [...recording, { pad, time, gain }];
}

// くり返し再生で、(from, to] の間に鳴らす音。from・to は再生を始めてからの秒
export function eventsBetween(recording, length, from, to) {
  if (!(length > 0) || to <= from) return [];
  const events = [];
  const startLoop = Math.floor(from / length);
  const endLoop = Math.floor(to / length);
  for (let loop = startLoop; loop <= endLoop; loop++) {
    for (const hit of recording) {
      const at = loop * length + hit.time;
      if (at > from && at <= to) events.push({ ...hit, at });
    }
  }
  return events.sort((a, b) => a.at - b.at);
}

// メトロノーム：bpm の拍の、(from, to] の間にある拍の番号（0 から）
export function beatsBetween(bpm, from, to) {
  if (!(bpm > 0)) return [];
  const interval = 60 / bpm;
  const beats = [];
  for (let n = Math.floor(from / interval) + 1; n * interval <= to; n++) beats.push(n);
  return beats;
}

// くり返しの中の時刻にする（0 以上 length 未満）
export function wrapTime(time, length) {
  return ((time % length) + length) % length;
}

// 録音の長さは、拍に合わせて小節（4 拍）の区切りに丸める
export function loopLength(seconds, bpm) {
  const bar = (60 / bpm) * 4;
  return Math.max(1, Math.round(seconds / bar)) * bar;
}
