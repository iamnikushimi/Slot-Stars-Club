const CACHE='ssc-v1';
const PRECACHE=['/','manifest.json'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(PRECACHE))));
self.addEventListener('fetch',e=>{
  // Network first for API calls
  if(e.request.url.includes('/api/')) return;
  e.respondWith(fetch(e.request).catch(()=>caches.match(e.request)));
});
