import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKUP_EXTENSION, MAX_CHARACTERS, backupFileName, characterFileName, characterSummary, detectFormat, formatDate, guessFacing, isCharacterRecord,
  packBackup, turnFacing, unpackBackup,
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

function bytes(...values) {
  return Uint8Array.from(values).buffer;
}

test('packBackup と unpackBackup で元に戻る', () => {
  const records = [
    { id: 'a', name: 'ロボ.glb', format: 'glb', facing: Math.PI / 2, addedAt: 10, data: bytes(1, 2, 3) },
    { id: 'b', name: 'cube.obj', format: 'obj', data: bytes() },
    { id: 'c', name: 'tet.stl', format: 'stl', facing: 0, addedAt: 30, data: bytes(9) },
  ];
  const restored = unpackBackup(packBackup(records, 'c'));
  assert.equal(restored.current, 'c');
  assert.deepEqual(restored.records.map((r) => [r.id, r.name, r.format, r.facing, r.addedAt, [...new Uint8Array(r.data)]]), [
    ['a', 'ロボ.glb', 'glb', Math.PI / 2, 10, [1, 2, 3]],
    ['b', 'cube.obj', 'obj', undefined, undefined, []],
    ['c', 'tet.stl', 'stl', 0, 30, [9]],
  ]);
  assert.deepEqual(unpackBackup(packBackup([])), { current: null, records: [] });
});

test('unpackBackup は違うファイルや壊れたファイルを読まない', () => {
  assert.equal(unpackBackup(new TextEncoder().encode('hello world, not a backup').buffer), null);
  assert.equal(unpackBackup(bytes(1, 2)), null);
  assert.equal(unpackBackup('text'), null);
  const good = packBackup([{ id: 'a', name: 'a.glb', format: 'glb', data: bytes(1, 2, 3, 4) }]);
  assert.equal(unpackBackup(good.slice(0, 20)), null, '目次が途中で切れている');
  const cut = unpackBackup(good.slice(0, good.byteLength - 1));
  assert.deepEqual(cut.records, [], 'データが足りないキャラクターは飛ばす');
});

test('unpackBackup は名前と形式が合わないキャラクターを飛ばす', () => {
  const packed = packBackup([
    { id: 'a', name: 'a.png', format: 'png', data: bytes(1) },
    { id: 'b', name: 'b.glb', format: 'obj', data: bytes(1) },
    { id: 'c', name: 'c.stl', format: 'stl', data: bytes(1) },
  ]);
  assert.deepEqual(unpackBackup(packed).records.map((r) => r.id), ['c']);
});

test('backupFileName', () => {
  assert.equal(backupFileName(new Date(2026, 0, 5).getTime()), `characters-20260105.${BACKUP_EXTENSION}`);
});
