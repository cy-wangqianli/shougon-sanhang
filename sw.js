/* 收工三行 · Service Worker
 *
 * 缓存版本：v1-2026-11-22
 * 更新方式：改动下面的 CACHE_VERSION 后重新部署；页面再打开一次即可换新缓存。
 * 缓存范围：index.html / styles.css / app.js / manifest.webmanifest
 */

var CACHE_VERSION = 'v1-2026-11-22';
var CACHE_NAME = 'shougon-sanhang-' + CACHE_VERSION;
var ASSETS = ['./index.html', './styles.css', './app.js', './manifest.webmanifest'];
var PAGE = './index.html';

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

  if (request.mode === 'navigate') {
    event.respondWith(
      caches.match(PAGE).then(function (hit) {
        return hit || fetch(request);
      })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(function (hit) {
      return hit || fetch(request);
    })
  );
});
