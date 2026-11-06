// Seule fonction serveur de D'amateur à pro : comptes anonymes, ligues entre amis, classements,
// et « ce que parient les autres ». Tout passe par POST /api/game {action, ...}.
import { db, hashToken, newToken, ipKey, overLimit } from "./_db.js";

const ORIGINS = [
  "https://skelvo.fr", "https://www.skelvo.fr", "https://skelvo.github.io",
  "https://damateur-a-pro.vercel.app",
];
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sans 0/O ni 1/I
const MAX_LEAGUES = 12, MAX_MEMBERS = 60, MAX_BAL = 1e9;

const cleanName = (v, max) => String(v ?? "").replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo; };
const int = (v, lo, hi) => Math.round(num(v, lo, hi));
const fail = (status, error) => Object.assign(new Error(error), { status, error });

// Semaine en cours (lundi, heure de Paris) : sert au classement « cette semaine »
const WEEK = `to_char(date_trunc('week', now() at time zone 'Europe/Paris'), 'YYYY-MM-DD')`;
const BOARD_COLS = `p.id, p.name, p.bal::float8 as bal, p.peak::float8 as peak, p.won, p.lost,
  (case when p.week = ${WEEK} then p.bal - coalesce(p.week_bal, p.bal) else 0 end)::float8 as week_gain`;

async function me(s, token) {
  if (!token) throw fail(401, "no_session");
  const r = await s.query(`select id, name from players where token_hash = $1`, [hashToken(token)]);
  if (!r[0]) throw fail(401, "no_session");
  return r[0];
}

function newCode() {
  let c = "";
  for (let i = 0; i < 5; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return c;
}

async function myLeagues(s, pid) {
  const leagues = await s.query(
    `select l.code, l.name, l.owner = $1 as mine, (select count(*)::int from league_members m2 where m2.code = l.code) as n
       from leagues l join league_members m on m.code = l.code where m.player = $1 order by m.joined_at`, [pid]);
  return leagues;
}

// Stats qu'on peut déclarer par sport (mêmes clés que dans l'app) ; la 1re est le score, obligatoire.
const SPORTS = {
  foot: { maxLv: 9, keys: ["g", "sot", "co", "of", "fo", "yc", "rc", "pk"] },
  rugby: { maxLv: 8, keys: ["pts", "tr", "cv", "pm", "px", "dr", "yc", "rc"] },
  tennis: { maxLv: 5, keys: ["sets", "gm", "ac", "df", "brk", "tb", "rk", "s1"] },
};
function cleanStats(sp, st) {
  if (!st || typeof st !== "object") return null;
  const out = {};
  for (const k of SPORTS[sp].keys) {
    const v = st[k];
    if (!Array.isArray(v) || v.length !== 2) continue;
    const a = Number(v[0]), b = Number(v[1]);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a > 300 || b > 300) continue;
    out[k] = [a, b];
  }
  const main = SPORTS[sp].keys[0];
  if (!out[main]) return null;
  if (sp === "tennis" && out.sets[0] === out.sets[1]) return null;
  return out;
}
// Résultat validé : le même score déclaré par 2 joueurs (et plus que tout autre score), ou une seule
// déclaration sans contradiction depuis 24 h. Pour chaque stat : la valeur la plus déclarée parmi
// ceux qui ont donné ce score.
function verdict(m, R) {
  if (!R.length) return { res: null, conf: 0 };
  const main = SPORTS[m.sp].keys[0], key = (st) => JSON.stringify(st[main]);
  const groups = {};
  for (const r of R) (groups[key(r.st)] ??= []).push(r);
  const G = Object.values(groups).sort((x, y) => y.length - x.length);
  const best = G[0];
  const ok = (best.length >= 2 && (G.length === 1 || best.length > G[1].length)) ||
    (G.length === 1 && best.length === 1 && Date.now() - Math.min(...best.map((r) => Number(r.ams))) > 24 * 3600e3);
  if (!ok) return { res: null, conf: best.length, conflict: G.length > 1 };
  const res = {};
  for (const k of SPORTS[m.sp].keys) {
    const c = {};
    for (const r of best) if (r.st[k]) c[JSON.stringify(r.st[k])] = (c[JSON.stringify(r.st[k])] || 0) + 1;
    const top = Object.entries(c).sort((x, y) => y[1] - x[1]);
    if (top[0] && (!top[1] || top[0][1] > top[1][1])) res[k] = JSON.parse(top[0][0]);
  }
  return { res, conf: best.length };
}

