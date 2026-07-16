// =============================================
// 0. 入口：src/main.js（vite 入口）
// =============================================
import './styles.css';
import cloudbase from '@cloudbase/js-sdk';

// =============================================
// 1. 常量与配置
// =============================================
const TCB_ENV_ID = 'lifelight-d8gqa6nbcf8db37c6';
const COLLECTION = 'lifelight';
const POSTER_W = 1080;
const POSTER_H = 1440;

// =============================================
// 2. CloudBase 初始化
// =============================================
let _tcbApp = null;
let _tcbReady = null;

async function initCloud() {
  if (_tcbReady) return _tcbReady;
  _tcbReady = (async () => {
    const app = cloudbase.init({
      env: TCB_ENV_ID,
      region: 'ap-shanghai',  // v3 必须指定地域
    });
    // 强制清掉之前残留的失败缓存
    try { await app.auth.signOut(); } catch {}
    await app.auth.signInAnonymously();
    _tcbApp = app;
  })();
  return _tcbReady;
}

function db() {
  if (!_tcbApp) { throw new Error('CloudBase 未初始化'); }
  return _tcbApp.database();
}

// =============================================
// 3. 数据访问层（UI 调这些函数；不再直接调 IDB）
// =============================================

// 把书存进去（book 包含 coverFileID）。返回 _id
async function putBook(book) {
  await initCloud();
  const { _id, ...payload } = book;
  if (_id) {
    await db().collection(COLLECTION).doc(_id).update({ data: payload });
    return _id;
  }
  const res = await db().collection(COLLECTION).add({
    data: { ...payload, type: 'book' },
  });
  return res._id || res.id;
}

async function getBook(id) {
  await initCloud();
  const res = await db().collection(COLLECTION).doc(id).get();
  const arr = res.data || [];
  const raw = arr[0];
  if (!raw) return null;
  return { _id: raw._id, ...(raw.data || raw) };
}

async function deleteBook(id) {
  await initCloud();
  await db().collection(COLLECTION).doc(id).remove();
}

async function listBooks() {
  await initCloud();
  // 直接拉所有，前端过滤（避免 SDK 对 data.* 字段路径的歧义）
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
        coverFileID: dataFields.coverFileID,
      });
    }
  }
  return out.sort(function(a, b) {
    return (b.readDate || '').localeCompare(a.readDate || '');
  });
}

async function clearAll() {
  await initCloud();
  const res = await db().collection(COLLECTION).where({ 'data.type': 'book' }).get();
  await Promise.all((res.data || []).map(b => db().collection(COLLECTION).doc(b._id).remove()));
  const prof = await db().collection(COLLECTION).where({ 'data.type': 'profile' }).get();
  await Promise.all((prof.data || []).map(p => db().collection(COLLECTION).doc(p._id).remove()));
}

// 个人资料：profile 用同一集合，type='profile' 单文档
const PROFILE_DEFAULT = { avatarFileID: null, nickname: '日子有微光' };
let _profileCache = null;

async function loadProfile() {
  if (_profileCache) return _profileCache;
  await initCloud();
  const res = await db().collection(COLLECTION).where({ 'data.type': 'profile' }).limit(1).get();
  const p = res.data && res.data[0];
  if (p) {
    const profileData = p.data || p;
    _profileCache = {
      avatar: profileData.avatarDataUrl || null,
      avatarDataUrl: profileData.avatarDataUrl || null,
      avatarFileID: profileData.avatarFileID || null,
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
    avatarFileID: p.avatarFileID || null,
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
  // 给 UI 用的同步接口（启动时已加载过 profile 之后才安全）
  return _profileCache || { ...PROFILE_DEFAULT };
}

// =============================================
// 4. 云存储：上传 / 临时 URL
// =============================================
const _fileUrlCache = new Map();

async function uploadBookCoverToCloud(blob, name) {
  await initCloud();
  const ext = (blob.type || 'image/jpeg').split('/')[1] || 'jpg';
  const fName = name || `file-${Date.now()}.${ext}`;
  const cPath = `lifelight/${fName}`;
  const fObj = new File([blob], fName, { type: blob.type || 'image/jpeg' });
  const resp = await _tcbApp.uploadFile({ cloudPath: cPath, filePath: fObj });
  return resp.fileID;
}

async function fileIdToUrl(fileID) {
  if (!fileID) return null;
  const cached = _fileUrlCache.get(fileID);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.url;
  await initCloud();
  // v3：getTempFileURL 接受 fileID 数组
  const res = await _tcbApp.getTempFileURL({ fileList: [fileID] });
  const item = (res.fileList || [])[0];
  if (!item || !item.tempFileURL) return null;
  _fileUrlCache.set(fileID, { url: item.tempFileURL, expiresAt: Date.now() + 50 * 60 * 1000 });
  return item.tempFileURL;
}

// UI 用的：拿一本书的封面 URL（异步）
async function bookCoverUrl(book) {
  if (!book) return '';
  if (book.coverFileID) return (await fileIdToUrl(book.coverFileID)) || '';
  return '';
}

// =============================================
// 5. 头像 dataURL（个人资料头像走 DataURL，不上云）
// =============================================
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

async function profileAvatarUrl() {
  const p = profileSync();
  if (!p.avatarDataUrl) return null;
  return p.avatarDataUrl;
}

// =============================================
// 6. 图片工具（压缩）
// =============================================
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

function blobToImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image load failed'));
    img.src = url;
  });
}

// =============================================
// 7. 工具函数
// =============================================
function showToast(msg, duration = 1800) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { t.hidden = true; }, duration);
}

function todayStr() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function profileInitials(name) {
  const s = (name || '').trim();
  return s ? s[0] : '微';
}

