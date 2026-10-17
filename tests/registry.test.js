import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { games } from '../games/registry.js';

test('登録されたゲームはすべて games/<id>/index.html を持つ', () => {
  assert.ok(games.length > 0);
  for (const game of games) {
    assert.ok(game.title && game.description, `${game.id} に title と description が必要`);
    const path = new URL(`../games/${game.id}/index.html`, import.meta.url);
    assert.ok(existsSync(path), `games/${game.id}/index.html が見つからない`);
  }
});

test('ゲームの id は重複しない', () => {
  const ids = games.map((g) => g.id);
  assert.equal(new Set(ids).size, ids.length);
});
