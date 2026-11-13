"use strict";
/* =====================================================================
   Tribune — paris sportifs gratuits (jetons fictifs)
   - Pro : matchs, scores et stats récupérés automatiquement (flux ESPN public)
   - Amateur : matchs ajoutés par un organisateur, ou matchs simulés
   - Cotes calculées par simulation Monte-Carlo de chaque match
   ===================================================================== */

/* ---------- utilitaires ---------- */
const $=(s,r=document)=>r.querySelector(s);
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const tok=n=>Math.round(n).toLocaleString("fr-FR");
const ymd=d=>{const x=new Date(d);return x.getFullYear()+String(x.getMonth()+1).padStart(2,"0")+String(x.getDate()).padStart(2,"0")};
const today=()=>ymd(Date.now());
function monday(t){const x=new Date(t);x.setHours(0,0,0,0);x.setDate(x.getDate()-(x.getDay()+6)%7);return x}
// formateurs de dates créés une seule fois (les recréer à chaque appel coûte cher sur les vieux téléphones)
const DFD=new Intl.DateTimeFormat("fr-FR",{weekday:"long",day:"numeric",month:"long"}),DFT=new Intl.DateTimeFormat("fr-FR",{hour:"2-digit",minute:"2-digit"}),DFS=new Intl.DateTimeFormat("fr-FR",{weekday:"short",day:"numeric",month:"short"});
const fDay=t=>{const s=DFD.format(new Date(t));return s[0].toUpperCase()+s.slice(1)};
const fTime=t=>DFT.format(new Date(t));
const fShort=t=>{const d=new Date(t);const dd=Math.round((new Date(t).setHours(0,0,0,0)-new Date().setHours(0,0,0,0))/DAY);
  return dd===0?"Aujourd’hui":dd===1?"Demain":dd===-1?"Hier":DFS.format(d)};
const ic=(id,cls="")=>`<svg class="i ${cls}"><use href="#i-${id}"/></svg>`;

/* ---------- référentiel sports / niveaux ---------- */

const DEPS={"Charente":["Cognac","Angoulême","Jarnac","Ruffec","La Couronne"],"Charente-Maritime":["Saintes","Rochefort","Royan","Jonzac","Aytré"],
  "Corrèze":["Tulle","Ussel","Objat","Malemort"],"Creuse":["Guéret","Aubusson","La Souterraine","Bourganeuf"],
  "Dordogne":["Périgueux","Bergerac","Sarlat","Ribérac","Trélissac"],"Gironde":["Libourne","Mérignac","Pessac","Langon","Blaye","Lormont","Cenon"],
  "Landes":["Dax","Mont-de-Marsan","Tarnos","Aire-sur-l’Adour","Saint-Paul-lès-Dax"],"Lot-et-Garonne":["Marmande","Villeneuve-sur-Lot","Nérac","Tonneins"],
  "Pyrénées-Atlantiques":["Anglet","Orthez","Oloron","Hendaye","Saint-Jean-de-Luz","Mauléon"],"Deux-Sèvres":["Niort","Bressuire","Parthenay","Thouars"],
  "Vienne":["Châtellerault","Loudun","Montmorillon","Buxerolles"],"Haute-Vienne":["Saint-Junien","Isle","Panazol","Couzeix"]};
const DEP=Object.keys(DEPS);
const NAT=["Rouen","Le Mans","Tours","Orléans","Dijon","Besançon","Reims","Amiens","Caen","Brest","Nancy","Metz","Grenoble","Annecy","Valence","Nîmes","Chambéry","Laval","Cholet","Bourges","Quimper","Vannes","Lorient","Troyes","Niort","Limoges","Poitiers","Angers","Avranches","Fréjus"];
const PFX={foot:["FC","US","AS","ES","SC","Stade","JS","AL","Entente","Olympique"],rugby:["RC","US","Stade","CA","SA","Avenir","Union","SC","AS","RO"]};
const FN=["Lucas","Hugo","Théo","Nathan","Louis","Jules","Arthur","Enzo","Léa","Chloé","Manon","Inès","Camille","Sarah","Jade","Emma","Tom","Noah","Paul","Zoé"];
const LN=["Martin","Bernard","Dubois","Lafitte","Etcheverry","Moreau","Laurent","Garcia","Darrigade","Fournier","Lambert","Bonnet","Lacoste","Durand","Mendiboure","Rousseau","Labat","Faure","Duprat","Castaing"];
const RK=[["NC","40","30/5","30/4","30/3"],["30/2","30/1","30","15/5","15/4"],["15/3","15/2","15/1","15","5/6"],["4/6","3/6","2/6","1/6","0"],["#740","#655","#590","#510","#455"],["#260","#215","#178","#146","#121"]];

/* ---------- état ---------- */
const LS="dap.v2";
let S=(()=>{try{const x=JSON.parse(localStorage.getItem(LS));if(x&&x.v===2)return x}catch(e){}return{v:2,name:"",bal:1000,peak:1000,bonus:"",bets:[],org:[],orgMode:false,sim:true,seen:0}})();
let GONE=false;   // compte supprimé : plus rien n’est réécrit sur le téléphone
const saveLocal=()=>{if(GONE)return;try{localStorage.setItem(LS,JSON.stringify(S))}catch(e){}};
const save=()=>{saveLocal();syncSoon()};
const U={lg:{code:"",data:null,err:null,loading:false,mode:"season",view:"rank"},tab:"m",sp:"all",lv:-1,dep:"",sel:[],combo:true,stake:20,open:null,dtab:"p",btab:"o"};
const REG=new Map(),FEED={};

/* ---------- fixtures simulées ---------- */
function simFixtures(sp,lv,mon){const key=`${sp}-${lv}-${ymd(mon)}`,r=rng(hash(key)),cfg=SP[sp],out=[],used=new Set();
  const n=sp==="tennis"?6:8,dep=lv<cfg.dep,pro=lv>=7&&sp!=="tennis";
  const pick=a=>a[Math.floor(r()*a.length)];
  for(let i=0;i<n;i++){let m={id:`${key}-${i}`,src:"sim",sp,lv,bo:3};
    const sat=new Date(mon);sat.setDate(sat.getDate()+5);
    if(sp==="tennis"){const day=r()<.5?0:1,h=[9,10,11,13,14,15,16,17][Math.floor(r()*8)];const t=new Date(sat);t.setDate(t.getDate()+day);t.setHours(h,r()<.5?0:30,0,0);m.t=+t;
      const p=()=>{let x;do{x=pick(FN)+" "+pick(LN)}while(used.has(x));used.add(x);return x};m.h=p();m.a=p();
      m.hs=pick(RK[lv]);m.as=pick(RK[lv]);m.dep=lv<cfg.dep?pick(DEP):"";m.comp=cfg.lv[lv]+(m.dep?" · "+m.dep:"")}
    else{const d=dep?pick(DEP):"";const pool=dep?DEPS[d]:pro?NAT:DEPS[pick(DEP)].concat(DEPS[pick(DEP)]);
      let town0="";const team=()=>{let x,t,tries=0;do{t=pick(pool);x=pick(PFX[sp])+" "+t;tries++}while((used.has(x)||t===town0)&&tries<30);used.add(x);town0=t;return x};
      m.h=team();m.a=team();m.dep=d;m.comp=cfg.lv[lv]+(d?" · "+d:"");
      const slots=sp==="rugby"?(lv>=8?[[5,14,30],[5,16,30],[5,18,30],[5,21,0],[6,14,30],[6,16,30]]:[[6,15,0],[6,15,0],[6,15,30],[5,18,0]])
        :(lv>=7?[[4,20,0],[5,15,0],[5,18,0],[5,20,0],[6,15,0],[6,17,0],[6,20,45]]:[[6,15,0],[6,15,0],[6,15,30],[5,18,0],[5,20,0],[6,13,0]]);
      const s=pick(slots),t=new Date(mon);t.setDate(t.getDate()+s[0]);t.setHours(s[1],s[2],0,0);m.t=+t}
    m.s=[strength(m.h,sp,lv),strength(m.a,sp,lv)];out.push(m)}
  return out}
function simWindow(sp,lv){const now=Date.now(),out=[];for(const w of [-1,0,1]){const mon=monday(now+w*7*DAY);
  for(const m of simFixtures(sp,lv,mon))if(m.t>now-5*DAY&&m.t<now+9*DAY)out.push(m)}return out}
function simById(id){const p=id.split("-");if(p.length<4)return null;const [sp,lv,d]=[p[0],+p[1],p[2]];
  const mon=new Date(+d.slice(0,4),+d.slice(4,6)-1,+d.slice(6,8));return simFixtures(sp,lv,mon).find(m=>m.id===id)||null}

/* ---------- flux live (pros) ---------- */
async function getJSON(u,ms=9000){const c=new AbortController(),t=setTimeout(()=>c.abort(),ms);try{const r=await fetch(u,{signal:c.signal,cache:"no-cache"});if(!r.ok)throw new Error(r.status);return await r.json()}finally{clearTimeout(t)}}
async function loadFeed(sp,lv){const paths=SP[sp].feeds[lv],key=sp+lv,now=Date.now();FEED[key]=FEED[key]||{ok:null,list:[]};
  const qs=sp==="tennis"?[`${ymd(now-4*DAY)}-${ymd(now+8*DAY)}`]:[...new Set([ymd(now-4*DAY).slice(0,6),ymd(now+8*DAY).slice(0,6),ymd(now+22*DAY).slice(0,6)])];
  try{const res=await Promise.all(paths.flatMap(p=>qs.map(q=>getJSON(`${ESPN}${p}/scoreboard?dates=${q}&limit=500`).then(j=>[p,j]))));
    const list=[],seen=new Set();for(const[p,j]of res)for(const ev of j.events||[]){if(seen.has(p+ev.id))continue;seen.add(p+ev.id);if(sp==="tennis")list.push(...parseTennis(ev,lv,p).filter(m=>!/^(TBD|TBA|Qualifier|Bye|\?)$/i.test(String(m.h).trim())&&!/^(TBD|TBA|Qualifier|Bye|\?)$/i.test(String(m.a).trim())));else{const m=parseTeamEvent(ev,sp,lv,p),tbd=x=>/^(TBD|TBA|\?)$/i.test(String(x||"").trim());if(m&&!tbd(m.h)&&!tbd(m.a)&&m.t>now-5*DAY&&m.t<now+22*DAY)list.push(m)}}
    FEED[key]={ok:true,list,at:now};feedSave();list.forEach(m=>{const old=REG.get(m.id);try{if(!old||!old._c)liveDiff(old,m)}catch(e){}if(old&&old.st&&m.st)for(const k in old.st)if(!(k in m.st))m.st[k]=old.st[k];REG.set(m.id,m)})}
  catch(e){const o=FEED[key];FEED[key]=o&&o.stale&&o.list.length?{...o,at:now}:{ok:false,list:[],at:now}}}
// matchs gardés sur le téléphone : à l'ouverture on affiche tout de suite les derniers connus, puis on les met à jour en fond
const FCACHE="dap-feed-1";
function feedSave(){if(!("caches"in window))return;clearTimeout(feedSave.t);feedSave.t=setTimeout(async()=>{try{const o={};
  for(const k in FEED){const f=FEED[k];if(f&&f.ok&&f.list.length)o[k]={at:f.at,list:f.list}}
  await (await caches.open(FCACHE)).put("./__feeds",new Response(JSON.stringify({v:1,o}),{headers:{"content-type":"application/json"}}))}catch(e){}},2500)}
async function feedLoadCache(){try{if(!("caches"in window))return false;const r=await (await caches.open(FCACHE)).match("./__feeds");if(!r)return false;
  const j=await r.json(),now=Date.now();let n=0;
  for(const k in j.o||{}){const f=j.o[k],cur=FEED[k];if(!f||!Array.isArray(f.list)||now-f.at>36*36e5||(cur&&(cur.ok!==null||cur.list.length)))continue;
    const list=f.list.filter(m=>m&&m.id&&m.t>now-5*DAY);list.forEach(m=>{m._c=1;if(!REG.has(m.id))REG.set(m.id,m)});FEED[k]={ok:true,list,at:f.at,stale:true};if(list.length)n++}
  return n>0}catch(e){return false}}
async function loadSport(sp){const jobs=Object.keys(SP[sp].feeds).filter(l=>!FEED[sp+l]||FEED[sp+l].stale).map(l=>loadFeed(sp,+l));if(!jobs.length)return;await Promise.all(jobs);
  if(sp===U.sp||U.sp==="all"){if(!U.open||U.open==="slip")render()}else renderSoon();settle()}
const idle=ms=>new Promise(ok=>"requestIdleCallback"in window?requestIdleCallback(()=>ok(),{timeout:ms}):setTimeout(ok,ms));
let FIRST=null;async function loadFeeds(){const f0=SP[U.sp]?U.sp:"foot";await (FIRST=loadSport(f0));await idle(U.sp==="all"?300:1500);for(const sp in SP)if(sp!==f0){await loadSport(sp);await idle(U.sp==="all"?200:800)}for(const sp in SP)if(sp!==f0)await warmSport(sp)}
// cotes des prochains matchs des autres sports calculées par petits paquets quand le téléphone ne fait rien : changer de sport devient instantané
async function warmSport(sp){const ms=matchesFor(sp,-1).filter(m=>["pre","live"].includes(status(m))).sort((a,b)=>a.t-b.t).slice(0,24);
  for(let i=0;i<ms.length;i+=2){await idle(400);if(document.hidden)return;for(const m of ms.slice(i,i+2))try{resMarket(m)}catch(e){}}}
// plusieurs mises à jour d'affilée = un seul affichage
let rsT=0;function renderSoon(ms=250){clearTimeout(rsT);rsT=setTimeout(()=>{if(!U.open||U.open==="slip")render()},ms)}
async function espnStats(m){ // complète les stats foot (cartons, corners…) et les compositions via le résumé du match
  if(m.sp!=="foot"||m.src!=="espn")return;if(m.state!=="in"&&m._sum===m.state)return;if(m.state==="in"&&m._sumAt&&Date.now()-m._sumAt<9e4)return;m._sum=m.state;m._sumAt=Date.now();
  try{applySummary(m,await getJSON(`${ESPN}${m.path}/summary?event=${m.eid}`))}
  catch(e){m._sum=0}}
async function loadLineup(m){if(m.sp!=="foot"||m.src!=="espn"||status(m)!=="pre"||m.t-Date.now()>100*6e4||(m.lineupAt&&Date.now()-m.lineupAt<4*6e4)||m._luBusy)return;
  m._luBusy=1;try{const j=await getJSON(`${ESPN}${m.path}/summary?event=${m.eid}`);readLineup(m,j);if(!m.lineup)m.lineupAt=Date.now()}catch(e){}finally{m._luBusy=0}}

/* ---------- paris sur les joueurs (buteur, doublé, carton) ----------
   Effectif + stats de la saison (buts, matchs, cartons) pour chaque équipe ; probabilité d'un joueur =
   part de ses buts dans ceux attendus de son équipe (d'après nos simulations), corrigée par son temps de jeu.
   Remboursé si le joueur ne joue pas. */
const SQ={};
// Une seule demande par équipe (gardée 6 h) ; renvoie true seulement quand l'effectif vient d'arriver.
function loadSquad(path,tid){const k=path+"|"+tid,c=SQ[k];if(c&&(c.p||Date.now()-c.at<6*H))return Promise.resolve(false);
  const e=SQ[k]={at:Date.now(),list:c&&c.list};
  return e.p=getJSON(`${ESPN}${path}/teams/${tid}/roster`).then(j=>{
    e.list=(j.athletes||[]).map(a=>{const st={};for(const c of ((a.statistics||{}).splits||{}).categories||[])for(const x of c.stats||[])st[x.name]=+x.value||0;
      return{id:String(a.id),name:a.displayName||a.shortName||"?",pos:((a.position||{}).abbreviation||"").slice(0,1),apps:st.appearances||0,sub:st.subIns||0,goals:st.totalGoals||0,yc:st.yellowCards||0,rc:st.redCards||0,hurt:(a.injuries||[]).length>0}});return true})
    .catch(()=>false).finally(()=>{e.p=null;e.at=Date.now()})}
const PRIOR={F:.34,M:.12,D:.04,G:0};
function playerOdds(m){if(m.sp!=="foot"||m.src!=="espn")return null;
  const sq=[m.hid,m.aid].map(t=>SQ[m.path+"|"+t]&&SQ[m.path+"|"+t].list);if(!sq[0]||!sq[1])return null;
  const key="P|"+m.id+"|"+(m.lineupAt||0);if(MKC.has(key))return MKC.get(key);
  const S_=sims(m),lam=[0,1].map(p=>{let t=0;for(let i=0;i<N;i++)t+=S_.g[p][i];return t/N});
  const out=[0,1].map(p=>{const stats=new Map(sq[p].map(x=>[x.id,x]));const lu=m.lineup&&m.lineup[p].length?m.lineup[p]:null;
    let pool=lu?lu.map(x=>({...(stats.get(x.id)||{apps:0,sub:0,goals:0,yc:0,rc:0}),id:x.id,name:x.name,pos:(x.pos||(stats.get(x.id)||{}).pos||"M").slice(0,1),starter:x.starter}))
      :sq[p].filter(x=>!x.hurt&&x.apps>0);
    const maxA=Math.max(1,...pool.map(x=>x.apps));
    pool=pool.filter(x=>x.pos!=="G").map(x=>{const mins=lu?(x.starter?1:.3):cl((x.apps-.6*x.sub)/maxA,.12,1),pr=PRIOR[x.pos]??.1;
      return{...x,mins,w:(x.goals+pr*3)/(x.apps+3)*mins,cr:cl((x.yc+x.rc+.18*3)/(x.apps+3),.03,.6)*mins}});
    const W=pool.reduce((a,x)=>a+x.w,0)||1;
    return pool.map(x=>{const xg=lam[p]*x.w/W,ps=1-Math.exp(-xg),p2=1-Math.exp(-xg)*(1+xg);
      return{id:x.id,name:x.name,pos:x.pos,o:{psc:podd(ps),p2:podd(p2),pyc:podd(x.cr)},p:ps}}).sort((a,b)=>b.p-a.p)});
  MKC.set(key,out);return out}
const podd=p=>p<.004?0:Math.round(cl(.88/p,1.15,80)*100)/100;
function playersBlock(m){if(m.sp!=="foot"||m.src!=="espn"||status(m)!=="pre")return"";
  const P=playerOdds(m);
  if(!P){const ks=[m.hid,m.aid].map(t=>SQ[m.path+"|"+t]);
    if(ks.every(e=>e&&!e.p)&&ks.some(e=>!e.list))return"";   // effectif indisponible pour ce match : pas de paris joueurs
    [m.hid,m.aid].forEach(t=>t&&loadSquad(m.path,t).then(ok=>{if(ok&&U.open===m.id)refreshLayer()}));
    return`<div class="grp">Joueurs</div><div class="skel" style="height:120px"></div>`}
  const side=U.pside||0,list=P[side].slice(0,U.pmore?40:10);
  return`<div class="grp">Joueurs</div><div class="mkt">
    <div class="seg" style="margin-bottom:8px"><button data-act="pside" data-v="0" aria-pressed="${side===0}">${esc(m.h)}</button><button data-act="pside" data-v="1" aria-pressed="${side===1}">${esc(m.a)}</button></div>
    <div class="phead"><span></span><span>Buteur</span><span>Doublé</span><span>Carton</span></div>
    ${list.map(x=>`<div class="prow2"><div><b>${esc(x.name)}</b><small>${{F:"Attaquant",M:"Milieu",D:"Défenseur"}[x.pos]||""}</small></div>
      ${["psc","p2","pyc"].map(mk=>{const o=x.o[mk],on=!!U.sel.find(s=>s.mid===m.id&&s.mk===mk&&s.k===x.id),tk=slotTaken(m.id,mk,null,x.id);
        return`<button class="odd sm${tk?" mine":""}" data-act="ppick" data-mid="${esc(m.id)}" data-mk="${mk}" data-pid="${esc(x.id)}" data-name="${esc(x.name)}" aria-pressed="${on}" ${o?"":"disabled"}><b>${o?fr(o):"—"}</b></button>`}).join("")}</div>`).join("")}
    ${P[side].length>10?`<button class="more" data-act="pmore">${U.pmore?"Moins de joueurs":"Tous les joueurs ("+P[side].length+")"}</button>`:""}
    <p class="note" style="margin:8px 0 0">${m.lineup?"Compositions officielles.":"Effectif de la saison : compositions officielles environ 1 h avant le match."} Si le joueur ne joue pas, le pari est remboursé. Carton : jaune ou rouge.</p></div>`}
function pickPlayer(mid,mk,pid,name){const m=findMatch(mid);if(!m||status(m)!=="pre")return;const P=playerOdds(m);if(!P)return;
  const x=P[0].concat(P[1]).find(y=>y.id===pid);if(!x||!x.o[mk])return;
  const i=U.sel.findIndex(s=>s.mid===mid&&s.mk===mk&&s.k===pid);if(i>=0){U.sel.splice(i,1);return}
  if(U.sel.length>=12){toast("12 sélections maximum par ticket.");return}
  U.sel.push({mid,mk,k:pid,line:null,o:x.o[mk],l:x.name+" : "+PMK[mk].t.toLowerCase(),mt:PMK[mk].t+(mk==="psc"?" (n’importe quand)":mk==="p2"?" (au moins 2 buts)":" (jaune ou rouge)"),
    ml:m.h+" – "+m.a,ic:PMK[mk].ic,cls:PMK[mk].cls,sp:m.sp,t:m.t,live:false,pl:x.name,snap:{path:m.path,sp:m.sp,lv:m.lv}});
  if(navigator.vibrate)try{navigator.vibrate(8)}catch(e){}}
async function espnRefetch(snap){ // match hors fenêtre : on va le rechercher à sa date
  try{const j=await getJSON(`${ESPN}${snap.path}/scoreboard?dates=${ymd(snap.t)}&limit=300`);
    for(const ev of j.events||[]){const ms=snap.sp==="tennis"?parseTennis(ev,snap.lv,snap.path):[parseTeamEvent(ev,snap.sp,snap.lv,snap.path)];
      for(const m of ms)if(m&&!REG.has(m.id))REG.set(m.id,m)}}catch(e){}}

// horloge ESPN en anglais → français (HT = mi-temps, FT = terminé, ET = prolongation…)
function frClock(c){c=String(c||"").trim();const M={HT:"Mi-temps",FT:"Terminé","FT-Pens":"Terminé (t.a.b.)",AET:"Terminé (a.p.)",ET:"Prolongation",Pens:"Tirs au but",Halftime:"Mi-temps","End of 1st Half":"Mi-temps","Full Time":"Terminé",Final:"Terminé",Delayed:"Retardé",Postponed:"Reporté",Suspended:"Suspendu",Abandoned:"Arrêté",Canceled:"Annulé",Scheduled:"À venir"};
  if(M[c])return M[c];return c.replace(/^(\d+)(st|nd|rd|th) Half$/i,(x,n)=>n==="1"?"1re mi-temps":"2e mi-temps").replace(/^End of (\d)(st|nd|rd|th) Quarter$/i,"Fin du $1e quart-temps").replace(/^(\d)(st|nd|rd|th) Quarter/i,"$1e quart-temps").replace(/^OT$/,"Prolongation").replace(/^(\d)(st|nd|rd|th)$/,(x,n)=>n==="1"?"1er set":n+"e set")}
function liveInfo(m){const el=(Date.now()-m.t)/6e4;
  if(m.src==="espn")return{sc:m.st&&(m.st.g||m.st.pts||m.st.sets),clock:frClock(m.clock)};
  const o=simOne(m);
  if(m.sp==="foot"){const mn=el<=47?Math.max(1,Math.floor(el)):el<62?"MT":Math.min(90,Math.floor(el-15));const cur=mn==="MT"?45:mn;
    return{sc:o._min.map(a=>a.filter(x=>x<=cur).length),clock:mn==="MT"?"Mi-temps":mn+"’"}}
  const f=cl(el/SP[m.sp].dur,0,1);
  if(m.sp==="rugby")return{sc:o.pts.map(v=>Math.round(v*f)),clock:el<42?Math.floor(el)+"’":el<57?"Mi-temps":Math.min(80,Math.floor(el-17))+"’"};
  return{sc:null,clock:"Set "+Math.min((o.sets[0]+o.sets[1]),1+Math.floor(f*(o.sets[0]+o.sets[1])))}}
function finalScore(m){const st=realStats(m);if(!st)return null;return st.g||st.pts||st.sets||null}

/* ---------- liste des matchs affichés ---------- */
function matchesFor(sp,lv){const cfg=SP[sp],out=[],levels=lv<0?cfg.lv.map((_,i)=>i):[lv];
  for(const l of levels){const f=cfg.feeds[l]&&FEED[sp+l];
    if(cfg.feeds[l]&&f&&f.ok)out.push(...f.list);
  }
  out.forEach(m=>{if(!REG.has(m.id))REG.set(m.id,m)});
  return out.map(m=>REG.get(m.id)||m).sort((a,b)=>a.t-b.t)}
const loadingPro=(sp,lv)=>{const cfg=SP[sp];return(lv<0?Object.keys(cfg.feeds):[lv]).some(l=>cfg.feeds[l]&&(!FEED[sp+l]||FEED[sp+l].ok===null))};
function findMatch(id,snap){let m=REG.get(id);if(m)return m;
  if(id.startsWith("o-"))return S.org.find(x=>x.id===id)||null;
  if(id.startsWith("a-"))return null;
  if(!id.startsWith("e-")){m=simById(id);if(m){REG.set(id,m);return m}}
  return null}

/* ---------- visuels : écussons ---------- */
const PAL=["#e63946","#1d4ed8","#16a34a","#f59e0b","#7c3aed","#0ea5e9","#111827","#f8fafc","#be123c","#065f46","#ea580c","#facc15","#0f766e","#9333ea","#334155","#dc2626"];
const lum=h=>{const n=parseInt(h.slice(1),16);return(.299*(n>>16)+.587*(n>>8&255)+.114*(n&255))/255};
function initials(name,sp){const w=name.replace(/[’']/g," ").split(/[\s-]+/).filter(Boolean);
  if(sp==="tennis")return(w[0][0]+(w[w.length-1]||"")[0]).toUpperCase();
  const pf=PFX.foot.concat(PFX.rugby);const core=w.filter(x=>!pf.includes(x)&&!/^(de|du|la|le|les|lès|sur|l|d)$/i.test(x));
  const p=w.find(x=>pf.includes(x));return((p&&p.length<=3?p[0]:"")+(core.map(x=>x[0]).join("")||w[0].slice(0,2))).slice(0,3).toUpperCase()}
// logos : corrections des trous ou erreurs du flux ESPN (même club sous un autre identifiant, faux drapeau…)
// clubs sans logo chez ESPN (rugby, Coupe de France amateur) : logos hébergés dans l’app (dossier logos/, source TheSportsDB)
const LOGO_FIX={"Siroco Les Abymes":"logos/siroco-les-abymes.png","Abymes":"logos/siroco-les-abymes.png","Oly Cayenne":"logos/olympique-de-cayenne.png","Olympique De Cayenne":"logos/olympique-de-cayenne.png","AS Etoile Matoury":"logos/etoile-matoury.png","Etoile Matoury":"logos/etoile-matoury.png","Chambéry Savoie":"logos/chambery-sf.png","Neuvillette-Jamin":"logos/la-neuvillette-jamin.png","Jamin":"logos/la-neuvillette-jamin.png","La Roche-sur-Yon":"logos/la-roche-sur-yon.png","La Roche":"logos/la-roche-sur-yon.png","Balagne":"logos/balagne.png","Le Puy":"logos/le-puy-en-velay.png","Pauloise":"logos/saint-pauloise.png","Saint-Pauloise FC":"logos/saint-pauloise.png","La Tamponnaise":"logos/la-tamponnaise.png","Tourcoing":"logos/tourcoing.png","CA Boulay":"logos/boulay.png","Boulay":"logos/boulay.png","CRUSSOL":"logos/rhone-crussol.png","Rhone Crussol Foot":"logos/rhone-crussol.png","Fréjus":"logos/frejus-saint-raphael.png","Hauts Lyonnais":"logos/hauts-lyonnais.png","Choisy":"logos/choisy-au-bac.png","Choisy Au Bac":"logos/choisy-au-bac.png","Fontenay Foot":"logos/vendee-fontenay-foot.png","Firminy":"logos/firminy.png","Thaon":"logos/thaon.png","ES Thaon":"logos/thaon.png","Vertou":"logos/vertou.png","Saint Sebastien":"logos/saint-sebastien.png","Sebastien":"logos/saint-sebastien.png","Pouliguen":"logos/la-baule-le-pouliguen.png","La Baule-Le Pouliguen":"logos/la-baule-le-pouliguen.png","Tinteniac St Domineuc":"logos/tinteniac-saint-domineuc.png","Tinteniac":"logos/tinteniac-saint-domineuc.png","Koetzingue":"logos/koetzingue.png","Biesheim":"logos/biesheim.png","Amneville":"logos/cso-amneville.png","Sundhoffen":"logos/sundhoffen.png","Asptt":"logos/asptt-dijon.png","Asptt Dijon":"logos/asptt-dijon.png","Selongey":"logos/is-selongey.png","Contres":"logos/contres.png","Cournon":"logos/cournon-d-auvergne.png","Chassieu Declines FC":"logos/chassieu-decines.png","Chassieu":"logos/chassieu-decines.png","Riviera":"logos/riviera.png","GSI Pontivy":"logos/gsi-pontivy.png","Le Touquet":"logos/le-touquet.png","Touquet":"logos/le-touquet.png","Avranches":"logos/avranches.png","US Feurs":"logos/feurs.png","Feurs":"logos/feurs.png","Racing Besan":"logos/racing-besancon.png","Racing Besancon":"logos/racing-besancon.png","Rouen":"logos/rouen.png","Stade Béthunois":"logos/stade-bethunois.png","Béthunois":"logos/stade-bethunois.png","Oberlauterbach":"logos/oberlauterbach-eberbach.png","Villefranche":"logos/villefranche-beaujolais.png","Vesoul":"logos/vesoul.png","Vitré":"logos/vitre.png","Balma":"logos/balma.png","Castanet":"logos/castanet.png","Avenir Foot Lozere":"logos/avenir-foot-lozere.png","Avenir Foot":"logos/avenir-foot-lozere.png","Boulazac":"logos/boulazac.png","Anglet Genet":"logos/genets-anglet.png","Anglet Genets":"logos/genets-anglet.png","Bressuire":"logos/bressuire.png","Challans":"logos/challans.png","FC Challans":"logos/challans.png","Angoulême":"logos/angouleme-charente.png","Montluçon":"logos/montlucon.png","Montlucon Football":"logos/montlucon.png","Chauny":"logos/chauny.png","Le Pays Du Valois":"logos/le-pays-du-valois.png","Valois":"logos/le-pays-du-valois.png","Claira":"logos/claira-saint-laurent.png","Claira / St Laurent":"logos/claira-saint-laurent.png","Puissalicon":"logos/puissalicon-magalas.png","Puissalicon Magalas":"logos/puissalicon-magalas.png","Buxerolles":"logos/buxerolles.png","ES Buxerolles":"logos/buxerolles.png","Sablé FC":"logos/sable.png","Lannion":"logos/lannion.png","Macaire":"logos/saint-andre-saint-macaire.png","St Andre St Macaire":"logos/saint-andre-saint-macaire.png","Nueillaubiers":"logos/nueillaubiers.png","Stade Bordelais":"logos/stade-bordelais.png","Rontignon":"logos/mazeres-uzos-rontignon.png","Mazeres Uzos Rontignon":"logos/mazeres-uzos-rontignon.png","Thionville":"logos/thionville-lusitanos.png","Chateaubrian":"logos/voltigeurs-de-chateaubriant.png","Chateaubriant":"logos/voltigeurs-de-chateaubriant.png","Horizon Patho":"logos/horizon-patho.png","Patho":"logos/horizon-patho.png","Chatou":"logos/chatou.png","Les Ulis":"logos/les-ulis.png","ESAP Metz":"logos/esap-metz.png","Metz":"logos/esap-metz.png","Reipertswiller":"logos/reipertswiller.png","Reiperts":"logos/reipertswiller.png","Massay":"logos/massay.png","Montlouis":"logos/montlouis.png","Montigny":"logos/montigny-les-metz.png","Montigny-Les-Metz":"logos/montigny-les-metz.png","Pontarlier":"logos/pontarlier.png","Montreuil FC":"logos/montreuil.png","Montreuil":"logos/montreuil.png","Loon Plage":"logos/loon-plage.png","Loon Plage FC":"logos/loon-plage.png","Neslois":"logos/pays-neslois.png","Furiani":"logos/furiani-agliani.png","Furiani-Agliani":"logos/furiani-agliani.png","Charleville":"logos/olympique-charleville-prix-am.png","Olympique Charleville Prix AM":"logos/olympique-charleville-prix-am.png","Olympique Marcquois":"logos/olympique-marcquois.png","Oly Marcquois":"logos/olympique-marcquois.png","Paris13":"logos/paris-13-atletico.png","Paris 13 Atletico":"logos/paris-13-atletico.png","Racing Chambery":"logos/racing-club-de-chambery.png","Chamois":"logos/chamois-niortais-saint-flo.png","Chamois Niortais FC":"logos/chamois-niortais-saint-flo.png","Riom":"logos/riom.png","RIOM":"logos/riom.png","FC Limonest":"logos/limonest-saint-didier.png","Limonest":"logos/limonest-saint-didier.png","Rives 82":"logos/2-rives-82.png","Rives":"logos/2-rives-82.png","Trélissac":"logos/trelissac.png","Trelissac FC":"logos/trelissac.png","Papus":"logos/juventus-de-papus.png","Juventus Papus":"logos/juventus-de-papus.png","Cestas":"logos/sag-cestas.png","Sag Cestas":"logos/sag-cestas.png","Saint-Die Kellermann":"logos/saint-die-kellermann.png","Kellermann":"logos/saint-die-kellermann.png","Saint-Renan":"logos/saint-renan.png","Renan":"logos/saint-renan.png","Sedan":"logos/sedan.png","Bourges Foot":"logos/bourges-foot-18.png","Senlis":"logos/senlis.png","Seyssinet":"logos/seyssinet.png","St Martin Tatinghem":"logos/saint-martin-lez-tatinghem.png","Tatinghem":"logos/saint-martin-lez-tatinghem.png","Racing Club de France":"logos/racing-club-de-france.png","Racing CF":"logos/racing-club-de-france.png","Castel":"logos/stade-castelbourgeois.png","Stade Castelbourgeois":"logos/stade-castelbourgeois.png","Talange":"logos/talange.png","Baume-Les-Dames":"logos/baume-les-dames.png","Baume":"logos/baume-les-dames.png","Tremblay":"logos/tremblay.png","Maisons":"logos/maisons-alfort.png","Maisons-Alfort":"logos/maisons-alfort.png","SC Toulon":"logos/toulon.png","Val Yerres":"logos/val-yerres-crosne.png","Val Yerres Crosne":"logos/val-yerres-crosne.png","Épinal":"logos/epinal.png","Veauche":"logos/veauche.png","St Paul en Jarez":"logos/saint-paul-en-jarez.png","Jarez":"logos/saint-paul-en-jarez.png","Verson":"logos/verson.png","Violaines":"logos/violaines.png","Vermelles":"logos/vermelles.png","Louannec":"logos/perros-louannec.png","Perros-Louannec":"logos/perros-louannec.png","USF Fecamp":"logos/fecamp.png","Fécamp":"logos/fecamp.png","Paillade":"logos/montpellier-atlas-paillade.png","Atlas Paillade":"logos/montpellier-atlas-paillade.png","Cannes":"logos/cannes.png","AS Cannes":"logos/cannes.png","Rumilly Vallières":"logos/rumilly-vallieres.png","Rumilly":"logos/rumilly-vallieres.png","Perpignan":"logos/usa-perpignan.png","Section Paloise":"logos/section-paloise.png","Bristol Rugby":"logos/bristol-bears.png","Bayonne":"logos/aviron-bayonnais.png"};
function fixLogo(name,logo){const n=String(name||"").trim();
  if(logo&&/\/countries\/500\/usa\.png/.test(logo)&&n!=="États-Unis")logo=null;   // ESPN met le drapeau américain à Perpignan
  return logo||LOGO_FIX[n]||null}   // le logo ESPN d'abord, le nôtre seulement s'il manque
// image qui ne charge pas : un 2e essai par le serveur d'images réduites d'ESPN, puis l'écusson dessiné
// logos ESPN : version réduite (96 px, ~5 Ko au lieu de ~60 Ko) ; l'original seulement si elle ne charge pas
const smallLogo=u=>u&&/^https:\/\/a\.espncdn\.com\/i\//.test(u)?"https://a.espncdn.com/combiner/i?img="+encodeURIComponent(u.replace("https://a.espncdn.com",""))+"&w=96&h=96":u;
function crestErr(img){if(!img.isConnected)return;img.style.visibility="hidden";const n=+(img.dataset.retry||0),src=img.getAttribute("src")||"";
  if(n<3){img.dataset.retry=n+1;const orig=img.dataset.orig||(img.dataset.orig=src),small=smallLogo(orig);
    // 1er essai : tout de suite l'autre version (originale ou réduite) ; puis l'original, avec une pause
    const alt=src===small&&small!==orig?orig:small;
    setTimeout(()=>{if(img.isConnected)img.src=n===0?alt:orig+(orig.includes("?")?"&":"?")+"r="+n},n===0?0:1200*n);return}
  if(img.parentNode)img.outerHTML=img.dataset.fb}
function crest(name,sp,logo,flag,raw){if(!raw)logo=fixLogo(name,logo);
  if(logo)return`<img class="crest" src="${esc(smallLogo(logo))}" data-orig="${esc(logo)}" alt="" referrerpolicy="no-referrer" data-fb="${esc(crest(name,sp,null,flag,1))}" onerror="crestErr(this)" onload="this.style.visibility=''">`;
  if(sp==="tennis"&&flag)return`<span class="crest tflag"><img src="${esc(smallLogo(flag))}" alt="" decoding="async" referrerpolicy="no-referrer" data-fb="${esc(crest(name,sp,null,null,1))}" onerror="this.parentNode.outerHTML=this.dataset.fb"></span>`;
  const h=hash(name),c1=PAL[h%16];let c2=PAL[(h>>5)%16];if(c2===c1)c2=PAL[(h%16+5)%16];
  const ini=esc(initials(name,sp)),tx=lum(c1)>.6?"#111":"#fff",id="c"+h.toString(36);
  if(sp==="tennis")return`<svg class="crest" viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="22" fill="${c1}"/><circle cx="24" cy="24" r="22" fill="none" stroke="${c2}" stroke-width="3"/>
    <text x="24" y="30" text-anchor="middle" font-family="Barlow Condensed,sans-serif" font-weight="800" font-size="18" fill="${tx}">${ini}</text>
    ${flag?`<image href="${esc(flag)}" x="30" y="30" width="16" height="16" clip-path="circle(8px)"/>`:""}</svg>`;
  const pat=(h>>9)%5,P=[``,`<path d="M14 0v48M24 0v48M34 0v48" stroke="${c2}" stroke-width="5"/>`,`<rect x="24" width="24" height="48" fill="${c2}"/>`,
    `<path d="M-4 10L44 46" stroke="${c2}" stroke-width="9"/>`,`<path d="M0 17h48M0 29h48" stroke="${c2}" stroke-width="5"/>`][pat];
  return`<svg class="crest" viewBox="0 0 48 48" aria-hidden="true"><defs><clipPath id="${id}"><path d="M6 5h36v16c0 13-9 20-18 24C15 41 6 34 6 21z"/></clipPath></defs>
    <g clip-path="url(#${id})"><rect width="48" height="48" fill="${c1}"/>${P}<rect x="6" y="5" width="36" height="12" fill="#00000030"/></g>
    <path d="M6 5h36v16c0 13-9 20-18 24C15 41 6 34 6 21z" fill="none" stroke="#ffffffcc" stroke-width="2"/>
    <text x="24" y="15" text-anchor="middle" font-family="Barlow Condensed,sans-serif" font-weight="800" font-size="${ini.length>2?9:10.5}" fill="#fff" letter-spacing=".5">${ini}</text>
    <circle cx="24" cy="29" r="6.5" fill="#ffffffe6"/><use href="#i-${SP[sp].ic}" x="18.5" y="23.5" width="11" height="11" style="stroke:#111;fill:none;stroke-width:1.8"/></svg>`}
const crestOf=(m,p)=>crest(p?m.a:m.h,m.sp,p?m.al:m.hl,p?m.af:m.hf);
function fieldSvg(sp){
  if(sp==="foot")return`<svg class="field" viewBox="0 0 400 220" preserveAspectRatio="none" fill="none" stroke="currentColor" stroke-width="2"><rect x="10" y="10" width="380" height="200"/><path d="M200 10v200"/><circle cx="200" cy="110" r="34"/><rect x="10" y="55" width="55" height="110"/><rect x="335" y="55" width="55" height="110"/><rect x="10" y="85" width="20" height="50"/><rect x="370" y="85" width="20" height="50"/></svg>`;
  if(sp==="rugby")return`<svg class="field" viewBox="0 0 400 220" preserveAspectRatio="none" fill="none" stroke="currentColor" stroke-width="2"><rect x="10" y="10" width="380" height="200"/><path d="M40 10v200M360 10v200M110 10v200M290 10v200M200 10v200"/><path d="M150 10v200M250 10v200" stroke-dasharray="8 8"/><path d="M40 95v30M360 95v30" stroke-width="5"/></svg>`;
  return`<svg class="field" viewBox="0 0 400 220" preserveAspectRatio="none" fill="none" stroke="currentColor" stroke-width="2"><rect x="20" y="20" width="360" height="180"/><path d="M20 42h360M20 178h360M110 42v136M290 42v136M110 110h180M200 20v180" /></svg>`}

/* ---------- rendu : matchs ---------- */
function selOf(mid,mk,k){return U.sel.find(s=>s.mid===mid&&s.mk===mk&&s.k===k)}
// plusieurs tickets par match, mais un seul pari par « case » (résultat, nombre de buts 2,5, buteur X…) : jamais deux paris contradictoires
const slotKey=(mk,line,k)=>mk+"|"+(line??"")+(PMK[mk]?"|"+k:"");
function myBet(mid){for(let i=S.bets.length-1;i>=0;i--){const b=S.bets[i];if(b.st!=="void"&&b.legs.some(L=>L.mid===mid))return b}return null}
function myBets(mid){return S.bets.filter(b=>b.st!=="void"&&b.legs.some(L=>L.mid===mid))}
// le pari déjà posé sur cette case de ce match (s'il y en a un)
function slotTaken(mid,mk,line,k){const key=slotKey(mk,line,k);for(let i=S.bets.length-1;i>=0;i--){const b=S.bets[i];if(b.st==="void")continue;
  const L=b.legs.find(L=>L.mid===mid&&slotKey(L.mk,L.line,L.k)===key);if(L)return{b,L}}return null}
// choix opposé déjà parié (ex. victoire Turquie alors qu'on a déjà parié Belgique) : seul cas refusé
function oppTaken(mid,mk,line,k){const t=slotTaken(mid,mk,line,k);return t&&String(t.L.k)!==String(k)?t:null}
function oddBtn(m,mk,k,s,short){const tk=slotTaken(m.id,mk.id,mk.line,k);if(tk&&String(tk.L.k)!==String(k))return`<button class="odd taken" data-act="mybet" data-mid="${esc(m.id)}" data-bid="${esc(tk.b.id)}">
    <span>${esc(short??s.l)}</span><b>${s.o?fr(s.o):"—"}</b></button>`;const mineCls=tk?" mine":"";
  const on=!!selOf(m.id,mk.id,k),st=status(m);
  let hit="";const rs=realStats(m);if(rs){const w=outcome(mk.d,m,rs,mk.line);if(w===k)hit=" hit"}
  return`<button class="odd${hit}${mineCls}" data-act="pick" data-mid="${esc(m.id)}" data-mk="${mk.id}" data-k="${k}" aria-pressed="${on}" ${!canBet(m)||!s.o?"disabled":""}>
    <span>${esc(short??s.l)}</span><b>${s.o?fr(s.o):"—"}</b></button>`}
// match commencé d'après l'horaire, mais sans direct (ESPN ne suit pas ce match en temps réel) : minute estimée
function ghostLive(m){if(!m||m.src!=="espn"||m.state!=="pre")return null;const e=(Date.now()-m.t)/6e4;if(e<1)return null;
  const end=(SP[m.sp]?SP[m.sp].dur:105)+25;if(e>end)return{t:"⏳ Match sans doute fini, résultat attendu",done:1};
  if(m.sp==="foot")return{t:e<=47?`⏱️ En cours · ~${Math.floor(e)}’`:e<=62?"⏱️ Mi-temps (estimée)":`⏱️ En cours · ~${Math.min(90,Math.floor(e-17))}’${e-17>90?"+":""}`};
  if(m.sp==="rugby")return{t:e<=42?`⏱️ En cours · ~${Math.floor(e)}’`:e<=57?"⏱️ Mi-temps (estimée)":`⏱️ En cours · ~${Math.min(80,Math.floor(e-15))}’`};
  return{t:"⏱️ En cours"}}
function mid(m){const st=status(m),gl=ghostLive(m);
  if(gl)return`<div class="mid"><div class="ko">${gl.done?"—":"⏱️"}</div><small class="live-t">${esc(gl.t.replace(/^⏱️ |^⏳ /,""))}</small>${gl.done?"":`<small class="nolive">Score en direct indisponible</small>`}</div>`;
  if(st==="pre")return`<div class="mid"><div class="ko">${fTime(m.t)}</div><small>${fShort(m.t)}</small></div>`;
  if(st==="live"){const L=liveInfo(m);return`<div class="mid">${L.sc?`<div class="score">${L.sc[0]}–${L.sc[1]}</div>`:`<div class="ko">—</div>`}<small class="live-t">${esc(L.clock)}</small></div>`}
  if(st==="cancel")return`<div class="mid"><div class="ko">—</div><small>Reporté</small></div>`;
  if(st==="wait")return`<div class="mid"><div class="ko">—</div><small>Score attendu</small></div>`;
  const sc=finalScore(m);return`<div class="mid"><div class="score">${sc?sc[0]+"–"+sc[1]:"—"}</div><small>Terminé</small></div>`}
// ---- chaîne télé (France) : règles simples + chaînes posées par les organisateurs (prioritaires) ----
let TVO={},tvAt=0;async function loadTv(){if(Date.now()-tvAt<15*6e4)return;tvAt=Date.now();try{const j=await api("tv_list",{});TVO=j.tv||{};if(!U.open)renderSoon()}catch(e){tvAt=0}}
const tvOf=m=>tvFor(m,TVO);
function tvChip(m,big){const ch=tvOf(m);if(!ch)return"";const C=TVCH[ch]||{},live=status(m)==="live"||!!ghostLive(m)&&!ghostLive(m).done;
  return`<button class="tvc${live?" on":""}${big?" big":""}" data-act="tv" data-ch="${esc(ch)}" aria-label="Regarder sur ${esc(ch)}">📺 ${esc(ch)}${live?" · EN DIRECT":C.free===1?"":" · payant"}</button>`}
// nombre de joueurs qui ont parié sur chaque match (accueil), rafraîchi toutes les 2 minutes au plus
let CCN={},ccAt=0,ccBusy=0;function crowdCounts(){if(ccBusy||Date.now()-ccAt<12e4)return;const mids=[...REG.values()].filter(m=>m.t>Date.now()-4*36e5&&m.t<Date.now()+9*864e5).map(m=>m.id).slice(0,300);if(!mids.length)return;
  ccBusy=1;api("crowd_counts",{mids}).then(j=>{CCN=j.n||{};ccAt=Date.now();if(U.tab==="m"&&!U.open)renderSoon()}).catch(()=>{}).finally(()=>{ccBusy=0})}
function crowdLine(m){const n=CCN[m.id]||0;return n?`<div class="ccn">👥 <b>${n}</b> joueur${n>1?"s ont":" a"} parié sur ce match</div>`:""}
function srcChip(m){return m.src==="espn"?`<span class="chip feed">Réel</span>`:m.src==="am"?`<span class="chip org">Réel · joueurs</span>`:m.src==="org"?`<span class="chip org">Organisateur</span>`:`<span class="chip">Simulation</span>`}
function card(m,showLv){const st=status(m),res=resMarket(m),defs=marketInfo(m);
  const nm=defs.length-1,icons=[...new Set(defs.slice(1).map(d=>d.ic+"|"+(d.cls||"")))].slice(0,4);
  const short=m.sp==="tennis"||m.sp==="basket"?["1","2"]:["1","N","2"];
  const fl=FLASH[m.id]&&Date.now()-FLASH[m.id].at<9e4?FLASH[m.id]:null;
  const mbs=myBets(m.id),mb=mbs[0];
  return`<article class="mc${fl?" mcflash":""}${mb?" mcbet":""}" data-act="open" data-mid="${esc(m.id)}" tabindex="0">${mb?`<span class="mcbetc">🎟️ ${mbs.length>1?mbs.length+" tickets":"Parié"+(mb.legs.length>1?" · combiné":"")}</span>`:""}${fl?`<span class="mcfl">${{g:"⚽ BUT !",og:"⚽ CSC !",yc:"🟨 Carton",rc:"🟥 Rouge",try:"🏉 Essai !",try7:"🏉 Essai !",pen:"🎯 Pénalité",conv:"🎯 Transfo",pts:"🏉 Points"}[fl.k]||"⚽"}</span>`:""}
    <div class="mc-top">${U.sp==="all"&&U.tab==="m"?`<span class="chip sptag sp-${m.sp}">${SPTAG[m.sp]||""}</span>`:""}${st==="live"?`<span class="chip live">Direct${liveOK(m)?" · paris ouverts":""}</span>`:""}${U.sp==="all"?"":srcChip(m)}<span class="comp">${esc(showLv?m.comp:(m.dep||m.comp))}</span>${tvChip(m)}</div>
    <div class="teams"><div class="tm">${crestOf(m,0)}<b>${esc(m.h)}</b>${m.hs?`<small>${esc(m.hs)}</small>`:""}</div>${mid(m)}<div class="tm">${crestOf(m,1)}<b>${esc(m.a)}</b>${m.as?`<small>${esc(m.as)}</small>`:""}</div></div>
    ${res?`<div class="pbar">${res.sels.map(s=>`<i style="width:${(s.p*100).toFixed(1)}%"></i>`).join("")}</div>
    <div class="odds c${res.sels.length}">${res.sels.map((s,k)=>oddBtn(m,res,k,s,short[k])).join("")}</div>`:""}
    ${crowdLine(m)}
    ${nm>0?`<button class="more" data-act="open" data-mid="${esc(m.id)}"><span class="ics">${icons.map(x=>{const[a,b]=x.split("|");return ic(a,b)}).join("")}</span>+${nm} paris : ${m.sp==="foot"?"cartons, corners, hors-jeux…":m.sp==="rugby"?"essais, pénalités, cartons…":m.sp==="basket"?"points, 3 points, rebonds…":"aces, doubles fautes, raquettes…"}</button>`:""}
  </article>`}
function resRow(m){const sc=finalScore(m)||["–","–"],w=typeof sc[0]==="number"?(sc[0]>sc[1]?0:sc[1]>sc[0]?1:-1):-1;
  return`<div class="res-row" data-act="open" data-mid="${esc(m.id)}"><div class="n">${crestOf(m,0)}<span class="${w===0?"w":""}">${esc(m.h)}</span></div>
  <div class="sc">${sc[0]} – ${sc[1]}</div><div class="n r">${crestOf(m,1)}<span class="${w===1?"w":""}">${esc(m.a)}</span></div></div>`}
function ladder(){const cfg=SP[U.sp],now=Date.now();
  const cnt=l=>matchesFor(U.sp,l).filter(m=>status(m)==="pre"||status(m)==="live").length;
  const n=cfg.base;
  const chip=l=>{const c=cnt(l),bars=Array.from({length:5},(_,i)=>`<i class="${(i+1)/5<=Math.min(l+1,n)/n+.001||i===0?"on":""}" style="height:${6+i*3.5}px"></i>`).join("");
    if(!c&&EV_ONLY[U.sp]&&EV_ONLY[U.sp].includes(l))return"";
    return`<button class="lvl${c?"":" zero"}" data-act="lv" data-lv="${l}" aria-pressed="${U.lv===l}"><span class="bars">${bars}</span><span>${esc(cfg.lv[l])}<em>${c?c+" match"+(c>1?"s":""):(cfg.feeds[l]&&FEED[U.sp+l]&&FEED[U.sp+l].ok===false?"Hors ligne":"—")}</em></span></button>`};
  return`<div class="ladder" id="ladder"><div class="tier"><small>Tous</small><div><button class="lvl star" data-act="lv" data-lv="-1" aria-pressed="${U.lv<0}">${ic("fire")}<span>À la une<em>Prochains</em></span></button></div></div>
    ${cfg.tiers.map(([t,ix])=>[t,ix.filter(l=>cfg.feeds[l])]).filter(([,ix])=>ix.length).map(([t,ix])=>`<div class="tier"><small>${t}</small><div>${ix.map(chip).join("")}</div></div>`).join("")}</div>`}
function viewMatches(){setTimeout(crowdCounts,0);const cfg=SP[U.sp];let h=`<div class="sbar sbar5"><button style="--c:#ffd23f" data-act="sp" data-sp="all" aria-pressed="${U.sp==="all"}"><span class="ball allb">🔥</span><span>Tout</span></button>${Object.entries(SP).map(([k,s])=>`<button style="--c:${s.c}" data-act="sp" data-sp="${k}" aria-pressed="${U.sp===k}">${ballArt(k,"ball")}<span>${{foot:"Foot",basket:"NBA",tennis:"Tennis",rugby:"Rugby"}[k]||s.n}</span></button>`).join("")}</div>`;
  if(U.ev){const e=EVENTS.find(x=>x.id===U.ev);if(e)return h+viewEvent(e)+foot();U.ev=null}
  if(U.sp==="all")return h+todayRow()+viewAll()+foot();
  h+=todayRow()+ladder();
  let list=matchesFor(U.sp,U.lv);
  const isDep=U.lv>=0&&U.lv<cfg.dep;

  const now=Date.now();
  let up=list.filter(m=>["pre","live","wait"].includes(status(m)));
  const done=list.filter(m=>status(m)==="post").sort((a,b)=>b.t-a.t);
  if(U.lv<0){let soon=up.filter(m=>m.t<now+3*DAY||status(m)==="live");
    // trêve ou creux de calendrier : on montre quand même les prochains matchs, même dans plus de 3 jours
    if(soon.filter(m=>m.src!=="sim").length<6)soon=soon.concat(up.filter(m=>m.src!=="sim"&&!soon.includes(m)).sort((a,b)=>a.t-b.t).slice(0,12-soon.length));
    const real=soon.filter(m=>m.src!=="sim"),sim=soon.filter(m=>m.src==="sim");
    up=real.slice(0,30).concat(sim.slice(0,real.length>=12?4:24-real.length)).sort((a,b)=>a.t-b.t)}
  const showLv=U.lv<0;
  const fm=U.lv<0&&S.fav&&S.fav.sp===U.sp?favMatch():null;
  if(fm){up=up.filter(m=>m!==fm);h+=`<div class="h2"><h2>❤️ ${esc(S.fav.name)}</h2><span>Ton équipe</span></div><div class="mc-grid">${card(fm,true)}</div>`}
  if(!up.length&&loadingPro(U.sp,U.lv)&&U.lv>=0&&cfg.feeds[U.lv])h+=`<div class="skel"></div><div class="skel"></div>`;
  else if(!up.length)h+=emptyLevel();
  else{let last="";h+=`<div class="h2"><h2>${U.lv<0?"À la une":esc(cfg.lv[U.lv])}</h2><span>${up.length} match${up.length>1?"s":""}</span></div>`;
    const live=up.filter(m=>status(m)==="live");if(live.length){h+=`<div class="day">En direct</div><div class="mc-grid">${live.map(m=>card(m,showLv)).join("")}</div>`}
    const rest=up.filter(m=>status(m)!=="live");let grp="";
    for(const m of rest){const d=fDay(m.t);if(d!==last){if(last)grp+="</div>";grp+=`<div class="day">${d}</div><div class="mc-grid">`;last=d}grp+=card(m,showLv)}
    if(last)grp+="</div>";h+=grp}
  if(done.length)h+=`<div class="h2"><h2>Résultats</h2><span>${done.length}</span></div>`+done.slice(0,U.lv<0?8:20).map(resRow).join("");
  h+=foot();return h}
// « Tout » : à la une de tous les sports réunis (vrais matchs : en direct, puis les prochains), chaque carte indique son sport
const SPTAG={foot:"⚽ Foot",rugby:"🏉 Rugby",tennis:"🎾 Tennis",basket:"🏀 NBA"};
function viewAll(){const now=Date.now();let h="";
  const all=Object.keys(SP).flatMap(sp=>matchesFor(sp,-1).filter(m=>m.src!=="sim")),up=all.filter(m=>["pre","live","wait"].includes(status(m)));
  let soon=up.filter(m=>m.t<now+2*DAY||status(m)==="live");if(soon.length<10)soon=soon.concat(up.filter(m=>!soon.includes(m)).sort((a,b)=>a.t-b.t).slice(0,14-soon.length));
  // pas plus de 14 matchs de tennis ni de NBA pour ne pas noyer le foot et le rugby
  const cap={tennis:14,basket:10},cnt={};soon=soon.sort((a,b)=>a.t-b.t).filter(m=>{cnt[m.sp]=(cnt[m.sp]||0)+1;return!cap[m.sp]||cnt[m.sp]<=cap[m.sp]}).slice(0,45);
  const fm=favMatch();if(fm){soon=soon.filter(m=>m!==fm);h+=`<div class="h2"><h2>❤️ ${esc(S.fav.name)}</h2><span>Ton équipe</span></div><div class="mc-grid">${card(fm,true)}</div>`}
  if(!soon.length){const busy=Object.keys(SP).some(sp=>loadingPro(sp,-1));return h+(busy?`<div class="skel"></div><div class="skel"></div>`:`<div class="empty">${ic("ball")}<b>Pas de match</b>Rien de prévu dans les prochains jours.</div>`)}
  const ns=new Set(soon.map(m=>m.sp)).size;h+=`<div class="h2"><h2>À la une</h2><span>${soon.length} matchs · ${ns} sport${ns>1?"s":""}</span></div>`;
  const live=soon.filter(m=>status(m)==="live");if(live.length)h+=`<div class="day">En direct</div><div class="mc-grid">${live.map(m=>card(m,true)).join("")}</div>`;
  let last="",grp="";for(const m of soon.filter(m=>status(m)!=="live")){const d=fDay(m.t);if(d!==last){if(last)grp+="</div>";grp+=`<div class="day">${d}</div><div class="mc-grid">`;last=d}grp+=card(m,true)}
  if(last)grp+="</div>";return h+grp}
function emptyLevel(){const cfg=SP[U.sp],l=U.lv;
  if(l>=0&&cfg.feeds[l]&&FEED[U.sp+l]&&FEED[U.sp+l].ok===false)
    return`<div class="empty">${ic("info")}<b>Flux live indisponible</b>Impossible de joindre le flux des matchs pros pour l’instant.<br><button class="btn ghost" style="margin-top:12px" data-act="retry">Réessayer</button></div>`;
  return`<div class="empty">${ic(cfg.ic)}<b>Pas de match</b>Rien de prévu dans les prochains jours ici.</div>`}
function foot(){return`<p class="foot">Jeu 100 % gratuit : jetons fictifs sans aucune valeur, rien à acheter, rien à gagner. Matchs pros, scores et stats en direct depuis un flux public ; cotes calculées par un modèle statistique, à titre indicatif.<br>Réservé aux 18 ans et plus · <button class="link" data-act="legal" style="padding:0;font-size:inherit">Règles et confidentialité</button><br>Les jeux d’argent comportent des risques : <a href="https://www.joueurs-info-service.fr" target="_blank" rel="noopener">Joueurs Info Service</a>, 09 74 75 13 13 (appel non surtaxé).</p>`}

/* ---------- rendu : fiche match ---------- */
function viewDetail(m){const st=status(m),mks=markets(m),res=mks.find(x=>x.id==="res"),rs=realStats(m)||(st==="live"&&m.src!=="espn"?null:m.st);
  if(m.src==="espn"&&st!=="pre"&&m.sp==="foot"&&(m._sum!==m.state||(m.state==="in"&&Date.now()-(m._sumAt||0)>9e4)))espnStats(m).then(()=>{MKC.clear();if(U.open===m.id)openDetail(m.id,true)});
  let h=`<div class="grab"><h3>${esc(SP[m.sp].n)}</h3><button class="x" data-act="close" aria-label="Fermer">${ic("x")}</button></div>
  <div class="hero">${fieldSvg(m.sp)}<div class="mc-top">${st==="live"?`<span class="chip live">Direct${liveOK(m)?" · paris ouverts":""}</span>`:""}${srcChip(m)}<span class="comp">${esc(m.comp)}</span></div>
    <div class="teams"><div class="tm">${crestOf(m,0)}<b>${esc(m.h)}</b>${m.hs?`<small>${esc(m.hs)}</small>`:""}</div>${mid(m)}<div class="tm">${crestOf(m,1)}<b>${esc(m.a)}</b>${m.as?`<small>${esc(m.as)}</small>`:""}</div></div>
    ${res?`<div class="prob">${res.sels.map(s=>`<span>${Math.round(s.p*100)} %</span>`).join("")}</div><div class="pbar">${res.sels.map(s=>`<i style="width:${(s.p*100).toFixed(1)}%"></i>`).join("")}</div>`:""}
    <div class="note" style="text-align:center;color:#ffffffa0;margin-top:6px">${esc(fDay(m.t))} · ${fTime(m.t)}</div>${tvChip(m,true)?`<div style="text-align:center;margin-top:8px">${tvChip(m,true)}</div>`:""}</div>`;
  {const mbs=myBets(m.id);if(mbs.length){h+=`<button class="mybet" data-act="mybet" data-mid="${esc(m.id)}"><span>🎟️</span><div><b>${mbs.length>1?`Tes ${mbs.length} tickets sur ce match`:"Ton ticket sur ce match"}</b>
    ${mbs.slice(0,4).map(mb=>`<small>• ${mb.legs.filter(x=>x.mid===m.id).map(x=>esc(x.l)+(x.mt&&x.mk!=="res"?" ("+esc(x.mt)+")":"")).join(" + ")} · ${tok(mb.stake)} jetons${mb.legs.length>1?` · combiné de ${mb.legs.length}`:""}</small>`).join("")}
    <small class="mut2">Tu peux reparier, mais pas sur le choix opposé (ex. l’autre équipe).</small></div><i>›</i></button>`}}
  const hasStats=st!=="pre";
  if(hasStats)h+=`<div class="seg"><button data-act="dtab" data-t="p" aria-pressed="${U.dtab==="p"}">Paris</button><button data-act="dtab" data-t="s" aria-pressed="${U.dtab==="s"}">Stats du match</button></div>`;
  if(m.src==="am")h+=amBlock(m,st);
  if(m.src==="org"&&S.orgMode)h+=`<div style="display:flex;gap:8px;margin-bottom:12px"><button class="btn wide" data-act="resform" data-mid="${esc(m.id)}">${m.res?"Modifier le résultat":"Saisir le résultat"}</button><button class="btn ghost" data-act="delm" data-mid="${esc(m.id)}">Retirer</button></div>`;
  if(hasStats&&U.dtab==="s"){h+=statsBlock(m,st==="live"&&m.src==="sim"?null:(rs||m.st))}
  else{if(st!=="pre")h+=`<div class="info">${ic("info")}<span>${st==="post"?"Match terminé : les sélections gagnantes sont marquées d’un ✓.":liveOK(m)?"Paris en direct : les cotes suivent le score et le temps restant.":"Paris fermés pour ce match."}</span></div>`;
    let g="";for(const mk of mks){if(mk.d.grp!==g){g=mk.d.grp;h+=`<div class="grp">${esc(g)}</div>`}
      const n=mk.sels.length;h+=`<div class="mkt"><h4>${ic(mk.d.ic,mk.d.cls||"")}${esc(mk.title)}${mk.line!=null?`<small>ligne ${fr(mk.line,1)}</small>`:""}</h4>
      <div class="odds c${n===3?3:2}">${mk.sels.map((s,k)=>oddBtn(m,mk,k,s)).join("")}</div>${crowd(m,mk)}</div>`;
      if(mk.id==="res")h+=duelButton(m)+playersBlock(m)}
    if(m.src==="espn"&&m.sp!=="foot")h+=`<p class="note">Pour ce flux, seuls les paris que l’on peut régler automatiquement sont proposés.</p>`}
  if(U.sel.length&&canBet(m))h+=slipPanel();
  return h}
function statsBlock(m,st){if(!st)return`<div class="empty">${ic("chart")}<b>Stats à venir</b>Elles s’affichent à la fin du match.</div>`;
  const keys=(m.sp==="foot"?["pos","sh"]:[]).concat(ALLSTATS[m.sp]).filter(k=>k!=="s1"&&Array.isArray(st[k])&&st[k].every(v=>v!=null&&!isNaN(v)));
  if(!keys.length)return`<div class="empty">${ic("chart")}<b>Stats indisponibles</b>Le flux n’a pas encore publié les statistiques.</div>`;
  return`<div class="cmp">${keys.map(k=>{const[a,b]=st[k],[lb,i2,c2]=STATL[k];
    if(k==="tb")return`<div class="r"><div class="l"><b></b><span>${ic(i2)}${lb}</span><b>${a+b}</b></div></div>`;
    if(k==="pos")return`<div class="r"><div class="l"><b>${Math.round(a)} %</b><span>${ic(i2)}${lb}</span><b>${Math.round(b)} %</b></div><div class="posb"><i style="flex:${a||1}"></i><i style="flex:${b||1}"></i></div></div>`;
    const mx=Math.max(a,b,1);return`<div class="r"><div class="l"><b>${a}</b><span>${ic(i2,c2||"")}${lb}</span><b>${b}</b></div><div class="bb"><i><b style="width:${a/mx*100}%"></b></i><i><b style="width:${b/mx*100}%"></b></i></div></div>`}).join("")}</div>${timeline(m)}`}
// temps forts (buts, cartons) dans l'ordre du match
function timeline(m){if(m.sp!=="foot"||!Array.isArray(m.ev)||!m.ev.length)return"";const E={g:"⚽",og:"⚽",yc:"🟨",rc:"🟥",pk:"🎯"},N={g:"But",og:"CSC",yc:"Carton jaune",rc:"Carton rouge",pk:"Penalty"};
  const L=m.ev.filter(e=>E[e.ty]).slice().sort((a,b)=>(parseInt(a.min)||0)-(parseInt(b.min)||0));if(!L.length)return"";
  return`<div class="h3t">Temps forts</div><div class="tln">${L.map(e=>{const side=e.s==null?-1:e.ty==="og"?1-e.s:e.s;return`<div class="tle${side===1?" aw":""}"><span class="tm">${esc(String(e.min||""))}’</span><span class="ic">${E[e.ty]}</span><span><b>${esc(e.n||N[e.ty])}</b><small>${N[e.ty]}${side>=0?" · "+esc(side?m.a:m.h):""}</small></span></div>`}).join("")}</div>`}

/* ---------- ballons illustrés ---------- */
function ballArt(sp,cls){
  if(sp==="basket")return`<svg class="${cls}" viewBox="0 0 48 48" aria-hidden="true"><defs><radialGradient id="bkg" cx=".36" cy=".3" r=".8"><stop offset="0" stop-color="#ffb35c"/><stop offset="1" stop-color="#c8560f"/></radialGradient></defs>
    <circle cx="24" cy="24" r="22" fill="url(#bkg)"/><g fill="none" stroke="#2a1205" stroke-width="1.6" stroke-linecap="round"><path d="M2 24h44M24 2v44"/><path d="M8.5 8.5c6 5.2 6 25.8 0 31M39.5 8.5c-6 5.2-6 25.8 0 31"/></g><circle cx="24" cy="24" r="22" fill="none" stroke="#2a1205" stroke-width="1.2"/></svg>`;
  if(sp==="foot"){const rad=d=>d*Math.PI/180,pt=(r,d,cx=24,cy=24)=>[cx+r*Math.cos(rad(d)),cy+r*Math.sin(rad(d))],f=q=>q[0].toFixed(2)+" "+q[1].toFixed(2);
    const pent=(cx,cy,r,rot)=>Array.from({length:5},(_,i)=>pt(r,rot+i*72,cx,cy));
    const C=pent(24,24,6.2,-90),O=[0,1,2,3,4].map(k=>{const a=-54+k*72,c=pt(19.5,a);return pent(c[0],c[1],6.2,a)});
    let g=`<path d="M${C.map(f).join("L")}Z"/>`;O.forEach(o=>g+=`<path d="M${o.map(f).join("L")}Z"/>`);
    for(let k=0;k<5;k++){const E=pt(12.3,-90+k*72),near=o=>o.reduce((m,q)=>Math.hypot(q[0]-E[0],q[1]-E[1])<Math.hypot(m[0]-E[0],m[1]-E[1])?q:m);
      g+=`<path fill="none" d="M${f(C[k])}L${f(E)}M${f(E)}L${f(near(O[k]))}M${f(E)}L${f(near(O[(k+4)%5]))}"/>`}
    return`<svg class="${cls}" viewBox="0 0 48 48" aria-hidden="true"><defs><radialGradient id="fbg" cx=".36" cy=".3" r=".8"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#b9c4be"/></radialGradient><clipPath id="fbc"><circle cx="24" cy="24" r="22"/></clipPath></defs>
      <circle cx="24" cy="24" r="22" fill="url(#fbg)"/><g clip-path="url(#fbc)" fill="#18201c" stroke="#18201c" stroke-width="1.5" stroke-linejoin="round">${g}</g><circle cx="24" cy="24" r="22" fill="none" stroke="#0d1310" stroke-width="1.2"/></svg>`}
  if(sp==="rugby")return`<svg class="${cls}" viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="rbg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e08a48"/><stop offset="1" stop-color="#7a3711"/></linearGradient></defs>
    <g transform="rotate(-35 24 24)"><ellipse cx="24" cy="24" rx="23" ry="14" fill="url(#rbg)" stroke="#3a1805" stroke-width="1.2"/>
    <path d="M9.5 13.5c3.2 5.5 3.2 15.5 0 21M38.5 13.5c-3.2 5.5-3.2 15.5 0 21" stroke="#fff" stroke-width="2.6" fill="none" opacity=".92"/>
    <path d="M16.5 24h15" stroke="#fff" stroke-width="1.8"/><path d="M18.5 21.2v5.6M21.5 21.2v5.6M24.5 21.2v5.6M27.5 21.2v5.6M30.5 21.2v5.6" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/>
    <ellipse cx="20" cy="16.5" rx="10" ry="3" fill="#fff" opacity=".2"/></g></svg>`;
  return`<svg class="${cls}" viewBox="0 0 48 48" aria-hidden="true"><defs><radialGradient id="tbg" cx=".36" cy=".3" r=".8"><stop offset="0" stop-color="#f4ff9a"/><stop offset=".6" stop-color="#cde83a"/><stop offset="1" stop-color="#8ea514"/></radialGradient></defs>
    <circle cx="24" cy="24" r="22" fill="url(#tbg)"/><path d="M8.6 8.4c7.5 6.5 7.5 24.7 0 31.2M39.4 8.4c-7.5 6.5-7.5 24.7 0 31.2" stroke="#fff" stroke-width="2.8" fill="none" stroke-linecap="round"/>
    <circle cx="24" cy="24" r="22" fill="none" stroke="#5f7008" stroke-width="1"/></svg>`}

/* ---------- ticket ---------- */
// Combiné : les paris d'un même match sont liés (ex. victoire + plus de 2,5 buts), on ne peut pas
// multiplier leurs cotes. On compte dans les simulations du match les cas où tous se réalisent ensemble.
let CIK="",CIV=null;
function comboInfo(sel=U.sel){const key=sel.map(s=>s.mid+s.mk+s.k+s.o).join("|");if(key===CIK&&CIV)return CIV;CIK=key;CIV=comboCalc(sel,findMatch);return CIV}
function slipOdds(){return comboInfo().odds}
const comboBlocked=()=>comboInfo().bad;
// quels paris se contredisent, et pourquoi (mêmes tirages que le calcul du combiné)
let CFK="",CFV=null;
function comboConflict(sel=U.sel){const key=sel.map(s=>s.mid+s.mk+s.k+s.line).join("|");if(key===CFK)return CFV;CFK=key;CFV=null;
  try{const by={};sel.forEach((s,i)=>{if(!PMK[s.mk])(by[s.mid]=by[s.mid]||[]).push(i)});
    for(const mid in by){const I=by[mid];if(I.length<2)continue;const m=findMatch(mid);if(!m)continue;const legs=I.map(i=>sel[i]);if(jointP(m,legs)>=.004)continue;
      // plus petit groupe de paris impossible ensemble
      let sub=null;const subsets=k=>{const r=[];const go=(st,acc)=>{if(acc.length===k){r.push(acc.slice());return}for(let j=st;j<I.length;j++){acc.push(I[j]);go(j+1,acc);acc.pop()}};go(0,[]);return r};
      for(let k=2;k<=I.length&&!sub;k++)for(const c of subsets(k))if(jointP(m,c.map(i=>sel[i]))<.004){sub=c;break}
      sub=sub||I;const nm=i=>{const s=sel[i];if(s.mk==="res")return`« ${s.k===1?"Match nul":s.l+" gagne"} »`;return`« ${s.l} (${s.mt.toLowerCase()}) »`};const un=(u,v)=>v<=1?u.replace(/s$/,""):u;
      let why=`${sub.map(nm).join(" + ")} ne peuvent pas arriver dans le même match.`;
      const ou=sub.find(i=>{const d=MK[m.sp].find(x=>x.id===sel[i].mk);return d&&d.ty==="ou"});
      if(ou!=null&&sub.length>1){const d=MK[m.sp].find(x=>x.id===sel[ou].mk),oth=sub.filter(i=>i!==ou),S_=marketSims(m),defs=oth.map(i=>MK[m.sp].find(x=>x.id===sel[i].mk));let lo=1e9,hi=-1e9;
        for(let n=0;n<N;n++){const g=k=>[S_[k][0][n],S_[k][1][n]];if(oth.every((i,j)=>legIdx(defs[j],m,g,sel[i])===sel[i].k)){const v=d.val(g,m);if(v<lo)lo=v;if(v>hi)hi=v}}
        const unit=/^Nombre de /i.test(d.t)?d.t.replace(/^Nombre de /i,""):"("+d.t.toLowerCase()+")";
        if(lo<1e9)why=sel[ou].k===1?`${oth.map(nm).join(" + ")} = au moins ${lo} ${un(unit,lo)} dans le match, donc ${nm(ou)} ne peut pas passer.`:`${oth.map(nm).join(" + ")} = au plus ${hi} ${un(unit,hi)} dans le match, donc ${nm(ou)} ne peut pas passer.`}
      CFV={idx:new Set(sub),why};return CFV}}catch(e){}
  return CFV}
function renderSlipBar(){const el=$("#slipbar");if(!U.sel.length||U.open==="slip"){el.innerHTML="";return}
  const n=U.sel.length,combo=U.combo&&n>1&&!comboBlocked();
  const cost=combo?U.stake:U.stake*n,gain=combo?U.stake*slipOdds():U.sel.reduce((a,s)=>a+U.stake*s.o,0);
  el.innerHTML=`<button class="slipbar" data-act="slip"><span class="n">${n}</span><div><b>Mon ticket${combo?" · cote "+fr(slipOdds()):""}</b><small>Mise ${tok(cost)} → gain possible ${tok(gain)}</small></div><span class="go">Valider ›</span></button>`}
// solde affiché sur le ticket : ce qu'on a, et ce qu'il reste après ce pari
const balLine=cost=>`<div class="balln${cost>S.bal?" low":""}"><span>${ic("coin")} Ton solde <b>${tok(S.bal)}</b></span><span>Après ce pari <b id="s3">${tok(Math.max(0,S.bal-cost))}</b></span></div>`;
function slipPanel(){const n=U.sel.length,blocked=comboBlocked(),combo=U.combo&&n>1&&!blocked,cost=combo?U.stake:U.stake*n,
    gain=combo?U.stake*slipOdds():U.sel.reduce((a,s)=>a+U.stake*s.o,0),last=U.sel[n-1];
  return`<div class="dslip"><div class="dl"><span class="n">${n}</span><div><b>${n===1?esc(last.l):n+" sélections"}</b><small>${n===1?esc(last.mt):combo?"Combiné · cote "+fr(slipOdds()):"Paris simples"+(blocked?" (combinaison impossible)":"")}</small></div>
    <button class="link" data-act="slip">Détails</button></div>
    ${n>1&&!blocked?`<div class="seg mini"><button data-act="combo" data-v="0" aria-pressed="${!combo}">Simples</button><button data-act="combo" data-v="1" aria-pressed="${combo}">Combiné</button></div>`:""}
    ${balLine(cost)}
    <div class="chips mini">${[10,20,50,100].map(v=>`<button data-act="stake" data-v="${v}" aria-pressed="${U.stake===v}">${v}</button>`).join("")}<input id="stk" type="number" min="1" inputmode="numeric" value="${U.stake}" aria-label="Mise${combo||n===1?"":" par pari"}"></div>
    <div class="dl2"><span>${combo||n===1?"Mise":"Total misé"} <b id="s1">${tok(cost)}</b></span><span>Gain possible <b id="s2" class="g">${tok(gain)}</b></span></div>
    ${cost>S.bal?`<p class="warn">Il te manque ${tok(cost-S.bal)} jetons.</p>`:""}
    <button class="btn gold wide" data-act="place" ${cost>S.bal?"disabled":""}>${ic("ticket")} Valider · ${tok(cost)} jetons</button></div>`}
function viewSlip(){const n=U.sel.length;if(!n)return`<div class="grab"><h3>Mon ticket</h3><button class="x" data-act="close">${ic("x")}</button></div><div class="empty">${ic("ticket")}<b>Ticket vide</b>Touche une cote pour l’ajouter.</div>`;
  const blocked=comboBlocked(),combo=U.combo&&n>1&&!blocked,cost=combo?U.stake:U.stake*n,gain=combo?U.stake*slipOdds():U.sel.reduce((a,s)=>a+U.stake*s.o,0);
  return`<div class="grab"><h3>Mon ticket</h3><button class="x" data-act="close" aria-label="Fermer">${ic("x")}</button></div>
  ${n>1?`<div class="seg"><button data-act="combo" data-v="0" aria-pressed="${!combo}">Simples (${n})</button><button data-act="combo" data-v="1" aria-pressed="${combo}" ${blocked?"disabled":""}>Combiné</button></div>`:""}
  ${blocked&&n>1?(()=>{const cf=comboConflict();return`<button class="cfbox" data-act="cflash"><b>⚠️ Combiné impossible</b><span>${esc(cf?cf.why:"Ces paris ne peuvent pas être gagnants tous ensemble.")}</span><small>En simples, chaque pari compte à part, mais au moins un sera perdant. Touche ici pour voir les paris en cause.</small></button>`})():combo&&comboInfo().linked?`<p class="note">${ic("info")} Plusieurs paris sur le même match : la cote est recalculée car ils sont liés.</p>`:""}
  <div>${U.sel.map((s,i)=>`<div class="leg${(comboConflict()||{idx:new Set()}).idx.has(i)?" conf":""}"><span class="ic">${ic(s.ic,s.cls||"")}</span><div><b>${esc(s.l)}</b><small>${esc(s.mt)}</small><small>${esc(s.ml)}</small></div><span class="o">${fr(s.o)}</span><button class="rm" data-act="unpick" data-i="${i}" aria-label="Retirer">${ic("x")}</button></div>`).join("")}</div>
  ${WE().on&&WE().k==="combo"?(combo&&n>=3?`<p class="webadge">🧾 Week-end des combinés : si ça passe, <b>+25 %</b> de bonus sur ton bénéfice !</p>`:`<p class="webadge dim">🧾 Week-end des combinés : fais un combiné de 3 sélections ou plus pour toucher +25 % de bonus.</p>`):""}
  <div class="chips">${[10,20,50,100,250].map(v=>`<button data-act="stake" data-v="${v}" aria-pressed="${U.stake===v}">${v}</button>`).join("")}<button data-act="stake" data-v="max">Max</button></div>
  <div class="stake"><label for="stk">Mise${combo||n===1?"":" par pari"}</label><input id="stk" type="number" min="1" inputmode="numeric" value="${U.stake}"></div>
  ${balLine(cost)}
  <div class="sum"><div><small>${combo?"Cote totale":"Total misé"}</small><b id="s1">${combo?fr(slipOdds()):tok(cost)}</b></div><div class="g"><small>Gain possible</small><b id="s2">${tok(gain)}</b></div></div>
  ${cost>S.bal?`<p class="warn">Solde insuffisant : il te manque ${tok(cost-S.bal)} jetons.</p>`:""}
  <button class="btn gold wide" data-act="place" ${cost>S.bal?"disabled":""}>${ic("ticket")} Valider · ${tok(cost)} jetons</button>
  <button class="link" data-act="clear" style="display:block;margin:10px auto 0">Vider le ticket</button>`}

/* ---------- mes paris ---------- */
async function cashOut(id){const b=S.bets.find(x=>x.id===id);const v=b&&cashValue(b);if(!v){toast("Encaissement plus possible pour ce pari.","bad");render();return}
  if(!confirm(`Encaisser ce pari maintenant pour ${tok(v)} jetons ?\n(Gain possible si tu attends : ${tok(b.stake*b.odds)})`))return;
  let v2;
  if(b.sid){   // pari enregistré par le serveur : c'est lui qui calcule la valeur et l'arrête
    try{const j=await api("cash_out",{cid:b.id});if(!j.ok){toast("Le match a bougé : encaissement plus possible.","bad");render();return}v2=j.pay}
    catch(e){toast("Pas de connexion : encaissement impossible pour l’instant.","bad");return}
    if(b.st!=="open")return}
  else{v2=cashValue(b);if(!v2){toast("Le match a bougé : encaissement plus possible.","bad");render();return}}
  b.st="cashed";b.pay=v2;postAct("cash",{pay:v2,stake:b.stake});b.done=Date.now();S.bal+=v2;S.peak=Math.max(S.peak,S.bal);save();render();bump();toast(`${ic("coin")} Encaissé : +${tok(v2)} jetons`,"win")}
// date du match, direct (minute et score) ou score final, pour chaque sélection d'un pari
// pendant le match : la sélection tient-elle ? (déjà gagnée, en bonne voie, perdante pour l'instant, déjà perdue)
function liveLeg(L,m){if(!m||L.r||PMK[L.mk]||!m.st||status(m)!=="live")return null;const d=(MK[m.sp]||[]).find(x=>x.id===L.mk);if(!d)return null;
  let w;try{w=outcome(d,m,m.st,L.line)}catch(e){return null}if(w==null)return null;const k=+L.k;
  if(d.ty==="res")return w===k?{c:"ok",t:"🟢 Gagnant pour l’instant"}:{c:"ko",t:"🟠 Perdant pour l’instant"};
  if(d.ty==="ou"){const v=d.val(x=>m.st[x],m),need=Math.floor(L.line)+1-v;
    if(k===0)return w===0?{c:"sure",t:"✅ Déjà gagné"}:{c:"wait",t:`⏳ Il en faut encore ${need}`};
    return w===1?{c:"ok",t:`🟢 Ça tient (${v} pour l’instant)`}:{c:"dead",t:"❌ Perdu"}}
  if(d.ty==="yn"){if(k===0)return w===0?{c:"sure",t:"✅ Déjà gagné"}:{c:"wait",t:"⏳ Pas encore"};return w===1?{c:"ok",t:"🟢 Ça tient"}:{c:"dead",t:"❌ Perdu"}}
  return null}
function legWhen(L){const m=L.mid&&findMatch(L.mid),t=(m&&m.t)||L.t;if(!t)return"";const st=m?status(m):(t>Date.now()?"pre":null);
  {const gl=ghostLive(m);if(gl)return`<small class="lw${gl.done?"":" live"}">${gl.t} <span class="mut">· pas de direct pour ce match</span></small>`}
  if(st==="live"){const I=liveInfo(m),ll=liveLeg(L,m);return`<small class="lw live">🔴 En direct${I.clock?" · "+esc(I.clock):""}${I.sc?` · <span class="lws">${I.sc[0]} – ${I.sc[1]}</span>`:""}</small>${ll?`<small class="ll ll-${ll.c}">${ll.t}</small>`:""}`}
  if(st==="post"){const sc=finalScore(m);return`<small class="lw">🏁 Terminé${sc?` · <span class="lws">${sc[0]} – ${sc[1]}</span>`:""} · ${esc(fShort(t))}</small>`}
  if(st==="wait")return`<small class="lw">⏳ Match fini, résultat attendu · ${esc(fShort(t))}</small>`;
  if(st==="cancel")return`<small class="lw">Reporté</small>`;
  return`<small class="lw">📅 ${esc(fShort(t))} à ${fTime(t)}</small>`}
function legStatus(L){if(L.r==="w")return`<span class="st w">✓</span>`;if(L.r==="l")return`<span class="st l">✗</span>`;if(L.r==="v")return`<span class="st v">↺</span>`;
  const ll=liveLeg(L,L.mid&&findMatch(L.mid));return ll?`<span class="st p ls-${ll.c}">${ll.c==="sure"?"✓":ll.c==="dead"?"✗":""}</span>`:`<span class="st p"></span>`}
function viewBets(){const B=S.bets.slice().reverse(),op=B.filter(b=>b.st==="open"),cl_=B.filter(b=>b.st!=="open");
  const W=cl_.filter(b=>b.st==="won").length,Lo=cl_.filter(b=>b.st==="lost").length,rate=W+Lo?W/(W+Lo):0;
  const net=cl_.reduce((a,b)=>a+(b.st==="won"||b.st==="cashed"?b.pay-b.stake:b.st==="lost"?-b.stake:0),0);
  const C=2*Math.PI*34;
  let h=`<div class="h2"><h2>Mes paris</h2><span>${tok(S.bets.length)} au total</span></div>
  <div class="kpis"><svg class="ring" viewBox="0 0 84 84"><circle cx="42" cy="42" r="34" fill="none" stroke="var(--line)" stroke-width="8"/>
    <circle cx="42" cy="42" r="34" fill="none" stroke="var(--acc)" stroke-width="8" stroke-linecap="${rate?"round":"butt"}" stroke-dasharray="${C*rate} ${C}" transform="rotate(-90 42 42)"/>
    <text x="42" y="49" text-anchor="middle">${Math.round(rate*100)}%</text></svg>
    <div class="kgrid"><div><small>Gagnés</small><b class="pos">${W}</b></div><div><small>Perdus</small><b class="neg">${Lo}</b></div><div><small>Bilan</small><b class="${net>=0?"pos":"neg"}">${net>0?"+":""}${tok(net)}</b></div></div></div>
  <div class="seg"><button data-act="btab" data-t="o" aria-pressed="${U.btab==="o"}">En cours (${op.length})</button><button data-act="btab" data-t="c" aria-pressed="${U.btab==="c"}">Terminés (${cl_.length})</button></div>`;
  const list=U.btab==="o"?op:cl_;
  if(!list.length)h+=`<div class="empty">${ic("ticket")}<b>${U.btab==="o"?"Aucun pari en cours":"Pas encore de résultat"}</b>${U.btab==="o"?"Choisis un match et touche une cote.":"Tes tickets réglés apparaîtront ici."}<br><button class="btn" style="margin-top:12px" data-act="tab" data-tab="m">Voir les matchs</button></div>`;
  h+=list.map(b=>{const tag=b.st==="won"?`<span class="tag won">+${tok(b.pay)}</span>`:b.st==="lost"?`<span class="tag lost">Perdu</span>`:b.st==="void"?`<span class="tag void">Remboursé</span>`:b.st==="cashed"?`<span class="tag cashed">Encaissé +${tok(b.pay)}</span>`:`<span class="tag open">En cours</span>`;
    const cv=b.st==="open"?cashValue(b):0;
    return`<div class="ticket ${b.st}" data-bid="${esc(b.id)}"><div class="th"><b>${b.legs.length>1?"Combiné · "+b.legs.length:"Simple"}</b><span>Parié le ${new Date(b.at).toLocaleDateString("fr-FR",{day:"numeric",month:"short"})} · ${fTime(b.at)}</span></div>
    ${(()=>{if(b.st!=="open")return"";const S_=b.legs.map(L=>L.r==="w"?"sure":L.r==="l"?"dead":(liveLeg(L,L.mid&&findMatch(L.mid))||{}).c);
      return S_.includes("dead")?`<div class="tdead">❌ Une sélection est déjà tombée : ${b.legs.length>1?"ce combiné":"ce pari"} est perdu</div>`:S_.every(x=>x==="sure")?`<div class="tsure">✅ Tout est déjà bon : gagné à la fin du match</div>`:""})()}
    <div class="tl">${b.legs.map(L=>`<div class="leg legx" data-act="legopen" data-mid="${esc(L.mid)}">${legStatus(L)}<div><b>${esc(L.l)} <span style="color:var(--mute);font-weight:500">@ ${fr(L.o)}</span></b><small>${esc(L.mt)}</small><small>${esc(L.ml)}</small>${legWhen(L)}</div></div>`).join("")}</div>
    <div class="tf"><div><small>Mise</small><b>${tok(b.stake)}</b></div><div style="text-align:center"><small>Cote</small><b>${fr(b.odds)}</b></div><div style="text-align:right"><small>${b.st==="won"?"Gain":b.st==="cashed"?"Encaissé":"Gain possible"}</small>${b.st==="open"?`<b>${tok(b.stake*b.odds)}</b>`:tag}</div></div>
    ${cv?`<button class="cashbtn" data-act="cash" data-id="${esc(b.id)}">${ic("coin")} Encaisser maintenant <b>${tok(cv)}</b></button>`:""}
    <button class="tshare" data-act="tshare" data-id="${esc(b.id)}">${ic("share")} Partager le ticket</button></div>`}).join("");
  return h+foot()}

/* ---------- succès (calculés sur le téléphone, envoyés au serveur pour le profil) ---------- */
const SUCC=[["first","ticket","Premier pari","Faire un pari"],["win1","trophy","Premier gain","Gagner un pari"],["s3","fire","En feu","3 paris gagnés d’affilée"],["s5","fire","Inarrêtable","5 paris gagnés d’affilée"],
  ["o5","chart","Coup de poker","Gagner à une cote de 5 ou plus"],["o10","bolt","Coup de génie","Gagner à une cote de 10 ou plus"],["c4","ticket","Combinard","Gagner un combiné de 4 sélections"],["big","coin","Jackpot","Gagner 500 jetons en un pari"],
  ["cash","coin","Prudent","Encaisser un pari avant la fin"],["b50","ticket","Habitué","50 paris"],["b200","ticket","Accro","200 paris"],["cards","card","Roi des cartons","Gagner un pari sur les cartons"],
  ["rk","broken","Raquette !","Deviner une raquette cassée"],["posts","posts","Buteur","Gagner un pari pénalité ou drop"],["duel","target","Duelliste","Gagner un duel"],["duel5","target","Terreur","Gagner 5 duels"],
  ["lm5","target","Œil de lynx","5 bonnes réponses au match de la guilde"],["week","trophy","Roi de la semaine","Gagner une semaine dans sa guilde"],["season","crown","Champion","Finir premier du mois dans sa guilde"],
  ["fav","ball","Supporter","Choisir son équipe de cœur"],["jack","coin","Légende","Toucher le jackpot de la roue (1 chance sur 10 millions)"],["k5","coin","5 000 jetons","Record à 5 000 jetons"],["k10","coin","10 000 jetons","Record à 10 000 jetons"]];
const SUCCD=Object.fromEntries(SUCC.map(x=>[x[0],x]));
function succOn(){const done=S.bets.filter(b=>b.st==="won"||b.st==="lost").sort((x,y)=>(x.done||x.at||0)-(y.done||y.at||0)),W=S.bets.filter(b=>b.st==="won");
  let run=0,maxRun=0;for(const b of done){run=b.st==="won"?run+1:0;maxRun=Math.max(maxRun,run)}
  const legs=S.bets.flatMap(b=>b.st==="won"||b.st==="cashed"||b.st==="lost"?b.legs:[]),bestO=W.reduce((a,b)=>Math.max(a,b.odds),0),me=U.lg.data&&U.lg.data.rows.find(r=>String(r.id)===String(U.lg.data.me));
  S.sticky=S.sticky||{};if(me&&me.tr)S.sticky.week=1;if(me&&me.sc)S.sticky.season=1;
  const lmOk=Object.values(S.lmw||{}).filter(v=>v===2).length;
  const on={first:S.bets.length>0,win1:W.length>0,s3:maxRun>=3,s5:maxRun>=5,o5:bestO>=5,o10:bestO>=10,c4:W.some(b=>b.legs.length>=4),big:W.some(b=>(b.pay||0)-b.stake>=500),
    cash:S.bets.some(b=>b.st==="cashed"),b50:S.bets.length>=50,b200:S.bets.length>=200,cards:legs.some(l=>l.r==="w"&&["yc","rc"].includes(l.mk)),rk:legs.some(l=>l.r==="w"&&l.mk==="rk"&&l.k===0),
    posts:legs.some(l=>l.r==="w"&&["pm","px","dr"].includes(l.mk)),duel:(S.dwin||0)>=1,duel5:(S.dwin||0)>=5,lm5:lmOk>=5,week:!!S.sticky.week,season:!!S.sticky.season,fav:!!S.fav,jack:(S.jackpot||0)>0,k5:S.peak>=5000,k10:S.peak>=10000};
  return SUCC.filter(x=>on[x[0]]).map(x=>x[0])}
const succGrid=(ids,all)=>`<div class="badges">${(all?SUCC:ids.map(i=>SUCCD[i]).filter(Boolean)).map(([id,i,t,d])=>{const on=ids.includes(id);return`<div class="bdg${on?" on":""}" title="${esc(d)}">${ic(i)}<b>${t}</b><small>${esc(d)}</small></div>`}).join("")}</div>`;

/* ---------- carrière ---------- */
const DIVS=[["Départementale 4",0],["Départementale 3",1300],["Départementale 2",1700],["Départementale 1",2200],["Régional 3",3000],["Régional 2",4000],["Régional 1",5500],["National 3",7500],["National 2",10000],["National 1",14000],["Ligue 2",20000],["Ligue 1",30000],["Ligue des champions",50000]];
function divOf(v){let i=0;DIVS.forEach((d,k)=>{if(v>=d[1])i=k});return i}
// niveau d'XP (calculé par le serveur, reçu à chaque synchro)
const myLv=()=>levelOf(S.xp||0);
function xpUpdate(x){if(x==null)return;const was=S.xp,a=levelOf(was||0);S.xp=x;saveLocal();const b=levelOf(x);
  if(was!=null&&b.lvl>a.lvl){confetti();toast(b.ti>a.ti?`${b.ic} Niveau ${b.lvl} : tu deviens <b>${esc(b.tier)}</b> !`:`⭐ Niveau ${b.lvl} !`,"win")}if(U.tab==="c"&&!U.open)render()}
function viewCareer(){const LV=myLv();
  const done=S.bets.filter(b=>b.st==="won"||b.st==="lost"),W=done.filter(b=>b.st==="won");
  const best=W.reduce((a,b)=>Math.max(a,b.pay-b.stake),0);
  let streak=0;for(const b of done.slice().sort((x,y)=>(y.done||0)-(x.done||0))){if(b.st==="won")streak++;else break}
  const SC=succOn(),rate=done.length?Math.round(W.length/done.length*100):0;
  if(S.pid&&!U.mePal&&!U.mePalLoad){U.mePalLoad=1;api("profile",{id:S.pid}).then(r=>{U.mePal=r.pal||{};if(U.tab==="c"&&!U.open)render()}).catch(()=>{U.mePalLoad=0})}
  const pushTxt=pushState()==="on"?"Activées sur ce téléphone · <button class='link' data-act='pushtest' style='padding:0'>tester</button>":pushState()==="denied"?"Refusées : autorise-les dans les réglages du téléphone":pushState()==="na"?(IOS&&!STANDALONE?"Installe d’abord l’app sur l’écran d’accueil":"Pas disponibles sur ce téléphone"):"Désactivées";
  if(S.tok&&!U.cosD&&!U.cosLoad){U.cosLoad=1;loadCos().then(()=>{if(U.tab==="c"&&!U.open){$("#main")._html=null;render()}})}
  const MC=mcInfo(S.bets,S.xp);let h=`<div class="pcard chero${MC.cls}${bnC(S.cos)}">${MC.fx}<div class="mctop">${MC.note("button","mycard")}<div class="who"><button class="avbtn" data-act="photo" aria-label="Changer ma photo">${avatar(S.pid||"me",S.name||"?",S.avv,"av"+frC(S.cos),true)}<span class="cam">${ic("plus")}</span></button>
    <div><h2>${nameH(S.name||"Joueur",S.cos)}${S.fav?` <span class="cfav">${S.fav.logo?`<img src="${esc(S.fav.logo)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">`:"❤️"}</span>`:""}</h2>${ttlH(S.cos)}<button class="div" data-act="divs">${LV.ic} ${esc(LV.tier)} · niveau ${LV.lvl} ›</button>
    <div class="prog mprog"><div class="t"><i style="width:${LV.pct*100}%"></i></div><div class="l"><span>${tok(LV.cur)} / ${tok(LV.need)} XP</span><span>${LV.next?esc(LV.next[2]+" "+LV.next[0])+" niv. "+LV.next[1]:"Niveau "+(LV.lvl+1)}</span></div></div></div></div></div></div>
  <div class="ckpi"><div><small>Jetons</small><b>${tok(S.bal)}</b></div><div><small>Réussite</small><b>${rate} %</b></div><div><small>Série</small><b>${streak}${streak>=3?" 🔥":""}</b></div><div><small>Plus gros gain</small><b class="pos">${best?"+"+tok(Math.round(best)):"—"}</b></div></div>
  ${palmares({id:S.pid,pal:U.mePal,best:{odds:W.reduce((a,b)=>Math.max(a,b.odds),0),pay:best}})}
  <button class="cstyle ccard" data-act="mycard"><span class="csw cardsw">🃏</span><span><b>Ma carte de joueur</b><small>Ta note sur 99 et tes 6 stats, à partager</small></span><span class="arr">›</span></button>
  <button class="cstyle" data-act="style"><span class="csw bnr bn-${(S.cos&&S.cos.b)||"b1"}"></span><span><b>🎨 Mon style</b><small>Bannière, couleur du pseudo, titre : débloque-les en jouant</small></span><span class="arr">›</span></button>
  <button class="cstyle cref" data-act="ref"><span class="csw refsw">🎁</span><span><b>Parrainer un ami</b><small>+500 jetons pour toi, +250 pour lui</small></span><span class="arr">›</span></button>
  <button class="csucc" data-act="succ"><span><b>🏅 Succès</b><small>${SC.length} / ${SUCC.length} débloqués</small></span><span class="csi">${SUCC.filter(s=>SC.includes(s[0])).slice(-5).map(s=>ic(s[1])).join("")}</span><span class="arr">›</span></button>
  <div class="ctiles"><button data-act="stats">📊<b>Mes stats</b><small>Par sport, par pari, par mois</small></button><button data-act="mshare">📤<b>Mon mois</b><small>Bilan en image</small></button>
    <button data-act="prof" data-id="${esc(S.pid||"")}">👤<b>Mon profil</b><small>Ce que voient les autres</small></button><button data-act="help">❓<b>Aide</b><small>Comment ça marche</small></button></div>
  <details class="csec"><summary>⚙️ Réglages</summary>
    <div class="row" data-act="fav" style="cursor:pointer"><div><b>Équipe de cœur</b><small>${S.fav?esc(S.fav.name):"Ses matchs en premier et un rappel quand elle joue"}</small></div><button class="link" data-act="fav">${S.fav?"Changer":"Choisir"}</button></div>
    <div class="row"><div><b>Notifications</b><small>${pushTxt}</small></div>
      ${pushState()==="on"?`<button class="sw" role="switch" data-act="pushoff" aria-checked="true" aria-label="Notifications"></button>`:pushState()==="off"?`<button class="sw" role="switch" data-act="pushon" aria-checked="false" aria-label="Notifications"></button>`:""}</div>
    ${pushState()==="on"?`<div class="row" style="flex-wrap:wrap;gap:8px"><div><b>Rappels pour parier</b><small>${["Aucun rappel","Un rappel à midi","À midi et vers 18 h"][S.remind??2]}</small></div>
      <div class="seg" style="width:100%;margin:0">${[["2","2 / jour"],["1","1 / jour"],["0","Aucun"]].map(([v,l])=>`<button data-act="remind" data-v="${v}" aria-pressed="${String(S.remind??2)===v}">${l}</button>`).join("")}</div></div>`:""}
    <div class="row"><div><b>Pseudo</b><small>${esc(S.name)}</small></div><button class="link" data-act="rename">Modifier</button></div>
    <div class="row"><div><b>Photo de profil</b><small>Visible dans les classements et le chat</small></div><button class="link" data-act="photo">Changer</button></div>
    ${STANDALONE?"":`<div class="row"><div><b>Installer l’app</b><small>Sur l’écran d’accueil de ton téléphone</small></div><button class="link" data-act="install">Comment ?</button></div>`}
  </details>
  <details class="csec"><summary>🔑 Mon compte</summary>
    ${rcodeCard()}
    <div class="row"><div><b>Récupérer un compte</b><small>Avec un code de compte, sur cet appareil</small></div><button class="link" data-act="xfer">Entrer un code</button></div>
    <div class="row"><div><b>Recommencer</b><small>Repartir de zéro avec 1 000 jetons</small></div><button class="link" data-act="reset" style="color:var(--loss)">Réinitialiser</button></div>
    <div class="row"><div><b>Supprimer mon compte</b><small>Efface tout, définitivement</small></div><button class="link" data-act="delacc" style="color:var(--loss)">Supprimer</button></div>
  </details>
  <details class="csec"><summary>📜 Aide et règles</summary>
    <div class="row"><div><b>Comment ça marche ?</b><small>Cotes, combinés, guildes, combats, animations…</small></div><button class="link" data-act="help">Ouvrir</button></div>
    <div class="row"><div><b>Règles et confidentialité</b><small>Le jeu, tes données, la modération</small></div><button class="link" data-act="legal">Lire</button></div>
    <div class="row"><div><b>Nous écrire</b><small>Question, bug, idée, signalement</small></div><button class="link" data-act="contact">Écrire</button></div>
    <div class="row"><div><b>Instagram</b><small>@tribune.pronos · nouveautés et pronos</small></div><button class="link" data-act="igo">Suivre</button></div>
    <div class="row"><div><b>Facebook</b><small>Page Tribune Pronos · nouveautés et pronos</small></div><button class="link" data-act="fbgo">Suivre</button></div>
    <div class="row"><div><b>Sons</b><small>${S.mute?"Coupés":"Bruitages de la roue et des gains"}</small></div><button class="sw" role="switch" data-act="mute" aria-checked="${!S.mute}" aria-label="Sons"></button></div>
    <div class="row"><div><b>Apparaître sur nos réseaux</b><small>${S.socialOff?"Non : tu restes anonyme sur @tribune.pronos":"Ton pseudo et tes coups peuvent être mis en avant sur @tribune.pronos"}</small></div><button class="sw" role="switch" data-act="socialpref" aria-checked="${!S.socialOff}" aria-label="Apparaître sur nos réseaux"></button></div>
    ${(S.blocked||[]).length?`<div class="row"><div><b>Joueurs bloqués</b><small>${S.blocked.length} joueur${S.blocked.length>1?"s":""}</small></div><button class="link" data-act="blocked">Gérer</button></div>`:""}
  </details>`;
  return h+foot()}
function openDivs(){const LV=myLv();U.open="divs";layer(`<div class="grab"><h3>Niveaux</h3><button class="x" data-act="close" aria-label="Fermer">${ic("x")}</button></div>
  <p class="note" style="text-align:left;margin-top:0">Tu gagnes de l’<b>XP</b> en pariant : plus c’est risqué et plus tu gagnes, plus ça rapporte. Ton niveau ne redescend jamais. Tu es <b>niveau ${LV.lvl}</b> (${tok(LV.xp)} XP).</p>
  <div class="tiers">${TIERS.slice().reverse().map((x,k)=>{const i=TIERS.length-1-k;return`<div class="${i===LV.ti?"cur":i<LV.ti?"done":""}"><span>${x[2]}</span><b>${x[0]}</b><small>niveau ${x[1]}${TIERS[i+1]?"–"+(TIERS[i+1][1]-1):"+"}</small></div>`}).join("")}</div>
  <div class="grp">Comment gagner de l’XP</div><div class="xprules">${[["Pari terminé (gagné ou perdu)","+10"],["Pari gagné : bonus selon la cote","+15 × (cote − 1), max 200"],["Pari encaissé avant la fin","moitié du bonus"],["Défi du jour · les 3 défis","+15 · +30"],["Combat de guildes gagné · nul · perdu","+50 · +25 · +10"],["Prono du week-end","+5 par point"],["Match de la guilde bien vu","+10"],["Podium du mois (1er · 2e · 3e)","+100 · +60 · +40"]].map(([a,b])=>`<div><span>${a}</span><b>${b}</b></div>`).join("")}</div>
  <p class="note" style="text-align:left">Mise d’au moins 5 jetons. Les +10 de participation comptent pour les 10 premiers paris de la journée. La roue et le jackpot ne donnent pas d’XP. Calculé par le serveur à partir de tes vrais paris.</p>`)}
function openSucc(){const SC=succOn();U.open="succ";layer(`<div class="grab"><h3>Succès · ${SC.length}/${SUCC.length}</h3><button class="x" data-act="close" aria-label="Fermer">${ic("x")}</button></div>${succGrid(SC,true)}`)}

/* ---------- formulaires organisateur ---------- */
const AMX={foot:9,rugby:8,tennis:5};   // niveaux amateurs (au-dessus : matchs pros du flux)
function viewAdd(){const cfg=SP[U.sp],lv=U.lv>=0&&U.lv<=AMX[U.sp]?U.lv:0,d=new Date();d.setDate(d.getDate()+((7-d.getDay())%7||7));d.setHours(15,0,0,0);
  const v=new Date(d-d.getTimezoneOffset()*6e4).toISOString().slice(0,16),T=U.sp==="tennis";
  return`<div class="grab"><h3>Nouveau match · ${cfg.n}</h3><button class="x" data-act="close">${ic("x")}</button></div>
  <div class="form"><label>Niveau<select id="f-lv">${cfg.lv.map((n,i)=>i>AMX[U.sp]?"":`<option value="${i}"${i===lv?" selected":""}>${esc(n)}</option>`).join("")}</select></label>
  <label>Département<select id="f-dep"><option value="">—</option>${DEP.map(x=>`<option${x===U.dep?" selected":""}>${x}</option>`).join("")}</select></label>
  <div class="two"><label>${T?"Joueur 1":"Domicile"}<input id="f-h" maxlength="32" placeholder="${T?"ex. Léa Martin":"ex. US Langon"}"></label><label>${T?"Joueur 2":"Extérieur"}<input id="f-a" maxlength="32" placeholder="${T?"ex. Inès Duprat":"ex. FC Pessac"}"></label></div>
  <label>Date et heure<input id="f-t" type="datetime-local" value="${v}"></label>
  <label>Favori<select id="f-f"><option value="0">Match équilibré</option><option value="1">${T?"Joueur 1":"Domicile"} favori</option><option value="2">${T?"Joueur 2":"Extérieur"} favori</option><option value="3">${T?"Joueur 1":"Domicile"} grand favori</option><option value="4">${T?"Joueur 2":"Extérieur"} grand favori</option></select></label>
  <button class="btn wide" data-act="savem">${ic("plus")} Enregistrer le match</button>
  <p class="note">Le match sera visible par tous les joueurs, avec des cotes calculées à partir du niveau et du favori. Après le match, les joueurs déclarent le score : dès que 2 donnent le même, les paris se règlent tout seuls.</p></div>`}
function viewRes(m){const st=(m.src==="am"?m.my:m.res)||{},keys=ALLSTATS[m.sp].filter(k=>k!=="s1"),T=m.sp==="tennis";
  const inp=(k,p)=>`<input type="number" min="0" inputmode="numeric" id="r-${k}-${p}" value="${st[k]&&st[k][p]!=null?st[k][p]:""}">`;
  return`<div class="grab"><h3>Résultat</h3><button class="x" data-act="close">${ic("x")}</button></div>
  <div class="form"><div class="statin"><b style="text-align:center">${esc(initials(m.h,m.sp))}</b><span>${esc(m.h)} – ${esc(m.a)}</span><b style="text-align:center">${esc(initials(m.a,m.sp))}</b></div>
  ${keys.map(k=>k==="tb"?`<div class="statin"><span></span><span>${ic(STATL[k][1])}${STATL[k][0]} (total)</span><input type="number" min="0" inputmode="numeric" id="r-tb-0" value="${st.tb?st.tb[0]:""}"></div>`
    :`<div class="statin">${inp(k,0)}<span>${ic(STATL[k][1],STATL[k][2]||"")}${STATL[k][0]}${k==="g"||k==="pts"||k==="sets"?" *":""}</span>${inp(k,1)}</div>`).join("")}
  ${T?`<label>Vainqueur du 1er set<select id="r-s1"><option value="">—</option><option value="0"${st.s1&&st.s1[0]?" selected":""}>${esc(m.h)}</option><option value="1"${st.s1&&st.s1[1]?" selected":""}>${esc(m.a)}</option></select></label>`:""}
  <button class="btn wide" data-act="saveres" data-mid="${esc(m.id)}">${m.src==="am"?"Déclarer ce score":"Valider le résultat"}</button>
  ${m.src==="am"?`<p class="note">Le score est validé quand 2 joueurs déclarent le même. Remplis les stats que tu connais : les paris sur une stat jamais déclarée sont remboursés.</p>`:""}
  <p class="note">* obligatoire. Les stats laissées vides peuvent être complétées plus tard ; sans elles, les paris concernés seront remboursés 48 h après le match.</p></div>`}

/* ---------- couches (sheets) ---------- */
let lockY=0;
// fiche qui attend des données : on ne montre le squelette que si la réponse tarde (sinon : une seule ouverture, déjà remplie)
let pendT=0;function layerLater(html,ms=450){clearTimeout(pendT);pendT=setTimeout(()=>layer(html),ms)}
function layer(html){clearTimeout(pendT);const was=!!$("#layer").innerHTML,bs=document.body.style;
  const sh=was&&html&&$("#layer .sheet");
  if(sh)sh.innerHTML=html;   // fiche déjà ouverte : on remplace le contenu sans rejouer l'animation d'ouverture
  else $("#layer").innerHTML=html?`<div class="scrim" data-act="scrim"><div class="sheet" role="dialog" aria-modal="true">${html}</div></div>`:"";
  if(html&&!was){lockY=window.scrollY;Object.assign(bs,{position:"fixed",top:-lockY+"px",left:"0",right:"0"})}
  else if(!html&&was){Object.assign(bs,{position:"",top:"",left:"",right:""});window.scrollTo(0,lockY)}}
function openDetail(id,keepScroll){const m=findMatch(id);if(!m)return;if(!keepScroll){loadCrowd(id);U.pside=0;U.pmore=false;loadLineup(m).then(()=>{if(m.lineup&&U.open===id)refreshLayer()})}const sc=keepScroll&&$(".sheet")?$(".sheet").scrollTop:0;U.open=id;layer(viewDetail(m));if(sc)$(".sheet").scrollTop=sc;renderSlipBar()}
function closeLayer(){U.open=null;layer("");render()}
function refreshLayer(){if(!U.open)return;const sc=$(".sheet")?$(".sheet").scrollTop:0;
  if(U.open==="slip")layer(viewSlip());else if(U.open==="add")return;else if(U.open.startsWith("res:"))return;else if(U.open==="welcome")return;else{const m=findMatch(U.open);if(m)layer(viewDetail(m))}
  if($(".sheet"))$(".sheet").scrollTop=sc}

/* ---------- rendu global ---------- */
function render(){if(window.__gate)return;   // page d'installation : on ne dessine jamais le jeu dans le navigateur
  if(U.tab==="m"&&S.name&&!U.open)loadGuide();if(U.open&&U.open.startsWith("td:")){const v=U.open.slice(3),h=viewToday(v);if(h)layer(h)}document.body.dataset.sp=SP[U.sp]?U.sp:"foot";document.body.classList.toggle("darkside",U.tab==="l"&&!!U.dark);$("#bal").textContent=tok(S.bal);{const st=pushState(),bd=$("#belldot"),bl=$("#bell");if(bd)bd.hidden=st==="on"||st==="na"&&!(IOS&&!STANDALONE);if(bl)bl.classList.toggle("on",st==="on")}
  $("#hello").innerHTML=S.name?`<span class="hi">Salut </span>${esc(S.name)}<span class="dv"> · ${esc(myLv().tier)} niv. ${myLv().lvl}</span>`:"Paris gratuits · du district aux pros";
  document.querySelectorAll(".nav button").forEach(b=>b.dataset.tab===U.tab?b.setAttribute("aria-current","page"):b.removeAttribute("aria-current"));
  const op=S.bets.filter(b=>b.st==="open").length,nb=$("#nb");nb.hidden=!op;nb.textContent=op;
  const lx=$("#ladder")?$("#ladder").scrollLeft:null;
  {const html=U.tab==="m"?viewMatches():U.tab==="b"?viewBets():U.tab==="l"?viewLeagues():viewCareer(),M=$("#main");if(html!==M._html){M.innerHTML=html;M._html=html}}
  if(lx!=null&&$("#ladder"))$("#ladder").scrollLeft=lx;
  renderSlipBar()}

/* ---------- règlement des paris ---------- */
// série en cours : pronos gagnés (ou perdus) d'affilée, dans l'ordre où ils ont été réglés
function streakNow(){const L=S.bets.filter(b=>(b.st==="won"||b.st==="lost")&&b.done).sort((a,b)=>b.done-a.done);if(!L.length)return{w:true,n:0};
  const w=L[0].st==="won";let n=0;for(const b of L){if((b.st==="won")!==w)break;n++}return{w,n}}
const legResult=L=>legResultM(L,findMatch(L.mid));
const cashValue=b=>cashValueM(b,findMatch);
let settling=false;
async function settle(){if(settling)return;settling=true;
  // paris perdus récemment : on continue de vérifier les autres sélections, pour afficher leur résultat (✓ / ✗) même si le ticket est déjà perdu
  const lostOpen=S.bets.filter(b=>b.st==="lost"&&b.legs.some(L=>!L.r)&&Date.now()-(b.done||b.at||0)<14*DAY);
  try{const pend=S.bets.filter(b=>b.st==="open").concat(lostOpen).flatMap(b=>b.legs.filter(L=>!L.r));
    // matchs pros hors fenêtre ou stats manquantes : on va chercher les données
    const fetches=[];const seen=new Set();
    // matchs amateurs des joueurs : on rafraîchit ceux qui attendent leur score
    const amIds=[...new Set(pend.filter(L=>L.mid.startsWith("a-")&&Date.now()>L.t+45*6e4).map(L=>L.mid))];
    if(amIds.length)fetches.push(loadAm(amIds));
    for(const L of pend){if(!L.mid.startsWith("e-")||Date.now()<L.t+SP[L.sp].dur*6e4)continue;let m=REG.get(L.mid);
      if(!m&&L.snap&&!seen.has(L.snap.path+ymd(L.t))){seen.add(L.snap.path+ymd(L.t));fetches.push(espnRefetch({...L.snap,t:L.t}))}
      else if(m&&status(m)==="post"&&m.sp==="foot"&&m._sum!=="post")fetches.push(espnStats(m))}
    if(fetches.length)await Promise.all(fetches);
    let won=0,lost=0,gain=0,voids=0,ouch=0;const s0=streakNow();
    for(const b of S.bets.filter(b=>b.st==="open")){for(const L of b.legs)if(!L.r){const r=legResult(L);if(r)L.r=r}
      if(b.legs.some(L=>L.r==="l")){b.st="lost";b.done=Date.now();lost++;
        // défaite qui fait mal (combiné raté d'une seule sélection, ou grosse mise) : annoncée dans le fil, une à la fois
        const n=b.legs.length,ok=b.legs.filter(L=>L.r==="w").length,one=n>=3&&ok===n-1;
        if(!ouch&&(one||b.stake>=500)){ouch++;postAct("lost",{stake:b.stake,n,one:one?1:0,odds:b.odds,last:(b.legs.find(L=>L.r==="l")||{}).l||""})}}
      else if(b.legs.every(L=>L.r)){const live=b.legs.filter(L=>L.r==="w");b.done=Date.now();
        if(!live.length){b.st="void";b.pay=b.stake;S.bal+=b.stake;voids++}
        else{const R=betResult(b);b.odds=R.odds;b.pay=R.pay;b.st="won";S.bal+=b.pay;gain+=b.pay;won++;
          if(won<=3)postAct("won",{pay:b.pay,odds:b.odds,n:b.legs.length,big:b.odds>=5||b.pay>=1000||b.legs.length>=4?1:0,legs:b.legs.slice(0,3).map(L=>L.l)})}}}
    if(won||lost){const s1=streakNow(),T=s1.w?[3,5,7,10,15]:[5,8,12],hit=T.filter(t=>s1.n>=t&&(s0.w!==s1.w||s0.n<t)).pop();if(hit)postAct("streak",{n:hit,w:s1.w?1:0})}
    {let fill=0;for(const b of lostOpen)for(const L of b.legs)if(!L.r){const r=legResult(L),m=findMatch(L.mid);if(r&&(r!=="v"||(m&&status(m)==="cancel"))){L.r=r;fill++}}if(fill&&!won&&!lost&&!voids){save();if(U.tab==="b"&&!U.open)render()}}
    if(won||lost||voids){S.peak=Math.max(S.peak,S.bal);save();render();bump();
      if(won){toast(`${ic("trophy")} ${won} pari${won>1?"s":""} gagné${won>1?"s":""} : +${tok(gain)} jetons !`,"win");winFx()}
      if(lost)toast(`${lost} pari${lost>1?"s":""} perdu${lost>1?"s":""}. La revanche ?`);
      setTimeout(checkDefis,1200);
      if(voids)toast(`↺ ${voids} pari${voids>1?"s":""} remboursé${voids>1?"s":""} (match annulé ou résultat indisponible).`)}}
  finally{settling=false}}

/* ---------- effets ---------- */
function toast(html,cls=""){const box=$("#toasts");while(box.children.length>=3)box.firstChild.remove();
  const t=document.createElement("div");t.className="toast "+cls;t.innerHTML=html;box.appendChild(t);
  // toucher ou glisser vers le haut pour la fermer tout de suite
  const out=()=>{if(t._out)return;t._out=1;t.style.transition="transform .2s ease-in,opacity .2s";t.style.transform="translateY(-120%)";t.style.opacity="0";setTimeout(()=>t.remove(),200)};
  let y0=null;t.addEventListener("pointerdown",e=>{y0=e.clientY;t.setPointerCapture&&t.setPointerCapture(e.pointerId)});
  t.addEventListener("pointermove",e=>{if(y0==null)return;const dy=Math.min(0,e.clientY-y0);t.style.transform=`translateY(${dy}px)`;t.style.opacity=String(1+dy/120)});
  t.addEventListener("pointerup",e=>{if(y0==null)return;const dy=e.clientY-y0;y0=null;if(dy<-25||Math.abs(dy)<8)out();else{t.style.transform="";t.style.opacity=""}});
  t.addEventListener("pointercancel",()=>{y0=null;t.style.transform="";t.style.opacity=""});
  setTimeout(out,3800)}
function bump(){const b=$("#bank");b.classList.remove("bump");void b.offsetWidth;b.classList.add("bump")}
function confetti(){if(matchMedia("(prefers-reduced-motion: reduce)").matches)return;const c=document.createElement("div");c.className="confetti";
  const cols=["#ffd23f","#35d07f","#ff7a45","#d7f25a","#fff","#5fa8ff"];
  for(let i=0;i<70;i++){const p=document.createElement("i");p.style.left=Math.random()*100+"%";p.style.background=cols[i%6];
    p.style.setProperty("--dx",(Math.random()*160-80)+"px");p.style.setProperty("--rot",(Math.random()*900-450)+"deg");
    p.style.animationDuration=(1.6+Math.random()*1.6)+"s";p.style.animationDelay=Math.random()*.3+"s";c.appendChild(p)}
  document.body.appendChild(c);setTimeout(()=>c.remove(),3800)}

/* ---------- actions ---------- */
function pick(mid,mkId,k){const m=findMatch(mid);if(!m||!canBet(m))return;{const mk0=markets(m).find(x=>x.id===mkId),tk=mk0&&oppTaken(mid,mkId,mk0.line,k);if(tk){toast(`🎟️ Tu as déjà parié « ${esc(tk.L.l)} » sur ce pari : pas de choix opposés sur le même match.`);return}}const mk=markets(m).find(x=>x.id===mkId);if(!mk)return;const s=mk.sels[k];if(!s.o)return;
  const i=U.sel.findIndex(x=>x.mid===mid&&x.mk===mkId);const same=i>=0&&U.sel[i].k===k;if(i>=0)U.sel.splice(i,1);
  if(!same){if(U.sel.length>=12){toast("12 sélections maximum par ticket.");return}
    U.sel.push({mid,mk:mkId,k,line:mk.line,o:s.o,live:liveOK(m),l:s.l,mt:mk.title,ml:m.h+" – "+m.a,ic:mk.d.ic,cls:mk.d.cls,sp:m.sp,t:m.t,
      snap:m.src==="espn"?{path:m.path,sp:m.sp,lv:m.lv}:null})}
  if(navigator.vibrate)try{navigator.vibrate(8)}catch(e){}}
async function place(){const n=U.sel.length;if(!n||U.placing)return;const stake=Math.floor(U.stake);if(!(stake>0)){toast("Mise minimum : 1 jeton.","bad");return}
  const gone=U.sel.filter(s=>{const m=findMatch(s.mid);return!m||!canBet(m)});
  // en direct, la cote a pu bouger depuis la sélection : on met à jour et on fait revalider
  let moved=0;U.sel.forEach(s=>{const m=findMatch(s.mid);if(!m||!liveOK(m))return;const mk=markets(m).find(x=>x.id===s.mk);
    if(!mk||mk.line!==s.line){gone.push(s);return}const o=mk.sels[s.k].o;if(o&&o!==s.o){s.o=o;moved++}});
  if(moved&&!gone.length){toast("Le score a bougé : cotes mises à jour, vérifie et valide à nouveau.");refreshLayer();renderSlipBar();return}
  if(gone.length){U.sel=U.sel.filter(s=>!gone.includes(s));toast("Un match a commencé : sélection retirée.","bad");refreshLayer();renderSlipBar();return}
  const combo=U.combo&&n>1&&!comboBlocked(),cost=combo?stake:stake*n;
  {const al=U.sel.filter(x=>oppTaken(x.mid,x.mk,x.line,x.k));if(al.length){U.sel=U.sel.filter(x=>!al.includes(x));toast("🎟️ Tu avais déjà parié le choix opposé : sélection retirée.","bad");refreshLayer();renderSlipBar();return}}if(cost>S.bal){toast("Solde insuffisant.","bad");return}
  const leg=s=>({mid:s.mid,mk:s.mk,k:s.k,line:s.line,o:s.o,live:!!s.live,l:s.l,mt:s.mt,ml:s.ml,ic:s.ic,sp:s.sp,t:s.t,snap:s.snap});
  const at=Date.now();
  // le serveur vérifie chaque pari (match pas commencé, vraie cote) et l'enregistre avant qu'on le garde ici
  if(U.sel.some(s=>!s.snap||!s.snap.path)){toast("Ce match ne peut pas être parié.","bad");return}
  const ss=s=>({mid:s.mid,path:s.snap.path,t:s.t,mk:s.mk,k:s.k,line:s.line,o:s.o,live:!!s.live,l:s.l,ml:s.ml,mt:s.mt});
  const req=combo?[{cid:"b"+at,stake,combo:true,odds:slipOdds(),sels:U.sel.map(ss)}]:U.sel.map((s,i)=>({cid:"b"+at+"-"+i,stake,sels:[ss(s)]}));
  U.placing=true;const bt=$("[data-act=place]");if(bt){bt.disabled=true;bt.dataset.txt=bt.innerHTML;bt.innerHTML="Vérification…"}
  let j;try{if(!(await ensureSession()))throw{code:"offline"};await syncNow();j=await api("place_bets",{bets:req})}
  catch(e){j={error:e.code==="slow_down"?"slow":"offline"}}
  finally{U.placing=false;const b2=$("[data-act=place]");if(b2){b2.disabled=false;if(b2.dataset.txt)b2.innerHTML=b2.dataset.txt}}
  if(!j||!j.ok){const E_=j&&j.error;
    if(E_==="odds_changed"){(j.changed||[]).forEach(c=>{const s=U.sel.find(x=>x.mid===c.mid&&x.mk===c.mk&&x.k===c.k);if(!s)return;if(c.o)s.o=c.o;else U.sel=U.sel.filter(x=>x!==s)});
      CIK="";toast("Les cotes ont bougé : vérifie et valide à nouveau.");refreshLayer();renderSlipBar();return}
    if(E_==="already"||E_==="same_match"){toast(E_==="already"?"🎟️ Tu as déjà parié le choix opposé sur ce match.":"Deux choix opposés sur le même pari : garde-en un seul.","bad");if(E_==="already"){U.sel=U.sel.filter(x=>!(x.mid===j.mid&&x.mk===j.mk));refreshLayer();renderSlipBar()}return}
    if(E_==="started"||E_==="unknown_match"){U.sel=U.sel.filter(x=>x.mid!==j.mid);toast("Un match a commencé : sélection retirée.","bad");refreshLayer();renderSlipBar();return}
    toast(E_==="balance"?"Solde insuffisant.":E_==="combo_impossible"?"Ce combiné est impossible.":E_==="slow"?"Doucement ! Réessaie dans un instant.":E_==="offline"?"Pas de connexion : pari non enregistré.":"Pari refusé, réessaie.","bad");return}
  const sid={};(j.bets||[]).forEach(x=>sid[x.cid]=x);
  S.bal-=cost;
  if(combo)S.bets.push({id:"b"+at,sid:(sid["b"+at]||{}).id,at,stake,odds:(sid["b"+at]||{}).odds||slipOdds(),groups:comboInfo().groups,legs:U.sel.map(leg),st:"open"});
  else U.sel.forEach((s,i)=>{const r=sid["b"+at+"-"+i]||{};S.bets.push({id:"b"+at+"-"+i,sid:r.id,at,stake,odds:r.odds||s.o,legs:[leg(s)],st:"open"})});
  {const placed=combo?[S.bets[S.bets.length-1]]:S.bets.slice(-n);
    postAct("bet",{legs:U.sel.slice(0,4).map(s=>s.l+(s.mk==="res"||PMK[s.mk]?"":" ("+s.mt+")")),stake:cost,odds:combo?slipOdds():(n===1?U.sel[0].o:null),n:combo?n:1,cid:placed.length===1?placed[0].id:undefined})}
  sendPicks(U.sel);U.sel=[];save();setTimeout(checkDefis,900);U.open=null;layer("");U.tab="b";U.btab="o";render();bump();window.scrollTo({top:0,behavior:"smooth"});
  toast(`${ic("ticket")} Pari validé ! Bonne chance.`,"win")}

document.addEventListener("click",e=>{const t=e.target.closest("[data-act]");if(!t)return;const a=t.dataset.act,d=t.dataset;
  if(a==="scrim"){if(e.target===t&&U.open!=="welcome"&&U.open!=="tos"&&U.open!=="intro"&&U.open!=="train")closeLayer();return}
  e.stopPropagation();
  switch(a){
    case"tab":U.tab=d.tab;U.open=null;layer("");render();window.scrollTo({top:0});if(d.tab==="l")loadBoards();break;
    case"lgsel":U.lg.code=d.code;U.lg.feed=null;U.lg.view=U.lg.view||"rank";render();loadBoards();break;
    case"lgmode":U.lg.mode=d.v;render();break;
    case"recap":openRecap(U.lg.code);break;
    case"rcrenew":renewRcode();break;
    case"rctype":typeRcode();break;
    case"igo":openInsta();break;
    case"mute":S.mute=!S.mute;saveLocal();render();if(!S.mute)wSound("win");break;
    case"fbgo":openFb();break;
    case"socialpref":S.socialOff=!S.socialOff;save();render();toast(S.socialOff?"OK, tu n’apparaîtras pas sur nos réseaux.":"Tu peux apparaître sur nos réseaux. Merci !");api("social_pref",{ok:!S.socialOff}).catch(()=>{});break;
    case"igpop":closeLayer();openInsta();break;
    case"ignever":S.igNever=1;saveLocal();closeLayer();break;
    case"cflash":{document.querySelectorAll(".leg.conf").forEach(x=>{x.classList.remove("flash");void x.offsetWidth;x.classList.add("flash")});const f=document.querySelector(".leg.conf");if(f)f.scrollIntoView({block:"center",behavior:"smooth"});break}
    case"ev":{const e=EVENTS.find(x=>x.id===d.id);U.evBack=U.sp;U.ev=d.id;if(e&&e.sp!==U.sp){U.sp=e.sp;U.lv=-1;U.dep="";loadSport(e.sp)}render();window.scrollTo({top:0});break}
    case"evx":{const bk=U.evBack;U.ev=null;U.evBack=null;if(bk&&bk!==U.sp){U.sp=bk;U.lv=-1;U.dep="";loadSport(bk)}render();window.scrollTo({top:0});break}
    case"stats":U.open="stats";layer(viewStats());break;
    case"fav":openFav();break;
    case"favl":{U.favL=+d.i;if(FAVT[FAVL[U.favL][1]]==="err")FAVT[FAVL[U.favL][1]]=null;const sc=$(".sheet")?$(".sheet").scrollTop:0;layer(viewFav());if($(".sheet"))$(".sheet").scrollTop=sc;loadFavTeams();break}
    case"favset":favSet(+d.i);break;
    case"favnone":S.fav=null;save();api("set_fav",{fav:null}).catch(()=>{});closeLayer();toast("Équipe de cœur retirée.");break;
    case"lmpick":lmPick(d.day,+d.k);break;
    case"lmgo":{const L0=U.lg.data&&U.lg.data.leagues[0];if(!L0)break;U.tab="l";U.lg.code=U.lg.code||L0.code;U.lg.view="prono";U.dark=false;render();loadBoards();loadProno();
      setTimeout(()=>{const t=document.querySelector(".gtabs");if(t)window.scrollTo({top:t.getBoundingClientRect().top+scrollY-80,behavior:"smooth"})},350);break}
    case"prno":{const m=(U.pr.data.matches||[]).find(x=>x.mid===d.mid);if(!m||m.t<=Date.now())break;const my=m.my||(m.my={sh:0,sa:0,joker:false,_new:1});
      my[d.side]=cl((my[d.side]||0)+(+d.d),0,20);delete my._new;render();pronoSave(m);break}
    case"prjk":pronoJoker(d.mid);break;
    case"prtab":U.pr.tab=d.v;render();break;
    case"prgo":{const L0=U.lg.data&&U.lg.data.leagues[0];if(!L0)break;U.tab="l";U.lg.code=U.lg.code||L0.code;U.lg.view="prono";U.dark=false;render();loadBoards();loadProno();window.scrollTo({top:0});break}
    case"gmenu":openGMenu();break;
    case"lgview":U.lg.view=d.v;if(["chat","feed"].includes(d.v))U.lg.talk=d.v;if(["fights","duels"].includes(d.v))U.lg.fsub=d.v;if(d.v==="fights")loadBattles(U.lg.code);if(d.v==="prono")loadProno();if(d.v==="chat")loadChat();render();if(d.v==="feed")loadActFeed();if(d.v==="duels")loadDuels();break;
    case"react":reactTo(d.id,d.e);break;
    case"prof":openProfile(d.id);break;
    case"photo":openPhoto();break;
    case"notif":openNotif();break;
    case"pushon":pushEnable();break;
    case"dkhome":openDarkHome();break;
    case"dkenter":darkGo();break;
    case"dkexit":darkExit();break;
    case"dknew":U.open="dknew";U.dkf={type:"yn",opts:["",""],when:"soir"};layer(viewDarkNew());break;
    case"dkset":dkSet(d);break;
    case"dkcreate":darkCreate();break;
    case"dkpick":U.open="dkstake";U.dks={id:d.id,opt:+d.opt,amount:20};layer(viewDarkStake());break;
    case"dkamt":{const g=$("#dks-g");if(g)U.dks.guess=g.value;U.dks.amount=+d.v;layer(viewDarkStake());break}
    case"dkresn":{const v=$("#dkn-"+d.id);const n=v&&v.value!==""?+v.value:NaN;if(isNaN(n)){toast("Entre le vrai chiffre.","bad");break}darkResolve(d.id,0,n);break}
    case"dkbet":darkStake();break;
    case"dkres":darkResolve(d.id,+d.opt);break;
    case"dkflag":darkFlag(d.id,d.kind);break;
    case"dkdel":darkDelete(d.id);break;
    case"dkopen":{const l=(U.dkLeagues||[]).find(x=>x.code===d.code);if(l)darkEnter(l.code,l.name);break}
    case"dknewl":darkNewLeague();break;
    case"dkjoin":darkJoin();break;
    case"dkshare":{const t=`Code de la guilde secrète : ${U.dkCur.code}\n(Dans l’app : reste appuyé 1 seconde sur le logo AP en haut à gauche, puis « Rejoindre ».)`;if(navigator.share)navigator.share({text:t}).catch(()=>{});else{navigator.clipboard&&navigator.clipboard.writeText(t);toast("Code copié.")}break}
    case"remind":S.remind=+d.v;save();render();if(U.open==="notif")layer(viewNotif());api("set_remind",{v:S.remind}).catch(()=>{});break;
    case"pushoff":pushDisable();break;
    case"pushtest":api("push_test",{}).then(()=>toast("Notification de test envoyée.","win")).catch(()=>toast("Impossible pour l’instant.","bad"));break;
    case"pushx":try{localStorage.setItem("dap.pushx",String(Date.now()))}catch(e){}render();break;
    case"chsend":chatSend();break;
    case"chq":chatSend(d.t);break;
    case"chdel":chatDelete(d.id);break;
    case"phdel":deletePhoto();break;
    case"phok":savePhoto();break;
    case"daccept":acceptDuel(d.id,+d.k);break;
    case"dnew":if(!S.tok){toast("Connexion au serveur nécessaire.","bad");break}U.open="duel";layer(viewDuelNew(findMatch(d.mid)));break;
    case"dset":U.dn[d.f]=d.f==="code"?d.v:+d.v;layer(viewDuelNew(findMatch($("[data-act=dgo]").dataset.mid)));break;
    case"dback":U.open=d.mid;layer(viewDetail(findMatch(d.mid)));break;
    case"dgo":createDuel(d.mid);break;
    case"lgnew":U.open="lgform";layer(viewLgForm("new"));setTimeout(()=>$("#lg-in")&&$("#lg-in").focus(),60);break;
    case"lgjoin":U.open="lgform";layer(viewLgForm("join"));setTimeout(()=>$("#lg-in")&&$("#lg-in").focus(),60);break;
    case"lgok":lgSubmit(d.kind);break;
    case"lginv":lgInvite();break;
    case"gmem":openMembers();break;
    case"gset":openGuildSet();break;
    case"gsave":saveGuild();break;
    case"glogo":pickGuildLogo();break;
    case"glogodel":setGuildLogo(null);break;
    case"gpick":{const f=U.gf;if(d.f==="i")f.i=d.v;else if(d.f==="c")f.c=d.v;else if(d.f==="a")f.a=d.v;else if(d.f==="ch")f.ch=d.v;keepGuildForm();layer(viewGuildSet());break}
    case"gdir":openDir();break;
    case"gwr":openGRank(d.v==="chal");break;
    case"gchal":btChallenge(d.id,d.n);break;
    case"gbans":btAnswer(d.id,d.v);break;
    case"gbt":openBtDetail(d.id);break;
    case"gdirjoin":dirJoin(d.id);break;
    case"gkick":guildAct("guild_kick",{id:d.id},"Exclure ce membre de la guilde ?");break;
    case"grole":guildAct("guild_role",{id:d.id,role:d.r},d.r==="chef"?"Lui confier la guilde ? Tu deviendras adjoint.":null);break;
    case"gans":guildAct("guild_answer",{id:d.id,accept:d.v==="1"},null);break;
    case"lgleave":lgLeave();break;
    case"lgretry":U.lg.err=null;loadBoards();render();break;
    case"sp":U.sp=d.sp;U.lv=-1;U.dep="";U.ev=null;render();if(SP[d.sp])loadSport(d.sp);break;
    case"lv":U.lv=+d.lv;render();break;
    case"open":U.dtab="p";openDetail(d.mid);break;
    case"close":closeLayer();break;
    case"legal":openLegal();break;
    case"help":openHelp();break;
    case"tshare":shareTicket(d.id);break;
    case"mshare":shareMonth();break;
    case"follow":followShared();break;
    case"style":openStyle();break;
    case"ref":openRef();break;
    case"refshare":refShare();break;
    case"mycard":openCard({id:S.pid,name:S.name,av:S.avv,me:true,bets:S.bets,xp:S.xp,cos:S.cos,fav:S.fav});break;
    case"pcard":if(U.prof)openCard(U.prof.me?{...U.prof,cos:S.cos,bets:S.bets,xp:S.xp,fav:S.fav}:U.prof);break;
    case"cardlock":toast(`🔒 Débloqué avec une note de ${d.v} ou plus.`);break;
    case"cardopt":{S.cardOpt={...(S.cardOpt||{}),[d.k]:d.v};S.cos={...(S.cos||{}),k:{...((S.cos&&S.cos.k)||{}),[d.k]:d.v}};saveLocal();refreshCard(d.k,d.v);clearTimeout(U.cardT);U.cardT=setTimeout(()=>api("card_set",{k:S.cos.k}).catch(()=>{}),700);break}
    case"cardshare":shareCard();break;
    case"sttab":U.cosTab=d.v;styleRender(true);break;
    case"stpick":{const x=d.v,ty=x.startsWith("tm:")?"t":x[0];if(!U.cosD.unlocked.includes(x)){const c=COS.find(y=>y[0]===x);toast("🔒 "+(c?c[4]:"Pas encore débloqué"));break}U.cosEdit[ty]=x;styleRender();if(ty==="v")winFx(x);break}
    case"stsave":saveStyle();break;
    case"shopen":openShared(d.c);break;
    case"actfollow":api("act_ticket",{id:d.id}).then(j=>{if(j&&j.code)openShared(j.code);else toast("Ce ticket n’est plus disponible.")}).catch(()=>toast("Ce ticket n’est plus disponible."));break;
    case"divs":openDivs();break;
    case"succ":openSucc();break;
    case"fxdemo":{const k=d.v,ru=k==="try";FXQ.push({k,team:ru?"Toulouse":k==="g"?"Rennes":"Lille",who:ru?"":k==="g"?"B. Dia":k==="yc"?"C. Verdonk":"M. Kjaergaard",min:67,m:ru?{h:"Toulouse",a:"Toulon",sc:[17,10]}:{h:"Rennes",a:"Lille",sc:k==="g"?[2,1]:[1,1]}});fxNext();break}
    case"gstats":if(U.open==="gmenu"){U.open=null;layer("")}openGStats();break;
    case"defigo":if(U.open&&U.open.startsWith("td:")){U.open=null;layer("")}defiGo(d.id);break;
    case"td":openToday(d.v);break;
    case"intro":openIntro();break;
    case"coach":startCoach();break;
    case"ixo":U.ix.o=+d.v;layer(viewIntro());break;
    case"ixs":U.ix.s=+d.v;layer(viewIntro());break;
    case"inext":introGo(1);break;
    case"nnext":U.ni=Math.min(NEWS.length-1,U.ni+1);layer(viewNews());break;
    case"nprev":U.ni=Math.max(0,U.ni-1);layer(viewNews());if(!U.ni)newsCard();break;
    case"nskip":newsEnd();break;
    case"ngo":{const v=d.v;newsEnd();setTimeout(()=>{if(v==="mycard")openCard({id:S.pid,name:S.name,av:S.avv,me:true,bets:S.bets,xp:S.xp,cos:S.cos,fav:S.fav});else if(v==="style")openStyle();else if(v==="wheel")openWheel();else if(v==="gwr"){U.tab="l";render();openGRank(false)}},250);break}
    case"iprev":introGo(-1);break;
    case"iskip":introEnd(false);break;
    case"istart":introEnd(true);break;
    case"cskip":stopCoach(false);toast("Guide arrêté. Tu peux le relancer dans Carrière › Comment ça marche ?");break;
    case"cnext":coachNext();break;
    case"trk":if(U.tr&&U.tr.ph!=="play"&&U.tr.ph!=="done"){U.tr.k=+d.v;layer(viewTrain())}break;
    case"trs":if(U.tr){U.tr.s=+d.v;layer(viewTrain())}break;
    case"trgo":trPlay();break;
    case"trend":trEnd();break;
    case"train":startCoach();break;
    case"gtog":U.gOpen=!(U.gOpen??true);render();break;
    case"gclaim":guideClaim(d.k);break;
    case"ggo":if(U.open&&U.open.startsWith("td:")){U.open=null;layer("")}guideGo(d.k);break;
    case"ghide":if(confirm("Masquer les missions ?")){S.guideHide=GSTEPS.length;save();render()}break;
    case"tosok":tosOk();break;
    case"tosno":tosNo();break;
    case"tosback":U.open=null;openTos();break;
    case"rep":report(d.k,d.id,d.w);break;
    case"block":toggleBlock(d.id,d.n);break;
    case"chmenu":openChMenu(d.id);break;
    case"blocked":openBlocked();break;
    case"contact":openContact();break;
    case"ctsend":contactSend();break;
    case"delacc":openDelAcc();break;
    case"delgo":delAccount();break;
    case"dtab":U.dtab=d.t;refreshLayer();break;
    case"btab":U.btab=d.t;render();break;
    case"mybet":{const b=(d.bid&&S.bets.find(x=>String(x.id)===d.bid))||myBet(d.mid);document.querySelectorAll(".scrim").forEach(x=>x.remove());U.open=null;layer("");U.tab="b";if(b)U.btab=b.st==="open"?"o":"c";render();window.scrollTo(0,0);
      if(b)setTimeout(()=>{const e=document.querySelector(`[data-bid="${b.id}"]`);if(e){e.scrollIntoView({block:"center",behavior:"smooth"});e.classList.add("flashb");setTimeout(()=>e.classList.remove("flashb"),1600)}},250);break}
    case"tv":{const C=TVCH[d.ch];if(C&&C.u)window.open(C.u,"_blank","noopener");else toast(`📺 Sur ${esc(d.ch)}`);break}
    case"pleg":{const go=()=>{const m=findMatch(d.mid);if(!m)return false;const st=status(m);U.dtab=st==="live"||st==="post"?"s":"p";openDetail(d.mid);return true};
      if(go())break;toast("Chargement du match…");espnRefetch({path:d.p,sp:d.sp,lv:lvOfPath(d.sp,d.p),t:+d.t}).then(()=>{if(!go())toast("Ce match n’est plus disponible.")}).catch(()=>toast("Ce match n’est plus disponible."));break}
    case"lgfull":{const k=d.k;U.lg.full=U.lg.full===k?null:k;const y=scrollY;render();if(U.lg.full!==k)window.scrollTo(0,Math.min(y,document.body.scrollHeight));break}
    case"legopen":{const m=findMatch(d.mid);if(!m){toast("Ce match n’est plus disponible dans l’appli.");break}const st=status(m);U.dtab=st==="live"||st==="post"?"s":"p";openDetail(d.mid);break}
    case"pick":pick(d.mid,d.mk,+d.k);if(U.open)refreshLayer();render();break;
    case"ppick":pickPlayer(d.mid,d.mk,d.pid,d.name);if(U.open)refreshLayer();render();break;
    case"pside":U.pside=+d.v;U.pmore=false;refreshLayer();break;
    case"pmore":U.pmore=!U.pmore;refreshLayer();break;
    case"unpick":U.sel.splice(+d.i,1);if(!U.sel.length)closeLayer();else{refreshLayer();renderSlipBar()}break;
    case"slip":U.open="slip";layer(viewSlip());renderSlipBar();break;
    case"combo":U.combo=d.v==="1";refreshLayer();break;
    case"stake":{U.stakeTouched=true;const n=U.sel.length,combo=U.combo&&n>1&&!comboBlocked();U.stake=d.v==="max"?Math.max(1,Math.floor(S.bal/(combo?1:n))):+d.v;refreshLayer();break}
    case"place":place();break;
    case"clear":U.sel=[];closeLayer();break;
    case"wheel":openWheel();break;
    case"spin":spin();break;
    case"defi":claimDefi(d.id);break;
    case"defiall":claimAll();break;
    case"cash":cashOut(d.id);break;
    case"retry":if(!SP[U.sp])break;for(const l in SP[U.sp].feeds)FEED[U.sp+l]={ok:null,list:[]};render();Promise.all(Object.keys(SP[U.sp].feeds).map(l=>loadFeed(U.sp,+l))).then(()=>{render();settle()});break;
    case"tsim":S.sim=!S.sim;save();render();break;
    case"torg":S.orgMode=!S.orgMode;save();render();if(S.orgMode)toast("Mode organisateur activé : ajoute tes matchs depuis l’onglet Matchs.");break;
    case"rename":U.open="welcome";layer(viewWelcome(true));setTimeout(()=>$("#w-name")&&$("#w-name").focus(),50);break;
    case"reset":if(confirm("Effacer tes paris et repartir avec 1 000 jetons ?")){Object.assign(S,{bal:1000,peak:1000,bets:[]});U.sel=[];save();render();if(S.tok)api("reset_log",{}).catch(()=>{})}break;
    case"addm":U.open="add";layer(viewAdd());break;
    case"savem":{const h=$("#f-h").value.trim(),aa=$("#f-a").value.trim(),t=Date.parse($("#f-t").value);if(!h||!aa){toast("Indique les deux "+(U.sp==="tennis"?"joueurs.":"équipes."),"bad");return}
      if(isNaN(t)){toast("Date invalide.","bad");return}const lv=+$("#f-lv").value,f=+$("#f-f").value,sv=[[0,0],[.6,-.2],[-.2,.6],[1.2,-.5],[-.5,1.2]][f];
      if(t<Date.now()-6*H){toast("Ce match est trop ancien.","bad");return}
      const btn=$("[data-act=savem]");btn.disabled=true;
      (async()=>{try{if(!(await ensureSession()))throw{code:"offline"};await api("am_add",{sp:U.sp,lv,dep:$("#f-dep").value,h,a:aa,t,fav:f});await loadAm();
        U.lv=lv;closeLayer();toast("Match ajouté pour tout le monde. Les paris sont ouverts !","win")}
      catch(e){btn.disabled=false;toast(e.code==="slow_down"?"Tu as ajouté beaucoup de matchs aujourd’hui.":e.code==="teams"?"Deux équipes différentes, s’il te plaît.":e.code==="date"?"Date invalide.":"Pas de connexion au serveur.","bad")}})();break}
    case"delm":if(confirm("Retirer ce match ? Les paris dessus seront remboursés.")){S.org=S.org.filter(m=>m.id!==d.mid);REG.delete(d.mid);U.sel=U.sel.filter(s=>s.mid!==d.mid);
      S.bets.forEach(b=>b.legs.forEach(L=>{if(L.mid===d.mid&&!L.r)L.r="v"}));save();closeLayer();settle()}break;
    case"resform":U.open="res:"+d.mid;layer(viewRes(findMatch(d.mid)));break;
    case"amdel":if(confirm("Retirer ce match pour tout le monde ? Les paris dessus seront remboursés.")){api("am_remove",{mid:d.mid}).then(async()=>{await loadAm();REG.delete(d.mid);
      S.bets.forEach(b=>b.legs.forEach(L=>{if(L.mid===d.mid&&!L.r)L.r="v"}));save();closeLayer();settle();toast("Match retiré.")}).catch(e=>toast(e.code==="locked"?"Impossible : un score a déjà été déclaré.":"Pas de connexion au serveur.","bad"))}break;
    case"saveres":{const m=S.org.find(x=>x.id===d.mid)||(d.mid.startsWith("a-")&&findMatch(d.mid));if(!m)return;const res={};
      for(const k of ALLSTATS[m.sp]){if(k==="s1"){const v=$("#r-s1")&&$("#r-s1").value;if(v!=="")res.s1=v==="0"?[1,0]:[0,1];continue}
        if(k==="tb"){const v=$("#r-tb-0").value;if(v!=="")res.tb=[+v,0];continue}
        const a0=$(`#r-${k}-0`).value,a1=$(`#r-${k}-1`).value;if(a0!==""&&a1!=="")res[k]=[+a0,+a1]}
      const main=m.sp==="foot"?"g":m.sp==="rugby"?"pts":"sets";if(!res[main]){toast("Le score est obligatoire.","bad");return}
      if(m.sp==="tennis"&&res.sets[0]===res.sets[1]){toast("Il faut un vainqueur.","bad");return}
      if(m.src==="am"){const b=$("[data-act=saveres]");b.disabled=true;
        api("am_report",{mid:m.id,st:res}).then(async()=>{await loadAm([m.id]);const m2=findMatch(m.id)||m;U.open=m.id;U.dtab="p";layer(viewDetail(m2));settle();
          toast(m2.res?"Score validé : les paris sont réglés !":"Merci ! Le score sera validé dès qu’un 2e joueur donne le même.","win")})
        .catch(e=>{b.disabled=false;toast(e.code==="too_early"?"Le match n’est pas encore fini.":"Pas de connexion au serveur.","bad")});break}
      m.res=res;REG.set(m.id,m);MKC.clear();save();U.open=m.id;U.dtab="s";layer(viewDetail(m));settle();toast("Résultat enregistré, paris réglés.","win");break}
    case"wgo":welcomeGo();break;
    case"wlegal":{const x=$("#w-legal");if(x){x.hidden=!x.hidden;if(!x.hidden&&!x.innerHTML)x.innerHTML=legalHTML()}break}
    case"xfer":U.open="welcome";layer(viewTransferIn());setTimeout(()=>$("#x-code")&&$("#x-code").focus(),60);break;
    case"xferok":transferIn();break;
    case"xmake":if(GATE&&!S.tok){toast("Pas de compte à transférer depuis ce navigateur : crée ton compte dans l’app.");break}transferOut();break;
    case"xmake2":U.open="install";layer(`<div class="grab"><h3>Transférer mon compte</h3><button class="x" data-act="close" aria-label="Fermer">${ic("x")}</button></div><div class="xbox" id="xbox"></div>`);transferOut();break;
    case"xback":U.open="welcome";layer(viewWelcome(false));setTimeout(wrefFill,100);break;
    case"copycode":navigator.clipboard&&navigator.clipboard.writeText(d.code).then(()=>toast("Code copié.","win")).catch(()=>{});break;
    case"copylink":{const u=shareableUrl();(navigator.clipboard?navigator.clipboard.writeText(u):Promise.reject()).then(()=>toast("Lien copié : colle-le dans Safari.","win")).catch(()=>prompt("Copie ce lien :",u));break}
    case"install":U.open="install";layer(viewInstall());break;
    case"plat":{if(U.plat===d.v)break;U.plat=d.v;const gi=$("#ginst");if(gi)gi.innerHTML=viewInstall(true);else if(U.open==="install"){const sh=$(".sheet"),sc=sh?sh.scrollTop:0;layer(viewInstall());const s2=$(".sheet");if(s2)s2.scrollTop=sc}break}
    case"instx":try{localStorage.setItem("dap.inst",String(Date.now()))}catch(e){}render();break;
    case"instgo":installPrompt();break;
  }});
document.addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey&&e.target.id==="chin"){e.preventDefault();chatSend();return}if(e.key==="Escape"&&U.open&&U.open!=="welcome"&&U.open!=="tos")closeLayer();
  if(e.key==="Enter"&&e.target.classList&&e.target.classList.contains("mc"))e.target.click();
  if(e.key==="Enter"&&e.target.id==="w-name")$("[data-act=wgo]").click()});
document.addEventListener("change",e=>{if(e.target.id==="dep"){U.dep=e.target.value;render()}if(e.target.id==="dk-t"&&U.open==="dknew"){dkKeep();layer(viewDarkNew())}});
document.addEventListener("input",e=>{if(e.target.id!=="stk")return;U.stakeTouched=true;U.stake=Math.max(1,Math.floor(+e.target.value)||1);
  const n=U.sel.length,combo=U.combo&&n>1&&!comboBlocked(),cost=combo?U.stake:U.stake*n,gain=combo?U.stake*slipOdds():U.sel.reduce((a,s)=>a+U.stake*s.o,0);
  if($("#s1")&&!(combo&&U.open==="slip"))$("#s1").textContent=tok(cost);if($("#s2"))$("#s2").textContent=tok(gain);
  if($("#s3")){$("#s3").textContent=tok(Math.max(0,S.bal-cost));const bl=$(".balln");if(bl)bl.classList.toggle("low",cost>S.bal)}
  const b=$("[data-act=place]");if(b){b.disabled=cost>S.bal;b.innerHTML=`${ic("ticket")} Valider · ${tok(cost)} jetons`}
  document.querySelectorAll("[data-act=stake]").forEach(x=>x.setAttribute("aria-pressed",+x.dataset.v===U.stake));renderSlipBar()});

/* ---------- serveur : compte anonyme, guildes, « ce que parient les autres » ----------
   Le jeu reste jouable sans réseau : tout est d'abord enregistré sur le téléphone. */
const API=(/^(damateur-a-pro\.vercel\.app|localhost)$/.test(location.hostname)?"":"https://damateur-a-pro.vercel.app")+"/api/game";
async function api(action,data={}){const c=new AbortController(),t=setTimeout(()=>c.abort(),12000);
  try{const r=await fetch(API,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action,token:S.tok||undefined,...data}),signal:c.signal});
    const j=await r.json().catch(()=>({}));
    if(r.status===401&&action!=="session"&&S.tok){S.tok="";saveLocal()}   // compte inconnu du serveur : on en recrée un
    if(!r.ok)throw Object.assign(new Error(j.error||r.status),{code:j.error||String(r.status)});return j}
  finally{clearTimeout(t)}}
// gains de roue reçus par ce téléphone (pour récupérer un tirage dont la réponse s'est perdue)
function wGotInit(){if(S.wGot)return;const d=today();S.wGot=S.wheel&&S.wheel.d===d?[d,d+"x"]:[];S.wGotFrom=d}
function wGotMark(r){wGotInit();if(!S.wGot.includes(r))S.wGot=[...S.wGot,r].slice(-12)}
function wheelRecover(list){if(spinning||!Array.isArray(list)||!list.length)return;wGotInit();let t=0;
  for(const x of list){const r=String(x.ref||""),v=+x.delta||0;if(!v||S.wGot.includes(r)||r.slice(0,8)<S.wGotFrom)continue;wGotMark(r);t+=v}
  if(t){S.bal+=t;S.peak=Math.max(S.peak,S.bal);save();render();bump();toast(`🎡 Gain de roue récupéré : +${tok(t)} jetons (le tirage avait eu lieu pendant une coupure).`,"win")}}
function wheelSync(j){wheelRecover(j&&j.wgot);if(j&&j.av!=null&&j.av!==(S.avv||0)){S.avv=j.av;S.avatar=null;saveLocal();if(!U.open)render()}   // photo du compte (après reconnexion, autre téléphone…)
  const w=j&&j.wheel;if(!w)return;let ch=false;if(w.r&&w.r!==S.wheelR){S.wheelR=w.r;S.bonus=w.b||"";S.extraSpin=w.x||"";S.wheelAuto="";ch=true}if(w.b&&w.b>(S.bonus||"")){S.bonus=w.b;ch=true}if(w.x&&w.x>(S.extraSpin||"")){S.extraSpin=w.x;ch=true}if(ch){saveLocal();if(!U.open)render()}}
// paris annulés par les organisateurs : remboursés et marqués « Remboursé »
function applyCancel(j){if(!j||!Array.isArray(j.cancel))return;let n=0;for(const c of j.cancel){const b=S.bets.find(x=>x.id===c.cid&&x.st==="open");if(!b)continue;b.st="void";b.pay=b.stake;b.done=Date.now();S.bal+=b.stake;n++}
  if(n){save();render();toast(`↺ ${n>1?n+" paris annulés":"Un pari annulé"} par les organisateurs : mise remboursée.`)}}
const myStats=()=>{const d=S.bets.filter(b=>b.st==="won"||b.st==="lost");return{won:d.filter(b=>b.st==="won").length,lost:d.filter(b=>b.st==="lost").length}};
let sessP=null;
function ensureSession(){if(S.tok)return Promise.resolve(true);if(!S.name)return Promise.resolve(false);
  return sessP||(sessP=api("session",{name:S.name,bal:S.bal,peak:S.peak,ref:refStored(),...myStats()}).then(j=>{S.tok=j.token;S.pid=j.id;saveLocal();refDone(j);return true})
    .catch(e=>{if(e.code==="name_taken")askNewName();if(e.code==="name_bad")askNewName(true);return false}).finally(()=>sessP=null))}
// Pseudo déjà pris par un autre joueur : on demande d'en choisir un autre (une fois par ouverture)
let askedName=false;
function askNewName(bad){if(GATE||askedName||U.open==="welcome"||U.open==="tos")return;askedName=true;U.open="welcome";layer(viewWelcome(true,bad?`Le pseudo « ${esc(S.name)} » n’est pas accepté (mot interdit ou signalé par plusieurs joueurs). Choisis-en un autre.`:`Le pseudo « ${esc(S.name)} » est déjà pris par un autre joueur. Choisis-en un autre pour apparaître dans les classements.`))}
let syncT=0;
function syncSoon(){if(!S.name)return;clearTimeout(syncT);syncT=setTimeout(async()=>{if(!(await ensureSession()))return;
  try{const j=await api("sync",{name:S.name,bal:S.bal,peak:S.peak,wb:S.bonus,wx:S.extraSpin,wr:S.wheelR||"",tos:S.tosV||"",so:!S.socialOff,...myStats(),...betsPayload()});wheelSync(j);applyCancel(j);xpUpdate(j.xp);if(j.name_taken)askNewName();if(j.name_bad)askNewName(true);backupSoon()}catch(e){if(e.code==="no_session"&&await ensureSession())syncSoon()}},2000)}
async function syncNow(){clearTimeout(syncT);if(!(await ensureSession()))return false;try{const j=await api("sync",{name:S.name,bal:S.bal,peak:S.peak,wb:S.bonus,wx:S.extraSpin,wr:S.wheelR||"",tos:S.tosV||"",so:!S.socialOff,...myStats(),...betsPayload()});wheelSync(j);applyCancel(j);xpUpdate(j.xp);if(j.name_bad)askNewName(true);return true}catch(e){return false}}
const pickKey=s=>s.mk+(s.line!=null?s.line:"");
function sendPicks(sel){const picks=sel.filter(s=>!PMK[s.mk]).map(s=>({mid:s.mid,mk:pickKey(s),k:s.k}));if(!picks.length)return;ensureSession().then(ok=>ok&&api("picks",{picks}).catch(()=>{}));
  for(const p of picks){const c=CROWD[p.mid];if(c&&c.data){const m=((c.data[p.mk]??={}));m[p.k]=(m[p.k]||0)+1}}}
// « Ce que parient les autres » : chargé à l'ouverture de la fiche d'un match (gardé 1 min)
const CROWD={};
function loadCrowd(mid){const c=CROWD[mid];if(c&&Date.now()-c.at<3e3)return;CROWD[mid]={at:Date.now(),data:c&&c.data};
  api("pick_stats",{mids:[mid]}).then(j=>{CROWD[mid]={at:Date.now(),data:j.stats[mid]||{}};if(U.open===mid)refreshLayer()}).catch(()=>{})}
function crowd(m,mk){const c=CROWD[m.id],d=c&&c.data&&c.data[mk.id+(mk.line!=null?mk.line:"")];if(!d)return"";
  const n=mk.sels.map((_,k)=>d[k]||0),tot=n.reduce((a,b)=>a+b,0);if(!tot)return"";const mx=Math.max(...n);
  const short=s=>s.l.replace(/^(Plus|Moins) de .*/,x=>x.split(" ")[0]);
  return`<div class="crowd"><div class="cb">${n.map(v=>`<i class="${v===mx?"ctop":""}" style="flex:${v||.0001}"></i>`).join("")}</div>
    ${ic("group")} ${tot} joueur${tot>1?"s":""} : ${mk.sels.map((s,k)=>`${esc(short(s))} ${Math.round(n[k]/tot*100)} %`).join(" · ")}</div>`}

/* ---------- matchs amateurs ajoutés par les joueurs ---------- */
const AM={list:[],ok:null,at:0};
function amMatch(x){const old=REG.get(x.id);const m=old&&old.src==="am"?old:{};
  Object.assign(m,{id:x.id,src:"am",sp:x.sp,lv:x.lv,dep:x.dep||"",h:x.h,a:x.a,t:x.t,s:x.s||[0,0],bo:3,comp:SP[x.sp].lv[x.lv]+(x.dep?" · "+x.dep:""),
    res:x.res,conf:x.conf,conflict:!!x.conflict,nrep:x.nrep,my:x.my,mine:x.mine});REG.set(m.id,m);return m}
async function loadAm(ids){try{const j=await api("am_list",ids?{ids}:{});const L=j.matches.map(amMatch);
    if(!ids){AM.list=L;AM.ok=true;AM.at=Date.now()}else for(const m of L)if(!AM.list.includes(m))AM.list.push(m);
    MKC.clear();return true}catch(e){if(!ids)AM.ok=false;return false}}
function amBlock(m,st){const T=m.sp==="tennis";
  if(st==="pre")return m.mine?`<div class="info">${ic("info")}<span>Tu as ajouté ce match : il est visible par tous les joueurs. <button class="link" data-act="amdel" data-mid="${esc(m.id)}" style="color:var(--loss)">Le retirer</button></span></div>`:"";
  const txt=m.res?`Score validé par ${m.conf} joueur${m.conf>1?"s":""}.`:m.conflict?"Les joueurs ne sont pas d’accord sur le score : il faut une autre déclaration.":m.nrep?`${m.nrep} déclaration${m.nrep>1?"s":""} : il en faut 2 identiques pour valider.`:"Personne n’a encore déclaré le score.";
  return`<div class="info">${ic("group")}<span>${txt}</span></div>
  <button class="btn ${m.res?"ghost":"gold"} wide" data-act="resform" data-mid="${esc(m.id)}" style="margin-bottom:12px">${m.my?"Modifier ma déclaration":"Déclarer le score"+(T?" du match":"")}</button>`}

/* ---------- guildes entre amis ---------- */
const AVC=["#35d07f","#ffd23f","#ff7a45","#5fa8ff","#d7f25a","#c084fc","#ff5a5f","#7ef0d8"];
const avc=name=>AVC[hash(name)%AVC.length];
let lgTimer=0;
async function loadBoards(){if(U.lg.loading||U.dark)return;U.lg.loading=true;if(U.lg.code)loadLm(U.lg.code);
  try{if(!(await ensureSession()))throw new Error("offline");await syncNow();const j=await api("boards",{code:U.lg.code});U.lg.data=j;U.lg.err=null;if(j.code!==U.lg.code)U.lg.code=j.code;if(j.code)loadBattles(j.code);claimGifts()}
  catch(e){U.lg.err=e.code||"offline"}
  finally{U.lg.loading=false;if(U.tab==="l"&&!U.open)render()}
  clearTimeout(lgTimer);lgTimer=setTimeout(()=>{if(U.tab==="l"&&!document.hidden)loadBoards()},6e4)}
function viewLeagues(){const L=U.lg,d=L.data;
  if(U.dark&&U.dkCur)return viewDark(U.dkCur)+foot();
  let h=`<div class="h2"><h2>Guildes</h2><span>${d&&d.leagues.length?d.leagues.length+" guilde"+(d.leagues.length>1?"s":""):"Entre amis"}</span></div>`;
  if(!S.name)return h+`<div class="empty">${ic("group")}<b>Choisis d’abord un pseudo</b></div>`;
  if(!d&&L.err)return h+`<div class="empty">${ic("info")}<b>Pas de connexion</b>Impossible de joindre le serveur des guildes. Tes paris restent enregistrés sur ton téléphone.<br><button class="btn ghost" style="margin-top:12px" data-act="lgretry">Réessayer</button></div>`;
  if(!d)return h+`<div class="skel"></div><div class="skel" style="height:90px"></div>`;
  h+=`<div class="lgchips"><button data-act="lgsel" data-code="" aria-pressed="${!L.code}">${ic("fire")} Général</button>${d.leagues.map(l=>`<button data-act="lgsel" data-code="${esc(l.code)}" aria-pressed="${L.code===l.code}">${emb(l,"sm")}${esc(l.name)}</button>`).join("")}</div>`;
  const cur=d.leagues.find(l=>l.code===L.code);
  if(cur){const R=cur.mine?"chef":cur.role==="officer"?"adjoint":"membre",boss=R!=="membre";
    const gdv=["Bronze","Argent","Or","Platine","Diamant","Diamant"][gdivI(cur.elo||1000)];
    h+=`<div class="lgcard gcomp gd-${gdv}" style="--gc:${esc((cur.emblem&&cur.emblem.c)||"#35d07f")}"><div class="gtop">${emb(cur,"lg")}<div class="gti"><h3>${esc(cur.name)}</h3>
    ${cur.motto?`<em class="gmotto">« ${esc(cur.motto)} »</em>`:""}<small><button class="link" data-act="gmem">${cur.n} membre${cur.n>1?"s":""}</button> · tu es ${R}</small><button class="gdvb" data-act="gwr">${gdivImg(gdivI(cur.elo||1000),"gdis")} Guilde ${GDIV[gdivI(cur.elo||1000)][0]} ›</button></div>
    <button class="btn gold gsm" data-act="lginv" aria-label="Inviter">${ic("share")}</button><button class="gdots" data-act="gmenu" aria-label="Menu de la guilde">•••${boss&&cur.nreq?`<i class="tdd"></i>`:""}</button></div></div>`}
  else h+=`<div class="lgcard"><h3>Classement général</h3><small>Tous les joueurs${d.rank?` · tu es <b style="color:var(--sel)">${d.rank}<sup>${d.rank===1?"er":"e"}</sup></b> sur ${d.total} en jetons`:""}</small></div>`;
  if(cur&&d.last)h+=`<div class="champ">${ic("trophy")}<div><small>Vainqueur${d.last.winners.length>1?"s":""} de la semaine dernière</small><b>${d.last.winners.map(w=>esc(w.name)+` <span class="pos">+${tok(w.gain)}</span>`).join(" · ")}</b></div></div>`;
  if(cur){const nd=(L.duels||[]).filter(x=>x.status==="open"&&String(x.a)!==String(d.me)).length;
    const nc=chatUnread(cur.code);
    const talk=["chat","feed"].includes(L.view),fight=["fights","duels"].includes(L.view),bt=(U.bt||{})[cur.code],nb=bt?bt.battles.filter(x=>x.status==="pending"&&x.incoming).length:0;
    h+=`<div class="seg gtabs"><button data-act="lgview" data-v="rank" aria-pressed="${L.view==="rank"}">Classement</button><button data-act="lgview" data-v="${U.lg.fsub||"fights"}" aria-pressed="${fight}">Combats${nb+nd?` <span class="pill">${nb+nd}</span>`:""}</button><button data-act="lgview" data-v="prono" aria-pressed="${L.view==="prono"}">Pronos${lmBanner()||pronoTodo()?`<i class="tdd"></i>`:""}</button><button data-act="lgview" data-v="${U.lg.talk||"chat"}" aria-pressed="${talk}">Discussion${nc?` <span class="pill">${nc}</span>`:""}</button></div>`;
    if(talk)h+=`<div class="seg mini gsub"><button data-act="lgview" data-v="chat" aria-pressed="${L.view==="chat"}">💬 Chat${nc?` <span class="pill">${nc}</span>`:""}</button><button data-act="lgview" data-v="feed" aria-pressed="${L.view==="feed"}">📰 Fil</button></div>`;
    if(fight)h+=`<div class="seg mini gsub"><button data-act="lgview" data-v="fights" aria-pressed="${L.view==="fights"}">⚔️ Contre les guildes${nb?` <span class="pill">${nb}</span>`:""}</button><button data-act="lgview" data-v="duels" aria-pressed="${L.view==="duels"}">🤺 Duels entre membres${nd?` <span class="pill">${nd}</span>`:""}</button></div>`;
    if(L.view==="chat")return h+viewChat(cur);
    if(L.view==="prono")return h+viewLm(cur.code)+viewProno(cur)+lgFooter(cur);
    if(L.view==="feed")return h+viewFeed()+lgFooter(cur);
    if(L.view==="duels")return h+viewDuels(cur)+lgFooter(cur);
    if(L.view==="fights"){if(!bt)loadBattles(cur.code);return h+(bt?viewBattle(cur):`<div class="skel" style="height:180px"></div>`)+`<p class="note">Combats de guildes : chaque lundi un adversaire de votre niveau, ou un défi lancé par le chef. Score = moyenne des gains en paris de tous les membres. <button class="link" data-act="gbt" data-id="" style="padding:0">Règles et historique</button></p>`+lgFooter(cur)}}
  const M=L.mode,SN=d.season;
  if(cur&&d.lastSeason&&(M==="season"||new Date().getDate()<=7))h+=`<div class="champ season">${ic("crown")}<div><small>Champion${d.lastSeason.winners.length>1?"s":""} du mois de ${esc(d.lastSeason.label)}</small><b>${d.lastSeason.winners.map(w=>esc(w.name)+` <span class="pos">+${tok(w.gain)}</span>`).join(" · ")}</b></div></div>`;
  if(cur){const b=(U.bt||{})[cur.code],lv=b&&b.battles.find(x=>x.status==="live");
    h+=`<div class="gquick"><button data-act="recap">📊 <span>Bilan</span>${(S.recapSeen||{})[cur.code]!==d.week?`<i class="tdd"></i>`:""}</button>
    <button data-act="gstats">📈 <span>Stats</span></button>
    <button data-act="lgview" data-v="fights">⚔️ <span>${lv?`<b class="${lv.my>lv.their?"pos":lv.my<lv.their?"neg":""}">${lv.my>0?"+":""}${tok(lv.my)}</b> / ${lv.their>0?"+":""}${tok(lv.their)}`:b?`${b.guild.div.i} ${b.guild.div.n}`:"Combats"}</span></button></div>`}
  h+=`<div class="seg tabs3"><button data-act="lgmode" data-v="season" aria-pressed="${M==="season"}">Mois</button><button data-act="lgmode" data-v="week" aria-pressed="${M==="week"}">Semaine</button><button data-act="lgmode" data-v="total" aria-pressed="${M==="total"}">Jetons</button></div>`;
  {const pz=(t,L,R,n)=>`<div class="przcard"><div class="pzh">🎁 <b>${t}</b></div><div class="pzl">${L.map((r,i)=>`<span class="${i===0?"g":""}"><small>${r}</small><b>+${tok(R[i])}</b></span>`).join("")}</div><small class="pzn">${n}</small></div>`;
    if(M==="week")h+=pz(cur?"Récompenses de la semaine":"Semaine",["1er","2e","3e"],[200,100,50],cur?"Versées le lundi matin aux 3 premiers de la guilde · il faut avoir au moins un pari terminé dans la semaine":"Les récompenses de la semaine se jouent dans chaque guilde (1er +200, 2e +100, 3e +50)");
    else if(M==="season"&&!cur)h+=pz("Récompenses du classement général",["👑 1er","2e","3e"],[1500,750,400],"Versées le 1er du mois aux 3 meilleurs joueurs de Tribune · il faut avoir au moins un pari terminé dans le mois")}
  if(M==="season"&&SN){const left=Math.max(0,Math.ceil((SN.end-Date.now())/864e5));
    if(cur){const P=prizesOf(cur);h+=`<div class="przcard"><div class="pzh">🎁 <b>Récompenses de fin de mois</b></div>
      <div class="pzl">${["1er","2e","3e","Les autres"].map((r,i)=>`<span class="${i===0?"g":""}"><small>${r}</small><b>+${tok(P[i])}</b></span>`).join("")}</div>
      <small class="pzn">Créditées toutes seules le 1er du mois · mêmes montants dans toutes les guildes · il faut avoir au moins un pari terminé dans le mois</small></div>`}
    h+=`<div class="sncard">${ic("crown")}<div><b>Classement de ${esc(SN.label)}</b><small>${left<=1?"Dernier jour !":`Fin dans ${left} jours`} · le premier du mois est sacré champion</small></div></div>`}
  // ne sont classés que ceux qui ont au moins un pari terminé (sur la période en Mois / Semaine) ; les autres sont listés à part, en bas
  const key=M==="week"?"week":M==="season"?"season":"bal",gainMode=M!=="total",played=r=>!r.on||r.on[key]||r.id===d.me&&(key==="bal"?S.bets.some(b=>["won","lost","cashed"].includes(b.st)):false),
    idle=d.rows.filter(r=>!played(r)),rows=d.rows.filter(played).sort((a,b)=>b[key]-a[key]||b.bal-a.bal).slice(0,cur?60:50);
  const val=r=>gainMode?(r[key]>0?"+":"")+tok(r[key]):tok(r.bal),cls=r=>gainMode?(r[key]>=0?"pos":"neg"):"";
  if(!rows.length)h+=`<div class="empty">Personne pour l’instant.</div>`;
  if(rows.length>=3){const P=[rows[0],rows[1],rows[2]],H=[90,66,48];
    h+=`<div class="podium">${P.map((r,i)=>`<div class="pod" data-act="prof" data-id="${esc(r.id)}">${avatar(r.id,r.name,r.av,"av"+frC(r.cos))}<b>${nameH(r.name,r.cos)}${r.id===d.me?" (toi)":""}</b><span class="${cls(r)}">${val(r)}</span>
      <div class="blk" style="height:${H[i]}px;background:${["#ffd23f","#c9d3dc","#e0975a"][i]}">${i+1}</div></div>`).join("")}</div>`}
  // liste raccourcie : les 10 premiers + ta place, le reste derrière « Voir tout »
  const LIM=10,full=U.lg.full===(cur?cur.code:"gen"),meI=rows.findIndex(r=>r.id===d.me),showR=(r,i)=>full||i<LIM||i===meI;
  h+=rows.map((r,i)=>(i<3&&rows.length>=3)||!showR(r,i)?"":`${!full&&i===meI&&i>LIM?`<div class="note" style="text-align:center;margin:2px 0">⋯</div>`:""}<div class="prow${r.id===d.me?" me":""}" data-act="prof" data-id="${esc(r.id)}"><span class="rk">${i+1}</span>${avatar(r.id,r.name,r.av,"av"+frC(r.cos))}
    <div><b>${nameH(r.name,r.cos)}${favCrest(r.fav)}${r.id===d.me?" (toi)":""}${r.sc?` <span class="trs crw">${ic("crown")}${r.sc>1?r.sc:""}</span>`:""}${r.tr?` <span class="trs">${ic("trophy")}${r.tr>1?r.tr:""}</span>`:""}</b><small>${r.cos&&r.cos.t&&cosTitle(r.cos.t)?esc(cosTitle(r.cos.t))+" · ":""}${levelOf(r.xp||0).ic} niv. ${levelOf(r.xp||0).lvl} · ${r.won} gagné${r.won>1?"s":""} · ${r.lost} perdu${r.lost>1?"s":""}</small></div>
    <span class="v ${cls(r)}">${val(r)}</span></div>`).join("");
  if(idle.length)h+=`<div class="idlep"><small>${M==="week"?"Pas encore de pari terminé cette semaine":M==="season"?"Pas encore de pari terminé ce mois-ci":"Pas encore de pari terminé"} · ${idle.length}</small><div>${idle.slice(0,40).map(r=>`<span data-act="prof" data-id="${esc(r.id)}" title="${esc(r.name)}">${avatar(r.id,r.name,r.av,"av"+frC(r.cos))}</span>`).join("")}</div></div>`;
  if(rows.length>LIM+1)h+=`<button class="btn ghost wide" data-act="lgfull" data-k="${cur?esc(cur.code):"gen"}" style="margin:8px 0">${full?"Réduire le classement":`Voir tout le classement (${rows.length})`}</button>`;
  if(!cur&&d.rank&&!rows.some(r=>r.id===d.me))h+=`<div class="note" style="text-align:center">…</div>`;
  const note=M==="week"?`« Semaine » = jetons gagnés <b>en pariant</b> depuis lundi (la roue, les défis et les bonus ne comptent pas). Repart à zéro chaque lundi ; le meilleur gagne un trophée ${ic("trophy")}.`
    :M==="season"?`« Mois » = jetons gagnés <b>en pariant</b> depuis le 1er du mois : seuls les paris comptent (pas la roue, les défis, le prono ni le match de la guilde). Paris gagnés + encaissés − paris perdus. Repart à zéro chaque mois ; le premier est sacré champion ${ic("crown")}.`
    :"« Jetons » = tout ce que tu as, depuis le début.";
  return h+`<p class="note">${note}</p>`+lgFooter(cur)}
function lgFooter(cur){if(cur)return foot();return`<button class="btn gold wide" data-act="gdir" style="margin-top:14px">${ic("group")} Trouver une guilde</button><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px"><button class="btn" data-act="lgnew">${ic("plus")} Créer</button><button class="btn ghost" data-act="lgjoin">Rejoindre avec un code</button></div>
  ${cur?`<p class="note"><button class="link" data-act="lgleave" style="color:var(--loss)">Quitter la guilde</button></p>`:""}`+foot()}

/* ---------- « Aujourd'hui » : une rangée de pastilles au lieu des cartes empilées (roue, défis, missions, prono…) ---------- */
function todayItems(){const T=[],we=WE();
  if(we.on||we.soon)T.push({k:"we",e:we.e,l:we.on?"Week-end":"Demain",dot:we.on,act:"td",v:"we"});
  if(wheelAvail())T.push({k:"wheel",e:"🎡",l:extraAvail()?"Tour bonus":"Roue",dot:true,act:"wheel"});
  if(S.name){const D=defisState(),got=D.filter(d=>d.got).length;
    if(!S.dch.all)T.push({k:"defis",e:"🎯",l:`Défis ${got}/3`,dot:D.some(d=>d.n>=d.g&&!d.got)||got===3,act:"td",v:"defis"})}
  const g=U.gs;if(guideVisible(g)){const GL=guideList(g),n=GL.filter(([k])=>g.done[k]).length,r=GL.some(([k])=>g.done[k]&&!g.claimed[k])||(!g.all&&GSTEPS.every(([k])=>g.claimed[k]));
    T.push({k:"guide",e:"🚀",l:g.all?"Nouvelle mission":`Missions ${n}/${GL.length}`,dot:r||g.all,act:"td",v:"guide"})}
  if(lmBanner())T.push({k:"lm",e:"🛡️",l:"Match guilde",dot:true,act:"lmgo"});
  if(pronoBanner()){const j=U.pr.data,todo=j.matches.some(m=>m.t>Date.now()&&!m.my);T.push({k:"prono",e:"🔮",l:"Prono",dot:todo,act:"prgo"})}
  for(const e of EVENTS.filter(evActive))T.push({k:"ev"+e.id,e:e.em,l:e.n,dot:evMatches(e).some(m=>status(m)==="live"),act:"ev",id:e.id,live:true});
  if(pushBanner())T.push({k:"push",e:"🔔",l:"Notifs",dot:true,act:"notif"});
  if(installBanner())T.push({k:"inst",e:"📲",l:"Installer",dot:false,act:"install"});
  return T}
function todayRow(){const T=todayItems();if(!T.length)return"";
  return`<div class="today">${T.map(x=>`<button class="tdi${x.dot?" on":""}" data-act="${x.act}"${x.v?` data-v="${x.v}"`:""}${x.id?` data-id="${x.id}"`:""}><span class="tdc">${x.e}${x.dot?`<i class="tdd"></i>`:""}</span><small>${esc(x.l)}</small></button>`).join("")}</div>`}
function openToday(v){U.open="td:"+v;U.gOpen=true;layer(viewToday(v))}
function viewToday(v){const x=`<button class="x" data-act="close" aria-label="Fermer">${ic("x")}</button>`;
  if(v==="defis")return`<div class="grab"><h3>Aujourd’hui</h3>${x}</div><p class="note" style="text-align:left;margin-top:0">Touche un défi pour aller au bon endroit. Les jetons se récupèrent ici dès qu’il est réussi.</p>${defisCard()}`;
  if(v==="guide")return`<div class="grab"><h3>Premiers pas</h3>${x}</div>${guideCard()||`<div class="empty">Toutes les missions sont faites 🎉</div>`}`;
  if(v==="we"){const w=WE();return`<div class="grab"><h3>Week-end spécial</h3>${x}</div>${weBanner()}<p class="note" style="text-align:left">Chaque week-end a son thème, à tour de rôle : 🧾 combinés (+25 % de bonus), 🎡 roue (gains ×2), 🎯 défis (×2). Tout est automatique.</p>`}
  return""}

/* ---------- palmarès (profil) ---------- */
function palmares(p){const a=p.pal||{},row=(U.lg.data&&U.lg.data.rows||[]).find(r=>String(r.id)===String(p.id))||{};
  const it=[[a.months||row.sc||0,"👑","mois gagné","mois gagnés"],[row.tr||0,"🏆","semaine gagnée","semaines gagnées"],[a.podiums||0,"🥉","podium du mois","podiums du mois"],[a.battles||0,"⚔️","combat gagné","combats gagnés"]];
  const best=a.best_odds||(p.best&&p.best.odds)||0,big=a.big_win||(p.best&&p.best.pay)||0;
  const any=it.some(x=>x[0]),mine=String(p.id)===String(S.pid);
  return`<div class="grp">Palmarès</div>${any?`<div class="palm">${it.map(([n,e,s1,s2])=>`<div class="${n?"on":""}"><span>${e}</span><b>${n}</b><small>${n>1?s2:s1}</small></div>`).join("")}</div>`
    :`<div class="palm0">🏆 ${mine?"Pas encore de titre : gagne une semaine ou un mois dans ta guilde, ou un combat de guildes !":"Pas encore de titre."}</div>`}
  ${best||(big&&!mine)?`<div class="palm2">${best?`<div>🎯 Meilleure cote gagnée <b>${fr(best)}</b></div>`:""}${big&&!mine?`<div>💰 Plus gros gain <b class="pos">+${tok(big)}</b></div>`:""}</div>`:""}`}

/* ---------- statistiques de la guilde ---------- */
async function openGStats(){U.open="gstats";const head=`<div class="grab"><h3>Statistiques de la guilde</h3><button class="x" data-act="close" aria-label="Fermer">${ic("x")}</button></div>`;
  layerLater(head+`<div class="skel" style="height:160px"></div><div class="skel"></div>`);
  try{const j=await api("guild_stats",{code:U.lg.code});if(U.open!=="gstats")return;layer(head+viewGStats(j))}catch(e){if(U.open==="gstats")layer(head+`<div class="empty">${ic("info")}<b>Pas de connexion</b>Réessaie dans un instant.</div>`)}}
function viewGStats(j){if(!j.bets)return`<div class="empty">${ic("chart")}<b>Pas encore de paris</b>Les statistiques arrivent dès les premiers paris de la guilde.</div>`;
  const SPN={foot:"⚽ Foot",rugby:"🏉 Rugby",tennis:"🎾 Tennis",basket:"🏀 NBA"},pp=(x,txt)=>x?`<div class="gmrow">${avatar(x.id,x.name,x.av,"av")}<div><b>${esc(x.name)}</b><small>${txt}</small></div></div>`:"";
  return`<p class="note" style="text-align:left;margin-top:0">Sur les 60 derniers jours, membres actuels.</p>
  <div class="stk">${[["Paris",tok(j.bets)],["Réussite",j.rate+" %"],["Combinés",tok(j.combos)],["Jetons misés",tok(j.staked)],["Sport préféré",j.sport?SPN[j.sport[0]]||j.sport[0]:"—"],["Pari préféré",j.market?esc(j.market[0]):"—"]].map(([k,v])=>`<div><small>${k}</small><b>${v}</b></div>`).join("")}</div>
  <div class="grp">Les records</div>
  ${pp(j.best,`📈 Meilleur parieur : ${j.best?(j.best.net>=0?"+":"")+tok(Math.round(j.best.net))+" jetons":""}`)}
  ${pp(j.sniper,`🎯 Le plus précis : ${j.sniper?Math.round(j.sniper.w/j.sniper.n*100)+" % de réussite":""}`)}
  ${pp(j.busy,`🔥 Le plus actif : ${j.busy?j.busy.n+" paris réglés":""}`)}
  ${pp(j.bestOdds,`🚀 Plus grosse cote gagnée : ${j.bestOdds?fr(j.bestOdds.odds)+(j.bestOdds.n>1?` (combiné de ${j.bestOdds.n})`:` (${esc(j.bestOdds.label||"")})`):""}`)}
  ${pp(j.bigWin,`💰 Plus gros gain : ${j.bigWin?"+"+tok(j.bigWin.gain)+" jetons":""}`)}`}

/* ---------- mon mois en image ---------- */
function monthData(){const now=new Date(),useLast=now.getDate()<=3,ref=new Date(now.getFullYear(),now.getMonth()-(useLast?1:0),1),y=ref.getFullYear(),mo=ref.getMonth();
  const B=S.bets.filter(b=>["won","lost","cashed"].includes(b.st)&&b.done&&new Date(b.done).getFullYear()===y&&new Date(b.done).getMonth()===mo);
  const W=B.filter(b=>b.st==="won"),net=B.reduce((a,b)=>a+(b.st==="lost"?-b.stake:(b.pay||0)-b.stake),0),sp={};
  for(const b of B)for(const L of b.legs)sp[L.sp]=(sp[L.sp]||0)+1;
  const d=U.lg.data,cur=d&&d.leagues.find(l=>l.code===U.lg.code)||d&&d.leagues[0];let rank=null;
  if(cur&&d.code===cur.code&&!useLast){const rows=d.rows.slice().sort((a,b)=>b.season-a.season);const i=rows.findIndex(r=>String(r.id)===String(d.me));if(i>=0)rank={pos:i+1,n:rows.length,guild:cur.name}}
  return{label:ref.toLocaleDateString("fr-FR",{month:"long",year:"numeric"}),n:B.length,w:W.length,net:Math.round(net),rate:B.length?Math.round(W.length/B.length*100):0,
    bestO:W.reduce((a,b)=>Math.max(a,b.odds),0),big:W.reduce((a,b)=>Math.max(a,(b.pay||0)-b.stake),0),sport:Object.entries(sp).sort((a,b)=>b[1]-a[1])[0],rank}}
async function monthImage(){const D=monthData(),W=1080,H=1350,cv=document.createElement("canvas");cv.width=W;cv.height=H;const c=cv.getContext("2d");
  try{await Promise.all([document.fonts.load('800 80px "Barlow Condensed"'),document.fonts.load('700 30px Barlow')])}catch(e){}
  const good=D.net>=0,SC=good?"#35d07f":"#ff5a5f";let g=c.createLinearGradient(0,0,0,H);g.addColorStop(0,"#04100a");g.addColorStop(1,"#0a2216");c.fillStyle=g;c.fillRect(0,0,W,H);
  const glow=(x,y,r,col)=>{const r2=c.createRadialGradient(x,y,0,x,y,r);r2.addColorStop(0,col);r2.addColorStop(1,"rgba(0,0,0,0)");c.fillStyle=r2;c.fillRect(0,0,W,H)};
  glow(140,-40,700,"rgba(53,208,127,.32)");glow(W-60,-60,650,"rgba(255,210,63,.22)");glow(W/2,560,520,SC+"30");
  c.save();c.globalAlpha=.07;c.fillStyle="#fff";for(const[x0,dir]of[[60,1],[W-60,-1]]){c.beginPath();c.moveTo(x0,-10);c.lineTo(x0+dir*620,H);c.lineTo(x0+dir*320,H);c.closePath();c.fill()}c.restore();
  const logo=await loadImg("logo-tribune.png?v=2");if(logo){const lw=260,lh=lw*logo.height/logo.width;c.drawImage(logo,(W-lw)/2,60,lw,lh)}
  c.textAlign="center";c.fillStyle="#9fb2a8";c.font='700 34px Barlow';c.fillText(`${(S.name||"Joueur").toUpperCase()} · MON MOIS DE ${D.label.toUpperCase()}`,W/2,250);
  c.fillStyle="#9fb2a8";c.font='700 32px Barlow';c.fillText(good?"GAGNÉ EN PARIANT 🔥":"BILAN DU MOIS 😅",W/2,340);
  c.save();c.shadowColor=SC;c.shadowBlur=45;c.fillStyle=SC;c.font='800 190px "Barlow Condensed"';c.fillText((D.net>0?"+":D.net<0?"−":"")+tok(Math.abs(D.net)),W/2,510);c.restore();
  c.fillStyle="#9fb2a8";c.font='800 46px "Barlow Condensed"';c.fillText("JETONS",W/2,568);
  if(D.rank){const t=`${D.rank.pos}${D.rank.pos===1?"ER":"E"} SUR ${D.rank.n} DANS « ${D.rank.guild.toUpperCase()} »`;c.font='800 44px "Barlow Condensed"';const w=c.measureText(t).width+70;
    c.fillStyle=D.rank.pos===1?"#ffd23f":"rgba(255,255,255,.1)";c.beginPath();c.roundRect((W-w)/2,610,w,76,38);c.fill();c.fillStyle=D.rank.pos===1?"#1b1400":"#e8efe9";c.fillText((D.rank.pos===1?"👑 ":"")+t,W/2,662)}
  const tiles=[["PARIS",tok(D.n)],["RÉUSSITE",D.rate+" %"],["GAGNÉS",tok(D.w)],["MEILLEURE COTE",D.bestO?fr(D.bestO):"—"],["PLUS GROS GAIN",D.big?"+"+tok(Math.round(D.big)):"—"],["SPORT FAVORI",D.sport?({foot:"FOOT",rugby:"RUGBY",tennis:"TENNIS",basket:"NBA"}[D.sport[0]]||"—"):"—"]];
  tiles.forEach(([k,v],i)=>{const col=i%3,row=Math.floor(i/3),x=70+col*320,y=740+row*215;c.fillStyle="#fbf8ef";c.beginPath();c.roundRect(x,y,300,190,28);c.fill();
    c.fillStyle="#7d8a83";c.font='700 26px Barlow';c.fillText(k,x+150,y+60);c.fillStyle=i===3?"#c99a0b":i===4?"#1f9d5c":"#13201a";c.font='800 72px "Barlow Condensed"';c.fillText(v,x+150,y+145)});
  c.fillStyle="#e8efe9";c.font='800 46px "Barlow Condensed"';c.fillText(good?"QUI FAIT MIEUX CE MOIS-CI ? 😏":"LE MOIS PROCHAIN SERA LE BON 💪",W/2,1225);
  c.fillStyle="#35d07f";c.font='700 30px Barlow';c.fillText((location.host+location.pathname.replace(/index\.html$/,"")).replace(/\/$/,""),W/2,1275);
  return{blob:await new Promise(ok=>cv.toBlob(ok,"image/png")),D}}
async function shareMonth(){toast("Préparation de l’image…");try{const{blob,D}=await monthImage(),file=new File([blob],"mon-mois-tribune.png",{type:"image/png"});
  if(!D.n){toast("Pas encore de pari terminé ce mois-ci.");return}
  const txt=`Mon mois de ${D.label} sur Tribune : ${D.net>=0?"+":""}${tok(D.net)} jetons en pariant 🔥`;
  if(navigator.canShare&&navigator.canShare({files:[file]})){try{await navigator.share({files:[file],text:txt})}catch(e){}return}
  const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="mon-mois-tribune.png";document.body.appendChild(a);a.click();a.remove();toast("Image enregistrée.","win")}
  catch(e){toast("Impossible de créer l’image.","bad")}}

/* ---------- animations en direct : but, carton, essai… quand il se passe quelque chose dans un match qui te concerne ---------- */
const FLASH={},FXQ=[];let fxOn=false;
const fxMine=m=>U.open===m.id||S.bets.some(b=>b.st==="open"&&b.legs.some(L=>L.mid===m.id))||!!(S.fav&&(String(m.hid)===String(S.fav.id)||String(m.aid)===String(S.fav.id)));
function liveDiff(o,m){if(!o||m.src!=="espn"||m.state!=="in"||!o.st||!m.st)return;const out=[],tm=k=>k===0?m.h:m.a;
  if(m.sp==="foot"){const key=e=>e.ty+"|"+e.id+"|"+e.min,had=new Set((o.ev||[]).map(key)),nv=(m.ev||[]).filter(e=>!had.has(key(e)));
    if(nv.length)for(const e of nv)out.push({k:e.ty,team:e.s!=null?tm(e.ty==="og"?1-e.s:e.s):"",who:e.n,min:e.min});
    else{const a=o.st.g||[0,0],b=m.st.g||[0,0];for(const k of [0,1])for(let i=a[k];i<b[k];i++)out.push({k:"g",team:tm(k),min:m.min})}}
  else if(m.sp==="rugby"){const a=o.st.pts||[0,0],b=m.st.pts||[0,0];for(const k of [0,1]){const d=b[k]-a[k];if(d<=0)continue;
    out.push({k:d>=7?"try7":d>=5?"try":d===3?"pen":d===2?"conv":"pts",team:tm(k),d,min:m.min})}}
  if(!out.length)return;FLASH[m.id]={at:Date.now(),k:out[out.length-1].k};
  if(fxMine(m))for(const e of out)FXQ.push({...e,m:{h:m.h,a:m.a,sc:(m.st.g||m.st.pts||[0,0]).slice()}});fxNext()}
const FXT={g:["BUUUT !","⚽","#35d07f"],og:["CONTRE SON CAMP !","⚽","#ff7a45"],yc:["CARTON JAUNE","card","#ffd23f"],rc:["CARTON ROUGE","card","#ff4040"],
  try:["ESSAI !","🏉","#ff7a45"],try7:["ESSAI TRANSFORMÉ !","🏉","#ff7a45"],pen:["PÉNALITÉ !","🎯","#5fa8ff"],conv:["TRANSFORMATION","🎯","#5fa8ff"],pts:["POINTS !","🏉","#ff7a45"]};
function fxNext(){if(fxOn||!FXQ.length||document.hidden)return;const e=FXQ.shift(),[title,icon,col]=FXT[e.k]||FXT.g;fxOn=true;
  const el=document.createElement("div");el.className="fx fx-"+e.k;el.style.setProperty("--fc",col);
  el.innerHTML=`<div class="fxbg"></div><div class="fxin">${icon==="card"?`<div class="fxcard"></div>`:`<div class="fxic">${icon}</div>`}<b class="fxt">${title}</b>
    <div class="fxs">${e.team?esc(e.team):""}${e.who?` · ${esc(e.who)}`:""}${e.min?` · ${e.min}’`:""}</div><div class="fxsc">${esc(e.m.h)} <b>${e.m.sc[0]} – ${e.m.sc[1]}</b> ${esc(e.m.a)}</div></div>`;
  document.body.appendChild(el);try{if(navigator.vibrate)navigator.vibrate(e.k==="rc"?[80,60,80,60,200]:e.k==="g"||e.k.startsWith("try")?[120,60,120]:[100])}catch(x){}
  if(e.k==="g"||e.k.startsWith("try"))setTimeout(confetti,250);
  el.addEventListener("click",()=>el.classList.add("out"));setTimeout(()=>el.classList.add("out"),2900);setTimeout(()=>{el.remove();fxOn=false;fxNext()},3300)}
document.addEventListener("visibilitychange",()=>{if(!document.hidden)setTimeout(fxNext,600)});

/* ---------- mon style : bannière, couleur du pseudo, titre (débloqués en jouant, vérifiés par le serveur) ---------- */
const nameH=(name,cos)=>{const e=cos&&cos.e&&cosEmoji(cos.e);return`<span class="${cos&&cos.c&&cos.c!=="c0"?"nc-"+cos.c:""}">${esc(name)}</span>${e?`<span class="nemo e-${cos.e}">${e}</span>`:""}`};
const frC=cos=>cos&&cos.f&&cos.f!=="f0"?" fr-"+cos.f:"";
// effet quand un de mes paris passe
const WFX={v12:["🦴","🐾","🦴","🌭"],v11:["❄️","❄️","❅","❆"],v10:["🪶","🪶","🪶"],v1:["⚽"],v2:["🎈","🎈","🎉"],v3:["🎆","🎇","✨"],v4:["🪙","🪙","💰"],v5:["⚡","⚡","🌩️"],v6:["👑","✨"],v7:["💸","💵","💶"],v8:["🔥","🔥","💥"],v9:["🌱","🌸","🌼"]};
function winFx(v){v=v||(S.cos&&S.cos.v);if(!v||v==="v0"||!WFX[v]){confetti();return}if(matchMedia("(prefers-reduced-motion: reduce)").matches)return;
  const c=document.createElement("div");c.className="erain";const E=WFX[v],up=v==="v2";
  for(let i=0;i<38;i++){const p=document.createElement("i");p.textContent=E[i%E.length];p.style.left=Math.random()*100+"%";p.style.fontSize=(22+Math.random()*22)+"px";
    p.style.animationDelay=(Math.random()*.9)+"s";p.style.animationDuration=(1.6+Math.random()*1.4)+"s";if(up)p.classList.add("up");c.appendChild(p)}
  if(v==="v5"){c.classList.add("flash")}
  if(v==="v10"){c.classList.add("raven");for(let i=0;i<9;i++){const r=document.createElement("b");r.textContent="🐦‍⬛";r.style.top=(8+Math.random()*70)+"%";r.style.fontSize=(30+Math.random()*30)+"px";r.style.animationDelay=(Math.random()*1.2)+"s";c.appendChild(r)}}
  if(v==="v12"){c.classList.add("teckel");for(let i=0;i<6;i++){const r=document.createElement("b");r.style.top=(10+Math.random()*70)+"%";const k=.7+Math.random()*.6;r.style.width=150*k+"px";r.style.height=65*k+"px";r.style.animationDelay=(Math.random()*1.3)+"s";c.appendChild(r)}}
  document.body.appendChild(c);setTimeout(()=>c.remove(),4000)}
const ttlH=cos=>{const t=cos&&cos.t&&cosTitle(cos.t);return t?`<span class="ttl${cos.y&&cos.y!=="y0"?" ty-"+cos.y:""}">${esc(t)}</span>`:""};
// finitions « mini-carte » (même métal, liserés et reflet que la carte de joueur) pour le haut des profils
const MC_K={"BRONZE":"bronze","ARGENT":"argent","OR":"or","ÉLITE":"elite","LÉGENDE":"legende"};
function mcInfo(bets,xp){let C;try{C=cardStats(bets||[],xp)}catch(e){C={note:40}}const T=CARD_T.find(x=>C.note>=x[0]);
  return{cls:" mcard mt-"+MC_K[T[1]],fx:`<i class="hfx"></i><i class="hho"></i>`,note:(tag="div",act="")=>`<${tag} class="mcnote"${act?` data-act="${act}" aria-label="Ma carte de joueur"`:""}><b>${C.note}</b><small>${T[1]}</small></${tag}>`}}
const bnC=cos=>cos&&cos.b&&cos.b!=="b0"&&COS.some(x=>x[0]===cos.b)?" bnr bn-"+cos.b:"";
async function loadCos(){if(!S.tok)return null;try{const j=await api("cos_get",{});U.cosD=j;S.cos=j.cos||{};saveLocal();return j}catch(e){return null}}
async function openStyle(){U.open="style";U.cosTab=U.cosTab||"b";const head=`<div class="grab"><h3>Mon style</h3><button class="x" data-act="close" aria-label="Fermer">${ic("x")}</button></div>`;
  layerLater(head+`<div class="skel" style="height:160px"></div><div class="skel"></div>`);const j=await loadCos();if(U.open!=="style")return;
  if(!j){layer(head+`<div class="empty">${ic("info")}<b>Pas de connexion</b>Réessaie dans un instant.</div>`);return}
  U.cosEdit={b:"b0",c:"c0",t:"t0",f:"f0",e:"e0",v:"v0",y:"y0",...Object.fromEntries(Object.entries(j.cos||{}).filter(([,v])=>v))};layer(viewStyle())}
function viewStyle(){const j=U.cosD,E=U.cosEdit,un=new Set(j.unlocked),T=U.cosTab,LV=myLv();
  const vis=x=>!(COS_SECRET.includes(x[3])&&!un.has(x[0]));
  const items=COS.filter(x=>x[1]===T&&vis(x)).map(x=>({id:x[0],n:x[2],d:x[4],ok:un.has(x[0]),sec:COS_SECRET.includes(x[3]),pk:x[3]}));
  if(T==="t")for(const id of j.unlocked)if(id.startsWith("tm:"))items.splice(1,0,{id,n:cosTitle(id),d:"",ok:true});
  const tm=ty=>ty==="t"?j.unlocked.filter(x=>x.startsWith("tm:")).length:0,cnt=ty=>ty==="h"?(S.fav?"choisie":"aucune"):`${COS.filter(x=>x[1]===ty&&un.has(x[0])).length+tm(ty)}/${COS.filter(x=>x[1]===ty&&vis(x)).length+tm(ty)}`;
  const prev={b:E.b,c:E.c,t:T==="y"&&(!E.t||E.t==="t0")?"t2":E.t,f:E.f,e:E.e,v:E.v,y:E.y};
  return`<div class="grab"><h3>Mon style</h3><button class="x" data-act="close" aria-label="Fermer">${ic("x")}</button></div>
  ${j.flags.all?`<p class="testr">🧪 Mode testeur : tout est débloqué pour toi.</p>`:""}
  ${(()=>{const MC=mcInfo(S.bets,S.xp);return`<div class="pcard chero stprev${MC.cls}${bnC(prev)}">${MC.fx}<div class="mctop">${MC.note()}<div class="who">${avatar(S.pid||"me",S.name||"?",S.avv,"av"+frC(prev),true)}<div><h2>${nameH(S.name||"Joueur",prev)}</h2>${ttlH(prev)}<span class="div">${LV.ic} ${esc(LV.tier)} · niveau ${LV.lvl}</span></div></div></div></div>`})()}
  <div class="sttabs">${[["b","🖼️ Bannières"],["c","🎨 Couleurs"],["t","🏷️ Titres"],["y","✨ Style du titre"],["f","⭕ Cadres"],["e","😎 Emojis"],["v","🎉 Victoire"],["h","❤️ Équipe"]].map(([k,n])=>`<button data-act="sttab" data-v="${k}" aria-pressed="${T===k}">${n}<small>${cnt(k)}</small></button>`).join("")}</div>
  ${T==="h"?`<div class="stfav">${S.fav?`<div class="stfavc">${S.fav.logo?`<img src="${esc(S.fav.logo)}" alt="">`:"❤️"}<div><b>${esc(S.fav.name)}</b><small>Ton équipe de cœur</small></div></div>`:`<p class="note" style="text-align:left">Pas encore d’équipe de cœur.</p>`}
    <p class="note" style="text-align:left">Ses matchs remontent en premier sur l’accueil, tu reçois un rappel à midi quand elle joue, et son écusson peut s’afficher sur ta carte de joueur (Écusson › Mon équipe).</p>
    <button class="btn gold wide" data-act="fav">❤️ ${S.fav?"Changer d’équipe":"Choisir mon équipe"}</button>${S.fav?`<button class="link" data-act="favnone" style="display:block;margin:10px auto 0">Retirer mon équipe de cœur</button>`:""}</div>`:""}
  ${T==="v"?`<p class="note" style="text-align:left">L’animation qui se lance quand un de tes paris passe. Touche un effet débloqué pour le voir.</p>`:T==="y"?`<p class="note" style="text-align:left">La couleur de ton titre (choisis aussi un titre dans 🏷️ Titres).</p>`:""}
  <div class="stgrid ${T}">${items.map(x=>`<button class="sti${x.ok?"":" lock"}${E[T]===x.id?" on":""}" data-act="stpick" data-v="${esc(x.id)}" ${x.ok?"":"aria-disabled=\"true\""}>
    ${T==="b"?`<span class="stsw bnr bn-${x.id}"></span>`:T==="c"?`<span class="stc nc-${x.id}">Aa</span>`:T==="f"?avatar(S.pid||"me",S.name||"?",S.avv,"av stav"+(x.id!=="f0"?" fr-"+x.id:""),true):T==="e"?`<span class="ste${x.pk==="corbeau"?" raven":""}">${x.id==="e0"?"∅":esc(x.n.split(" ")[0])}</span>`:T==="v"?`<span class="ste${x.pk==="corbeau"?" raven":""}">${x.id==="v0"?"🎊":esc(x.n.split(" ")[0])}</span>`:T==="y"?`<span class="ttl${x.id!=="y0"?" ty-"+x.id:""}">${esc(cosTitle(E.t&&E.t!=="t0"?E.t:"t2"))}</span>`:""}${x.sec?x.pk==="teckel"?`<span class="stsec tk">🐕 Exclusif</span>`:`<span class="stsec">🐦‍⬛ Exclusif</span>`:""}${COS_SEASON[(COS.find(y=>y[0]===x.id)||[])[3]]?`<span class="stsea">${COS_SEASON[COS.find(y=>y[0]===x.id)[3]]}</span>`:""}<b>${esc(T==="e"&&x.id!=="e0"?x.n.split(" ").slice(1).join(" "):T==="v"&&x.id!=="v0"?x.n.split(" ").slice(1).join(" "):x.n)}</b>${x.ok?"":`<small>🔒 ${esc(x.d)}</small>`}</button>`).join("")}</div>
  <button class="btn gold wide" data-act="stsave" style="margin-top:12px">Enregistrer mon style</button>
  <p class="note">Ton style se voit sur ton profil, dans les classements et dans le chat. Tout se débloque en jouant : rien ne s’achète.</p>`}
// réaffiche l'éditeur sans perdre la position des onglets ni de la liste
function styleRender(tab){const tl=$(".sttabs")?$(".sttabs").scrollLeft:0,sc=$(".sheet")?$(".sheet").scrollTop:0;layer(viewStyle());
  const T=$(".sttabs");if(T)T.scrollLeft=tl;const sh=$(".sheet");if(sh&&!tab)sh.scrollTop=sc;
  if(tab){const b=$(".sttabs [aria-pressed=true]");if(b&&T){const r=b.getBoundingClientRect(),R=T.getBoundingClientRect();if(r.left<R.left||r.right>R.right)T.scrollLeft+=r.left-R.left-16}}}
async function saveStyle(){try{const j=await api("cos_set",{...U.cosEdit});if(j.error)throw j;S.cos=j.cos;saveLocal();closeLayer();confetti();toast("🎨 Style enregistré !","win");$("#main")._html=null;render();if(U.lg.data)loadBoards()}
  catch(e){toast("Impossible d’enregistrer pour l’instant.","bad")}}

/* ---------- carte de joueur (façon carte de foot) : note sur 99 et 6 notes calculées sur les vrais paris ---------- */
function cardStats(bets,xp){const D=bets.filter(b=>["won","lost","cashed"].includes(b.st)),W=D.filter(b=>b.st==="won");
  const cl99=v=>Math.max(20,Math.min(99,Math.round(v))),lg=o=>Math.log2(Math.max(1.01,o||1.01)),avg=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;
  const rate=D.length?W.length/D.length*100:0,staked=D.reduce((a,b)=>a+b.stake,0),net=D.reduce((a,b)=>a+(b.st==="lost"?-b.stake:(b.pay||0)-b.stake),0);
  const days=new Set(bets.filter(b=>b.at>Date.now()-30*DAY).map(b=>ymd(b.at))).size,L=levelOf(xp||0);
  const S_={PRÉ:cl99(30+rate*.65),FLA:cl99(W.length?35+30*lg(avg(W.map(b=>+b.odds))):30),AUD:cl99(bets.length?30+25*lg(avg(bets.map(b=>+b.odds))):30),
    GES:cl99(staked?50+net/staked*60:40),RÉG:cl99(30+days*2.3),EXP:cl99(30+L.lvl*.7)};
  let note=cl99(S_.PRÉ*.2+S_.FLA*.15+S_.AUD*.1+S_.GES*.25+S_.RÉG*.1+S_.EXP*.2);if(D.length<5)note=Math.min(note,59);
  const sp={};for(const b of bets)for(const x of b.legs)sp[x.sp]=(sp[x.sp]||0)+1;const main=Object.entries(sp).sort((a,b)=>b[1]-a[1])[0];
  return{note,stats:S_,n:D.length,lvl:L.lvl,tier:L.tier,sport:main?{foot:"FOOT",rugby:"RUGBY",tennis:"TENNIS",basket:"NBA"}[main[0]]||"":""}}
const CARD_T=[[90,"LÉGENDE",["#2a0d5c","#7a3cff","#ffd23f"],"#ffe680"],[80,"ÉLITE",["#0b1d3a","#123a6b","#d4a017"],"#ffd23f"],[70,"OR",["#7a5a00","#e0b02a","#fff1a8"],"#2a1d00"],
  [60,"ARGENT",["#5f6b74","#c9d3dc","#f4f7f9"],"#1f262b"],[0,"BRONZE",["#5a3417","#b0753c","#e8b27a"],"#2a1608"]];
// palettes « métal » par rang : fond (4 teintes), encre, liseré (3 teintes), holographique
// textures dessinées par rang (images), posées sur la forme de la carte
// bannières illustrées (une image 3:2 : bande pour le profil, centre pour la carte)
const BN_TEX={b1:"bn/b1-c.webp?v=1",b2:"bn/b2-c.webp?v=1",b3:"bn/b3-c.webp?v=1",b4:"bn/b4-c.webp?v=1",b5:"bn/b5-c.webp?v=1",b6:"bn/b6-c.webp?v=1",b7:"bn/b7-c.webp?v=1",b8:"bn/b8-c.webp?v=1",b9:"bn/b9-c.webp?v=1",b10:"bn/b10-c.webp?v=1",b11:"bn/b11-c.webp?v=1",b12:"bn/b12-c.webp?v=1",b13:"bn/b13-c.webp?v=1",b14:"bn/b14-c.webp?v=1",b15:"bn/b15-c.webp?v=1",b16:"bn/b16-c.webp?v=1",b17:"bn/b17-c.webp?v=1",b18:"bn/b18-c.webp?v=1",b19:"bn/b19-c.webp?v=1",b22:"bn/b22-c.webp?v=1",b20:"bn/b20-c.webp?v=1",b21:"bn/b21-c.webp?v=1"};
// étincelles sur la carte « Ma bannière » : 0 sobre, 1 quelques-unes, 2 beaucoup (bannières rares)
const BN_FX={b20:1,b21:1,b5:1,b6:1,b7:1,b9:1,b12:1,b18:1,b19:1};
// encre adaptée quand la texture dessinée est sombre
const CARD_INK={"BRONZE":"#ffe8cf","OR":"#fff3d0"};
const CARD_TEX={"BRONZE":"card-bronze.webp?v=3","ARGENT":"card-argent.webp?v=1","OR":"card-or.webp?v=3","ÉLITE":"card-elite.webp?v=1","LÉGENDE":"card-legende.webp?v=1"};
const CARD_P={"BRONZE":{bg:["#4a2710","#a8682f","#e6a868","#7a4520"],ink:"#2a1406",trim:["#ffd9b0","#8a4f24","#f3c79a"],holo:0},
  "ARGENT":{bg:["#59626b","#c3ccd5","#f5f8fb","#8a949e"],ink:"#1a2026",trim:["#ffffff","#7d8892","#e6ebf0"],holo:0},
  "OR":{bg:["#7a5300","#e0ab1c","#fff0a6","#b8860b"],ink:"#2a1c00",trim:["#fff7cf","#9c7000","#ffe27a"],holo:0},
  "ÉLITE":{bg:["#03070f","#0f2b55","#0a1c38","#020509"],ink:"#ffd23f",trim:["#fff1a8","#a87b00","#ffd23f"],holo:1},
  "LÉGENDE":{bg:["#14042e","#5b1fb0","#2a0a5c","#0b0219"],ink:"#ffe9a0",trim:["#fff6c8","#c7952a","#ffd23f"],holo:2}};
async function playerCard(p,o){o=o||{};const C=cardStats(p.bets||[],p.xp),T=(()=>{const real=CARD_T.find(x=>C.note>=x[0]),ch=o.rk&&o.rk!=="auto"&&CARD_T.find(x=>x[1]===o.rk);return ch&&ch[0]<=real[0]?ch:real})(),BNK=o.d==="bn"&&p.cos&&p.cos.b&&p.cos.b!=="b0"?p.cos.b:"",BNT=BNK&&BN_TEX[BNK],BC=BNK&&!BNT&&BN_COL[BNK];
  const P=BC?{bg:[BC[0],BC[1],BC[0],BC[1]],ink:"#fff8ec",trim:["#ffffff","#9a9a9a","#f0f0f0"],holo:1,glow:[BC[2],BC[3]]}:BNT?{...CARD_P["LÉGENDE"],ink:"#fff6e0",holo:BN_FX[BNK]||0}:(CARD_TEX[T[1]]&&CARD_INK[T[1]]?{...CARD_P[T[1]],ink:CARD_INK[T[1]]}:CARD_P[T[1]]);
  const W=720,H=1000,K=o.scale||1,cv=document.createElement("canvas");cv.width=W*K;cv.height=H*K;const c=cv.getContext("2d"),ink=P.ink;c.scale(K,K);
  try{await Promise.all([document.fonts.load('800 80px "Barlow Condensed"'),document.fonts.load('700 30px Barlow'),document.fonts.load('600 30px Barlow')])}catch(e){}
  let sd=0;for(const ch of String(p.name||"x"))sd=(sd*31+ch.charCodeAt(0))>>>0;const rnd=()=>(sd=(sd*1664525+1013904223)>>>0)/4294967296;
  // silhouette façon carte de foot : épaules découpées, pointe en bas
  const shape=(k=1)=>{c.save();c.translate(W/2,H/2);c.scale(k,k);c.translate(-W/2,-H/2);c.beginPath();
    c.moveTo(48,128);c.quadraticCurveTo(48,64,112,56);c.lineTo(250,44);c.quadraticCurveTo(300,40,326,22);c.quadraticCurveTo(360,6,394,22);c.quadraticCurveTo(420,40,470,44);
    c.lineTo(608,56);c.quadraticCurveTo(672,64,672,128);c.lineTo(672,770);c.quadraticCurveTo(672,850,590,890);c.lineTo(392,978);c.quadraticCurveTo(360,992,328,978);c.lineTo(130,890);c.quadraticCurveTo(48,850,48,770);c.closePath();c.restore()};
  c.clearRect(0,0,W,H);
  // ombre portée
  c.save();c.shadowColor="rgba(0,0,0,.55)";c.shadowBlur=40;c.shadowOffsetY=16;shape();c.fillStyle=P.bg[1];c.fill();c.restore();
  // fond métal
  c.save();shape();c.clip();
  let g=c.createLinearGradient(0,0,W*.4,H);P.bg.forEach((x,i)=>g.addColorStop(i/3,x));c.fillStyle=g;c.fillRect(0,0,W,H);
  // texture dessinée du rang (si disponible) à la place des facettes et rayures
  const TX=BNT?await loadImg(BNT).catch(()=>null):!BC&&CARD_TEX[T[1]]?await loadImg(CARD_TEX[T[1]]).catch(()=>null):null;
  if(TX){const s=Math.max(W/TX.width,H/TX.height);c.drawImage(TX,(W-TX.width*s)/2,(H-TX.height*s)/2,TX.width*s,TX.height*s);
    // le bas de la texture est éclairci pour que le texte foncé reste lisible
    // texture gardée telle quelle ; le texte reçoit un halo (clair sous une encre foncée, sombre sous une encre claire) pour rester lisible partout
    const ft=c.fillText.bind(c),light=parseInt(P.ink.slice(1,3),16)>128;
    c.fillText=(t,x,y,...r)=>{const fs=parseFloat((c.font.match(/(\d+(?:\.\d+)?)px/)||[])[1]||20),col=c.fillStyle,d=Math.max(1.2,fs*.045);c.save();
      c.shadowColor="rgba(0,0,0,.6)";c.shadowBlur=Math.max(2,fs*.08);c.shadowOffsetY=d*1.6;c.fillStyle=light?"rgba(20,10,0,.9)":"rgba(0,0,0,.55)";ft(t,x,y+d*.6,...r);c.restore();
      c.save();c.fillStyle=light?"rgba(255,255,255,.18)":"rgba(255,250,235,.55)";ft(t,x,y-d*.7,...r);c.restore();
      c.save();let g=col;if(typeof col==="string"){g=c.createLinearGradient(0,y-fs*.85,0,y+fs*.1);const lt=light;
        g.addColorStop(0,lt?"#fff8d8":"#5a4a38");g.addColorStop(.45,col);g.addColorStop(1,lt?"#b98a1c":"#120a02")}c.fillStyle=g;ft(t,x,y,...r);c.restore()}}
  if(P.glow)for(const[x,y,col]of[[W*.2,160,P.glow[0]],[W*.85,H*.7,P.glow[1]]]){const r=c.createRadialGradient(x,y,10,x,y,460);r.addColorStop(0,col);r.addColorStop(1,"transparent");c.fillStyle=r;c.fillRect(0,0,W,H)}
  // facettes de cristal
  if(!TX)for(let i=0;i<9;i++){c.beginPath();const x=rnd()*W,y=rnd()*H*.9;c.moveTo(x,y);c.lineTo(x+(rnd()-.5)*520,y+(rnd()-.2)*420);c.lineTo(x+(rnd()-.5)*520,y+(rnd()-.2)*420);c.closePath();c.fillStyle=rnd()<.5?"rgba(255,255,255,.07)":"rgba(0,0,0,.07)";c.fill()}
  // fines rayures
  c.globalAlpha=TX?0:.06;c.strokeStyle="#fff";c.lineWidth=2;for(let x=-H;x<W;x+=16){c.beginPath();c.moveTo(x,0);c.lineTo(x+H*.55,H);c.stroke()}c.globalAlpha=1;
  if(P.holo&&!TX){c.globalCompositeOperation="overlay";g=c.createLinearGradient(0,0,W,H);["#ff5e7e","#ffd23f","#5cffb0","#5fa8ff","#c77dff","#ff5e7e"].forEach((x,i,a)=>g.addColorStop(i/(a.length-1),x));c.globalAlpha=P.holo>1?.42:.28;c.fillStyle=g;c.fillRect(0,0,W,H);c.globalAlpha=1;c.globalCompositeOperation="source-over";}
  // lumière derrière le joueur
  let r=c.createRadialGradient(470,250,20,470,250,330);r.addColorStop(0,`rgba(255,255,255,${TX?0:.38})`);r.addColorStop(1,"rgba(255,255,255,0)");c.fillStyle=r;c.fillRect(0,0,W,H);
  // dessin de la bannière en filigrane
  if(BC){const art=await bnArt(BNK);if(art){c.globalAlpha=.16;const aw=W*.86,ah=aw*art.height/art.width;c.drawImage(art,W/2-aw/2,775-ah/2,aw,ah);c.globalAlpha=1}}
  // photo détourée, fondue vers le bas
  let img=null;try{const src=p.me&&S.avatar?S.avatar:p.av?avUrl(p.id,p.av):"";if(src)img=await loadImg(src)}catch(e){}
  {const px=262,py=66,pw=390,ph=440,o2=document.createElement("canvas");o2.width=pw;o2.height=ph;const oc=o2.getContext("2d");
    if(img){const s=Math.max(pw/img.width,ph/img.height),iw=img.width*s,ih=img.height*s;oc.drawImage(img,(pw-iw)/2,(ph-ih)/2.6,iw,ih)}
    else if(!TX){oc.fillStyle=ink;oc.globalAlpha=.9;oc.textAlign="center";oc.font='800 300px "Barlow Condensed"';oc.fillText((p.name||"?")[0].toUpperCase(),pw/2,ph*.78)}
    oc.globalCompositeOperation="destination-in";const fg=oc.createLinearGradient(0,0,0,ph);fg.addColorStop(0,"rgba(0,0,0,0)");fg.addColorStop(.07,"rgba(0,0,0,1)");fg.addColorStop(.68,"rgba(0,0,0,1)");fg.addColorStop(1,"rgba(0,0,0,0)");oc.fillStyle=fg;oc.fillRect(0,0,pw,ph);
    const sg=oc.createLinearGradient(0,0,pw,0);sg.addColorStop(0,"rgba(0,0,0,0)");sg.addColorStop(.14,"rgba(0,0,0,1)");sg.addColorStop(.9,"rgba(0,0,0,1)");sg.addColorStop(1,"rgba(0,0,0,0)");oc.fillStyle=sg;oc.fillRect(0,0,pw,ph);
    c.drawImage(o2,px,py);
    // initiale en relief (sans photo, sur une carte en métal)
    if(!img&&TX){c.save();c.fillStyle=ink;c.textAlign="center";c.font='800 300px "Barlow Condensed"';c.fillText((p.name||"?")[0].toUpperCase(),px+pw/2,py+ph*.78);c.restore()}}
  // bandeau du nom
  g=c.createLinearGradient(0,500,0,640);g.addColorStop(0,"rgba(0,0,0,0)");g.addColorStop(.5,ink===P.ink&&!["#ffd23f","#ffe9a0","#fff8ec"].includes(ink)?"rgba(255,255,255,.18)":"rgba(0,0,0,.28)");g.addColorStop(1,"rgba(0,0,0,0)");c.fillStyle=g;c.fillRect(0,500,W,140);
  // reflet du haut + vignette
  g=c.createLinearGradient(0,0,0,H*.45);g.addColorStop(0,"rgba(255,255,255,.28)");g.addColorStop(1,"rgba(255,255,255,0)");c.fillStyle=g;c.fillRect(0,0,W,H);
  r=c.createRadialGradient(W/2,H*.45,H*.35,W/2,H*.45,H*.75);r.addColorStop(0,"rgba(0,0,0,0)");r.addColorStop(1,"rgba(0,0,0,.45)");c.fillStyle=r;c.fillRect(0,0,W,H);
  // holographique (élite, légende, bannière)
  if(P.holo){
    for(let i=0;i<(P.holo>1?26:14);i++){const x=60+rnd()*(W-120),y=60+rnd()*(H-200),s=3+rnd()*9;c.fillStyle=`rgba(255,255,255,${.5+rnd()*.5})`;c.beginPath();c.moveTo(x,y-s);c.quadraticCurveTo(x,y,x+s,y);c.quadraticCurveTo(x,y,x,y+s);c.quadraticCurveTo(x,y,x-s,y);c.quadraticCurveTo(x,y,x,y-s);c.fill()}}
  c.restore();
  // liserés en relief
  g=c.createLinearGradient(0,0,W,H);g.addColorStop(0,P.trim[0]);g.addColorStop(.45,P.trim[1]);g.addColorStop(.7,P.trim[2]);g.addColorStop(1,P.trim[1]);
  shape();c.lineWidth=14;c.strokeStyle=g;c.stroke();shape();c.lineWidth=3;c.strokeStyle="rgba(0,0,0,.35)";c.stroke();
  shape(.945);c.lineWidth=2.5;c.strokeStyle=g;c.globalAlpha=.75;c.stroke();c.globalAlpha=1;
  // colonne de gauche : note, sport, écusson, rang
  const txt=(t,x,y,f,col=ink,al="center")=>{c.font=f;c.textAlign=al;c.fillStyle=col;c.fillText(t,x,y)};
  c.save();c.shadowColor="rgba(0,0,0,.25)";c.shadowBlur=6;c.shadowOffsetY=3;
  txt(String(C.note),160,232,'800 150px "Barlow Condensed"');// sous la note : le titre de niveau (Habitué, Ultra, Capo…), réduit s'il est long
  const spL=String(C.tier||"").toUpperCase();if(spL){let fs=44;c.font=`800 ${fs}px "Barlow Condensed"`;while(fs>24&&c.measureText(spL).width>150){fs-=2;c.font=`800 ${fs}px "Barlow Condensed"`}txt(spL,160,284,`800 ${fs}px "Barlow Condensed"`)}c.restore();const up=spL?0:-50;c.save();c.translate(0,up);
  c.fillStyle=ink;c.globalAlpha=.6;c.fillRect(118,304,84,3);c.globalAlpha=1;
  let by=320;if(o.bd==="fav"&&p.fav&&p.fav.logo){const L=await loadImgX(p.fav.logo);if(L){c.drawImage(L,122,by,76,76);by+=92}}
  else if(o.bd==="emo"){const em=p.cos&&p.cos.e&&cosEmoji(p.cos.e);if(em){txt(em,160,by+64,'66px serif');by+=92}}
  c.fillStyle=ink;c.globalAlpha=.6;if(by>320)c.fillRect(118,by,84,3);c.globalAlpha=1;
  txt(T[1],160,by+44,'800 30px "Barlow Condensed"');c.restore();
  // nom
  let nm=(p.name||"Joueur").toUpperCase(),fs=92;c.font=`800 ${fs}px "Barlow Condensed"`;while(c.measureText(nm).width>W-170&&fs>54){fs-=4;c.font=`800 ${fs}px "Barlow Condensed"`}
  c.save();c.shadowColor="rgba(0,0,0,.3)";c.shadowBlur=8;c.shadowOffsetY=3;txt(nm,W/2,590,`800 ${fs}px "Barlow Condensed"`);c.restore();
  // ornement
  c.fillStyle=ink;c.globalAlpha=.75;c.fillRect(130,614,205,2.5);c.fillRect(W-335,614,205,2.5);c.beginPath();c.moveTo(W/2,603);c.lineTo(W/2+12,615);c.lineTo(W/2,627);c.lineTo(W/2-12,615);c.closePath();c.fill();c.globalAlpha=1;
  const tt=o.sub!=="lvl"&&p.cos&&p.cos.t&&cosTitle(p.cos.t);txt(tt?tt:`Niveau ${C.lvl}`,W/2,664,'600 29px Barlow');
  // statistiques
  const ks=Object.keys(C.stats);ks.forEach((k,i)=>{const col=i<3?0:1,row=i%3,x=col?W/2+58:178,y=730+row*62;
    txt(String(C.stats[k]),x+30,y,'800 60px "Barlow Condensed"',ink,"right");c.globalAlpha=.85;txt(k,x+44,y,'700 34px "Barlow Condensed"',ink,"left");c.globalAlpha=1});
  c.fillStyle=ink;c.globalAlpha=.45;c.fillRect(W/2-1.5,688,3,170);c.globalAlpha=1;
  // pied : logo et nombre de paris
  const logo=await loadImg("logo-tribune.png?v=2");if(logo){const lw=66,lh=lw*logo.height/logo.width;let li=logo;if(!["#ffd23f","#ffe9a0","#fff8ec"].includes(ink)){const o3=document.createElement("canvas");o3.width=logo.width;o3.height=logo.height;const oc=o3.getContext("2d");oc.drawImage(logo,0,0);oc.globalCompositeOperation="source-in";oc.fillStyle=ink;oc.fillRect(0,0,o3.width,o3.height);li=o3}
    c.globalAlpha=.9;c.drawImage(li,W/2-lw/2,868,lw,lh);c.globalAlpha=1}
  txt(`${C.n} PARI${C.n>1?"S":""}`,W/2,944,'800 20px "Barlow Condensed"');
  return{blob:await new Promise(ok=>cv.toBlob(ok,"image/png")),C,T}}
function refDone(j){try{localStorage.removeItem("dap.ref")}catch(e){}if(j&&j.parrain){S.refBy=j.parrain;saveLocal();setTimeout(claimGifts,2500)}}
async function wrefFill(){const b=$("#wref"),rc=refStored();if(!b)return;try{const j=await api("ref_info",rc?{code:rc}:{pending:1});if(j.name&&j.code&&$("#w-ref")&&!$("#w-ref").value)$("#w-ref").value=j.code;if(j.name&&$("#wref"))$("#wref").innerHTML=`<div class="refban">🎁 <span><b>Invité par ${esc(j.name)}</b><br>+${tok(j.gets)} jetons de bienvenue en plus des 1 000 de départ.</span></div>`}catch(e){}}
async function openRef(){U.open="ref";const head=`<div class="grab"><h3>Parrainer un ami</h3><button class="x" data-act="close" aria-label="Fermer">${ic("x")}</button></div>`;
  layerLater(head+`<div class="skel" style="height:140px"></div><div class="skel"></div>`);
  try{if(!(await ensureSession()))throw 0;const j=await api("ref_get",{});if(U.open!=="ref")return;U.ref=j;const ok=j.friends.filter(f=>f.ok).length;
    layer(head+`<div class="refhero"><div class="refgift">🎁</div><p><b>Invite tes amis sur Tribune</b></p>
      <div class="refrw"><div><b>+${tok(j.gets)}</b><small>pour ton ami, dès son inscription</small></div><div><b>+${tok(j.give)}</b><small>pour toi, quand il a joué ses ${j.need} premiers paris</small></div></div></div>
      <div class="xcode"><small>Ton code de parrainage</small><b>${esc(j.code)}</b></div>
      <button class="btn gold wide" data-act="refshare">${ic("share")} Envoyer mon lien d’invitation</button>
      <div class="grp">Mes filleuls${j.friends.length?` · ${ok} validé${ok>1?"s":""} · +${tok(j.earned)} gagnés`:""}</div>
      ${j.friends.length?`<div class="reflist">${j.friends.map(f=>`<div class="refrow">${avatar(f.id,f.name,f.av,"av")}<span><b>${esc(f.name)}</b><small>${f.ok?"✅ Parrainage validé : +"+tok(j.give)+" pour toi":`${f.n} / ${j.need} paris terminés`}</small></span>${f.ok?"":`<i class="refbar"><i style="width:${f.n/j.need*100}%"></i></i>`}</div>`).join("")}</div>`
        :`<div class="empty">${ic("group")}<b>Pas encore de filleul</b>Envoie ton lien : ton ami l’ouvre, installe l’app et crée son compte, c’est tout.</div>`}
      <p class="note">Jusqu’à ${j.max} parrainages récompensés. Les jetons restent fictifs. À 3 amis validés, tu débloques le titre « 🤝 Recruteur ».</p>`)}
  catch(e){if(U.open==="ref")layer(head+`<div class="empty">${ic("info")}<b>Pas de connexion</b>Réessaie dans un instant.</div>`)}}
async function refShare(){const j=U.ref;if(!j)return;const url=APP_URL+"?parrain="+j.code,text=`Viens jouer avec moi sur Tribune 🏆 Paris sportifs gratuits entre amis (jetons fictifs). Avec mon lien tu reçois +${j.gets} jetons de bienvenue (mon code de parrainage : ${j.code}) :`;
  try{if(navigator.share){await navigator.share({title:"Tribune",text,url});return}}catch(e){if(e&&e.name==="AbortError")return}
  try{await navigator.clipboard.writeText(text+" "+url);toast("Lien copié : colle-le à ton ami !","win")}catch(e){prompt("Copie ce lien :",url)}}
// carte 3D : on l'incline avec le doigt (ou en bougeant le téléphone), un reflet suit la lumière
function cardTilt(){const w=$("#tilt");if(!w)return;let tx=0,ty=0,cx=0,cy=0,act=false,raf=0,t0=performance.now();
  const set=()=>{cx+=(tx-cx)*.16;cy+=(ty-cy)*.16;const idle=act?0:1,t=(performance.now()-t0)/1000,ix=cx+idle*Math.sin(t*.8)*5,iy=cy+idle*Math.cos(t*.6)*4;
    w.style.transform=`rotateX(${iy}deg) rotateY(${ix}deg)`;w.style.setProperty("--gx",(50+ix*2.6)+"%");w.style.setProperty("--gy",(50-iy*2.6)+"%");w.style.setProperty("--go",(.25+Math.min(1,Math.hypot(ix,iy)/18)*.55).toFixed(2));
    if(document.body.contains(w))raf=requestAnimationFrame(set)};raf=requestAnimationFrame(set);
  const mv=e=>{const r=w.getBoundingClientRect(),x=(e.clientX-r.left)/r.width-.5,y=(e.clientY-r.top)/r.height-.5;tx=Math.max(-1,Math.min(1,x*2))*20;ty=-Math.max(-1,Math.min(1,y*2))*20};
  w.addEventListener("pointerdown",e=>{act=true;mv(e);try{w.setPointerCapture(e.pointerId)}catch(x){}
    if(window.DeviceOrientationEvent&&typeof DeviceOrientationEvent.requestPermission==="function"&&!U.gyroAsk){U.gyroAsk=1;DeviceOrientationEvent.requestPermission().catch(()=>{})}});
  w.addEventListener("pointermove",e=>{if(act)mv(e)});
  const end=()=>{act=false;tx=0;ty=0};w.addEventListener("pointerup",end);w.addEventListener("pointercancel",end);
  let b0=null;const ori=e=>{if(act||e.beta==null||!document.body.contains(w)){if(!document.body.contains(w))removeEventListener("deviceorientation",ori);return}if(b0==null)b0=[e.beta,e.gamma];tx=Math.max(-18,Math.min(18,(e.gamma-b0[1])*.8));ty=Math.max(-18,Math.min(18,-(e.beta-b0[0])*.8))};
  addEventListener("deviceorientation",ori)}
async function openCard(p){U.open="card";U.cardP=p;const head=`<div class="grab"><h3>Carte de joueur</h3><button class="x" data-act="close" aria-label="Fermer">${ic("x")}</button></div>`;
  if(!U.cardSk)layerLater(head+`<div class="skel" style="height:420px"></div>`,200);
  const o=p.me?{d:"rang",bd:S.fav?"fav":"emo",sub:"t",sp:"auto",...(S.cardOpt||{}),...((S.cos&&S.cos.k)||{})}:{d:"rang",bd:"emo",sub:"t",sp:"auto",...((p.cos&&p.cos.k)||{})};
  try{const{blob,C,T}=await playerCard(p,o);U.cardBlob=blob;U.cardName=p.name;const url=URL.createObjectURL(blob);if(U.open!=="card")return;
    const ch=(k,v,n,ok=true)=>ok?`<button data-act="cardopt" data-k="${k}" data-v="${v}" aria-pressed="${o[k]===v}">${n}</button>`:"";
    const opts=p.me?`<div class="cdopt"><b>Design</b><div>${ch("d","rang","🏅 Mon rang")}${ch("d","bn","🖼️ Ma bannière",S.cos&&S.cos.b&&S.cos.b!=="b0")}</div>
      <b>Écusson</b><div>${ch("bd","fav","❤️ Mon équipe",!!S.fav)}${ch("bd","emo","😎 Mon emoji",!!(S.cos&&S.cos.e&&S.cos.e!=="e0"))}${ch("bd","none","Aucun")}</div>
      <b>Sous le pseudo</b><div>${ch("sub","t","🏷️ Mon titre")}${ch("sub","lvl","⭐ Mon niveau")}</div>
      <b>Rang affiché</b><div>${(()=>{const real=CARD_T.find(x=>C.note>=x[0]);return[["auto","✨ Mon rang"],["BRONZE","🥉 Bronze"],["ARGENT","🥈 Argent"],["OR","🥇 Or"],["ÉLITE","💎 Élite"],["LÉGENDE","👑 Légende"]].map(([v,n])=>{const t=CARD_T.find(x=>x[1]===v),lock=t&&t[0]>real[0];
        return lock?`<button data-act="cardlock" data-v="${t[0]}" class="lk" aria-disabled="true">🔒 ${n.split(" ")[1]}</button>`:`<button data-act="cardopt" data-k="rk" data-v="${v}" aria-pressed="${(o.rk||"auto")===v}">${n}</button>`}).join("")})()}</div>
      <small class="rkn">Tu peux afficher ton rang ou un rang inférieur. Les rangs au-dessus se débloquent avec ta note.</small></div>`:"";
    layer(head+`<div class="pcardimg"><div class="tilt" id="tilt"><img src="${url}" alt="Carte de ${esc(p.name)}"><i class="glare" style="-webkit-mask-image:url(${url});mask-image:url(${url})"></i></div></div><p class="tilthint">👆 Fais glisser ton doigt sur la carte pour la faire bouger</p>${opts}
    <p class="note">Note <b>${C.note}</b> (${T[1].toLowerCase()}) : précision, flair, audace, gestion, régularité et expérience, calculés sur les vrais paris.${p.me?" Ta bannière et ton style se changent dans « Mon style ».":""}</p>
    <button class="btn gold wide" data-act="cardshare">${ic("share")} Partager la carte</button>`);U.cardSk=0;cardTilt()}
  catch(e){U.cardSk=0;if(U.open==="card")layer(head+`<div class="empty">${ic("info")}<b>Impossible de créer la carte</b>Réessaie dans un instant.</div>`)}}
// change un réglage de la carte sans rouvrir la fenêtre : seuls les boutons et l'image se mettent à jour
async function refreshCard(k,v){const p=U.cardP;if(!p)return;document.querySelectorAll(`[data-act=cardopt][data-k="${k}"]`).forEach(b=>b.setAttribute("aria-pressed",b.dataset.v===v));
  const im=$(".pcardimg img");if(im)im.classList.add("cdbusy");const n=(U.cardN=(U.cardN||0)+1);
  try{const o={d:"rang",bd:S.fav?"fav":"emo",sub:"t",sp:"auto",...(S.cardOpt||{}),...((S.cos&&S.cos.k)||{})},{blob}=await playerCard(p,o);if(n!==U.cardN||U.open!=="card")return;U.cardBlob=blob;
    const url=URL.createObjectURL(blob),im2=$(".pcardimg img"),gl=$(".pcardimg .glare");if(gl){gl.style.webkitMaskImage=gl.style.maskImage=`url(${url})`}if(im2){const old=im2.src;im2.onload=()=>{im2.classList.remove("cdbusy");if(old.startsWith("blob:"))URL.revokeObjectURL(old)};im2.src=url}}
  catch(e){const im3=$(".pcardimg img");if(im3)im3.classList.remove("cdbusy")}}
async function shareCard(){const b=U.cardBlob;if(!b)return;const file=new File([b],"carte-tribune.png",{type:"image/png"}),txt=`Ma carte de joueur sur Tribune 🃏 ${APP_URL}`;
  if(navigator.canShare&&navigator.canShare({files:[file]})){try{await navigator.share({files:[file],text:txt})}catch(e){}return}
  const a=document.createElement("a");a.href=URL.createObjectURL(b);a.download="carte-tribune.png";document.body.appendChild(a);a.click();a.remove();toast("Carte enregistrée.","win")}

/* ---------- week-ends spéciaux (thème automatique, à tour de rôle) ---------- */
const WE=()=>weekendOf(today());
function weBanner(){const w=WE();if(!w.on&&!w.soon)return"";
  return`<div class="webox${w.on?"":" soon"}"><span class="wee">${w.e}</span><div><small>${w.on?(w.last?"Week-end spécial · dernier jour !":"Week-end spécial · jusqu’à dimanche minuit"):"Demain, week-end spécial"}</small><b>${w.n}</b><p>${w.d}</p></div></div>`}
let gfAt=0;
async function claimGifts(){if(!S.tok||Date.now()-gfAt<6e4)return;gfAt=Date.now();try{const j=await api("gifts_claim",{neg:1});if(!j.gifts||!j.gifts.length)return;
  const t=j.gifts.reduce((a,x)=>a+x.amount,0);S.bal=Math.max(0,S.bal+t);S.peak=Math.max(S.peak,S.bal);save();render();
  if(t<0){toast(`🔧 ${esc(j.gifts[0].label||"Correction du solde")} : −${tok(-t)} jetons`);return}bump();confetti();
  toast(j.gifts.length===1?`🧾 ${esc(j.gifts[0].label)} : +${tok(t)} jetons !`:`🧾 Bonus du week-end : +${tok(t)} jetons !`,"win")}catch(e){}}

/* ---------- ticket à partager (image) ---------- */
const imgX={};function loadImgX(src){return imgX[src]||(imgX[src]=new Promise(ok=>{const i=new Image();i.crossOrigin="anonymous";i.referrerPolicy="no-referrer";i.onload=()=>ok(i);i.onerror=()=>ok(null);i.src=src}))}
// dessin d'une bannière (son image SVG, lue dans la feuille de style) pour la carte de joueur
async function bnArt(k){const d=document.createElement("span");d.className="bnr bn-"+k;d.style.cssText="position:absolute;left:-9999px";document.body.appendChild(d);const bg=getComputedStyle(d).backgroundImage;d.remove();
  const m=/url\("(data:image\/svg[^"]+)"\)/.exec(bg);return m?loadImg(m[1]):null}
const imgP={};function loadImg(src){return imgP[src]||(imgP[src]=new Promise(ok=>{const i=new Image();i.onload=()=>ok(i);i.onerror=()=>ok(null);i.src=src}))}
function wrapTxt(c,t,max){const w=String(t).split(" "),L=[];let cur="";for(const x of w){const n=cur?cur+" "+x:x;if(c.measureText(n).width>max&&cur){L.push(cur);cur=x}else cur=n}if(cur)L.push(cur);return L}
// couleurs de fond des images partagées selon la bannière du joueur
const BN_COL={b1:["#0b2a17","#06140b","rgba(53,208,127,.4)","rgba(36,128,63,.4)"],b2:["#0c1d3d","#050b18","rgba(255,255,255,.18)","rgba(95,168,255,.25)"],
  b3:["#3a0800","#120300","rgba(255,122,26,.45)","rgba(255,43,43,.35)"],b4:["#14082a","#07040f","rgba(255,43,214,.35)","rgba(0,229,255,.3)"],
  b5:["#120a2e","#05030f","rgba(107,47,214,.5)","rgba(31,143,255,.4)"],b6:["#2a1a00","#0c0716","rgba(255,210,63,.45)","rgba(122,60,255,.45)"],
  b7:["#3a2a00","#120c00","rgba(255,210,63,.5)","rgba(255,230,128,.3)"],b8:["#2a3036","#0e1114","rgba(215,222,227,.35)","rgba(139,151,160,.3)"],
  b9:["#1b1032","#08051a","rgba(122,60,255,.45)","rgba(255,255,255,.15)"],b10:["#1e0909","#0a0303","rgba(255,59,59,.4)","rgba(255,59,59,.2)"],
  b11:["#0f3d1d","#051208","rgba(124,242,138,.4)","rgba(31,122,52,.4)"],b12:["#3d2a00","#120c00","rgba(255,210,63,.5)","rgba(255,210,63,.3)"],
  b13:["#2a0610","#06102a","rgba(179,18,43,.5)","rgba(18,64,179,.5)"],b14:["#2a1407","#0c0603","rgba(143,71,25,.5)","rgba(255,122,69,.3)"],
  b15:["#3a1a0a","#120804","rgba(199,91,43,.5)","rgba(255,255,255,.12)"],b16:["#3a2410","#120b04","rgba(196,139,71,.5)","rgba(255,210,63,.2)"],
  b17:["#0e3b28","#05120c","rgba(53,208,127,.4)","rgba(255,210,63,.3)"],b18:["#1a1033","#050308","rgba(143,134,255,.4)","rgba(232,226,255,.2)"],
  b21:["#b8652a","#2a170a","rgba(255,208,138,.45)","rgba(194,122,58,.35)"],b20:["#b8652a","#2a170a","rgba(255,208,138,.45)","rgba(194,122,58,.35)"],b19:["#0b1d3a","#050b18","rgba(255,255,255,.3)","rgba(255,90,95,.3)"]};
async function ticketImage(b,link){
  const W=1080,legs=b.legs.slice(0,8),more=b.legs.length-legs.length,RH=128,tkH=110+legs.length*RH+(more?50:0)+60+190,H=Math.max(1350,560+tkH+230);
  const cv=document.createElement("canvas");cv.width=W;cv.height=H;const c=cv.getContext("2d");
  try{await Promise.all([document.fonts.load('800 80px "Barlow Condensed"'),document.fonts.load('700 30px Barlow'),document.fonts.load('500 30px Barlow')])}catch(e){}
  const st=["won","lost","cashed","void"].includes(b.st)?b.st:"open",SC={won:"#35d07f",lost:"#ff5a5f",cashed:"#ffd23f",void:"#9fb2a8",open:"#5fa8ff"}[st];
  // fond : nuit de match, projecteurs, lignes du terrain
  const BC=BN_COL[S.cos&&S.cos.b]||["#04100a","#0a2216","rgba(53,208,127,.35)","rgba(255,210,63,.22)"];
  let g=c.createLinearGradient(0,0,0,H);g.addColorStop(0,BC[0]);g.addColorStop(1,BC[1]);c.fillStyle=g;c.fillRect(0,0,W,H);
  const glow=(x,y,r,col)=>{const r2=c.createRadialGradient(x,y,0,x,y,r);r2.addColorStop(0,col);r2.addColorStop(1,"rgba(0,0,0,0)");c.fillStyle=r2;c.fillRect(0,0,W,H)};
  glow(120,-40,700,BC[2]);glow(W-80,-60,650,BC[3]);glow(W/2,H+120,800,SC+"33");
  c.save();c.globalAlpha=.07;c.fillStyle="#fff";for(const [x0,dir] of [[60,1],[W-60,-1]]){c.beginPath();c.moveTo(x0,-10);c.lineTo(x0+dir*620,H);c.lineTo(x0+dir*320,H);c.closePath();c.fill()}c.restore();
  c.save();c.strokeStyle="rgba(255,255,255,.05)";c.lineWidth=4;c.beginPath();c.arc(W/2,H-40,230,0,Math.PI*2);c.stroke();c.beginPath();c.moveTo(0,H-40);c.lineTo(W,H-40);c.stroke();c.restore();
  // en-tête : logo + joueur
  const logo=await loadImg("logo-tribune.png?v=2");if(logo){const lw=300,lh=lw*logo.height/logo.width;c.drawImage(logo,(W-lw)/2,56,lw,lh)}
  c.font='700 32px Barlow';const who=`${S.name||"Joueur"}  ·  ${new Date(b.at).toLocaleDateString("fr-FR",{day:"numeric",month:"long"})}`,ww=c.measureText(who).width+110;
  c.fillStyle="rgba(255,255,255,.08)";c.beginPath();c.roundRect((W-ww)/2,250,ww,64,32);c.fill();
  c.fillStyle=avc(S.name||"?");c.beginPath();c.arc((W-ww)/2+40,282,22,0,Math.PI*2);c.fill();c.fillStyle="#04130b";c.font='800 26px Barlow';c.textAlign="center";c.fillText((S.name||"?")[0].toUpperCase(),(W-ww)/2+40,291);
  c.fillStyle="#e8efe9";c.font='700 32px Barlow';c.textAlign="left";c.fillText(who,(W-ww)/2+78,293);
  // gros chiffre
  const big=st==="won"||st==="cashed"?"+"+tok(b.pay):st==="lost"?"−"+tok(b.stake):st==="void"?tok(b.stake):tok(Math.round(b.stake*b.odds));
  const lab={won:"TICKET GAGNANT 🔥",cashed:"ENCAISSÉ À TEMPS 😎",lost:"RATÉ DE PEU… 😅",void:"REMBOURSÉ",open:"GAIN POSSIBLE 🤞"}[st];
  c.textAlign="center";c.fillStyle="#9fb2a8";c.font='700 34px Barlow';c.fillText(lab,W/2,385);
  c.save();c.font='800 150px "Barlow Condensed"';const bw=c.measureText(big).width;c.font='800 48px "Barlow Condensed"';const jw=c.measureText(" JETONS").width;const x0=(W-bw-jw)/2;
  c.textAlign="left";c.shadowColor=SC;c.shadowBlur=40;c.fillStyle=st==="open"?"#ffffff":SC;c.font='800 150px "Barlow Condensed"';c.fillText(big,x0,515);
  c.shadowBlur=0;c.fillStyle="#9fb2a8";c.font='800 48px "Barlow Condensed"';c.fillText(" JETONS",x0+bw,510);c.restore();
  // ticket papier (dessiné à part pour découper les encoches)
  const tx=80,ty=560,tw=W-160,tc=document.createElement("canvas");tc.width=tw;tc.height=tkH;const t=tc.getContext("2d");
  let pg=t.createLinearGradient(0,0,0,tkH);pg.addColorStop(0,"#fbf8ef");pg.addColorStop(1,"#efe9da");t.fillStyle=pg;t.beginPath();t.roundRect(0,0,tw,tkH,34);t.fill();
  t.fillStyle=SC;t.beginPath();t.roundRect(0,0,tw,14,[34,34,0,0]);t.fill();
  t.fillStyle="#1b2a22";t.font='800 50px "Barlow Condensed"';t.textAlign="left";t.fillText(b.legs.length>1?`COMBINÉ · ${b.legs.length} SÉLECTIONS`:"PARI SIMPLE",44,82);
  let y=110;const spE={foot:"⚽",rugby:"🏉",tennis:"🎾",basket:"🏀"};
  legs.forEach((L,i)=>{if(i){t.fillStyle="rgba(0,0,0,.08)";t.fillRect(44,y,tw-88,2)}
    const r=L.r==="w"?["✓","#1f9d5c"]:L.r==="l"?["✗","#d93a3f"]:L.r==="v"?["↺","#7d8a83"]:[null,null];
    t.fillStyle=r[1]?r[1]+"22":"rgba(0,0,0,.06)";t.beginPath();t.arc(84,y+RH/2,36,0,Math.PI*2);t.fill();
    t.textAlign="center";if(r[0]){t.fillStyle=r[1];t.font='800 44px Barlow';t.fillText(r[0],84,y+RH/2+15)}else{t.font='40px sans-serif';t.fillText(spE[L.sp]||"⚽",84,y+RH/2+14)}
    t.textAlign="left";t.fillStyle="#13201a";t.font='700 38px Barlow';t.fillText(wrapTxt(t,L.l,tw-420)[0],140,y+RH/2-6);
    t.fillStyle="#6b7a72";t.font='500 28px Barlow';t.fillText(wrapTxt(t,L.ml||L.mt||"",tw-420)[0],140,y+RH/2+34);
    t.font='800 46px "Barlow Condensed"';const ot=fr(L.o),ow=t.measureText(ot).width+44;t.fillStyle="#13201a";t.beginPath();t.roundRect(tw-44-ow,y+RH/2-34,ow,68,34);t.fill();
    t.fillStyle="#ffd23f";t.textAlign="center";t.fillText(ot,tw-44-ow/2,y+RH/2+16);y+=RH});
  if(more){t.textAlign="left";t.fillStyle="#6b7a72";t.font='600 30px Barlow';t.fillText(`+ ${more} autres sélections`,140,y+34);y+=50}
  // pointillés + encoches
  y+=30;t.strokeStyle="rgba(0,0,0,.25)";t.lineWidth=4;t.setLineDash([14,14]);t.beginPath();t.moveTo(50,y);t.lineTo(tw-50,y);t.stroke();t.setLineDash([]);
  t.globalCompositeOperation="destination-out";for(const x of [0,tw]){t.beginPath();t.arc(x,y,30,0,Math.PI*2);t.fill()}t.globalCompositeOperation="source-over";
  const cols=[["MISE",tok(b.stake),"#13201a"],["COTE",fr(b.odds),"#c99a0b"],[st==="open"?"GAIN POSSIBLE":st==="cashed"?"ENCAISSÉ":"GAIN",st==="lost"?"0":tok(st==="open"?Math.round(b.stake*b.odds):b.pay),st==="lost"?"#d93a3f":"#1f9d5c"]];
  cols.forEach(([k,v,cl],i)=>{const cx=tw*(i+.5)/3;t.textAlign="center";t.fillStyle="#7d8a83";t.font='700 26px Barlow';t.fillText(k,cx,y+70);t.fillStyle=cl;t.font='800 76px "Barlow Condensed"';t.fillText(v,cx,y+150)});
  c.save();c.shadowColor="rgba(0,0,0,.55)";c.shadowBlur=50;c.shadowOffsetY=20;c.drawImage(tc,tx,ty);c.restore();
  // tampon
  const stamp={won:"GAGNÉ",lost:"PERDU",cashed:"ENCAISSÉ",void:"REMBOURSÉ",open:"EN COURS"}[st];
  c.save();c.translate(tx+tw-175,ty+82);c.rotate(-.16);c.font='800 64px "Barlow Condensed"';const sw=c.measureText(stamp).width+50;
  c.globalAlpha=.9;c.strokeStyle=SC;c.lineWidth=7;c.beginPath();c.roundRect(-sw/2,-50,sw,92,14);c.stroke();c.lineWidth=2.5;c.beginPath();c.roundRect(-sw/2+9,-41,sw-18,74,9);c.stroke();
  c.fillStyle=SC;c.textAlign="center";c.fillText(stamp,0,18);c.restore();
  // pied
  const fy=ty+tkH+90;c.textAlign="center";c.fillStyle="#e8efe9";c.font='800 46px "Barlow Condensed"';c.fillText(st==="won"?"QUI FAIT MIEUX ? 😏":st==="lost"?"LA REVANCHE, C’EST QUAND ?":"QUI ME SUIT ?",W/2,fy);
  c.fillStyle="#35d07f";c.font='700 32px Barlow';c.fillText((link||APP_URL).replace(/^https?:\/\//,"").replace(/\/$/,""),W/2,fy+52);
  c.fillStyle="#6b7a72";c.font='500 26px Barlow';c.fillText("Paris gratuits entre potes · jetons fictifs",W/2,fy+92);
  return new Promise(ok=>cv.toBlob(ok,"image/png"))}
const APP_URL="https://damateur-a-pro.vercel.app/",IG_URL="https://www.instagram.com/tribune.pronos/",FB_URL="https://www.facebook.com/tribune.pronos";
const FB_ICON=`<svg class="igic" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#fff"/><path d="M13.4 21.9v-7.2h2.4l.4-2.8h-2.8v-1.8c0-.8.2-1.4 1.4-1.4h1.5V6.2c-.3 0-1.1-.1-2.1-.1-2.1 0-3.6 1.3-3.6 3.7v2.1H8.2v2.8h2.4v7.2" fill="#1877f2"/></svg>`;
const IG_ICON=`<svg class="igic" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="17.3" cy="6.7" r="1.2" fill="currentColor"/></svg>`;
async function shareTicket(id){const b=S.bets.find(x=>x.id===id);if(!b)return;toast("Préparation du ticket…");
  try{let link=APP_URL;if(b.sid){try{const j=await api("share_bet",{cid:b.id});if(j.code)link=APP_URL+"?pari="+j.code}catch(e){}}
    const blob=await ticketImage(b,link),file=new File([blob],"ticket-tribune.png",{type:"image/png"});
    const head=b.st==="won"?`Ticket gagnant sur Tribune : +${tok(b.pay)} jetons à ${fr(b.odds)} 🔥`:b.st==="lost"?"Raté de peu sur Tribune… 😅":`Mon ticket sur Tribune : cote ${fr(b.odds)}, qui me suit ? 😏`;
    const txt=`${head}\n👉 ${b.st==="open"?"Touche pour voir le ticket et le suivre":"Touche pour voir le ticket"} : ${link}`;
    if(navigator.canShare&&navigator.canShare({files:[file]})){try{await navigator.share({files:[file],text:txt})}catch(e){}return}
    if(navigator.share){try{await navigator.share({text:txt})}catch(e){}return}
    try{await navigator.clipboard.writeText(txt);toast("Lien du ticket copié : colle-le dans ta conversation.","win")}catch(e){}
    const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="ticket-tribune.png";document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),4e3)}
  catch(e){toast("Impossible de créer l’image.","bad")}}
// lien de ticket (…/?pari=CODE) : on ouvre le ticket ; un nouveau joueur le retrouve après son inscription
// lien de parrainage : on garde le code jusqu'à la création du compte
function refFromLink(){const c=new URLSearchParams(location.search).get("parrain");if(!c)return;const code=c.toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,8);
  const q=new URLSearchParams(location.search);q.delete("parrain");history.replaceState(null,"",location.pathname+(q.toString()?"?"+q:""));
  keepTmp("dap.ref",code)}
// valeurs gardées le temps d'installer l'appli (ticket partagé, parrainage), puis oubliées : sinon Safari les remontrait à chaque visite
function keepTmp(k,v){try{localStorage.setItem(k,v+"|"+Date.now())}catch(e){}}
function getTmp(k,min){try{const raw=localStorage.getItem(k);if(!raw)return"";const[v,t]=raw.split("|");if(!t||Date.now()-Number(t)>min*6e4){localStorage.removeItem(k);return""}return v}catch(e){return""}}
const refStored=()=>getTmp("dap.ref",24*60);
// lien d'un match (…/?match=rugby-401234) : on ouvre directement la fiche du match pour faire son prono
function matchFromLink(){const c=new URLSearchParams(location.search).get("match");if(!c)return;const q=new URLSearchParams(location.search);q.delete("match");history.replaceState(null,"",location.pathname+(q.toString()?"?"+q:""));
  const v=String(c).toLowerCase().replace(/[^a-z0-9-]/g,"").slice(0,30);if(/^[a-z]+-\d+$/.test(v)){keepTmp("dap.match",v);U.matchNow=1}}
let mpTries=0;async function matchPending(v){v=v||getTmp("dap.match",30);if(!v||!S.name||GATE)return;const[sp,eid]=v.split("-");if(!SP[sp])return;
  try{await loadSport(sp)}catch(e){}
  const m=[...REG.values()].find(x=>String(x.eid)===eid);
  if(!m){if(++mpTries<8)setTimeout(()=>matchPending(v),2500);return}
  try{localStorage.removeItem("dap.match")}catch(e){}mpTries=0;
  if(U.open&&U.open!=="slip"){document.querySelectorAll(".scrim").forEach(x=>x.remove());U.open=null;layer("")}
  U.tab="m";U.sp=sp;render();U.dtab="p";openDetail(m.id)}
function pariFromLink(){const c=new URLSearchParams(location.search).get("pari");if(!c)return;history.replaceState(null,"",location.pathname);
  keepTmp("dap.pari",c.toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,10));U.pariNow=1}
let ptAt=0;async function pendingTicket(){if(!S.tok||GATE||Date.now()-ptAt<4000||(U.open&&U.open!=="slip"))return;ptAt=Date.now();
  try{const j=await api("pending_ticket",{});if(j.code)openShared(j.code);else if(j.match)matchPending(j.match)}catch(e){}}
document.addEventListener("visibilitychange",()=>{if(!document.hidden&&S.name)setTimeout(pendingTicket,700)});
function pariPending(){const c=getTmp("dap.pari",30);if(!c||!S.name)return;try{localStorage.removeItem("dap.pari")}catch(e){}openShared(c)}
async function openShared(code){U.open="shared";U.shared=null;const head=`<div class="grab"><h3>Ticket partagé</h3><button class="x" data-act="close" aria-label="Fermer">${ic("x")}</button></div>`;
  layerLater(head+`<div class="skel" style="height:220px"></div>`);
  try{const j=await api("shared_bet",{code});U.shared=j;if(U.open==="shared")layer(head+viewShared(j))}
  catch(e){if(U.open==="shared")layer(head+`<div class="empty">${ic("info")}<b>${e.code==="unknown"?"Ticket introuvable":"Pas de connexion"}</b>${e.code==="unknown"?"Ce lien de ticket n’existe plus.":"Réessaie dans un instant."}</div>`)}}
function viewShared(j){const me=String(j.pid)===String(S.pid),st=j.status,tag=st==="won"?`<span class="tag won">Gagné +${tok(j.pay)}</span>`:st==="lost"?`<span class="tag lost">Perdu</span>`:st==="void"?`<span class="tag void">Remboursé</span>`:st==="cashed"?`<span class="tag cashed">Encaissé +${tok(j.pay)}</span>`:`<span class="tag open">En cours</span>`;
  const open=j.legs.filter(L=>!L.r&&L.t>Date.now()-60e3).length;
  return`<div class="shwho">${avatar(j.pid,j.name,j.av,"av")}<div><b>${esc(j.name)}</b><small>${j.legs.length>1?"Combiné de "+j.legs.length:"Pari simple"} · ${new Date(j.at).toLocaleDateString("fr-FR",{day:"numeric",month:"long"})}</small></div>${tag}</div>
  <div class="ticket ${st}"><div class="tl">${j.legs.map(L=>`<div class="leg">${legStatus(L)}<div><b>${esc(L.l)} <span style="color:var(--mute);font-weight:500">@ ${fr(L.o)}</span></b><small>${esc(L.mt||"")}</small><small>${esc(L.ml||"")}</small></div></div>`).join("")}</div>
  <div class="tf"><div><small>Mise</small><b>${tok(j.stake)}</b></div><div style="text-align:center"><small>Cote</small><b>${fr(j.odds)}</b></div><div style="text-align:right"><small>${st==="open"?"Gain possible":"Gain"}</small><b>${st==="lost"?"0":tok(st==="open"?j.stake*j.odds:j.pay)}</b></div></div></div>
  ${j.follows?`<p class="note">🎟️ ${j.follows} personne${j.follows>1?"s suivent":" suit"} ce ticket</p>`:""}
  ${me?`<p class="note">C’est ton ticket.</p>`:st!=="open"||!open?`<p class="note">Ce ticket n’est plus ouvert : les matchs ont commencé ou sont finis.</p>`
    :S.name?`<button class="btn gold wide" data-act="follow">🎟️ Je suis ce pari</button><p class="note">Ses sélections encore ouvertes vont dans ton ticket, aux cotes du moment. Tu choisis ta mise.</p>`
    :`<button class="btn gold wide" data-act="close">Créer mon compte pour le suivre</button>`}`}
async function followShared(){const j=U.shared;if(!j)return;const b=$("[data-act=follow]");if(b){b.disabled=true;b.textContent="Préparation…"}
  await Promise.allSettled([...new Set(j.legs.map(L=>L.sp))].map(sp=>loadSport(sp)));await loadEvents();
  let added=0,gone=0;for(const L of j.legs){if(L.r){continue}const m=findMatch(L.mid);if(!m||!canBet(m)||PMK[L.mk]){gone++;continue}
    const mk=markets(m).find(x=>x.id===L.mk);if(!mk||!mk.sels[L.k]||!mk.sels[L.k].o){gone++;continue}if(!selOf(L.mid,L.mk,L.k))pick(L.mid,L.mk,L.k);added++}
  if(!added){toast("Plus aucune sélection de ce ticket n’est ouverte.","bad");if(b){b.disabled=false;b.textContent="🎟️ Je suis ce pari"}return}
  U.combo=!!j.combo&&U.sel.length>1;api("shared_bet",{code:j.code,follow:1}).catch(()=>{});
  U.tab="m";U.open="slip";layer(viewSlip());render();toast(`🎟️ ${added} sélection${added>1?"s":""} de ${esc(j.name)} ajoutée${added>1?"s":""}${gone?` (${gone} plus disponible${gone>1?"s":""})`:""}. Choisis ta mise !`,"win")}

/* ---------- guide : présentation en 4 écrans, premier pari accompagné, missions « Premiers pas », aide ---------- */
// 1) présentation (glisser ou « Suivant »)
const INTRO_N=4,INTRO_V=2;   // changer INTRO_V remontre la présentation et le tuto à tout le monde
function openIntro(){if(U.open&&U.open!=="intro"&&U.open!=="help"){setTimeout(()=>{if(S.name&&S.introSeen!==INTRO_V)openIntro()},5000);return}U.open="intro";U.ii=0;U.ix={o:1,s:20};layer(viewIntro())}
function viewIntro(){const i=U.ii,X=U.ix,O=[["PSG",1.65],["Nul",3.8],["Lens",5.2]],o=O[X.o];
  const S1=`<div class="iimg"><img src="img/intro1.webp?v=1" alt=""></div><h2>Parie sur les vrais matchs</h2><p>Foot, rugby, tennis et NBA : les vrais matchs, avec les scores <b>en direct</b>. Tu paries sur qui gagne, mais aussi sur les buteurs, les cartons, les corners, les essais, les aces…</p>
    <div class="ichips"><span>⚽ Foot</span><span>🏉 Rugby</span><span>🎾 Tennis</span><span>🏀 NBA</span></div>
    <div class="ibox">🎁 <b>1 000 jetons offerts</b> pour commencer${S.starter==="pending"?" : tu les gagnes sur un match d’entraînement à la fin de cette présentation":""}.<br>Ce sont des <b>jetons fictifs</b> : tout est gratuit, aucun argent en jeu, jamais.</div>`;
  const S2=`<div class="iimg"><img src="img/intro2.webp?v=1" alt=""></div><h2>La cote, en 10 secondes</h2><p>Chaque pronostic a une <b>cote</b>. Touche un choix pour voir :</p>
    <div class="imc"><div class="imt"><b>PSG</b><span>contre</span><b>Lens</b></div><div class="odds c3">${O.map((x,k)=>`<button class="odd" data-act="ixo" data-v="${k}" aria-pressed="${X.o===k}"><span>${["1","N","2"][k]}</span><b>${fr(x[1])}</b></button>`).join("")}</div>
    <div class="ilegend"><span>1 = PSG gagne</span><span>N = match nul</span><span>2 = Lens gagne</span></div></div>
    <div class="chips">${[10,20,50,100].map(v=>`<button data-act="ixs" data-v="${v}" aria-pressed="${X.s===v}">${v}</button>`).join("")}</div>
    <div class="ibox calc">Tu mises <b>${X.s}</b> jetons sur « ${o[0]} » à <b>${fr(o[1])}</b><br>Si c’est bon, tu reçois <b class="pos">${tok(Math.round(X.s*o[1]))} jetons</b> <small>(${X.s} × ${fr(o[1])})</small><br>Si c’est raté, tu perds ta mise.</div>
    <p class="isub">Cote haute = résultat peu probable, mais gros gain. Cote basse = plus sûr, petit gain.</p>`;
  const S3=`<div class="iimg"><img src="img/intro3.webp?v=1" alt=""></div><h2>Simple ou combiné</h2>
    <div class="itk"><b>Pari simple</b><small>Un seul pronostic</small><div class="itl"><span>PSG gagne</span><b>1,65</b></div><div class="itg">10 jetons → <b class="pos">17 jetons</b></div></div>
    <div class="itk gold"><b>Combiné</b><small>Plusieurs pronostics sur un ticket : les cotes se <b>multiplient</b></small><div class="itl"><span>PSG gagne</span><b>1,65</b></div><div class="itl"><span>Plus de 2,5 buts</span><b>1,90</b></div><div class="itg">Cote 1,65 × 1,90 = <b>3,14</b> · 10 jetons → <b class="pos">31 jetons</b></div></div>
    <p class="isub">⚠️ Dans un combiné, <b>tout</b> doit être bon. Un seul raté et le ticket est perdu.</p>`;
  const S4=`<div class="iimg"><img src="img/intro4.webp?v=1" alt=""></div><h2>Joue avec tes potes</h2>
    <div class="ilist"><div><span>📈</span><p><b>Ton niveau</b> : chaque pari te rapporte de l’XP (encore plus s’il est gagné et risqué). Tu montes de Spectateur à Légende.</p></div>
    <div><span>🛡️</span><p><b>Les guildes</b> : un groupe entre amis ou collègues, avec classement de la semaine et du mois, chat, prono du week-end et combats contre d’autres guildes.</p></div>
    <div><span>🎡</span><p><b>Chaque jour</b> : la roue de la chance et 3 défis pour gagner des jetons.</p></div>
    <div><span>🔔</span><p><b>Les notifications</b> te préviennent du coup d’envoi et de tes gains.</p></div></div>`;
  const body=[S1,S2,S3,S4][i];
  return`<div class="intro" id="intro"><div class="ihead"><span class="idots">${Array.from({length:INTRO_N},(_,k)=>`<i class="${k===i?"on":""}"></i>`).join("")}</span><button class="link" data-act="iskip">Passer</button></div>
    <div class="ibody">${body}</div>
    <div class="ifoot">${i>0?`<button class="btn ghost" data-act="iprev">‹</button>`:""}${i<INTRO_N-1?`<button class="btn gold wide" data-act="inext">Suivant</button>`:`<button class="btn gold wide" data-act="istart">${ic("ticket")} ${S.starter==="pending"?"Mon match d’entraînement":"Match d’entraînement"}</button>`}</div>${i===INTRO_N-1?`<p class="note" style="margin:10px 0 0"><button class="link" data-act="iskip">${S.starter==="pending"?"Passer et recevoir mes 1 000 jetons":"C’est bon, j’ai compris"}</button></p>`:""}</div>`}
// « Quoi de neuf ? » : montré une fois après une grosse mise à jour (changer NEWS_V pour le remontrer)
const NEWS_V=1;
const NEWS=[["card-legende.webp?v=1","Ta carte en métal","Bronze, argent, or, élite, légende : ta carte de joueur a maintenant une vraie matière. <b>Fais-la bouger avec le doigt</b>, elle est en 3D ! Tu peux aussi choisir le rang affiché.","mycard","Voir ma carte"],
  ["bn/b20.webp?v=1","22 bannières illustrées","Stade, terre battue, parquet, orage, galaxie, teckel… Chaque bannière a sa scène en haut du profil et sa propre carte.","style","Mon style"],
  ["fr/f5.webp?v=2","12 nouveaux cadres","Flammes, néon, glace, éclairs, diamant, pièces d’or… à débloquer en jouant, autour de ta photo partout dans l’appli.","style","Mon style"],
  ["roue-anneau.webp?v=1","La nouvelle roue","Ampoules, cases en métal, la case qui s’allume sous la flèche, et des bruitages. Un tour gratuit chaque jour !","wheel","Tourner la roue"],
  ["gdiv/g6.webp?v=1","Les divisions de guildes","Bronze, argent, or, platine, diamant… jusqu’à <b>Légende</b>. Gagnez les combats du lundi pour monter !","gwr","Le classement"]];
function openNews(){if(U.open){setTimeout(()=>{if(S.newsSeen!==NEWS_V&&S.name)openNews()},4000);return}U.open="news";U.ni=0;layer(viewNews());newsCard()}
function viewNews(){const i=U.ni,n=NEWS[i];return`<div class="intro news" id="news"><div class="ihead"><span class="idots">${NEWS.map((_,k)=>`<i class="${k===i?"on":""}"></i>`).join("")}</span><button class="link" data-act="nskip">Fermer</button></div>
  <div class="ibody"><div class="nwk">✨ Quoi de neuf ?</div><div class="nwimg">${i===0?`<img id="nwcard" src="${n[0]}" alt="" style="visibility:hidden">`:i===2?`<div class="nwav">${avatar(S.pid||"me",S.name||"?",S.avv,"av fr-f5",true)}</div>`:i===3?`<div class="wheelbox nwwh">${wheelSvg()}<img class="wring" src="roue-anneau.webp?v=1" alt=""><img class="whub" src="roue-centre.webp?v=1" alt=""></div>`:`<img src="${n[0]}" alt="">`}</div><h2>${n[1]}</h2><p>${n[2]}</p><button class="btn ghost wide" data-act="ngo" data-v="${n[3]}">${n[4]} ›</button></div>
  <div class="ifoot">${i>0?`<button class="btn ghost" data-act="nprev">‹</button>`:""}<button class="btn gold wide" data-act="${i<NEWS.length-1?"nnext":"nskip"}">${i<NEWS.length-1?"Suivant":"C’est parti !"}</button></div></div>`}
async function newsCard(){const im=$("#nwcard");if(!im)return;try{const{blob}=await playerCard({id:S.pid,name:S.name,av:S.avv,me:true,bets:S.bets,xp:S.xp,cos:S.cos},{d:"rang",bd:"emo",sub:"t",sp:"auto"});const u=URL.createObjectURL(blob);const i2=$("#nwcard");if(i2){i2.src=u;i2.style.visibility=""}}catch(e){const i2=$("#nwcard");if(i2)i2.style.visibility=""}}
function newsEnd(){S.newsSeen=NEWS_V;saveLocal();closeLayer()}
function introGo(d){U.ii=Math.max(0,Math.min(INTRO_N-1,U.ii+d));layer(viewIntro());const s=$(".sheet");if(s)s.scrollTop=0}
let ixT=null;
document.addEventListener("touchstart",e=>{if(U.open==="intro"&&e.target.closest&&e.target.closest("#intro"))ixT={x:e.touches[0].clientX,y:e.touches[0].clientY}},{passive:true});
document.addEventListener("touchend",e=>{if(!ixT||U.open!=="intro")return;const dx=e.changedTouches[0].clientX-ixT.x,dy=e.changedTouches[0].clientY-ixT.y;ixT=null;if(Math.abs(dx)>60&&Math.abs(dx)>Math.abs(dy)*1.5)introGo(dx<0?1:-1)},{passive:true});
function introEnd(coach){S.introSeen=INTRO_V;save();closeLayer();if(!coach)setTimeout(pariPending,800);if(coach)startCoach();else if(!grantStarter(false))toast("Tu peux revoir la présentation dans Carrière › Comment ça marche ?")}

// 2) match d'entraînement : un faux match qui se joue en quelques secondes, sans toucher aux vrais matchs.
// Le premier pari est forcément gagné et débloque les 1 000 premiers jetons du nouveau joueur.
const TR_O=[1.85,3.4,4.2],TR_T=["Les Novices FC","Tribune United"];
function grantStarter(quiet){if(S.starter!=="pending")return false;S.starter="done";S.bal+=1000;if(S.tok)api("starter_log",{}).catch(()=>{});S.peak=Math.max(S.peak,S.bal);save();render();bump();
  if(!quiet){confetti();toast(`${ic("coin")} Tes 1 000 premiers jetons sont arrivés. À toi de jouer !`,"win")}return true}
function openTraining(){U.tr={k:null,s:0,ph:"pick",min:0,sc:[0,0],ev:[]};U.open="train";layer(viewTrain())}
function viewTrain(){const T=U.tr,o=T.k!=null?TR_O[T.k]:0,lab=["Victoire des Novices","Match nul","Victoire de Tribune United"];
  let h=`<div class="grab"><h3>Match d’entraînement</h3></div><p class="note" style="text-align:left;margin-top:0">Un faux match pour apprendre, <b>sans risque</b> : il se joue en quelques secondes.</p>
  <div class="mc trm"><div class="mc-top"><span class="chip">Entraînement</span><span class="comp">Coupe des débutants</span></div>
  <div class="teams"><div class="tm"><span class="trc">🟢</span><b>${TR_T[0]}</b></div><div class="mid">${T.ph==="pick"||T.ph==="stake"?`<div class="ko">Prêt</div><small>coup d’envoi</small>`:`<div class="score">${T.sc[0]}–${T.sc[1]}</div><small class="live-t">${T.ph==="done"?"Terminé":T.min+"’"}</small>`}</div><div class="tm"><span class="trc">🟡</span><b>${TR_T[1]}</b></div></div>
  <div class="odds c3 tr-odds">${TR_O.map((x,k)=>`<button class="odd" data-act="trk" data-v="${k}" aria-pressed="${T.k===k}" ${T.ph==="play"||T.ph==="done"?"disabled":""}><span>${["1","N","2"][k]}</span><b>${fr(x)}</b></button>`).join("")}</div>
  <div class="ilegend"><span>1 = Novices gagnent</span><span>N = nul</span><span>2 = Tribune gagne</span></div></div>`;
  if(T.ev.length)h+=`<div class="trev">${T.ev.map(e=>`<div>${e}</div>`).join("")}</div>`;
  if(T.k!=null&&T.ph!=="done")h+=`<div class="trtk"><div class="leg"><span class="ic">${ic("ticket")}</span><div><b>${lab[T.k]}</b><small>Ton pronostic</small></div><span class="o">${fr(o)}</span></div>
    ${T.ph==="play"?"":`<div class="chips tr-chips">${[10,20,50,100].map(v=>`<button data-act="trs" data-v="${v}" aria-pressed="${T.s===v}">${v}</button>`).join("")}</div>`}
    <div class="sum"><div><small>Mise (jetons d’entraînement)</small><b>${T.s||"—"}</b></div><div class="g"><small>Gain possible</small><b>${T.s?tok(Math.round(T.s*o)):"—"}</b></div></div>
    ${T.s?`<p class="note" style="margin:6px 0">${T.s} × ${fr(o)} = <b>${tok(Math.round(T.s*o))}</b> jetons si c’est bon.</p>`:""}
    ${T.ph==="play"?`<button class="btn wide" disabled>Le match se joue…</button>`:`<button class="btn gold wide tr-go" data-act="trgo" ${T.s?"":"disabled"}>${ic("ticket")} Valider mon pari</button>`}</div>`;
  if(T.ph==="done"){const g=Math.round(T.s*o),st=S.starter==="pending";
    h+=`<div class="trwin"><div class="tag won" style="font-size:16px">GAGNÉ ✓</div><b>Bravo, ton pronostic est bon !</b><p>Mise ${T.s} × cote ${fr(o)} = <b class="pos">+${tok(g)}</b> jetons d’entraînement.</p>
      ${st?`<div class="ibox calc">🎁 Pour fêter ton premier pari gagné, <b>tes 1 000 premiers jetons</b> sont à toi !</div>`:""}
      <p class="isub">Sur les vrais matchs, c’est pareil : touche une cote, choisis ta mise, valide. Le pari se règle tout seul à la fin du match.</p>
      <button class="btn gold wide tr-end" data-act="trend">${st?ic("coin")+" Récupérer mes 1 000 jetons":"Continuer"}</button></div>`}
  return h}
function trPlay(){const T=U.tr;if(!T||T.k==null||!T.s)return;T.ph="play";T.min=0;T.sc=[0,0];T.ev=[];
  // le scénario finit toujours sur le pronostic choisi
  const goals=T.k===0?[[23,0],[58,1],[77,0]]:T.k===1?[[31,1],[66,0]]:[[18,1],[49,0],[84,1]];
  const tick=()=>{if(!U.tr||U.open!=="train")return;T.min=Math.min(90,T.min+6);for(const[m,s]of goals)if(m<=T.min&&!T.ev.some(e=>e.startsWith(m+"’"))){T.sc[s]++;T.ev.push(`${m}’ ⚽ But pour ${TR_T[s]} (${T.sc[0]}–${T.sc[1]})`)}
    if(T.min>=90){T.ph="done";layer(viewTrain());confetti();return}layer(viewTrain());setTimeout(tick,260)};
  layer(viewTrain());setTimeout(tick,300)}
function trEnd(){U.tr=null;U.open=null;layer("");grantStarter(true);if(U.coach){U.coach.end=0;U.tab="m";render();window.scrollTo({top:0});coachTick()}else render()}
const COACH_END=[
  {sel:()=>$('.nav [data-tab=m]'),txt:"Voilà tes <b>1 000 jetons</b> 💰 À toi de jouer sur les <b>vrais matchs</b> quand tu veux : touche une cote, choisis ta mise, valide. Tu peux aussi toucher un match pour voir tous ses paris (buteurs, cartons, corners…)."},
  {sel:()=>$('.nav [data-tab=b]'),txt:"<b>Mes paris</b> : tes tickets en cours et terminés. Ils se règlent <b>tout seuls</b> à la fin des matchs. Avant la fin, tu peux souvent <b>encaisser</b> pour garder un gain."},
  {sel:()=>$('.nav [data-tab=l]'),txt:"<b>Guildes</b> : crée ou rejoins un groupe avec tes potes ou tes collègues. Classements de la semaine et du mois, chat, prono du week-end, duels et combats de guildes."},
  {sel:()=>$('.nav [data-tab=c]'),txt:"<b>Carrière</b> : ta division, tes statistiques, tes succès et l’aide « Comment ça marche ? » si tu as une question."}];
let coachT=0,safeTop=null;
function topSafe(){if(safeTop==null){const d=document.createElement("div");d.style.cssText="position:fixed;top:0;padding-top:env(safe-area-inset-top,0px);visibility:hidden";document.body.appendChild(d);safeTop=parseFloat(getComputedStyle(d).paddingTop)||0;d.remove()}return safeTop}
function startCoach(){U.coach={end:-1};if(U.open)closeLayer();if(U.tab!=="m"){U.tab="m";render()}window.scrollTo({top:0});
  let c=$("#coach");if(!c){c=document.createElement("div");c.id="coach";c.innerHTML=`<div class="cspot"></div><div class="cbub"><small class="cst"></small><p class="ctx"></p><div class="cbt"><button class="link" data-act="cskip">Passer le guide</button><button class="btn gold" data-act="cnext" hidden>Suivant</button></div></div>`;document.body.appendChild(c)}
  c.hidden=false;openTraining();clearInterval(coachT);coachT=setInterval(coachTick,250);coachTick()}
function stopCoach(done){setTimeout(pariPending,1200);clearInterval(coachT);U.coach=null;const c=$("#coach");if(c)c.hidden=true;S.coachDone=1;
  if(U.open==="train"){U.tr=null;U.open=null;layer("")}grantStarter(false);save();
  if(done){U.tab="m";render();window.scrollTo({top:0});toast("Guide terminé ! Il te reste quelques missions « Premiers pas » pour gagner des jetons 🎁","win");loadGuide(true)}}
function coachStep(){const C=U.coach,T=U.tr;
  if(C.end>=0)return{n:5+C.end,...COACH_END[C.end],next:true};
  if(!T)return{n:1,txt:"…"};
  if(T.ph==="done")return{n:4,sel:()=>$(".tr-end"),txt:"<b>Gagné !</b> Touche le bouton jaune 👇"};
  if(T.ph==="play")return{n:4,hide:true};
  if(T.k==null)return{n:1,sel:()=>$(".tr-odds"),txt:"<b>Touche une cote</b> : c’est ton pronostic 👇"};
  if(!T.s)return{n:2,sel:()=>$(".tr-chips"),txt:"<b>Choisis ta mise</b> (jetons d’entraînement) 👇"};
  return{n:3,sel:()=>$(".tr-go"),txt:"<b>Valide ton pari</b> et regarde le match 👇"}}
function coachTick(){const C=U.coach,c=$("#coach");if(!C||!c)return;const st=coachStep(),el=st.sel&&st.sel();
  const sp=c.querySelector(".cspot"),bub=c.querySelector(".cbub"),W=innerWidth,H=innerHeight,bw=Math.min(380,W-24),top0=topSafe()+10;
  bub.style.display=st.hide?"none":"";sp.style.display="none";if(st.hide)return;
  if(el&&!el.dataset.cv){el.dataset.cv=1;const r0=el.getBoundingClientRect();if(r0.top<top0+60||r0.bottom>H-90)el.scrollIntoView({block:"center",behavior:"smooth"})}
  c.querySelector(".cst").textContent=`Étape ${st.n} sur 8`;const tx=c.querySelector(".ctx");if(tx.dataset.t!==st.txt){tx.dataset.t=st.txt;tx.innerHTML=st.txt}
  const nb=c.querySelector("[data-act=cnext]");nb.hidden=!st.next;nb.textContent=C.end===COACH_END.length-1?"Terminer":"Suivant";
  bub.style.width=bw+"px";bub.style.left=Math.round((W-bw)/2)+"px";const bh=bub.offsetHeight;
  if(el){const r=el.getBoundingClientRect(),p=6;Object.assign(sp.style,{display:"block",left:r.left-p+"px",top:r.top-p+"px",width:r.width+2*p+"px",height:r.height+2*p+"px"});
    // bulle juste au-dessus de l'élément s'il est en bas de l'écran, sinon juste en dessous (jamais sous la barre d'état)
    const sh=U.open==="train"&&$(".sheet"),st0=sh?sh.getBoundingClientRect().top:0;
    if(sh&&st0-bh-12>=top0)bub.style.top=(st0-bh-12)+"px";   // match d'entraînement : bulle dans l'espace libre au-dessus de la fiche
    else if(r.top>H/2)bub.style.top=Math.max(top0,r.top-p-12-bh)+"px";else bub.style.top=Math.max(top0,Math.min(H-bh-8,r.bottom+p+12))+"px"}
  else bub.style.top=Math.max(top0,H-bh-110)+"px"}
function coachNext(){const C=U.coach;if(!C||C.end<0)return;if(C.end>=COACH_END.length-1){stopCoach(true);return}C.end++;coachTick()}

// 3) missions « Premiers pas » (vérifiées par le serveur)
const GSTEPS=[["bet","🎟️","Faire ton premier pari","Touche une cote, choisis ta mise, valide."],["wheel","🎡","Tourner la roue de la chance","Un tour gratuit chaque jour."],
  ["guild","🛡️","Rejoindre ou créer une guilde","Pour jouer avec tes potes ou tes collègues."],["push","🔔","Activer les notifications","Coup d’envoi, résultats, rappels."],
  ["fav","❤️","Choisir ton équipe de cœur","Ses matchs remontent en premier."],["combo","🧾","Tenter un combiné","Au moins 2 pronostics sur un même ticket."],["insta","📸","Suivre Tribune sur Instagram","Nouveautés, pronos du week-end : @tribune.pronos"],["fb","👍","Suivre Tribune sur Facebook","La Page Tribune Pronos : facebook.com/tribune.pronos"]];
// missions masquées : on retient combien il y en avait, pour réafficher la carte quand une nouvelle arrive
const guideHidden=()=>{const h=S.guideHide;return!!h&&(h===1?7:h)>=GSTEPS.length};
// déjà tout fini (bonus final pris) : la carte revient seulement pour les nouvelles missions pas encore récupérées
const guideList=g=>g.all?GSTEPS.filter(([k])=>!g.claimed[k]):GSTEPS;
const guideVisible=g=>!!g&&!guideHidden()&&guideList(g).length>0;
let gAt=0;
async function loadGuide(force){if(!S.tok||guideHidden()||(!force&&Date.now()-gAt<2e4))return;gAt=Date.now();try{U.gs=await api("guide_status",{});if(U.tab==="m"&&(!U.open||U.open.startsWith("td:")))render()}catch(e){}}
function guideLocal(){return{bet:S.bets.some(b=>b.sid),wheel:!!S.wheel,guild:!!(U.lg.data&&U.lg.data.leagues.length),push:pushState()==="on",fav:!!S.fav,combo:S.bets.some(b=>b.sid&&b.legs.length>1),insta:!!S.igDone,fb:!!S.fbDone}}
let gLocAt=0;
function guideCard(){const g=U.gs;if(!guideVisible(g))return"";const GL=guideList(g);
  {const L=guideLocal();if(GSTEPS.some(([k])=>L[k]&&!g.done[k])&&Date.now()-gLocAt>8e3&&(U.gTries=(U.gTries||0)+1)<=4){gLocAt=Date.now();if(L.fav&&!g.done.fav&&S.favOk!==S.fav.id)favPush();else setTimeout(()=>loadGuide(true),1500)}}const n=GL.filter(([k])=>g.done[k]).length,ready=GL.filter(([k])=>g.done[k]&&!g.claimed[k]).length,open=U.gOpen??(S.bets.length<3||ready>0||g.all);
  let h=`<div class="gcard"><button class="ghd" data-act="gtog"><span class="gico">🚀</span><span><b>${g.all?(GL.length>1?"Nouvelles missions":"Nouvelle mission"):"Premiers pas"}</b><small>${n}/${GL.length} faite${GL.length>1?"s":""} · +${g.reward} jetons${GL.length>1?" chacune":""}${ready?` · <b class="pos">${ready} à récupérer</b>`:""}</small></span><span class="arr">${open?"⌃":"⌄"}</span></button>
    <div class="gbar"><i style="width:${n/GL.length*100}%"></i></div>`;
  if(open){h+=GL.map(([k,e,t,s])=>{const d=g.done[k],c=g.claimed[k];
      return`<div class="gst${c?" ok":""}"><span class="ge">${c?"✅":e}</span><div><b>${t}</b><small>${s}</small></div>${c?`<span class="gok">+${g.reward}</span>`:d?`<button class="btn gold" data-act="gclaim" data-k="${k}">+${g.reward}</button>`:`<button class="btn ghost" data-act="ggo" data-k="${k}">Go</button>`}</div>`}).join("");
    if(!g.all&&GSTEPS.every(([k])=>g.claimed[k]))h+=`<button class="btn gold wide" data-act="gclaim" data-k="all" style="margin-top:8px">🎉 Bonus final : +${g.bonus} jetons</button>`;
    h+=`<div class="gft"><button class="link" data-act="help">Comment ça marche ?</button><button class="link" data-act="ghide">Masquer</button></div>`}
  return h+`</div>`}
// Instagram : ouvre le compte et le note (mission « Premiers pas »)
function openInsta(){const l=document.createElement("a");l.href=IG_URL;l.target="_blank";l.rel="noopener";document.body.appendChild(l);l.click();l.remove();S.igDone=1;saveLocal();api("insta_click",{}).catch(()=>{})}
function openFb(){const l=document.createElement("a");l.href=FB_URL;l.target="_blank";l.rel="noopener";document.body.appendChild(l);l.click();l.remove();S.fbDone=1;saveLocal();api("fb_click",{}).catch(()=>{})}
function igPopup(){if(window.__gate||!S.name||S.igNever||S.igDone)return;S.launches=(S.launches||0)+1;saveLocal();if(S.launches%10)return;
  setTimeout(()=>{if(U.open)return;U.open="igpop";layer(`<div class="grab"><h3>On est sur Instagram !</h3><button class="x" data-act="close" aria-label="Fermer">${ic("x")}</button></div>
    <div class="igpop">${IG_ICON}<p><b>@tribune.pronos</b>Nouveautés de l’appli, pronos du week-end, défis entre guildes… Abonne-toi pour ne rien rater !</p></div>
    <button class="btn wide igbtn" data-act="igpop">📸 Suivre sur Instagram</button><div class="ifoot" style="justify-content:center"><button class="link" data-act="close">Plus tard</button><button class="link" data-act="ignever">Ne plus demander</button></div>`)},5000)}
async function guideClaim(k){try{const j=await api("guide_claim",{step:k});if(j.error)throw j;if(j.amount){S.bal+=j.amount;S.peak=Math.max(S.peak,S.bal);save();bump();if(k==="all")confetti();toast(`🎁 +${j.amount} jetons !`,"win");$("#main")._html=null;render()}await loadGuide(true)}
  catch(e){toast("Pas encore validé : réessaie dans un instant.","bad");loadGuide(true)}}
function guideGo(k){if(k==="bet"){U.tab="m";render();const o=[...document.querySelectorAll("#main .mc")].find(x=>x.offsetParent);if(o)o.scrollIntoView({block:"center",behavior:"smooth"});toast("Choisis un vrai match et touche une cote : ton pronostic va dans ton ticket.");return}if(k==="wheel"){const wb=$("[data-act=wheel]");if(wheelAvail()&&wb)wb.click();else toast("Tu as déjà tourné la roue aujourd’hui : reviens demain !");return}
  if(k==="guild"){U.tab="l";render();window.scrollTo({top:0});loadBoards();toast("Crée ta guilde, rejoins-en une avec un code, ou trouve-en une dans l’annuaire.");return}
  if(k==="push"){pushEnable();return}if(k==="fav"){openFav();return}if(k==="insta"){openInsta();setTimeout(()=>loadGuide(true),1500);return}if(k==="fb"){openFb();setTimeout(()=>loadGuide(true),1500);return}
  if(k==="combo"){openHelp("combo");return}}

// 4) aide « Comment ça marche ? »
const HELP=[["Parier",[
  ["cote","Qu’est-ce qu’une cote ?","La cote dit combien rapporte un pari. <b>Gain = mise × cote.</b> Exemple : 20 jetons à 2,50 → 50 jetons si c’est bon (dont tes 20 de mise). Plus la cote est haute, moins le résultat est probable. Les cotes sont calculées par un modèle statistique."],
  ["1n2","1, N, 2 : ça veut dire quoi ?","<b>1</b> = l’équipe de gauche (à domicile) gagne. <b>N</b> = match nul. <b>2</b> = l’équipe de droite (à l’extérieur) gagne. Au tennis et en NBA, pas de nul : 1 ou 2."],
  ["parier","Comment parier ?","1) Touche une cote : elle va dans ton ticket. 2) Touche <b>Mon ticket</b> en bas. 3) Choisis ta mise. 4) Touche <b>Valider</b>. Touche le match lui-même pour voir tous les paris : buteurs, cartons, corners, essais, aces…"],
  ["combo","Pari simple ou combiné ?","Avec plusieurs pronostics dans ton ticket, tu choisis : <b>Simples</b> = un pari séparé pour chacun (la mise est comptée pour chacun). <b>Combiné</b> = un seul pari, les cotes se multiplient, mais <b>tout</b> doit être bon. Deux paris liés sur le même match ont une cote recalculée."],
  ["direct","Parier en direct","Sur les <b>vrais matchs de foot et de rugby</b>, les paris restent ouverts pendant le jeu : jusqu’à la <b>85<sup>e</sup> minute</b> au foot et la <b>72<sup>e</sup></b> au rugby. Repère l’étiquette <b>Direct · paris ouverts</b> sur le match. En direct, seuls les paris sur le résultat, les buts ou les points sont proposés, et la cote change avec le score : si elle bouge au moment de valider, l’appli te demande de vérifier. Au tennis et en NBA, tout se ferme au coup d’envoi.<br><br>Pendant le direct, sur un match que tu regardes, où tu as parié, ou de ton équipe de cœur : <b>animation</b> à chaque but, carton ou essai (appli ouverte). Appli fermée : <b>notification</b> à chaque but, carton ou essai d’un match où tu as parié (avec quelques minutes de retard ; plusieurs actions d’affilée arrivent ensemble)."],
  ["regle","Quand mon pari est-il réglé ?","Tout seul, dès que le score et la stat du pari sont connus, en général quelques minutes après la fin. Tu reçois une notification si elles sont activées. Si une stat n’est jamais publiée (48 h) ou si le match est reporté, la sélection est <b>remboursée</b> (cote 1,00 dans un combiné)."],
  ["cash","Encaisser un pari","Dans <b>Mes paris</b>, tant que le match n’est pas fini, tu peux souvent encaisser tout de suite : tu sécurises un montant (plus petit que le gain possible) et le pari s’arrête là."]]],
 ["Jetons et classements",[
  ["jetons","Les jetons","Ils sont <b>fictifs</b> : aucune valeur, rien à acheter, rien à retirer. Tu commences avec 1 000. Si tu tombes à zéro, Carrière › Recommencer te redonne 1 000 jetons."],
  ["div","Niveaux et XP","Chaque pari terminé rapporte de l’<b>XP</b> : +10, plus un bonus quand il est gagné, d’autant plus gros que la cote est haute (+15 × (cote − 1), jusqu’à 200). Défis, combats de guildes, prono, match de la guilde et podiums du mois en rapportent aussi. Les niveaux vont de 1 à 100 et plus : Spectateur, Supporter, Habitué, Abonné, Ultra, Capo, Connaisseur, Expert, Consultant, Analyste, Stratège, Oracle, Légende. Ça ne redescend jamais, et ça ne s’achète pas avec des jetons."],
  ["roue","Roue de la chance et défis du jour","Un tour de roue gratuit par jour et 3 défis du jour (par exemple « gagne un pari à plus de 2,00 »). Ces jetons ne comptent pas dans les classements."],
  ["classement","Classements de la semaine et du mois","Ils comptent seulement les jetons gagnés <b>en pariant</b> (gains − mises perdues). La semaine repart le lundi, le mois le 1er. À la fin du mois, chaque guilde récompense son podium : 1er +1 000, 2e +500, 3e +250, les autres +25 (avec au moins un pari terminé dans le mois)."]]],
 ["Guildes",[
  ["guilde","C’est quoi une guilde ?","Un groupe de joueurs (jusqu’à 100) : amis, collègues, famille. Elle a son classement, son chat, son prono du week-end, son match du jour, ses duels. Tu peux être dans plusieurs guildes."],
  ["rejoindre","Créer ou rejoindre une guilde","Onglet Guildes : <b>Créer</b> (tu deviens chef), <b>Rejoindre avec un code</b> (le code donné par un membre), ou <b>Trouver une guilde</b> dans l’annuaire. Pour inviter, touche <b>Inviter</b> et partage le lien."],
  ["roles","Chef et adjoints","Le chef choisit l’emblème, la devise, qui peut entrer (ouverte, sur demande, privée), nomme des adjoints et peut passer la main. Le chef et les adjoints acceptent les demandes, excluent un membre et suppriment les messages déplacés."],
  ["prono","Prono du week-end, match du jour, duels","<b>Prono</b> : devine le score exact de quelques matchs du week-end ; les points rapportent des jetons. <b>Match de la guilde</b> : chacun vote 1, N ou 2 sur le match du jour. <b>Duel</b> : défie un membre sur un match, le gagnant prend la mise."],
  ["combat","Combats de guildes","Chaque lundi, le championnat donne à ta guilde (au moins 3 membres) un adversaire de niveau proche. Le chef ou un adjoint peut aussi défier une autre guilde pour la semaine suivante. Score = <b>moyenne des gains en paris</b> de tous les membres (ceux qui ne parient pas comptent 0). Résultat le mardi matin, avec une cote et une division (Bronze → Diamant). Les membres qui ont parié reçoivent +200 (victoire), +75 (nul) ou +25 (défaite)."]]],
 ["Ton compte",[
  ["code","Changer de téléphone ou réinstaller","Ton compte n’a ni e-mail ni mot de passe : garde ton <b>code de compte</b> (Carrière). Sur le nouveau téléphone, au moment de choisir ton pseudo, touche « J’ai déjà un compte » et entre le code : tu retrouves tout."],
  ["install","Installer l’app","Pas de store : sur iPhone, dans Safari, Partager › Sur l’écran d’accueil. Sur Android, menu ⋮ › Installer l’application. Détails dans Carrière › Installer l’app."],
  ["notif","Notifications","Active-les avec la cloche en haut ou dans Carrière : coup d’envoi de tes matchs, résultats, rappels (0, 1 ou 2 par jour), messages de ta guilde. Sur iPhone, il faut d’abord installer l’app."],
  ["securite","Signaler, bloquer, supprimer","Dans le chat, touche <b>•••</b> sur un message pour le signaler ou bloquer son auteur. Un pseudo se signale depuis sa fiche. Tu peux supprimer ton compte dans Carrière. Une question ? Carrière › Nous écrire."]]]];
function openHelp(focus){U.open="help";layer(`<div class="grab"><h3>Comment ça marche ?</h3><button class="x" data-act="close" aria-label="Fermer">${ic("x")}</button></div>
  <div class="hbtns"><button class="btn ghost" data-act="intro">▶️ Revoir la présentation</button><button class="btn ghost" data-act="coach">🎟️ Match d’entraînement</button></div>
  <div class="grp">Les animations du direct</div><div class="hbtns h4"><button class="btn ghost" data-act="fxdemo" data-v="g">⚽ But</button><button class="btn ghost" data-act="fxdemo" data-v="yc">🟨 Jaune</button><button class="btn ghost" data-act="fxdemo" data-v="rc">🟥 Rouge</button><button class="btn ghost" data-act="fxdemo" data-v="try">🏉 Essai</button></div>
  ${HELP.map(([g,L])=>`<div class="grp">${g}</div>`+L.map(([k,q,a])=>`<details class="hq" id="hq-${k}"${k===focus?" open":""}><summary>${q}</summary><p>${a}</p></details>`).join("")).join("")}
  <p class="note">Pas trouvé ? <button class="link" data-act="contact" style="padding:0">Écris-nous</button>, ou retrouve-nous sur <a href="${IG_URL}" target="_blank" rel="noopener" style="color:var(--acc)">Instagram @tribune.pronos</a>.</p>`);
  if(focus)setTimeout(()=>{const e=$("#hq-"+focus);if(e)e.scrollIntoView({block:"center"})},80)}

/* ---------- règles du jeu, confidentialité, modération, suppression du compte ---------- */
const TOS_V="2026-11c";
function legalHTML(){return`<div class="legal">
<p class="lgl-up">Version du 11 novembre 2026</p>
<h4>1. Le jeu</h4>
<p>Tribune est un jeu <b>100 % gratuit</b> de pronostics sportifs, créé et géré par un particulier pour jouer entre amis, sans but commercial et sans publicité.</p>
<p>Les <b>jetons sont fictifs</b> : ils n’ont aucune valeur, ne s’achètent pas, ne se vendent pas, ne s’échangent pas et ne se convertissent jamais en argent, en cadeau ou en avantage réel. Les récompenses (roue, défis, classements, combats de guildes, concours…) sont uniquement des jetons fictifs ou des éléments de style dans l’appli (cadres, bannières, titres), sans aucune valeur et impossibles à échanger. Tribune n’est donc pas un jeu d’argent : on ne mise jamais d’argent et on ne gagne rien de réel.</p>
<h4>2. Réservé aux 18 ans et plus</h4>
<p>Parce qu’il reprend le principe des paris sportifs, Tribune est réservé aux personnes majeures. En jouant, tu confirmes avoir 18 ans ou plus.</p>
<h4>3. Cotes, scores et résultats</h4>
<p>Les scores et statistiques viennent d’un flux public ; les cotes sont calculées par un modèle statistique, à titre indicatif. Des erreurs ou retards sont possibles : un pari peut être remboursé ou corrigé si une donnée était fausse. Le jeu peut évoluer, être interrompu ou remis à zéro, sans garantie ni compensation.</p>
<h4>4. Bonne conduite</h4>
<p>Pseudos, noms de guilde, devises et messages doivent rester corrects. Sont interdits : insultes, propos racistes, sexistes, homophobes ou haineux, harcèlement, contenus sexuels ou violents, publication d’informations personnelles sur quelqu’un, spam, triche (bugs exploités, plusieurs comptes pour gonfler un classement).</p>
<p><b>Modération automatique</b> : les mots grossiers ou haineux sont refusés dans les noms et masqués dans le chat. Chacun peut <b>signaler</b> un message, un pseudo ou une guilde et <b>bloquer</b> un joueur. Un message signalé par plusieurs membres est masqué ; un pseudo ou un nom de guilde signalé par trois joueurs différents est remplacé. Le chef et les adjoints d’une guilde peuvent supprimer les messages de leur chat et exclure un membre. En cas d’abus grave, un compte peut être supprimé.</p>
<p><b>Images</b> : tu dois avoir le droit d’utiliser les images que tu mets dans l’appli (photo de profil, logo de guilde). Pas de photo de quelqu’un sans son accord, pas de logo d’entreprise ou de marque sans l’accord de son propriétaire. Une image déplacée peut être signalée ; elle est retirée automatiquement après plusieurs signalements, ou par les organisateurs.</p>
<h4>5. Ton compte</h4>
<p>Pas d’e-mail ni de mot de passe : ton compte est lié à ton téléphone et à ton <b>code de compte</b>. Garde-le pour toi : quiconque l’a peut récupérer ton compte. Tu peux supprimer ton compte à tout moment dans Carrière › Supprimer mon compte.</p>
<h4>6. Données personnelles</h4>
<p><b>Responsable</b> : l’organisateur de Tribune (un particulier), joignable à <a href="mailto:contact.tribuneps@gmail.com" style="color:var(--acc)">contact.tribuneps@gmail.com</a>.</p>
<p><b>Ce qui est enregistré</b> : ton pseudo, ta photo de profil si tu en mets une, ton style et les réglages de ta carte de joueur, tes jetons, tes paris et tes statistiques, tes guildes (et leur logo si un chef ou un adjoint en met un), tes messages de chat, tes pronostics et duels, ton équipe de cœur, ton choix d’apparaître ou non sur nos réseaux, ta date d’acceptation de ces règles, et, si tu les actives, l’adresse technique de tes notifications. Pour limiter les abus, une empreinte de ton adresse IP est utilisée, brouillée et changée chaque jour : elle ne permet pas de te retrouver.</p>
<p><b>Ce qui n’est pas enregistré</b> : ni nom réel, ni e-mail (sauf si tu nous écris toi-même par e-mail), ni téléphone, ni position, ni contacts. Aucun traceur publicitaire, aucune revente, aucun partage commercial. Ton téléphone garde une copie de ta partie (stockage local), nécessaire au jeu ; il n’y a pas de cookie publicitaire.</p>
<p><b>Pourquoi</b> : faire fonctionner le jeu (base légale : l’exécution du service que tu utilises) et le protéger des abus (intérêt légitime).</p>
<p><b>Qui les voit</b> : les joueurs voient ton pseudo, ta photo et tes résultats dans les classements ; les membres de tes guildes voient aussi tes paris, ton profil et tes messages. Les données sont hébergées par des prestataires techniques : Vercel (site et serveur) et Neon (base de données), qui peuvent se trouver hors de l’Union européenne avec les garanties prévues par le RGPD. Les notifications passent par le service de ton téléphone (Apple, Google ou Mozilla). Les publications sur nos réseaux sont hébergées par Meta (Instagram, Facebook). Les messages envoyés avec « Nous écrire » (avec ton pseudo) sont transmis par Resend (service d’envoi d’e-mails) vers la boîte de contact des organisateurs, hébergée par Google (Gmail).</p>
<p><b>Réseaux sociaux de Tribune</b> : pour faire vivre le jeu, Tribune peut montrer sur ses comptes Instagram et Facebook (@tribune.pronos) ton <b>pseudo</b>, ta <b>carte de joueur</b> (photo de profil comprise) et tes <b>résultats dans le jeu</b> : classements, meilleurs coups ou tickets de la semaine, guilde. Jamais ton code de compte, tes messages de chat ou une information qui permettrait de savoir qui tu es en vrai. Tu peux refuser à tout moment dans Carrière › Réglages › « Apparaître sur nos réseaux » : tu n’apparais plus, ou seulement comme « un joueur ». Pour faire retirer une publication déjà en ligne, écris-nous (base légale : intérêt légitime à faire connaître le jeu).</p>
<p><b>Combien de temps</b> : tant que ton compte existe. Quand tu le supprimes, tout est effacé tout de suite (paris, messages, photo, guildes dont tu étais le seul membre…) ; seuls les signalements et les messages envoyés aux organisateurs (formulaire ou e-mail) sont gardés au plus un an, puis supprimés.</p>
<p><b>Tes droits</b> : accès, rectification (change ton pseudo), effacement (supprime ton compte), opposition et limitation. Pour toute demande : Carrière › Nous écrire, ou par e-mail à <a href="mailto:contact.tribuneps@gmail.com" style="color:var(--acc)">contact.tribuneps@gmail.com</a>. Tu peux aussi saisir la CNIL (cnil.fr).</p>
<h4>7. Jeu responsable</h4>
<p>Tribune se joue sans argent, mais reprend le principe des paris sportifs. Les <b>vrais paris d’argent</b> présentent des risques : perte d’argent, endettement, dépendance, isolement. Ici, on joue pour le plaisir entre amis : ne mise jamais de vrai argent pour « te refaire » ou pour prolonger le jeu.</p>
<p>Tribune n’a <b>aucun lien avec un site de paris</b>, n’en fait pas la promotion et ne reçoit rien de leur part. Les cotes sont calculées par l’appli : ce ne sont <b>pas celles d’un bookmaker</b>, et réussir ici ne veut pas dire réussir avec de l’argent.</p>
<p>Si les paris (d’argent ou non) prennent trop de place pour toi ou un proche, parles-en : <a href="https://www.joueurs-info-service.fr" target="_blank" rel="noopener">Joueurs Info Service</a>, 09 74 75 13 13 (appel non surtaxé, 7 j/7).</p>
<h4>8. Divers</h4>
<p>Les noms, logos et drapeaux des équipes appartiennent à leurs propriétaires et servent seulement à reconnaître les matchs. Ces règles peuvent évoluer ; en cas de changement important, l’appli te les remontre. Droit français.</p>
<h4>9. Mentions légales</h4>
<p><b>Édition</b> : Tribune est édité par un particulier, à titre non commercial. Contact : <a href="mailto:contact.tribuneps@gmail.com" style="color:var(--acc)">contact.tribuneps@gmail.com</a>.</p>
<p><b>Hébergement</b> : Vercel Inc., 440 N Barranca Ave #4133, Covina, CA 91723, États-Unis (vercel.com). Base de données : Neon Inc. (neon.tech).</p>
<p><b>Données sportives</b> : scores et statistiques issus d’un flux public (ESPN) ; Tribune n’est lié à aucune compétition, équipe ou ligue.</p></div>`}
function openLegal(){U.open="legal";layer(`<div class="grab"><h3>Règles et confidentialité</h3><button class="x" data-act="close" aria-label="Fermer">${ic("x")}</button></div>`+legalHTML())}
// joueurs déjà inscrits : on fait accepter les règles une fois (et à chaque nouvelle version)
function openTos(){if(U.open&&U.open!=="tos"){setTimeout(()=>{if(S.name&&S.tosV!==TOS_V)openTos()},5000);return}U.open="tos";layer(`<div class="tosh"><h3>Avant de continuer</h3><p class="note" style="text-align:left">${S.tosV?"Les règles ont été mises à jour (11 novembre) : Tribune peut désormais montrer ton pseudo, ta carte et tes résultats sur ses comptes Instagram et Facebook (tu peux refuser dans Réglages). Prends une minute pour les relire, puis valide pour continuer.":"Tribune s’ouvre à plus de monde : voici les règles du jeu et ce qu’on fait (et ne fait pas) de tes données. Prends une minute pour les lire."}</p></div>`+legalHTML()+
  `<label class="agechk"><input type="checkbox" id="tos-ok"><span>J’ai <b>18 ans ou plus</b> et j’accepte les règles du jeu et la politique de confidentialité.</span></label>
  <button class="btn gold wide" data-act="tosok">Continuer</button><p class="note"><button class="link" data-act="tosno">Je n’ai pas 18 ans</button></p>`)}
function tosOk(){if(!$("#tos-ok")||!$("#tos-ok").checked){toast("Coche la case pour continuer.","bad");return}S.tosV=TOS_V;save();closeLayer();syncSoon();if(S.introSeen!==INTRO_V)setTimeout(openIntro,400)}
function tosNo(){U.open="tos";layer(`<div class="tosh"><h3>Désolé</h3></div><div class="empty">${ic("info")}<b>Tribune est réservé aux 18 ans et plus</b>Si tu t’es trompé, reviens en arrière.<br><button class="btn ghost" style="margin-top:12px" data-act="tosback">Revenir</button><br><button class="link" data-act="delacc" style="margin-top:10px;color:var(--loss)">Supprimer mon compte</button></div>`)}
// signaler / bloquer
const blocked=id=>(S.blocked||[]).some(x=>String(x.id)===String(id));
function toggleBlock(id,name){S.blocked=S.blocked||[];if(blocked(id)){S.blocked=S.blocked.filter(x=>String(x.id)!==String(id));toast(`${esc(name)} est débloqué.`)}
  else{if(!confirm(`Bloquer ${name} ? Tu ne verras plus ses messages dans le chat.`))return;S.blocked.push({id:String(id),name:String(name).slice(0,18)});toast(`${esc(name)} est bloqué : tu ne verras plus ses messages.`,"win")}
  save();if(U.open==="prof"||U.open==="chmenu"||U.open==="blocked")closeLayer();if(U.open==="blocked")openBlocked();render()}
async function report(kind,id,what){if(!confirm(`Signaler ${what} ? Les signalements sont anonymes.`))return;
  try{const j=await api("report",{kind,id});if(j.error)throw j;closeLayer();
    toast(j.hidden?"Merci : le message est masqué.":j.renamed?(kind==="guild"?"Merci : le nom et le logo de la guilde ont été retirés.":"Merci : le nom a été remplacé."):"Merci, c’est signalé. Plusieurs signalements entraînent une action automatique.","win");
    if(kind==="chat"&&j.hidden){const c=CH[U.lg.code];if(c)c.msgs=c.msgs.filter(m=>String(m.id)!==String(id));render()}}
  catch(e){toast("Impossible de signaler pour l’instant.","bad")}}
function openChMenu(id){const c=CH[U.lg.code],m=c&&c.msgs.find(x=>String(x.id)===String(id));if(!m)return;const cur=U.lg.data&&U.lg.data.leagues.find(l=>l.code===U.lg.code),boss=cur&&(cur.mine||cur.role==="officer");
  U.open="chmenu";layer(`<div class="grab"><h3>Message de ${esc(m.name)}</h3><button class="x" data-act="close" aria-label="Fermer">${ic("x")}</button></div><p class="chquote">${esc(m.text).replace(/\n/g,"<br>")}</p>
  <div class="mlist"><button data-act="rep" data-k="chat" data-id="${esc(m.id)}" data-w="ce message">🚩 Signaler ce message</button><button data-act="block" data-id="${esc(m.who)}" data-n="${esc(m.name)}">🚫 Bloquer ${esc(m.name)}</button>
  ${boss?`<button data-act="chdel" data-id="${esc(m.id)}" style="color:var(--loss)">🗑️ Supprimer le message (chef / adjoint)</button>`:""}</div>`)}
function openBlocked(){U.open="blocked";const L=S.blocked||[];layer(`<div class="grab"><h3>Joueurs bloqués</h3><button class="x" data-act="close" aria-label="Fermer">${ic("x")}</button></div>`+
  (L.length?L.map(x=>`<div class="gmrow"><div><b>${esc(x.name)}</b><small>Ses messages sont cachés</small></div><button class="btn ghost" data-act="block" data-id="${esc(x.id)}" data-n="${esc(x.name)}">Débloquer</button></div>`).join(""):`<div class="empty">Personne n’est bloqué.</div>`))}
function openContact(){U.open="contact";layer(`<div class="grab"><h3>Nous écrire</h3><button class="x" data-act="close" aria-label="Fermer">${ic("x")}</button></div>
  <p class="note" style="text-align:left">Une question, un bug, une idée, un problème avec un joueur, une demande sur tes données ? Écris ici : le message arrive directement aux organisateurs.</p>
  <div class="form"><label>Raison<select id="ct-why">${CT_WHY.map(x=>`<option>${x}</option>`).join("")}</select></label><textarea id="ct-in" rows="5" maxlength="1500" placeholder="Ton message…"></textarea><button class="btn gold wide" data-act="ctsend">Envoyer</button></div>
  <p class="note">Tu préfères l’e-mail ? <a href="mailto:contact.tribuneps@gmail.com?subject=Tribune" style="color:var(--acc)">contact.tribuneps@gmail.com</a></p>`);setTimeout(()=>$("#ct-in")&&$("#ct-in").focus(),60)}
const CT_WHY=["❓ Question","🐞 Bug / problème","💡 Idée / suggestion","🚩 Signaler un joueur ou une guilde","🪙 Jetons / paris","🔒 Mon compte / mes données","🤝 Partenariat","✏️ Autre"];
async function contactSend(){const t=($("#ct-in").value||"").trim(),w=$("#ct-why")?$("#ct-why").value:"";if(t.length<3){$("#ct-in").focus();return}
  try{if(!(await ensureSession()))throw 0;const j=await api("contact",{text:t,why:w});if(j.error)throw j;closeLayer();toast("Message envoyé, merci !","win")}catch(e){toast("Pas de connexion : réessaie plus tard.","bad")}}
function openDelAcc(){U.open="delacc";layer(`<div class="grab"><h3>Supprimer mon compte</h3><button class="x" data-act="close" aria-label="Fermer">${ic("x")}</button></div>
  <div class="warn" style="text-align:left">C’est <b>définitif</b> : tes jetons, tes paris, ta photo, tes messages, tes statistiques et ton code de compte sont effacés du serveur et de ce téléphone. Si tu es chef d’une guilde, un autre membre prend la main ; une guilde où tu es seul disparaît.</div>
  <div class="form"><label><span>Écris <b>SUPPRIMER</b> pour confirmer</span><input id="del-in" autocomplete="off" autocapitalize="characters" placeholder="SUPPRIMER"></label>
  <button class="btn wide" data-act="delgo" style="background:var(--loss);color:#fff">Supprimer définitivement</button></div>`)}
async function delAccount(){const v=($("#del-in").value||"").trim().toUpperCase();if(v!=="SUPPRIMER"){toast("Écris SUPPRIMER pour confirmer.","bad");return}
  try{if(S.tok){const j=await api("delete_account",{confirm:"SUPPRIMER"});if(j.error)throw j}
    GONE=true;S.tok=null;
    try{for(const k of Object.keys(localStorage))if(/^dap\./.test(k))localStorage.removeItem(k)}catch(e){}
    try{const r=await navigator.serviceWorker?.ready;const sub=r&&await r.pushManager.getSubscription();if(sub)await sub.unsubscribe()}catch(e){}
    alert("Ton compte est supprimé. Merci d’avoir joué !");location.replace(location.pathname)}
  catch(e){toast("Pas de connexion : la suppression n’a pas pu se faire.","bad")}}

/* ---------- combats de guildes : défis et championnat (moyenne des gains en paris de tous les membres) ---------- */
const sgnT=x=>(x>0?"+":"")+tok(x);
const BRES={w:["Victoire","won"],d:["Match nul","void"],l:["Défaite","lost"]};
async function loadBattles(code){if(!code||!S.tok)return;try{const j=await api("battle_list",{code});U.bt=U.bt||{};U.bt[code]=j;
  if(U.tab==="l"&&!U.open&&U.lg.code===code)render();if(U.open==="gbt")layer(viewBtDetail());
  if(j.battles.some(b=>b.status==="done"))claimBattles()}catch(e){}}
let bcAt=0;
async function claimBattles(){if(!S.tok||Date.now()-bcAt<6e4)return;bcAt=Date.now();try{const j=await api("battle_claim",{});if(!j.rewards||!j.rewards.length)return;
  const t=j.rewards.reduce((a,x)=>a+x.amount,0);S.bal+=t;S.peak=Math.max(S.peak,S.bal);save();render();bump();if(j.rewards.some(x=>x.result==="w"))confetti();
  toast(`⚔️ Combats de guildes : +${tok(t)} jetons !`,"win")}catch(e){}}
function btLeft(b){const ms=b.end-Date.now();if(ms<=0)return"Résultat mardi matin";const d=Math.floor(ms/864e5);return d>=1?`Fin dans ${d} j`:`Fin ce soir à minuit`}
function btLive(b){const lo=Math.min(b.my,b.their,0),a=b.my-lo+1,c=b.their-lo+1,pct=Math.round(100*a/(a+c)),bet=(b.team||[]).filter(x=>x.gain!=null).length;
  return`<div class="btlive" data-act="gbt" data-id="${esc(b.id)}"><div class="btk">${b.kind==="league"?"🏟️ Championnat":"⚔️ Défi"} · ${btLeft(b)}</div>
  <div class="btvs"><div class="side"><b class="btsc ${b.my>b.their?"pos":b.my<b.their?"neg":""}">${sgnT(b.my)}</b><small>Nous</small></div><span class="btx">VS</span>
  <div class="side"><b class="btsc">${sgnT(b.their)}</b><small>${emb(b.vs)}${esc(b.vs.name)}</small></div></div>
  <div class="btbar"><i style="width:${pct}%"></i></div><small class="btsub">${bet}/${b.myN} membre${b.myN>1?"s ont":" a"} parié cette semaine · détail ›</small></div>`}
function viewBattle(cur){const j=(U.bt||{})[cur.code];if(!j)return"";const g=j.guild,boss=j.role!=="membre",B=j.battles;
  const live=B.filter(b=>b.status==="live"),ready=B.filter(b=>b.status==="ready"),pin=B.filter(b=>b.status==="pending"&&b.incoming),pout=B.filter(b=>b.status==="pending"&&!b.incoming),done=B.filter(b=>b.status==="done");
  let h=`<div class="btcard"><button class="bthd" data-act="gwr"><span class="btdiv">${gdivImg(gdivI(g.elo),"gdis")} ${GDIV[gdivI(g.elo)][0]}</span><small>Cote ${g.elo} · ${g.w}V ${g.d}N ${g.l}D · ${g.rank}<sup>e</sup> mondial</small><span class="arr">›</span></button>`;
  if(!g.ok)h+=`<p class="btnote">Il faut au moins ${j.min} membres pour combattre d’autres guildes. Invite tes potes !</p>`;
  h+=live.map(btLive).join("");
  h+=ready.map(b=>`<div class="btline">⚔️ <span>Défi accepté contre ${emb(b.vs)}<b>${esc(b.vs.name)}</b> · commence lundi</span></div>`).join("");
  h+=pin.map(b=>`<div class="btline">⚔️ <span>${emb(b.vs)}<b>${esc(b.vs.name)}</b> vous défie pour la semaine prochaine${boss?"":" · le chef ou un adjoint répond"}</span>
    ${boss?`<span class="btans"><button class="btn gold" data-act="gbans" data-id="${esc(b.id)}" data-v="1">Accepter</button><button class="x" data-act="gbans" data-id="${esc(b.id)}" data-v="0" aria-label="Refuser">${ic("x")}</button></span>`:""}</div>`).join("");
  h+=pout.map(b=>`<div class="btline">⏳ <span>Défi envoyé à ${emb(b.vs)}<b>${esc(b.vs.name)}</b> · en attente</span>${boss?`<button class="link" data-act="gbans" data-id="${esc(b.id)}" data-v="c">Retirer</button>`:""}</div>`).join("");
  if(!live.length&&g.ok)h+=`<p class="btnote">${g.champ?"Championnat : chaque lundi, un adversaire de votre niveau est tiré automatiquement.":"Championnat en pause (réglage du chef)."}</p>`;
  const L=done[0];if(L)h+=`<button class="btline" data-act="gbt" data-id="">🏁 <span>Dernier combat : <span class="tag ${BRES[L.res][1]}">${BRES[L.res][0]}</span> contre <b>${esc(L.vs.name)}</b> (${sgnT(L.my)} à ${sgnT(L.their)})</span><span class="arr">›</span></button>`;
  h+=`<div class="btbtns">${boss&&g.ok?`<button class="btn" data-act="gwr" data-v="chal">⚔️ Défier une guilde</button>`:""}<button class="btn ghost" data-act="gwr">🌍 Classement des guildes</button></div></div>`;
  return h}
function openBtDetail(id){U.btSel=id;U.open="gbt";layer(viewBtDetail())}
function viewBtDetail(){const j=(U.bt||{})[U.lg.code];const head=`<div class="grab"><h3>Combats de guildes</h3><button class="x" data-act="close" aria-label="Fermer">${ic("x")}</button></div>`;
  if(!j)return head+`<div class="skel"></div>`;
  const b=j.battles.find(x=>String(x.id)===String(U.btSel)&&x.status==="live");let h=head;
  if(b){h+=btLive(b).replace('data-act="gbt"','')+`<div class="grp">Notre équipe (${b.myN})</div>`+(b.team||[]).map(m=>`<div class="gmrow">${avatar(m.id,m.name,m.av,"av")}<div><b>${esc(m.name)}${String(m.id)===String(j.me)?" (toi)":""}</b><small>${m.gain==null?"Pas encore de pari terminé cette semaine":"Gains en paris cette semaine"}</small></div><b class="${m.gain==null?"":m.gain>=0?"pos":"neg"}">${m.gain==null?"0":sgnT(m.gain)}</b></div>`).join("")}
  const done=j.battles.filter(x=>x.status==="done");
  if(done.length)h+=`<div class="grp">Derniers combats</div>`+done.map(x=>`<div class="gmrow">${emb(x.vs,"lg")}<div><b>${esc(x.vs.name)}</b><small>${x.kind==="league"?"Championnat":"Défi"} · semaine du ${new Date(x.week+"T12:00").toLocaleDateString("fr-FR",{day:"numeric",month:"short"})} · ${sgnT(x.my)} à ${sgnT(x.their)}</small></div><span class="tag ${BRES[x.res][1]}">${BRES[x.res][0]}</span><small class="${x.delta>=0?"pos":"neg"}" style="margin-left:6px">${x.delta>0?"+":""}${x.delta}</small></div>`).join("");
  const R=j.reward;
  h+=`<div class="grp">Les règles</div><p class="note" style="text-align:left">Le score d’une guilde, c’est la <b>moyenne des gains en paris</b> de la semaine (du lundi au dimanche) de <b>tous</b> ses membres, même ceux qui ne parient pas (ils comptent 0). Les membres sont figés au début du combat. La roue, les défis et les bonus ne comptent pas.<br><br>
  🏟️ <b>Championnat</b> : chaque lundi, un adversaire de cote proche est tiré automatiquement.<br>⚔️ <b>Défi</b> : le chef ou un adjoint défie une guilde pour la semaine suivante (un défi par semaine).<br><br>
  🎁 Récompense pour chaque membre qui a parié pendant la semaine : victoire <b>+${R.w}</b>, nul <b>+${R.d}</b>, défaite <b>+${R.l}</b> jetons. Résultat le mardi matin.<br><br>
  Divisions selon la cote : Bronze, Argent (1050), Or (1100), Platine (1150), Diamant (1200) et Légende (1250).</p>`;
  return h}
// divisions des guildes : écussons dessinés, de Bronze à Légende
const GDIV=[["Bronze",-1e9],["Argent",1050],["Or",1100],["Platine",1150],["Diamant",1200],["Légende",1250]];
const gdivI=elo=>{let i=0;GDIV.forEach((d,k)=>{if(elo>=d[1])i=k});return i};
const gdivImg=(i,cls="gdi")=>`<img class="${cls}" src="gdiv/g${i+1}.webp?v=1" alt="${GDIV[i][0]}">`;
function gLadder(elo){const i=gdivI(elo),nx=GDIV[i+1],pv=GDIV[i][1]<0?1000:GDIV[i][1],pct=nx?Math.max(4,Math.min(100,(elo-pv)/(nx[1]-pv)*100)):100;
  return`<div class="gldr"><div class="gldrc">${gdivImg(i,"gdbig")}<div><small>Division de ta guilde</small><b>${GDIV[i][0]}</b><span>Cote ${elo}</span></div></div>
    <div class="gldbar"><i style="width:${pct}%"></i></div><p class="gldn">${nx?`Encore <b>${nx[1]-elo}</b> point${nx[1]-elo>1?"s":""} de cote pour passer <b>${nx[0]}</b>`:"Tout en haut : division maximale 👑"}</p>
    <div class="gldl">${GDIV.map((d,k)=>`<div class="${k<i?"ok":k===i?"cur":"lock"}">${gdivImg(k)}<small>${d[0]}</small><em>${d[1]<0?"départ":d[1]}</em></div>`).join("")}</div>
    <p class="gldn" style="margin-top:6px">La cote monte en gagnant les combats de guildes du lundi, et baisse en les perdant.</p></div>`}
async function openGRank(chal){U.open="gwr";const head=`<div class="grab"><h3>${chal?"Défier une guilde":"Classement des guildes"}</h3><button class="x" data-act="close" aria-label="Fermer">${ic("x")}</button></div>`;
  layerLater(head+`<div class="skel"></div><div class="skel"></div>`);
  try{const j=await api("guild_ranking",{});if(U.open!=="gwr")return;const me=(U.bt||{})[U.lg.code],boss=me&&me.role!=="membre"&&me.guild.ok;
    const mine=j.guilds.find(g=>g.mine),myElo=me&&me.guild&&me.guild.elo!=null?me.guild.elo:mine?mine.elo:null;
    layer(head+(chal?`<p class="note" style="text-align:left">Le défi dure une semaine et commence lundi prochain. La guilde défiée doit accepter.</p>`:myElo!=null?gLadder(myElo):"")
      +(j.guilds.length?j.guilds.map((g,i)=>`<div class="gdrow"><span class="rk">${i+1}</span>${emb(g,"lg")}<div><b>${esc(g.name)}</b><small>${gdivImg(gdivI(g.elo),"gdis")} ${GDIV[gdivI(g.elo)][0]} · cote ${g.elo} · ${g.w}V ${g.d}N ${g.l}D · ${g.n} membres</small></div>
        ${g.mine?`<span class="tag won">Toi</span>`:`<button class="x sm" data-act="rep" data-k="guild" data-id="${esc(g.gid)}" data-w="la guilde « ${esc(g.name)} » (nom ou logo déplacé)" aria-label="Signaler">🚩</button>`+(boss?`<button class="btn ${chal?"gold":""}" data-act="gchal" data-id="${esc(g.gid)}" data-n="${esc(g.name)}">Défier</button>`:"")}</div>`).join("")
      :`<div class="empty">${ic("trophy")}<b>Pas encore de guilde classée</b>Il faut au moins 3 membres pour entrer au classement.</div>`))}
  catch(e){if(U.open==="gwr")layer(head+`<div class="empty">${ic("info")}<b>Pas de connexion</b>Réessaie dans un instant.</div>`)}}
const BERR={already:"Défi déjà envoyé à cette guilde.",busy:"Une des deux guildes a déjà un défi la semaine prochaine.",too_small:"Il faut au moins 3 membres dans chaque guilde.",too_many:"3 défis en attente au maximum.",not_allowed:"Seuls le chef et les adjoints peuvent faire ça."};
async function btChallenge(gid,name){if(!confirm(`Défier « ${name} » pour la semaine prochaine ?`))return;
  try{const j=await api("battle_challenge",{code:U.lg.code,gid});if(j.error)throw j;closeLayer();toast("Défi envoyé ! Leur chef doit accepter.","win");loadBattles(U.lg.code)}
  catch(e){toast(BERR[e.code||e.error]||"Impossible d’envoyer le défi.","bad")}}
async function btAnswer(id,v){if(v==="c"&&!confirm("Retirer ce défi ?"))return;
  try{const j=await api("battle_answer",{id,accept:v==="1"});if(j.error)throw j;toast(v==="1"?"Défi accepté : rendez-vous lundi !":v==="0"?"Défi refusé.":"Défi retiré.","win");loadBattles(U.lg.code)}
  catch(e){toast(BERR[e.code||e.error]||"Action impossible.","bad")}}

/* ---------- fil d'activité de la guilde ---------- */
const EMOS=["🔥","😂","👏","😱"];
function postAct(kind,data){if(!S.name)return;ensureSession().then(ok=>ok&&api("act",{kind,data}).catch(()=>{}))}
function ago(t){const m=Math.round((Date.now()-t)/6e4);return m<1?"à l’instant":m<60?`il y a ${m} min`:m<1440?`il y a ${Math.round(m/60)} h`:`il y a ${Math.round(m/1440)} j`}
async function loadActFeed(){const c=U.lg.code;if(!c)return;try{const j=await api("feed",{code:c});if(U.lg.code===c){U.lg.feed=j.items;U.lg.luck=j.luck||[];U.lg.feedAt=Date.now()}}catch(e){U.lg.feed=U.lg.feed||[]}
  if(U.tab==="l"&&!U.open)render()}
// fil de guilde : chaque tour de roue, avec un petit mot selon la chance
function wheelAct(d){const v=d.v||0,b=v/(d.d?2:1),t=d.x?"au tour bonus":"à la roue",x2=d.d?` <small class="mut">(roue ×2)</small>`:"";
  return b>=500?`🔥 a décroché le <b style="color:var(--sel)">gros lot</b> ${t} : <b class="pos">+${tok(v)}</b>${x2}`
    :b>=200?`🍀 a gagné <b class="pos">+${tok(v)}</b> ${t}, la chance !${x2}`
    :b>=100?`🎡 a gagné <b>+${tok(v)}</b> ${t}${x2}`
    :b>=50?`🎡 a gagné <b>+${tok(v)}</b> ${t}, peut mieux faire${x2}`
    :`😅 seulement <b>+${tok(v)}</b> ${t}… pas de chance${x2}`}
function actText(a){const d=a.data||{};const legs=(d.legs||[]).map(esc).join(" + ");
  switch(a.kind){
    case"bet":return`a parié <b>${tok(d.stake||0)}</b> sur ${legs||"un match"}${d.n>1&&d.odds?` <span class="mut">(combiné · cote ${fr(+d.odds)})</span>`:d.odds?` <span class="mut">@ ${fr(+d.odds)}</span>`:""}${String(a.who)!==String(U.lg.data&&U.lg.data.me)&&Date.now()-a.at<3*DAY?` <button class="btn gold shbtn" data-act="actfollow" data-id="${esc(a.id)}">🎟️ Parier pareil</button>`:""}`;
    case"won":return d.big?`<span class="bigtag">🔥 Gros coup</span> a gagné <b class="pos">+${tok(d.pay||0)}</b>${d.n>1?` avec un combiné de ${d.n}`:""}${d.odds?` à <b>${fr(+d.odds)}</b>`:""}${legs?` <span class="mut">${legs}</span>`:""}`
      :`a gagné <b class="pos">+${tok(d.pay||0)}</b> ${ic("trophy")}${legs?` <span class="mut">${legs}</span>`:""}`;
    case"lost":return d.one?`💀 a perdu son combiné de ${d.n}… <b>à une seule sélection près</b>${d.last?` <span class="mut">(${esc(d.last)})</span>`:""}`
      :`💸 a perdu <b class="neg">${tok(d.stake||0)}</b> jetons${d.last?` sur ${esc(d.last)}`:""}… aïe`;
    case"streak":return d.w?`🔥 enchaîne <b class="pos">${d.n} pronos gagnés</b> d’affilée !`:`🥶 <b>${d.n} pronos perdus</b> de suite… ça va tourner`;
    case"cash":return`a encaissé <b>${tok(d.pay||0)}</b> avant la fin`;
    case"wheel":return d.v>=1e6?`a touché le <b style="color:var(--sel)">JACKPOT</b> de la roue : <b class="pos">+${tok(d.v)}</b> 💰 (1 chance sur 10 millions !)`:wheelAct(d);
    case"defis":return`a réussi les 3 défis du jour`;
    case"duel":if(d.acc)return`relève le duel de ${esc(d.opp||"?")} : <b>${esc(d.pick||"")}</b> sur ${esc(d.mlabel||"")} <span class="mut">(${tok(d.stake||0)} jetons)</span>`;
      return`lance un duel : <b>${esc(d.pick||"")}</b> sur ${esc(d.mlabel||"")} <span class="mut">(${tok(d.stake||0)} jetons)</span>`;
    case"duelwin":return d.n?`remporte le défi de guilde (${d.n} participants) : <b class="pos">+${tok(d.pay||0)}</b>`:`remporte son duel${d.opp?` contre ${esc(d.opp)}`:""} : <b class="pos">+${tok(d.pay||0)}</b>`;
    case"join":return`a rejoint la guilde`;
    case"share":return`partage son ticket : ${d.n>1?`combiné de ${d.n} · cote <b>${fr(+d.odds||1)}</b>`:`${esc(d.l||"")} @ <b>${fr(+d.odds||1)}</b>`} <button class="btn gold shbtn" data-act="shopen" data-c="${esc(d.code)}">🎟️ Voir / suivre</button>`;
  }return""}
// qui a le plus de chance à la roue cette semaine (moyenne par tour)
function luckBox(){const L=U.lg.luck||[];if(!L.length)return"";const me=String(U.lg.data&&U.lg.data.me),med=["🥇","🥈","🥉"];
  return`<div class="luck"><div class="luckh">🍀 Chance à la roue <small>7 derniers jours · moyenne par tour</small></div>${L.slice(0,8).map((x,i)=>`<div class="luckr${String(x.who)===me?" me":""}" data-act="prof" data-id="${esc(x.who)}">
    <span class="luckn">${med[i]||i+1}</span>${avatar(x.who,x.name,x.av,"av")}<b>${esc(x.name)}</b><small>${x.n} tour${x.n>1?"s":""}</small><em>${tok(x.avg)}</em></div>`).join("")}
    ${L.length>1?`<p class="luckf">${L.length>2&&L[L.length-1].avg<L[0].avg?`😅 ${esc(L[L.length-1].name)} n’a vraiment pas de chance en ce moment…`:""}</p>`:""}</div>`}
function viewFeed(){const F=U.lg.feed;if(!F){loadActFeed();return`<div class="skel" style="height:80px"></div><div class="skel" style="height:80px"></div>`}
  if(Date.now()-(U.lg.feedAt||0)>3e4)setTimeout(loadActFeed,0);
  if(!F.length)return`<div class="empty">${ic("group")}<b>Rien pour l’instant</b>Les paris, gains et duels des membres s’afficheront ici.</div>`;
  const top=F.find(a=>a.kind==="won"&&a.data&&a.data.big&&Date.now()-a.at<864e5),L=top?[top,...F.filter(a=>a!==top)]:F;
  return luckBox()+L.map(a=>`<div class="act${a===top?" star":""}">${a===top?`<div class="startag">⭐ À la une</div>`:""}<span data-act="prof" data-id="${esc(a.who)}">${avatar(a.who,a.name,a.av,"av")}</span><div>
    <p><b>${esc(a.name)}${String(a.who)===String(U.lg.data.me)?" (toi)":""}</b> ${actText(a)}</p><small>${ago(a.at)}</small>
    <div class="reacts">${EMOS.map(e=>{const n=(a.reacts||{})[e]||0;return`<button data-act="react" data-id="${esc(a.id)}" data-e="${e}" aria-pressed="${a.mine===e}">${e}${n?` <span>${n}</span>`:""}</button>`}).join("")}</div></div></div>`).join("")}
async function reactTo(id,e){const a=(U.lg.feed||[]).find(x=>String(x.id)===String(id));if(!a)return;const r=a.reacts=a.reacts||{};
  if(a.mine){r[a.mine]=Math.max(0,(r[a.mine]||1)-1)}if(a.mine===e)a.mine=null;else{a.mine=e;r[e]=(r[e]||0)+1}render();
  api("react",{act:id,emo:e}).catch(()=>{})}

/* ---------- avatars ---------- */
const avUrl=(id,v)=>API+"?avatar="+encodeURIComponent(id)+"&v="+v;
function avatar(id,name,v,cls,mine){const meNow=mine||(U.lg.data&&String(id)===String(U.lg.data.me));
  const src=meNow&&S.avatar?S.avatar:v?avUrl(id,v):"";
  return`<span class="${cls}" style="background:${avc(name||"?")}">${src?`<img src="${src}" alt="" decoding="async" onerror="this.remove()">`:""}<i>${esc((name||"?")[0].toUpperCase())}</i></span>`}
// résumé des paris envoyé au serveur (visible par les membres de mes guildes)
// gains des PARIS seuls (gain net : paiement − mise ; perdu = −mise), par semaine (lundi) et par mois, d'après la date de fin du pari
function betProfits(){const out={},lim=Date.now()-75*DAY;
  for(const b of S.bets){if(!["won","lost","cashed"].includes(b.st))continue;const t=b.done||b.at;if(!t||t<lim)continue;
    const g=b.st==="lost"?-b.stake:(b.pay||0)-b.stake,d=new Date(t),mon=new Date(d);mon.setHours(12,0,0,0);mon.setDate(mon.getDate()-((mon.getDay()+6)%7));
    const wk=mon.getFullYear()+"-"+String(mon.getMonth()+1).padStart(2,"0")+"-"+String(mon.getDate()).padStart(2,"0"),mo=d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0");
    out[wk]=(out[wk]||0)+g;out[mo]=(out[mo]||0)+g}
  for(const k in out)out[k]=Math.round(out[k]);return out}
// paris envoyés au serveur (fiche du joueur + notifications « ton match commence » / « pari gagné ») ; pour les paris en cours,
// chaque sélection donne son match (compétition ESPN, identifiant, heure) et le choix fait
function betsPayload(){const B=S.bets.slice(-40).reverse().map(b=>({id:b.id,at:b.at,done:b.done||0,st:b.st,stake:b.stake,odds:b.odds,pay:b.pay||0,
    legs:b.legs.slice(0,8).map(L=>{const o={l:String(L.l).slice(0,60),ml:String(L.ml||"").slice(0,60),mt:String(L.mt||"").slice(0,40),r:L.r||null};
      if(L.snap&&L.snap.path&&/^e-/.test(L.mid)){o.p=L.snap.path;o.e=L.mid.split("-").pop();o.t=L.t;o.sp=L.sp;if(b.st==="open"){o.mk=L.mk;o.k=L.k;o.line=L.line}}return o})}));
  const W=S.bets.filter(b=>b.st==="won");return{bets:B,best:{odds:W.reduce((a,b)=>Math.max(a,b.odds),0),pay:W.reduce((a,b)=>Math.max(a,b.pay||0),0)},badges:succOn(),profits:betProfits()}}

/* ---------- fiche d'un joueur ---------- */
async function openProfile(id){const me=U.lg.data&&String(id)===String(U.lg.data.me)||String(id)===String(S.pid);
  U.open="prof";layerLater(`<div class="grab"><h3>Profil</h3><button class="x" data-act="close" aria-label="Fermer">${ic("x")}</button></div><div class="skel" style="height:140px"></div><div class="skel"></div>`);
  if(me){const p={id:S.pid,name:S.name,bal:S.bal,peak:S.peak,xp:S.xp||0,...myStats(),...betsPayload(),av:S.avv,me:true,fav:S.fav,cos:S.cos};layer(viewProfile(p));
    if(S.pid)api("profile",{id:S.pid}).then(r=>{if(U.open==="prof"){p.hist=r.hist;p.pal=r.pal;layer(viewProfile(p))}}).catch(()=>{});return}
  try{const p=await api("profile",{id});if(U.open==="prof")layer(viewProfile(p))}
  catch(e){if(U.open==="prof")layer(`<div class="grab"><h3>Profil</h3><button class="x" data-act="close">${ic("x")}</button></div><div class="empty">${ic("info")}<b>${e.code==="not_friend"?"Profil privé":"Pas de connexion"}</b>${e.code==="not_friend"?"Tu ne vois que les joueurs de tes guildes.":"Réessaie dans un instant."}</div>`)}}
function viewProfile(p){U.prof=p;const done=p.won+p.lost,rate=done?Math.round(p.won/done*100):0,B=p.bets||[],open=B.filter(b=>b.st==="open"),past=B.filter(b=>b.st!=="open").slice(0,12);
  const row=(U.lg.data&&U.lg.data.rows||[]).find(r=>String(r.id)===String(p.id)),tr=row?row.tr:0,sc=row?row.sc:0;
  const bet=b=>{const tag=b.st==="won"?`<span class="tag won">+${tok(b.pay)}</span>`:b.st==="lost"?`<span class="tag lost">Perdu</span>`:b.st==="void"?`<span class="tag void">Remboursé</span>`:b.st==="cashed"?`<span class="tag cashed">Encaissé +${tok(b.pay)}</span>`:`<span class="tag open">En cours</span>`;
    return`<div class="pbet"><div class="pbh"><b>${b.legs.length>1?"Combiné · "+b.legs.length:"Simple"}</b>${tag}</div>
      ${b.legs.map(L=>{const mid=L.p&&L.e?"e-"+String(L.p).replace(/\W/g,"")+"-"+L.e:"",LL={...L,mid};
        return`<div class="pleg${mid?" legx":""}"${mid?` data-act="pleg" data-mid="${esc(mid)}" data-p="${esc(L.p)}" data-t="${+L.t||0}" data-sp="${esc(L.sp||"")}"`:""}>${mid&&!L.r?legStatus(LL):L.r==="w"?`<span class="st w">✓</span>`:L.r==="l"?`<span class="st l">✗</span>`:L.r==="v"?`<span class="st v">↺</span>`:`<span class="st p"></span>`}<div><b>${esc(L.l)}</b><small>${esc(L.ml)}</small>${mid&&!L.r&&L.mk?legWhen(LL):""}</div></div>`}).join("")}
      <small class="pbf">Mise ${tok(b.stake)} · cote ${fr(+b.odds||1)} · ${new Date(b.at).toLocaleDateString("fr-FR",{day:"numeric",month:"short"})}</small></div>`};
  return`<div class="grab"><h3>Profil</h3><button class="x" data-act="close" aria-label="Fermer">${ic("x")}</button></div>
  ${(()=>{const MC=mcInfo(p.me?S.bets:p.bets,p.xp);return`<div class="phero${MC.cls}${bnC(p.me?S.cos:p.cos)}">${MC.fx}${MC.note()}`})()}${avatar(p.id,p.name,p.av,"av big"+frC(p.me?S.cos:p.cos),p.me)}<div><h2>${nameH(p.name,p.me?S.cos:p.cos)}</h2>${ttlH(p.me?S.cos:p.cos)}<span class="div">${levelOf(p.xp||0).ic} ${esc(levelOf(p.xp||0).tier)} · niv. ${levelOf(p.xp||0).lvl}${sc?` · ${sc} mois gagné${sc>1?"s":""}`:""}${tr?` · ${tr} semaine${tr>1?"s":""} gagnée${tr>1?"s":""}`:""}</span>
    ${p.fav?`<span class="pfav">${p.fav.logo?`<img src="${esc(p.fav.logo)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">`:"❤️"} ${esc(p.fav.name)}</span>`:""}
    ${p.me?`<button class="link" data-act="photo">Changer ma photo</button>`:""}</div></div>
  <div class="pstats"><div><small>Jetons</small><b>${tok(p.bal)}</b></div><div><small>Record</small><b>${tok(p.peak)}</b></div><div><small>Réussite</small><b>${rate} %</b></div>
    <div><small>Gagnés</small><b class="pos">${p.won}</b></div><div><small>Meilleure cote</small><b>${p.best&&p.best.odds?fr(p.best.odds):"—"}</b></div><div><small>Plus gros gain</small><b class="pos">${p.best&&p.best.pay?"+"+tok(p.best.pay):"—"}</b></div></div>
  <button class="btn wide pcardbtn" data-act="pcard">🃏 Voir la carte de joueur</button>
  ${(()=>{const bw=(p.bets||[]).filter(b=>b.st==="won").sort((a,b)=>b.odds-a.odds)[0];return bw?`<div class="grp">🏆 Ticket record</div><div class="vitr"><div class="vth"><b>${bw.legs.length>1?"Combiné de "+bw.legs.length:"Pari simple"}</b><span>cote <b>${fr(+bw.odds)}</b> · <span class="pos">+${tok(bw.pay)}</span></span></div>${bw.legs.slice(0,5).map(L=>`<div class="vtl">✓ ${esc(L.l)} <small>${esc(L.ml||"")}</small></div>`).join("")}${bw.legs.length>5?`<div class="vtl"><small>+ ${bw.legs.length-5} autres</small></div>`:""}</div>`:""})()}
  ${curve(p.hist,p.bal)}
  ${palmares(p)}
  ${(p.badges||[]).length?`<div class="grp">Succès (${p.badges.length}/${SUCC.length})</div>${succGrid(p.badges)}`:""}
  <div class="grp">Paris en cours (${open.length})</div>${open.length?open.map(bet).join(""):`<p class="note">Aucun pari en cours.</p>`}
  <div class="grp">Derniers paris</div>${past.length?past.map(bet).join(""):`<p class="note">Pas encore de pari terminé.</p>`}
  ${p.me?"":`<div class="pmod"><button class="link" data-act="rep" data-k="player" data-id="${esc(p.id)}" data-w="le pseudo « ${esc(p.name)} »">🚩 Signaler le pseudo</button><button class="link" data-act="block" data-id="${esc(p.id)}" data-n="${esc(p.name)}">${blocked(p.id)?"Débloquer":"🚫 Bloquer"}</button></div>`}`}

/* ---------- événements : grandes compétitions, affichées seulement pendant qu'elles se jouent ---------- */
const EVENTS=[
  {id:"wc",n:"Coupe du monde",sp:"foot",lv:25,em:"🏆",c:"#d4a017"},
  {id:"euro",n:"Euro",sp:"foot",lv:26,em:"🇪🇺",c:"#2456c9"},
  {id:"nl",n:"Ligue des nations",sp:"foot",lv:24,em:"🌍",c:"#3a7bd5"},
  {id:"jof",n:"Jeux olympiques · football",sp:"foot",lv:27,em:"🥇",c:"#0081c8"},
  {id:"jofw",n:"Jeux olympiques · football féminin",sp:"foot",lv:28,em:"🥇",c:"#0081c8"},
  {id:"job",n:"Jeux olympiques · basket",sp:"basket",lv:7,em:"🥇",c:"#ee334e"},
  {id:"jobw",n:"Jeux olympiques · basket féminin",sp:"basket",lv:8,em:"🥇",c:"#ee334e"},
  {id:"rwc",n:"Coupe du monde de rugby",sp:"rugby",lv:15,em:"🏉",c:"#c8a24a"},
  {id:"nc",n:"Nations Championship",sp:"rugby",lv:16,em:"🏉",c:"#0b3d91"},
  {id:"trc",n:"Rugby Championship",sp:"rugby",lv:17,em:"🏉",c:"#2a6b3a"},
  {id:"6n",n:"Tournoi des Six Nations",sp:"rugby",lv:13,em:"🏉",c:"#1d6b3a"},
  {id:"tests",n:"Tests internationaux de rugby",sp:"rugby",lv:14,em:"🏉",c:"#a0522d"},
  {id:"rg",n:"Roland-Garros",sp:"tennis",lv:6,re:/roland|french open/i,em:"🎾",c:"#c4532a"},
  {id:"wim",n:"Wimbledon",sp:"tennis",lv:6,re:/wimbledon/i,em:"🎾",c:"#4b2c83"},
  {id:"uso",n:"US Open",sp:"tennis",lv:6,re:/us open/i,em:"🎾",c:"#1f5aa6"},
  {id:"ao",n:"Open d’Australie",sp:"tennis",lv:6,re:/australian open/i,em:"🎾",c:"#1a8fd6"},
  {id:"fin",n:"Masters de fin d’année",sp:"tennis",lv:6,re:/atp finals|wta finals/i,em:"🎾",c:"#3c3c8c"},
  {id:"davis",n:"Coupe Davis",sp:"tennis",lv:6,re:/davis cup|billie jean/i,em:"🎾",c:"#b22222"}];
const EV_ONLY={foot:[25,26,27,28],rugby:[15],basket:[7,8]};   // ces niveaux n'apparaissent que pendant leur événement
const evMatches=e=>matchesFor(e.sp,e.lv).filter(m=>!e.re||e.re.test(m.comp||""));
function evActive(e){const now=Date.now();return evMatches(e).some(m=>{const st=status(m);return st==="live"||(st==="pre"&&m.t<now+10*DAY)||(st==="post"&&m.t>now-36*H)})}
function loadEvents(){return Promise.allSettled(EVENTS.filter(e=>!FEED[e.sp+e.lv]).map(e=>loadFeed(e.sp,e.lv).then(()=>{if(U.tab==="m"&&!U.open)renderSoon()})))}
function eventStrip(){const A=EVENTS.filter(evActive);if(!A.length)return"";const now=Date.now();
  return`<div class="evs">${A.map(e=>{const M=evMatches(e),live=M.filter(m=>status(m)==="live").length,next=M.filter(m=>status(m)==="pre").sort((a,b)=>a.t-b.t)[0],
    today=M.filter(m=>status(m)==="pre"&&new Date(m.t).toDateString()===new Date().toDateString()).length;
    return`<button class="evc" data-act="ev" data-id="${e.id}" style="--ec:${e.c}"><span class="em">${e.em}</span><span class="t"><small>${live?`<b class="lv">● En direct</b>`:"En ce moment"}</small><b>${esc(e.n)}</b>
      <small>${live?`${live} match${live>1?"s":""} en cours`:today?`${today} match${today>1?"s":""} aujourd’hui`:next?`Prochain : ${esc(fDay(next.t))} ${new Date(next.t).toLocaleTimeString("fr-FR",{hour:"2-digit",minute:"2-digit"})}`:"Derniers résultats"}</small></span><span class="arr">›</span></button>`}).join("")}</div>`}
function viewEvent(e){const M=evMatches(e),live=M.filter(m=>status(m)==="live"),up=M.filter(m=>status(m)==="pre").sort((a,b)=>a.t-b.t),done=M.filter(m=>status(m)==="post").sort((a,b)=>b.t-a.t);
  let h=`<div class="evh" style="--ec:${e.c}"><button class="link" data-act="evx">‹ Tous les matchs</button><div class="em">${e.em}</div><h2>${esc(e.n)}</h2>
    <small>${up.length} match${up.length>1?"s":""} à venir · ${done.length} joué${done.length>1?"s":""}</small></div>`;
  if(live.length)h+=`<div class="day">En direct</div><div class="mc-grid">${live.map(m=>card(m,false)).join("")}</div>`;
  let last="";for(const m of up.slice(0,40)){const d=fDay(m.t);if(d!==last){if(last)h+="</div>";h+=`<div class="day">${d}</div><div class="mc-grid">`;last=d}h+=card(m,false)}if(last)h+="</div>";
  if(!up.length&&!live.length)h+=`<div class="empty">${ic("trophy")}<b>C’est fini !</b>Plus aucun match à venir pour cet événement.</div>`;
  if(done.length)h+=`<div class="h2"><h2>Résultats</h2><span>${done.length}</span></div>`+done.slice(0,20).map(resRow).join("");
  return h}

/* ---------- guildes : emblème, membres et rôles, réglages, annuaire ---------- */
const EMBLEMS=["🦁","🐺","🦅","🐉","🦈","🐻","🦊","🐯","🔥","⚡","👑","🏆","⚽","🏉","🎾","🏀","💎","🚀","🎯","🛡️","⚔️","🌟","🍀","🐐"];
const GCOLORS=["#35d07f","#ffd23f","#ff7a45","#5fa8ff","#c084fc","#ff5a5f","#2ec4b6","#f8fafc","#ff9f1c","#8ac926"];
const ACCESS={open:["Ouverte","Tout le monde peut la rejoindre depuis l’annuaire."],request:["Sur demande","Visible dans l’annuaire ; le chef ou un adjoint accepte chaque demande."],private:["Privée","Invisible dans l’annuaire : on la rejoint seulement avec son code."]};
// logo image d'une guilde (envoyé par le chef, ou posé par les organisateurs) ; gardé en mémoire pour ne pas clignoter
const LOGO_KEEP={};
// images utilisées par les styles (cadre fourrure, Teckel géant) : chargées une fois en arrière-plan puis gardées en mémoire
setTimeout(()=>{for(const u of["fur-teckel.webp?v=3","teckel-cadre.webp?v=2"]){if(!LOGO_KEEP[u]){const im=new Image();im.src=u;LOGO_KEEP[u]=im}}},2500);
function gLogoUrl(e){if(!e)return"";if(typeof e.lg==="string"&&/^\d{1,15}\.\d{1,6}$/.test(e.lg)){const[g,v]=e.lg.split(".");return`/api/game?glogo=${g}&v=${v}`}
  if(typeof e.img==="string"&&/^g\/[a-z0-9-]{1,40}\.(webp|png)$/.test(e.img))return"/"+e.img.replace(/\.webp$/,".png")+"?v=2";return""}
const emb=(l,sz)=>{const e=(l&&l.emblem)||{},u=gLogoUrl(e);if(u){if(!LOGO_KEEP[u]){const im=new Image();im.src=u;LOGO_KEEP[u]=im}
  return`<span class="gemb img ${sz||""}" role="img" aria-label="Logo" style="--gc:${esc(e.c||"#35d07f")};background-image:url(${u})"></span>`}
  return`<span class="gemb ${sz||""}" style="--gc:${esc(e.c||"#35d07f")}">${esc(e.i||"🛡️")}</span>`};
const seenTxt=t=>{const h=(Date.now()-t)/H;return h<1?"en ligne récemment":h<24?`vu il y a ${Math.round(h)} h`:`vu il y a ${Math.round(h/24)} j`};
async function openMembers(){U.open="gmem";const head=`<div class="grab"><h3>Membres</h3><button class="x" data-act="close" aria-label="Fermer">${ic("x")}</button></div>`;
  layerLater(head+`<div class="skel"></div><div class="skel"></div>`);
  try{const j=await api("guild_members",{code:U.lg.code});if(U.open==="gmem")layer(head+viewMembers(j))}catch(e){if(U.open==="gmem")layer(head+`<div class="empty">${ic("info")}<b>Pas de connexion</b>Réessaie dans un instant.</div>`)}}
function viewMembers(j){const boss=j.role!=="membre",RL={chef:"👑 Chef",adjoint:"⭐ Adjoint",membre:"Membre"};
  let h=j.requests.length?`<div class="grp">Demandes (${j.requests.length})</div>`+j.requests.map(r=>`<div class="gmrow">${avatar(r.id,r.name,r.av,"av"+frC(r.cos))}<div><b>${esc(r.name)}</b><small>demande à rejoindre</small></div>
    <button class="btn" data-act="gans" data-id="${esc(r.id)}" data-v="1">Accepter</button><button class="x" data-act="gans" data-id="${esc(r.id)}" data-v="0" aria-label="Refuser">${ic("x")}</button></div>`).join(""):"";
  h+=`<div class="grp">${j.members.length} membre${j.members.length>1?"s":""}</div>`+j.members.map(m=>{const me=String(m.id)===String(j.me);
    const acts=me||!boss||m.role==="chef"||(j.role==="adjoint"&&m.role!=="membre")?"":`<div class="gmact">${j.role==="chef"?(m.role==="adjoint"?`<button class="link" data-act="grole" data-id="${esc(m.id)}" data-r="membre">Retirer adjoint</button>`:`<button class="link" data-act="grole" data-id="${esc(m.id)}" data-r="adjoint">Nommer adjoint</button>`)+`<button class="link" data-act="grole" data-id="${esc(m.id)}" data-r="chef">Faire chef</button>`:""}<button class="link" data-act="gkick" data-id="${esc(m.id)}" style="color:var(--loss)">Exclure</button></div>`;
    return`<div class="gmrow"><span data-act="prof" data-id="${esc(m.id)}">${avatar(m.id,m.name,m.av,"av")}</span><div><b>${esc(m.name)}${me?" (toi)":""}</b><small>${RL[m.role]} · ${seenTxt(m.seen)}</small>${acts}</div></div>`}).join("");
  return h}
function openGMenu(){const d=U.lg.data,cur=d&&d.leagues.find(l=>l.code===U.lg.code);if(!cur)return;const boss=cur.mine||cur.role==="officer";U.open="gmenu";
  layer(`<div class="grab"><h3>${esc(cur.name)}</h3><button class="x" data-act="close" aria-label="Fermer">${ic("x")}</button></div>
  <div class="lgcode" style="margin-bottom:10px"><div><small>Code de la guilde</small><br><b>${esc(cur.code)}</b></div><button class="btn gold" data-act="lginv">${ic("share")} Inviter</button></div>
  <div class="mlist"><button data-act="gmem">👥 Membres${boss&&cur.nreq?` · <b style="color:var(--sel)">${cur.nreq} demande${cur.nreq>1?"s":""}</b>`:""}</button>${boss?`<button data-act="gset">⚙️ Gérer la guilde (logo, emblème, devise, accès, championnat)</button>`:""}
  <button data-act="gstats">📈 Statistiques de la guilde</button><button data-act="gdir">🔎 Trouver une autre guilde</button><button data-act="lgnew">➕ Créer une guilde</button><button data-act="lgjoin">🔑 Rejoindre avec un code</button>
  <button data-act="lgleave" style="color:var(--loss)">🚪 Quitter la guilde</button></div>`)}
async function guildAct(action,args,ask){if(ask&&!confirm(ask))return;try{const j=await api(action,{code:U.lg.code,...args});if(j&&j.error)throw j;toast("C’est fait.","win");await loadBoards();openMembers()}
  catch(e){toast(e&&e.error==="full"?"La guilde est pleine.":e&&e.error==="too_many"?"Ce joueur est déjà dans trop de guildes.":"Action impossible.","bad")}}
function openGuildSet(){const cur=U.lg.data.leagues.find(l=>l.code===U.lg.code);if(!cur)return;const e=cur.emblem||{};U.gf={i:e.i||"🛡️",c:e.c||"#35d07f",lg:e.lg,img:e.img,a:cur.access||"private",m:cur.motto||"",n:cur.name,chef:!!cur.mine,ch:cur.champ===false?"0":"1"};U.open="gset";layer(viewGuildSet())}
function keepGuildForm(){const m=$("#g-motto"),n=$("#g-name");if(m)U.gf.m=m.value;if(n)U.gf.n=n.value}
function viewGuildSet(){const f=U.gf;
  return`<div class="grab"><h3>Gérer la guilde</h3><button class="x" data-act="close" aria-label="Fermer">${ic("x")}</button></div>
  <div class="gprev">${emb({emblem:{i:f.i,c:f.c,lg:f.lg,img:f.img}},"xl")}</div>
  <div class="grp">Logo (image)</div><div class="glogo"><button class="btn" data-act="glogo">📷 ${f.lg||f.img?"Changer le logo":"Mettre un logo"}</button>${f.lg||f.img?`<button class="btn ghost" data-act="glogodel">Retirer le logo</button>`:""}</div>
  <p class="note" style="text-align:left;margin:6px 0 0">${f.lg||f.img?"Le logo remplace l’emblème partout. Retire-le pour revenir à l’emblème.":"Une image (idéalement PNG au fond transparent) qui remplace l’emblème partout : onglets, combats, annuaire."}</p>
  <div class="grp">Emblème${f.lg||f.img?" (si pas de logo)":""}</div><div class="gpick">${EMBLEMS.map(x=>`<button data-act="gpick" data-f="i" data-v="${x}" aria-pressed="${f.i===x}">${x}</button>`).join("")}</div>
  <div class="grp">Couleur</div><div class="gpick col">${GCOLORS.map(x=>`<button data-act="gpick" data-f="c" data-v="${x}" aria-pressed="${f.c===x}" style="background:${x}" aria-label="Couleur"></button>`).join("")}</div>
  <div class="form">${f.chef?`<label>Nom<input id="g-name" maxlength="24" value="${esc(f.n)}"></label>`:""}<label>Devise (facultatif)<input id="g-motto" maxlength="60" value="${esc(f.m)}" placeholder="ex. On ne lâche rien"></label></div>
  <div class="grp">Qui peut rejoindre ?</div>${Object.entries(ACCESS).map(([k,[t,d]])=>`<button class="gacc" data-act="gpick" data-f="a" data-v="${k}" aria-pressed="${f.a===k}"><b>${t}</b><small>${d}</small></button>`).join("")}
  ${f.chef?`<div class="grp">Championnat des guildes</div><button class="gacc" data-act="gpick" data-f="ch" data-v="1" aria-pressed="${f.ch==="1"}"><b>On participe</b><small>Chaque lundi, un adversaire de votre niveau (il faut au moins 3 membres).</small></button><button class="gacc" data-act="gpick" data-f="ch" data-v="0" aria-pressed="${f.ch==="0"}"><b>Pause</b><small>Pas de championnat ; les défis restent possibles.</small></button>`:""}
  <button class="btn gold wide" data-act="gsave" style="margin-top:12px">Enregistrer</button>`}
function pickGuildLogo(){keepGuildForm();const inp=document.createElement("input");inp.type="file";inp.accept="image/*";
  inp.onchange=async()=>{const f=inp.files&&inp.files[0];if(!f)return;try{const url=URL.createObjectURL(f),im=await new Promise((ok,ko)=>{const i=new Image();i.onload=()=>ok(i);i.onerror=ko;i.src=url});
    const k=Math.min(1,440/im.width,190/im.height),w=Math.max(1,Math.round(im.width*k)),h=Math.max(1,Math.round(im.height*k)),cv=document.createElement("canvas");cv.width=w;cv.height=h;const c=cv.getContext("2d");c.drawImage(im,0,0,w,h);URL.revokeObjectURL(url);
    let d=cv.toDataURL("image/png");if(d.length>200000){const c2=document.createElement("canvas");c2.width=w;c2.height=h;const x=c2.getContext("2d");x.fillStyle="#fff";x.fillRect(0,0,w,h);x.drawImage(cv,0,0);d=c2.toDataURL("image/jpeg",.86)}
    await setGuildLogo(d)}catch(e){toast("Image illisible, essaie une autre.","bad")}};inp.click()}
async function setGuildLogo(img){keepGuildForm();try{toast(img?"Envoi du logo…":"Logo retiré…");const j=await api("guild_logo",{code:U.lg.code,img});if(!j||j.error)throw j;
  const e=j.emblem||{};U.gf.lg=e.lg;U.gf.img=e.img;const cur=U.lg.data&&U.lg.data.leagues.find(l=>l.code===U.lg.code);if(cur)cur.emblem={...(cur.emblem||{}),lg:e.lg,img:e.img};
  if(U.open==="gset")layer(viewGuildSet());$("#main")._html=null;render();toast(img?"Logo enregistré !":"Logo retiré.","win")}
  catch(e){toast(e&&e.error==="image"?"Image trop lourde : essaie une image plus petite.":"Impossible d’envoyer le logo.","bad")}}
async function saveGuild(){keepGuildForm();const f=U.gf;try{const j=await api("guild_update",{code:U.lg.code,emblem:{i:f.i,c:f.c},access:f.a,motto:f.m,name:f.n,...(f.chef?{champ:f.ch==="1"}:{})});if(j.error)throw j;closeLayer();toast("Guilde mise à jour.","win");loadBoards()}catch(e){toast(e.code==="name_bad"?"Nom ou devise refusés : choisis des mots corrects.":"Impossible d’enregistrer.","bad")}}
async function openDir(q){U.open="gdir";const head=`<div class="grab"><h3>Trouver une guilde</h3><button class="x" data-act="close" aria-label="Fermer">${ic("x")}</button></div>
  <div class="form"><input id="g-q" placeholder="Rechercher une guilde…" value="${esc(q||"")}" autocomplete="off"></div>`;
  layerLater(head+`<div class="skel"></div><div class="skel"></div>`);
  try{const j=await api("guild_dir",{q:q||""});if(U.open!=="gdir")return;
    layer(head+(j.guilds.length?j.guilds.map(g=>`<div class="gdrow">${emb(g,"lg")}<div><b>${esc(g.name)}</b>${g.motto?`<em class="gmotto">« ${esc(g.motto)} »</em>`:""}<small>${g.div?g.div.i+" ":""}${g.n} membre${g.n>1?"s":""} · ${g.active} actif${g.active>1?"s":""} cette semaine · ${ACCESS[g.access][0]}</small></div>
      ${g.mine?`<span class="tag won">Membre</span>`:g.asked?`<span class="tag void">Demande envoyée</span>`:`<button class="btn ${g.access==="open"?"gold":""}" data-act="gdirjoin" data-id="${esc(g.gid)}">${g.access==="open"?"Rejoindre":"Demander"}</button>`}</div>`).join("")
      :`<div class="empty">${ic("group")}<b>Aucune guilde trouvée</b>Crée la tienne et rends-la ouverte dans « Gérer » pour qu’on la trouve ici.</div>`));
    const inp=$("#g-q");if(inp){inp.onchange=()=>openDir(inp.value.trim());if(q)inp.focus()}}
  catch(e){if(U.open==="gdir")layer(head+`<div class="empty">${ic("info")}<b>Pas de connexion</b>Réessaie dans un instant.</div>`)}}
async function dirJoin(gid){try{const j=await api("guild_join",{gid});
  if(j.joined){closeLayer();U.lg.code=j.code;U.lg.view="rank";toast(`Bienvenue dans « ${esc(j.name)} » !`,"win");await loadBoards()}
  else{toast("Demande envoyée : le chef ou un adjoint va répondre.","win");openDir($("#g-q")&&$("#g-q").value.trim())}}
  catch(e){toast(e.code==="full"?"Cette guilde est pleine.":e.code==="too_many"?"Tu es déjà dans trop de guildes.":"Impossible de rejoindre cette guilde.","bad")}}

/* ---------- équipe de cœur ---------- */
const FAVL=[["Ligue 1","soccer/fra.1","foot"],["Ligue 2","soccer/fra.2","foot"],["Top 14","rugby/270559","rugby"],["Premier League","soccer/eng.1","foot"],["Liga","soccer/esp.1","foot"],["Serie A","soccer/ita.1","foot"],["Bundesliga","soccer/ger.1","foot"],["Portugal","soccer/por.1","foot"],["NBA","basketball/nba","basket"]];
const FAVT={};
function openFav(){U.open="fav";U.favL=U.favL||0;favCache();layer(viewFav());FAVL.forEach((_,i)=>loadFavTeams(i))}
function favCache(){if(FAVT._c)return;FAVT._c=1;try{const c=JSON.parse(localStorage.getItem("dap.favt")||"null");if(c&&Date.now()-c.at<7*864e5)for(const k in c.t)FAVT[k]=c.t[k]}catch(e){}}
function favSave(){try{const t={};for(const[,p]of FAVL)if(Array.isArray(FAVT[p]))t[p]=FAVT[p];localStorage.setItem("dap.favt",JSON.stringify({at:Date.now(),t}))}catch(e){}}
async function loadFavTeams(i){const path=FAVL[i??U.favL][1];if(Array.isArray(FAVT[path])||FAVT[path]==="load")return;FAVT[path]="load";
  try{const j=await getJSON(`${API}?teams=${encodeURIComponent(path)}`);FAVT[path]=j.teams.map(t=>({id:t.id,name:frTeam(t.short||t.name),logo:fixLogo(frTeam(t.short||t.name),t.logo)})).sort((a,b)=>a.name.localeCompare(b.name,"fr"));favSave()}
  catch(e){FAVT[path]="err"}if(U.open==="fav"&&FAVL[U.favL][1]===path)layer(viewFav())}
function viewFav(){const [ln,path,sp]=FAVL[U.favL],T=FAVT[path];
  return`<div class="grab"><h3>Équipe de cœur</h3><button class="x" data-act="close" aria-label="Fermer">${ic("x")}</button></div>
  <p class="note" style="margin-top:0">Ses matchs s’affichent en premier, tu reçois un rappel les jours où elle joue, et son logo apparaît à côté de ton nom.</p>
  <div class="chips favl">${FAVL.map(([n],i)=>`<button data-act="favl" data-i="${i}" aria-pressed="${U.favL===i}">${n}</button>`).join("")}</div>
  ${!T||T==="load"?`<div class="skel" style="height:200px"></div>`:T==="err"?`<div class="empty">${ic("info")}<b>Pas de connexion</b>Réessaie dans un instant.</div>`
    :`<div class="favg">${T.map((t,i)=>`<button data-act="favset" data-i="${i}" class="${S.fav&&S.fav.id===t.id?"on":""}">${crest(t.name,sp,t.logo)}<span>${esc(t.name)}</span></button>`).join("")}</div>`}
  ${S.fav?`<p class="note" style="text-align:center"><button class="link" data-act="favnone" style="color:var(--loss)">Retirer mon équipe de cœur</button></p>`:""}`}
async function favSet(i){const [,path,sp]=FAVL[U.favL],t=(FAVT[path]||[])[i];if(!t)return;
  S.fav={sp,id:t.id,path,name:t.name,logo:t.logo};save();closeLayer();toast(`❤️ ${esc(t.name)} est ton équipe de cœur !`,"win");
  favPush();}
async function favPush(){try{if(!(await ensureSession()))return;await api("set_fav",{fav:S.fav});S.favOk=S.fav&&S.fav.id;saveLocal();loadGuide(true)}catch(e){}}
function favMatch(){if(!S.fav)return null;const id=String(S.fav.id);
  return[...REG.values()].filter(m=>(String(m.hid)===id||String(m.aid)===id)&&["pre","live"].includes(status(m))).sort((a,b)=>a.t-b.t)[0]||null}
const favCrest=(f,sz=16)=>f&&f.l?`<img class="fcr" src="${esc(f.l)}" alt="" width="${sz}" height="${sz}" referrerpolicy="no-referrer" onerror="this.remove()">`:"";

/* ---------- récompenses du mois ---------- */
// mêmes montants pour toutes les guildes (même liste dans api/game.js : PRIZES)
const PRZ=[1000,500,250,25];
const prizesOf=()=>PRZ;
// au démarrage : récompenses de fin de mois pas encore reçues → créditées
async function claimPrizes(){if(!S.tok)return;try{const j=await api("prizes_claim",{});if(!j.prizes.length)return;let t=0;
  for(const x of j.prizes){t+=x.amount;S.prizes=S.prizes||[];S.prizes.push(x)}
  S.bal+=t;S.peak=Math.max(S.peak,S.bal);save();render();bump();confetti();
  const x=j.prizes[0];toast(j.prizes.length===1?`🎁 ${x.rank}${x.rank===1?"er":"e"} de « ${esc(x.league)} » en ${esc(x.label)} : +${tok(x.amount)} jetons !`:`🎁 Récompenses de fin de mois : +${tok(t)} jetons !`,"win")}catch(e){}}

/* ---------- match de la guilde : un match par jour, chacun vote 1 / N / 2 ---------- */
const LM={};
async function loadLm(code){if(!code||!S.tok)return;try{const j=await api("lm_get",{code});LM[code]=j;lmReward(j);if(!U.open&&(U.tab==="l"||U.tab==="m"))render()}catch(e){}}
function lmReward(j){S.lmw=S.lmw||{};let won=0;
  for(const e of [j.cur,...j.hist])if(e&&e.res!=null&&!S.lmw[e.day]){S.lmw[e.day]=e.my===e.res?2:1;if(e.my===e.res)won+=j.prize}
  if(won){S.bal+=won;S.peak=Math.max(S.peak,S.bal);toast(`${ic("target")} Match de la guilde : bien vu ! +${tok(won)} jetons`,"win");bump()}save()}
async function lmPick(day,k){const j=LM[U.lg.code];if(!j||!j.cur||j.cur.day!==day)return;const c=j.cur;if(c.match.t<=Date.now()){toast("Trop tard, le match a commencé.","bad");return}
  const me=String(j.me),old=c.picks.find(x=>String(x.id)===me);if(old)old.pick=k;else c.picks.push({id:j.me,name:S.name,av:S.avv||0,pick:k});c.my=k;render();
  try{await api("lm_pick",{day,pick:k});toast("Vote enregistré !","win");for(const code in LM)if(code!==U.lg.code)loadLm(code)}catch(e){toast(e.code==="started"?"Trop tard, le match a commencé.":"Pas de connexion, réessaie.","bad");loadLm(U.lg.code)}}
function lmWhen(t){const d=new Date(t),today=new Date();const same=d.toDateString()===today.toDateString(),tm=new Date(today.getTime()+864e5).toDateString()===d.toDateString();
  return(same?"Ce soir":tm?"Demain":d.toLocaleDateString("fr-FR",{weekday:"long"}))+" à "+d.toLocaleTimeString("fr-FR",{hour:"2-digit",minute:"2-digit"}).replace(":","h")}
function viewLm(code){const j=LM[code];if(!j)return"";const c=j.cur;let h="";
  if(c){const m=c.match,P=c.picks,n=P.length,locked=m.t<=Date.now(),opts=[m.h,"Match nul",m.a];
    const st=c.res!=null?`Terminé · ${m.sh} – ${m.sa}`:m.live?`En cours${m.sh!=null?` · ${m.sh} – ${m.sa}`:""}`:lmWhen(m.t);
    h+=`<div class="lmc"><div class="lmh">${ic("target")}<b>Match de la guilde</b><span>${esc(st)}</span></div>
      <div class="lmt">${crest(m.h,"foot",m.hl)}<b>${esc(m.h)}</b><i>–</i><b>${esc(m.a)}</b>${crest(m.a,"foot",m.al)}</div>
      <div class="lmo">${opts.map((o,k)=>{const V=P.filter(x=>x.pick===k),pc=n?Math.round(V.length/n*100):0,mine=c.my===k,win=c.res===k;
        return`<button class="${mine?"mine ":""}${win?"win":""}" ${locked?"disabled":`data-act="lmpick" data-day="${esc(c.day)}" data-k="${k}"`}><i style="width:${pc}%"></i>
          <span class="l">${esc(k===1?"Nul":o)}${win?" ✓":""}</span><span class="v">${V.length}</span>
          <span class="avs">${V.slice(0,6).map(x=>avatar(x.id,x.name,x.av,"av")).join("")}</span></button>`}).join("")}</div>
      <small class="lmf">${c.res!=null?(c.my==null?"Tu n’avais pas voté.":c.my===c.res?`Bien vu : +${j.prize} jetons !`:"Raté cette fois."):locked?`${n} vote${n>1?"s":""} · votes fermés`:c.my==null?`Bonne réponse = <b>+${j.prize} jetons</b> · tout le monde voit les votes`:`Tu peux changer d’avis jusqu’au coup d’envoi · bonne réponse = +${j.prize} jetons`}</small>
      ${j.month.length?`<div class="lmm">Ce mois : ${j.month.slice(0,4).map(x=>`<b>${esc(x.name)}</b> ${x.ok}/${x.n}`).join(" · ")}</div>`:""}
      ${j.hist.length?`<div class="lmhist">${j.hist.slice(0,4).map(e=>`<span class="${e.my==null||e.res==null?"":e.my===e.res?"ok":"ko"}">${esc(e.match.h)} ${e.match.sh??"–"}-${e.match.sa??"–"} ${esc(e.match.a)}</span>`).join("")}</div>`:""}</div>`}
  return h}
// prono du week-end avec des matchs pas encore pronostiqués (pastille rouge sur l'onglet Pronos)
function pronoTodo(){try{const j=U.pr&&U.pr.data;return!!(j&&j.matches&&j.matches.some(m=>m.t>Date.now()&&!m.my))}catch(e){return false}}
function lmBanner(){const L0=U.lg.data&&U.lg.data.leagues[0];if(!L0)return"";const j=LM[U.lg.code||L0.code];if(!j||!j.cur||j.cur.my!=null||j.cur.match.t<=Date.now())return"";const m=j.cur.match;
  return`<button class="prban lmban" data-act="lmgo">${ic("target")}<span><b>Match de la guilde</b><small>${esc(m.h)} – ${esc(m.a)} · ${esc(lmWhen(m.t))} · ${j.cur.picks.length} vote${j.cur.picks.length>1?"s":""}</small></span><span class="arr">›</span></button>`}

/* ---------- bilan de la semaine ---------- */
async function openRecap(code){if(!code)return;U.open="recap";const head=`<div class="grab"><h3>Le bilan de la semaine</h3><button class="x" data-act="close" aria-label="Fermer">${ic("x")}</button></div>`;
  layerLater(head+`<div class="skel" style="height:160px"></div><div class="skel"></div><div class="skel"></div>`);
  try{const r=await api("recap",{code});if(U.open!=="recap")return;layer(head+viewRecap(r));
    S.recapSeen=S.recapSeen||{};if(U.lg.data){S.recapSeen[code]=U.lg.data.week;saveLocal()}}
  catch(e){if(U.open==="recap")layer(head+`<div class="empty">${ic("info")}<b>Pas de connexion</b>Réessaie dans un instant.</div>`)}}
function viewRecap(r){const d0=new Date(r.from+3600e3),d1=new Date(r.to-3600e3),f=x=>x.toLocaleDateString("fr-FR",{day:"numeric",month:"long",timeZone:"Europe/Paris"}).replace(/^1 /,"1er ");
  const who=x=>`<span class="rcw" data-act="prof" data-id="${esc(x.id)}">${avatar(x.id,x.name,x.av,"av")}<b>${esc(x.name)}</b></span>`;
  const legs=L=>L&&L.length?`<small class="rcl">${L.map(esc).join(" · ")}</small>`:"";
  let h=`<div class="rchero"><small>${esc(r.name)}</small><b>Semaine du ${f(d0)} au ${f(d1)}</b><span>${r.bets} pari${r.bets>1?"s":""} · ${tok(r.staked)} jetons misés</span></div>`;
  if(r.empty)return h+`<div class="empty">${ic("chart")}<b>Semaine calme</b>Personne n’a gagné ou perdu de jetons dans la guilde la semaine dernière. Rendez-vous lundi prochain !</div>`;
  if(r.podium.length){const P=r.podium,H=[54,78,40],O=P.length>=3?[1,0,2]:P.length===2?[1,0]:[0];
    h+=`<div class="rcpod">${O.map(i=>`<div data-act="prof" data-id="${esc(P[i].id)}">${avatar(P[i].id,P[i].name,P[i].av,"av")}<b>${esc(P[i].name)}</b><span class="pos">+${tok(P[i].gain)}</span><div class="blk" style="height:${H[i]}px;background:${["#ffd23f","#c9d3dc","#e0975a"][i]}">${i+1}</div></div>`).join("")}</div>`}
  const card=(cls,icon,title,body)=>`<div class="rcc ${cls}"><div class="rch">${ic(icon)}<small>${title}</small></div>${body}</div>`;
  let c="";
  if(r.odds)c+=card("gold","bolt","Plus grosse cote",`${who(r.odds)}<div class="rcv">cote <b>${fr(r.odds.odds)}</b> · <span class="pos">+${tok(r.odds.pay)}</span></div>${legs(r.odds.legs)}`);
  if(r.flop)c+=card("red","broken","Plus gros flop",`${who(r.flop)}<div class="rcv"><b class="neg">−${tok(r.flop.stake)}</b> envolés${r.flop.odds?` · cote ${fr(r.flop.odds)}`:""}</div>${legs(r.flop.legs)}`);
  if(r.prono)c+=card("blue","target","Roi du prono",`${r.prono.who.map(who).join("")}<div class="rcv"><b>${r.prono.pts} pt${r.prono.pts>1?"s":""}</b>${r.prono.done?"":" · provisoire"}</div>`);
  if(r.duel)c+=card("","target","Roi des duels",`${who(r.duel)}<div class="rcv"><b>${r.duel.n}</b> duel${r.duel.n>1?"s":""} gagné${r.duel.n>1?"s":""}</div>`);
  if(r.busy)c+=card("","ticket","Le plus accro",`${who(r.busy)}<div class="rcv"><b>${r.busy.n}</b> pari${r.busy.n>1?"s":""} dans la semaine</div>`);
  if(r.red)c+=card("red","chart","Lanterne rouge",`${who(r.red)}<div class="rcv"><b class="neg">${tok(r.red.gain)}</b> sur la semaine</div>`);
  return h+`<div class="rcgrid">${c}</div><p class="note">Le bilan sort chaque lundi matin. Les gains comptent du lundi au dimanche ; plus grosse cote et plus gros flop parmi les paris terminés dans la semaine.</p>`}

/* ---------- code de compte permanent + sauvegarde automatique ---------- */
function rcodeCard(){if(!S.name)return"";
  if(S.rcode)return`<div class="rcard"><div class="rch">🔑 <b>Mon code de compte</b></div><div class="rcodev">${esc(S.rcode)}</div>
    <small>Il ne change jamais. <b>Fais une capture d’écran</b> : avec ce code, tu retrouves ton compte (jetons, paris, guildes) sur n’importe quel téléphone, même si tu perds le tien. Ne le donne à personne.</small>
    <button class="btn ghost" data-act="copycode" data-code="${esc(S.rcode)}">Copier</button></div>`;
  if(S.rcodeOther)return`<div class="rcard"><div class="rch">🔑 <b>Mon code de compte</b></div><small>Ton code a été créé ailleurs (autre téléphone ou administrateur). Entre-le pour l’afficher ici, ou crée-en un nouveau (l’ancien ne marchera plus).</small><button class="btn" data-act="rctype">J’ai mon code</button><button class="btn ghost" data-act="rcrenew">Créer un nouveau code</button></div>`;
  return`<div class="rcard"><div class="rch">🔑 <b>Mon code de compte</b></div><div class="skel" style="height:40px"></div></div>`}
// au démarrage : on crée le code s'il n'existe pas, et on vérifie que celui du téléphone est toujours le bon
async function ensureRcode(){if(!S.name)return;try{if(!(await ensureSession()))return;const j=await api("recovery_make",S.rcode?{have:S.rcode}:{});
  if(j.code){S.rcode=j.code;delete S.rcodeOther}else if(j.exists){delete S.rcode;S.rcodeOther=1}saveLocal();if(U.tab==="c"&&!U.open)render()}catch(e){}}
async function typeRcode(){const v=(prompt("Entre ton code de compte (12 caractères) :")||"").toUpperCase().replace(/[^A-Z0-9]/g,"");if(v.length!==12)return;
  try{const j=await api("recovery_make",{have:v});if(j.ok){S.rcode=v.replace(/^(.{4})(.{4})(.{4})$/,"$1-$2-$3");delete S.rcodeOther;saveLocal();render();toast("Code enregistré sur ce téléphone.","win")}else toast("Ce n’est pas le bon code.","bad")}catch(e){toast("Pas de connexion, réessaie.","bad")}}
async function renewRcode(){if(!confirm("Créer un nouveau code de compte ? L’ancien ne marchera plus."))return;
  try{const j=await api("recovery_make",{renew:true});S.rcode=j.code;delete S.rcodeOther;saveLocal();render();toast("Nouveau code créé : fais une capture d’écran !","win")}catch(e){toast("Impossible pour l’instant.","bad")}}
// sauvegarde complète du téléphone sur le serveur (au plus toutes les 10 min), pour récupérer son compte avec le code
async function backupSoon(){if(!S.tok||Date.now()-(S.bkAt||0)<10*6e4)return;S.bkAt=Date.now();saveLocal();
  const st={...S};delete st.tok;delete st.pid;delete st.bkAt;try{await api("backup",{state:st})}catch(e){S.bkAt=0}}

/* ---------- statistiques perso (tout l'historique du téléphone) ---------- */
const netOf=b=>b.st==="lost"?-b.stake:b.st==="won"||b.st==="cashed"?(b.pay||0)-b.stake:0;
function viewStats(){const head=`<div class="grab"><h3>Mes statistiques</h3><button class="x" data-act="close" aria-label="Fermer">${ic("x")}</button></div>`;
  const D=S.bets.filter(b=>["won","lost","cashed"].includes(b.st));
  if(!D.length)return head+`<div class="empty">${ic("chart")}<b>Pas encore de chiffres</b>Tes statistiques apparaîtront dès ton premier pari terminé.</div>`;
  const W=D.filter(b=>b.st!=="lost"),staked=D.reduce((a,b)=>a+b.stake,0),net=D.reduce((a,b)=>a+netOf(b),0),pct=(a,n)=>n?Math.round(a/n*100):0;
  const sorted=D.slice().sort((a,b)=>(a.done||a.at)-(b.done||b.at));let run=0,best=0;for(const b of sorted){run=b.st!=="lost"?run+1:0;best=Math.max(best,run)}
  const big=D.reduce((a,b)=>Math.max(a,netOf(b)),0),worst=D.reduce((a,b)=>Math.min(a,netOf(b)),0),bestO=W.filter(b=>b.st==="won").reduce((a,b)=>Math.max(a,b.odds),0);
  const avgO=W.length?W.reduce((a,b)=>a+b.odds,0)/W.length:0;
  const kpi=(l,v,c="")=>`<div><small>${l}</small><b class="${c}">${v}</b></div>`;
  let h=head+`<div class="stk">${kpi("Paris terminés",D.length)}${kpi("Réussite",pct(W.length,D.length)+" %")}${kpi("Bilan",(net>=0?"+":"")+tok(net),net>=0?"pos":"neg")}
    ${kpi("Rendement",(net>=0?"+":"")+(staked?Math.round(net/staked*100):0)+" %",net>=0?"pos":"neg")}${kpi("Mise moyenne",tok(Math.round(staked/D.length)))}${kpi("Cote moy. gagnée",avgO?fr(avgO):"—")}</div>`;
  // tableau : nombre, réussite (barre), bilan
  const table=(title,rows,unit)=>rows.length?`<div class="grp">${title}</div><div class="sttab">${rows.map(r=>`<div class="str"><span class="stn">${r.ic?ic(r.ic):""}${esc(r.n)}</span><span class="stbar"><i style="width:${r.p}%"></i><em>${r.p} %</em></span><span class="stc">${r.c} ${unit}</span>${r.net!=null?`<b class="${r.net>=0?"pos":"neg"}">${r.net>=0?"+":""}${tok(r.net)}</b>`:""}</div>`).join("")}</div>`:"";
  const group=(arr,key,isLeg)=>{const g={};for(const x of arr){const k=key(x);if(!k)continue;const e=g[k]||(g[k]={n:k,c:0,w:0,net:isLeg?null:0});e.c++;if(isLeg?x.r==="w":x.st!=="lost")e.w++;if(!isLeg)e.net+=netOf(x)}
    return Object.values(g).map(e=>({...e,p:pct(e.w,e.c)})).sort((a,b)=>b.c-a.c)};
  const SPN={foot:["Football","ball"],rugby:["Rugby","rugby"],tennis:["Tennis","tennis"],basket:["Basket","basket"]};
  const sp=group(D,b=>{const s=[...new Set(b.legs.map(L=>L.sp))];return s.length===1?s[0]:"mix"}).map(r=>({...r,n:r.n==="mix"?"Plusieurs sports":SPN[r.n]?SPN[r.n][0]:r.n,ic:SPN[r.n]?SPN[r.n][1]:"ticket"}));
  h+=table("Par sport",sp,"paris");
  const kind=group(D,b=>b.legs.length>1?"Combinés":b.legs[0].live?"Simples en direct":"Simples avant-match");h+=table("Par façon de parier",kind,"paris");
  const legs=D.flatMap(b=>b.legs).filter(L=>L.r==="w"||L.r==="l");
  h+=table("Par championnat (pronostics justes)",group(legs,L=>L.snap&&SP[L.snap.sp||L.sp]&&SP[L.snap.sp||L.sp].lv[L.snap.lv],true).slice(0,8),"pronos");
  h+=table("Par type de pari (pronostics justes)",group(legs,L=>String(L.mt||"").replace(/\s*\(.*\)$/,"")||null,true).slice(0,10),"pronos");
  // bilan par mois
  const M={};for(const b of D){const d=new Date(b.done||b.at),k=d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0");M[k]=(M[k]||0)+netOf(b)}
  const mk=Object.keys(M).sort().slice(-6),mx=Math.max(1,...mk.map(k=>Math.abs(M[k])));
  h+=`<div class="grp">Bilan par mois</div><div class="stm">${mk.map(k=>`<div><span class="b ${M[k]>=0?"p":"n"}" style="height:${Math.max(3,Math.abs(M[k])/mx*70)}px"></span><b class="${M[k]>=0?"pos":"neg"}">${M[k]>=0?"+":""}${tok(M[k])}</b><small>${new Date(+k.slice(0,4),+k.slice(5)-1,1).toLocaleDateString("fr-FR",{month:"short"})}</small></div>`).join("")}</div>`;
  h+=`<div class="grp">Records</div><div class="stk" style="grid-template-columns:1fr 1fr">${kpi("Plus gros gain",big?"+"+tok(big):"—","pos")}${kpi("Plus grosse perte",worst?tok(worst):"—","neg")}${kpi("Meilleure cote gagnée",bestO?fr(bestO):"—")}${kpi("Meilleure série",best+" gagné"+(best>1?"s":""))}</div>`;
  return h+`<p class="note">Calculées sur tous tes paris terminés de ce téléphone. Un pari encaissé avant la fin compte comme réussi. Les « pronostics justes » comptent chaque sélection, y compris dans les combinés.</p>`}

/* ---------- courbe des jetons (30 derniers jours) ---------- */
function curve(H,now){if(!H||!H.length)return"";const pts=H.map(([d,v])=>[Date.UTC(+d.slice(0,4),+d.slice(4,6)-1,+d.slice(6,8)),v]);
  if(now!=null){const t=Date.UTC(new Date().getFullYear(),new Date().getMonth(),new Date().getDate());if(pts[pts.length-1][0]===t)pts[pts.length-1][1]=now;else pts.push([t,now])}
  if(pts.length<2)return`<div class="grp">Évolution des jetons</div><p class="note">La courbe apparaîtra dès demain.</p>`;
  const W=320,Hh=110,P=6,t0=pts[0][0],t1=pts[pts.length-1][0],lo=Math.min(...pts.map(p=>p[1])),hi=Math.max(...pts.map(p=>p[1])),rg=Math.max(1,hi-lo);
  const X=t=>P+(t-t0)/Math.max(1,t1-t0)*(W-2*P),Y=v=>Hh-P-(v-lo)/rg*(Hh-2*P);
  const d=pts.map((p,i)=>(i?"L":"M")+X(p[0]).toFixed(1)+" "+Y(p[1]).toFixed(1)).join(" "),diff=pts[pts.length-1][1]-pts[0][1],c=diff>=0?"var(--win)":"var(--loss)";
  return`<div class="grp">Évolution des jetons <span class="${diff>=0?"pos":"neg"}" style="float:right">${diff>=0?"+":""}${tok(diff)} en ${Math.round((t1-t0)/864e5)} j</span></div>
  <div class="curve"><svg viewBox="0 0 ${W} ${Hh}" preserveAspectRatio="none" aria-hidden="true"><path d="${d} L${X(t1).toFixed(1)} ${Hh} L${X(t0).toFixed(1)} ${Hh}Z" fill="${c}" opacity=".13"/><path d="${d}" fill="none" stroke="${c}" stroke-width="2.4" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>
  <div class="cl"><span>${tok(hi)}</span><span>${tok(lo)}</span></div></div>`}

/* ---------- photo de profil : choisir, déplacer, zoomer, valider ---------- */
const PH={img:null,x:0,y:0,z:1,min:1,box:260,pts:new Map(),d0:0,z0:1};
function openPhoto(){U.open="photo";const CUR=S.avatar||(S.avv&&S.pid?avUrl(S.pid,S.avv):null);layer(`<div class="grab"><h3>Ma photo</h3><button class="x" data-act="close" aria-label="Fermer">${ic("x")}</button></div>
  <div class="crop" id="crop"><div class="cimg" id="cimg">${CUR?`<img class="cur" src="${CUR}" alt="">`:""}</div><div class="cmask"></div>${CUR?"":`<div class="cempty">${ic("user")}<span>Aucune photo</span></div>`}</div>
  <label class="zoom" id="zoomw" hidden>${ic("target")}<input type="range" id="zoom" min="1" max="4" step="0.01" value="1" aria-label="Zoom"></label>
  <p class="note" id="phhint" style="text-align:center">${CUR?"Ta photo actuelle.":"Choisis une photo dans ta galerie ou prends-en une."}</p>
  <label class="btn ghost wide" style="margin-bottom:8px">${ic("plus")} ${CUR?"Choisir une autre photo":"Choisir une photo"}<input type="file" id="phfile" accept="image/*" hidden></label>
  <button class="btn gold wide" data-act="phok" id="phok" hidden>Valider ma photo</button>
  ${CUR?`<button class="link" data-act="phdel" style="display:block;margin:10px auto 0;color:var(--loss)">Supprimer ma photo</button>`:""}`);
  $("#phfile").addEventListener("change",e=>{const f=e.target.files&&e.target.files[0];if(f)loadPhoto(f)})}
function loadPhoto(file){const url=URL.createObjectURL(file),img=new Image();
  img.onload=()=>{PH.img=img;const B=PH.box=$("#crop").clientWidth;PH.min=Math.max(B/img.naturalWidth,B/img.naturalHeight);PH.z=1;PH.x=0;PH.y=0;
    const w=$("#cimg");w.innerHTML="";w.appendChild(img);img.style.width=img.naturalWidth+"px";img.style.height=img.naturalHeight+"px";
    const em=$(".cempty");if(em)em.remove();$("#zoomw").hidden=false;$("#zoom").value=1;$("#phok").hidden=false;
    $("#phhint").textContent="Fais glisser pour placer ta photo, pince ou utilise le curseur pour zoomer.";placePhoto();bindCrop()};
  img.onerror=()=>toast("Impossible de lire cette image.","bad");img.src=url}
// garde la photo toujours plus grande que le cercle
function placePhoto(){const im=PH.img;if(!im)return;const s=PH.min*PH.z,w=im.naturalWidth*s,h=im.naturalHeight*s,B=PH.box;
  PH.x=cl(PH.x,(B-w)/2,(w-B)/2);PH.y=cl(PH.y,(B-h)/2,(h-B)/2);
  im.style.transform=`translate(${(B-w)/2+PH.x}px,${(B-h)/2+PH.y}px) scale(${s})`}
function bindCrop(){const el=$("#crop");if(el._b)return;el._b=1;
  el.addEventListener("pointerdown",e=>{if(!PH.img)return;el.setPointerCapture(e.pointerId);PH.pts.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(PH.pts.size===2){const[a,b]=[...PH.pts.values()];PH.d0=Math.hypot(a.x-b.x,a.y-b.y);PH.z0=PH.z}});
  el.addEventListener("pointermove",e=>{const p=PH.pts.get(e.pointerId);if(!p)return;const n={x:e.clientX,y:e.clientY};
    if(PH.pts.size===1){PH.x+=n.x-p.x;PH.y+=n.y-p.y}
    PH.pts.set(e.pointerId,n);
    if(PH.pts.size===2){const[a,b]=[...PH.pts.values()];const d=Math.hypot(a.x-b.x,a.y-b.y);if(PH.d0)PH.z=cl(PH.z0*d/PH.d0,1,4);$("#zoom").value=PH.z}
    placePhoto()});
  const up=e=>{PH.pts.delete(e.pointerId);PH.d0=0};el.addEventListener("pointerup",up);el.addEventListener("pointercancel",up);
  el.addEventListener("wheel",e=>{e.preventDefault();PH.z=cl(PH.z*(e.deltaY<0?1.08:1/1.08),1,4);$("#zoom").value=PH.z;placePhoto()},{passive:false});
  $("#zoom").addEventListener("input",e=>{PH.z=+e.target.value;placePhoto()})}
async function savePhoto(){const im=PH.img;if(!im)return;const B=PH.box,O=320,k=O/B,s=PH.min*PH.z,w=im.naturalWidth*s,h=im.naturalHeight*s;
  const c=document.createElement("canvas");c.width=c.height=O;const g=c.getContext("2d");g.fillStyle="#0b1310";g.fillRect(0,0,O,O);
  g.drawImage(im,((B-w)/2+PH.x)*k,((B-h)/2+PH.y)*k,w*k,h*k);
  let url=c.toDataURL("image/jpeg",.85);if(url.length>150000)url=c.toDataURL("image/jpeg",.65);
  const b=$("#phok");b.disabled=true;b.textContent="Envoi…";
  try{if(!(await ensureSession()))throw{code:"offline"};const j=await api("set_avatar",{img:url});S.avatar=url;S.avv=j.v;save();closeLayer();bump();toast("Photo de profil enregistrée !","win");
    if(U.lg.data)loadBoards()}
  catch(e){b.disabled=false;b.textContent="Valider ma photo";toast(e.code==="image"?"Image trop lourde, zoome un peu plus.":"Pas de connexion au serveur.","bad")}}
async function deletePhoto(){if(!confirm("Supprimer ta photo de profil ?"))return;
  try{await api("set_avatar",{img:null});S.avatar=null;S.avv=0;save();closeLayer();toast("Photo supprimée.")}catch(e){toast("Pas de connexion au serveur.","bad")}}

/* ---------- côté dark : paris inventés, anonymes, en pari mutuel ---------- */
const DK_ICON=`<svg viewBox="0 0 24 24" class="i" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4l3.5 4.5M20 4l-3.5 4.5"/><path d="M12 21c-4.4 0-7-3-7-7.2C5 9.6 8 7 12 7s7 2.6 7 6.8C19 18 16.4 21 12 21z"/><path d="M8.5 13.5l2 .8M15.5 13.5l-2 .8M10 17.5c1.3.7 2.7.7 4 0"/></svg>`;
function viewDarkWarn(){const cur=U.dkSel;
  return`<div class="dkwarn"><div class="dkbig">${DK_ICON}</div><h2>Tu entres dans le côté dark</h2>
  <p>Ici, ce sont les membres de <b>« ${esc(cur?cur.name:"ta guilde")} »</b> qui inventent les paris, <b>anonymement</b> : « Julien arrivera en retard lundi ? », « Combien de temps va durer la réunion de 14 h ? »…</p>
  <ul><li>Les mises vont dans un <b>pot commun</b> : les gagnants se le partagent.</li>
  <li>Le créateur ne peut pas parier sur son propre pari. C’est lui qui donne le résultat, et les autres ont <b>12 h pour contester</b>.</li>
  <li><b>Rien de méchant</b> : pas de moqueries, rien sur la santé, le physique, la famille ou la vie privée de quelqu’un. Ce sont des collègues : si ça peut blesser ou mettre mal à l’aise, ce n’est plus drôle.</li>
  <li>Tout le monde peut <b>signaler</b> un pari : à 2 signalements, il disparaît.</li></ul>
  <button class="btn wide dkgo" data-act="dkenter">${DK_ICON} J’entre, j’ai compris</button><button class="link" data-act="dkhome" style="display:block;margin:12px auto 0">Retour</button></div>`}
function loadDark(){const c=U.lg.code;if(!c||!S.tok)return Promise.resolve();
  return api("dark_list",{code:c}).then(j=>{U.dk={code:c,bets:j.bets,at:Date.now()};settleDark(c,j.bets);if(U.tab==="l"&&U.dark&&!U.open)render()}).catch(()=>{U.dk=U.dk||{code:c,bets:[],err:1};if(U.tab==="l"&&U.dark&&!U.open)render()})}
const potOf=b=>Object.values(b.pools||{}).reduce((a,v)=>a+v,0);
function dkGain(b,opt,x){const T=potOf(b)+x,P=((b.pools||{})[opt]||0)+x;return P?Math.floor(x*T/P):x}
function leftTxt(t){const m=Math.round((t-Date.now())/6e4);return m<60?`${m} min`:m<1440?`${Math.floor(m/60)} h ${String(m%60).padStart(2,"0")}`:`${Math.round(m/1440)} j`}
function viewDark(cur){const D=U.dk&&U.dk.code===cur.code?U.dk.bets:null;if(!D)loadDark();else if(Date.now()-U.dk.at>3e4)setTimeout(loadDark,0);
  let h=`<div class="dkhead"><div><small>${esc(cur.name)}</small><h2>${DK_ICON} Le côté dark</h2><p>Paris inventés par les membres. Personne ne sait qui les a créés.</p></div></div>
  <div style="display:grid;grid-template-columns:1fr auto;gap:8px;margin-bottom:12px"><button class="btn" data-act="dknew">${ic("plus")} Inventer un pari</button><button class="btn ghost" data-act="dkexit">Quitter</button></div>
  <div class="dkcode"><span>Code secret : <b>${esc(cur.code)}</b></span><button class="link" data-act="dkshare">Partager</button></div>`;
  if(!D)return h+`<div class="skel"></div><div class="skel"></div>`;
  if(!D.length)return h+`<div class="empty">${DK_ICON}<b>Rien de louche pour l’instant</b>Lance le premier pari : retards, réunions, pauses café, paris entre collègues…</div>`;
  return h+D.map(b=>{const T=potOf(b),open=b.state==="open",my=b.my;
    const tag=open?`<span class="tag open">${leftTxt(b.closes)}</span>`:b.state==="closed"?`<span class="tag void">En attente du résultat</span>`:b.state==="contest"?`<span class="tag open">Résultat · 12 h pour contester</span>`:b.state==="final"?`<span class="tag won">Terminé</span>`:`<span class="tag lost">Annulé · remboursé</span>`;
    const u=b.unit?" "+esc(b.unit):"",near=b.kind==="num"&&b.resultNum!=null&&(b.guesses||[]).length?Math.min(...b.guesses.map(x=>Math.abs(x.g-b.resultNum))):null;
    const opts=b.kind==="num"?`${(b.guesses||[]).length?`<div class="dkguess">${b.guesses.map(x=>`<span class="${near!=null&&Math.abs(x.g-b.resultNum)===near?"win":""}${my&&my.guess===x.g?" mine":""}">${fr(x.g,x.g%1?1:0).replace(",0","")}${u} <small>${tok(x.a)}</small></span>`).join("")}</div>`:`<small class="mut">Aucun pronostic pour l’instant.</small>`}
      ${b.resultNum!=null?`<div class="dkresn">Résultat : <b>${fr(b.resultNum,b.resultNum%1?1:0)}${u}</b></div>`:""}
      ${open&&!b.mine&&!my?`<button class="btn dkgo wide" style="margin-top:8px" data-act="dkpick" data-id="${esc(b.id)}" data-opt="0">Donner mon chiffre et miser</button>`:open&&my?`<button class="btn ghost wide" style="margin-top:8px" data-act="dkpick" data-id="${esc(b.id)}" data-opt="0">Ajouter des jetons sur ${fr(my.guess,my.guess%1?1:0)}${u}</button>`:""}`
      :b.options.map((o,k)=>{const P=(b.pools||{})[k]||0,pct=T?Math.round(P/T*100):0,win=b.result===k&&b.state!=="void",mine=my&&my.opt===k;
      const can=open&&!b.mine&&(!my||my.opt===k);
      return`<button class="dkopt${win?" win":""}${mine?" mine":""}" ${can?`data-act="dkpick" data-id="${esc(b.id)}" data-opt="${k}"`:"disabled"}>
        <span class="bar" style="width:${pct}%"></span><b>${esc(o)}</b><small>${pct} % · ${tok(P)}</small>${win?`<i>✓</i>`:""}</button>`}).join("");
    const myTxt=my?(b.kind==="num"?` · toi : ${tok(my.amount)} sur ${fr(my.guess,my.guess%1?1:0)}${u}`:` · toi : ${tok(my.amount)} sur « ${esc(b.options[my.opt])} »`):"";
    let foot="";
    if(b.mine)foot=b.state==="closed"?(b.kind==="num"?`<div class="dkres"><small>C’est ton pari (personne ne le sait). Quel est le vrai chiffre ?</small><input type="number" inputmode="decimal" id="dkn-${esc(b.id)}" placeholder="ex. 14"><button class="btn ghost" data-act="dkresn" data-id="${esc(b.id)}">Valider</button></div>`
      :`<div class="dkres"><small>C’est ton pari (personne ne le sait). Qu’est-ce qui s’est passé ?</small>${b.options.map((o,k)=>`<button class="btn ghost" data-act="dkres" data-id="${esc(b.id)}" data-opt="${k}">${esc(o)}</button>`).join("")}</div>`)
      :`<small class="mut">${ic("info")} C’est ton pari : tu ne peux pas miser dessus${open&&!b.players?` · <button class="link" data-act="dkdel" data-id="${esc(b.id)}">Supprimer</button>`:""}</small>`;
    else if(b.state==="contest"&&!b.myContest)foot=`<small class="mut">Pas d’accord avec le résultat ? <button class="link" data-act="dkflag" data-kind="contest" data-id="${esc(b.id)}">Contester</button> (${b.contests}/2)</small>`;
    else if(b.myContest)foot=`<small class="mut">Tu as contesté ce résultat (${b.contests}/2).</small>`;
    return`<div class="dkbet"><div class="dkq"><b>${esc(b.question)}</b>${tag}</div>
      <small class="mut">Pot : <b>${tok(T)}</b> jetons · ${b.players} joueur${b.players>1?"s":""}${myTxt}</small>
      <div class="dkopts">${opts}</div>${foot}
      ${b.mine||b.myReport?"":`<button class="link dkrep" data-act="dkflag" data-kind="report" data-id="${esc(b.id)}">Signaler</button>`}</div>`}).join("")+
    `<p class="note">Pari mutuel : les gagnants se partagent tout le pot, au prorata de leur mise. Si personne n’a misé sur le bon choix, ou si le pari est annulé, tout le monde est remboursé.</p>`}
function viewDarkNew(){const f=U.dkf;
  const W=[["1h","Dans 1 h"],["soir","Ce soir 20 h"],["dem8","Demain 8 h"],["dem18","Demain 18 h"],["3j","Dans 3 jours"],["custom","Date précise…"]];
  const loc=t=>{const d=new Date(t);return new Date(d-d.getTimezoneOffset()*6e4).toISOString().slice(0,16)};
  if(f.when==="custom"&&!f.t)f.t=loc(dkWhen("dem8"));
  return`<div class="grab"><h3>Inventer un pari</h3><button class="x" data-act="close" aria-label="Fermer">${ic("x")}</button></div>
  <div class="form"><label>Ta question<input id="dk-q" maxlength="140" placeholder="ex. Julien arrivera en retard lundi ?" value="${esc(f.q||"")}"></label>
  <div class="seg"><button data-act="dkset" data-f="type" data-v="yn" aria-pressed="${f.type==="yn"}">Oui / Non</button><button data-act="dkset" data-f="type" data-v="multi" aria-pressed="${f.type==="multi"}">Choix</button><button data-act="dkset" data-f="type" data-v="num" aria-pressed="${f.type==="num"}">Un chiffre</button></div>
  ${f.type==="num"?`<label>Unité (facultatif)<input id="dk-u" maxlength="12" placeholder="ex. min, buts, fois" value="${esc(f.unit||"")}"></label><p class="note" style="margin:0">Chacun donne son chiffre en misant : <b style="color:var(--ink)">le plus proche gagne le pot</b> (partagé en cas d’égalité).</p>`:""}
  ${f.type==="multi"?f.opts.map((o,i)=>`<input class="dk-o" data-i="${i}" maxlength="40" placeholder="Choix ${i+1}${i===0?" (ex. moins de 5 min)":i===1?" (ex. 5 à 15 min)":""}" value="${esc(o)}">`).join("")+(f.opts.length<4?`<button class="link" data-act="dkset" data-f="add">${ic("plus")} Ajouter un choix</button>`:""):""}
  <label>Fin des paris</label><div class="chips">${W.map(([k,l])=>`<button data-act="dkset" data-f="when" data-v="${k}" aria-pressed="${f.when===k}">${l}</button>`).join("")}</div>
  ${f.when==="custom"?`<label>Date et heure exactes<input type="datetime-local" id="dk-t" value="${f.t}" min="${loc(Date.now()+6*6e4)}" max="${loc(Date.now()+30*DAY)}"></label>`:""}
  <p class="note" style="margin:0">Les paris se ferment : <b style="color:var(--ink)">${(()=>{const t=f.when==="custom"?Date.parse(f.t):dkWhen(f.when);return isNaN(t)?"—":fDay(t)+" à "+fTime(t)})()}</b></p>
  <p class="note">Ton nom ne sera jamais affiché. Tu ne pourras pas miser sur ce pari, et c’est toi qui donneras le résultat après la fin. Rappel : rien de méchant ni de personnel.</p>
  <button class="btn wide dkgo" data-act="dkcreate">${DK_ICON} Lancer le pari</button></div>`}
function dkKeep(){const f=U.dkf,q=$("#dk-q"),t=$("#dk-t"),u=$("#dk-u");if(q)f.q=q.value;if(t)f.t=t.value;if(u)f.unit=u.value;document.querySelectorAll(".dk-o").forEach(x=>f.opts[+x.dataset.i]=x.value)}
function dkSet(d){dkKeep();const f=U.dkf;if(d.f==="type")f.type=d.v;else if(d.f==="add"&&f.opts.length<4)f.opts.push("");else if(d.f==="when")f.when=d.v;layer(viewDarkNew())}
function dkWhen(k){const d=new Date();if(k==="1h")return Date.now()+H;if(k==="3j")return Date.now()+3*DAY;
  if(k==="soir"){d.setHours(20,0,0,0);if(d<Date.now()+10*6e4)d.setDate(d.getDate()+1);return+d}
  d.setDate(d.getDate()+1);d.setHours(k==="dem8"?8:18,0,0,0);return+d}
async function darkCreate(){dkKeep();const f=U.dkf,q=(f.q||"").trim(),num=f.type==="num",opts=num?[]:f.type==="yn"?["Oui","Non"]:f.opts.map(o=>o.trim()).filter(Boolean);
  if(q.length<6){toast("Écris une vraie question.","bad");return}if(!num&&opts.length<2){toast("Il faut au moins 2 choix.","bad");return}
  const closes=f.when==="custom"?Date.parse(f.t):dkWhen(f.when);
  if(isNaN(closes)||closes<Date.now()+5*6e4){toast("Choisis une fin dans au moins 5 minutes.","bad");return}
  if(closes>Date.now()+30*DAY){toast("30 jours maximum.","bad");return}
  const b=$("[data-act=dkcreate]");b.disabled=true;
  try{await api("dark_create",{code:U.lg.code,question:q,options:opts,closes,kind:num?"num":"choice",unit:num?(f.unit||"").trim():""});closeLayer();await loadDark();toast(`${DK_ICON} Pari lancé, anonymement.`,"win")}
  catch(e){b.disabled=false;toast(e.code==="options"?"Les choix doivent être différents.":e.code==="slow_down"?"Beaucoup de paris aujourd’hui !":"Pas de connexion au serveur.","bad")}}
function viewDarkStake(){const q=U.dks,b=U.dk.bets.find(x=>String(x.id)===String(q.id));if(!b)return"";
  return`<div class="grab"><h3>Miser</h3><button class="x" data-act="close" aria-label="Fermer">${ic("x")}</button></div>
  <p style="margin:0 0 6px;font-weight:700">${esc(b.question)}</p>${b.kind==="num"?(b.my?`<p class="note" style="margin-top:0">Ton chiffre : <b style="color:var(--acc)">${fr(b.my.guess,b.my.guess%1?1:0)}${b.unit?" "+esc(b.unit):""}</b></p>`
    :`<div class="form" style="margin-bottom:6px"><label>Ton chiffre${b.unit?" ("+esc(b.unit)+")":""}<input type="number" inputmode="decimal" id="dks-g" value="${q.guess??""}" placeholder="ex. 12"></label></div>`)
    :`<p class="note" style="margin-top:0">Ton choix : <b style="color:var(--acc)">${esc(b.options[q.opt])}</b></p>`}
  <div class="chips">${[10,20,50,100,250].map(v=>`<button data-act="dkamt" data-v="${v}" aria-pressed="${q.amount===v}">${v}</button>`).join("")}</div>
  ${b.kind==="num"?`<div class="sum"><div><small>Mise</small><b>${tok(q.amount)}</b></div><div class="g"><small>Pot actuel</small><b>${tok(potOf(b)+q.amount)}</b></div></div>`
    :`<div class="sum"><div><small>Mise</small><b>${tok(q.amount)}</b></div><div class="g"><small>Gain si ça passe (aujourd’hui)</small><b>${tok(dkGain(b,q.opt,q.amount))}</b></div></div>`}
  <p class="note">Le gain change jusqu’à la fin des paris : plus il y a de mises sur les autres choix, plus tu gagnes.</p>
  <button class="btn wide dkgo" data-act="dkbet" ${q.amount>S.bal?"disabled":""}>Miser ${tok(q.amount)} jetons</button>`}
async function darkStake(){const q=U.dks;if(q.amount>S.bal){toast("Pas assez de jetons.","bad");return}
  const bt=U.dk.bets.find(x=>String(x.id)===String(q.id)),num=bt&&bt.kind==="num",gi=$("#dks-g");let guess=num?(bt.my?bt.my.guess:gi&&gi.value!==""?+gi.value:NaN):null;
  if(num&&isNaN(guess)){toast("Donne ton chiffre.","bad");return}
  const b=$("[data-act=dkbet]");b.disabled=true;
  try{await api("dark_stake",{id:q.id,opt:q.opt,amount:q.amount,guess});S.bal-=q.amount;S.dk=S.dk||{};const e=S.dk[q.id]||(S.dk[q.id]={code:U.lg.code,opt:q.opt,amount:0,guess});e.amount+=q.amount;
    save();bump();closeLayer();await loadDark();toast("Mise enregistrée. Croise les doigts…","win")}
  catch(e){b.disabled=false;toast(e.code==="closed"?"Trop tard, les paris sont fermés.":e.code==="other_option"?"Tu as déjà misé sur un autre choix.":"Pas de connexion au serveur.","bad");loadDark()}}
async function darkResolve(id,opt,value){const b=U.dk.bets.find(x=>String(x.id)===String(id));
  if(!b||!confirm(`Résultat : « ${b.kind==="num"?value+(b.unit?" "+b.unit:""):b.options[opt]} » ?\nLes autres auront 12 h pour contester.`))return;
  try{await api("dark_resolve",{id,result:opt,value});await loadDark();toast("Résultat enregistré.","win")}catch(e){toast("Impossible pour l’instant.","bad")}}
async function darkFlag(id,kind){if(!confirm(kind==="report"?"Signaler ce pari comme méchant ou déplacé ? À 2 signalements, il disparaît.":"Contester ce résultat ? À 2 contestations, le pari est annulé et tout le monde est remboursé."))return;
  try{await api("dark_flag",{id,kind});await loadDark();toast(kind==="report"?"Signalement envoyé.":"Contestation enregistrée.")}catch(e){toast("Pas de connexion au serveur.","bad")}}
async function darkDelete(id){if(!confirm("Supprimer ton pari ?"))return;try{await api("dark_delete",{id});await loadDark()}catch(e){toast("Impossible : quelqu’un a déjà misé.","bad")}}
// gains : chaque téléphone se règle une seule fois quand le pari est définitif (ou annulé)
function settleDark(code,bets){if(!S.dk)return;let ch=false;
  for(const b of bets){const e=S.dk[b.id];if(!e||e.settled)continue;
    if(b.state==="void"){e.settled=1;ch=true;S.bal+=e.amount;toast(`Pari dark annulé : ${tok(e.amount)} jetons remboursés.`)}
    else if(b.state==="final"&&b.kind==="num"){e.settled=1;ch=true;const T=potOf(b),G=b.guesses||[];
      const near=G.length?Math.min(...G.map(x=>Math.abs(x.g-b.resultNum))):0,W=G.filter(x=>Math.abs(x.g-b.resultNum)===near).reduce((a,x)=>a+x.a,0),mg=e.guess??(b.my&&b.my.guess);
      if(mg!=null&&Math.abs(mg-b.resultNum)===near&&W){const g=Math.floor(e.amount*T/W);S.bal+=g;toast(`${DK_ICON} Le plus proche, c’était toi : +${tok(g)} jetons !`,"win");confetti()}
      else toast(`Pari dark perdu : « ${esc(b.question)} »`)}
    else if(b.state==="final"){e.settled=1;ch=true;const T=potOf(b),W=(b.pools||{})[b.result]||0;
      if(!W){S.bal+=e.amount;toast("Personne n’avait vu juste : mise remboursée.")}
      else if(e.opt===b.result){const g=Math.floor(e.amount*T/W);S.bal+=g;toast(`${DK_ICON} Pari dark gagné : +${tok(g)} jetons !`,"win");confetti()}
      else toast(`Pari dark perdu : « ${esc(b.question)} »`)}}
  for(const id in S.dk)if(S.dk[id].code===code&&!S.dk[id].settled&&!bets.some(b=>String(b.id)===String(id))){S.dk[id].settled=1;S.bal+=S.dk[id].amount;ch=true}   // pari masqué (signalé) : remboursé
  if(ch){S.peak=Math.max(S.peak,S.bal);save();render();bump()}}
async function checkDarkAll(){const codes=[...new Set(Object.values(S.dk||{}).filter(x=>!x.settled).map(x=>x.code))];
  for(const c of codes){try{const j=await api("dark_list",{code:c});settleDark(c,j.bets)}catch(e){}}}

/* ---------- entrée cachée : appui long (0,7 s) sur le logo AP ---------- */
let lpT=0;
document.addEventListener("contextmenu",e=>{if(e.target.closest(".blogo"))e.preventDefault()});
let lpXY=null,lpDone=0,lpBlock=0;
const lpStart=(e,x,y)=>{if(!e.target.closest(".blogo"))return;clearTimeout(lpT);lpXY=[x,y];lpT=setTimeout(()=>{lpXY=null;lpDone=Date.now();if(navigator.vibrate)navigator.vibrate(30);openDarkHome()},700)};
const lpStop=()=>{clearTimeout(lpT);lpXY=null};
document.addEventListener("touchstart",e=>{const t=e.touches[0];lpStart(e,t.clientX,t.clientY)},{passive:true});
document.addEventListener("touchmove",e=>{if(!lpXY)return;const t=e.touches[0];if(Math.abs(t.clientX-lpXY[0])+Math.abs(t.clientY-lpXY[1])>12)lpStop()},{passive:true});
document.addEventListener("touchend",e=>{lpStop();if(lpDone&&Date.now()-lpDone<10000){lpDone=0;lpBlock=Date.now();if(e.cancelable)e.preventDefault()}},{passive:false});
// le clic qui suit l'appui long ne doit pas refermer ce qui vient de s'ouvrir
document.addEventListener("click",e=>{if(Date.now()-lpBlock<600){e.stopPropagation();e.preventDefault();lpBlock=0}},true);document.addEventListener("touchcancel",lpStop);
if(!("ontouchstart" in window)){document.addEventListener("mousedown",e=>lpStart(e,e.clientX,e.clientY));document.addEventListener("mouseup",lpStop)}
U.dkLeagues=null;
async function loadDarkLeagues(){try{const j=await api("dark_leagues",{});U.dkLeagues=j.leagues}catch(e){U.dkLeagues=U.dkLeagues||[]}if(U.open==="dkhome")layer(viewDarkHome())}
function openDarkHome(){if(!S.name)return;U.open="dkhome";layer(viewDarkHome());ensureSession().then(loadDarkLeagues)}
function viewDarkHome(){const L=U.dkLeagues;
  return`<div class="dkwarn" style="padding-top:4px"><div class="dkbig">${DK_ICON}</div><h2>Le côté dark</h2><p style="text-align:center">Tes guildes secrètes. Elles n’apparaissent nulle part ailleurs : seuls ceux qui ont le code y entrent.</p></div>
  ${!L?`<div class="skel"></div>`:L.length?L.map(l=>`<button class="dkl" data-act="dkopen" data-code="${esc(l.code)}"><b>${esc(l.name)}</b><small>${l.n} membre${l.n>1?"s":""}</small><span>›</span></button>`).join(""):`<p class="note" style="text-align:center">Aucune guilde secrète pour l’instant.</p>`}
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px"><button class="btn dkgo" data-act="dknewl">${ic("plus")} Créer</button><button class="btn ghost" data-act="dkjoin">Rejoindre</button></div>
  <button class="link" data-act="close" style="display:block;margin:14px auto 0">Fermer</button>`}
async function darkNewLeague(){const v=(prompt("Nom de la guilde secrète :")||"").trim();if(!v)return;
  try{const j=await api("create_league",{name:v,dark:true});await loadDarkLeagues();darkEnter(j.code,v)}catch(e){toast(e.code==="too_many"?"Trop de guildes.":"Impossible pour l’instant.","bad")}}
async function darkJoin(){const v=(prompt("Code de la guilde secrète :")||"").trim();if(!v)return;
  try{const j=await api("join_league",{code:v,dark:true});await loadDarkLeagues();darkEnter(j.code,j.name)}catch(e){toast(e.code==="unknown"?"Code inconnu.":"Impossible pour l’instant.","bad")}}
function darkEnter(code,name){U.dkSel={code,name};U.open="dkwarn";layer(viewDarkWarn())}
function darkGo(){const c=U.dkSel;if(!c)return;if(!U.dark)U.dkPrev=U.lg.code;U.dkCur=c;U.lg.code=c.code;U.dark=true;U.tab="l";U.open=null;layer("");U.dk=null;render();loadDark();window.scrollTo({top:0})}
function darkExit(){U.dark=false;U.dkCur=null;U.lg.code=U.dkPrev||"";U.dk=null;render();loadBoards();window.scrollTo({top:0})}

/* ---------- prono du week-end ----------
   Le serveur choisit 7 gros matchs du week-end ; chacun devine les scores exacts jusqu'au coup d'envoi.
   5 pts score exact, 3 pts bon vainqueur + bon écart, 2 pts bon vainqueur ; joker ×2 ; 1 pt = 10 jetons. */
U.pr={data:null,tab:"week"};
async function loadProno(){if(!S.tok)return;const code=U.lg.code||(U.lg.data&&U.lg.data.leagues[0]&&U.lg.data.leagues[0].code)||"";
  try{const j=await api("prono_get",{code});const old=U.pr.data;
    // garder les pronos en cours d'envoi
    if(old&&old.week===j.week)for(const m of j.matches){const o=old.matches.find(x=>x.mid===m.mid);if(o&&o._pending)m.my=o.my}
    U.pr.data=j;U.pr.at=Date.now();pronoReward(j)}catch(e){}
  if(!U.open)render()}
const PRT={};
function pronoSave(m){m._pending=1;clearTimeout(PRT[m.mid]);PRT[m.mid]=setTimeout(async()=>{try{await api("prono_pick",{mid:m.mid,sh:m.my.sh,sa:m.my.sa});m._pending=0}
  catch(e){m._pending=0;toast(e.code==="started"?"Trop tard, le match a commencé.":"Pas de connexion : ton prono n’est pas enregistré.","bad");loadProno();return}
  clearTimeout(PRT._r);PRT._r=setTimeout(()=>{if(!U.pr.data.matches.some(x=>x._pending))loadProno()},1500)},500)}
async function pronoJoker(mid){const m=U.pr.data.matches.find(x=>x.mid===mid);if(!m)return;
  if(!m.my){toast("Mets d’abord un score sur ce match.","bad");return}
  clearTimeout(PRT[mid]);try{if(m._pending)await api("prono_pick",{mid,sh:m.my.sh,sa:m.my.sa});m._pending=0;await api("prono_joker",{mid});
    U.pr.data.matches.forEach(x=>{if(x.my)x.my.joker=x.mid===mid});render();toast("Joker posé : points ×2 sur ce match !","win")}
  catch(e){toast(e.code==="joker_locked"?"Ton joker est déjà sur un match commencé.":e.code==="started"?"Ce match a commencé.":"Pas de connexion.","bad")}}
// 10 jetons par point, versés une fois quand tous les matchs du week-end sont terminés
function pronoReward(j){S.prono=S.prono||{};if(S.prono[j.week])return;const M=j.matches;if(!M.length||!M.every(m=>m.done||m.cancel))return;
  const pts=M.reduce((a,m)=>a+(m.pts||0),0);S.prono[j.week]=1;if(pts>0){S.bal+=pts*10;S.peak=Math.max(S.peak,S.bal);toast(`Prono du week-end : ${pts} points = +${tok(pts*10)} jetons !`,"win");confetti();bump()}save()}
function prDays(j){const f=d=>new Date(d).toLocaleDateString("fr-FR",{weekday:"short",day:"numeric",month:"short"});return f(j.from+12*H)+" → "+f(j.to-12*H)}
function pronoBanner(){const j=U.pr.data;if(!j||!j.matches.length||!(U.lg.data&&U.lg.data.leagues.length))return"";
  const open=j.matches.filter(m=>m.t>Date.now()),done=j.matches.filter(m=>m.my).length;if(!open.length&&!j.matches.some(m=>m.my))return"";
  const pts=j.matches.reduce((a,m)=>a+(m.pts||0),0);
  return`<button class="prban" data-act="prgo">${ic("target")}<span><b>Prono du week-end</b><small>${open.length?`${done}/${j.matches.length} scores devinés · ${open.length} match${open.length>1?"s":""} encore ouvert${open.length>1?"s":""}`:`${pts} point${pts>1?"s":""} ce week-end`}</small></span><span class="arr">›</span></button>`}
function viewProno(cur){const j=U.pr.data;if(!j){loadProno();return`<div class="skel"></div><div class="skel"></div>`}
  if(Date.now()-(U.pr.at||0)>6e4)setTimeout(loadProno,0);
  const now=Date.now(),pts=j.matches.reduce((a,m)=>a+(m.pts||0),0),jk=j.matches.find(m=>m.my&&m.my.joker);
  let h=`<div class="prhead"><div><small>${esc(prDays(j))}</small><h3>Prono du week-end</h3><p>Devine les scores exacts. <b>5 pts</b> score exact · <b>3 pts</b> bon vainqueur et bon écart · <b>2 pts</b> bon vainqueur · <b>joker ×2</b>. 1 point = 10 jetons.</p></div><div class="prpts"><b>${pts}</b><small>pts</small></div></div>`;
  if(j.board&&j.board.lastWin)h+=`<div class="champ">${ic("target")}<div><small>Prono d’or de la semaine dernière</small><b>${j.board.lastWin.names.map(esc).join(" · ")} <span class="pos">${j.board.lastWin.pts} pts</span></b></div></div>`;
  if(!j.matches.length)return h+`<div class="empty">${ic("ball")}<b>Pas encore de matchs</b>Les matchs du week-end arrivent bientôt.</div>`;
  let day="";
  for(const m of j.matches){const d=fDay(m.t);if(d!==day){h+=`<div class="day">${d}</div>`;day=d}
    const open=m.t>now,my=m.my,lg={"soccer/fra.1":"Ligue 1","soccer/eng.1":"Premier League","soccer/esp.1":"La Liga","soccer/ita.1":"Serie A","soccer/ger.1":"Bundesliga"}[m.path]||"";
    const step=(side)=>`<div class="prstep">${open?`<button data-act="prno" data-mid="${esc(m.mid)}" data-side="${side}" data-d="1" aria-label="plus">+</button>`:""}<b>${my?my[side]:"–"}</b>${open?`<button data-act="prno" data-mid="${esc(m.mid)}" data-side="${side}" data-d="-1" aria-label="moins">−</button>`:""}</div>`;
    const real=m.sh!=null?`<div class="prreal">${m.done?"Score final":m.cancel?"Reporté":"En cours"} : <b>${m.sh}–${m.sa}</b>${m.pts!=null?` <span class="tag ${m.pts?"won":"lost"}">${m.pts?"+"+m.pts+" pts":"0 pt"}</span>`:""}</div>`:"";
    const oth=j.board&&j.board.others&&j.board.others[m.mid];
    h+=`<div class="prm${my&&my.joker?" jk":""}"><div class="prtop"><span>${esc(lg)}</span><span>${open?fTime(m.t):m.done?"Terminé":"Commencé"}</span></div>
      <div class="prrow"><div class="prt">${crest(m.h,"foot",m.hl)}<b>${esc(m.h)}</b></div>${step("sh")}<span class="prsep">–</span>${step("sa")}<div class="prt r">${crest(m.a,"foot",m.al)}<b>${esc(m.a)}</b></div></div>
      ${open?`<button class="prjk" data-act="prjk" data-mid="${esc(m.mid)}" aria-pressed="${!!(my&&my.joker)}">${ic("bolt")} ${my&&my.joker?"Joker ×2 sur ce match":"Mettre mon joker ici"}</button>`:my&&my.joker?`<div class="prjk on">${ic("bolt")} Joker ×2</div>`:""}
      ${!open&&!my?`<small class="mut">Tu n’as pas pronostiqué ce match.</small>`:""}${real}
      ${oth&&oth.length?`<div class="proth">${oth.map(o=>`<span>${esc(o.name)} <b>${o.sh}–${o.sa}</b>${o.joker?" ⚡":""}${o.pts!=null?` <i class="${o.pts?"pos":""}">${o.pts}</i>`:""}</span>`).join("")}</div>`:""}</div>`}
  if(j.board){const t=U.pr.tab,key=t==="week"?"week":"season",rows=j.board.rows.slice().sort((a,b)=>b[key]-a[key]||b.exact-a.exact);
    h+=`<div class="h2"><h2>Classement du prono</h2></div><div class="seg"><button data-act="prtab" data-v="week" aria-pressed="${t==="week"}">Ce week-end</button><button data-act="prtab" data-v="season" aria-pressed="${t==="season"}">Saison</button></div>`+
    rows.map((r,i)=>`<div class="prow${String(r.id)===String(j.me)?" me":""}" data-act="prof" data-id="${esc(r.id)}"><span class="rk">${i+1}</span>${avatar(r.id,r.name,r.av,"av"+frC(r.cos))}<div><b>${esc(r.name)}${String(r.id)===String(j.me)?" (toi)":""}${r.gold?` <span class="trs">${ic("target")}${r.gold>1?r.gold:""}</span>`:""}</b><small>${t==="week"?`${r.n}/${j.matches.length} pronos · ${r.exact} score${r.exact>1?"s":""} exact${r.exact>1?"s":""}`:`${r.season} points au total`}</small></div><span class="v">${r[key]} pts</span></div>`).join("")}
  return h}

/* ---------- notifications ----------
   Envoyées par le serveur quand un collègue fait quelque chose qui te concerne (duel, chat, réaction, arrivée).
   Sur iPhone : iOS 16.4 ou plus et l'app installée sur l'écran d'accueil. */
const VAPID_PUB="BNb9Bfnw4qxD1NTgsPfjQk5ufvrkK7f5ZE2Mid5KNfArGpm1j0NrPXfXb4u8HQQ8jydYMGUVQScISDAq81Z9KIw";
const pushOK=()=>"serviceWorker"in navigator&&"PushManager"in window&&"Notification"in window;
let psC=null,psAt=0;function pushState(){const n=Date.now();if(psC&&n-psAt<3000)return psC;psAt=n;return psC=pushState0()}
function pushState0(){if(!pushOK())return"na";if(Notification.permission==="denied")return"denied";return S.push&&Notification.permission==="granted"?"on":"off"}
const b64u=s=>{const p="=".repeat((4-s.length%4)%4),r=atob((s+p).replace(/-/g,"+").replace(/_/g,"/"));return Uint8Array.from(r,c=>c.charCodeAt(0))};
async function pushEnable(){if(!pushOK()){toast(IOS&&!STANDALONE?"Installe d’abord l’app sur l’écran d’accueil.":"Notifications indisponibles sur ce téléphone.","bad");return}
  try{const perm=await Notification.requestPermission();if(perm!=="granted"){toast("Notifications refusées.","bad");render();if(U.open==="notif")layer(viewNotif());return}
    const reg=await navigator.serviceWorker.ready;let sub=await reg.pushManager.getSubscription();
    if(!sub)sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:b64u(VAPID_PUB)});
    if(!(await ensureSession()))throw new Error("offline");await api("push_sub",{sub:sub.toJSON()});psC=null;S.push=1;save();render();if(U.open==="notif")layer(viewNotif());toast("🔔 Notifications activées !","win")}
  catch(e){toast("Impossible d’activer les notifications pour l’instant.","bad")}}
async function pushDisable(){try{const reg=await navigator.serviceWorker.ready,sub=await reg.pushManager.getSubscription();if(sub){api("push_unsub",{endpoint:sub.endpoint}).catch(()=>{});await sub.unsubscribe()}}catch(e){}
  psC=null;S.push=0;save();render();if(U.open==="notif")layer(viewNotif());toast("Notifications désactivées.")}
// le téléphone peut renouveler son abonnement : on le renvoie au serveur à chaque ouverture
async function pushRefresh(){if(!S.push||!pushOK()||Notification.permission!=="granted")return;try{const reg=await navigator.serviceWorker.ready,sub=await reg.pushManager.getSubscription();
  if(sub&&S.tok)api("push_sub",{sub:sub.toJSON()}).catch(()=>{});else if(!sub)pushEnable()}catch(e){}}
function pushBanner(){if(pushState()!=="off")return"";let x=0;try{x=+localStorage.getItem("dap.pushx")||0}catch(e){}if(Date.now()-x<5*DAY)return"";
  return`<div class="pushb">${ic("fire")}<div><b>Active les notifications</b><small>Duels, matchs du soir, prono, classement : ne rate rien.</small></div><button class="btn" data-act="notif">Activer</button><button class="x" data-act="pushx" aria-label="Plus tard">${ic("x")}</button></div>`}
function openNotif(){U.open="notif";layer(viewNotif())}
function viewNotif(){const st=pushState();
  const head=`<div class="grab"><h3>Notifications</h3><button class="x" data-act="close" aria-label="Fermer">${ic("x")}</button></div>`;
  const list=`<div class="nflist"><div>${ic("target")}Un collègue te lance un duel ou l’accepte</div><div>${ic("ball")}Les gros matchs du jour et le prono du week-end</div>
    <div>${ic("chart")}Quand quelqu’un te passe devant dans ta guilde</div><div>${ic("group")}Les messages du chat de ta guilde</div><div>${ic("trophy")}Le bilan du lundi et le champion du mois</div></div>`;
  if(st==="on")return head+`<div class="nfhero on"><div class="big">${ic("bell")}</div><h2>Activées</h2><p>Tu recevras les notifications sur ce téléphone.</p></div>
    <div class="row" style="flex-wrap:wrap;gap:8px"><div><b>Rappels pour parier</b><small>${["Aucun rappel","Un rappel à midi","À midi et vers 18 h"][S.remind??2]}</small></div>
    <div class="seg" style="width:100%;margin:0">${[["2","2 / jour"],["1","1 / jour"],["0","Aucun"]].map(([v,l])=>`<button data-act="remind" data-v="${v}" aria-pressed="${String(S.remind??2)===v}">${l}</button>`).join("")}</div></div>
    ${list}<button class="btn ghost wide" data-act="pushtest">Envoyer une notification de test</button>
    <p class="note" style="text-align:center"><button class="link" data-act="pushoff" style="color:var(--loss)">Couper les notifications</button></p>`;
  if(st==="denied")return head+`<div class="nfhero"><div class="big">${ic("bell")}</div><h2>Bloquées</h2><p>Tu as refusé les notifications : il faut les réautoriser dans les réglages du téléphone.</p></div>
    <ol class="steps">${IOS?`<li><span class="n">1</span><div>Ouvre <b>Réglages</b> › <b>Notifications</b>.</div></li><li><span class="n">2</span><div>Choisis <b>Tribune</b> et active <b>Autoriser les notifications</b>.</div></li>`
      :`<li><span class="n">1</span><div>Appuie longtemps sur l’icône de l’app › <b>Infos sur l’appli</b> (ⓘ).</div></li><li><span class="n">2</span><div><b>Notifications</b> › active-les.</div></li>`}
    <li><span class="n">3</span><div>Reviens ici et touche <b>Activer</b>.</div></li></ol><button class="btn gold wide" data-act="pushon">${ic("bell")} Activer</button>`;
  if(st==="na")return head+`<div class="nfhero"><div class="big">${ic("bell")}</div><h2>Pas disponible ici</h2><p>${IOS&&!STANDALONE?"Installe d’abord l’app sur ton écran d’accueil, puis ouvre-la depuis l’icône.":IOS?"Il faut iOS 16.4 ou plus récent : mets ton iPhone à jour (Réglages › Général › Mise à jour logicielle).":"Ton navigateur ne gère pas les notifications. Utilise Chrome."}</p></div>${list}`;
  return head+`<div class="nfhero"><div class="big">${ic("bell")}</div><h2>Ne rate rien</h2><p>Un appui suffit. Tu pourras régler les rappels ou tout couper quand tu veux.</p></div>
    <button class="btn gold wide" data-act="pushon" style="font-size:19px;padding:15px">${ic("bell")} Activer les notifications</button>${list}
    <p class="note" style="text-align:center">Ton téléphone va te demander l’autorisation : choisis <b>Autoriser</b>.</p>`}

// ouvrir le bon écran depuis une notification (…?go=duels&code=ABCDE)
function goFrom(url){try{const u=new URL(url,location.href),g=u.searchParams.get("go"),c=u.searchParams.get("code");if(!g)return;
  if(u.search)history.replaceState(null,"",location.pathname);U.open=null;layer("");U.tab="l";if(c)U.lg.code=c.toUpperCase();
  if(g==="recap"){U.dark=false;U.lg.view="rank";render();loadBoards();openRecap(U.lg.code);return}
  if(g==="dark"&&c){U.open=null;layer("");loadDarkLeagues().then(()=>{const l=(U.dkLeagues||[]).find(x=>x.code===c.toUpperCase());if(l){U.lg.code="";U.dkSel={code:l.code,name:l.name};darkGo()}});return}
  if(g==="bets"){U.dark=false;U.tab="b";render();window.scrollTo({top:0});return}
  if(g==="dark")g="rank";U.lg.view=g;if(g==="fights")loadBattles(U.lg.code);render();loadBoards();if(g==="chat")loadChat();if(g==="duels")loadDuels();if(g==="feed")loadActFeed();if(g==="prono")loadProno();window.scrollTo({top:0})}catch(e){}}
if("serviceWorker"in navigator)navigator.serviceWorker.addEventListener("message",e=>{if(e.data&&e.data.go)goFrom(e.data.go)});

/* ---------- chat de la guilde ---------- */
const CH={};   // code → {msgs, last, at}
const QUICK=["😂 La honte","👏 Bien joué","🔥 Chaud !","Revanche ?","On parie ?","Pas de chance…"];
function chatUnread(code){const c=CH[code];if(!c||!c.msgs.length)return 0;if(U.tab==="l"&&U.lg.view==="chat"&&U.lg.code===code&&!U.dark)return 0;const seen=(S.chatSeen||{})[code]||0;return c.msgs.filter(m=>m.id>seen&&String(m.who)!==String(c.me)).length}
async function loadChat(){const code=U.lg.code;if(!code||!S.tok)return;const c=CH[code]||(CH[code]={msgs:[],last:0});
  try{const j=await api("chat_list",{code,after:c.last});const have=new Set(c.msgs.map(m=>String(m.id))),nw=j.msgs.filter(m=>!have.has(String(m.id)));if(nw.length){c.msgs=c.msgs.concat(nw).slice(-200);c.last=c.msgs[c.msgs.length-1].id}c.at=Date.now();c.me=j.me}catch(e){c.err=1}
  if(U.tab==="l"&&U.lg.view==="chat"&&U.lg.code===code&&!U.open){const box=$("#chbox"),stick=!box||box.scrollHeight-box.scrollTop-box.clientHeight<80;
    const inp=$("#chin"),val=inp?inp.value:"",foc=document.activeElement===inp;render();const b2=$("#chbox");if(b2&&stick)b2.scrollTop=b2.scrollHeight;
    const i2=$("#chin");if(i2){i2.value=val;if(foc)i2.focus()}
    if(c.msgs.length){S.chatSeen=S.chatSeen||{};S.chatSeen[code]=c.last;saveLocal()}}}
let chT=0;
function viewChat(cur){const c=CH[cur.code];clearTimeout(chT);chT=setTimeout(()=>{if(U.tab==="l"&&U.lg.view==="chat"&&!document.hidden)loadChat()},c?5000:0);
  if(!c)return`<div class="skel" style="height:240px"></div>`;
  let h=`<div class="chbox" id="chbox">`,day="";
  if(!c.msgs.length)h+=`<div class="empty" style="border:0">${ic("group")}<b>Le chat de « ${esc(cur.name)} »</b>Chambre tes collègues, prépare tes duels, commente les matchs…</div>`;
  for(const m of c.msgs){if(blocked(m.who))continue;const d=fDay(m.at);if(d!==day){h+=`<div class="chday">${d}</div>`;day=d}const mine=String(m.who)===String(c.me);
    h+=`<div class="chm${mine?" me":""}">${mine?"":`<span data-act="prof" data-id="${esc(m.who)}">${avatar(m.who,m.name,m.av,"av"+frC(m.cos))}</span>`}<div class="chb">${mine?"":`<b>${nameH(m.name,m.cos)}</b>`}<p>${esc(m.text).replace(/\n/g,"<br>")}</p><small>${fTime(m.at)}${mine?` · <button class="link" data-act="chdel" data-id="${esc(m.id)}">supprimer</button>`:` · <button class="link" data-act="chmenu" data-id="${esc(m.id)}" aria-label="Signaler ou bloquer">•••</button>`}</small></div></div>`}
  h+=`</div><div class="chq">${QUICK.map(q=>`<button data-act="chq" data-t="${esc(q)}">${esc(q)}</button>`).join("")}</div>
  <div class="chin"><textarea id="chin" rows="1" maxlength="400" placeholder="Écris à la guilde…"></textarea><button class="btn" data-act="chsend" aria-label="Envoyer">${ic("share")}</button></div>`;
  setTimeout(()=>{const b=$("#chbox");if(b&&!b._s){b._s=1;b.scrollTop=b.scrollHeight}},0);
  if(c.msgs.length){S.chatSeen=S.chatSeen||{};S.chatSeen[cur.code]=c.last;saveLocal()}
  return h}
async function chatSend(quick){const inp=$("#chin"),text=(quick||(inp&&inp.value)||"").trim();if(!text)return;const code=U.lg.code;
  if(!quick&&inp)inp.value="";
  try{await api("chat_send",{code,text});await loadChat();const b=$("#chbox");if(b)b.scrollTop=b.scrollHeight}
  catch(e){if(!quick&&inp)inp.value=text;toast(e.code==="slow_down"?"Doucement ! Trop de messages.":"Message non envoyé (pas de connexion).","bad")}}
async function chatDelete(id){if(!confirm("Supprimer ce message ?"))return;try{const j=await api("chat_delete",{id});if(j&&j.error)throw j;if(U.open==="chmenu")closeLayer();const c=CH[U.lg.code];if(c)c.msgs=c.msgs.filter(m=>String(m.id)!==String(id));render()}catch(e){}}

/* ---------- duels ---------- */
async function loadDuels(){if(!S.tok)return;try{const j=await api("duels",{});U.lg.duels=j.duels;U.lg.duelsAt=Date.now();await checkDuels(j.duels,j.me)}catch(e){}
  if(U.tab==="l"&&!U.open)render()}
const myDuel=id=>(S.duel||{})[id];
async function checkDuels(D,me){let changed=false;S.duel=S.duel||{};
  for(const x of D){const mine=myDuel(x.id);if(!mine)continue;
    if(x.status==="live"&&Date.now()>x.t+90*6e4){let m=REG.get(x.mid);if(!m&&mine.snap&&!mine.ref){mine.ref=1;await espnRefetch({...mine.snap,t:x.t});m=REG.get(x.mid)}
      const sc=m&&status(m)==="post"&&!m.cancel&&finalScore(m);
      if(sc){const res=m.sp==="tennis"||m.sp==="basket"?(sc[0]>sc[1]?0:1):cmp3(sc);
        // le serveur lit lui-même le score et décide ; on suit son verdict
        const r=await api("duel_result",{id:x.id,res}).catch(()=>null);
        if(r&&r.status==="done"){x.status="done";x.res=r.res;x.winner=r.winner}else if(!r){x.status="done";x.res=res;x.winner=x.ka===res?x.a:x.kb===res?x.b:null}}
      else if(m&&(m.cancel||status(m)==="cancel")){x.status="done";x.winner=null}}
    if(mine.settled)continue;
    if(x.entries&&(x.status==="done"||x.status==="expired")){const e=x.entries.find(y=>String(y.who)===String(me));if(!e||e.payout==null){if(x.status==="done")U.lg.duelsAt=0;continue}
      mine.settled=1;changed=true;S.bal+=e.payout;
      if(x.status==="expired")toast(`Défi ${esc(x.mlabel)} : pas assez de pronostics différents, ${tok(e.payout)} jetons remboursés.`);
      else if(e.payout>mine.stake||(e.payout&&e.k===x.res)){toast(`${ic("trophy")} Défi gagné : +${tok(e.payout)} jetons !`,"win");confetti();S.dwin=(S.dwin||0)+1;postAct("duelwin",{mlabel:x.mlabel,pay:e.payout,n:x.entries.length})}
      else if(e.payout)toast(`Défi ${esc(x.mlabel)} : personne n’a vu juste, mise remboursée.`);
      else toast(`Défi perdu sur ${esc(x.mlabel)}. La revanche ?`);continue}
    if(x.status==="done"){mine.settled=1;changed=true;
      if(x.winner==null){S.bal+=mine.stake;toast(`Duel ${esc(x.mlabel)} : personne n’a vu juste, mise remboursée.`)}
      else if(String(x.winner)===String(me)){S.bal+=2*mine.stake;toast(`${ic("trophy")} Duel gagné : +${tok(2*mine.stake)} jetons !`,"win");confetti();
        S.dwin=(S.dwin||0)+1;postAct("duelwin",{mlabel:x.mlabel,pay:2*mine.stake,opp:String(x.a)===String(me)?x.bname:x.aname})}
      else toast(`Duel perdu sur ${esc(x.mlabel)}. La revanche ?`)}
    else if(x.status==="expired"){mine.settled=1;changed=true;S.bal+=mine.stake;toast(`Personne n’a relevé ton duel ${esc(x.mlabel)} : ${tok(mine.stake)} jetons remboursés.`)}}
  if(changed){S.peak=Math.max(S.peak,S.bal);save();render();bump()}}
function duelPick(x,k){return(x.opts||[])[k]||["1","N","2"][k]}
function viewDuels(cur){const D=(U.lg.duels||[]).filter(x=>x.code===cur.code),me=String(U.lg.data.me);
  if(!U.lg.duels){loadDuels();return`<div class="skel" style="height:90px"></div>`}
  if(Date.now()-(U.lg.duelsAt||0)>3e4)setTimeout(loadDuels,0);
  let h=`<div class="info">${ic("info")}<span>Ouvre un match à venir et touche <b style="color:var(--ink)">Défier ma guilde</b>. Tout le monde peut entrer avec son pronostic et la même mise : à la fin, <b style="color:var(--ink)">le pot est partagé entre ceux qui ont vu juste</b>.</span></div>`;
  if(!D.length)return h+`<div class="empty">${ic("target")}<b>Aucun duel</b>Lance le premier !</div>`;
  return h+D.map(x=>{if(x.entries)return groupDuel(x,me);const iA=String(x.a)===me,iB=String(x.b)===me,start=Date.now()<x.t;
    let st="",act="";
    if(x.status==="open"){st=`<span class="tag open">En attente</span>`;
      if(!iA&&start)act=`<div class="dacc"><small>Relever le défi (${tok(x.stake)} jetons) :</small>${(x.opts||[]).map((o,k)=>k===x.ka?"":`<button class="btn ghost" data-act="daccept" data-id="${esc(x.id)}" data-k="${k}">${esc(o)}</button>`).join("")}</div>`}
    else if(x.status==="live")st=`<span class="tag open">${start?"Relevé":"En cours"}</span>`;
    else if(x.status==="expired")st=`<span class="tag void">Expiré</span>`;
    else st=x.winner==null?`<span class="tag void">Nul</span>`:`<span class="tag ${String(x.winner)===me?"won":iA||iB?"lost":"cashed"}">${String(x.winner)===me?"Gagné":esc(String(x.winner)===String(x.a)?x.aname:x.bname)+" gagne"}</span>`;
    return`<div class="duel"><div class="dh2"><b>${esc(x.mlabel)}</b>${st}</div><small>${fDay(x.t)} · ${fTime(x.t)} · mise ${tok(x.stake)} chacun</small>
      <div class="vs"><div class="${x.status==="done"&&String(x.winner)===String(x.a)?"w":""}"><span data-act="prof" data-id="${esc(x.a)}">${avatar(x.a,x.aname,x.aav,"av")}</span><b>${esc(x.aname)}${iA?" (toi)":""}</b><em>${esc(duelPick(x,x.ka))}</em></div>
      <span class="vsx">VS</span>
      <div class="${x.status==="done"&&String(x.winner)===String(x.b)?"w":""}">${x.b?`<span data-act="prof" data-id="${esc(x.b)}">${avatar(x.b,x.bname||"?",x.bav,"av")}</span><b>${esc(x.bname||"?")}${iB?" (toi)":""}</b><em>${esc(duelPick(x,x.kb))}</em>`:`<span class="av q">?</span><b>Qui relève ?</b>`}</div></div>${act}</div>`}).join("")}
// défi à plusieurs : participants regroupés par pronostic, pot commun
function groupDuel(x,me){const E=x.entries,mineE=E.find(y=>String(y.who)===me),start=Date.now()<x.t,pot=E.reduce((a,y)=>a+y.stake,0),opts=x.opts&&x.opts.length?x.opts:["1","N","2"];
  const st=x.status==="open"?`<span class="tag open">${start?"Ouvert":"Lancement…"}</span>`:x.status==="live"?`<span class="tag open">En cours</span>`:x.status==="expired"?`<span class="tag void">Annulé</span>`
    :mineE?`<span class="tag ${mineE.payout>0&&mineE.k===x.res?"won":mineE.payout?"void":"lost"}">${mineE.k===x.res&&mineE.payout?"Gagné +"+tok(mineE.payout):mineE.payout?"Remboursé":"Perdu"}</span>`:`<span class="tag cashed">Terminé</span>`;
  const col=opts.map((o,k)=>{const P=E.filter(y=>y.k===k),win=x.status==="done"&&x.res===k;
    return`<div class="gdc${win?" w":""}"><div class="gdh"><b>${esc(o)}</b><small>${P.length} joueur${P.length>1?"s":""}</small></div>
      <div class="gdp">${P.map(y=>`<span data-act="prof" data-id="${esc(y.who)}" title="${esc(y.name)}">${avatar(y.who,y.name,y.av,"av")}</span>`).join("")||`<span class="mut" style="font-size:12px">personne</span>`}</div>
      ${x.status==="open"&&start&&!mineE?`<button class="btn ghost gdj" data-act="daccept" data-id="${esc(x.id)}" data-k="${k}">Je rejoins</button>`:""}</div>`}).join("");
  return`<div class="duel gduel"><div class="dh2"><b>${esc(x.mlabel)}</b>${st}</div>
    <small>${fDay(x.t)} · ${fTime(x.t)} · ${tok(x.stake)} jetons chacun · lancé par ${esc(x.aname)}</small>
    <div class="gpot">💰 Pot : <b>${tok(pot)}</b> jetons · ${E.length} participant${E.length>1?"s":""}${mineE?` · toi : <b>${esc(opts[mineE.k]||"")}</b>`:""}</div>
    <div class="gdcols c${opts.length}">${col}</div>
    ${x.status==="open"&&start?`<small class="mut" style="display:block;margin-top:6px">Il faut au moins 2 pronostics différents au coup d’envoi, sinon tout le monde est remboursé.</small>`:""}</div>`}
async function acceptDuel(id,k){const x=(U.lg.duels||[]).find(y=>String(y.id)===String(id));if(!x)return;
  if(x.stake>S.bal){toast("Pas assez de jetons pour relever ce duel.","bad");return}
  if(!confirm(`${x.entries?"Rejoindre le défi":"Relever le duel"} ${x.mlabel} avec « ${duelPick(x,k)} » pour ${tok(x.stake)} jetons ?`))return;
  try{await api(x.entries?"duel_join":"duel_accept",x.entries?{id,k}:{id,kb:k});S.bal-=x.stake;S.duel=S.duel||{};S.duel[id]={stake:x.stake,snap:null};const m=REG.get(x.mid);if(m&&m.src==="espn")S.duel[id].snap={path:m.path,sp:m.sp,lv:m.lv};
    save();bump();toast(`${ic("target")} Défi relevé ! Que le meilleur gagne.`,"win");postAct("duel",{mlabel:x.mlabel,pick:duelPick(x,k),stake:x.stake,acc:1,opp:x.aname});await loadDuels()}
  catch(e){toast(e.code==="already"?"Tu participes déjà à ce défi.":e.code==="unavailable"?"Trop tard : le match a commencé.":"Pas de connexion au serveur.","bad");loadDuels()}}
// création depuis la fiche d'un match
function duelButton(m){if(m.src!=="espn"||status(m)!=="pre"||m.t-Date.now()<2*6e4||!U.lg.data||!U.lg.data.leagues.length)return"";
  return`<button class="btn ghost wide" data-act="dnew" data-mid="${esc(m.id)}" style="margin:6px 0 4px">${ic("target")} Défier ma guilde sur ce match</button>`}
function viewDuelNew(m){const L=U.lg.data.leagues,res=markets(m).find(x=>x.id==="res"),opts=res.sels.map(x=>x.l);U.dn=U.dn||{k:0,stake:50,code:L[0].code};if(!L.some(l=>l.code===U.dn.code))U.dn.code=L[0].code;
  return`<div class="grab"><h3>Défier ma guilde</h3><button class="x" data-act="dback" data-mid="${esc(m.id)}" aria-label="Retour">${ic("x")}</button></div>
  <p class="note" style="margin-top:0">${esc(m.h)} – ${esc(m.a)} · ${fDay(m.t)} ${fTime(m.t)}</p>
  ${L.length>1?`<div class="lgchips">${L.map(l=>`<button data-act="dset" data-f="code" data-v="${esc(l.code)}" aria-pressed="${U.dn.code===l.code}">${esc(l.name)}</button>`).join("")}</div>`:""}
  <div class="grp" style="margin-top:4px">Ton pronostic</div><div class="odds c${opts.length}">${opts.map((o,k)=>`<button class="odd" data-act="dset" data-f="k" data-v="${k}" aria-pressed="${U.dn.k===k}"><span>${esc(o)}</span></button>`).join("")}</div>
  <div class="grp">Mise (chacun)</div><div class="chips">${[20,50,100,250].map(v=>`<button data-act="dset" data-f="stake" data-v="${v}" aria-pressed="${U.dn.stake===v}">${v}</button>`).join("")}</div>
  <p class="note">Tous les membres peuvent entrer jusqu’au coup d’envoi, avec le pronostic de leur choix et la même mise (${tok(U.dn.stake)} jetons). À la fin, <b>le pot est partagé entre ceux qui ont vu juste</b>. S’il n’y a pas au moins 2 pronostics différents au coup d’envoi, ou si personne n’a vu juste, tout le monde est remboursé.</p>
  <button class="btn gold wide" data-act="dgo" data-mid="${esc(m.id)}" ${U.dn.stake>S.bal?"disabled":""}>${ic("target")} Lancer le défi · ${tok(U.dn.stake)} jetons</button>`}
async function createDuel(mid){const m=findMatch(mid);if(!m||status(m)!=="pre")return;const res=markets(m).find(x=>x.id==="res"),opts=res.sels.map(x=>x.l),q=U.dn;
  if(q.stake>S.bal){toast("Pas assez de jetons.","bad");return}const b=$("[data-act=dgo]");b.disabled=true;
  try{if(!(await ensureSession()))throw{code:"offline"};
    const j=await api("duel_create",{code:q.code,mid:m.id,path:m.path,mlabel:m.h+" – "+m.a,opts,t:m.t,ka:q.k,stake:q.stake});
    S.bal-=q.stake;S.duel=S.duel||{};S.duel[j.id]={stake:q.stake,snap:{path:m.path,sp:m.sp,lv:m.lv}};save();bump();
    postAct("duel",{mlabel:m.h+" – "+m.a,pick:opts[q.k],stake:q.stake});U.lg.code=q.code;U.lg.view="duels";U.lg.duels=null;U.open=null;layer("");U.tab="l";render();loadBoards();loadDuels();
    toast(`${ic("target")} Défi lancé ! Tes potes peuvent entrer dans Guildes › Combats › Duels.`,"win")}
  catch(e){b.disabled=false;toast(e.code==="started"?"Le match commence trop tôt pour un duel.":e.code==="slow_down"?"Beaucoup de duels aujourd’hui !":"Pas de connexion au serveur.","bad")}}
function viewLgForm(kind){const nw=kind==="new";
  return`<div class="grab"><h3>${nw?"Nouvelle guilde":"Rejoindre une guilde"}</h3><button class="x" data-act="close" aria-label="Fermer">${ic("x")}</button></div>
  <div class="form"><label>${nw?"Nom de la guilde":"Code de la guilde"}<input id="lg-in" maxlength="${nw?24:5}" ${nw?'placeholder="ex. Les potes du dimanche"':'placeholder="ex. K7RZP" autocapitalize="characters" style="text-transform:uppercase;letter-spacing:4px;font-weight:800"'} autocomplete="off"></label>
  <button class="btn gold wide" data-act="lgok" data-kind="${kind}">${nw?"Créer la guilde":"Rejoindre"}</button>
  <p class="note">${nw?"Tu recevras un code à 5 lettres à donner à tes amis.":"Demande le code à l’ami qui a créé la guilde."}</p></div>`}
const LGERR={unknown:"Aucune guilde avec ce code.",full:"Cette guilde est pleine (100 joueurs).",too_many:"Tu es déjà dans 12 guildes : quittes-en une d’abord.",slow_down:"Doucement ! Réessaie dans un moment.",name:"Donne un nom à ta guilde.",name_bad:"Ce nom n’est pas accepté. Choisis-en un autre."};
async function lgSubmit(kind){const v=($("#lg-in").value||"").trim();if(!v){$("#lg-in").focus();return}const b=$("[data-act=lgok]");b.disabled=true;
  try{if(!(await ensureSession()))throw{code:"offline"};
    const j=kind==="new"?await api("create_league",{name:v}):await api("join_league",{code:v});if(kind!=="new"&&!j.already)postAct("join",{});
    U.lg.code=j.code;U.open=null;layer("");U.tab="l";await loadBoards();render();
    toast(kind==="new"?`${ic("trophy")} Guilde créée ! Code : <b>${esc(j.code)}</b>`:j.already?"Tu es déjà dans cette guilde.":`${ic("group")} Bienvenue dans « ${esc(j.name)} » !`,"win");if(kind==="new")lgInvite()}
  catch(e){b.disabled=false;toast(LGERR[e.code]||"Pas de connexion au serveur.","bad")}}
async function lgInvite(){const d=U.lg.data,cur=d&&d.leagues.find(l=>l.code===U.lg.code);if(!cur)return;
  const url=location.origin+location.pathname+"?ligue="+cur.code,txt=`Rejoins ma guilde « ${cur.name} » sur Tribune (paris gratuits, jetons fictifs) ! Code : ${cur.code}`;
  try{if(navigator.share){await navigator.share({title:"Tribune",text:txt,url});return}}catch(e){if(e&&e.name==="AbortError")return}
  try{await navigator.clipboard.writeText(txt+" "+url);toast("Invitation copiée : colle-la dans ta conversation.","win")}catch(e){prompt("Copie ce lien :",url)}}
async function lgLeave(){const d=U.lg.data,cur=d&&d.leagues.find(l=>l.code===U.lg.code);if(!cur||!confirm(`Quitter « ${cur.name} » ?`))return;
  try{await api("leave_league",{code:cur.code});U.lg.code="";await loadBoards();toast("Tu as quitté la guilde.")}catch(e){toast("Pas de connexion au serveur.","bad")}}
// Lien d'invitation : …/?ligue=CODE
async function joinFromLink(){const c=new URLSearchParams(location.search).get("guilde");if(!c||!S.name)return;
  history.replaceState(null,"",location.pathname);
  try{if(!(await ensureSession()))throw{code:"offline"};const j=await api("join_league",{code:c});U.lg.code=j.code;U.tab="l";U.open=null;layer("");render();loadBoards();
    toast(j.already?"Tu es déjà dans cette guilde.":`${ic("group")} Bienvenue dans « ${esc(j.name)} » !`,"win")}
  catch(e){toast(LGERR[e.code]||"Impossible de rejoindre la guilde pour l’instant.","bad")}}

/* ---------- défis du jour ----------
   3 défis par jour (les mêmes pour tout le monde, tirés de la date) : un facile, un moyen, un difficile.
   Progression calculée à partir des paris du jour : rien à tricher, rien à perdre si on ne joue pas. */
function defisToday(){return defisFor(today())}
function defisState(){if(!S.dch||S.dch.d!==today())S.dch={d:today(),got:[],seen:[],all:false};
  // pari gagné compté pour aujourd'hui : son dernier match a commencé aujourd'hui, ou hier à partir de 18 h (fini tard le soir) — même règle que le serveur
  const t=today(),y=ymd(Date.now()-DAY),P=S.bets.filter(b=>ymd(b.at)===t),W=S.bets.filter(b=>{if(b.st!=="won")return false;const lt=Math.max(...b.legs.map(L=>L.t||0));if(!lt)return false;const d=ymd(lt);return d===t||(d===y&&new Date(lt).getHours()>=18)});
  const mul=WE().on&&WE().k==="defis"?2:1;
  return defisToday().map(d=>({...d,r:d.r*mul,n:Math.min(d.g,d.f(P,W)),got:S.dch.got.includes(d.id)}))}
const defiBonus=()=>DEFI_BONUS*(WE().on&&WE().k==="defis"?2:1);
function defisCard(){const D=defisState(),done=D.filter(d=>d.got).length;
  if(S.dch.all)return`<div class="dcard done">${ic("trophy")}<span>Défis du jour terminés · reviens demain pour 3 nouveaux défis</span></div>`;
  return`<div class="dcard"><div class="dh"><b>${ic("target")} Défis du jour</b><span>${WE().on&&WE().k==="defis"?"🎯 ×2 · ":""}${done}/3 · tous : +${defiBonus()}</span></div>
  ${D.map(d=>`<div class="drow${d.got?" ok":""}"${d.got?"":` data-act="defigo" data-id="${d.id}" role="button"`}><span class="dic">${ic(d.ic,d.cls||"")}</span><div><b>${esc(d.t)}</b><div class="dbar"><i style="width:${d.n/d.g*100}%"></i></div></div>
    ${d.got?`<span class="dgot">✓</span>`:d.n>=d.g?`<button class="btn gold${(S.dch.wait||[]).includes(d.id)?" dwait":""}" data-act="defi" data-id="${d.id}">${(S.dch.wait||[]).includes(d.id)?"⏳ Réessayer":"+"+d.r}</button>`:`<span class="drw">${d.n}/${d.g} · +${d.r}</span>`}</div>`).join("")}
  ${done===3?`<button class="btn gold wide" data-act="defiall" style="margin-top:8px">${ic("gift")} Bonus des 3 défis : +${defiBonus()}</button>`:""}</div>`}
// toucher un défi emmène au bon endroit
function defiGo(id){const goSp=sp=>{U.ev=null;U.sp=sp;U.lv=-1;U.tab="m";render();const o=[...document.querySelectorAll("#main .mc")].find(x=>x.offsetParent);if(o)o.scrollIntoView({block:"center",behavior:"smooth"})};
  const firstFoot=()=>matchesFor("foot",-1).filter(m=>m.src==="espn"&&status(m)==="pre").sort((a,b)=>a.t-b.t)[0];
  const openM=(hint)=>{const m=firstFoot();if(m){U.tab="m";render();openDetail(m.id);toast(hint)}else{goSp("foot");toast("Pas de match de foot à venir pour l’instant.")}};
  if(["card","wcard"].includes(id))return openM("Descends jusqu’aux paris « Cartons » de ce match (ou choisis-en un autre).");
  if(id==="corn")return openM("Descends jusqu’aux paris « Corners » de ce match (ou choisis-en un autre).");
  if(["bt1","wbt"].includes(id))return openM("Descends jusqu’à « Buteur » et choisis un joueur.");
  if(id==="bb")return openM("Ajoute 2 paris de ce même match à ton ticket, puis choisis « Combiné ».");
  if(id==="rug"){goSp("rugby");return toast("Matchs de rugby : touche une cote.")}
  if(id==="ten"){goSp("tennis");return toast("Matchs de tennis : touche une cote.")}
  if(id==="live"){const L=["foot","rugby","basket","tennis"].flatMap(sp=>matchesFor(sp,-1)).find(m=>status(m)==="live"&&liveOK(m));
    if(L){U.tab="m";render();openDetail(L.id);return toast("Ce match est en direct, les paris sont ouverts : touche une cote.")}goSp("foot");return toast("Aucun match de foot ou de rugby en cours pour l’instant. Reviens pendant un match : les paris restent ouverts jusqu’à la 85e (foot) ou la 72e (rugby).")}
  if(id==="3sp"){goSp(U.sp);return toast("Parie sur 3 sports différents : change de sport avec les cartes en haut.")}
  if(["cb3","wcb"].includes(id)){goSp("foot");return toast("Mets au moins "+(id==="cb3"?"3":"2")+" pronostics dans ton ticket, puis choisis « Combiné ».")}
  goSp(U.sp);toast(id==="o25"?"Choisis une cote de 2,50 ou plus.":"Choisis un match et touche une cote.")}
let defBusy={};
async function claimDefi(id){const D=defisState(),d=D.find(x=>x.id===id);if(!d||d.got||d.n<d.g||defBusy[id])return;
  defBusy[id]=1;document.querySelectorAll(`[data-act=defi][data-id="${id}"]`).forEach(b=>{b.disabled=true;b.textContent="⏳"});
  let j;try{j=await api("defi_claim",{id})}catch(e){defBusy[id]=0;render();toast("Pas de connexion : réessaie dans un instant.","bad");return}
  defBusy[id]=0;
  if(j.error==="not_done"){S.dch.wait=S.dch.wait||[];if(!S.dch.wait.includes(id))S.dch.wait.push(id);save();render();
    toast("Le serveur ne voit pas encore ce défi comme réussi : seuls les paris faits avec la dernière version comptent, et un pari gagné est vérifié dans les 10 minutes. Réessaie un peu plus tard.");return}
  if(S.dch.wait)S.dch.wait=S.dch.wait.filter(x=>x!==id);
  if(!S.dch.got.includes(id))S.dch.got.push(id);if(j.ok){S.bal+=j.v;S.peak=Math.max(S.peak,S.bal);toast(`${ic("target")} Défi réussi : +${j.v} jetons`,"win");bump()}save();render()}
async function claimAll(){const D=defisState();if(S.dch.all||D.some(d=>!d.got))return;let j;try{j=await api("defi_claim",{all:true})}catch(e){toast("Pas de connexion : réessaie dans un instant.","bad");return}
  if(j.error==="not_done"){toast("Le serveur n’a pas encore validé tous tes défis. Réessaie un peu plus tard.");return}
  S.dch.all=true;if(!j.ok){save();render();return}S.bal+=j.v;S.peak=Math.max(S.peak,S.bal);save();render();bump();confetti();
  toast(`${ic("gift")} Les 3 défis du jour : +${tok(j.v)} jetons !`,"win")}
function checkDefis(){const D=defisState();for(const d of D)if(d.n>=d.g&&!d.got&&!S.dch.seen.includes(d.id)){S.dch.seen.push(d.id);saveLocal();
  toast(`${ic("target")} Défi réussi : « ${esc(d.t)} ». Récupère +${d.r} dans l’onglet Matchs.`,"win")}}

/* ---------- roue de la chance ----------
   8 cases, chacune exactement 1 chance sur 8 : tirage uniforme avec le générateur
   aléatoire cryptographique du navigateur (rejet des valeurs biaisées). */
// chances en % (de plus en plus faibles) ; taille des cases en % du tour : elles rapetissent un peu à chaque palier (le jackpot = la plus petite), la vraie chance est écrite dessus
const WD=[16,15,14,13,12,11,9,6],JD=4,WCOL=["#35d07f","#ffd23f","#ff7a45","#5fa8ff","#d7f25a","#c084fc","#ff5a5f","#f8fafc"];
function fairIndex(n){const a=new Uint32Array(1),lim=Math.floor(4294967296/n)*n;do{crypto.getRandomValues(a)}while(a[0]>=lim);return a[0]%n}
// cases de taille dégressive + la case JACKPOT tirée à part (1 chance sur 10 millions)
const JW=JD*3.6,WSPAN=360-JW;
const WA=(()=>{let a=0;return WD.map(p=>{const w=p*3.6,r=[a,a+w];a+=w;return r})})();   // [début, fin] en degrés
const wCenter=i=>i<0?WSPAN+JW/2:(WA[i][0]+WA[i][1])/2;
function wheelPick(){const r=fairIndex(100);let c=0;for(let i=0;i<WP.length;i++){c+=WP[i];if(r<c)return i}return 0}
// cases texturées (images) : "d" = texte foncé, "l" = texte clair
const WTEX=["l","d","l","l","d","l","l","d"],WFIT=[0,3,4,6,7];   // WFIT : texture entière dans la case (reflets des bords visibles)
function wheelSvg(){const n=WHEEL.length,R=140,c=150,pt=d=>{const r=(d-90)*Math.PI/180;return(c+R*Math.cos(r)).toFixed(2)+" "+(c+R*Math.sin(r)).toFixed(2)};
  const j0=WSPAN,j1=360;
  return`<svg viewBox="0 0 300 300" class="wheel" id="wheel" aria-hidden="true"><defs><radialGradient id="wgl" cx="150" cy="150" r="140" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#000" stop-opacity=".25"/><stop offset=".35" stop-color="#000" stop-opacity="0"/><stop offset=".78" stop-color="#fff" stop-opacity="0"/><stop offset=".93" stop-color="#fff" stop-opacity=".22"/><stop offset=".985" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity=".1"/></radialGradient><linearGradient id="wsh" x1="0" y1="0" x2="1" y2="1"><stop offset=".25" stop-color="#fff" stop-opacity="0"/><stop offset=".45" stop-color="#fff" stop-opacity=".28"/><stop offset=".55" stop-color="#fff" stop-opacity="0"/></linearGradient><linearGradient id="jg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff3b0"/><stop offset=".5" stop-color="#ffd23f"/><stop offset="1" stop-color="#b8860b"/></linearGradient></defs>
    ${WTEX.map((on,i)=>!on?"":WFIT.includes(i)?`<pattern id="wt${i}" patternContentUnits="objectBoundingBox" width="1" height="1"><image href="img/w${i}.webp?v=2" width="1" height="1" preserveAspectRatio="none"/></pattern>`:`<pattern id="wt${i}" patternUnits="userSpaceOnUse" width="300" height="300"><image href="img/w${i}.webp?v=2" width="300" height="300" preserveAspectRatio="xMidYMid slice"/></pattern>`).join("")}
    ${WHEEL.map((v,i)=>{const [a0,a1]=WA[i],w=a1-a0,mid=(a0+a1)/2,dark=WTEX[i]?WTEX[i]==="d":lum(WCOL[i])>.55,col=dark?"#0a110f":"#fff",big=w>=38;
    return`<g class="wseg" data-i="${i}"><path d="M150 150L${pt(a0)}A${R} ${R} 0 ${w>180?1:0} 1 ${pt(a1)}Z" fill="${WTEX[i]?`url(#wt${i})`:WCOL[i]}" stroke="#0a110f" stroke-width="3"/><path d="M150 150L${pt(a0)}A${R} ${R} 0 ${w>180?1:0} 1 ${pt(a1)}Z" fill="url(#wgl)"/><path d="M150 150L${pt(a0)}A${R} ${R} 0 ${w>180?1:0} 1 ${pt(a1)}Z" fill="url(#wsh)"/>
    <g transform="rotate(${mid} 150 150)">${big?`<text x="150" y="50" text-anchor="middle" font-family="Barlow Condensed,sans-serif" font-weight="800" font-size="30" fill="${col}">${v}</text>
    <text x="150" y="68" text-anchor="middle" font-family="Barlow,sans-serif" font-weight="700" font-size="11" fill="${col}" opacity=".75">JETONS</text>
    <text x="150" y="86" text-anchor="middle" font-family="Barlow,sans-serif" font-weight="800" font-size="12" fill="${col}">${WP[i]} %</text>`
    :`<text x="150" y="44" text-anchor="middle" font-family="Barlow Condensed,sans-serif" font-weight="800" font-size="${w>=28?26:22}" fill="${col}">${v}</text>
    <text x="150" y="60" text-anchor="middle" font-family="Barlow,sans-serif" font-weight="800" font-size="10.5" fill="${col}" opacity=".9">${WP[i]} %</text>`}</g></g>`}).join("")}
    <pattern id="wtj" patternContentUnits="objectBoundingBox" width="1" height="1"><image href="img/wj.webp?v=1" width="1" height="1" preserveAspectRatio="none"/></pattern>
    <path d="M150 150L${pt(j0)}A${R} ${R} 0 0 1 ${pt(j1)}Z" fill="url(#wtj)" stroke="#0a110f" stroke-width="1.5"/>
    <g transform="rotate(${(j0+j1)/2} 150 150)"><text transform="translate(150 50) rotate(-90)" text-anchor="middle" dominant-baseline="central" font-family="Barlow Condensed,sans-serif" font-weight="800" font-size="14" fill="#2a1a00" letter-spacing=".3">1 000 000</text></g>
</svg>`}
function wheelMini(){return`<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">${WCOL.map((col,i)=>{const a0=(i*45-112.5)*Math.PI/180,a1=a0+Math.PI/4;
  return`<path d="M12 12L${(12+11*Math.cos(a0)).toFixed(2)} ${(12+11*Math.sin(a0)).toFixed(2)}A11 11 0 0 1 ${(12+11*Math.cos(a1)).toFixed(2)} ${(12+11*Math.sin(a1)).toFixed(2)}Z" fill="${col}"/>`}).join("")}<circle cx="12" cy="12" r="11" fill="none" stroke="#2a1d00" stroke-width="1.5"/><circle cx="12" cy="12" r="3" fill="#2a1d00"/></svg>`}
function nextReset(){const d=new Date();d.setHours(24,0,0,0);const m=Math.round((d-Date.now())/6e4);return(m>=60?Math.floor(m/60)+" h "+String(m%60).padStart(2,"0"):m+" min")}
// tour bonus offert à tout le monde, une seule journée (en plus du tour quotidien)
const extraAvail=()=>today()===EXTRA_DAY&&S.bonus===today()&&S.extraSpin!==today();
const wheelAvail=()=>S.bonus!==today()||extraAvail();
function openWheel(){U.wheelOk=false;U.open="wheel";layer(viewWheel());const ok=()=>{if(U.wheelOk)return;U.wheelOk=true;if(U.open==="wheel"&&!spinning)layer(viewWheel())};syncNow().finally(ok);setTimeout(ok,4000)}
// à l'ouverture de l'appli : la roue s'affiche d'elle-même quand un tour est dispo (une fois par jour, si rien d'autre n'est ouvert)
function autoWheel(){if(window.__gate||GATE||!S.name||S.tosV!==TOS_V||S.introSeen!==INTRO_V||U.coach||!wheelAvail())return;
  const k=today()+(extraAvail()?"x":"");if(S.wheelAuto===k)return;
  setTimeout(()=>{if(U.open||!wheelAvail()||S.wheelAuto===k)return;S.wheelAuto=k;saveLocal();openWheel()},1500)}
document.addEventListener("visibilitychange",()=>{if(!document.hidden)autoWheel()});
// réveil du serveur (publications programmées, règlement des paris, notifications de but) : les tâches GitHub sont souvent en retard,
// donc chaque appli ouverte le réveille aussi, au plus une fois par minute pour tout le monde (le serveur filtre)
function wakeServer(){if(document.hidden)return;try{fetch(API+"?cron=1&slot=tick",{keepalive:true}).catch(()=>{})}catch(e){}}
setTimeout(wakeServer,8000);setInterval(wakeServer,5*6e4);document.addEventListener("visibilitychange",()=>{if(!document.hidden)setTimeout(wakeServer,3000)});
function viewWheel(){const done=!wheelAvail();
  return`<div class="grab"><h3>Roue de la chance</h3><button class="x" data-act="close" aria-label="Fermer">${ic("x")}</button></div>
  ${WE().on&&WE().k==="roue"?`<div class="webox mini"><span class="wee">🎡</span><div><b>Week-end de la roue</b><p>Ton gain sera doublé (×2) !</p></div></div>`:""}
  <div class="wheelbox"><div class="pointer"></div><svg class="wptr" id="wptr" viewBox="0 0 60 80" aria-hidden="true"><defs><linearGradient id="pg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff6c0"/><stop offset=".45" stop-color="#ffcf3a"/><stop offset="1" stop-color="#9a6a00"/></linearGradient><radialGradient id="pe" cx=".35" cy=".35"><stop offset="0" stop-color="#9dffc8"/><stop offset=".5" stop-color="#1fc46a"/><stop offset="1" stop-color="#0a5c30"/></radialGradient></defs><path d="M30 78 L6 22 A24 24 0 1 1 54 22 Z" fill="url(#pg)" stroke="#6b4a00" stroke-width="2"/><path d="M30 70 L12 24 A18 18 0 1 1 48 24 Z" fill="none" stroke="#fff3b0" stroke-width="1.5" opacity=".6"/><circle cx="30" cy="24" r="11" fill="url(#pe)" stroke="#ffe27a" stroke-width="2.5"/><circle cx="26" cy="20" r="3" fill="#fff" opacity=".8"/></svg>${wheelSvg()}<img class="wring" src="roue-anneau.webp?v=1" alt=""><img class="whub" src="roue-centre.webp?v=1" alt=""></div>
  <div id="wres" class="wres">${done&&S.wheel&&S.wheel.d===today()?`Aujourd’hui : <b>+${tok(S.wheel.v)} jetons</b>`:extraAvail()?"🎁 Tour bonus offert à tout le monde aujourd’hui !":"Un tour gratuit par jour"}</div>
  <button class="btn gold wide" data-act="spin" id="spin" ${done||U.wheelOk===false?"disabled":""}>${done?"Prochain tour dans "+nextReset():U.wheelOk===false?"Un instant…":extraAvail()?"Lancer le tour bonus":"Lancer la roue"}</button>
  <div class="info">${ic("info")}<span><b style="color:var(--ink)">100 % hasard.</b> Plus le gain est gros, plus il est rare : ${WHEEL.map((v,i)=>`<b style="color:var(--ink)">${v}</b> ${WP[i]} %`).join(" · ")}. Les cases rapetissent avec le gain ; la vraie chance est écrite sur chacune. Les jetons de la roue <b style="color:var(--ink)">ne comptent pas</b> dans les classements. La fine case dorée <b style="color:var(--sel)">JACKPOT 1 000 000</b> est tirée à part : <b style="color:var(--ink)">1 chance sur 10 millions</b> à chaque tour. Le tirage utilise le générateur aléatoire sécurisé du téléphone, sans aucun réglage caché.</span></div>`}
let spinning=false;
async function spin(){if(spinning||!wheelAvail()||U.wheelOk===false)return;spinning=true;wSound("tick");
  const b0=$("#spin");if(b0){b0.disabled=true;b0.textContent="Tirage…"}
  // le tirage est fait par le serveur (impossible à rejouer ou à truquer depuis le téléphone)
  let j;try{j=await api("wheel_spin",{})}catch(e){j={error:"offline"}}
  if(!j.ok){spinning=false;if(j.error==="done"){S.bonus=today();saveLocal();if(U.open==="wheel")layer(viewWheel());toast("Tu as déjà tourné la roue aujourd’hui.");render()}
    else{if(b0){b0.disabled=false;b0.textContent="Lancer la roue"}toast("Pas de connexion : réessaie dans un instant.","bad")}return}
  const jack=j.jack,i=j.i,v=j.v;
  gAt=0;if(j.extra)S.extraSpin=j.day;else S.bonus=j.day;S.wheel={d:today(),v};wGotMark(j.day+(j.extra?"x":""));S.bal+=v;S.peak=Math.max(S.peak,S.bal);if(jack)S.jackpot=(S.jackpot||0)+1;save();
  const w=$("#wheel"),b=$("#spin"),jit=(Math.random()-.5)*(jack?JW:WA[i][1]-WA[i][0])*.7,deg=360*7-wCenter(i)+jit;
  if(b){b.disabled=true;b.textContent="Ça tourne…"}
  const end=()=>{spinning=false;$("#bal").textContent=tok(S.bal);bump();
    if($("#wres"))$("#wres").innerHTML=`Gagné : <b>+${tok(v)} jetons</b>`;if($("#spin")){if(extraAvail()){$("#spin").disabled=false;$("#spin").textContent="Lancer le tour bonus"}else $("#spin").textContent="Prochain tour dans "+nextReset()}
    if(jack){toast(`💰 JACKPOT ! +1 000 000 jetons ! Une chance sur 10 millions…`,"win");confetti();setTimeout(confetti,900);setTimeout(confetti,1800)}
    else{toast(`${wheelMini()} +${tok(v)} jetons ! ${extraAvail()?"Et tu as encore un tour bonus aujourd’hui !":"À demain pour un nouveau tour."}`,"win");if(v>=200)confetti()}if(!U.open)render()};
  if(!w||matchMedia("(prefers-reduced-motion: reduce)").matches){end();return}
  w.style.transition="none";w.style.transform="rotate(0deg)";void w.getBoundingClientRect();
  w.style.transition="transform 5.2s cubic-bezier(.12,.75,.12,1)";requestAnimationFrame(()=>{w.style.transform=`rotate(${deg}deg)`});wheelTrack(w,5400);setTimeout(end,5400)}
// pendant le tour : la case sous la flèche grossit et s'illumine, la flèche « claque » à chaque case
// bruitages de la roue (fabriqués à la volée, rien à télécharger) ; coupés si le son est désactivé dans les réglages
let WAC=null;function wSound(k){if(S.mute)return;try{WAC=WAC||new (window.AudioContext||window.webkitAudioContext)();if(WAC.state==="suspended")WAC.resume();const t=WAC.currentTime,o=(f,d,type,g,at=0)=>{const x=WAC.createOscillator(),v=WAC.createGain();x.type=type;x.frequency.setValueAtTime(f,t+at);v.gain.setValueAtTime(0,t+at);v.gain.linearRampToValueAtTime(g,t+at+.005);v.gain.exponentialRampToValueAtTime(.0001,t+at+d);x.connect(v).connect(WAC.destination);x.start(t+at);x.stop(t+at+d+.02)};
  if(k==="tick"){o(1900,.035,"square",.05);o(950,.05,"triangle",.06)}
  else{const notes=k==="jack"?[523,659,784,1047,1319,1568]:k==="big"?[523,659,784,1047]:[659,880,1175];notes.forEach((n,j)=>o(n,.35,"triangle",.12,j*.09));if(k!=="win")o(2093,.6,"sine",.06,notes.length*.09)}}catch(e){}}
function wheelTrack(w,ms){const segs=[...w.querySelectorAll(".wseg")],P=$("#wptr"),t0=performance.now();let last=-2;
  const f=()=>{const m=getComputedStyle(w).transform;let a=0;if(m&&m!=="none"){const v=m.match(/matrix\(([^)]+)\)/);if(v){const[c,s2]=v[1].split(",").map(Number);a=Math.atan2(s2,c)*180/Math.PI}}
    const at=((360-a)%360+360)%360;let i=WA.findIndex(([x,y])=>at>=x&&at<y);
    if(i!==last){segs.forEach((g,k)=>g.classList.toggle("hot",k===i));if(last!==-2)wSound("tick");last=i;if(P){P.classList.remove("tk");void P.getBoundingClientRect();P.classList.add("tk")}try{navigator.vibrate&&navigator.vibrate(4)}catch(e){}}
    if(performance.now()-t0<ms+200)requestAnimationFrame(f);else{segs.forEach((g,k)=>g.classList.toggle("win",k===i));wSound(i<0?"jack":WHEEL[i]>=200?"big":"win")}};
  requestAnimationFrame(f)}

/* ---------- accueil ---------- */
function viewWelcome(rename,msg){return`<div class="welcome">${rename?`<div class="grab"><h3>Ton pseudo</h3><button class="x" data-act="close">${ic("x")}</button></div>${msg?`<p class="warn" style="text-align:left">${msg}</p>`:""}`:`
  
  <img src="logo-tribune.png?v=2" alt="Tribune" class="wlogo"><p class="note" style="font-size:15px">Parie gratuitement sur les vrais matchs de foot, de rugby, de tennis et de NBA, en direct. Monte de niveau, de Spectateur à Légende.</p>
  <div class="feat"><div>${ic("card","yc")}Cartons, corners, hors-jeux</div><div>${ic("posts")}Essais, pénalités ratées</div><div>${ic("broken")}Doubles fautes, raquettes cassées</div></div>`}
  ${!S.name?`<div id="wref"></div><details class="wrefc"><summary>🎁 J’ai un code de parrainage</summary><div class="form"><input id="w-ref" maxlength="8" placeholder="ex. BLVUEY" autocapitalize="characters" autocomplete="off" value="${esc(refStored())}"></div></details>`:""}
  <div class="form" style="text-align:left"><label>Ton pseudo<input id="w-name" maxlength="18" value="${esc(S.name)}" placeholder="ex. Le Pronostiqueur" autocomplete="nickname"></label>
  <p class="warn" id="w-err" hidden></p>
  ${rename?"":`<label class="agechk"><input type="checkbox" id="w-age"><span>J’ai <b>18 ans ou plus</b> et j’accepte les <button class="link" data-act="wlegal" style="padding:0">règles du jeu et la politique de confidentialité</button>.</span></label><div id="w-legal" hidden></div>`}
  <button class="btn gold wide" data-act="wgo">${rename?"Enregistrer":"C’est parti !"}</button></div>
  ${rename?"":STANDALONE?`<div class="info" style="text-align:left;margin-top:14px">${ic("info")}<span><b style="color:var(--ink)">Tu as déjà un compte ?</b> Nouveau téléphone, appli réinstallée… entre ton code de compte et tu retrouves tout.<br><button class="btn ghost" data-act="xfer" style="margin-top:8px">Entrer mon code</button></span></div>`
    :`<button class="link" data-act="xfer" style="margin-top:10px">J’ai déjà un compte (code de compte)</button>`}
  ${rename?"":`<p class="note" style="margin-top:12px">Jetons fictifs, aucun argent réel. Jeu réservé au divertissement.</p>`}</div>`}
async function welcomeGo(){const inp=$("#w-name"),n=(inp.value||"").replace(/\s+/g," ").trim().slice(0,18),err=$("#w-err"),b=$("[data-act=wgo]");
  if(!n){inp.focus();return}const first=!S.name;
  if(first&&!($("#w-age")&&$("#w-age").checked)){err.hidden=false;err.textContent="Coche la case : Tribune est réservé aux 18 ans et plus.";return}b.disabled=true;err.hidden=true;
  const bad=()=>{err.hidden=false;err.textContent=`« ${n} » n’est pas accepté. Choisis un pseudo correct.`;b.disabled=false;inp.focus();inp.select()};
  const taken=()=>{err.hidden=false;err.textContent=`« ${n} » est déjà pris. Choisis un autre pseudo.`;b.disabled=false;inp.focus();inp.select()};
  if(first&&!S.tok&&!S.bets.length&&S.starter!=="done"){S.bal=0;S.peak=Math.max(0,S.peak);S.starter="pending"}
  try{if(first||!S.tok){const rIn=$("#w-ref"),rv=rIn&&rIn.value.trim()?rIn.value.toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,8):refStored();const j=await api("session",{name:n,bal:S.bal,peak:S.peak,ref:rv,...myStats()});S.tok=j.token;S.pid=j.id;refDone(j)}
    else{const j=await api("sync",{name:n,bal:S.bal,peak:S.peak,...myStats()});if(j.name_taken){taken();return}if(j.name_bad){bad();return}}}
  catch(e){if(e.code==="name_taken"){taken();return}if(e.code==="name_bad"){bad();return}}   // hors connexion : on accepte, la vérification se fera plus tard
  if(first)S.tosV=TOS_V;S.name=n;askedName=false;save();U.open=null;layer("");render();
  if(first){setTimeout(joinFromLink,400);setTimeout(()=>{if(S.introSeen!==INTRO_V)openIntro();else grantStarter(false)},900)}else toast("Pseudo enregistré.","win")}

/* ---------- installer l'app / changer d'appareil ---------- */
const UA=navigator.userAgent,STANDALONE=matchMedia("(display-mode: standalone)").matches||navigator.standalone===true;
const IOS=/iphone|ipad|ipod/i.test(UA)||(navigator.platform==="MacIntel"&&navigator.maxTouchPoints>1),ANDROID=/android/i.test(UA),INAPP=ANDROID&&/; wv\)|FBAN|FBAV|Instagram|Snapchat|Line\/|MicroMessenger|GSA\//i.test(UA);
const IOS_SAFARI=IOS&&!/CriOS|FxiOS|EdgiOS|OPiOS|GSA\/|Instagram|FBAN|FBAV|Snapchat/i.test(UA);
let installEvt=null;
addEventListener("beforeinstallprompt",e=>{e.preventDefault();installEvt=e;if(GATE){renderGate();return}if(U.tab==="m"&&!U.open)render();if(U.open==="install")layer(viewInstall())});
addEventListener("appinstalled",()=>{installEvt=null;try{localStorage.setItem("dap.inst",String(Date.now()))}catch(e){}});
function installBanner(){if(STANDALONE||!(IOS||ANDROID))return"";let x=0;try{x=+localStorage.getItem("dap.inst")||0}catch(e){}if(Date.now()-x<3*DAY)return"";
  return`<div class="instb"><span class="ii"><img src="icon-180.png" alt=""></span><div><b>Installe l’app sur ton téléphone</b><small>En 2 étapes, sans passer par un store.</small></div>
    <button class="btn" data-act="install">Comment&nbsp;?</button><button class="x" data-act="instx" aria-label="Plus tard">${ic("x")}</button></div>`}
const SHARE_IOS=`<svg class="i" viewBox="0 0 24 24" style="color:#5fa8ff"><path d="M12 15V3M7.5 7.5L12 3l4.5 4.5"/><path d="M6 10.5H5a1 1 0 0 0-1 1V20a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8.5a1 1 0 0 0-1-1h-1"/></svg>`;
const ADD_IOS=`<svg class="i" viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="M12 8v8M8 12h8"/></svg>`;
// lien complet à rouvrir dans Safari / Chrome (on garde le parrainage et le ticket partagé : le navigateur intégré d'Instagram ne partage rien avec Safari)
function shareableUrl(){const q=new URLSearchParams();const r=refStored();if(r)q.set("parrain",r);const pc=U.pariNow?getTmp("dap.pari",30):"";if(pc)q.set("pari",pc);
  const lg=new URLSearchParams(location.search).get("guilde");if(lg)q.set("guilde",lg);return location.origin+location.pathname+(q.toString()?"?"+q:"")}
const INAPP_NAME=/Instagram/i.test(UA)?"Instagram":/FBAN|FBAV|FB_IAB/i.test(UA)?"Facebook":/Snapchat/i.test(UA)?"Snapchat":/TikTok|musical_ly|Bytedance/i.test(UA)?"TikTok":/LinkedInApp/i.test(UA)?"LinkedIn":/Line\//i.test(UA)?"Line":/GSA\//i.test(UA)?"Google":"";
function viewInstall(gate){const head=gate?"":`<div class="grab"><h3>Installer l’app</h3><button class="x" data-act="close" aria-label="Fermer">${ic("x")}</button></div>`;
  const P=U.plat||(ANDROID?"android":"ios");
  const pick=`<div class="platpick"><small>Ton téléphone</small><div><button data-act="plat" data-v="ios" aria-pressed="${P==="ios"}">🍏 iPhone</button><button data-act="plat" data-v="android" aria-pressed="${P==="android"}">🤖 Android</button></div></div>`;
  if(P==="ios"){const url=shareableUrl(),inApp=IOS&&!IOS_SAFARI,app=INAPP_NAME||"une autre appli";
    return head+pick+(inApp?`<div class="inappw"><b>⚠️ Tu es dans ${esc(app)}</b><p>Ici, l’installation ne marche pas : l’app s’installe <b>uniquement depuis Safari</b>.</p>
      ${INAPP_NAME==="Instagram"||INAPP_NAME==="Facebook"?`<ol class="iasteps"><li><span>1</span><div>Touche les <b class="dots">•••</b> tout en haut à droite</div></li><li><span>2</span><div>Choisis <b>Ouvrir dans le navigateur externe</b></div></li></ol>`:""}
      <a class="btn ghost wide" href="x-safari-${esc(url)}">🧭 Essayer d’ouvrir dans Safari</a>
      <p class="small">${INAPP_NAME==="Instagram"||INAPP_NAME==="Facebook"?"Ça ne marche pas ? Copie le lien et colle-le dans Safari :":`Rien ne se passe ? `+INAPP_NAME==="Instagram"?"Touche les <b>•••</b> en haut à droite, puis <b>Ouvrir dans le navigateur externe</b>.":INAPP_NAME==="Facebook"?"Touche les <b>•••</b> en haut à droite, puis <b>Ouvrir dans le navigateur externe</b>.":INAPP_NAME==="Snapchat"||INAPP_NAME==="TikTok"?"Touche les <b>•••</b> (ou la flèche de partage), puis <b>Ouvrir dans le navigateur</b>.":"Cherche le menu <b>•••</b> ou la boussole 🧭, puis <b>Ouvrir dans Safari</b>."+"<br>Ou copie le lien et colle-le dans Safari :"}</p>
      <button class="btn ghost wide" data-act="copylink">📋 Copier le lien</button></div><div class="grp">Ensuite, dans Safari</div>`
      :!IOS?`<p class="note" style="text-align:left">Sur iPhone, ouvre <b>${esc(url.replace(/^https:\/\//,""))}</b> dans <b>Safari</b> (pas dans Instagram, WhatsApp ou Chrome), puis :</p>`:"")+`
    <div class="instvid"><video src="media/install-iphone.mp4?v=3" poster="media/install-iphone.jpg?v=2" controls playsinline muted preload="none"></video><small>▶️ La démo en 15 secondes</small></div>
    <ol class="steps"><li><span class="n">1</span><div>Dans Safari, touche le bouton <b>Partager</b> ${SHARE_IOS}<small>Selon ta version d’iOS : dans la barre du bas, à côté de l’adresse, ou dans le menu <b>•••</b>.</small></div></li>
      <li><span class="n">2</span><div>Fais défiler et choisis <b>Sur l’écran d’accueil</b> ${ADD_IOS}.</div></li>
      <li class="stimp"><span class="n">3</span><div><b>Important :</b> vérifie que <b>« Ouvrir comme app web »</b> est bien <b>activé</b> <span class="iostg"></span>, puis touche <b>Ajouter</b>.<small>Sinon, Tribune s’ouvre comme un simple onglet Safari et le jeu ne marche pas.</small></div></li>
      <li><span class="n">4</span><div>Ouvre <b>Tribune</b> depuis ton écran d’accueil et choisis ton pseudo : <b>1 000 jetons</b> t’attendent.<small>Tu avais déjà un compte ? Touche « J’ai déjà un compte » et entre ton <b>code de compte</b> pour tout retrouver.</small></div></li></ol>
    <div class="xbox" id="xbox">${S.name&&S.tok?(S.rcode?`<div class="xcode"><small>Ton code de compte (il ne change jamais)</small><b>${esc(S.rcode)}</b></div><button class="btn ghost wide" data-act="copycode" data-code="${esc(S.rcode)}">Copier mon code</button>`:`<button class="btn gold wide" data-act="xmake">${ic("ticket")} Créer un code pour l’app</button>`):gate?`<p class="note">Nouveau joueur ? Pas besoin de code : tu choisiras ton pseudo dans l’app.</p>`:`<p class="note">Choisis d’abord un pseudo pour avoir un code.</p>`}</div>
`}
  if(ANDROID&&INAPP&&!installEvt){const u=shareableUrl().replace(/^https:\/\//,"");return head+pick+`<div class="inappw"><b>⚠️ Tu es dans ${esc(INAPP_NAME||"une autre appli")}</b><p>Ici, l’installation ne marche pas : ouvre le lien dans <b>Chrome</b>.</p>
      <a class="btn gold wide" href="intent://${esc(u)}#Intent;scheme=https;package=com.android.chrome;end">${ic("share")} Ouvrir dans Chrome</a>
      <p class="small">Si rien ne se passe : touche le menu <b>⋮</b> (ou <b>•••</b>) et choisis <b>Ouvrir dans Chrome</b> ou <b>Ouvrir dans le navigateur externe</b>.</p><button class="btn ghost wide" data-act="copylink">📋 Copier le lien</button></div>`}
  if(P==="android")return head+pick+(!ANDROID?`<p class="note" style="text-align:left">Sur Android, ouvre <b>${esc(shareableUrl().replace(/^https:\/\//,""))}</b> dans <b>Chrome</b>, puis :</p>`:"")+(installEvt&&ANDROID?`<p class="note" style="font-size:15px">Un appui suffit : l’app s’ajoute à ton écran d’accueil, avec ton compte.</p><button class="btn gold wide" data-act="instgo">${ic("plus")} Installer l’app</button><div class="instvid"><video src="media/install-android.mp4?v=1" poster="media/install-android.jpg?v=1" controls playsinline muted preload="none"></video><small>▶️ Sinon, la démo en 15 secondes</small></div>`
    :`<div class="instvid"><video src="media/install-android.mp4?v=1" poster="media/install-android.jpg?v=1" controls playsinline muted preload="none"></video><small>▶️ La démo en 15 secondes</small></div><ol class="steps"><li><span class="n">1</span><div>Dans Chrome, touche le menu <b>⋮</b> en haut à droite.</div></li>
      <li><span class="n">2</span><div>Choisis <b>Installer l’application</b> (ou <b>Ajouter à l’écran d’accueil</b>), puis confirme.</div></li>
      <li><span class="n">3</span><div>Ouvre <b>Tribune</b> depuis ton écran d’accueil : ton compte est déjà là.</div></li></ol>
      <p class="note">Pas d’option « Installer » ? Vérifie que tu es bien dans <b>Chrome</b> (pas dans WhatsApp, Messenger ou une autre appli). Sur Samsung Internet : menu <b>≡</b> › <b>Ajouter page à</b> › <b>Écran d’accueil</b>.</p>`);
  return head+`<p class="note">Ouvre ce site sur ton téléphone pour l’installer sur l’écran d’accueil.</p>`}
async function installPrompt(){if(!installEvt)return;installEvt.prompt();const r=await installEvt.userChoice.catch(()=>null);installEvt=null;
  if(GATE){renderGate();if(r&&r.outcome==="accepted")toast("App installée ! Ouvre-la depuis ton écran d’accueil.","win");return}
  if(r&&r.outcome==="accepted"){closeLayer();toast("App installée ! Retrouve-la sur ton écran d’accueil.","win")}else layer(viewInstall())}
// Sur téléphone, le jeu ne s'utilise que depuis l'app installée (écran d'accueil) : dans un navigateur,
// on n'affiche que la marche à suivre (et le code de transfert pour ceux qui jouaient déjà ici).
const GATE=!STANDALONE&&!matchMedia("(display-mode: fullscreen), (display-mode: minimal-ui)").matches&&(IOS||ANDROID);window.__gate=GATE;
function renderGate(){const lg=new URLSearchParams(location.search).get("guilde");const pc=U.pariNow?getTmp("dap.pari",30):"";const rc=refStored();
  const mc=U.matchNow?getTmp("dap.match",30):"";if(mc)setTimeout(async()=>{try{await api("match_mark",{m:mc})}catch(e){}const box=$("#gmatch");if(box)box.innerHTML=`<div class="gpgo">📲 <b>Tu as déjà l’app ?</b> Ouvre maintenant <b>Tribune</b> depuis ton écran d’accueil : <b>le match s’ouvrira tout seul</b> (dans les 20 minutes), prêt pour ton prono.</div><p class="note">Pas encore l’app ? Installe-la ci-dessous : le match t’attendra.</p>`},40);
  if(rc)setTimeout(async()=>{try{const j=await api("ref_info",{code:rc,mark:1});const box=$("#gref");if(box&&j.name)box.innerHTML=`<div class="refban">🎁 <span><b>${esc(j.name)} t’invite sur Tribune !</b><br>Installe l’app ci-dessous et crée ton compte : <b>+${tok(j.gets)} jetons de bienvenue</b> en plus des 1 000 de départ.</span></div>`}catch(e){}},30);
  if(pc)setTimeout(async()=>{try{const j=await api("shared_bet",{code:pc,mark:1});const box=$("#gpari");if(box)box.innerHTML=`<div class="gptk"><b>🎟️ Ticket de ${esc(j.name)}</b><small>${j.legs.length>1?"Combiné de "+j.legs.length:"Pari simple"} · cote ${fr(j.odds)}</small>
    ${j.legs.map(L=>`<div class="gpl"><span>${esc(L.l)}</span><b>${fr(L.o)}</b></div>`).join("")}</div>
    <div class="gpgo">📲 <b>Tu as déjà l’app ?</b> Ouvre maintenant <b>Tribune</b> depuis ton écran d’accueil : <b>le ticket s’ouvrira tout seul</b> (dans les 20 minutes), avec le bouton « Je suis ce pari ».</div>
    <p class="note">Pas encore l’app ? Installe-la ci-dessous : le ticket t’attendra.</p>`}catch(e){}},50);
  document.body.classList.add("gated");
  $("#main")._html=null;$("#main").innerHTML=`<div class="gate"><div class="ghero"><img src="img/gate.webp?v=2" alt="Tribune"></div><h1 class="glogo vh"><img src="logo-tribune.png?v=2" alt="Tribune"></h1><small style="color:var(--mute2)">v${VERSION}</small><p class="gsub">Le jeu se joue <b>uniquement depuis l’app</b> sur ton écran d’accueil. C’est gratuit, sans store, et ça prend 10 secondes.</p>
    <div id="gref"></div><div id="gmatch"></div>${pc?`<div id="gpari"><div class="skel" style="height:120px"></div></div>`:""}
    ${lg?`<div class="xcode" style="margin-bottom:12px"><small>Invitation à une guilde : une fois dans l’app, va dans Guildes › Rejoindre et entre ce code</small><b>${esc(lg.toUpperCase().slice(0,8))}</b></div>`:""}
    <div id="ginst">${viewInstall(true)}</div>
    <a class="igban gig" href="${IG_URL}" target="_blank" rel="noopener">${IG_ICON}<span><b>@tribune.pronos</b><small>Suis-nous sur Instagram</small></span><span class="arr">›</span></a>
    <a class="igban gig fbban" href="${FB_URL}" target="_blank" rel="noopener">${FB_ICON}<span><b>Tribune Pronos</b><small>Aime notre page Facebook 👍</small></span><span class="arr">›</span></a></div>`}
// Code de transfert : on envoie tout l'état du jeu (sauf le jeton) au serveur, valable 48 h
async function transferOut(){const box=$("#xbox");if(box)box.innerHTML=`<div class="skel" style="height:70px"></div>`;
  try{if(!(await ensureSession()))throw{code:"offline"};await syncNow();const st={...S};delete st.tok;delete st.pid;
    const j=await api("make_transfer",{state:st});
    const html=`<div class="xcode"><small>Ton code de transfert (valable 48 h, une seule fois)</small><b>${esc(j.code)}</b>
      <button class="btn ghost" data-act="copycode" data-code="${esc(j.code)}">Copier</button></div>
      <p class="note">Entre-le dans l’app installée ou sur ton autre téléphone. Une fois utilisé, ce navigateur-ci est déconnecté du compte.</p>`;
    if($("#xbox"))$("#xbox").innerHTML=html}
  catch(e){if($("#xbox"))$("#xbox").innerHTML=`<p class="warn">Pas de connexion au serveur, réessaie dans un instant.</p><button class="btn gold wide" data-act="xmake">Réessayer</button>`}}
function viewTransferIn(){return`<div class="grab"><h3>Récupérer mon compte</h3><button class="x" data-act="${S.name?"close":"xback"}" aria-label="Retour">${ic("x")}</button></div>
  <div class="form"><label>Ton code de compte<input id="x-code" maxlength="14" placeholder="ex. K7RZ-P3QA-M8XW" autocapitalize="characters" autocomplete="off" style="text-transform:uppercase;letter-spacing:4px;font-weight:800;text-align:center;font-size:22px"></label>
  <p class="warn" id="x-err" hidden></p><button class="btn gold wide" data-act="xferok">Récupérer mon compte</button>
  <p class="note">Ton code de compte est dans Carrière › « Mon code de compte » (12 caractères, il ne change jamais).${S.name?" Attention : ce que tu as sur cet appareil sera remplacé.":""}</p></div>`}
async function transferIn(){const code=($("#x-code").value||"").trim(),err=$("#x-err"),b=$("[data-act=xferok]");if(code.replace(/[^a-z0-9]/gi,"").length<8){$("#x-code").focus();return}
  b.disabled=true;err.hidden=true;
  try{const j=await api("use_transfer",{code});const st=j.state&&typeof j.state==="object"?j.state:{};
    if(j.state&&typeof j.state==="object")S=Object.assign({v:2,name:"",bal:1000,peak:1000,bonus:"",bets:[],org:[],orgMode:false,sim:false},st,{tok:j.token,pid:j.id,name:j.name});
    else Object.assign(S,{tok:j.token,pid:j.id,name:j.name,bal:j.bal,peak:Math.max(S.peak||0,j.peak)});   // pas de sauvegarde : on garde ce téléphone, avec le solde du serveur
    if(j.permanent){S.rcode=code.toUpperCase().replace(/[^A-Z0-9]/g,"").replace(/^(.{4})(.{4})(.{4})$/,"$1-$2-$3");delete S.rcodeOther}
    saveLocal();
    toast(`${ic("coin")} Compte récupéré : bon retour ${esc(j.name)} !`,"win");setTimeout(()=>location.reload(),900)}
  catch(e){b.disabled=false;err.hidden=false;err.textContent=e.code==="unknown"?"Code inconnu. Vérifie les 12 caractères de ton code de compte.":e.code==="slow_down"?"Trop d’essais : réessaie dans une heure.":"Pas de connexion au serveur."}}

/* ---------- pas de zoom (sauf pour recadrer la photo), écran en vertical ---------- */
(function(){const inCrop=e=>e.target&&e.target.closest&&e.target.closest("#crop");
  ["gesturestart","gesturechange","gestureend"].forEach(t=>document.addEventListener(t,e=>{if(!inCrop(e))e.preventDefault()},{passive:false}));
  document.addEventListener("touchmove",e=>{if(e.touches.length>1&&!inCrop(e))e.preventDefault()},{passive:false});
  try{screen.orientation&&screen.orientation.lock&&screen.orientation.lock("portrait").catch(()=>{})}catch(e){}})();

/* ---------- version ----------
   Numéro affiché à côté du titre. version.txt (même numéro) permet à une app restée ouverte
   de voir qu'une mise à jour est sortie et de proposer de recharger. */
const VERSION="3.13";
function showVersion(){const v=$("#ver");if(!v)return;v.textContent="v"+VERSION;let last="";try{last=localStorage.getItem("dap.ver")||""}catch(e){}
  if(last&&last!==VERSION){v.classList.add("new");toast(`Mise à jour installée : version ${VERSION}`,"win");setTimeout(()=>v.classList.remove("new"),6000)}
  try{localStorage.setItem("dap.ver",VERSION)}catch(e){}}
async function checkUpdate(){try{const r=await fetch("version.txt?t="+Date.now(),{cache:"no-store"});if(!r.ok)return;const v=(await r.text()).trim();if(!/^\d+\.\d{1,3}$/.test(v))return;   // hors connexion : le service worker peut renvoyer une page à la place
  if(v&&v!==VERSION&&!$(".upd")){const b=document.createElement("button");b.className="upd";b.innerHTML=`<span>Nouvelle version ${esc(v)} disponible</span><b>Recharger</b>`;
    b.onclick=()=>location.reload();document.body.appendChild(b)}}catch(e){}}
showVersion();checkUpdate();
document.addEventListener("visibilitychange",()=>{if(!document.hidden)checkUpdate()});setInterval(checkUpdate,5*6e4);

/* ---------- démarrage : écran de chargement le temps que tout soit prêt, puis tout s'affiche d'un coup ---------- */
function hideSplash(){const s=$("#splash");if(!s)return;s.classList.add("gone");setTimeout(()=>s.remove(),350)}
async function boot(){if(GATE||!S.name){hideSplash();setTimeout(afterBoot,300);return}
  const msg=["Chargement des matchs…","Les cotes du jour…","Ta guilde…","Presque prêt…"];let k=0;const mt=setInterval(()=>{const e=$("#spt");if(e)e.textContent=msg[Math.min(++k,msg.length-1)]},1300);
  const hit=await FEEDHIT;
  const jobs=[(async()=>{if(hit)return;for(let i=0;i<20&&!FIRST;i++)await new Promise(r=>setTimeout(r,20));await FIRST})(),loadEvents(),
    (async()=>{if(!(await ensureSession()))return;await Promise.allSettled([loadGuide(true),(async()=>{await loadBoards();const L0=U.lg.data&&U.lg.data.leagues[0];
      if(L0)await Promise.allSettled([loadProno(),loadLm(U.lg.code||L0.code)])})()])})()];
  await Promise.race([Promise.allSettled(jobs),new Promise(r=>setTimeout(r,hit?1200:6500))]);
  clearInterval(mt);U.lg.loading=false;render();hideSplash();setTimeout(afterBoot,400)}
refFromLink();pariFromLink();matchFromLink();setTimeout(igPopup,0);getTmp("dap.pari",30);getTmp("dap.ref",24*60);
// coincé dans le navigateur d'Instagram, Facebook… : on tente tout de suite de rouvrir le lien dans Safari ou Chrome (une seule fois)
// flèche vers le menu ••• d'Instagram / Facebook (seul moyen fiable de sortir sur iPhone)
function inAppArrow(){if(!GATE||!INAPP_NAME||document.querySelector(".iaarrow"))return;if(!(IOS&&!IOS_SAFARI)&&!(ANDROID&&INAPP))return;
  const d=document.createElement("div");d.className="iaarrow";d.innerHTML=`<svg viewBox="0 0 60 70" width="54" height="64"><path d="M10 64 C14 34 30 18 48 10" stroke="#ffd23f" stroke-width="5" fill="none" stroke-linecap="round"/><path d="M34 6 L50 9 L45 25" stroke="#ffd23f" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg><div>Touche <b>•••</b><br>puis <b>Ouvrir dans le navigateur externe</b></div>`;document.body.appendChild(d)}
(function escapeInApp(){const inIOS=IOS&&!IOS_SAFARI&&INAPP_NAME,inAnd=ANDROID&&INAPP;if(!GATE||!(inIOS||inAnd))return;
  try{if(sessionStorage.getItem("dap.esc"))return;sessionStorage.setItem("dap.esc","1")}catch(e){}
  const u=shareableUrl();setTimeout(()=>{location.href=inIOS?"x-safari-"+u:"intent://"+u.replace(/^https?:\/\//,"")+"#Intent;scheme=https;package=com.android.chrome;end"},350)})();
const FEEDHIT=GATE?Promise.resolve(false):feedLoadCache();
if(GATE){hideSplash();renderGate();inAppArrow()}else{
FEEDHIT.then(h=>{if(h&&(!U.open||U.open==="slip"))render()});
render();
if(!S.name){hideSplash();U.open="welcome";layer(viewWelcome(false));setTimeout(wrefFill,300)}else{syncSoon();joinFromLink()}
loadFeeds();boot();setTimeout(loadTv,1500);setInterval(loadTv,15*6e4);
setTimeout(()=>{if(S.dk&&Object.values(S.dk).some(x=>!x.settled))checkDarkAll()},5000);
goFrom(location.href);
function preloadArt(){const L=["roue-anneau.webp?v=1","roue-centre.webp?v=1",...WTEX.map((x,i)=>x?`img/w${i}.webp?v=2`:"").filter(Boolean),"img/wj.webp?v=1"];
  try{const T=CARD_T.find(x=>cardStats(S.bets||[],S.xp).note>=x[0]);if(T&&CARD_TEX[T[1]])L.push(CARD_TEX[T[1]])}catch(e){}
  if(S.cos&&S.cos.f&&/^f([1-9]|1[0-2])$/.test(S.cos.f))L.push(`fr/${S.cos.f}.webp?v=2`);
  if(S.cos&&S.cos.b&&BN_TEX[S.cos.b])L.push(`bn/${S.cos.b}.webp?v=1`);
  L.forEach((u,i)=>setTimeout(()=>{const im=new Image();im.decoding="async";im.src=u},i*60))}
var afterBoot=function(){setTimeout(preloadArt,1200);pushRefresh();if(S.introSeen===INTRO_V&&S.tosV===TOS_V){setTimeout(pariPending,600);setTimeout(pendingTicket,900);setTimeout(()=>matchPending(),1200)}if(S.name&&S.starter==="pending"&&S.introSeen===INTRO_V&&!U.coach)grantStarter(false);if(S.name&&S.tosV!==TOS_V)openTos();else if(S.name&&S.introSeen!==INTRO_V){openIntro();S.newsSeen=NEWS_V;saveLocal()}else if(S.name&&S.newsSeen!==NEWS_V)setTimeout(openNews,2500);if(S.name){claimPrizes();claimBattles();claimGifts();ensureRcode()}if(S.name)Promise.resolve().then(()=>{if(U.lg.data&&U.lg.data.leagues.length){const c0=U.lg.code;for(const l of U.lg.data.leagues){U.lg.code=l.code;loadChat()}U.lg.code=c0}});if(S.duel&&Object.values(S.duel).some(x=>!x.settled))loadDuels();autoWheel()};
setInterval(()=>{if(!document.hidden&&S.duel&&Object.values(S.duel).some(x=>!x.settled))loadDuels()},12e4);
// matchs en direct qui te concernent (regardé, parié, équipe de cœur) : leur compétition est rafraîchie toutes les 20 s pour les animations
setInterval(()=>{if(document.hidden)return;const hot=new Set([...REG.values()].filter(m=>m.src==="espn"&&m.state==="in"&&(m.sp==="foot"||m.sp==="rugby")&&fxMine(m)).map(m=>m.sp+"|"+m.lv));
  for(const k of hot){const[sp,lv]=k.split("|");const f=FEED[sp+lv];if(f&&f.at&&Date.now()-f.at>18e3&&!f.busy){f.busy=1;loadFeed(sp,+lv).then(()=>{if(!U.open)renderSoon();else if(U.open&&REG.get(U.open))openDetail(U.open,true);settle()})}}},20000);
// retour dans l'appli (déjà ouverte en arrière-plan) : on rafraîchit tout de suite les matchs en direct, sans attendre
document.addEventListener("visibilitychange",()=>{if(document.hidden)return;const now=Date.now(),keys=new Set();
  for(const m of REG.values())if(m.src==="espn"&&(m.state==="in"||(m.state==="pre"&&m.t<now)))keys.add(m.sp+"|"+m.lv);
  for(const k of keys){const[sp,lv]=k.split("|"),f=FEED[sp+lv];if(f&&!f.busy&&now-(f.at||0)>8e3){f.busy=1;loadFeed(sp,+lv).then(()=>{if(!U.open)render();else if(REG.get(U.open))openDetail(U.open,true);settle()})}}});
setInterval(()=>{if(document.hidden)return;
  const anyLive=[...REG.values()].some(m=>m.src==="espn"&&m.state==="in");const stale=Object.values(FEED).some(f=>f.at&&Date.now()-f.at>(anyLive?6e4:5*6e4));
  if(stale){for(const sp in SP)for(const lv in SP[sp].feeds)if(FEED[sp+lv]&&Date.now()-FEED[sp+lv].at>(anyLive?6e4:5*6e4))loadFeed(sp,+lv).then(()=>{if(!U.open)render();settle()})}
  else if(!U.open)render();
  settle()},30000);
settle();
}
if("serviceWorker"in navigator&&location.protocol==="https:")navigator.serviceWorker.register("sw.js").catch(()=>{});
