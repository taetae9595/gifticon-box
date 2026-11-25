/* ─────────────────────────────────────────────────────────────
   내 기프티콘함 — app.js
   사진과 정보는 이 브라우저(IndexedDB)에만 저장한다. 서버·로그인 없음.
   ───────────────────────────────────────────────────────────── */
'use strict';

const DB_NAME = 'gifticon-box';
const DB_VERSION = 1;
const STORE = 'gifticons';
const OCR_WORKER_PATH = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js';
const OCR_CORE_PATH = 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1';
const OCR_LANG_PATH = 'https://tessdata.projectnaptha.com/4.0.0';
const DAY = 86400000;

const $ = (id) => document.getElementById(id);

const state = {
  items: [],
  pending: [],
  queue: [],
  active: null,
  openId: null,
  undoItem: null
};

/* ───────── 저장소 ───────── */
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('expiry', 'expiry', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function dbAll() {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  }));
}

function dbPut(item) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(item);
    tx.oncomplete = () => resolve(item);
    tx.onerror = () => reject(tx.error);
  }));
}

function dbDelete(id) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

/* ───────── 날짜 도우미 ───────── */
function pad2(n) { return String(n).padStart(2, '0'); }
function ymd(date) { return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()); }
function todayDate() { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); }
function parseYmd(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return null;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return dt;
}
function daysLeft(expiry) {
  const d = parseYmd(expiry);
  if (!d) return null;
  return Math.round((d.getTime() - todayDate().getTime()) / DAY);
}
function dotted(expiry) {
  const d = parseYmd(expiry);
  if (!d) return '유효기간 없음';
  return d.getFullYear() + '.' + pad2(d.getMonth() + 1) + '.' + pad2(d.getDate());
}

function badgeOf(expiry) {
  const n = daysLeft(expiry);
  if (n === null) return { text: '날짜 없음', cls: 'dday-none' };
  if (n < 0) return { text: '만료', cls: 'dday-expired' };
  if (n === 0) return { text: 'D-Day', cls: 'dday-today' };
  if (n <= 7) return { text: 'D-' + n, cls: 'dday-soon' };
  return { text: 'D-' + n, cls: 'dday-ok' };
}

/* 정렬: 만료된 것 먼저(최근 만료 순) → 사용 가능한 것(유효기간 짧은 순) */
function sortedGroups() {
  const expired = [];
  const active = [];
  state.items.forEach((it) => {
    const n = daysLeft(it.expiry);
    (n !== null && n < 0 ? expired : active).push(it);
  });
  expired.sort((a, b) => (b.expiry || '').localeCompare(a.expiry || ''));
  active.sort((a, b) => (a.expiry || '9999-12-31').localeCompare(b.expiry || '9999-12-31'));
  return { expired, active };
}

/* ───────── 이미지 URL 캐시 ───────── */
const urlCache = new Map();
function imageUrl(item) {
  if (urlCache.has(item.id)) return urlCache.get(item.id);
  const u = URL.createObjectURL(item.blob);
  urlCache.set(item.id, u);
  return u;
}
function dropUrl(id) {
  const u = urlCache.get(id);
  if (u) { URL.revokeObjectURL(u); urlCache.delete(id); }
}

/* ───────── 화면 그리기 ───────── */
function render() {
  const { expired, active } = sortedGroups();
  const list = $('list');
  const empty = $('empty');

  Array.from(urlCache.keys()).forEach((id) => {
    if (!state.items.some((it) => it.id === id)) dropUrl(id);
  });

  list.textContent = '';

  if (!state.items.length) {
    empty.hidden = false;
    list.hidden = true;
  } else {
    empty.hidden = true;
    list.hidden = false;

    const frag = document.createDocumentFragment();
    if (expired.length) {
      frag.appendChild(groupLabel('만료됨 ' + expired.length, true));
      expired.forEach((it) => frag.appendChild(cardEl(it)));
    }
    if (active.length) {
      if (expired.length) frag.appendChild(groupLabel('사용 가능 ' + active.length, false));
      active.forEach((it) => frag.appendChild(cardEl(it)));
    }
    list.appendChild(frag);
  }

  $('appbar-sub').textContent = subText(expired, active);
}