// =============================================
// 8. 个人资料 chip + 编辑
// =============================================
async function renderProfileChip() {
  const p = await loadProfile();
  const avatarEl = document.getElementById('profile-avatar');
  const nameEl = document.getElementById('profile-name');
  if (!avatarEl || !nameEl) return;
  if (p.avatarDataUrl) {
    avatarEl.style.backgroundImage = `url(${p.avatarDataUrl})`;
    avatarEl.textContent = '';
  } else {
    avatarEl.style.backgroundImage = '';
    avatarEl.textContent = profileInitials(p.nickname);
  }
  nameEl.textContent = p.nickname;
}

function openProfileEditor() {
  const p = profileSync();
  const card = document.getElementById('modal-card');
  card.innerHTML = `
    <button class="modal-close" id="profile-close">×</button>
    <h2 class="form-title">个人资料</h2>
    <label class="avatar-picker" id="avatar-picker" style="${p.avatarDataUrl ? `background-image:url(${p.avatarDataUrl});` : ''}">
      <input type="file" accept="image/*">
      ${p.avatarDataUrl ? '' : `<span>${escapeHtml(profileInitials(p.nickname))}</span>`}
      <span class="hint">${p.avatarDataUrl ? '替换' : '上传头像'}</span>
    </label>
    <div class="field profile-modal-fields">
      <label>昵称</label>
      <input type="text" id="p-nickname" maxlength="20" placeholder="你的名字" value="${escapeHtml(p.nickname)}">
    </div>
    <div class="form-actions">
      <button type="button" class="btn btn-secondary" id="profile-cancel">取消</button>
      <button type="button" class="btn btn-primary" id="profile-save">保存</button>
    </div>
  `;

  let newAvatarDataUrl = p.avatarDataUrl || null;
  const avatarInput = card.querySelector('#avatar-picker input');
  card.querySelector('#avatar-picker').onclick = e => {
    if (e.target.tagName !== 'INPUT') avatarInput.click();
  };
  avatarInput.onchange = async ev => {
    const file = ev.target.files?.[0];
    if (!file) return;
    try {
      // 头像压缩到 200px / 0.85
      const blob = await compressImage(file);
      const url = URL.createObjectURL(blob);
      const img = new Image();
      await new Promise((r, j) => { img.onload = r; img.onerror = j; img.src = url; });
      const c = document.createElement('canvas');
      const longEdge = Math.max(img.width, img.height);
      const sc = longEdge > 200 ? 200 / longEdge : 1;
      c.width = Math.round(img.width * sc);
      c.height = Math.round(img.height * sc);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const out = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
      newAvatarDataUrl = await blobToDataUrl(out);
      const picker = document.getElementById('avatar-picker');
      picker.style.backgroundImage = `url(${newAvatarDataUrl})`;
      picker.querySelector('span:first-of-type')?.remove();
      picker.querySelector('.hint').textContent = '替换';
      URL.revokeObjectURL(url);
    } catch (err) {
      showToast('图片处理失败');
    }
  };

  document.getElementById('profile-close').onclick = closeProfile;
  document.getElementById('profile-cancel').onclick = closeProfile;
  document.getElementById('profile-save').onclick = async () => {
    const nickname = document.getElementById('p-nickname').value.trim() || '日子有微光';
    const saveBtn = document.getElementById('profile-save');
    saveBtn.disabled = true;
    try {
      await saveProfile({ nickname, avatarDataUrl: newAvatarDataUrl });
      await renderProfileChip();
      closeProfile();
      showToast('已保存');
    } catch (err) {
      showToast('保存失败：' + (err.message || err));
      saveBtn.disabled = false;
    }
  };

  document.getElementById('modal').hidden = false;
}

function closeProfile() {
  document.getElementById('modal').hidden = true;
}

// =============================================
// 9. 视图：书架
// =============================================
const filter = {
  month: 'all',
  fav: 'all',
  sort: 'newest',
  keyword: '',
  view: 'grid',
  tags: [],
};

async function renderShelf() {
  const top = document.getElementById('shelf-top');
  const grid = document.getElementById('shelf-grid');
  const empty = document.getElementById('shelf-empty');

  document.getElementById('filter-btn').hidden = false;
  document.getElementById('search-box').hidden = false;

  let books;
  try {
    books = await listBooks();
  } catch (err) {
    const dbg = document.createElement('div');
    dbg.id = '__debug_listbooks';
    dbg.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#c00;color:#fff;padding:8px;font-size:11px;z-index:99999;font-family:monospace;';
    dbg.textContent = '加载失败: ' + (err.message || String(err));
    document.body.appendChild(dbg);
    return;
  }

  const total = books.length;
  top.innerHTML = '';

  let filtered = books;
  if (filter.month !== 'all') {
    filtered = filtered.filter(b => (b.readDate || '').startsWith(filter.month));
  }
  if (filter.fav === 'fav') {
    filtered = filtered.filter(b => b.favorite);
  }
  if (filter.keyword) {
    const kw = filter.keyword.toLowerCase();
    filtered = filtered.filter(b =>
      (b.title || '').toLowerCase().includes(kw) ||
      (b.author || '').toLowerCase().includes(kw) ||
      (b.note || '').toLowerCase().includes(kw)
    );
  }
  if (filter.tags.length) {
    filtered = filtered.filter(b =>
      Array.isArray(b.tags) && filter.tags.every(t => b.tags.includes(t))
    );
  }
  filtered.sort((a, b) => {
    const cmp = (a.readDate || '').localeCompare(b.readDate || '');
    return filter.sort === 'newest' ? -cmp : cmp;
  });

  const listEl = document.getElementById('shelf-list');
  if (!listEl) {
    const el = document.createElement('div');
    el.id = 'shelf-list';
    document.getElementById('view-shelf').insertBefore(el, document.getElementById('fab-add'));
  }
  const list = document.getElementById('shelf-list');
  grid.style.display = filter.view === 'grid' ? '' : 'none';
  list.style.display = filter.view === 'list' ? '' : 'none';

  grid.innerHTML = '';
  list.innerHTML = '';

  if (books.length === 0) {
    empty.hidden = false;
    empty.innerHTML = '<p style="text-align:center;color:var(--text-2);margin-top:60px;">还没有记录<br>点 + 加第一本</p>';
    return;
  }
  if (filtered.length === 0) {
    empty.hidden = false;
    empty.innerHTML = filter.keyword
      ? `<p style="text-align:center;color:var(--text-2);margin-top:60px;">没找到包含「${escapeHtml(filter.keyword)}」的书</p>`
      : '<p style="text-align:center;color:var(--text-2);margin-top:60px;">当前筛选下没有书</p>';
    return;
  }
  empty.hidden = true;
  if (filter.view === 'grid') {
    const cards = await Promise.all(filtered.map(makeBookCard));
    cards.forEach(c => grid.appendChild(c));
  } else {
    const rows = await Promise.all(filtered.map(makeBookRow));
    rows.forEach(r => list.appendChild(r));
  }
}

