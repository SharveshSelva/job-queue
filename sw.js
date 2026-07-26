/* Cache the shell so the app opens offline; always try network first for jobs.json. */
const SHELL = "queue-shell-v3";
const FILES = ["./", "./index.html", "./app.js", "./styles.css", "./manifest.json",
               "./icon-192.png", "./icon-512.png", "./icon-maskable-512.png", "./apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== SHELL).map(k => caches.delete(k)))
  ).then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;

  // jobs.json: stale-while-revalidate.
  // Serve the cached copy IMMEDIATELY so the app paints with zero network wait,
  // then refresh in the background for next time. Network-first meant staring at
  // a blank screen on a slow connection.
  if (url.pathname.endsWith("jobs.json")) {
    e.respondWith(
      caches.open(SHELL).then(async cache => {
        const cached = await cache.match(e.request);
        const network = fetch(e.request).then(res => {
          if (res && res.ok) cache.put(e.request, res.clone());
          return res;
        }).catch(() => null);
        return cached || network || new Response('{"jobs":[]}', {headers:{"Content-Type":"application/json"}});
      })
    );
    return;
  }

  // shell: cache first
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request)));
});