function subText(expired, active) {
  if (!state.items.length) return '사진을 올리면 유효기간을 읽어서 정리해 드려요';
  const parts = [state.items.length + '개 보관 중'];
  if (expired.length) parts.push('만료 ' + expired.length + '개');
  if (active.length) {
    const first = active[0];
    const n = daysLeft(first.expiry);
    if (n === 0) parts.push('오늘 만료 1개');
    else if (n !== null && n <= 7) parts.push('가장 임박 ' + badgeOf(first.expiry).text);
  }
  return parts.join(' · ');
}

function groupLabel(text, isExpired) {
  const p = document.createElement('p');
  p.className = 'group-label' + (isExpired ? ' is-expired' : '');
  p.textContent = text;
  return p;
}

function cardEl(item) {
  const n = daysLeft(item.expiry);
  const badge = badgeOf(item.expiry);
  const card = document.createElement('article');
  card.className = 'card' + (n !== null && n < 0 ? ' is-expired' : '');
  card.dataset.id = item.id;

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'card-open';
  open.setAttribute('aria-label', (item.name || '기프티콘') + ' 확대 보기');

  const thumb = document.createElement('div');
  thumb.className = 'thumb';

  const img = document.createElement('img');
  img.src = imageUrl(item);
  img.alt = item.name || '기프티콘 사진';
  img.loading = 'lazy';
  img.decoding = 'async';
  thumb.appendChild(img);

  const dday = document.createElement('span');
  dday.className = 'dday ' + badge.cls;
  dday.textContent = badge.text;
  thumb.appendChild(dday);

  const body = document.createElement('div');
  body.className = 'card-body';

  const name = document.createElement('p');
  name.className = 'card-name' + (item.name ? '' : ' is-empty');
  name.textContent = item.name || '이름 없음';
  body.appendChild(name);

  const exp = document.createElement('p');
  exp.className = 'card-exp';
  exp.textContent = dotted(item.expiry) + '까지';
  if (n !== null && n < 0) exp.classList.add('is-expired');
  else if (n !== null && n <= 7) exp.classList.add('is-soon');
  body.appendChild(exp);

  open.appendChild(thumb);
  open.appendChild(body);
  open.addEventListener('click', () => openModal(item.id));

  const useBtn = document.createElement('button');
  useBtn.type = 'button';
  useBtn.className = 'card-use';
  useBtn.textContent = '사용완료';
  useBtn.setAttribute('aria-label', (item.name || '기프티콘') + ' 사용완료로 삭제');
  useBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    markUsed(item.id);
  });

  card.appendChild(open);
  card.appendChild(useBtn);
  return card;
}

/* ───────── 불러오기 ───────── */
async function loadItems() {
  try {
    state.items = await dbAll();
  } catch (err) {
    console.error(err);
    state.items = [];
    toast('저장된 목록을 읽지 못했어요');
  }
  render();
}

/* ───────── 모달(확대 보기) ───────── */
function openModal(id) {
  const item = state.items.find((it) => it.id === id);
  if (!item) return;
  state.openId = id;

  const n = daysLeft(item.expiry);
  const badge = badgeOf(item.expiry);

  $('modal-img').src = imageUrl(item);
  $('modal-img').alt = (item.name || '기프티콘') + ' 사진';
  $('modal-name').textContent = item.name || '기프티콘';
  $('modal-badge').textContent = badge.text;
  $('modal-badge').className = 'modal-badge' + (badge.cls === 'dday-today' ? ' is-today' : badge.cls === 'dday-soon' ? ' is-soon' : badge.cls === 'dday-expired' ? ' is-expired' : '');

  const dateLine = $('modal-date');
  dateLine.textContent = '';
  const span = document.createElement('span');
  span.className = 'modal-date-main';
  span.textContent = dotted(item.expiry) + '까지';
  if (n !== null && n < 0) span.classList.add('strong-expired');
  else if (n !== null && n <= 7) span.classList.add('strong-soon');
  dateLine.appendChild(span);
  if (n !== null) {
    const tail = document.createElement('span');
    tail.className = 'modal-date-tail';
    tail.textContent = n < 0 ? '  ·  ' + (-n) + '일 지났어요' : n === 0 ? '  ·  오늘이 마지막이에요' : '  ·  ' + n + '일 남았어요';
    dateLine.appendChild(tail);
  }

  $('modal-edit-panel').hidden = true;
  $('modal-info').hidden = false;
  $('modal').hidden = false;
  document.body.classList.add('locked');
}

