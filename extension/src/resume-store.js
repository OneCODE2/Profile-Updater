/**
 * Resume bytes live in IndexedDB, not chrome.storage.
 * One transaction replaces the current record. shortcut: IDB's transaction is the
 * atomic swap, so a previous key is not kept after commit.
 */

const DB = "npu-resume";
const STORE = "resume";

const openDb = () =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const requestToPromise = (request) =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const createResumeStore = () => ({
  async get() {
    const db = await openDb();
    const row = await requestToPromise(db.transaction(STORE, "readonly").objectStore(STORE).get("current"));
    return row || null;
  },
  async put(record) {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(record, "current");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
  async clear() {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete("current");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
});

module.exports = { createResumeStore };
