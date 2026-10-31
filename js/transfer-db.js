/* ---------------------------------------------------------------------
   index.html(タイトル画面) ⇔ game.html(ゲーム本編) の間で、
   ユーザーが選択したGLB(勇者/メイド)や、ロードするセーブデータのテキストを
   安全に引き継ぐための小さな共有ヘルパー。

   GLBファイルは数十MB〜になり得るため、容量制限の厳しい
   localStorage/sessionStorage(通常5〜10MB程度)ではなく、
   より大きな容量を扱えるIndexedDBを使用する。

   index.html / game.html の両方から
   <script src="js/transfer-db.js"></script> で読み込んで使う。
--------------------------------------------------------------------- */
const TransferDB = (() => {
  const DB_NAME = 'dragonHunterTransfer';
  const STORE_NAME = 'kv';
  const DB_VERSION = 1;

  function openDb() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error('このブラウザではIndexedDBが利用できません'));
        return;
      }
      let req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) {
        reject(e);
        return;
      }
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE_NAME)) {
          req.result.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDBを開けませんでした'));
    });
  }

  async function set(key, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      } catch (e) {
        reject(e);
      }
    });
  }

  async function get(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(key);
        req.onsuccess = () => resolve(req.result === undefined ? null : req.result);
        req.onerror = () => reject(req.error);
      } catch (e) {
        reject(e);
      }
    });
  }

  async function del(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      } catch (e) {
        reject(e);
      }
    });
  }

  return { get, set, del };
})();