function closeModal() {
  if ($('modal').hidden) return;
  $('modal').hidden = true;
  $('modal-img').removeAttribute('src');
  $('modal-edit-panel').hidden = true;
  $('modal-info').hidden = false;
  state.openId = null;
  document.body.classList.remove('locked');
}

function openEdit() {
  const item = state.items.find((it) => it.id === state.openId);
  if (!item) return;
  $('edit-name').value = item.name || '';
  $('edit-date').value = item.expiry || '';
  $('modal-info').hidden = true;
  $('modal-edit-panel').hidden = false;
  $('edit-date').focus();
}

async function saveEdit() {
  const item = state.items.find((it) => it.id === state.openId);
  if (!item) return;
  const dateVal = $('edit-date').value;
  if (!parseYmd(dateVal)) {
    toast('유효기간을 골라 주세요');
    return;
  }
  const updated = Object.assign({}, item, {
    name: $('edit-name').value.trim().slice(0, 60),
    expiry: dateVal
  });
  await dbPut(updated);
  state.items = state.items.map((it) => (it.id === updated.id ? updated : it));
  render();
  openModal(updated.id); // 정보 갱신해서 다시 그리기
  toast('수정했어요');
}

/* ───────── 사용완료(삭제) + 되돌리기 ───────── */
let undoTimer = null;

async function markUsed(id) {
  const item = state.items.find((it) => it.id === id);
  if (!item) return;
  await dbDelete(id);
  state.items = state.items.filter((it) => it.id !== id);
  dropUrl(id);
  if (state.openId === id) closeModal();
  render();
  showUndo(item);
}

function showUndo(item) {
  state.undoItem = item;
  $('toast-text').textContent = '사용완료로 지웠어요';
  $('toast-undo').hidden = false;
  $('toast').hidden = false;
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => {
    state.undoItem = null;
    $('toast').hidden = true;
  }, 6000);
}

async function undoDelete() {
  const item = state.undoItem;
  if (!item) return;
  state.undoItem = null;
  clearTimeout(undoTimer);
  $('toast').hidden = true;
  await dbPut(item);
  state.items.push(item);
  render();
  toast('되살렸어요');
}

let toastTimer = null;

function toast(msg) {
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $('toast').hidden = true;
    state.undoItem = null;
  }, 2400);
  $('toast-text').textContent = msg;
  $('toast-undo').hidden = true;
  $('toast').hidden = false;
}

/* ───────── 시트 열고 닫기 ───────── */
function openSheet(id) {
  $(id).hidden = false;
  document.body.classList.add('locked');
  if (id === 'sheet-menu') updateMenuStat();
}
function closeSheet(id) {
  $(id).hidden = true;
  if ($('sheet-add').hidden && $('sheet-menu').hidden) document.body.classList.remove('locked');
}

async function updateMenuStat() {
  const box = $('menu-stat');
  const count = state.items.length;
  const bytes = state.items.reduce((a, it) => a + (it.blob && it.blob.size ? it.blob.size : 0), 0);
  let size = '';
  if (bytes) size = ' · 사진 ' + formatBytes(bytes);
  box.textContent = count + '개 보관 중' + size + ' · 이 기기에만 저장됨';
}

