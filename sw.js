/* 내 기프티콘함 — 오프라인에서도 열리도록 앱 껍데기를 캐시한다.
   사진·정보는 IndexedDB에 있고, 여기서는 화면 파일만 다룬다. */
const CACHE = 'gifticon-box-v1';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './ocr-date.js',
  './manifest.json',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];
const OCR_ASSET = /cdn\.jsdelivr\.net\/npm\/tesseract\.js(-core)?@/;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()).catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== CACHE + '-ocr').map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // OCR 도구(스크립트·WASM)는 한 번 받아두면 오프라인에서도 다시 쓸 수 있게
  if (OCR_ASSET.test(url.href)) {
    event.respondWith(
      caches.open(CACHE + '-ocr').then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
        return res;
      }).catch(() => fetch(req))
    );
    return;
  }

  if (url.origin !== location.origin) return;

  // 화면 파일은 항상 새 것을 먼저 시도하고, 오프라인이면 캐시로
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
  );
});