function tagPillsHtml(book) {
  if (!Array.isArray(book.tags) || book.tags.length === 0) return '';
  return `<div class="tag-pills-row">${book.tags.map(t => `<span class="tag-pill-static">${escapeHtml(t)}</span>`).join('')}</div>`;
}

async function makeBookCard(book) {
  const card = document.createElement('div');
  card.className = 'book-card';
  const img = document.createElement('img');
  const coverSrc = await bookCoverUrl(book);
  if (coverSrc) img.src = coverSrc;
  card.appendChild(img);
  const info = document.createElement('div');
  info.className = 'book-info';
  info.innerHTML = `
    <div class="book-title">${escapeHtml(book.title || '')}</div>
    <div class="book-meta">${escapeHtml(book.author || "")}</div>
    <div class="book-meta">${book.readDate || ""}${book.favorite ? " · ❤️" : ""}</div>
    ${tagPillsHtml(book)}
  `;
  card.appendChild(info);
  card.onclick = () => openDetail(book._id);
  return card;
}

async function makeBookRow(book) {
  const row = document.createElement('div');
  row.className = 'book-row';
  const img = document.createElement('img');
  const coverSrc = await bookCoverUrl(book);
  if (coverSrc) img.src = coverSrc;
  row.appendChild(img);
  const info = document.createElement('div');
  info.className = 'info';
  const snippet = (book.note || '').replace(/\n/g, ' ').slice(0, 60);
  info.innerHTML = `
    <div class="title">${escapeHtml(book.title || '')}${book.favorite ? ' <span style="color:var(--accent);">❤️</span>' : ''}</div>
    <div class="meta">${escapeHtml(book.author || '')}${book.author ? ' · ' : ''}${book.readDate || ''}</div>
    ${snippet ? `<div class="snippet">${escapeHtml(snippet)}${(book.note || '').length > 60 ? '…' : ''}</div>` : ''}
    ${tagPillsHtml(book)}
  `;
  row.appendChild(info);
  row.onclick = () => openDetail(book._id);
  return row;
}

function openFilterSheet() {
  listBooks().then(books => {
    const months = [...new Set(books.map(b => (b.readDate || '').slice(0, 7)).filter(Boolean))].sort().reverse();
    const monthOptions = ['<button data-month="all"' + (filter.month === 'all' ? ' class="active"' : '') + '>全部</button>']
      .concat(months.map(m => `<button data-month="${m}"${filter.month === m ? ' class="active"' : ''}>${m}</button>`))
      .join('');

    const favOptions = [
      ['all', '全部'],
      ['fav', '只 ❤️'],
    ].map(([v, l]) => `<button data-fav="${v}"${filter.fav === v ? " class=\"active\"" : ""}>${l}</button>`).join("");

    const sortOptions = [
      ['newest', '最新优先'],
      ['oldest', '最早优先'],
    ].map(([v, l]) => `<button data-sort="${v}"${filter.sort === v ? " class=\"active\"" : ""}>${l}</button>`).join("");

    const viewOptions = [
      ['grid', '▦ 网格'],
      ['list', '☰ 列表'],
    ].map(([v, l]) => `<button data-view="${v}"${filter.view === v ? " class=\"active\"" : ""}>${l}</button>`).join("");

    const allTags = [...new Set(books.flatMap(b => Array.isArray(b.tags) ? b.tags : []))].sort();
    const tagOptions = (allTags.length === 0
      ? '<span style="color:var(--text-2);font-size:13px;">还没有任何标签</span>'
      : allTags.map(t => `<button data-tag="${escapeHtml(t)}"${filter.tags.includes(t) ? " class=\"active\"" : ""}>${escapeHtml(t)}</button>`).join('')
    ) + (filter.tags.length ? `<button data-tag-clear style="color:#c33;">清除</button>` : '');

    const sheet = document.createElement('div');
    sheet.className = 'sheet';
    sheet.id = 'filter-sheet';
    sheet.innerHTML = `
      <h3>月份</h3>
      <div class="sheet-options" id="sheet-month">${monthOptions}</div>
      <h3>喜好</h3>
      <div class="sheet-options" id="sheet-fav">${favOptions}</div>
      <h3>标签（多选）</h3>
      <div class="sheet-options" id="sheet-tag">${tagOptions}</div>
      <h3>排序</h3>
      <div class="sheet-options" id="sheet-sort">${sortOptions}</div>
      <h3>显示方式</h3>
      <div class="sheet-options" id="sheet-view">${viewOptions}</div>
      <button class="sheet-close" id="sheet-close">关闭</button>
    `;
    document.body.appendChild(sheet);

    function pick(group, key) {
      sheet.querySelector(`#sheet-${group}`).addEventListener('click', e => {
        const btn = e.target.closest("button");
        if (!btn) return;
        filter[key] = btn.dataset[key];
        sheet.querySelectorAll(`#sheet-${group} button`).forEach(b => b.classList.toggle('active', b === btn));
        renderShelf();
      });
    }
    pick('month', 'month');
    pick('fav', 'fav');
    pick('sort', 'sort');
    pick('view', 'view');

    sheet.querySelector('#sheet-tag').addEventListener('click', e => {
      const btn = e.target.closest('button');
      if (!btn) return;
      if (btn.dataset.tagClear !== undefined) {
        filter.tags = [];
      } else {
        const t = btn.dataset.tag;
        const i = filter.tags.indexOf(t);
        if (i >= 0) filter.tags.splice(i, 1);
        else filter.tags.push(t);
      }
      renderShelf();
      sheet.remove();
      openFilterSheet();
    });

    document.getElementById('sheet-close').onclick = () => sheet.remove();
  });
}

