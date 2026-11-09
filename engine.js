// Tribune · moteur commun à l'appli et au serveur : sports et niveaux, simulation des matchs (cotes Monte-Carlo),
// types de paris, lecture du flux ESPN et règlement d'une sélection. Pas de DOM ici.
// Navigateur : script classique (les déclarations sont globales). Serveur : import "../engine.js" puis globalThis.ENGINE.
const fr=(n,d=2)=>n.toFixed(d).replace(".",",");
const cl=(x,a,b)=>Math.max(a,Math.min(b,x));
const H=36e5,DAY=864e5;
function hash(s){let h=2166136261;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)}return h>>>0}
function rng(seed){let a=seed>>>0;return()=>{a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
function pois(r,l){if(l<=0)return 0;const L=Math.exp(-l);let k=0,p=r();while(p>L){k++;p*=r()}return k}
function binom(r,n,p){let k=0;for(let i=0;i<n;i++)if(r()<p)k++;return k}
const SP={
  foot:{n:"Football",sub:"France · Europe",ic:"ball",c:"#35d07f",dur:115,
    lv:["Départementale 4","Départementale 3","Départementale 2","Départementale 1","Régional 3","Régional 2","Régional 1","National 3","National 2","National 1","Ligue 2","Ligue 1","Premier League","La Liga","Ligue des champions",
      "Coupe de France","Serie A","Bundesliga","Europa League","Conference League","Championship","Liga Portugal","Eredivisie","Pro League","Ligue des nations","Coupe du monde","Euro","JO (hommes)","JO (femmes)"],base:15,
    tiers:[["District",[0,1,2,3]],["Ligue régionale",[4,5,6]],["National",[7,8,9]],["Pro France",[10,11,15]],["Europe",[12,13,16,17,20,21,22,23]],["Coupes d’Europe",[14,18,19]],["Sélections",[24,25,26,27,28]]],dep:4,simMax:11,
    feeds:{10:["soccer/fra.2"],11:["soccer/fra.1"],12:["soccer/eng.1"],13:["soccer/esp.1"],14:["soccer/uefa.champions"],15:["soccer/fra.coupe_de_france"],16:["soccer/ita.1"],17:["soccer/ger.1"],
      18:["soccer/uefa.europa"],19:["soccer/uefa.europa.conf"],20:["soccer/eng.2"],21:["soccer/por.1"],22:["soccer/ned.1"],23:["soccer/bel.1"],24:["soccer/uefa.nations"],25:["soccer/fifa.world"],26:["soccer/uefa.euro"],27:["soccer/fifa.olympics"],28:["soccer/fifa.w.olympics"]}},
  rugby:{n:"Rugby",sub:"Top 14 · Tests",ic:"rugby",c:"#ff7a45",dur:100,
    lv:["Régionale 3","Régionale 2","Régionale 1","Fédérale 3","Fédérale 2","Fédérale 1","Nationale 2","Nationale","Pro D2","Top 14","Champions Cup","Premiership","URC","Six Nations","Tests internationaux","Coupe du monde"],base:11,
    tiers:[["Régional",[0,1,2]],["Fédéral",[3,4,5]],["National",[6,7]],["Pro",[8,9,10,11,12]],["International",[13,14,15]]],dep:3,simMax:9,
    feeds:{9:["rugby/270559"],10:["rugby/271937"],11:["rugby/267979"],12:["rugby/270557"],13:["rugby/180659"],14:["rugby/289234"],15:["rugby/164205"]}},
  tennis:{n:"Tennis",sub:"ATP · WTA",ic:"tennis",c:"#d7f25a",dur:120,
    lv:["Tournoi de club","Open départemental","Open régional","Open national","ITF World Tour","Challenger","ATP / WTA Tour"],
    base:7,tiers:[["Amateur",[0,1,2,3]],["Pro",[4,5,6]]],dep:2,simMax:5,
    feeds:{6:["tennis/atp","tennis/wta"]}},
  basket:{n:"Basket",sub:"NBA",ic:"basket",c:"#ff9f1c",dur:150,
    lv:["Loisir","Départemental","Régional","Nationale","Pro B","Betclic Élite","NBA","JO (hommes)","JO (femmes)"],
    base:7,tiers:[["Pro",[6]],["Jeux olympiques",[7,8]]],dep:2,simMax:5,
    feeds:{6:["basketball/nba"],7:["basketball/mens-olympics-basketball"],8:["basketball/womens-olympics-basketball"]}}
};
const MCC=new Map(),MKC=new Map(),ONE=new Map();   // caches des simulations et des marchés
/* ---------- simulateurs (un match = un tirage) ---------- */
const lvA=m=>1-cl(m.lv/(SP[m.sp].base-1),0,1);  // 1 = plus bas niveau amateur
const SIM={
  foot(r,m){const a=lvA(m),[x,y]=m.s,o={g:[0,0],sot:[0,0],co:[0,0],of:[0,0],fo:[0,0],yc:[0,0],rc:[0,0],pk:[0,0]};
    for(const p of [0,1]){const d=p?y-x:x-y,hm=p?-.12:.12,l=(1.3+.6*a)*Math.exp(.33*d+hm),g=pois(r,l);
      o.g[p]=g;o.sot[p]=g+pois(r,l*2.1);o.co[p]=pois(r,4.7*Math.exp(.2*d+hm/2));o.of[p]=pois(r,1.8+.5*a);
      o.fo[p]=pois(r,11+2*a-.4*d);o.yc[p]=pois(r,1.75+.8*a-.15*d);o.rc[p]=pois(r,.07+.09*a);o.pk[p]=pois(r,.12+.07*a)}
    return o},
  rugby(r,m){const a=lvA(m),[x,y]=m.s,o={pts:[0,0],tr:[0,0],cv:[0,0],pm:[0,0],px:[0,0],dr:[0,0],yc:[0,0],rc:[0,0]};
    for(const p of [0,1]){const d=(p?y-x:x-y)*.6,hm=p?-.09:.09,tr=pois(r,(2.3+1.3*a)*Math.exp(.38*d+hm)),cv=binom(r,tr,.74-.2*a),
      pa=pois(r,(3.4+.8*a)*Math.exp(.1*d)),pm=binom(r,pa,.8-.22*a),dr=pois(r,.13);
      o.tr[p]=tr;o.cv[p]=cv;o.pm[p]=pm;o.px[p]=pa-pm;o.dr[p]=dr;o.yc[p]=pois(r,.6+.45*a);o.rc[p]=pois(r,.04+.06*a);o.pts[p]=5*tr+2*cv+3*(pm+dr)}
    return o},
  basket(r,m){const [x,y]=m.s,nrm=()=>{let u=0,v=0;while(!u)u=r();v=r();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v)};
    const o={pts:[0,0],tp:[0,0],reb:[0,0],ast:[0,0],ot:[0,0]};
    const pace=7*nrm();   // rythme du match, commun aux deux équipes
    for(const p of [0,1]){const d=p?y-x:x-y,hm=p?-1.6:1.6;o.pts[p]=Math.round(113+5.5*d+hm+pace+8.2*nrm())}
    if(Math.abs(o.pts[0]-o.pts[1])<=2&&r()<.3)o.pts[1]=o.pts[0];   // fins de match serrées : égalisation au buzzer
    while(o.pts[0]===o.pts[1]){o.ot[0]++;for(const p of [0,1])o.pts[p]+=Math.max(2,Math.round(11+3.5*nrm()))}   // prolongation de 5 min
    for(const p of [0,1]){o.tp[p]=Math.max(2,Math.round(12.8+.11*(o.pts[p]-113)+3.4*nrm()));o.reb[p]=Math.max(25,Math.round(44+5.5*nrm()));o.ast[p]=Math.max(12,Math.round(26+.12*(o.pts[p]-113)+4.5*nrm()))}
    return o},
  tennis(r,m){const a=lvA(m),[x,y]=m.s,d=x-y,hold=[cl(.79-.13*a+.06*d,.55,.93),cl(.79-.13*a-.06*d,.55,.93)],
      ace=[(.5-.38*a)*Math.exp(.2*x),(.5-.38*a)*Math.exp(.2*y)],dfl=.26+.1*a,need=m.bo===5?3:2,
      sets=[0,0],gm=[0,0],ac=[0,0],df=[0,0],brk=[0,0],rk=[0,0];let tb=0,s1=null,srv=r()<.5?0:1;
    while(sets[0]<need&&sets[1]<need){const g=[0,0];
      for(;;){if(g[0]===6&&g[1]===6){tb++;const w=r()<cl(.5+.08*d,.2,.8)?0:1;g[w]++;gm[w]++;ac[0]+=pois(r,ace[0]*1.3);ac[1]+=pois(r,ace[1]*1.3);srv=1-srv;break}
        ac[srv]+=pois(r,ace[srv]);df[srv]+=pois(r,dfl);const w=r()<hold[srv]?srv:1-srv;if(w!==srv)brk[w]++;g[w]++;gm[w]++;srv=1-srv;
        if((g[w]>=6&&g[w]-g[1-w]>=2)||g[w]===7)break}
      const ws=g[0]>g[1]?0:1;sets[ws]++;if(!s1)s1=ws?[0,1]:[1,0];
      for(const p of [0,1])if(r()<.01+.03*a+(p!==ws?.02:0))rk[p]++}
    return{sets,gm,ac,df,brk,tb:[tb,0],rk,s1}}
};
const N=1500;
function sims(m){let S_=MCC.get(m.id);if(S_)return S_;S_={};const r=rng(hash(m.id+"|mc"));
  for(let i=0;i<N;i++){const o=SIM[m.sp](r,m);for(const k in o){const t=S_[k]||(S_[k]=[new Int16Array(N),new Int16Array(N)]);t[0][i]=o[k][0];t[1][i]=o[k][1]}}
  MCC.set(m.id,S_);return S_}
function simOne(m){let o=ONE.get(m.id);if(o)return o;const r=rng(hash(m.id+"|real"));o=SIM[m.sp](r,m);
  if(m.sp==="foot"){const rm=rng(hash(m.id+"|min"));o._min=o.g.map(n=>Array.from({length:n},()=>1+Math.floor(rm()*93)).sort((a,b)=>a-b))}
  ONE.set(m.id,o);return o}

/* ---------- marchés ---------- */
const tot=(g,k)=>{const v=g(k);return v[0]+v[1]};
const cmp3=v=>v[0]>v[1]?0:v[0]===v[1]?1:2;
const MK={
  foot:[
    {id:"res",grp:"Résultat",ic:"ball",t:"Résultat du match",ty:"res",need:["g"],val:g=>cmp3(g("g"))},
    {id:"gt",grp:"Buts",ic:"goal",t:"Nombre de buts",ty:"ou",need:["g"],val:g=>tot(g,"g")},
    {id:"bt",grp:"Buts",ic:"goal",t:"Les deux équipes marquent",ty:"yn",need:["g"],val:g=>{const v=g("g");return v[0]>0&&v[1]>0}},
    {id:"gh",grp:"Buts",ic:"goal",t:m=>"Buts de "+m.h,ty:"ou",need:["g"],val:g=>g("g")[0]},
    {id:"ga",grp:"Buts",ic:"goal",t:m=>"Buts de "+m.a,ty:"ou",need:["g"],val:g=>g("g")[1]},
    {id:"yc",grp:"Discipline",ic:"card",cls:"yc",t:"Cartons jaunes",ty:"ou",need:["yc"],val:g=>tot(g,"yc")},
    {id:"rc",grp:"Discipline",ic:"card",cls:"rc",t:"Au moins un carton rouge",ty:"yn",need:["rc"],val:g=>tot(g,"rc")>0},
    {id:"pk",grp:"Discipline",ic:"whistle",t:"Penalty sifflé",ty:"yn",need:["pk"],val:g=>tot(g,"pk")>0},
    {id:"fo",grp:"Discipline",ic:"whistle",t:"Fautes",ty:"ou",need:["fo"],val:g=>tot(g,"fo")},
    {id:"co",grp:"Jeu",ic:"corner",t:"Corners",ty:"ou",need:["co"],val:g=>tot(g,"co")},
    {id:"of",grp:"Jeu",ic:"flag",t:"Hors-jeux",ty:"ou",need:["of"],val:g=>tot(g,"of")},
    {id:"st",grp:"Jeu",ic:"target",t:"Tirs cadrés",ty:"ou",need:["sot"],val:g=>tot(g,"sot")}],
  rugby:[
    {id:"res",grp:"Résultat",ic:"rugby",t:"Résultat du match",ty:"res",need:["pts"],val:g=>cmp3(g("pts"))},
    {id:"pt",grp:"Score",ic:"chart",t:"Total de points",ty:"ou",need:["pts"],val:g=>tot(g,"pts")},
    {id:"tr",grp:"Score",ic:"rugby",t:"Essais marqués",ty:"ou",need:["tr"],val:g=>tot(g,"tr")},
    {id:"pm",grp:"Pied",ic:"posts",t:"Pénalités réussies",ty:"ou",need:["pm"],val:g=>tot(g,"pm")},
    {id:"px",grp:"Pied",ic:"miss",t:"Pénalités ratées",ty:"ou",need:["px"],val:g=>tot(g,"px")},
    {id:"dr",grp:"Pied",ic:"drop",t:"Au moins un drop réussi",ty:"yn",need:["dr"],val:g=>tot(g,"dr")>0},
    {id:"yc",grp:"Discipline",ic:"card",cls:"yc",t:"Cartons jaunes",ty:"ou",need:["yc"],val:g=>tot(g,"yc")},
    {id:"rc",grp:"Discipline",ic:"card",cls:"rc",t:"Au moins un carton rouge",ty:"yn",need:["rc"],val:g=>tot(g,"rc")>0}],
  tennis:[
    {id:"res",grp:"Résultat",ic:"tennis",t:"Vainqueur du match",ty:"res2",need:["sets"],val:g=>{const v=g("sets");return v[0]>v[1]?0:1}},
    {id:"s1",grp:"Résultat",ic:"tennis",t:"Vainqueur du 1er set",ty:"res2",need:["s1"],val:g=>g("s1")[0]?0:1},
    {id:"ns",grp:"Résultat",ic:"chart",t:"Nombre de sets",ty:"sets",need:["sets"],val:(g,m)=>tot(g,"sets")-(m.bo===5?3:2)},
    {id:"gm",grp:"Jeux",ic:"chart",t:"Nombre de jeux",ty:"ou",need:["gm"],val:g=>tot(g,"gm")},
    {id:"tb",grp:"Jeux",ic:"tb",t:"Au moins un tie-break",ty:"yn",need:["tb"],val:g=>tot(g,"tb")>0},
    {id:"bk",grp:"Jeux",ic:"break",t:"Breaks",ty:"ou",need:["brk"],val:g=>tot(g,"brk")},
    {id:"ac",grp:"Service",ic:"bolt",t:"Aces",ty:"ou",need:["ac"],val:g=>tot(g,"ac")},
    {id:"df",grp:"Service",ic:"df",t:"Doubles fautes",ty:"ou",need:["df"],val:g=>tot(g,"df")},
    {id:"rk",grp:"Nerfs",ic:"broken",t:"Raquette cassée",ty:"yn",need:["rk"],val:g=>tot(g,"rk")>0}],
  basket:[
    {id:"res",grp:"Résultat",ic:"basket",t:"Vainqueur (prolongations comprises)",ty:"res2",need:["pts"],val:g=>{const v=g("pts");return v[0]>v[1]?0:1}},
    {id:"pt",grp:"Points",ic:"chart",t:"Total de points",ty:"ou",need:["pts"],val:g=>tot(g,"pts")},
    {id:"ph",grp:"Points",ic:"chart",t:m=>"Points de "+m.h,ty:"ou",need:["pts"],val:g=>g("pts")[0]},
    {id:"pa",grp:"Points",ic:"chart",t:m=>"Points de "+m.a,ty:"ou",need:["pts"],val:g=>g("pts")[1]},
    {id:"e10",grp:"Points",ic:"target",t:"Victoire de 10 points ou plus",ty:"yn",need:["pts"],val:g=>{const v=g("pts");return Math.abs(v[0]-v[1])>=10}},
    {id:"ot",grp:"Points",ic:"whistle",t:"Prolongation",ty:"yn",need:["ot"],val:g=>g("ot")[0]>0},
    {id:"tp",grp:"Jeu",ic:"basket",t:"Paniers à 3 points",ty:"ou",need:["tp"],val:g=>tot(g,"tp")},
    {id:"rb",grp:"Jeu",ic:"chart",t:"Rebonds",ty:"ou",need:["reb"],val:g=>tot(g,"reb")},
    {id:"as",grp:"Jeu",ic:"group",t:"Passes décisives",ty:"ou",need:["ast"],val:g=>tot(g,"ast")}]
};
const ALLSTATS={foot:["g","sot","co","of","fo","yc","rc","pk"],rugby:["pts","tr","cv","pm","px","dr","yc","rc"],tennis:["sets","gm","ac","df","brk","tb","rk","s1"],basket:["pts","tp","reb","ast","ot"]};
const STATL={g:["Buts","goal"],sot:["Tirs cadrés","target"],co:["Corners","corner"],of:["Hors-jeux","flag"],fo:["Fautes","whistle"],yc:["Cartons jaunes","card","yc"],rc:["Cartons rouges","card","rc"],pk:["Penalties","whistle"],
  pts:["Points","chart"],tr:["Essais","rugby"],cv:["Transformations","posts"],pm:["Pénalités réussies","posts"],px:["Pénalités ratées","miss"],dr:["Drops","drop"],
  tp:["Paniers à 3 points","basket"],reb:["Rebonds","chart"],ast:["Passes décisives","group"],ot:["Prolongations","whistle"],
  sets:["Sets","tennis"],gm:["Jeux","chart"],ac:["Aces","bolt"],df:["Doubles fautes","df"],brk:["Breaks","break"],tb:["Tie-breaks","tb"],rk:["Raquettes cassées","broken"]};
// stats que chaque source sait fournir (on ne propose que les paris réglables)
function avail(m){if(m.src!=="espn")return ALLSTATS[m.sp];
  return m.sp==="foot"?["g","sot","co","of","fo","yc","rc","pk"]:m.sp==="rugby"?["pts"]:m.sp==="basket"?["pts","tp","reb","ast","ot"]:["sets","gm","tb","s1"]}
const odd=p=>p<.012?0:Math.round(cl(.93/p,1.01,60)*100)/100;
const mt=(d,m)=>typeof d.t==="function"?d.t(m):d.t;
// En direct : on part du score actuel et on simule seulement la fin du match
// (chaque but / essai / pénalité d'un match complet simulé est conservé avec la probabilité « temps restant »).
const liveOK=m=>m.src==="espn"&&m.sp!=="tennis"&&m.sp!=="basket"&&m.state==="in"&&m.st&&m.min!=null&&m.min<(m.sp==="foot"?85:72);
const canBet=m=>status(m)==="pre"||liveOK(m);
function liveSims(m){const key=m.id+"|L|"+m.min+"|"+JSON.stringify(m.st.g||m.st.pts);let S_=MCC.get(key);if(S_)return S_;
  const r=rng(hash(key)),full=m.sp==="foot"?90:80,f=cl((full-m.min)/full,0,1),now=m.st.g||m.st.pts,k=m.sp==="foot"?"g":"pts";S_={[k]:[new Int16Array(N),new Int16Array(N)]};
  for(let i=0;i<N;i++){const o=SIM[m.sp](r,m);for(const p of [0,1]){const add=m.sp==="foot"?binom(r,o.g[p],f):5*binom(r,o.tr[p],f)+2*binom(r,o.cv[p],f)+3*binom(r,o.pm[p]+o.dr[p],f);S_[k][p][i]=now[p]+add}}
  MCC.set(key,S_);return S_}
const marketSims=m=>liveOK(m)?liveSims(m):sims(m);
function markets(m){const lv_=liveOK(m),key=m.id+"|"+m.src+(lv_?"|L"+m.min+JSON.stringify(m.st.g||m.st.pts):"");let L=MKC.get(key);if(L)return L;
  const S_=marketSims(m),av=lv_?[m.sp==="foot"?"g":"pts"]:avail(m);L=[];
  for(const d of MK[m.sp]){if(d.need.some(k=>!av.includes(k)))continue;L.push(mkOne(d,S_,m))}
  MKC.set(key,L);if(MKC.size>3000)MKC.delete(MKC.keys().next().value);return L}
// un seul type de pari (même calcul, donc mêmes cotes que markets) ; buffers réutilisés : plus rapide, résultats identiques
function mkOne(d,S_,m){
    const vals=new Float64Array(N),B={};let i=0;const g=k=>{const a=B[k]||(B[k]=[0,0]),t=S_[k];a[0]=t[0][i];a[1]=t[1][i];return a};
    for(i=0;i<N;i++)vals[i]=+d.val(g,m);
    let sels=[],line=null;
    if(d.ty==="ou"){const mx=Math.max(...vals);let best=.5,bd=9;for(let k=0;k<=mx;k++){let c=0;for(const v of vals)if(v>k)c++;const p=c/N;if(Math.abs(p-.52)<bd){bd=Math.abs(p-.52);best=k}}
      line=best+.5;let c=0;for(const v of vals)if(v>line)c++;const p=c/N;const ls=fr(line,1);
      sels=[{l:"Plus de "+ls,p},{l:"Moins de "+ls,p:1-p}]}
    else if(d.ty==="yn"){let c=0;for(const v of vals)if(v)c++;sels=[{l:"Oui",p:c/N},{l:"Non",p:1-c/N}]}
    else{const lb=d.ty==="res"?[m.h,"Match nul",m.a]:d.ty==="res2"?[m.h,m.a]:(m.bo===5?["3 sets","4 sets","5 sets"]:["2 sets","3 sets"]);
      const c=lb.map(()=>0);for(const v of vals)c[v]++;sels=lb.map((l,k)=>({l,p:c[k]/N}))}
    // pour les paris oui/non, "Oui" = val vraie → index 0 ; pour plus/moins, "Plus" → index 0
    return{d,id:d.id,line,title:mt(d,m),sels:sels.map(s=>({...s,o:odd(s.p)}))}}
// pour les cartes de match : seulement le résultat (1N2) et le nombre de paris, sans calculer tous les marchés
const RKC=new Map();
function resMarket(m){const lv_=liveOK(m),key=m.id+"|"+m.src+(lv_?"|L"+m.min+JSON.stringify(m.st.g||m.st.pts):"");const L=MKC.get(key);if(L)return L.find(x=>x.id==="res")||null;
  if(RKC.has(key))return RKC.get(key);const d=MK[m.sp].find(x=>x.id==="res"),av=lv_?[m.sp==="foot"?"g":"pts"]:avail(m);
  const r=d&&!d.need.some(k=>!av.includes(k))?mkOne(d,marketSims(m),m):null;RKC.set(key,r);if(RKC.size>3000)RKC.delete(RKC.keys().next().value);return r}
function marketInfo(m){const lv_=liveOK(m),av=lv_?[m.sp==="foot"?"g":"pts"]:avail(m);return MK[m.sp].filter(d=>!d.need.some(k=>!av.includes(k)))}
function outcome(d,m,st,line){ // index de la sélection gagnante, null si stats manquantes
  if(!st||d.need.some(k=>!Array.isArray(st[k])||st[k].some(v=>v==null||isNaN(v))))return null;
  const g=k=>st[k],v=d.val(g,m);
  if(d.ty==="ou")return v>line?0:1;if(d.ty==="yn")return v?0:1;return v}
const ESPN="https://site.api.espn.com/apis/site/v2/sports/";
const SOCSTAT={yellowCards:"yc",redCards:"rc",offsides:"of",wonCorners:"co",foulsCommitted:"fo",shotsOnTarget:"sot",penaltyKickShots:"pk"};
const strength=(name,sp,lv)=>((hash(name+"|"+sp)%2001)/1000-1)*(lv<3?1.1:.9);
function recStrength(c,name,sp,lv){const s=c.records&&c.records[0]&&c.records[0].summary;
  if(s&&/^\d+-\d+-\d+$/.test(s)){const[w,d,l]=s.split("-").map(Number),n=w+d+l;if(n>=3)return cl(((3*w+d)/n-1.4)/.8,-1.4,1.4)}
  if(sp==="basket"&&s&&/^\d+-\d+$/.test(s)){const[w,l]=s.split("-").map(Number),n=w+l;if(n>=3)return cl((w/n-.5)*2.6,-1.3,1.3)}
  return strength(name,sp,lv)*.6}
// cotes américaines du bookmaker (ex. +120 / -150) → écart de niveau entre les deux équipes
const amer=o=>{const v=parseFloat(o);return isNaN(v)?null:v>0?1+v/100:1+100/-v};
function bookDiff(c){try{const ml=c.odds&&c.odds[0]&&c.odds[0].moneyline;if(!ml)return null;
    const g=x=>x&&amer((x.close&&x.close.odds)||(x.open&&x.open.odds)),oh=g(ml.home),oa=g(ml.away),od=g(ml.draw);if(!oh||!oa||!od)return null;
    const t=1/oh+1/oa+1/od,ph=1/oh/t,pa=1/oa/t;let best=0,be=9;
    for(const[d,h,a]of bdTable()){const e=(h-ph)**2+(a-pa)**2;if(e<be){be=e;best=d}}return best}catch(e){return null}}
// table calculée une seule fois (mêmes valeurs qu'avant, mêmes pas de 0,05) : bien plus rapide au chargement
let BDT=null;function bdTable(){if(BDT)return BDT;BDT=[];for(let d=-3;d<=3.001;d+=.05){const[h,,a]=footProbs(d,0);BDT.push([d,h,a])}return BDT}
function footProbs(d,a){const l1=(1.3+.6*a)*Math.exp(.33*d+.12),l2=(1.3+.6*a)*Math.exp(-.33*d-.12),P=(l,k)=>{let p=Math.exp(-l);for(let i=1;i<=k;i++)p*=l/i;return p};
  let h=0,x=0,w=0;for(let i=0;i<12;i++)for(let j=0;j<12;j++){const p=P(l1,i)*P(l2,j);if(i>j)h+=p;else if(i===j)x+=p;else w+=p}return[h,x,w]}
// noms d'équipes en français (même liste que api/_teams.js)
const TEAM_FR={"Albania":"Albanie","Andorra":"Andorre","Armenia":"Arménie","Australia":"Australie","Austria":"Autriche","Azerbaijan":"Azerbaïdjan","Belarus":"Biélorussie","Belgium":"Belgique","Bosnia-Herz":"Bosnie-Herzégovine","Bosnia and Herzegovina":"Bosnie-Herzégovine","Brazil":"Brésil","Bulgaria":"Bulgarie","Croatia":"Croatie","Cyprus":"Chypre","Czechia":"Tchéquie","Czech Republic":"Tchéquie","Denmark":"Danemark","England":"Angleterre","Estonia":"Estonie","Faroe Islands":"Îles Féroé","Fiji":"Fidji","Finland":"Finlande","Georgia":"Géorgie","Germany":"Allemagne","Greece":"Grèce","Hungary":"Hongrie","Iceland":"Islande","Israel":"Israël","Italy":"Italie","Japan":"Japon","Latvia":"Lettonie","Lithuania":"Lituanie","Malta":"Malte","Moldova":"Moldavie","Montenegro":"Monténégro","N Ireland":"Irlande du Nord","Northern Ireland":"Irlande du Nord","Netherlands":"Pays-Bas","New Zealand":"Nouvelle-Zélande","North Macedonia":"Macédoine du Nord","Norway":"Norvège","Poland":"Pologne","Rep Ireland":"Irlande","Republic of Ireland":"Irlande","Ireland":"Irlande","Romania":"Roumanie","San Marino":"Saint-Marin","Scotland":"Écosse","Serbia":"Serbie","Slovakia":"Slovaquie","Slovenia":"Slovénie","Spain":"Espagne","Sweden":"Suède","Switzerland":"Suisse","Türkiye":"Turquie","Turkey":"Turquie","Uzbekistan":"Ouzbékistan","Wales":"Pays de Galles","South Africa":"Afrique du Sud","Argentina":"Argentine","Chile":"Chili","United States":"États-Unis","USA":"États-Unis","Mexico":"Mexique","Morocco":"Maroc","Algeria":"Algérie","Tunisia":"Tunisie","Senegal":"Sénégal","Ivory Coast":"Côte d'Ivoire","Cameroon":"Cameroun","Egypt":"Égypte","Colombia":"Colombie","Ecuador":"Équateur","Peru":"Pérou","Russia":"Russie","South Korea":"Corée du Sud","Korea Republic":"Corée du Sud","Saudi Arabia":"Arabie saoudite","Namibia":"Namibie","Ukraine":"Ukraine","Kazakhstan":"Kazakhstan","Kosovo":"Kosovo","Uruguay":"Uruguay","Canada":"Canada","Portugal":"Portugal","France":"France","Bremen":"Werder Brême","Frankfurt":"Francfort","Hamburg":"Hambourg","Gladbach":"M'gladbach","Spurs":"Tottenham","C Palace":"Crystal Palace","Nottm Forest":"Nottingham Forest","Boro":"Middlesbrough","Man City":"Manchester City","Man Utd":"Manchester United","Sevilla":"Séville","Athletic":"Athletic Bilbao","Atlético":"Atlético Madrid","Rayo":"Rayo Vallecano","S Bratislava":"Slovan Bratislava","AEK Athens":"AEK Athènes","København":"FC Copenhague","Standard Liege":"Standard de Liège","Slavia Prague":"Slavia Prague","Sporting":"Sporting Portugal","Red Star":"Étoile rouge","Bayern":"Bayern Munich","Dortmund":"Dortmund","Leverkusen":"Leverkusen","Inter Milan":"Inter Milan","Milan":"AC Milan","Napoli":"Naples","Celta Vigo":"Celta Vigo","Deportivo":"La Corogne","St. Étienne":"Saint-Étienne","Stade Francais Paris":"Stade Français","Bordeaux Begles":"Bordeaux-Bègles","Montpellier Herault":"Montpellier","LOU Rugby":"Lyon OU","Castres Olympique":"Castres","Chambery":"Chambéry","Angouleme":"Angoulême","Montlucon":"Montluçon","Nimes":"Nîmes","Chalon-sur-Saone":"Chalon-sur-Saône","Frejus":"Fréjus","Epinal":"Épinal","Fecamp":"Fécamp","Trelissac":"Trélissac","Vitre":"Vitré","Le Havre AC":"Le Havre","Clermont Foot":"Clermont","Dijon FCO":"Dijon","Red Star FC":"Red Star","Rodez Aveyron":"Rodez","SC Amiens":"Amiens"},frTeam=n=>TEAM_FR[String(n).trim()]||String(n).trim();
function parseTeamEvent(ev,sp,lv,path){const c=ev.competitions&&ev.competitions[0];if(!c||!c.competitors||c.competitors.length<2)return null;
  const Hc=c.competitors.find(x=>x.homeAway==="home")||c.competitors[0],Ac=c.competitors.find(x=>x.homeAway==="away")||c.competitors[1];
  const ty=(ev.status&&ev.status.type)||{},state=ty.state||"pre";
  const nm=t=>frTeam((t.team&&(t.team.shortDisplayName||t.team.displayName))||"?");
  const m={id:"e-"+path.replace(/\W/g,"")+"-"+ev.id,src:"espn",path,eid:ev.id,sp,lv,bo:3,comp:SP[sp].lv[lv],h:nm(Hc),a:nm(Ac),
    hl:Hc.team&&Hc.team.logo,al:Ac.team&&Ac.team.logo,hid:Hc.team&&Hc.team.id,aid:Ac.team&&Ac.team.id,t:Date.parse(ev.date),
    state,clock:ty.shortDetail||"",done:!!ty.completed,cancel:state==="post"&&!ty.completed};
  {const st_=ev.status||{},dc=parseInt(st_.displayClock,10);m.min=/^(HT|MT)/i.test(ty.shortDetail||"")||ty.name==="STATUS_HALFTIME"?(sp==="foot"?45:40):!isNaN(dc)?dc:Math.round((st_.clock||0)/60)}
  m.s=[recStrength(Hc,m.h,sp,lv),recStrength(Ac,m.a,sp,lv)];
  if(sp==="foot"){const d=bookDiff(c);if(d!=null)m.s=[d/2,-d/2]}
  if(state!=="pre"){const k=sp==="foot"?"g":"pts";m.st={[k]:[+Hc.score||0,+Ac.score||0]};
    if(sp==="foot")[Hc,Ac].forEach((x,p)=>(x.statistics||[]).forEach(s=>{const k2=SOCSTAT[s.name];if(k2){(m.st[k2]||(m.st[k2]=[null,null]))[p]=parseFloat(s.displayValue)}}));
    if(sp==="basket"){const BK={threePointFieldGoalsMade:"tp",rebounds:"reb",assists:"ast"};
      [Hc,Ac].forEach((x,p)=>(x.statistics||[]).forEach(s=>{const k2=BK[s.name];if(k2){(m.st[k2]||(m.st[k2]=[null,null]))[p]=parseFloat(s.displayValue)}}));
      const q=(Hc.linescores||[]).length;if(q>=4)m.st.ot=[q-4,0]}}
  if(sp==="foot"&&Array.isArray(c.details))m.ev=c.details.map(x=>{const a=(x.athletesInvolved||[])[0],t=(x.type&&x.type.text)||"";
    // s = équipe (0 domicile, 1 extérieur), n = nom du joueur : pour les animations en direct
    const hid=String(Hc.id||(Hc.team&&Hc.team.id)||""),tid=String((x.team&&x.team.id)||"");
    return{ty:x.scoringPlay?(x.ownGoal?"og":"g"):/red/i.test(t)?"rc":/yellow/i.test(t)?"yc":"",id:a&&String(a.id),min:parseInt((x.clock&&x.clock.displayValue)||"0",10),
      s:tid?(tid===hid?0:1):null,n:a&&(a.shortName||a.displayName)||""}}).filter(e=>e.ty&&e.id);
  return m}
function parseTennis(ev,lv,path){const out=[];const groups=ev.groupings||[{grouping:{slug:"singles"},competitions:ev.competitions||[]}];
  for(const g of groups){const slug=((g.grouping&&(g.grouping.slug||g.grouping.displayName))||"").toLowerCase();if(slug.includes("double"))continue;
    for(const c of g.competitions||[]){const cs=c.competitors||[];if(cs.length<2)continue;const A=cs[0],B=cs[1];
      const nm=x=>(x.athlete&&(x.athlete.displayName||x.athlete.shortName))||(x.team&&x.team.displayName)||"?";
      const ty=(c.status&&c.status.type)||{},state=ty.state||"pre";
      const gs=/(australian open|roland|french open|wimbledon|us open)/i.test(ev.name||"")&&!/wta|women/i.test(slug+path);
      const m={id:"e-"+path.replace(/\W/g,"")+"-"+c.id,src:"espn",path,eid:c.id,date:c.date||ev.date,sp:"tennis",lv,bo:gs?5:3,
        comp:(ev.shortName||ev.name||"Tour")+(path.endsWith("wta")?" · WTA":" · ATP"),h:nm(A),a:nm(B),
        hf:A.athlete&&A.athlete.flag&&A.athlete.flag.href,af:B.athlete&&B.athlete.flag&&B.athlete.flag.href,
        t:Date.parse(c.date||ev.date),state,clock:ty.shortDetail||"",done:!!ty.completed,cancel:state==="post"&&!ty.completed};
      m.s=[strength(m.h,"tennis",lv)*.5,strength(m.a,"tennis",lv)*.5];
      const la=(A.linescores||[]).map(x=>+x.value),lb=(B.linescores||[]).map(x=>+x.value);
      if(state!=="pre"&&la.length){const sets=[0,0],gm=[0,0];let tb=0;
        la.forEach((v,i)=>{const w=lb[i]??0;gm[0]+=v;gm[1]+=w;if(Math.max(v,w)>=6&&v!==w&&(state==="post"||i<la.length-1))sets[v>w?0:1]++;if((v===7&&w===6)||(v===6&&w===7))tb++});
        if(state==="post"&&A.winner!==undefined&&sets[0]===sets[1])sets[A.winner?0:1]++;
        m.st={sets,gm,tb:[tb,0],s1:la.length&&lb.length&&la[0]!==lb[0]?(la[0]>lb[0]?[1,0]:[0,1]):undefined};if(!m.st.s1)delete m.st.s1}
      if(m.t)out.push(m)}}
  return out}
/* ---------- statut d'un match ---------- */
function status(m){const now=Date.now();
  if(m.src==="espn")return m.cancel?"cancel":m.state==="in"?"live":m.state==="post"?"post":"pre";
  if(m.src==="org"||m.src==="am")return m.res?"post":now<m.t?"pre":"wait";
  return now<m.t?"pre":now<m.t+SP[m.sp].dur*6e4?"live":"post"}
function realStats(m){const s=status(m);if(s!=="post")return null;if(m.src==="sim")return simOne(m);if(m.src==="org"||m.src==="am")return m.res;return m.st||null}

/* ---------- combinés : cote d'un ensemble de sélections (mêmes règles pour l'appli et le serveur) ---------- */
const PMK={psc:{t:"Buteur",ic:"goal"},p2:{t:"Doublé",ic:"goal"},pyc:{t:"Carton",ic:"card",cls:"yc"}};
function legIdx(d,m,g,L){const v=d.val(g,m);return d.ty==="ou"?(v>L.line?0:1):d.ty==="yn"?(v?0:1):v}
// probabilité que toutes les sélections d'un même match passent ensemble (même tirage Monte-Carlo)
function jointP(m,legs){if(!m)return 0;const S_=marketSims(m),defs=legs.map(L=>MK[m.sp].find(d=>d.id===L.mk));let c=0;
  for(let i=0;i<N;i++){const g=k=>[S_[k][0][i],S_[k][1][i]];let ok=true;for(let j=0;j<legs.length;j++)if(legIdx(defs[j],m,g,legs[j])!==legs[j].k){ok=false;break}if(ok)c++}return c/N}
// sel : [{mid,mk,k,line,o}] ; getM(mid) → match. Matchs différents : cotes multipliées ; même match : cote jointe.
function comboCalc(sel,getM){const by={};sel.forEach(s=>(by[s.mid]=by[s.mid]||[]).push(s));let odds=1,bad=false,linked=0;const groups={};
  for(const mid in by){const L=by[mid];if(L.length===1){odds*=L[0].o;continue}
    if(L.some(s=>PMK[s.mk])){const o=Math.round(cl(L.reduce((a,s)=>a*s.o,1)*.92,1.01,2000)*100)/100;linked++;groups[mid]=o;odds*=o;continue}
    linked++;const p=jointP(getM(mid),L);if(p<.004){bad=true;continue}const o=Math.round(cl(.9/p,1.01,500)*100)/100;groups[mid]=o;odds*=o}
  return{odds:Math.round(odds*100)/100,groups,bad,linked}}

/* ---------- règlement (mêmes règles pour l'appli et le serveur) ---------- */
// Compositions : [équipe domicile, extérieur] → joueurs {id, name, pos, starter, played}
function readLineup(m,j){const R=j&&j.rosters;if(!Array.isArray(R)||!R.some(t=>(t.roster||[]).length))return;const L=[[],[]];
  for(const t of R){const p=t.team&&String(t.team.id)===String(m.aid)?1:t.team&&String(t.team.id)===String(m.hid)?0:(t.homeAway==="away"?1:0);
    for(const x of t.roster||[])if(x.athlete)L[p].push({id:String(x.athlete.id),name:x.athlete.displayName||x.athlete.shortName||"?",pos:(x.position&&x.position.abbreviation)||"",starter:!!x.starter,played:!!(x.starter||x.subbedIn)})}
  m.lineup=L;m.lineupAt=Date.now()}
// résumé ESPN d'un match de foot : compositions + statistiques complètes (cartons, corners…)
function applySummary(m,j){const teams=(j&&j.boxscore&&j.boxscore.teams)||[];readLineup(m,j);
  teams.forEach(t=>{const p=t.team&&t.team.id===m.aid?1:t.team&&t.team.id===m.hid?0:(t.homeAway==="away"?1:0);
    (t.statistics||[]).forEach(s=>{const k=SOCSTAT[s.name];if(k){m.st=m.st||{};(m.st[k]||(m.st[k]=[null,null]))[p]=parseFloat(s.displayValue)}})})}
function playerLegResult(L,m){if(!m.lineup||!m.ev){const late=Date.now()-L.t>SP.foot.dur*6e4+48*H;return late?"v":null}
  const pl=m.lineup[0].concat(m.lineup[1]).find(x=>x.id===String(L.k));if(!pl||!pl.played)return"v";
  const n=m.ev.filter(e=>e.id===String(L.k)&&(L.mk==="pyc"?(e.ty==="yc"||e.ty==="rc"):e.ty==="g")).length;
  return(L.mk==="p2"?n>=2:n>=1)?"w":"l"}
// résultat d'une sélection : "w" gagné, "l" perdu, "v" remboursé, null pas encore connu
function legResultM(L,m){const age=Date.now()-L.t;
  if(!m)return age>7*DAY?"v":null;
  const st=status(m);if(st==="cancel")return"v";if(st!=="post")return((m.src==="org"||m.src==="am")&&age>14*DAY)?"v":null;
  if(PMK[L.mk])return playerLegResult(L,m);
  const d=MK[m.sp].find(x=>x.id===L.mk);if(!d)return"v";
  const w=outcome(d,m,realStats(m),L.line);
  if(w==null)return age>SP[m.sp].dur*6e4+48*H?"v":null;
  return w===L.k?"w":"l"}
// gain d'un pari dont toutes les sélections sont réglées et aucune perdue (sélections remboursées retirées)
function betResult(b){const live=b.legs.filter(L=>L.r==="w");if(!live.length)return{st:"void",odds:1,pay:b.stake};
  const G=b.groups||{};let o=1;const by={};live.forEach(L=>(by[L.mid]=by[L.mid]||[]).push(L));
  for(const mid in by){const all=b.legs.filter(L=>L.mid===mid);o*=G[mid]&&all.every(L=>L.r==="w")?G[mid]:by[mid].reduce((a,L)=>a*L.o,1)}
  const odds=Math.round(o*100)/100;return{st:"won",odds,pay:Math.round(b.stake*odds)}}
// Encaisser avant la fin : valeur = gain possible × probabilité actuelle que le pari passe × 0,9.
function cashValueM(b,getM){if(b.st!=="open"||b.legs.some(L=>L.r==="l"||L.r==="v"))return 0;const by={};
  for(const L of b.legs.filter(L=>!L.r)){if(PMK[L.mk])return 0;const m=getM(L.mid);if(!m)return 0;const st=status(m);if(st!=="pre"&&!liveOK(m))return 0;
    const d=MK[m.sp].find(x=>x.id===L.mk);if(!d)return 0;if(liveOK(m)&&d.need.some(k=>k!==(m.sp==="foot"?"g":"pts")))return 0;
    (by[L.mid]=by[L.mid]||[]).push(L)}
  if(!Object.keys(by).length)return 0;let p=1;for(const mid in by)p*=jointP(getM(mid),by[mid]);
  const full=Math.floor(b.stake*b.odds);return cl(Math.floor(full*p*.9),1,full-1)}

/* ---------- roue et défis du jour (le serveur tire la roue et vérifie les défis) ---------- */
const WHEEL=[25,50,75,100,150,200,300,500],WP=[28,24,18,13,8,5,3,1];   // gains et chances en %
const JACKPOT=1000000,JACK_ODDS=10000000;   // case jackpot tirée à part : 1 chance sur 10 millions
const EXTRA_DAY="20261109";   // tour bonus offert à tout le monde ce jour-là
const legsOf=B=>B.flatMap(b=>b.legs);
const DEFIS=[
  [{id:"p3",ic:"ticket",t:"Place 3 paris",g:3,r:50,f:P=>P.length},
   {id:"card",ic:"card",cls:"yc",t:"Parie sur les cartons",g:1,r:40,f:P=>legsOf(P).filter(l=>l.mk==="yc"||l.mk==="rc").length},
   {id:"corn",ic:"corner",t:"Parie sur les corners",g:1,r:40,f:P=>legsOf(P).filter(l=>l.mk==="co").length},
   {id:"bt1",ic:"goal",t:"Parie sur un buteur",g:1,r:40,f:P=>legsOf(P).filter(l=>l.mk==="psc").length},
   {id:"rug",ic:"rugby",t:"Parie sur un match de rugby",g:1,r:50,f:P=>legsOf(P).filter(l=>l.sp==="rugby").length},
   {id:"ten",ic:"tennis",t:"Parie sur un match de tennis",g:1,r:50,f:P=>legsOf(P).filter(l=>l.sp==="tennis").length},
   {id:"w1e",ic:"trophy",t:"Gagne un pari simple",g:1,r:50,f:(P,W)=>W.filter(b=>b.legs.length===1).length}],
  [{id:"p5",ic:"ticket",t:"Place 5 paris",g:5,r:80,f:P=>P.length},
   {id:"cb3",ic:"chart",t:"Fais un combiné d’au moins 3 sélections",g:1,r:70,f:P=>P.filter(b=>b.legs.length>=3).length},
   {id:"bb",ic:"target",t:"Fais un combiné sur un même match",g:1,r:70,f:P=>P.filter(b=>new Set(b.legs.map(l=>l.mid)).size<b.legs.length).length},
   {id:"live",ic:"fire",t:"Fais un pari en direct (foot ou rugby, pendant le match)",g:1,r:80,f:P=>legsOf(P).filter(l=>l.live).length},
   {id:"3sp",ic:"trophy",t:"Parie sur les 3 sports",g:3,r:100,f:P=>new Set(legsOf(P).map(l=>l.sp)).size},
   {id:"w1",ic:"trophy",t:"Gagne un pari",g:1,r:60,f:(P,W)=>W.length}],
  [{id:"w2",ic:"trophy",t:"Gagne 2 paris",g:2,r:100,f:(P,W)=>W.length},
   {id:"o25",ic:"bolt",t:"Gagne un pari à une cote de 2,50 ou plus",g:1,r:120,f:(P,W)=>W.filter(b=>b.odds>=2.5).length},
   {id:"wcard",ic:"card",cls:"rc",t:"Gagne un pari sur les cartons",g:1,r:100,f:(P,W)=>legsOf(W).filter(l=>(l.mk==="yc"||l.mk==="rc")&&l.r==="w").length},
   {id:"wbt",ic:"goal",t:"Trouve un buteur",g:1,r:120,f:(P,W)=>legsOf(W).filter(l=>l.mk==="psc"&&l.r==="w").length},
   {id:"wcb",ic:"chart",t:"Gagne un combiné",g:1,r:120,f:(P,W)=>W.filter(b=>b.legs.length>1).length}]];
const DEFI_BONUS=150;
// Week-ends spéciaux (samedi et dimanche, heure de Paris) : un thème par week-end, à tour de rôle, sans rien à régler.
const WEEKENDS={roue:{n:"Week-end de la roue",e:"🎡",d:"Tous les gains de la roue sont doublés (×2)."},
  defis:{n:"Week-end des défis",e:"🎯",d:"Les défis du jour rapportent le double (×2), bonus des 3 défis compris."},
  combo:{n:"Week-end des combinés",e:"🧾",d:"Combiné gagné de 3 sélections ou plus : +25 % de bonus sur ton bénéfice."}};
const COMBO_BOOST=.25;
function weekendOf(day){const t=Date.UTC(+day.slice(0,4),+day.slice(4,6)-1,+day.slice(6,8))/864e5,dow=new Date(t*864e5).getUTCDay();
  const k=["combo","roue","defis"][Math.floor((t+3)/7)%3];return{k,...WEEKENDS[k],on:dow===6||dow===0,soon:dow===5,last:dow===0}}
function defisFor(day){const r=rng(hash("defis|"+day));return DEFIS.map(L=>L[Math.floor(r()*L.length)])}

if(typeof globalThis!=="undefined")globalThis.ENGINE={resMarket,marketInfo,mkOne,WEEKENDS,COMBO_BOOST,weekendOf,fr,strength,SP,SIM,MK,N,ALLSTATS,STATL,ESPN,MCC,MKC,ONE,cl,hash,rng,pois,binom,H,DAY,lvA,sims,simOne,tot,cmp3,avail,odd,mt,liveOK,canBet,liveSims,marketSims,markets,outcome,
  SOCSTAT,recStrength,amer,bookDiff,footProbs,TEAM_FR,frTeam,parseTeamEvent,parseTennis,status,realStats,PMK,legIdx,jointP,comboCalc,readLineup,applySummary,playerLegResult,legResultM,betResult,cashValueM,WHEEL,WP,JACKPOT,JACK_ODDS,EXTRA_DAY,DEFIS,DEFI_BONUS,defisFor,legsOf};
