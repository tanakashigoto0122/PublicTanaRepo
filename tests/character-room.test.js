import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_CHARACTERS, characterFileName, characterSummary, detectFormat, formatDate, guessFacing, isCharacterRecord,
  turnFacing,
} from '../games/character-room/logic.js';

test('ほかのゲームの関数', () => {
  assert.equal(detectFormat('robo.GLB'), 'glb');
  assert.equal(guessFacing([1, 2, 1]), 0);
  assert.equal(characterFileName('ロボ', 'stl'), 'ロボ.stl');
  assert.equal(isCharacterRecord({ name: 'a.obj', data: new ArrayBuffer(1) }), true);
  assert.ok(MAX_CHARACTERS > 0);
});

test('turnFacing は 90 度ずつ回り、-π〜π に収まる', () => {
  assert.equal(turnFacing(0), Math.PI / 2);
  assert.equal(turnFacing(Math.PI / 2), Math.PI);
  assert.ok(Math.abs(turnFacing(Math.PI) + Math.PI / 2) < 1e-9);
  assert.ok(Math.abs(turnFacing(-Math.PI / 2)) < 1e-9);
  assert.equal(turnFacing(), Math.PI / 2, '向きがなければ 0 から');
  // 4 回で元に戻る
  let angle = -Math.PI / 2;
  for (let i = 0; i < 4; i++) angle = turnFacing(angle);
  assert.ok(Math.abs(angle + Math.PI / 2) < 1e-9);
});

test('formatDate と characterSummary', () => {
  const ms = new Date(2026, 10, 9, 12).getTime();
  assert.equal(formatDate(ms), '2026/11/9');
  assert.equal(formatDate(undefined), '');
  assert.equal(characterSummary({ format: 'glb', data: new ArrayBuffer(2048), addedAt: ms }), 'glb・2.0 KB・2026/11/9');
  assert.equal(characterSummary({ format: 'stl', data: new ArrayBuffer(10) }), 'stl・10 B', '日付がない古い記録');
});
