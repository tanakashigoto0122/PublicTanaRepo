// いくつかのゲームで共通に使う、DOM に依存しない部分
import { detectFormat } from '../model-viewer/logic.js';

// 保存されたキャラクターが読み込める形をしているか
export function isCharacterRecord(record) {
  return record?.data instanceof ArrayBuffer && Boolean(detectFormat(record.name));
}
