// Service Worker — RV Route Planner
// Caches app shell for offline use; network-first for API calls

const CACHE_NAME = 'rv-route-v1';
const APP_SHELL = [
    './',
    './index.html',
    './css/style.css',
    './js/config.js',
    './js/utils.js',
    './js/map.js',
    './js/geocoder.js',
    './js/router.js',
    './js/restrictions.js',
    './js/ui.js',
    './js/app.js',
    './manifest.json',
    './icons/icon-192.png',
    './icons/icon-512.png',
];

// Leaflet CDN assets to cache
const CDN_ASSETS = [
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            return cache.addAll(APP_SHELL).catch(err => {
                console.warn('SW: some app shell assets failed to cache:', err);
            });
        })
    );
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(
                keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
            )
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);

    // API calls — network only (don't cache routing/geocoding responses in SW)
    if (url.hostname.includes('openrouteservice.org') ||
        url.hostname.includes('googleapis.com') ||
        url.hostname.includes('overpass-api.de') ||
        url.hostname.includes('overpass.kumi.systems')) {
        return; // Let browser handle normally
    }

    // Tile requests — cache with network-first
    if (url.hostname.includes('tile.openstreetmap.org')) {
        event.respondWith(
            fetch(event.request).then(response => {
                const clone = response.clone();
                caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                return response;
            }).catch(() => caches.match(event.request))
        );
        return;
    }

    // App shell & CDN — cache-first, network fallback
    event.respondWith(
        caches.match(event.request).then(cached => {
            if (cached) return cached;
            return fetch(event.request).then(response => {
                // Cache CDN assets on first fetch
                if (CDN_ASSETS.some(a => event.request.url.includes(a))) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                }
                return response;
            });
        })
    );
});
