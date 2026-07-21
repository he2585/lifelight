// =============================================
// 混合存储层
// - 数据：CloudBase 数据库（跨设备同步）
// - 封面：优先云存储，失败自动降级到 IndexedDB
// - JSON 备份导出/导入
// =============================================

import cloudbase from '@cloudbase/js-sdk';

const TCB_ENV_ID = 'lifelight-d8gqa6nbcf8db37c6';
const COLLECTION = 'lifelight';

// ============ CloudBase 初始化 ============
let _tcbApp = null;
let _tcbReady = null;

async function initCloud() {
  if (_tcbReady) return _tcbReady;
  _tcbReady = (async () => {
    const app = cloudbase.init({
      env: TCB_ENV_ID,
      region: 'ap-shanghai',
    });
    try { await app.auth.signOut(); } catch {}
    await app.auth.signInAnonymously();
    _tcbApp = app;
  })();
  return _tcbReady;
}

function db() {
  if (!_tcbApp) throw new Error('CloudBase 未初始化');
  return _tcbApp.database();
}

// ============ IndexedDB 本地存储（封面备用） ============
const DB_NAME = 'lifelight_local';
const DB_VER = 1;
const STORE = 'files';
let _idb = null;

function openIDB() {
  return new Promise((resolve, reject) => {
    if (_idb) return resolve(_idb);
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: '_id' });
      }
    };
    req.onsuccess = () => { _idb = req.result; resolve(_idb); };
    req.onerror = () => reject(req.error);
  });
}