function formatBytes(n) {
  if (n < 1024) return n + 'B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + 'KB';
  return (n / 1024 / 1024).toFixed(1) + 'MB';
}

/* ───────── 사진 추가 + OCR ───────── */
let ocrWorker = null;
let ocrLoading = null;

function ocrSupported() {
  return typeof window.Tesseract !== 'undefined' && !!window.Tesseract.createWorker;
}

function ocrNote(msg, isErr) {
  const n = $('ocr-note');
  if (!msg) { n.hidden = true; return; }
  n.hidden = false;
  n.textContent = msg;
  n.style.color = isErr ? '#e5484d' : '';
}

function waitForTesseract(ms) {
  return new Promise((resolve) => {
    const started = Date.now();
    (function tick() {
      if (ocrSupported()) return resolve(true);
      if (Date.now() - started > ms) return resolve(false);
      setTimeout(tick, 200);
    })();
  });
}

async function ensureWorker() {
  if (ocrWorker) return ocrWorker;
  if (ocrLoading) return ocrLoading;
  if (!ocrSupported()) {
    const ok = await waitForTesseract(20000);
    if (!ok) throw new Error('tesseract-missing');
  }

  ocrLoading = window.Tesseract.createWorker('kor', 1, {
    workerPath: OCR_WORKER_PATH,
    corePath: OCR_CORE_PATH,
    langPath: OCR_LANG_PATH,
    logger: (m) => {
      const entry = state.active;
      if (!entry) return;
      if (m.status === 'recognizing text') {
        entry.progress = Math.round((m.progress || 0) * 100);
        setStatus(entry, '유효기간 읽는 중… ' + entry.progress + '%', 'reading');
      } else if (typeof m.status === 'string' && m.status.indexOf('load') >= 0) {
        setStatus(entry, '인식기 준비 중… (처음 한 번만 걸려요)', 'reading');
      }
    }
  }).then((w) => { ocrWorker = w; return w; });

  ocrLoading = ocrLoading.then(
    (w) => { ocrLoading = null; return w; },
    (e) => { ocrLoading = null; throw e; }
  );
  return ocrLoading;
}

function uid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'g-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
}