// =============================================
// 10. 视图：统计
// =============================================
async function renderStats() {
  const el = document.getElementById('view-stats');
  document.getElementById('topbar-title').textContent = '统计';
  document.getElementById('filter-btn').hidden = true;

  const books = await listBooks();
  if (books.length === 0) {
    el.innerHTML = '<p style="text-align:center;color:var(--text-2);margin-top:60px;">还没有数据</p>';
    return;
  }

  const total = books.length;
  const fav = books.filter(b => b.favorite).length;
  const dates = books.map(b => b.readDate).filter(Boolean).sort();
  const earliest = dates[0];
  const latest = dates[dates.length - 1];

  const byMonth = {};
  books.forEach(b => {
    const m = (b.readDate || '').slice(0, 7);
    if (m) byMonth[m] = (byMonth[m] || 0) + 1;
  });
  const monthEntries = Object.entries(byMonth).sort((a, b) => b[0].localeCompare(a[0]));
  const monthMax = Math.max(...monthEntries.map(([, c]) => c), 1);

  const monthBars = monthEntries.map(([m, c]) => `
    <div class="bar-row">
      <span class="label">${m}</span>
      <span class="bar"><div style="width:${(c / monthMax * 100).toFixed(0)}%;"></div></span>
      <span class="count">${c}</span>
    </div>
  `).join('');

  const today = new Date();
  const days = 365;
  const heatCounts = {};
  books.forEach(b => { if (b.readDate) heatCounts[b.readDate] = (heatCounts[b.readDate] || 0) + 1; });

  const cells = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const c = heatCounts[key] || 0;
    let cls = 'cell';
    if (c >= 3) cls += " l3";
    else if (c === 2) cls += " l2";
    else if (c === 1) cls += " l1";
    cells.push(`<div class="${cls}"></div>`);
  }

  const recent = [...books].sort((a, b) => (b.readDate || '').localeCompare(a.readDate || '')).slice(0, 5);
  const recentHtml = (await Promise.all(recent.map(async b => {
    const url = await bookCoverUrl(b);
    return `
      <div class="recent-item" data-id="${b._id}">
        <img src="${url || ''}">
        <div class="t">${escapeHtml(b.title || '')}</div>
      </div>
    `;
  }))).join("");

  el.innerHTML = `
    <div class="stats-card">
      <h3>总览</h3>
      <div class="stats-summary">
        累计 <strong>${total}</strong> 本 · ❤️ <strong>${fav}</strong> 本<br>
        最早 ${earliest} ~ 最近 ${latest}
      </div>
    </div>

    <div class="stats-card">
      <h3>按月统计</h3>
      ${monthBars}
      </div>

    <div class="stats-card">
      <h3>过去 365 天阅读热力</h3>
      <div class="heatmap">${cells.join("")}</div>
    </div>

    <div class="stats-card">
      <h3>最近 5 本</h3>
      <div class="recent-row">${recentHtml}</div>
    </div>
  `;

  el.querySelectorAll('.recent-item').forEach(item => {
    item.onclick = () => openDetail(item.dataset.id);
  });
}

// =============================================
// 11. 视图：设置
// =============================================
function renderSettings() {
  const el = document.getElementById('view-settings');
  document.getElementById('topbar-title').textContent = '我的';
  document.getElementById('filter-btn').hidden = true;

  el.innerHTML = `
    <div class="settings-list">
      <button class="settings-item" id="set-profile">
        <span class="label">个人资料（头像 / 昵称）</span>
        <span class="hint">编辑</span>
      </button>
      <button class="settings-item" id="set-export-pdf">
        <span class="label">导出 PDF（按日期/标签筛选）</span>
        <span class="hint">打印</span>
      </button>
      <button class="settings-item danger" id="set-clear">
        <span class="label">清空全部数据</span>
      </button>
    </div>
    <p class="about-text">
      日子有微光<br>
      云端同步 · 跨设备可用
    </p>
  `;

  document.getElementById('set-profile').onclick = openProfileEditor;
  document.getElementById('set-export-pdf').onclick = openExportPdfSheet;
  document.getElementById('set-clear').onclick = clearAllFlow;
}

async function clearAllFlow() {
  if (!confirm('确定清空全部数据吗？此操作不可撤销！')) return;
  try {
    await clearAll();
    showToast('已清空');
    renderShelf();
  } catch (err) {
    showToast('清空失败：' + (err.message || err));
  }
}

