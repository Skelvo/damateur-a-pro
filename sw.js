// Service worker : réseau d'abord (toujours revérifié auprès du serveur), cache en secours hors ligne.
const C="dap-v53",IMG="dap-img-1",SHELL=["./","index.html","manifest.webmanifest","icon-192.png","icon-180.png","icon-512.png","logo-tribune.png","engine.js","app.js","app.css"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()))});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C&&x!==IMG).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
// logos des équipes, drapeaux et photos de profil : gardés sur le téléphone (plus rapide, moins de données), 500 au plus
let imgPuts=0;
async function trimImg(c){const k=await c.keys();for(let i=0;i<k.length-500;i++)await c.delete(k[i])}
function imgFetch(e,u){return caches.open(IMG).then(async c=>{const hit=await c.match(e.request.url);if(hit)return hit;
  const same=u.origin===location.origin;let r;try{r=await fetch(same?e.request:new Request(e.request.url,{mode:"cors",credentials:"omit"}))}catch(x){return fetch(e.request)}
  if(r&&r.ok&&r.type!=="opaque"){c.put(e.request.url,r.clone());if(++imgPuts%25===0)trimImg(c)}return r})}
self.addEventListener("fetch",e=>{const u=new URL(e.request.url);if(e.request.method!=="GET")return;
  if(e.request.destination==="image"&&(/(^|\.)espncdn\.com$/.test(u.hostname)||(u.origin===location.origin&&(u.pathname.startsWith("/logos/")||(u.pathname.includes("/api/")&&u.searchParams.has("avatar")&&u.searchParams.has("v")))))){e.respondWith(imgFetch(e,u));return}
  if(u.origin!==location.origin||u.pathname.includes("/api/"))return;
  const fresh=e.request.mode==="navigate"||/\.(html|txt|webmanifest)$/.test(u.pathname)||u.pathname.endsWith("/");
  const net=fetch(e.request,fresh?{cache:"no-cache"}:undefined).then(r=>{if(r.ok&&!u.pathname.endsWith("version.txt")){const cp=r.clone();caches.open(C).then(c=>c.put(e.request,cp))}return r});
  // ouverture de l'appli : si le réseau traîne plus de 2,5 s, on affiche la version déjà sur le téléphone
  if(e.request.mode==="navigate"){e.respondWith(new Promise(res=>{let done=false;const fin=r=>{if(!done&&r){done=true;res(r)}};
    const t=setTimeout(()=>caches.match(e.request).then(c=>c&&fin(c)),2500);
    net.then(r=>{clearTimeout(t);fin(r)}).catch(()=>caches.match(e.request).then(c=>c||caches.match("index.html")).then(c=>fin(c||Response.error())))}));return}
  e.respondWith(net.catch(()=>caches.match(e.request).then(r=>r||caches.match("index.html"))))});

// Notifications : affichage, et ouverture du bon écran quand on touche la notification
self.addEventListener("push",e=>{let d={};try{d=e.data?e.data.json():{}}catch(x){d={title:"Tribune",body:e.data&&e.data.text()}}
  e.waitUntil(self.registration.showNotification(d.title||"Tribune",{body:d.body||"",icon:"icon-180.png",badge:"icon-180.png",tag:d.tag||undefined,renotify:!!d.tag,data:{url:d.url||"./"}}))});
self.addEventListener("notificationclick",e=>{e.notification.close();const url=new URL((e.notification.data&&e.notification.data.url)||"./",self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({type:"window",includeUncontrolled:true}).then(cs=>{for(const c of cs){if("focus"in c){c.postMessage({go:url});return c.focus()}}return self.clients.openWindow(url)}))});