async function saveBlobLocal(key, blob) {
  const db = await openIDB();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  return new Promise((resolve, reject) => {
    const req = store.put({ _id: key, blob });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function getBlobLocal(key) {
  if (!key) return null;
  const db = await openIDB();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  return new Promise((resolve, reject) => {
    const req = store.get(key);
    req.onsuccess = () => {
      const doc = req.result;
      resolve(doc ? doc.blob : null);
    };
    req.onerror = () => reject(req.error);
  });
}

// ============ 图片压缩 ============
const MAX_LONG_EDGE = 800;
const JPEG_QUALITY = 0.7;

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const w0 = img.width, h0 = img.height;
        const longEdge = Math.max(w0, h0);
        const scale = longEdge > MAX_LONG_EDGE ? MAX_LONG_EDGE / longEdge : 1;
        const w = Math.round(w0 * scale);
        const h = Math.round(h0 * scale);
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        c.toBlob(
          blob => blob ? resolve(blob) : reject(new Error('toBlob failed')),
          'image/jpeg', JPEG_QUALITY
        );
      };
      img.onerror = () => reject(new Error('image load failed'));
      img.src = reader.result;
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// ============ 封面存储（云存储 + 本地双存） ============
const _urlCache = new Map();

/**
 * 上传封面：优先云端，云端失败则存本地
 * 返回 { fileID: string, localKey: string|null }
 * - fileID 云存储 ID（有值表示云端成功）
 * - localKey 本地 key（有值表示兜底了本地）
 */
async function uploadCover(compressedBlob) {
  const key = 'cover_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  let fileID = null;

  // 尝试云端
  try {
    await initCloud();
    const ext = 'jpg';
    const fName = `cover-${Date.now()}.${ext}`;
    const cPath = `lifelight/${fName}`;
    const fObj = new File([compressedBlob], fName, { type: 'image/jpeg' });
    const resp = await _tcbApp.uploadFile({ cloudPath: cPath, filePath: fObj });
    fileID = resp.fileID;
  } catch (err) {
    console.warn('[uploadCover] 云存储失败，降级到本地:', err.message);
  }

  // 总存一份本地
  try {
    await saveBlobLocal(key, compressedBlob);
  } catch (err) {
    console.warn('[uploadCover] 本地存储也失败:', err.message);
  }

  return { fileID, localKey: key };
}

/**
 * 获取封面 URL：优先云存储临时 URL，失败则用本地 Blob URL
 */
async function getCoverUrl(cover) {
  if (!cover) return '';
  const { fileID, localKey } = cover;

  // 尝试云存储临时 URL
  if (fileID) {
    const cached = _urlCache.get(fileID);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.url;
    try {
      await initCloud();
      const res = await _tcbApp.getTempFileURL({ fileList: [fileID] });
      const item = (res.fileList || [])[0];
      if (item && item.tempFileURL) {
        _urlCache.set(fileID, { url: item.tempFileURL, expiresAt: Date.now() + 50 * 60 * 1000 });
        return item.tempFileURL;
      }
    } catch (err) {
      console.warn('[getCoverUrl] 云存储取 URL 失败:', err.message);
    }
  }

  // 降级到本地
  if (localKey) {
    const cacheKey = 'local_' + localKey;
    const cached = _urlCache.get(cacheKey);
    if (cached) return cached;
    try {
      const blob = await getBlobLocal(localKey);
      if (blob) {
        const url = URL.createObjectURL(blob);
        _urlCache.set(cacheKey, url);
        return url;
      }
    } catch (err) {
      console.warn('[getCoverUrl] 本地 blob 也失败:', err.message);
    }
  }

  return '';
}

/**
 * 删除封面（云 + 本地）
 */
async function deleteCover(cover) {
  if (!cover) return;
  const { fileID, localKey } = cover;
  if (fileID) {
    try {
      await initCloud();
      // CloudBase SDK v3 的删除文件接口
      if (_tcbApp.deleteFile) {
        await _tcbApp.deleteFile({ fileList: [fileID] });
      }
    } catch (err) {
      console.warn('[deleteCover] 云删除失败:', err.message);
    }
  }
  if (localKey) {
    try {
      const db = await openIDB();
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      store.delete(localKey);
    } catch (err) {
      console.warn('[deleteCover] 本地删除失败:', err.message);
    }
  }
}

// ============ 书的 CRUD（CloudBase 数据库） ============

/**
 * 保存书
 * 入参 book 中 cover 格式: { fileID, localKey }
 */
async function putBook(book) {
  await initCloud();
  const { _id, cover, ...payload } = book;
  // 只把 cover 的 fileID 上传到数据库（localKey 不传，本地用）
  const dbData = { ...payload, type: 'book' };
  if (cover) {
    dbData.coverFileID = cover.fileID || null;
  }

  if (_id) {
    await db().collection(COLLECTION).doc(_id).update({ data: dbData });
    return { _id, cover };
  }
  const res = await db().collection(COLLECTION).add({ data: dbData });
  const newId = res._id || res.id;
  return { _id: newId, cover };
}

async function getBook(id) {
  await initCloud();
  const res = await db().collection(COLLECTION).doc(id).get();
  const arr = res.data || [];
  const raw = arr[0];
  if (!raw) return null;
  const dataFields = raw.data || raw;
  // localKey 从本地同步数据里补（数据里不存 localKey，只有 fileID）
  return {
    _id: raw._id,
    title: dataFields.title,
    author: dataFields.author,
    readDate: dataFields.readDate,
    note: dataFields.note,
    favorite: !!dataFields.favorite,
    tags: dataFields.tags,
    cover: { fileID: dataFields.coverFileID || null, localKey: null },
  };
}

async function deleteBook(id) {
  await initCloud();
  // 先拿书信息（封面也要删）
  const book = await getBook(id);
  if (book && book.cover) await deleteCover(book.cover);
  await db().collection(COLLECTION).doc(id).remove();
}

async function listBooks() {
  await initCloud();
  const res = await db().collection(COLLECTION).get();
  const arr = res.data || [];
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const doc = arr[i];
    const dataFields = doc.data || doc;
    if (dataFields.type === 'book') {
      out.push({
        _id: doc._id,
        title: dataFields.title,
        author: dataFields.author,
        readDate: dataFields.readDate,
        note: dataFields.note,
        favorite: !!dataFields.favorite,
        tags: dataFields.tags,
        cover: { fileID: dataFields.coverFileID || null, localKey: null },
      });
    }
  }
  return out.sort((a, b) => (b.readDate || '').localeCompare(a.readDate || ''));
}

async function clearAll() {
  await initCloud();
  // 清数据库
  const res = await db().collection(COLLECTION).where({ 'data.type': 'book' }).get();
  await Promise.all((res.data || []).map(b => db().collection(COLLECTION).doc(b._id).remove()));
  const prof = await db().collection(COLLECTION).where({ 'data.type': 'profile' }).get();
  await Promise.all((prof.data || []).map(p => db().collection(COLLECTION).doc(p._id).remove()));
  // 清本地
  try {
    const db = await openIDB();
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    store.clear();
  } catch {}
}

// ============ 个人资料 ============
const PROFILE_DEFAULT = { nickname: '日子有微光' };
let _profileCache = null;

async function loadProfile() {
  if (_profileCache) return _profileCache;
  await initCloud();
  const res = await db().collection(COLLECTION).where({ 'data.type': 'profile' }).limit(1).get();
  const p = res.data && res.data[0];
  if (p) {
    const profileData = p.data || p;
    _profileCache = {
      avatarDataUrl: profileData.avatarDataUrl || null,
      nickname: profileData.nickname || PROFILE_DEFAULT.nickname,
    };
  } else {
    _profileCache = { ...PROFILE_DEFAULT };
  }
  return _profileCache;
}

async function saveProfile(p) {
  await initCloud();
  const data = {
    type: 'profile',
    nickname: p.nickname,
    avatarDataUrl: p.avatarDataUrl || null,
  };
  const existing = await db().collection(COLLECTION).where({ 'data.type': 'profile' }).limit(1).get();
  if (existing.data && existing.data[0]) {
    await db().collection(COLLECTION).doc(existing.data[0]._id).update({ data });
  } else {
    await db().collection(COLLECTION).add({ data });
  }
  _profileCache = { ...p };
}

function profileSync() {
  return _profileCache || { ...PROFILE_DEFAULT };
}

// ============ 导出 ============
// cover 字段简化后导出，导入时再重建（本地 blob 不导出）
async function exportBooks() {
  const books = await listBooks();
  const profile = await loadProfile();
  return {
    version: 2,
    exportedAt: new Date().toISOString(),
    books: books.map(b => ({
      _id: b._id,
      title: b.title,
      author: b.author,
      readDate: b.readDate,
      note: b.note,
      favorite: b.favorite,
      tags: b.tags,
      coverFileID: b.cover?.fileID || null,
    })),
    profile,
  };
}

async function importBooks(data) {
  if (!data.books || !Array.isArray(data.books)) throw new Error('备份格式不正确');
  await initCloud();
  for (const b of data.books) {
    const cover = { fileID: b.coverFileID || null, localKey: null };
    const { _id, coverFileID, ...rest } = b;
    await putBook({ ...rest, cover, _id });
  }
  if (data.profile) {
    await saveProfile(data.profile);
  }
}

export {
  initCloud,
  putBook, getBook, deleteBook, listBooks, clearAll,
  uploadCover, getCoverUrl, deleteCover,
  compressImage,
  loadProfile, saveProfile, profileSync,
  exportBooks, importBooks,
};