// =============================================
// 12. PDF 导出
// =============================================
async function openExportPdfSheet() {
  document.getElementById('filter-sheet')?.remove();
  const books = await listBooks();
  const months = [...new Set(books.map(b => (b.readDate || '').slice(0, 7)).filter(Boolean))].sort().reverse();
  const allTags = [...new Set(books.flatMap(b => Array.isArray(b.tags) ? b.tags : []))].sort();

  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.id = 'export-pdf-sheet';
  const monthOptions = ['<button data-pdf-month="all" class="active">全部</button>']
    .concat(months.map(m => `<button data-pdf-month="${m}">${m}</button>`))
    .join('');
  const tagOptions = allTags.length
    ? allTags.map(t => `<button data-pdf-tag="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join('')
    : '<span style="color:var(--text-2);font-size:13px;">还没有任何标签</span>';

  sheet.innerHTML = `
    <h3>导出 PDF</h3>
    <p style="font-size:13px;color:var(--text-2);margin:0 0 8px;">选好筛选条件后，点"打开打印页"即可在浏览器打印对话框里"另存为 PDF"。</p>
    <h3>月份</h3>
    <div class="sheet-options" id="pdf-month">${monthOptions}</div>
    <h3>标签（多选，可不选）</h3>
    <div class="sheet-options" id="pdf-tag">${tagOptions}</div>
    <div class="sheet-close-row">
      <button class="btn btn-secondary" id="pdf-cancel">取消</button>
      <button class="btn btn-primary" id="pdf-open">打开打印页</button>
    </div>
  `;
  document.body.appendChild(sheet);

  const sel = { month: 'all', tags: new Set() };
  sheet.querySelector('#pdf-month').addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    sel.month = btn.dataset.pdfMonth;
    sheet.querySelectorAll('#pdf-month button').forEach(b => b.classList.toggle('active', b === btn));
  });
  sheet.querySelector('#pdf-tag').addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const t = btn.dataset.pdfTag;
    if (sel.tags.has(t)) {
      sel.tags.delete(t);
      btn.classList.remove('active');
    } else {
      sel.tags.add(t);
      btn.classList.add('active');
    }
  });

  document.getElementById('pdf-cancel').onclick = () => sheet.remove();
  document.getElementById('pdf-open').onclick = async () => {
    let filtered = books;
    if (sel.month !== 'all') filtered = filtered.filter(b => (b.readDate || '').startsWith(sel.month));
    if (sel.tags.size) filtered = filtered.filter(b => Array.isArray(b.tags) && [...sel.tags].every(t => b.tags.includes(t)));
    sheet.remove();
    if (filtered.length === 0) { showToast('当前筛选下没有书'); return; }
    filtered.sort((a, b) => (a.readDate || '').localeCompare(b.readDate || ''));
    await openPdfPrintWindow(filtered, sel.month === 'all' ? '全部' : sel.month);
  };
}

async function openPdfPrintWindow(books, monthLabel) {
  const profile = await loadProfile();
  // 把每本书的封面转成 dataURL（pdf 新窗口里直接用 img）
  const enriched = await Promise.all(books.map(async b => {
    let coverUrl = '';
    if (b.coverFileID) {
      coverUrl = await fileIdToUrl(b.coverFileID) || '';
    }
    return { ...b, coverUrl };
  }));
  const html = buildPrintHtml(enriched, profile, monthLabel);
  const w = window.open('', '_blank');
  if (!w) { showToast('浏览器拦截了弹窗'); return; }
  w.document.open();
  w.document.write(html);
  w.document.close();
  w.addEventListener('load', () => {
    setTimeout(() => {
      try { w.focus(); w.print(); } catch {}
    }, 400);
  });
}

function buildPrintHtml(books, profile, monthLabel) {
  const title = `${profile.nickname || '日子有微光'} 的亲子阅读记录${monthLabel === '全部' ? '' : ' · ' + monthLabel}`;
  const now = new Date();
  const ymd = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  const avatarUrl = profile.avatarDataUrl || '';
  const sections = books.map(b => `
    <section class="book">
      <div class="cover"><img src="${b.coverUrl || ''}" alt=""></div>
      <div class="body">
        <h2>${escapeHtml(b.title || '')}</h2>
        <p class="meta">${escapeHtml(b.author || '')}${b.author ? ' · ' : ''}${escapeHtml(b.readDate || '')}${b.favorite ? ' · ❤️' : ''}</p>
        ${(b.tags && b.tags.length) ? `<p class="tags">${b.tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</p>` : ''}
        ${b.note ? `<p class="note">${escapeHtml(b.note).replace(/\n/g, '<br>')}</p>` : ''}
      </div>
    </section>
  `).join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)}</title>
<style>
  :root { --bg:#FAF8F3; --text:#2D2D2D; --text-2:#8A8A8A; --accent:#E89B5C; }
  * { box-sizing: border-box; }
  html, body { margin:0; background:var(--bg); color:var(--text);
    font-family:-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
    font-size:14px; line-height:1.7; }
  .container { max-width:720px; margin:0 auto; padding:40px 32px; }
  header.cover { text-align:center; padding:20px 0 40px; border-bottom:1px solid rgba(0,0,0,0.08); margin-bottom:32px; }
  header.cover .avatar { width:64px; height:64px; border-radius:50%; background:var(--accent); display:inline-flex; align-items:center; justify-content:center; color:#fff; font-size:22px; font-weight:600; margin-bottom:12px; background-size:cover; background-position:center; vertical-align:middle; }
  header.cover h1 { font-size:22px; margin:8px 0 4px; }
  header.cover .sub { color:var(--text-2); font-size:13px; }
  section.book { display:flex; gap:24px; padding:24px 0; border-bottom:1px dashed rgba(0,0,0,0.08); page-break-inside:avoid; break-inside:avoid; }
  section.book:last-child { border-bottom:none; }
  .cover img { width:120px; height:150px; object-fit:cover; border-radius:6px; background:#eee; display:block; }
  .body { flex:1; min-width:0; }
  .body h2 { font-size:18px; margin:0 0 6px; }
  .meta { color:var(--text-2); font-size:12px; margin:0 0 8px; }
  .tags { margin:6px 0 10px; }
  .tag { display:inline-block; background:rgba(232,155,92,0.15); color:var(--accent); border-radius:8px; padding:1px 8px; font-size:11px; margin-right:4px; }
  .note { margin:0; white-space:pre-wrap; word-break:break-word; }
  footer { text-align:center; color:var(--text-2); font-size:12px; padding:32px 0 0; margin-top:32px; border-top:1px solid rgba(0,0,0,0.06); }
  @media print {
    body { background:#fff; }
    .container { max-width:none; padding:16mm 14mm; }
    section.book { padding:8mm 0; }
    h1 { page-break-after:avoid; }
  }
</style>
</head>
<body>
  <div class="container">
    <header class="cover">
      ${avatarUrl ? `<span class="avatar" style="background-image:url(${avatarUrl});"></span>` : `<span class="avatar">${escapeHtml(profileInitials(profile.nickname))}</span>`}
      <h1>${escapeHtml(title)}</h1>
      <p class="sub">共 ${books.length} 本 · 生成于 ${ymd}</p>
    </header>
    ${sections}
    <footer>来自 ${escapeHtml(profile.nickname || '日子有微光')} · 日子有微光</footer>
  </div>
</body>
</html>`;
}

// =============================================
// 13. 视图：详情
// =============================================
async function openDetail(id) {
  const book = await getBook(id);
  if (!book) { showToast('记录不存在'); return; }
  const card = document.getElementById('modal-card');
  const coverUrl = await bookCoverUrl(book);
  card.innerHTML = `
    <button class="modal-close" id="detail-close">×</button>
    <img class="detail-cover" src="${coverUrl || ''}">
    <h2 class="detail-title">${escapeHtml(book.title || '')}</h2>
    <p class="detail-meta">${escapeHtml(book.author || "")}${book.author ? " · " : ""}${book.readDate || ""}${book.favorite ? " · ❤️" : ""}</p>
    ${tagPillsHtml(book)}
    ${book.note ? `<div class="detail-note">${escapeHtml(book.note).replace(/\n/g, "<br>")}</div>` : ""}
    <div class="detail-actions">
      <button class="btn btn-secondary" id="detail-share">分享海报</button>
      <button class="btn btn-secondary" id="detail-edit">编辑</button>
      <button class="btn btn-danger" id="detail-delete">删除</button>
    </div>
  `;
  document.getElementById('modal').hidden = false;

  document.getElementById('detail-close').onclick = closeDetail;
  document.getElementById('detail-delete').onclick = () => deleteBookFlow(book._id);
  document.getElementById('detail-edit').onclick = () => {
    closeDetail();
    openForm(book);
  };
  document.getElementById('detail-share').onclick = async () => {
    closeDetail();
    await openPoster(book);
  };
}

function closeDetail() {
  document.getElementById('modal').hidden = true;
}

async function deleteBookFlow(id) {
  if (!confirm('确定要删除这本书吗？此操作不可撤销。')) return;
  try {
    await deleteBook(id);
    closeDetail();
    renderShelf();
    showToast('已删除');
  } catch (err) {
    showToast('删除失败：' + (err.message || err));
  }
}

// =============================================
// 14. 海报
// =============================================
async function drawPoster(book) {
  const coverUrl = await bookCoverUrl(book);
  if (!coverUrl) return null;
  const c = document.createElement('canvas');
  c.width = POSTER_W;
  c.height = POSTER_H;
  const ctx = c.getContext('2d');

  ctx.fillStyle = '#FAF8F3';
  ctx.fillRect(0, 0, POSTER_W, POSTER_H);

  const coverH = Math.round(POSTER_H * 0.55);
  const coverMaxW = Math.round(POSTER_W * 0.85);
  const img = await new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('load failed'));
    im.src = coverUrl;
  });
  const cw0 = img.width, ch0 = img.height;
  const scale = Math.min(coverMaxW / cw0, coverH / ch0);
  const cw = Math.round(cw0 * scale);
  const ch = Math.round(ch0 * scale);
  const cx = (POSTER_W - cw) / 2;
  const cy = Math.round(POSTER_H * 0.05);
  roundRect(ctx, cx, cy, cw, ch, 32);
  ctx.clip();
  ctx.drawImage(img, cx, cy, cw, ch);
  ctx.restore();

  const textX = Math.round(POSTER_W * 0.08);
  let y = cy + ch + 64;

  ctx.fillStyle = '#2D2D2D';
  ctx.font = 'bold 56px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.textBaseline = 'top';
  const titleLines = wrapText(ctx, book.title || '', POSTER_W * 0.84, 2);
  titleLines.forEach(line => { ctx.fillText(line, textX, y); y += 68; });
  y += 12;

  ctx.fillStyle = '#8A8A8A';
  ctx.font = '28px -apple-system, "PingFang SC", sans-serif';
  const meta = [book.author, book.readDate].filter(Boolean).join('  ·  ');
  ctx.fillText(meta, textX, y);
  y += 50;

  if (book.note) {
    ctx.fillStyle = '#2D2D2D';
    ctx.font = '26px -apple-system, "PingFang SC", sans-serif';
    const noteLines = wrapText(ctx, book.note, POSTER_W * 0.84, 3);
    noteLines.forEach(line => { ctx.fillText(line, textX, y); y += 40; });
  }

  ctx.fillStyle = '#8A8A8A';
  ctx.font = '22px -apple-system, "PingFang SC", sans-serif';
  ctx.textAlign = 'center';
  const profile = profileSync();
  const nickname = profile.nickname || '日子有微光';
  ctx.fillText(`来自 ${nickname} 的日子有微光`, POSTER_W / 2, POSTER_H - 50);

  return c;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.save();
}

