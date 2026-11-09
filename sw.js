// Service worker : réseau d'abord (toujours revérifié auprès du serveur), cache en secours hors ligne.
const C="dap-v13",SHELL=["./","index.html","manifest.webmanifest","icon-192.png","icon-180.png","icon-512.png","logo-tribune.png","engine.js"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()))});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
self.addEventListener("fetch",e=>{const u=new URL(e.request.url);if(e.request.method!=="GET"||u.origin!==location.origin||u.pathname.includes("/api/"))return;
  const fresh=e.request.mode==="navigate"||/\.(html|txt|webmanifest)$/.test(u.pathname)||u.pathname.endsWith("/");
  e.respondWith(fetch(e.request,fresh?{cache:"no-cache"}:undefined).then(r=>{if(r.ok&&!u.pathname.endsWith("version.txt")){const cp=r.clone();caches.open(C).then(c=>c.put(e.request,cp))}return r})
    .catch(()=>caches.match(e.request).then(r=>r||caches.match("index.html"))))});

// Notifications : affichage, et ouverture du bon écran quand on touche la notification
self.addEventListener("push",e=>{let d={};try{d=e.data?e.data.json():{}}catch(x){d={title:"Tribune",body:e.data&&e.data.text()}}
  e.waitUntil(self.registration.showNotification(d.title||"Tribune",{body:d.body||"",icon:"icon-180.png",badge:"icon-180.png",tag:d.tag||undefined,renotify:!!d.tag,data:{url:d.url||"./"}}))});
self.addEventListener("notificationclick",e=>{e.notification.close();const url=new URL((e.notification.data&&e.notification.data.url)||"./",self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({type:"window",includeUncontrolled:true}).then(cs=>{for(const c of cs){if("focus"in c){c.postMessage({go:url});return c.focus()}}return self.clients.openWindow(url)}))});
