// Prono du week-end : choix des matchs (flux ESPN), mise à jour des résultats et calcul des points.
import { frTeam } from "./_teams.js";
const ESPN = "https://site.api.espn.com/apis/site/v2/sports/";
// [compétition, nombre de matchs retenus]
const LEAGUES = [["soccer/fra.1", 3], ["soccer/eng.1", 1], ["soccer/esp.1", 1], ["soccer/ita.1", 1], ["soccer/ger.1", 1]];

async function getJSON(u) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), 9000);
  try { const r = await fetch(u, { signal: c.signal }); if (!r.ok) throw new Error(r.status); return await r.json(); }
  finally { clearTimeout(t); }
}
const ym = (ms) => { const d = new Date(ms); return d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, "0"); };
// points par victoire/nul/défaite d'après la fiche « V-N-D » de l'équipe
const recPts = (c) => { const s = c.records && c.records[0] && c.records[0].summary; const m = /^(\d+)-(\d+)-(\d+)$/.exec(s || ""); return m ? 3 * +m[1] + +m[2] : 0; };

function parse(ev, path) {
  const c = ev.competitions && ev.competitions[0];
  if (!c || !c.competitors || c.competitors.length < 2) return null;
  const H = c.competitors.find((x) => x.homeAway === "home") || c.competitors[0], A = c.competitors.find((x) => x.homeAway === "away") || c.competitors[1];
  const ty = (ev.status && ev.status.type) || {};
  const nm = (x) => frTeam((x.team && (x.team.shortDisplayName || x.team.displayName)) || "?");
  return { mid: "e-" + path.replace(/\W/g, "") + "-" + ev.id, path, eid: String(ev.id), h: nm(H), a: nm(A), hl: H.team && H.team.logo, al: A.team && A.team.logo,
    t: Date.parse(ev.date), state: ty.state || "pre", done: !!ty.completed, cancel: ty.state === "post" && !ty.completed,
    sh: ty.state === "pre" ? null : +H.score || 0, sa: ty.state === "pre" ? null : +A.score || 0, strength: recPts(H) + recPts(A) };
}

async function fetchLeague(path, from, to) {
  const months = [...new Set([ym(from), ym(to - 1)])];
  const out = [];
  for (const m of months) {
    const j = await getJSON(`${ESPN}${path}/scoreboard?dates=${m}&limit=500`);
    for (const ev of j.events || []) { const x = parse(ev, path); if (x && x.t >= from && x.t < to) out.push(x); }
  }
  return out;
}

// Les matchs qui restent aujourd'hui (pour les rappels), du plus attendu au moins attendu
const TODAY = ["soccer/fra.1", "soccer/uefa.champions", "rugby/270559", "soccer/uefa.nations", "soccer/eng.1", "soccer/esp.1", "soccer/fra.coupe_de_france",
  "soccer/ita.1", "soccer/ger.1", "soccer/uefa.europa", "rugby/289234", "rugby/271937", "soccer/fra.2", "soccer/uefa.europa.conf"];
export async function todayMatches(ymd, from, to) {
  const res = await Promise.all(TODAY.map((path, k) => getJSON(`${ESPN}${path}/scoreboard?dates=${ymd}&limit=200`)
    .then((j) => (j.events || []).map((ev) => parse(ev, path)).filter((x) => x && x.state === "pre" && x.t >= from && x.t < to).map((x) => ({ ...x, k })))
    .catch(() => [])));
  return res.flat().sort((a, b) => a.k - b.k || b.strength - a.strength || a.t - b.t);
}

// Les matchs du week-end (vendredi 0 h → lundi 0 h, heure de Paris)
export async function buildWeek(from, to) {
  const all = [];
  for (const [path, n] of LEAGUES) {
    try {
      const L = (await fetchLeague(path, from, to)).sort((a, b) => b.strength - a.strength || a.t - b.t);
      all.push(...L.slice(0, n));
    } catch (e) { /* compétition indisponible cette semaine */ }
  }
  return all.sort((a, b) => a.t - b.t).map(({ strength, ...m }) => m);
}

// Met à jour les scores des matchs commencés (au plus une requête par compétition)
export async function refreshResults(matches) {
  const now = Date.now();
  const need = matches.filter((m) => !m.done && !m.cancel && m.t < now);
  if (!need.length) return false;
  let changed = false;
  for (const path of [...new Set(need.map((m) => m.path))]) {
    try {
      const L = await fetchLeague(path, Math.min(...need.map((m) => m.t)) - 3600e3, now + 3600e3);
      for (const x of L) {
        const m = matches.find((y) => y.mid === x.mid);
        if (m && (m.sh !== x.sh || m.sa !== x.sa || m.done !== x.done || m.state !== x.state)) {
          Object.assign(m, { sh: x.sh, sa: x.sa, done: x.done, state: x.state, cancel: x.cancel }); changed = true;
        }
      }
    } catch (e) {}
  }
  return changed;
}

// 5 = score exact, 3 = bon vainqueur (ou nul) et bon écart, 2 = bon vainqueur (ou nul) ; joker ×2
export function points(m, p) {
  if (!m.done || m.sh == null || !p) return null;
  const sg = Math.sign(m.sh - m.sa), pg = Math.sign(p.sh - p.sa);
  let pts = 0;
  if (p.sh === m.sh && p.sa === m.sa) pts = 5;
  else if (sg === pg && m.sh - m.sa === p.sh - p.sa) pts = 3;
  else if (sg === pg) pts = 2;
  return p.joker ? pts * 2 : pts;
}