function addFiles(fileList) {
  const files = Array.from(fileList || []).filter((f) => f && /^image\//.test(f.type || ''));
  if (!files.length) {
    toast('사진 파일을 골라 주세요');
    return;
  }
  files.forEach((file) => {
    const entry = {
      key: uid(),
      file: file,
      thumbUrl: URL.createObjectURL(file),
      name: '',
      expiry: '',
      autoDate: '',
      status: 'queued',
      progress: 0,
      note: '유효기간 읽을 준비 중…',
      text: ''
    };
    state.pending.push(entry);
    state.queue.push(entry);
  });
  renderPending();
  pumpQueue();
}

function renderPending() {
  const box = $('pending');
  box.textContent = '';
  state.pending.forEach((entry) => box.appendChild(pendingEl(entry)));
  $('btn-save').disabled = state.pending.length === 0;
  $('btn-save').textContent = state.pending.length
    ? '보관함에 담기' + (state.pending.length > 1 ? ' (' + state.pending.length + '장)' : '')
    : '보관함에 담기';
}

function pendingEl(entry) {
  const wrap = document.createElement('div');
  wrap.className = 'pitem';
  wrap.dataset.key = entry.key;

  const thumb = document.createElement('div');
  thumb.className = 'pthumb';
  const img = document.createElement('img');
  img.src = entry.thumbUrl;
  img.alt = '';
  thumb.appendChild(img);

  const fields = document.createElement('div');
  fields.className = 'pfields';

  const status = document.createElement('p');
  status.className = 'pstatus';
  status.dataset.role = 'status';
  fields.appendChild(status);

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'pinput';
  nameInput.placeholder = '상품명·메모 (선택)';
  nameInput.maxLength = 60;
  nameInput.value = entry.name;
  nameInput.addEventListener('input', () => { entry.name = nameInput.value; });
  fields.appendChild(nameInput);

  const dateRow = document.createElement('label');
  dateRow.className = 'pdate-row';
  const dateLabel = document.createElement('span');
  dateLabel.textContent = '유효기간';
  const dateInput = document.createElement('input');
  dateInput.type = 'date';
  dateInput.className = 'pinput';
  dateInput.dataset.role = 'date';
  dateInput.value = entry.expiry;
  dateInput.addEventListener('input', () => {
    entry.expiry = dateInput.value;
    if (entry.autoDate && entry.expiry !== entry.autoDate) {
      entry.note = '직접 고친 날짜로 저장해요';
    }
    dateInput.classList.toggle('missing', !entry.expiry);
    if (entry.expiry) setStatus(entry, entry.autoDate === entry.expiry ? '유효기간 ' + dotted(entry.expiry) + ' 로 읽었어요' : '유효기간 ' + dotted(entry.expiry), 'found');
  });
  dateRow.appendChild(dateLabel);
  dateRow.appendChild(dateInput);
  fields.appendChild(dateRow);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'premove';
  remove.setAttribute('aria-label', '이 사진 빼기');
  remove.textContent = '✕';
  remove.addEventListener('click', () => {
    removeEntry(entry);
  });

  wrap.appendChild(thumb);
  wrap.appendChild(fields);
  wrap.appendChild(remove);

  // 상태 표시(진행률 등)는 요소를 다시 만들지 않고 글자만 갈아 끼운다
  entry._el = { wrap: wrap, status: status, date: dateInput, note: entry.note };
  paintStatus(entry);
  return wrap;
}

function paintStatus(entry) {
  if (!entry._el || !entry._el.status) return;
  const s = entry._el.status;
  s.textContent = '';
  s.className = 'pstatus';

  if (entry.status === 'reading' || entry.status === 'queued') {
    const spin = document.createElement('span');
    spin.className = 'spin';
    s.appendChild(spin);
    s.appendChild(document.createTextNode(entry.note || '유효기간 읽는 중…'));
  } else if (entry.status === 'found') {
    s.textContent = '✓ ' + (entry.note || '');
    s.classList.add('found');
  } else if (entry.status === 'miss' || entry.status === 'error') {
    s.textContent = '! ' + (entry.note || '');
    s.classList.add(entry.status === 'error' ? 'err' : 'miss');
  } else {
    s.textContent = entry.note || '';
  }

  if (entry._el.date && entry.expiry) {
    entry._el.date.value = entry.expiry;
    entry._el.date.classList.remove('missing');
  }
}

function setStatus(entry, note, status) {
  entry.note = note;
  if (status) entry.status = status;
  paintStatus(entry);
}

function removeEntry(entry) {
  state.pending = state.pending.filter((e) => e.key !== entry.key);
  state.queue = state.queue.filter((e) => e.key !== entry.key);
  if (state.active === entry) state.active = null;
  if (entry._el && entry._el.wrap && entry._el.wrap.parentNode) entry._el.wrap.remove();
  URL.revokeObjectURL(entry.thumbUrl);
  $('btn-save').disabled = state.pending.length === 0;
  $('btn-save').textContent = '보관함에 담기' + (state.pending.length > 1 ? ' (' + state.pending.length + '장)' : '');
  if (!state.pending.length) $('pending').textContent = '';
}

async function pumpQueue() {
  if (state.active) return;
  const next = state.queue.shift();
  if (!next) return;
  if (state.pending.indexOf(next) < 0) { pumpQueue(); return; }

  state.active = next;
  setStatus(next, '유효기간 읽는 중…', 'reading');

  try {
    const worker = await ensureWorker();
    const prepared = await prepareForOcr(next.file);
    const result = await worker.recognize(prepared);
    const text = (result && result.data && result.data.text) || '';
    next.text = text;
    if (text) console.debug('[ocr]', text.replace(/\s+/g, ' ').slice(0, 400));
    const parsed = window.parseExpiry ? window.parseExpiry(text) : null;

    if (parsed) {
      next.autoDate = parsed.date;
      if (!next.expiry) next.expiry = parsed.date;
      const looksSure = parsed.source === 'keyword' || parsed.source === 'near';
      next.status = 'found';
      next.note = looksSure
        ? '유효기간 ' + dotted(parsed.date) + ' 로 읽었어요'
        : dotted(parsed.date) + ' 로 읽었어요 · 사진과 맞는지 봐 주세요';
    } else {
      next.status = 'miss';
      next.note = '날짜를 못 찾았어요. 유효기간을 직접 골라 주세요';
    }
  } catch (err) {
    console.warn('OCR 실패', err);
    next.status = 'error';
    next.note = '자동 인식이 안 됐어요. 유효기간을 직접 골라 주세요';
    if (err && err.message === 'tesseract-missing') {
      ocrNote('인터넷이 끊겨 자동 인식 도구를 못 불러왔어요. 유효기간은 직접 골라 주세요.', true);
    }
  } finally {
    state.active = null;
    paintStatus(next);
    pumpQueue();
  }
}

/* OCR용으로 긴 변 1600px까지만 줄여서 넘긴다(빠르고 정확) */
async function prepareForOcr(file) {
  try {
    const bmp = await createImageBitmap(file);
    const max = 1600;
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    return blob || file;
  } catch (e) {
    return file;
  }
}

/* 보관용으로 저장할 이미지(긴 변 2000px, JPEG 0.92) */
async function prepareForStore(file) {
  try {
    const bmp = await createImageBitmap(file);
    const max = 2000;
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size <= 2.5 * 1024 * 1024 && /image\/(jpeg|png|webp)/.test(file.type)) {
      if (bmp.close) bmp.close();
      return file;
    }
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.92));
    return blob || file;
  } catch (e) {
    return file;
  }
}

