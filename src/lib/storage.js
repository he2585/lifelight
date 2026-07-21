// =============================================
// 纯本地 IndexedDB 存储层（替代 CloudBase）
// =============================================

const DB_NAME = 'lifelight';
const DB_VER = 1;
const STORE = 'books';
const PROFILE_KEY = '_profile';

let _db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    if (_db) return resolve(_db);
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: '_id' });
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ============ 书 ============

async function putBook(book) {
  const db = await openDB();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  return new Promise((resolve, reject) => {
    const doc = { ...book, type: 'book' };
    if (!doc._id) doc._id = genId();
    const req = store.put(doc);
    req.onsuccess = () => resolve(doc._id);
    req.onerror = () => reject(req.error);
  });
}

async function getBook(id) {
  const db = await openDB();
  const tx = db.transaction(STORE, 'readonly');
  const store = tx.objectStore(STORE);
  return new Promise((resolve, reject) => {
    const req = store.get(id);
    req.onsuccess = () => {
      const doc = req.result;
      if (!doc || doc.type !== 'book') return resolve(null);
      resolve(doc);
    };
    req.onerror = () => reject(req.error);
  });
}

async function deleteBook(id) {
  const db = await openDB();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  return new Promise((resolve, reject) => {
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function listBooks() {
  const db = await openDB();
  const tx = db.transaction(STORE, 'readonly');
  const store = tx.objectStore(STORE);
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => {
      const all = req.result || [];
      const books = all.filter(d => d.type === 'book').map(d => ({
        _id: d._id,
        title: d.title,
        author: d.author,
        readDate: d.readDate,
        note: d.note,
        favorite: !!d.favorite,
        tags: d.tags || [],
        coverBlobKey: d.coverBlobKey,
      }));
      books.sort((a, b) => (b.readDate || '').localeCompare(a.readDate || ''));
      resolve(books);
    };
    req.onerror = () => reject(req.error);
  });
}

async function clearBooks() {
  const db = await openDB();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  return new Promise((resolve, reject) => {
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ============ 封面图片（存 Blob）============

const _coverCache = new Map();

async function saveCoverBlob(blob) {
  const key = 'cover_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  const db = await openDB();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  return new Promise((resolve, reject) => {
    // 存为一个 type='blob' 的记录
    const doc = { _id: key, type: 'blob', blob: blob };
    const req = store.put(doc);
    req.onsuccess = () => resolve(key);
    req.onerror = () => reject(req.error);
  });
}

async function getCoverUrl(blobKey) {
  if (!blobKey) return '';
  const cached = _coverCache.get(blobKey);
  if (cached) return cached;
  const db = await openDB();
  const tx = db.transaction(STORE, 'readonly');
  const store = tx.objectStore(STORE);
  return new Promise((resolve, reject) => {
    const req = store.get(blobKey);
    req.onsuccess = () => {
      const doc = req.result;
      if (doc && doc.type === 'blob' && doc.blob) {
        const url = URL.createObjectURL(doc.blob);
        _coverCache.set(blobKey, url);
        resolve(url);
      } else {
        resolve('');
      }
    };
    req.onerror = () => reject(req.error);
  });
}

// ============ 个人资料 ============

async function loadProfile() {
  const db = await openDB();
  const tx = db.transaction(STORE, 'readonly');
  const store = tx.objectStore(STORE);
  return new Promise((resolve, reject) => {
    const req = store.get(PROFILE_KEY);
    req.onsuccess = () => {
      const doc = req.result;
      if (doc && doc.type === 'profile') {
        resolve({
          avatarDataUrl: doc.avatarDataUrl || null,
          nickname: doc.nickname || '日子有微光',
        });
      } else {
        resolve({ avatarDataUrl: null, nickname: '日子有微光' });
      }
    };
    req.onerror = () => reject(req.error);
  });
}

async function saveProfile(p) {
  const db = await openDB();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  return new Promise((resolve, reject) => {
    const doc = {
      _id: PROFILE_KEY,
      type: 'profile',
      nickname: p.nickname || '日子有微光',
      avatarDataUrl: p.avatarDataUrl || null,
    };
    const req = store.put(doc);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ============ 清空全部 ============

async function clearAll() {
  const db = await openDB();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  return new Promise((resolve, reject) => {
    const req = store.clear();
    req.onsuccess = () => { _coverCache.clear(); resolve(); };
    req.onerror = () => reject(req.error);
  });
}

export {
  putBook, getBook, deleteBook, listBooks, clearBooks,
  saveCoverBlob, getCoverUrl,
  loadProfile, saveProfile,
  clearAll,
};
