import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCharacterRecord } from '../games/shared/logic.js';

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