async function savePending() {
  if (!state.pending.length) return;
  const missing = state.pending.filter((e) => !parseYmd(e.expiry));
  const ready = state.pending.filter((e) => parseYmd(e.expiry));

  if (!ready.length) {
    missing.forEach((e) => { if (e._el && e._el.date) e._el.date.classList.add('missing'); });
    toast('유효기간을 먼저 골라 주세요');
    return;
  }

  $('btn-save').disabled = true;
  let saved = 0;
  for (const entry of ready) {
    try {
      const blob = await prepareForStore(entry.file);
      const item = {
        id: uid(),
        name: entry.name.trim().slice(0, 60),
        expiry: entry.expiry,
        createdAt: new Date().toISOString(),
        blob: blob
      };
      await dbPut(item);
      state.items.push(item);
      saved += 1;
      URL.revokeObjectURL(entry.thumbUrl);
      state.pending = state.pending.filter((e) => e.key !== entry.key);
    } catch (err) {
      console.error(err);
      toast('사진을 저장하지 못했어요. 저장 공간을 확인해 주세요');
      break;
    }
  }

  renderPending();
  render();

  if (state.pending.length) {
    toast(saved + '장 담았어요 · ' + state.pending.length + '장은 유효기간을 넣어 주세요');
  } else {
    closeSheet('sheet-add');
    $('pending').textContent = '';
    toast(saved + '장을 보관함에 담았어요');
  }
}

/* ───────── 백업 / 복원 ───────── */
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

async function dataUrlToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return await res.blob();
}

async function exportBackup() {
  if (!state.items.length) { toast('내보낼 기프티콘이 없어요'); return; }
  const { expired, active } = sortedGroups();
  const ordered = expired.concat(active);
  const items = [];
  for (const it of ordered) {
    items.push({
      name: it.name || '',
      expiry: it.expiry,
      createdAt: it.createdAt || null,
      image: await blobToDataUrl(it.blob)
    });
  }
  const payload = { app: 'gifticon-box', version: 1, exportedAt: new Date().toISOString(), count: items.length, items: items };
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = '기프티콘백업-' + ymd(new Date()) + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  closeSheet('sheet-menu');
  toast(items.length + '개를 백업 파일로 내보냈어요');
}

