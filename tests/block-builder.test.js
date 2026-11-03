import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HISTORY_LIMIT, MAX_SCALE, MIN_SCALE, SHAPE_KINDS, addShape, clampScale, createHistory, createSampleScene,
  createScene, deserialize, duplicateShape, findFreeSpot, findShape, normalizeColor, record, redo,
  removeShape, serialize, undo, updateShape,
} from '../games/block-builder/logic.js';

const RED = '#ff0000';
const BLUE = '#0000ff';

test('createScene は空の作品を返す', () => {
  assert.deepEqual(createScene(), { shapes: [], nextId: 1 });
});

test('findFreeSpot は原点から順に空いている場所を探す', () => {
  assert.deepEqual(findFreeSpot([]), [0, 0]);
  let scene = createScene();
  const spots = [];
  for (let i = 0; i < 9; i++) {
    scene = addShape(scene, 'box', RED);
    spots.push(scene.shapes[i].position[0] + ',' + scene.shapes[i].position[2]);
  }
  // 3x3 のマスを重ならずに埋める
  assert.equal(new Set(spots).size, 9);
  const xs = scene.shapes.map((s) => s.position[0]);
  assert.equal(Math.max(...xs) - Math.min(...xs), 3);
});

test('addShape は床の上に初期状態の形を追加し、id を進める', () => {
  const scene = addShape(createScene(), 'sphere', '#AABBCC');
  assert.deepEqual(scene.shapes[0], {
    id: 1, kind: 'sphere', position: [0, 0.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1], color: '#aabbcc',
  });
  assert.equal(scene.nextId, 2);
  for (const kind of SHAPE_KINDS) assert.ok(addShape(scene, kind, RED));
  assert.throws(() => addShape(scene, 'pyramid', RED));
  assert.throws(() => addShape(scene, 'box', 'red'));
});

test('updateShape は指定した形だけを書き換え、元の作品は変えない', () => {
  const before = addShape(addShape(createScene(), 'box', RED), 'cone', RED);
  const after = updateShape(before, 2, { position: [1, 2, 3], color: '#00FF00' });
  assert.deepEqual(findShape(after, 2).position, [1, 2, 3]);
  assert.equal(findShape(after, 2).color, '#00ff00');
  assert.equal(findShape(after, 1), before.shapes[0]);
  assert.equal(findShape(before, 2).color, RED);
  assert.equal(updateShape(before, 99, { color: BLUE }), before);
});

test('大きさは MIN_SCALE〜MAX_SCALE に収める', () => {
  const scene = updateShape(addShape(createScene(), 'box', RED), 1, { scale: [0, 100, NaN] });
  assert.deepEqual(findShape(scene, 1).scale, [MIN_SCALE, MAX_SCALE, 1]);
  assert.equal(clampScale(2.5), 2.5);
});

test('removeShape と duplicateShape', () => {
  let scene = addShape(createScene(), 'torus', RED);
  scene = updateShape(scene, 1, { position: [0, 3, 0], rotation: [1, 2, 3], scale: [2, 2, 2] });
  const copied = duplicateShape(scene, 1);
  const copy = findShape(copied, 2);
  assert.equal(copy.kind, 'torus');
  assert.deepEqual(copy.rotation, [1, 2, 3]);
  assert.deepEqual(copy.scale, [2, 2, 2]);
  assert.equal(copy.position[1], 3);
  assert.notDeepEqual([copy.position[0], copy.position[2]], [0, 0]);
  // コピーの配列は元と共有しない
  assert.notEqual(copy.rotation, findShape(copied, 1).rotation);
  assert.equal(copied.nextId, 3);
  assert.equal(duplicateShape(scene, 99), scene);

  const removed = removeShape(copied, 1);
  assert.deepEqual(removed.shapes.map((s) => s.id), [2]);
  assert.equal(removed.nextId, 3);
  assert.equal(removeShape(removed, 1), removed);
});

test('normalizeColor は #rrggbb だけを受け付ける', () => {
  assert.equal(normalizeColor('#ABCDEF'), '#abcdef');
  assert.throws(() => normalizeColor('#abc'));
  assert.throws(() => normalizeColor('rgb(0,0,0)'));
});

test('履歴で元に戻す・やり直すができる', () => {
  const a = createScene();
  const b = addShape(a, 'box', RED);
  const c = addShape(b, 'cone', RED);
  let history = record(record(createHistory(a), b), c);
  assert.equal(history.present, c);
  history = undo(history);
  assert.equal(history.present, b);
  history = undo(history);
  assert.equal(history.present, a);
  assert.equal(undo(history), history);
  history = redo(history);
  assert.equal(history.present, b);
  // 戻したあとに別の操作をすると、やり直しの履歴は消える
  const d = addShape(b, 'sphere', BLUE);
  history = record(history, d);
  assert.equal(history.future.length, 0);
  assert.equal(redo(history), history);
  assert.equal(record(history, d), history);
});

test('履歴は HISTORY_LIMIT 件までしか残さない', () => {
  let scene = createScene();
  let history = createHistory(scene);
  for (let i = 0; i < HISTORY_LIMIT + 20; i++) {
    scene = addShape(scene, 'box', RED);
    history = record(history, scene);
  }
  assert.equal(history.past.length, HISTORY_LIMIT);
});

test('serialize したものを deserialize すると同じ作品に戻る', () => {
  const scene = createSampleScene([RED, BLUE, '#00ff00']);
  assert.deepEqual(deserialize(serialize(scene)), scene);
});

test('deserialize は壊れたデータを拒み、おかしな形だけを捨てる', () => {
  assert.equal(deserialize('not json'), null);
  assert.equal(deserialize('null'), null);
  assert.equal(deserialize(JSON.stringify({ version: 2, shapes: [] })), null);
  assert.equal(deserialize(JSON.stringify({ version: 1 })), null);

  const good = { kind: 'box', position: [1, 2, 3], rotation: [0, 0, 0], scale: [50, 1, 1], color: '#ABCDEF' };
  const text = JSON.stringify({
    version: 1,
    shapes: [
      { ...good, id: 40 },
      { ...good, kind: 'pyramid' },
      { ...good, position: [1, 2] },
      { ...good, scale: [1, 'x', 1] },
      { ...good, color: 'blue' },
      null,
      { ...good, kind: 'cone' },
    ],
  });
  const scene = deserialize(text);
  assert.deepEqual(scene.shapes.map((s) => [s.id, s.kind]), [[1, 'box'], [2, 'cone']]);
  assert.deepEqual(scene.shapes[0].scale, [MAX_SCALE, 1, 1]);
  assert.equal(scene.shapes[0].color, '#abcdef');
  assert.equal(scene.nextId, 3);
});

test('createSampleScene は積み重なった 3 つの形を作る', () => {
  const scene = createSampleScene([RED, BLUE, '#00ff00']);
  assert.deepEqual(scene.shapes.map((s) => s.kind), ['box', 'cylinder', 'cone']);
  assert.deepEqual(scene.shapes.map((s) => s.position[1]), [0.5, 1.5, 2.5]);
  assert.deepEqual(scene.shapes.map((s) => s.color), [RED, BLUE, '#00ff00']);
});
