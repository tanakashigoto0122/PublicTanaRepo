import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INDEX_TIP, PADS, REARM_SPEED, STRIKE_SPEED, addHit, beatsBetween, eventsBetween, loopLength, padAt, strikeGain,
  updateStrike, wrapTime,
} from '../games/air-drum/logic.js';

const snare = PADS.find((p) => p.id === 'snare');

test('太鼓の並び', () => {
  assert.equal(INDEX_TIP, 8);
  assert.equal(new Set(PADS.map((p) => p.id)).size, PADS.length);
  for (const pad of PADS) {
    assert.ok(pad.x - pad.r * 0.75 >= 0 && pad.x + pad.r * 0.75 <= 1 && pad.y - pad.r >= 0 && pad.y + pad.r <= 1, pad.id);
    assert.match(pad.color, /^--/);
  }
});

test('padAt は太鼓の上なら返し、外なら null', () => {
  assert.equal(padAt([snare.x, snare.y], 4 / 3).id, 'snare');
  assert.equal(padAt([0.5, 0.05], 4 / 3), null);
  // 横長の画面では、横の距離が長く見える
  const edge = [snare.x + snare.r * 0.9 * (3 / 4), snare.y];
  assert.equal(padAt(edge, 4 / 3)?.id, 'snare');
  assert.equal(padAt([snare.x, snare.y - snare.r * 1.2], 4 / 3), null);
  // 縦長の画面では、半径は横幅に対する割合
  assert.equal(padAt([snare.x, snare.y + snare.r * 0.5], 0.75)?.id, 'snare');
});

test('updateStrike は速く振り下ろしたときに 1 回だけ鳴らし、指を上げるとまた鳴らせる', () => {
  let { state, hit } = updateStrike(null, { y: 0.5, time: 0, pad: null });
  assert.equal(hit, null);
  ({ state, hit } = updateStrike(state, { y: 0.52, time: 0.1, pad: snare }));
  assert.equal(hit, null, 'ゆっくりでは鳴らない');
  ({ state, hit } = updateStrike(state, { y: 0.52 + STRIKE_SPEED * 0.05, time: 0.15, pad: snare }));
  assert.equal(hit.pad.id, 'snare');
  assert.ok(hit.speed >= STRIKE_SPEED);
  ({ state, hit } = updateStrike(state, { y: 0.7, time: 0.2, pad: snare }));
  assert.equal(hit, null, '続けて下へ動いても 1 回だけ');
  ({ state, hit } = updateStrike(state, { y: 0.7 - REARM_SPEED * 0.1, time: 0.25, pad: snare }));
  assert.equal(state.armed, true, '上へ動かすとまた叩ける');
  ({ state, hit } = updateStrike(state, { y: 0.8, time: 0.3, pad: snare }));
  assert.equal(hit.pad.id, 'snare');
});

test('updateStrike は太鼓の外では鳴らさず、別の太鼓へ移ると叩ける', () => {
  let { state } = updateStrike(null, { y: 0.2, time: 0, pad: null });
  let hit;
  ({ state, hit } = updateStrike(state, { y: 0.5, time: 0.05, pad: null }));
  assert.equal(hit, null);
  const tom = PADS.find((p) => p.id === 'tom');
  ({ state, hit } = updateStrike(state, { y: 0.7, time: 0.1, pad: snare }));
  assert.equal(hit.pad.id, 'snare');
  ({ state, hit } = updateStrike(state, { y: 0.71, time: 0.15, pad: tom }));
  assert.equal(state.armed, true, '別の太鼓に入った');
});

test('strikeGain は 0.2〜1', () => {
  assert.equal(strikeGain(0), 0.2);
  assert.equal(strikeGain(STRIKE_SPEED), 0.2);
  assert.ok(strikeGain(STRIKE_SPEED + 2) > strikeGain(STRIKE_SPEED + 1));
  assert.equal(strikeGain(100), 1);
});

test('録音とくり返し', () => {
  let recording = [];
  recording = addHit(recording, 'kick', 0, 1);
  recording = addHit(recording, 'snare', 1, 0.5);
  assert.equal(recording.length, 2);
  // 2 秒でくり返し：0〜4.5 秒に kick は 0・2・4、snare は 1・3
  const events = eventsBetween(recording, 2, -0.01, 4.5);
  assert.deepEqual(events.map((e) => [e.pad, e.at]), [['kick', 0], ['snare', 1], ['kick', 2], ['snare', 3], ['kick', 4]]);
  assert.deepEqual(eventsBetween(recording, 2, 1, 2).map((e) => e.at), [2], '始まりは含まず、終わりは含む');
  assert.deepEqual(eventsBetween(recording, 0, 0, 5), []);
  assert.deepEqual(eventsBetween(recording, 2, 3, 3), []);
});

test('beatsBetween と loopLength', () => {
  assert.deepEqual(beatsBetween(120, 0, 2), [1, 2, 3, 4]);
  assert.deepEqual(beatsBetween(120, 0.5, 1.4), [2]);
  assert.deepEqual(beatsBetween(0, 0, 10), []);
  assert.equal(loopLength(2.1, 120), 2, '1 小節（4 拍 = 2 秒）');
  assert.equal(loopLength(5.2, 120), 6);
  assert.equal(loopLength(0.3, 120), 2, '短くても 1 小節');
});

test('wrapTime はくり返しの中の時刻にする', () => {
  assert.equal(wrapTime(2.5, 2), 0.5);
  assert.equal(wrapTime(-0.5, 2), 1.5);
  assert.equal(wrapTime(0, 2), 0);
});