function wrapText(ctx, text, maxWidth, maxLines) {
  const chars = text.split('');
  const lines = [];
  let line = '';
  for (const ch of chars) {
    const test = line + ch;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = ch;
      if (lines.length >= maxLines) break;
    } else {
      line = test;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (lines.length === maxLines && (line || text.length > lines.join('').length)) {
    let last = lines[lines.length - 1];
    while (ctx.measureText(last + '…').width > maxWidth && last.length) last = last.slice(0, -1);
    lines[lines.length - 1] = last + '…';
  }
  return lines;
}

async function openPoster(book) {
  const layer = document.createElement('div');
  layer.className = 'poster-modal';
  const c = await drawPoster(book);
  if (!c) { showToast('封面加载失败'); return; }
  layer.innerHTML = `
    <button class="poster-close" style="position:absolute;top:20px;right:20px;background:none;border:none;color:#fff;font-size:32px;cursor:pointer;">×</button>
  `;
  layer.appendChild(c);
  const actions = document.createElement('div');
  actions.className = 'poster-actions';
  actions.innerHTML = `
    <button class="btn btn-secondary" id="poster-save">保存到相册</button>
    <button class="btn btn-primary" id="poster-close">关闭</button>
  `;
  layer.appendChild(actions);
  document.body.appendChild(layer);

  layer.querySelector('.poster-close').onclick = () => layer.remove();
  layer.querySelector('#poster-close').onclick = () => layer.remove();
  layer.querySelector('#poster-save').onclick = () => {
    c.toBlob(blob => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `绘本海报-${book.title || ''}-${book.readDate || ''}.jpg`;
      a.click();
      URL.revokeObjectURL(a.href);
      showToast('已保存');
    }, 'image/jpeg', 0.9);
  };
}

