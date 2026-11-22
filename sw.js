/* 收工三行 · Service Worker
 *
 * CACHE_VERSION：只有需要强制清空缓存时才 +1（日常改动靠 stale-while-revalidate 自动更新）。
 * 缓存范围：index.html / styles.css / app.js / manifest.webmanifest / 三个图标
 */

var CACHE_VERSION = 'v4-2026-11-22';
var CACHE_NAME = 'shougon-sanhang-' + CACHE_VERSION;
var ASSETS = [
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon-180.png'
];
var PAGE_URL = new URL('./index.html', self.location.href).href;

var OFFLINE_HTML = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<title>收工三行 · 离线</title>' +
  '<style>body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;' +
  'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;' +
  'color:#221f1a;background:#f4efe4;text-align:center;line-height:1.7}' +
  'h1{margin:0 0 8px;font-size:20px}p{margin:0;color:#5d5549;font-size:14px}</style></head>' +
  '<body><main><h1>现在无法打开「收工三行」</h1>' +
  '<p>网络断了，本机也还没有可用缓存。<br>连上网络后刷新一次即可。</p></main></body></html>';

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(ASSETS);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.map(function (name) {
        if (name !== CACHE_NAME && name.indexOf('shougon-sanhang-') === 0) {
          return caches.delete(name);
        }
        return null;
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;

  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // 导航：网络优先，失败回落到页面缓存，再不行给中文离线提示
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then(function (response) {
        return response;
      }).catch(function () {
        return caches.match(PAGE_URL, { ignoreSearch: true }).then(function (hit) {
          if (hit) return hit;
          return new Response(OFFLINE_HTML, {
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
          });
        });
      })
    );
    return;
  }

  // 静态资源：stale-while-revalidate
  event.respondWith(
    caches.match(request).then(function (hit) {
      var network = fetch(request).then(function (response) {
        if (response && response.status === 200 && response.type === 'basic') {
          var copy = response.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            cache.put(request, copy);
          });
        }
        return response;
      }).catch(function () {
        return hit;
      });

      return hit || network;
    })
  );
});
