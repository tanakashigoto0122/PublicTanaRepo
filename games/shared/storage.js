// このブラウザの IndexedDB に保存する部品。どこにも送らない。
import { LIBRARY_PREFIX, isCharacterRecord, libraryKey, newCharacterId, sortCharacters } from './logic.js';

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

// いま使うキャラクターにする。保存した一覧にも入れる（id がなければ新しく付ける）。
// null を渡すと、いまのキャラクターを外す（一覧には残る）
export async function writeCharacter(record) {
  if (!record) {
    await withCharacterStore('readwrite', (store) => store.delete(CURRENT));
    return;
  }
  record.id ??= newCharacterId();
  record.addedAt ??= Date.now();
  await withCharacterStore('readwrite', (store) => {
    store.put(record, libraryKey(record.id));
    return store.put(record, CURRENT);
  });
}

// 保存した一覧（追加した順）
export async function listCharacters() {
  const range = IDBKeyRange.bound(LIBRARY_PREFIX, `${LIBRARY_PREFIX}\uffff`);
  const records = await withCharacterStore('readonly', (store) => store.getAll(range));
  return sortCharacters(records.filter((record) => isCharacterRecord(record) && record.id));
}

// 一覧にだけ入れる。いま使っているキャラクターと同じなら、そちらも書き換える
export async function saveCharacter(record) {
  record.id ??= newCharacterId();
  record.addedAt ??= Date.now();
  await withCharacterStore('readwrite', (store) => {
    store.put(record, libraryKey(record.id));
    const request = store.get(CURRENT);
    request.onsuccess = () => {
      if (request.result?.id === record.id) store.put(record, CURRENT);
    };
    return request;
  });
}

// 一覧から消す。いま使っているキャラクターなら、それも外す
export async function removeCharacter(id) {
  await withCharacterStore('readwrite', (store) => {
    store.delete(libraryKey(id));
    const request = store.get(CURRENT);
    request.onsuccess = () => {
      if (request.result?.id === id) store.delete(CURRENT);
    };
    return request;
  });
}