const ACTIONS = {
  // Crée un joueur anonyme. Le jeton n'est gardé qu'en empreinte sha256.
  async session(s, b, req) {
    if (await overLimit(ipKey(req) + ":new", 30, 3600)) throw fail(429, "slow_down");
    const token = newToken();
    const bal = b.bal == null ? 1000 : num(b.bal, 0, MAX_BAL);
    const r = await s.query(
      `insert into players (token_hash, name, bal, peak, won, lost, week, week_bal)
       values ($1, $2, $3::numeric, greatest($3::numeric, $4::numeric), $5::int, $6::int, ${WEEK}, $3::numeric) returning id`,
      [hashToken(token), cleanName(b.name, 18) || "Joueur", bal, b.peak == null ? bal : num(b.peak, 0, MAX_BAL), int(b.won, 0, 1e7), int(b.lost, 0, 1e7)]);
    return { token, id: r[0].id };
  },

  // Envoie le profil du joueur (pseudo, solde, record, bilan). Le solde de début de semaine est
  // retenu au premier envoi de chaque semaine : « cette semaine » = solde actuel − solde du lundi.
  async sync(s, b) {
    const p = await me(s, b.token);
    const name = cleanName(b.name, 18) || p.name;
    await s.query(
      `update players set
         week_bal = case when week is distinct from ${WEEK} then bal else week_bal end,
         week = ${WEEK},
         name = $2, bal = $3::numeric, peak = greatest(peak, $4::numeric, $3::numeric), won = $5::int, lost = $6::int, seen_at = now()
       where id = $1`,
      [p.id, name, num(b.bal, 0, MAX_BAL), num(b.peak, 0, MAX_BAL), int(b.won, 0, 1e7), int(b.lost, 0, 1e7)]);
    return { ok: true };
  },

  async create_league(s, b) {
    const p = await me(s, b.token);
    const name = cleanName(b.name, 24);
    if (!name) throw fail(400, "name");
    const n = (await s.query(`select count(*)::int as n from league_members where player = $1`, [p.id]))[0].n;
    if (n >= MAX_LEAGUES) throw fail(400, "too_many");
    for (let i = 0; i < 8; i++) {
      const code = newCode();
      const r = await s.query(`insert into leagues (code, name, owner) values ($1, $2, $3) on conflict do nothing returning code`, [code, name, p.id]);
      if (r[0]) {
        await s.query(`insert into league_members (code, player) values ($1, $2)`, [code, p.id]);
        return { code };
      }
    }
    throw fail(500, "code");
  },

  async join_league(s, b, req) {
    const p = await me(s, b.token);
    if (await overLimit(ipKey(req) + ":join", 40, 3600)) throw fail(429, "slow_down");
    const code = cleanName(b.code, 8).toUpperCase().replace(/[^A-Z0-9]/g, "");
    const l = (await s.query(`select code, name, (select count(*)::int from league_members m where m.code = leagues.code) as n from leagues where code = $1`, [code]))[0];
    if (!l) throw fail(404, "unknown");
    const already = (await s.query(`select 1 from league_members where code = $1 and player = $2`, [code, p.id]))[0];
    if (!already) {
      if (l.n >= MAX_MEMBERS) throw fail(400, "full");
      const n = (await s.query(`select count(*)::int as n from league_members where player = $1`, [p.id]))[0].n;
      if (n >= MAX_LEAGUES) throw fail(400, "too_many");
      await s.query(`insert into league_members (code, player) values ($1, $2) on conflict do nothing`, [code, p.id]);
    }
    return { code, name: l.name, already: !!already };
  },

  async leave_league(s, b) {
    const p = await me(s, b.token);
    const code = cleanName(b.code, 8).toUpperCase();
    await s.query(`delete from league_members where code = $1 and player = $2`, [code, p.id]);
    // ligue vide : on la supprime
    await s.query(`delete from leagues where code = $1 and not exists (select 1 from league_members where code = $1)`, [code]);
    return { ok: true };
  },

  // Mes ligues + le classement de celle demandée (ou le général si code = "")
  async boards(s, b) {
    const p = await me(s, b.token);
    const leagues = await myLeagues(s, p.id);
    const code = cleanName(b.code, 8).toUpperCase();
    let rows, total = null, rank = null;
    if (code && leagues.some((l) => l.code === code)) {
      rows = await s.query(`select ${BOARD_COLS} from players p join league_members m on m.player = p.id where m.code = $1`, [code]);
    } else {
      // général : les 100 meilleurs de la semaine et au total, plus ma place
      rows = await s.query(
        `(select ${BOARD_COLS} from players p where p.seen_at > now() - interval '60 days' order by p.bal desc limit 100)
         union
         (select ${BOARD_COLS} from players p where p.week = ${WEEK} order by p.bal - coalesce(p.week_bal, p.bal) desc limit 100)
         union
         (select ${BOARD_COLS} from players p where p.id = $1)`, [p.id]);
      total = (await s.query(`select count(*)::int as n from players where seen_at > now() - interval '60 days'`))[0].n;
      rank = (await s.query(
        `select count(*)::int + 1 as r from players where seen_at > now() - interval '60 days' and bal > (select bal from players where id = $1)`, [p.id]))[0].r;
    }
    return {
      me: p.id, leagues, code: code && leagues.some((l) => l.code === code) ? code : "", total, rank,
      rows: rows.map((r) => ({ id: r.id, name: r.name, bal: Math.round(r.bal), peak: Math.round(r.peak), won: r.won, lost: r.lost, week: Math.round(r.week_gain) })),
    };
  },

  // Enregistre les choix du joueur (un par match et par marché) pour « ce que parient les autres »
  async picks(s, b) {
    const p = await me(s, b.token);
    const list = Array.isArray(b.picks) ? b.picks.slice(0, 20) : [];
    for (const x of list) {
      const mid = cleanName(x.mid, 80), mk = cleanName(x.mk, 24), k = int(x.k, 0, 9);
      if (!mid || !mk) continue;
      await s.query(
        `insert into picks (mid, mk, k, player) values ($1, $2, $3, $4) on conflict (mid, mk, player) do update set k = excluded.k, at = now()`,
        [mid, mk, k, p.id]);
    }
    return { ok: true };
  },

  // ---- Matchs amateurs ajoutés par les joueurs (visibles par tous) ----
  async am_add(s, b) {
    const p = await me(s, b.token);
    const sp = SPORTS[b.sp] ? b.sp : null;
    if (!sp) throw fail(400, "sport");
    const h = cleanName(b.h, 32), a = cleanName(b.a, 32);
    if (!h || !a || h.toLowerCase() === a.toLowerCase()) throw fail(400, "teams");
    const t = Number(b.t);
    if (!Number.isFinite(t) || t < Date.now() - 6 * 3600e3 || t > Date.now() + 60 * 86400e3) throw fail(400, "date");
    const n = (await s.query(`select count(*)::int as n from am_matches where created_by = $1 and created_at > now() - interval '1 day'`, [p.id]))[0].n;
    if (n >= 25) throw fail(429, "slow_down");
    const fav = int(b.fav, 0, 4), sv = [[0, 0], [0.6, -0.2], [-0.2, 0.6], [1.2, -0.5], [-0.5, 1.2]][fav];
    const id = "a-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    await s.query(
      `insert into am_matches (id, sp, lv, dep, h, a, t, s, created_by) values ($1, $2, $3, $4, $5, $6, to_timestamp($7::float8 / 1000), $8::jsonb, $9)`,
      [id, sp, int(b.lv, 0, SPORTS[sp].maxLv), cleanName(b.dep, 40), h, a, t, JSON.stringify(sv), p.id]);
    return { id };
  },

  // Matchs amateurs d'une période (ou par identifiants), avec le résultat validé par les déclarations
  async am_list(s, b) {
    const p = b.token ? (await s.query(`select id from players where token_hash = $1`, [hashToken(b.token)]))[0] : null;
    const ids = (Array.isArray(b.ids) ? b.ids : []).slice(0, 80).map((x) => cleanName(x, 40)).filter(Boolean);
    const rows = ids.length
      ? await s.query(`select *, extract(epoch from t) * 1000 as tms from am_matches where id = any($1) and not hidden`, [ids])
      : await s.query(`select *, extract(epoch from t) * 1000 as tms from am_matches
          where not hidden and t > now() - interval '6 days' and t < now() + interval '30 days' order by t limit 500`);
    if (!rows.length) return { matches: [] };
    const reps = await s.query(`select mid, player, st, extract(epoch from at) * 1000 as ams from am_reports where mid = any($1)`, [rows.map((r) => r.id)]);
    const by = {};
    for (const r of reps) (by[r.mid] ??= []).push(r);
    return {
      matches: rows.map((r) => {
        const R = by[r.id] || [];
        const mine = p && R.find((x) => String(x.player) === String(p.id));
        return {
          id: r.id, sp: r.sp, lv: r.lv, dep: r.dep, h: r.h, a: r.a, t: Math.round(Number(r.tms)), s: r.s,
          mine: !!(p && String(r.created_by) === String(p.id)), nrep: R.length, my: mine ? mine.st : null,
          ...verdict(r, R),
        };
      }),
    };
  },

  // Déclarer le score (et les stats connues) d'un match amateur terminé
  async am_report(s, b) {
    const p = await me(s, b.token);
    const m = (await s.query(`select *, extract(epoch from t) * 1000 as tms from am_matches where id = $1 and not hidden`, [cleanName(b.mid, 40)]))[0];
    if (!m) throw fail(404, "unknown");
    if (Date.now() < Number(m.tms) + 45 * 60e3) throw fail(400, "too_early");
    const st = cleanStats(m.sp, b.st);
    if (!st) throw fail(400, "score");
    await s.query(
      `insert into am_reports (mid, player, st) values ($1, $2, $3::jsonb) on conflict (mid, player) do update set st = excluded.st, at = now()`,
      [m.id, p.id, JSON.stringify(st)]);
    return { ok: true };
  },

  // Retirer un match qu'on a ajouté (tant que personne n'a déclaré de score)
  async am_remove(s, b) {
    const p = await me(s, b.token);
    const r = await s.query(
      `update am_matches set hidden = true where id = $1 and created_by = $2 and not exists (select 1 from am_reports where mid = $1) returning id`,
      [cleanName(b.mid, 40), p.id]);
    if (!r[0]) throw fail(400, "locked");
    return { ok: true };
  },

  async pick_stats(s, b) {
    const mids = (Array.isArray(b.mids) ? b.mids : []).slice(0, 80).map((m) => cleanName(m, 80)).filter(Boolean);
    if (!mids.length) return { stats: {} };
    const r = await s.query(`select mid, mk, k, count(*)::int as n from picks where mid = any($1) group by mid, mk, k`, [mids]);
    const stats = {};
    for (const x of r) ((stats[x.mid] ??= {})[x.mk] ??= {})[x.k] = x.n;
    return { stats };
  },
};

export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  if (ORIGINS.includes(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET") return res.status(200).json({ ok: true, service: "damateur-a-pro" });
  if (req.method !== "POST") return res.status(405).json({ error: "method" });
  try {
    let b = req.body;
    if (typeof b === "string") b = JSON.parse(b || "{}");
    b ||= {};
    const fn = ACTIONS[b.action];
    if (!fn) return res.status(400).json({ error: "action" });
    if (await overLimit(ipKey(req) + ":all", 400, 60)) throw fail(429, "slow_down");
    const s = await db();
    res.status(200).json(await fn(s, b, req));
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.error });
    console.error(e);
    res.status(500).json({ error: "server" });
  }
}
