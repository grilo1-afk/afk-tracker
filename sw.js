const CACHE_VERSION = "v9";
const CACHE_NAME = `afk-shell-${CACHE_VERSION}`;

const SHELL_FILES = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./auth.js",
  "./api.js",
  "./state.js",
  "./ui.js",
  "./supabase-client.js",
  "./presets.js",
  "./recurring.js",
  "./manifest.json",
  "./images/icons/icon-192.png",
  "./images/icons/icon-512.png",
  "./images/icons/icon-maskable-192.png",
  "./images/icons/icon-maskable-512.png",
  "./images/icons/apple-touch-icon.png",
  "./images/icons/favicon-32.png",
  "./images/icons/favicon-16.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name)),
      ),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Only ever intercept same-origin requests for the exact shell files
  // listed above. Everything else — Supabase calls, Google Fonts, anything
  // not in SHELL_FILES — falls straight through to the network untouched.
  if (url.origin !== self.location.origin) return;
  const path = "." + url.pathname;
  if (!SHELL_FILES.includes(path) && path !== "./") return;

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request)),
  );
});