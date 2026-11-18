// Classements ATP / WTA (top 150, flux ESPN), gardés 12 h en mémoire : servent aux cotes du tennis (appli et serveur)
import "../engine.js";
const E = globalThis.ENGINE;
let R = null, at = 0, pending = null;
async function getJSON(u) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), 6000);
  try { const r = await fetch(u.replace(/^http:/, "https:"), { signal: c.signal }); return r.ok ? r.json() : null; } catch (e) { return null; } finally { clearTimeout(t); }
}
async function one(tour) {
  const idx = await getJSON(`https://sports.core.api.espn.com/v2/sports/tennis/leagues/${tour}/rankings`);
  const ref = idx && idx.items && idx.items[0] && idx.items[0].$ref;
  const j = ref && await getJSON(ref);
  const out = {};
  for (const x of (j && j.ranks) || []) { const id = ((x.athlete && x.athlete.$ref) || "").match(/athletes\/(\d+)/); if (id && x.current) out[id[1]] = x.current; }
  return out;
}
export async function tennisRanks() {
  if (R && Date.now() - at < 12 * 3600e3) return R;
  if (!pending) pending = (async () => {
    const [atp, wta] = await Promise.all([one("atp"), one("wta")]);
    if (Object.keys(atp).length || Object.keys(wta).length) { R = { atp, wta }; at = Date.now(); E.setTennisRanks(R); }
    pending = null; return R || { atp: {}, wta: {} };
  })();
  return pending;
}