// =============================================
// 15. 视图：新增 / 编辑表单
// =============================================
let _editingBook = null;
let _formCoverFileID = null;
let _formTags = [];

function openForm(book = null) {
  _editingBook = book;
  _formCoverFileID = null;
  _formTags = [];
  const card = document.getElementById('modal-card');
  const isEdit = !!book;
  card.innerHTML = `
    <button class="modal-close" id="form-close">×</button>
    <h2 class="form-title">${isEdit ? "编辑" : "新增"}一本书</h2>
    <label class="cover-picker" id="cover-picker">
      <input type="file" accept="image/*" ${isEdit ? '' : 'capture="environment"'}>
      <span class="ph">点击拍照<br>或选图</span>
    </label>
    <div class="field">
      <label>书名 *</label>
      <input type="text" id="f-title" placeholder="必填">
    </div>
    <div class="field">
      <label>作者</label>
      <input type="text" id="f-author" placeholder="选填">
    </div>
    <div class="field">
      <label>阅读日期</label>
      <input type="date" id="f-date">
    </div>
    <div class="field">
      <label>笔记</label>
      <textarea id="f-note" rows="4" placeholder="孩子的反应、喜欢的句子、你的感想"></textarea>
    </div>
    <div class="field">
      <label>标签</label>
      <div class="tag-input-wrap">
        <div class="tag-pills" id="f-tag-pills"></div>
        <input type="text" id="f-tag-input" placeholder="输入后按回车或逗号">
      </div>
      <div class="tag-suggest" id="f-tag-suggest"></div>
    </div>
    <div class="field">
      <label class="field-row">
        <button type="button" class="fav-toggle" id="f-fav">🤍 加入喜欢</button>
      </label>
    </div>
    <div class="form-actions">
      <button type="button" class="btn btn-secondary" id="form-cancel">取消</button>
      <button type="button" class="btn btn-primary" id="form-save">保存</button>
    </div>
  `;

  const initialDate = book?.readDate || todayStr();
  document.getElementById('f-date').value = initialDate;
  if (book) {
    document.getElementById('f-title').value = book.title || '';
    document.getElementById('f-author').value = book.author || '';
    document.getElementById('f-note').value = book.note || '';
    if (Array.isArray(book.tags) && book.tags.length) {
      _formTags = book.tags.slice();
      renderFormTags();
    }
    if (book.favorite) toggleFav(true);
    if (book.coverFileID) {
      _formCoverFileID = book.coverFileID;
      // 异步加载预览
      (async () => {
        const url = await fileIdToUrl(book.coverFileID);
        if (url) showCoverPreview(url);
      })();
    }
  }

  document.getElementById('form-close').onclick = closeForm;
  document.getElementById('form-cancel').onclick = closeForm;
  document.getElementById('form-save').onclick = saveForm;
  document.querySelector('#cover-picker input').onchange = handleCoverChange;
  document.getElementById('f-fav').onclick = () => toggleFav();

  document.getElementById('f-title').addEventListener('input', updateSaveBtn);
  updateSaveBtn();

  const tagInput = document.getElementById('f-tag-input');
  const commitTags = (raw) => {
    raw.split(/[,,]/).forEach(t => {
      const tag = t.trim();
      if (tag && !_formTags.includes(tag)) _formTags.push(tag);
    });
    renderFormTags();
    tagInput.value = '';
  };
  tagInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commitTags(tagInput.value);
    } else if (e.key === 'Backspace' && !tagInput.value && _formTags.length) {
      _formTags.pop();
      renderFormTags();
    }
  });
  tagInput.addEventListener('blur', () => {
    if (tagInput.value.trim()) commitTags(tagInput.value);
  });

  renderTagSuggest();

  document.getElementById('modal').hidden = false;
}

function renderFormTags() {
  const wrap = document.getElementById('f-tag-pills');
  wrap.innerHTML = _formTags.map((t, i) =>
    `<span class="tag-pill">${escapeHtml(t)}<button type="button" class="tag-pill-x" data-i="${i}" aria-label="删除">×</button></span>`
  ).join('');
  wrap.querySelectorAll('.tag-pill-x').forEach(btn => {
    btn.onclick = () => {
      const i = Number(btn.dataset.i);
      _formTags.splice(i, 1);
      renderFormTags();
    };
  });
}

