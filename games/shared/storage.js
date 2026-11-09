// このブラウザの IndexedDB に保存する部品。どこにも送らない。
import { isCharacterRecord } from './logic.js';

// 1 つのストアだけを持つデータベースを開き、action(store) の結果を返す
export function objectStore(dbName, storeName, storeOptions) {
  function open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(storeName, storeOptions);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return async function withStore(mode, action) {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, mode);
        const request = action(transaction.objectStore(storeName));
        transaction.oncomplete = () => resolve(request.result);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      db.close();
    }
  };
}

// ゲームをまたいで使うキャラクター。最初に作ったメカ・ブラスターの名前のまま使い続ける
const withCharacterStore = objectStore('mini-games-mecha-blaster', 'character');
const CURRENT = 'current';

// 使えるキャラクター（{ name, format, data, facing }）か、なければ null
export async function readCharacter() {
  const record = await withCharacterStore('readonly', (store) => store.get(CURRENT));
  return isCharacterRecord(record) ? record : null;
}

// null を渡すとキャラクターを消す
export async function writeCharacter(record) {
  await withCharacterStore('readwrite', (store) => (record ? store.put(record, CURRENT) : store.delete(CURRENT)));
}
