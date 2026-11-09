// Paris contrôlés par le serveur : on retrouve chaque match dans le flux ESPN, on recalcule la cote avec le même
// moteur que l'appli (engine.js) et on refuse un pari sur un match commencé ou à une cote plus haute que la vraie.
import "../engine.js";
const E = globalThis.ENGINE;

// compétition ESPN → sport et niveau (on ne fait jamais confiance au téléphone pour ça)
const LV = {};
for (const sp in E.SP) for (const lv in E.SP[sp].feeds) for (const p of E.SP[sp].feeds[lv]) LV[p] = { sp, lv: +lv };

const CACHE = new Map();   // réponses ESPN gardées quelques secondes (plusieurs paris sur la même journée)
async function board(path, ymd, live) {
  const key = path + "|" + ymd, c = CACHE.get(key);
  if (c && Date.now() - c.at < (live ? 15e3 : 60e3)) return c.j;
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(`${E.ESPN}${path}/scoreboard?dates=${ymd}&limit=300`, { signal: ctl.signal });
    if (!r.ok) throw new Error(String(r.status));
    const j = await r.json();
    CACHE.set(key, { j, at: Date.now() });
    if (CACHE.size > 200) CACHE.delete(CACHE.keys().next().value);
    return j;
  } finally { clearTimeout(t); }
}
const ymdUTC = (t) => new Date(t).toISOString().slice(0, 10).replace(/-/g, "");

// le match d'une sélection {mid, path, t}, tel que le voit ESPN maintenant (null si introuvable)
export async function loadMatch(sel) {
  const P = LV[sel.path], t = Number(sel.t);
  if (!P || !t || !/^e-/.test(String(sel.mid || ""))) return null;
  const live = Math.abs(Date.now() - t) < 4 * 3600e3;
  for (const d of [0, -864e5, 864e5]) {
    let j;
    try { j = await board(sel.path, ymdUTC(t + d), live); } catch (e) { continue; }
    for (const ev of j.events || []) {
      const ms = P.sp === "tennis" ? E.parseTennis(ev, P.lv, sel.path) : [E.parseTeamEvent(ev, P.sp, P.lv, sel.path)];
      const m = ms.find((x) => x && x.id === sel.mid);
      if (m) return m;
    }
  }
  return null;
}

const TOL = 1.02;   // la cote du téléphone peut dépasser la vraie de 2 % au plus (petits écarts de données)

// Vérifie un pari {stake, combo, sels:[{mid,path,t,mk,k,line,o}]}. Renvoie {ok, odds, legs, groups} ou {error, …}.
export async function checkBet(bet) {
  const sels = Array.isArray(bet.sels) ? bet.sels.slice(0, 12) : [];
  if (!sels.length) return { error: "empty" };
  const M = {}, changed = [];
  for (const s of sels) {
    const m = M[s.mid] || (M[s.mid] = await loadMatch(s));
    if (!m) return { error: "unknown_match", mid: s.mid };
    if (!E.canBet(m)) return { error: "started", mid: s.mid };
    const o = Number(s.o);
    if (!(o >= 1.01 && o <= 500)) return { error: "odds", mid: s.mid };
    if (E.PMK[s.mk]) {   // buteur, doublé, carton d'un joueur : cote calculée sur le téléphone avec l'effectif (bornée ici)
      if (m.sp !== "foot" || o < 1.15 || o > 80) return { error: "odds", mid: s.mid };
      continue;
    }
    const mk = E.markets(m).find((x) => x.id === s.mk);
    if (!mk) return { error: "market", mid: s.mid, mk: s.mk };
    if (mk.line != null && Number(s.line) !== mk.line) { changed.push({ mid: s.mid, mk: s.mk, k: s.k, line: mk.line, o: null }); continue; }
    const real = mk.sels[s.k] && mk.sels[s.k].o;
    if (!real) return { error: "market", mid: s.mid, mk: s.mk };
    if (o > real * TOL) changed.push({ mid: s.mid, mk: s.mk, k: s.k, line: mk.line, o: real });
  }
  if (changed.length) return { error: "odds_changed", changed };
  const legs = sels.map((s) => ({ ...s, sp: M[s.mid].sp, lv: M[s.mid].lv, eid: String(M[s.mid].eid), t: M[s.mid].t }));
  if (!bet.combo || sels.length === 1) return { ok: true, odds: Number(sels[0].o), legs, groups: null };
  const c = E.comboCalc(sels.map((s) => ({ ...s, o: Number(s.o) })), (mid) => M[mid]);
  if (c.bad) return { error: "combo_impossible" };
  const claimed = Number(bet.odds);
  if (claimed > c.odds * TOL) return { error: "odds_changed", changed: [], combo: c.odds };
  return { ok: true, odds: Math.min(claimed || c.odds, c.odds * TOL), legs, groups: c.groups };
}
