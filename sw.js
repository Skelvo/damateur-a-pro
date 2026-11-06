// Service worker : réseau d'abord (toujours revérifié auprès du serveur), cache en secours hors ligne.
const C="dap-v3",SHELL=["./","index.html","manifest.webmanifest","icon.svg","icon-180.png","icon-512.png"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()))});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
self.addEventListener("fetch",e=>{const u=new URL(e.request.url);if(e.request.method!=="GET"||u.origin!==location.origin||u.pathname.includes("/api/"))return;
  const fresh=e.request.mode==="navigate"||/\.(html|txt|webmanifest)$/.test(u.pathname)||u.pathname.endsWith("/");
  e.respondWith(fetch(e.request,fresh?{cache:"no-cache"}:undefined).then(r=>{if(r.ok&&!u.pathname.endsWith("version.txt")){const cp=r.clone();caches.open(C).then(c=>c.put(e.request,cp))}return r})
    .catch(()=>caches.match(e.request).then(r=>r||caches.match("index.html"))))});