async function renderTagSuggest() {
  const wrap = document.getElementById('f-tag-suggest');
  if (!wrap) return;
  const books = await listBooks();
  const allTags = [...new Set(books.flatMap(b => Array.isArray(b.tags) ? b.tags : []))].sort();
  if (allTags.length === 0) {
    wrap.innerHTML = '';
    return;
  }
  wrap.innerHTML = '<span class="tag-suggest-label">已有：</span>' + allTags.map(t => {
    const picked = _formTags.includes(t);
    return `<button type="button" class="tag-suggest-btn${picked ? ' picked' : ''}" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</button>`;
  }).join('');
  wrap.querySelectorAll('.tag-suggest-btn').forEach(btn => {
    btn.onclick = () => {
      const t = btn.dataset.tag;
      const i = _formTags.indexOf(t);
      if (i >= 0) _formTags.splice(i, 1);
      else _formTags.push(t);
      renderFormTags();
      renderTagSuggest();
    };
  });
}

function closeForm() {
  document.getElementById('modal').hidden = true;
  _editingBook = null;
  _formCoverFileID = null;
  _formTags = [];
}

async function handleCoverChange(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    showCoverPreview(null, '上传中…');
    const compressed = await compressImage(file);
    const fid = await uploadBookCoverToCloud(compressed, `cover-${Date.now()}.jpg`);
    _formCoverFileID = fid;
    const previewUrl = await fileIdToUrl(fid);
    showCoverPreview(previewUrl);
  } catch (err) {
    showToast('上传失败：' + (err.message || err));
    const picker = document.getElementById('cover-picker');
    picker.classList.remove('has-cover');
    picker.querySelector('img')?.remove();
    const ph = document.createElement('span');
    ph.className = 'ph';
    ph.innerHTML = '点击拍照<br>或选图';
    picker.appendChild(ph);
  }
}

function showCoverPreview(url, loadingText) {
  const picker = document.getElementById('cover-picker');
  picker.classList.add('has-cover');
  picker.querySelector('.ph')?.remove();
  let img = picker.querySelector("img");
  if (!img) {
    img = document.createElement('img');
    picker.appendChild(img);
  }
  if (loadingText) {
    img.removeAttribute('src');
    img.alt = loadingText;
  } else if (url) {
    img.src = url;
  }
}

function toggleFav(force) {
  const btn = document.getElementById('f-fav');
  const isOn = force ?? btn.classList.contains('on');
  const next = !isOn;
  btn.classList.toggle('on', next);
  btn.textContent = next ? '❤️ 已喜欢' : '🤍 加入喜欢';
}

function updateSaveBtn() {
  const saveBtn = document.getElementById('form-save');
  const title = document.getElementById('f-title').value.trim();
  saveBtn.disabled = !title;
}

async function saveForm() {
  const title = document.getElementById('f-title').value.trim();
  const author = document.getElementById('f-author').value.trim();
  const readDate = document.getElementById('f-date').value;
  const note = document.getElementById('f-note').value.trim();
  const favorite = document.getElementById('f-fav').classList.contains('on');
  const tagInput = document.getElementById('f-tag-input');
  if (tagInput && tagInput.value.trim()) {
    tagInput.value.split(/[,,]/).forEach(t => {
      const tag = t.trim();
      if (tag && !_formTags.includes(tag)) _formTags.push(tag);
    });
  }
  const tags = _formTags.slice();

  if (!title) { showToast('书名必填'); return; }
  if (!_editingBook && !_formCoverFileID) { showToast('请上传封面'); return; }

  const coverFileID = _formCoverFileID || (_editingBook && _editingBook.coverFileID);
  const book = {
    title, author, readDate, note, favorite, tags, coverFileID,
  };
  if (_editingBook && _editingBook._id) book._id = _editingBook._id;

  try {
    const savedId = await putBook(book);
    console.log('[saveForm] saved id =', savedId);
    closeForm();
    renderShelf();
  } catch (err) {
    showToast('保存失败：' + (err.message || err));
    console.error('[saveForm] error:', err);
  }
}

// =============================================
// 16. 入口：DOMContentLoaded
// =============================================
document.addEventListener('DOMContentLoaded', async () => {
  // Tab 切换
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const name = btn.dataset.tab;
      document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.view').forEach(v => {
        v.classList.toggle('active', v.id === `view-${name}`);
      });
      if (name === 'shelf') renderShelf();
      if (name === 'stats') renderStats();
      if (name === 'settings') renderSettings();
    });
  });

  document.querySelector('.tab[data-tab="shelf"]').classList.add('active');
  document.getElementById('view-shelf').classList.add('active');

  document.getElementById('fab-add').onclick = () => openForm();
  document.getElementById('filter-btn').onclick = openFilterSheet;

  const searchInput = document.getElementById('search-input');
  let searchT;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchT);
    searchT = setTimeout(() => {
      filter.keyword = searchInput.value.trim();
      renderShelf();
    }, 150);
  });
  document.getElementById('search-clear').onclick = () => {
    searchInput.value = '';
    filter.keyword = '';
    renderShelf();
  };

  document.getElementById('profile-btn').onclick = openProfileEditor;

  // 初始化 CloudBase：登录 + 加载 profile
  const loader = document.getElementById('app-loader');
  const loaderText = loader.querySelector('.loader-text');
  try {
    loaderText.textContent = '连接云端…';
    await initCloud();
    await loadProfile();
    loader.hidden = true;
    document.getElementById('app').hidden = false;
    await renderProfileChip();
    // 首次渲染书架
    // 等 DOM 绑定完成后再异步触发
    // （先直接 await 渲染）
    renderShelf();
  } catch (err) {
    loaderText.innerHTML = (err.message || err).replace(/\n/g, '<br>');
    loader.style.color = '#c33';
    console.error('CloudBase init failed:', err);
  }
});