async function importBackup(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (e) {
    toast('백업 파일을 읽지 못했어요');
    return;
  }
  const list = Array.isArray(data) ? data : (data && Array.isArray(data.items) ? data.items : null);
  if (!list) { toast('기프티콘 백업 파일이 아니에요'); return; }

  let added = 0;
  let skipped = 0;
  for (const raw of list) {
    if (!raw || !parseYmd(raw.expiry) || !raw.image) { skipped += 1; continue; }
    try {
      const blob = await dataUrlToBlob(raw.image);
      await dbPut({
        id: uid(),
        name: String(raw.name || '').slice(0, 60),
        expiry: raw.expiry,
        createdAt: raw.createdAt || new Date().toISOString(),
        blob: blob
      });
      added += 1;
    } catch (e) {
      skipped += 1;
    }
  }
  await loadItems();
  closeSheet('sheet-menu');
  toast(added ? added + '개를 가져왔어요' + (skipped ? ' (' + skipped + '개는 건너뜀)' : '') : '가져올 기프티콘이 없었어요');
}

/* ───────── 이벤트 연결 ───────── */
function bind() {
  $('btn-add').addEventListener('click', () => openSheet('sheet-add'));
  $('empty-add').addEventListener('click', () => openSheet('sheet-add'));
  $('add-close').addEventListener('click', () => {
    if (state.pending.length && !confirm('담지 않은 사진이 있어요. 닫을까요?')) return;
    closeSheet('sheet-add');
  });
  $('sheet-add').addEventListener('click', (e) => {
    if (e.target === $('sheet-add')) {
      if (state.pending.length && !confirm('담지 않은 사진이 있어요. 닫을까요?')) return;
      closeSheet('sheet-add');
    }
  });

  $('file-input').addEventListener('change', (e) => {
    addFiles(e.target.files);
    e.target.value = '';
  });

  const dz = $('dropzone');
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => {
    e.preventDefault();
    dz.classList.add('drag');
  }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => {
    e.preventDefault();
    dz.classList.remove('drag');
    if (ev === 'drop' && e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
  }));

  $('btn-save').addEventListener('click', savePending);

  $('btn-menu').addEventListener('click', () => openSheet('sheet-menu'));
  $('menu-close').addEventListener('click', () => closeSheet('sheet-menu'));
  $('sheet-menu').addEventListener('click', (e) => { if (e.target === $('sheet-menu')) closeSheet('sheet-menu'); });
  $('btn-export').addEventListener('click', exportBackup);
  $('btn-import').addEventListener('click', () => $('import-input').click());
  $('import-input').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (f) importBackup(f);
  });

  $('modal-close').addEventListener('click', closeModal);
  $('btn-use').addEventListener('click', () => { if (state.openId) markUsed(state.openId); });
  $('modal-edit').addEventListener('click', openEdit);
  $('edit-cancel').addEventListener('click', () => {
    $('modal-edit-panel').hidden = true;
    $('modal-info').hidden = false;
  });
  $('edit-save').addEventListener('click', saveEdit);
  $('toast-undo').addEventListener('click', undoDelete);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('modal').hidden) { closeModal(); return; }
    if (!$('sheet-add').hidden) { closeSheet('sheet-add'); return; }
    if (!$('sheet-menu').hidden) closeSheet('sheet-menu');
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) render();
  });

  // 위치 이동 없이 하루가 바뀌었을 때 D-day 갱신
  setInterval(() => {
    if (!document.hidden) render();
  }, 60 * 1000);
}

/* ───────── 시작 ───────── */
async function init() {
  bind();
  await loadItems();

  if (!ocrSupported()) {
    setTimeout(() => {
      if (!ocrSupported()) ocrNote('자동 인식 도구를 불러오지 못했어요(인터넷 연결 확인). 유효기간은 직접 골라 주세요.', true);
    }, 4000);
  }

  if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', init);
