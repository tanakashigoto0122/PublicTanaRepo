import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIBRARY_PREFIX, characterFileName, displayName, isCharacterRecord, libraryKey, newCharacterId, sortCharacters,
} from '../games/shared/logic.js';

test('isCharacterRecord は、中身があって開ける形式のキャラクターだけ', () => {
  const data = new ArrayBuffer(4);
  assert.equal(isCharacterRecord({ name: 'robo.glb', format: 'glb', data }), true);
  assert.equal(isCharacterRecord({ name: 'ROBO.STL', format: 'stl', data }), true);
  assert.equal(isCharacterRecord({ name: 'photo.png', data }), false, '開けない形式');
  assert.equal(isCharacterRecord({ name: 'robo.glb', data: 'text' }), false, '中身がない');
  assert.equal(isCharacterRecord({ data }), false, '名前がない');
  assert.equal(isCharacterRecord(undefined), false);
  assert.equal(isCharacterRecord(null), false);
});

test('libraryKey と newCharacterId', () => {
  assert.equal(libraryKey('abc'), `${LIBRARY_PREFIX}abc`);
  assert.equal(newCharacterId(36 ** 3, () => 0), '1000-000000');
  assert.notEqual(newCharacterId(1, () => 0.1), newCharacterId(1, () => 0.2));
  assert.match(newCharacterId(), /^[0-9a-z]+-[0-9a-z]{6}$/);
});

test('sortCharacters は追加した順で、時刻のない古い記録が先頭', () => {
  const records = [{ id: 'b', addedAt: 20 }, { id: 'old' }, { id: 'a', addedAt: 10 }];
  assert.deepEqual(sortCharacters(records).map((r) => r.id), ['old', 'a', 'b']);
  assert.equal(records[0].id, 'b', '元の配列は変えない');
});

test('displayName と characterFileName', () => {
  assert.equal(displayName('mecha.glb'), 'mecha');
  assert.equal(displayName('a.b.obj'), 'a.b');
  assert.equal(displayName(''), 'キャラクター');
  assert.equal(displayName(undefined), 'キャラクター');
  assert.equal(characterFileName(' ロボ ', 'glb'), 'ロボ.glb');
  assert.equal(characterFileName('ロボ.stl', 'glb'), 'ロボ.glb', '拡張子は形式に合わせる');
  assert.equal(characterFileName('a/b:c', 'obj'), 'abc.obj', 'ファイル名に使えない文字は消す');
  assert.equal(characterFileName('   ', 'stl'), 'キャラクター.stl');
});
