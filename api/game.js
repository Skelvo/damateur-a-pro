// Seule fonction serveur de Tribune : comptes anonymes, guildes entre amis, classements,
// et « ce que parient les autres ». Tout passe par POST /api/game {action, ...}.
import * as SOCIAL from "./_social.js";
import { db, hashToken, newToken, ipKey, overLimit } from "./_db.js";
import { timingSafeEqual, randomInt } from "node:crypto";
import { buildWeek, refreshResults, points, todayMatches, bestOfDay } from "./_prono.js";
import { notify, members } from "./_push.js";
import { checkBet, settleOpen, cashValueServer, loadMatch } from "./_bets.js";

const ORIGINS = [
  "https://skelvo.fr", "https://www.skelvo.fr", "https://skelvo.github.io",
  "https://damateur-a-pro.vercel.app",
];
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sans 0/O ni 1/I
const MAX_LEAGUES = 12, MAX_MEMBERS = 100, MAX_BAL = 1e9;

const cleanName = (v, max) => String(v ?? "").replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo; };
const int = (v, lo, hi) => Math.round(num(v, lo, hi));
const fail = (status, error) => Object.assign(new Error(error), { status, error });
function admin(b) {
  const want = process.env.ADMIN_KEY || "", got = String(b.key || "");
  if (want.length < 24 || got.length !== want.length || !timingSafeEqual(Buffer.from(got), Buffer.from(want))) throw fail(403, "forbidden");
}
// La semaine du prono : construite au premier appel (matchs du week-end), résultats rafraîchis toutes les 3 min
async function pronoWeek(s, noRefresh) {
  const w = (await s.query(
    `select ${WEEK} as w,
       extract(epoch from ((date_trunc('week', now() at time zone 'Europe/Paris') + interval '4 days') at time zone 'Europe/Paris')) * 1000 as fri,
       extract(epoch from ((date_trunc('week', now() at time zone 'Europe/Paris') + interval '7 days') at time zone 'Europe/Paris')) * 1000 as mon`))[0];
  const from = Math.round(Number(w.fri)), to = Math.round(Number(w.mon));
  let row = (await s.query(`select matches, extract(epoch from updated_at) * 1000 as up from prono_weeks where week = $1`, [w.w]))[0];
  if (!row || (!row.matches.length && Date.now() - Number(row.up) > 30 * 60e3)) {
    const matches = await buildWeek(from, to);
    await s.query(`insert into prono_weeks (week, matches) values ($1, $2::jsonb) on conflict (week) do update set matches = case when jsonb_array_length(prono_weeks.matches) = 0 then excluded.matches else prono_weeks.matches end, updated_at = now()`,
      [w.w, JSON.stringify(matches)]);
    row = (await s.query(`select matches, extract(epoch from updated_at) * 1000 as up from prono_weeks where week = $1`, [w.w]))[0];
  } else if (!noRefresh && Date.now() - Number(row.up) > 3 * 60e3) {
    const M = row.matches;
    if (await refreshResults(M)) await s.query(`update prono_weeks set matches = $2::jsonb, updated_at = now() where week = $1`, [w.w, JSON.stringify(M)]);
    else await s.query(`update prono_weeks set updated_at = now() where week = $1`, [w.w]);
    row.matches = M;
  }
  return { week: w.w, from, to, matches: row.matches };
}
const lname = async (s, code) => ((await s.query(`select name from leagues where code = $1`, [code]))[0] || {}).name || "ta guilde";
const go = (view, code) => `./?go=${view}&code=${encodeURIComponent(code)}`;
const isDarkMember = async (s, code, pid) => !!(code && (await s.query(`select 1 from league_members m join leagues l on l.code = m.code and l.dark where m.code = $1 and m.player = $2`, [code, pid]))[0]);
const isMember = async (s, code, pid) => !!(code && (await s.query(`select 1 from league_members where code = $1 and player = $2`, [code, pid]))[0]);
const ACT_KINDS = ["bet", "won", "cash", "wheel", "defis", "duel", "duelwin", "join"];
const EMOS = ["🔥", "😂", "👏", "😱"];
// violation de l'index unique sur le pseudo
const isTaken = (e) => e && (e.code === "23505" || /players_name_u|duplicate key/i.test(String(e.message)));

// Semaine en cours (lundi, heure de Paris) : sert au classement « cette semaine »
const WEEK = `to_char(date_trunc('week', now() at time zone 'Europe/Paris'), 'YYYY-MM-DD')`;
// Saison en cours = mois (heure de Paris), le classement de la saison repart à zéro le 1er
const MONTH = `to_char(now() at time zone 'Europe/Paris', 'YYYY-MM')`;
const PREV_WEEK = `to_char(date_trunc('week', now() at time zone 'Europe/Paris') - interval '7 days', 'YYYY-MM-DD')`;
const PREV_MONTH = `to_char(date_trunc('month', now() at time zone 'Europe/Paris') - interval '1 month', 'YYYY-MM')`;
const BOARD_COLS = `p.id, p.name, p.cos, coalesce((select x.xp from pxp x where x.player = p.id), 0) as xp, p.bal::float8 as bal, p.peak::float8 as peak, p.won, p.lost, p.avatar_v, p.fav, p.badges,
  coalesce((select x.gain from sprofits x where x.player = p.id and x.per = ${WEEK}), 0)::float8 as week_gain,
  coalesce((select x.gain from sprofits x where x.player = p.id and x.per = ${MONTH}), 0)::float8 as month_gain`;
// Gains par semaine (ou par mois) des membres d'une guilde, y compris la dernière période de ceux
// qui n'ont pas rouvert l'app depuis ; rk = place dans la guilde pour cette période.
// Depuis le 9 novembre 2026, seuls les PARIS comptent (vue sprofits : paris réglés par le serveur, impossible à trafiquer) :
// la roue, les défis, le prono et le match de la guilde ne comptent plus. Avant, c'était l'écart de solde.
const CUT = { week: "2026-11-09", month: "2026-11" };
const periodGains = (tbl, col, cur, bal) => `with mem as (select player from league_members where code = $1),
  g as (select pr.player, pr.per, pr.gain from sprofits pr join mem on mem.player = pr.player where length(pr.per) = ${col === "week" ? 10 : 7} and pr.per >= '${CUT[col]}'
        union all
        select w.player, w.${col} as per, w.gain from ${tbl} w join mem on mem.player = w.player where w.${col} < '${CUT[col]}'
        union all
        select p.id, p.${col}, p.bal - coalesce(p.${bal}, p.bal) from players p join mem on mem.player = p.id
          where p.${col} is not null and p.${col} <> ${cur} and p.${col} < '${CUT[col]}'
            and not exists (select 1 from ${tbl} w2 where w2.player = p.id and w2.${col} = p.${col})),
  r as (select player, per, gain::float8 as gain, rank() over (partition by per order by gain desc) as rk from g)`;
const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const monthName = (m) => MONTHS[Number(String(m).slice(5, 7)) - 1] || m;

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
    `select l.code, l.name, l.owner = $1 as mine, l.prizes, l.emblem, l.motto, l.access, l.elo, l.champ, m.role, (select count(*)::int from requests rq where rq.code = l.code) as nreq, (select count(*)::int from league_members m2 where m2.code = l.code) as n
       from leagues l join league_members m on m.code = l.code where m.player = $1 and not l.dark order by m.joined_at`, [pid]);
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

// ---- Bilan de la semaine passée d'une guilde (calculé à la demande, rien n'est stocké) ----
async function recapFor(s, code) {
  const per = (await s.query(`select ${PREV_WEEK} as w,
      extract(epoch from ((date_trunc('week', now() at time zone 'Europe/Paris') - interval '7 days') at time zone 'Europe/Paris')) * 1000 as a,
      extract(epoch from (date_trunc('week', now() at time zone 'Europe/Paris') at time zone 'Europe/Paris')) * 1000 as b`))[0];
  const from = Math.round(Number(per.a)), to = Math.round(Number(per.b));
  const mem = await s.query(`select pl.id, pl.name, pl.avatar_v, pl.bets from league_members m join players pl on pl.id = m.player where m.code = $1`, [code]);
  const who = Object.fromEntries(mem.map((x) => [String(x.id), x]));
  const P = (id, extra) => { const x = who[String(id)]; return x ? { id: x.id, name: x.name, av: x.avatar_v || 0, ...extra } : null; };
  const g = (await s.query(`${periodGains("weekly", "week", WEEK, "week_bal")}
     select player, gain from r where per = $2 order by gain desc`, [code, per.w])).filter((x) => who[String(x.player)] && Math.round(x.gain) !== 0);
  const podium = g.filter((x) => x.gain > 0).slice(0, 3).map((x) => P(x.player, { gain: Math.round(x.gain) }));
  const worst = g[g.length - 1];
  const red = worst && worst.gain < 0 && g.length >= 2 ? P(worst.player, { gain: Math.round(worst.gain) }) : null;
  // paris de la semaine (les 40 derniers de chacun, gardés sur le serveur pour les fiches)
  let odds = null, flop = null, busy = null, nb = 0, staked = 0;
  for (const x of mem) {
    const list = (x.bets && x.bets.list) || [];
    let n = 0;
    for (const b of list) {
      const t = Number(b.done || b.at) || 0, placed = Number(b.at) || 0;
      if (placed >= from && placed < to) { n++; staked += Number(b.stake) || 0; }
      if (t < from || t >= to) continue;
      const legs = (b.legs || []).slice(0, 4).map((L) => L.l);
      if (b.st === "won" && (!odds || b.odds > odds.odds)) odds = P(x.id, { odds: Number(b.odds) || 0, pay: Number(b.pay) || 0, legs });
      if (b.st === "lost" && (!flop || b.stake > flop.stake || (b.stake === flop.stake && b.odds < flop.odds))) flop = P(x.id, { stake: Number(b.stake) || 0, odds: Number(b.odds) || 0, legs });
    }
    nb += n;
    if (n && (!busy || n > busy.n)) busy = P(x.id, { n });
  }
  if (odds && odds.odds < 1.5) odds = null;
  // prono du week-end
  let prono = null;
  const wk = (await s.query(`select matches from prono_weeks where week = $1`, [per.w]))[0];
  if (wk) {
    const picks = await s.query(`select player, mid, sh, sa, joker from prono_picks where week = $1 and player = any($2::bigint[])`, [per.w, mem.map((x) => x.id)]);
    const pts = {};
    for (const x of picks) { const M = wk.matches.find((m) => m.mid === x.mid); const pt = M ? points(M, x) : null; if (pt != null) pts[x.player] = (pts[x.player] || 0) + pt; }
    const best = Math.max(0, ...Object.values(pts));
    if (best > 0) prono = { pts: best, who: Object.keys(pts).filter((k) => pts[k] === best).map((k) => P(k, {})).filter(Boolean),
      done: wk.matches.every((m) => m.done || m.cancel) };
  }
  // duels gagnés
  let duel = null;
  const dw = await s.query(`select winner, count(*)::int as n from duels where code = $1 and status = 'done' and winner is not null
      and t >= to_timestamp($2 / 1000.0) and t < to_timestamp($3 / 1000.0) group by winner order by n desc limit 1`, [code, from, to]);
  if (dw[0]) duel = P(dw[0].winner, { n: dw[0].n });
  return { week: per.w, from, to, podium, red, odds, flop, busy, prono, duel, bets: nb, staked: Math.round(staked),
    empty: !podium.length && !odds && !flop && !prono && !duel };
}

// ---- Tâche du matin (Vercel Cron, chaque jour vers 8 h) : notifications du bilan (lundi) et de la saison (le 1er) ----
async function morning(s) {
  // règles : signalements et messages aux organisateurs gardés au plus un an
  try { await s.query(`delete from reports where at < now() - interval '1 year'`); } catch (e) { console.error(e); }
  const t = (await s.query(`select extract(isodow from now() at time zone 'Europe/Paris')::int as dow,
      extract(day from now() at time zone 'Europe/Paris')::int as day, ${PREV_WEEK} as w, ${PREV_MONTH} as m`))[0];
  const once = async (key) => !!(await s.query(`insert into meta (key, value) values ($1, '1') on conflict do nothing returning key`, [key]))[0];
  const leagues = await s.query(`select l.code, l.name from leagues l where not l.dark and (select count(*) from league_members m where m.code = l.code) >= 2`);
  const out = { recap: 0, season: 0 };
  try { out.battles = await battlesTick(s); } catch (e) { console.error("battles", e); }
  const today = await parisDay(s), we = EG.weekendOf(today);
  if (t.dow === 6 && we.on && await once("we:" + today)) {
    const to = (await s.query(`select distinct player from push_subs`)).map((x) => x.player);
    await notify(s, to, { title: `${we.e} ${we.n} !`, body: `${we.d} Jusqu'à dimanche minuit, profites-en !`, url: "./", tag: "weekend" });
    out.weekend = to.length;
  }
  if (t.day === 1 && await once("season:" + t.m)) {
    await ensurePrizes(s, t.m);
    const mine = await s.query(`select p.player, p.rank, p.amount, l.name from month_prizes p join leagues l on l.code = p.code where p.month = $1 and not p.claimed`, [t.m]);
    const byP = {};
    for (const x of mine) (byP[x.player] ??= []).push(x);
    const done = new Set();
    for (const L of leagues) {
      const w = await s.query(`${periodGains("monthly", "month", MONTH, "month_bal")}
         select r.player, r.gain, pl.name from r join players pl on pl.id = r.player where r.per = $2 and r.rk = 1 and r.gain > 0`, [L.code, t.m]);
      if (!w.length) continue;
      const to = (await members(s, L.code)).filter((id) => !done.has(String(id)));
      to.forEach((id) => done.add(String(id)));
      const champ = `${w.map((x) => x.name).join(" et ")} ${w.length > 1 ? "sont champions du mois" : "est champion du mois"} avec +${Math.round(w[0].gain)} jetons.`;
      for (const id of to) {
        const pr = (byP[id] || []).find((x) => x.name === L.name);
        await notify(s, [id], { title: `👑 Classement de ${monthName(t.m)} terminé · ${L.name}`,
          body: champ + (pr ? ` Toi : ${pr.rank}${pr.rank === 1 ? "er" : "e"}, tu gagnes +${pr.amount} jetons 🎁` : " Nouveau mois : tout le monde repart à zéro !"),
          url: go("rank", L.code), tag: "season-" + L.code });
      }
      out.season++;
    }
  }
  if (t.dow === 1 && await once("recap:" + t.w)) {
    const done = new Set();
    for (const L of leagues) {
      const r = await recapFor(s, L.code);
      if (r.empty) continue;
      const to = (await members(s, L.code)).filter((id) => !done.has(String(id)));
      to.forEach((id) => done.add(String(id)));
      const top = r.podium[0];
      await notify(s, to, { title: `🏆 Le bilan de la semaine · ${L.name}`,
        body: top ? `${top.name} gagne la semaine avec +${top.gain} jetons. Qui a fait le plus gros flop ? Viens voir !` : "Plus grosse cote, plus gros flop, roi du prono… Viens voir !",
        url: go("recap", L.code), tag: "recap-" + L.code });
      out.recap++;
    }
  }
  return out;
}

// ---- Rappels pour parier (Vercel Cron : midi et 18 h, heure de Paris) ----
// Seulement pour ceux qui ont les notifications, pas ouvert l'app depuis 1 h 30, et avec un vrai contenu.
const hhmm = (t) => new Date(t).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" }).replace(":", "h");
// ---- Récap du dimanche soir : la semaine de chaque joueur (paris réglés par le serveur) et sa place dans sa guilde ----
async function weeklyRecap(s) {
  const t = (await s.query(`select to_char(date_trunc('week', now() at time zone 'Europe/Paris'), 'YYYY-MM-DD') as per, extract(isodow from now() at time zone 'Europe/Paris')::int as dow`))[0];
  if (t.dow !== 7 && !globalThis.__dapAnyDay) return { skipped: "pas dimanche" };   // __dapAnyDay : tests en local
  const ppl = await s.query(`select p.id, p.name,
      count(b.id) filter (where b.status in ('won','lost','cashed'))::int as n,
      count(b.id) filter (where b.status in ('won','cashed'))::int as w,
      coalesce(sum(case when b.status = 'lost' then -b.stake when b.status in ('won','cashed') then coalesce(b.pay,0) - b.stake else 0 end), 0)::float8 as g,
      max(b.odds) filter (where b.status = 'won')::float8 as best
    from players p join bets b on b.player = p.id and b.settled_at >= date_trunc('week', now() at time zone 'Europe/Paris') at time zone 'Europe/Paris'
    where exists (select 1 from push_subs x where x.player = p.id)
    group by p.id, p.name having count(b.id) filter (where b.status in ('won','lost','cashed')) > 0`);
  let sent = 0;
  for (const p of ppl) {
    if (!(await sentOnce(s, `recap:${t.per}:${p.id}`))) continue;
    const r = (await s.query(`with my as (select m.code, l.name, (select count(*) from league_members x where x.code = m.code) as n
          from league_members m join leagues l on l.code = m.code where m.player = $1 and not l.dark order by n desc limit 1),
        b as (select m.player, coalesce((select gain from sprofits sp where sp.player = m.player and sp.per = $2), 0) as g from league_members m join my on my.code = m.code)
      select my.code, my.name, my.n, (select count(*) from b where b.g > (select g from b where player = $1)) + 1 as rk from my`, [p.id, t.per]))[0];
    const fr = (v) => String(Math.round(v * 100) / 100).replace(".", ","), g = Math.round(p.g);
    let body = `${p.n} pari${p.n > 1 ? "s" : ""} réglé${p.n > 1 ? "s" : ""} · ${p.w} gagné${p.w > 1 ? "s" : ""} · ${g > 0 ? "+" : ""}${g} jeton${Math.abs(g) > 1 ? "s" : ""}.`;
    if (r && Number(r.n) >= 2) body += ` ${Number(r.rk) === 1 ? "🥇 1er" : Number(r.rk) + "e"} sur ${r.n} dans « ${r.name} ».`;
    if (p.best) body += ` Meilleur coup : cote ${fr(p.best)} 🔥`;
    await notify(s, [p.id], { title: g > 0 ? "📊 Belle semaine sur Tribune !" : "📊 Ta semaine sur Tribune", body: body + " Nouvelle semaine demain : à toi de jouer !",
      url: r ? go("rank", r.code) : "./", tag: "recap" });
    sent++;
  }
  return { sent, players: ppl.length };
}

async function reminders(s, slot) {
  const t = (await s.query(`select to_char(now() at time zone 'Europe/Paris', 'YYYYMMDD') as ymd, extract(isodow from now() at time zone 'Europe/Paris')::int as dow,
      extract(epoch from ((date_trunc('day', now() at time zone 'Europe/Paris') + interval '1 day') at time zone 'Europe/Paris')) * 1000 as eod`))[0];
  // samedi soir : où en est le combat de la guilde, pour motiver tout le monde avant le dernier jour
  if (slot === "soir" && t.dow === 6) try {
    const live = await s.query(`select bt.id, bt.a, bt.b, la.name as na, lb.name as nb from battles bt join leagues la on la.code = bt.a join leagues lb on lb.code = bt.b where bt.status = 'live' and bt.week = ${WEEK}`);
    const sc = await battleScores(s, live.map((x) => x.id));
    for (const x of live) for (const [c, o, n, on] of [[x.a, x.b, x.na, x.nb], [x.b, x.a, x.nb, x.na]]) {
      if (!(await sentOnce(s, `bsat:${x.id}:${c}`))) continue;
      const my = (sc[x.id + "|" + c] || { avg: 0 }).avg, th = (sc[x.id + "|" + o] || { avg: 0 }).avg, sg = (v) => (v > 0 ? "+" : "") + v;
      const to = (await s.query(`select player from battle_members where battle = $1 and code = $2`, [x.id, c])).map((y) => y.player);
      await notify(s, to, { title: my > th ? `⚔️ ${n} mène contre ${on} !` : my < th ? `⚔️ ${n} est menée par ${on}` : `⚔️ Égalité parfaite contre ${on}`,
        body: `${sg(my)} à ${sg(th)} de moyenne. ${my >= th ? "Tenez bon : il reste dimanche !" : "Il reste dimanche pour renverser, chaque pari compte !"}`, url: go("fights", c), tag: "battle-" + x.id });
    }
  } catch (e) { console.error("bsat", e); }
  const key = `remind:${slot}:${t.ymd}`;
  if (!(await s.query(`insert into meta (key, value) values ($1, '1') on conflict do nothing returning key`, [key]))[0]) return { skipped: "déjà fait" };
  const min = slot === "midi" ? 1 : 2;
  const ppl = await s.query(`select p.id, p.name, p.fav from players p where p.remind >= $1 and p.seen_at < now() - interval '90 minutes'
      and exists (select 1 from push_subs x where x.player = p.id)`, [min]);
  if (!ppl.length) return { sent: 0 };
  const now = Date.now(), M = await todayMatches(t.ymd, now + 20 * 60e3, Math.round(Number(t.eod)));
  const top = M[0], more = M.length - 1;
  const tonight = top ? `${top.h} – ${top.a} à ${hhmm(top.t)}${more > 0 ? ` et ${more} autre${more > 1 ? "s" : ""} match${more > 1 ? "s" : ""}` : ""}` : "";
  // prono du week-end (vendredi, samedi) : matchs pas encore commencés et pas encore pronostiqués
  let pr = null;
  if (t.dow === 5 || t.dow === 6) {
    const wk = await pronoWeek(s, true);
    const open = wk.matches.filter((m) => !m.done && !m.cancel && m.t > now + 20 * 60e3);
    if (open.length) pr = { week: wk.week, open, first: Math.min(...open.map((m) => m.t)) };
  }
  const lm = await dayMatch(s).catch(() => null);
  const jobs = ppl.map(async (p) => {
    let msg = null;
    if (pr) {
      const mine = new Set((await s.query(`select mid from prono_picks where week = $1 and player = $2`, [pr.week, p.id])).map((x) => x.mid));
      const left = pr.open.filter((m) => !mine.has(m.mid)).length;
      const lg = (await s.query(`select code from league_members where player = $1 and code not in (select code from leagues where dark) order by joined_at limit 1`, [p.id]))[0];
      if (left && lg) msg = { title: "🎯 Prono du week-end", body: `Il te reste ${left} match${left > 1 ? "s" : ""} à pronostiquer, premier coup d'envoi à ${hhmm(pr.first)}. Le score exact rapporte 50 jetons !`, url: go("prono", lg.code), tag: "remind-prono" };
    }
    const fm = p.fav && slot === "midi" ? M.find((m) => m.hid === p.fav.id || m.aid === p.fav.id) : null;
    if (!msg && fm) msg = { title: `❤️ ${p.fav.name} joue aujourd'hui`, body: `${fm.h} – ${fm.a} à ${hhmm(fm.t)}. Tu paries sur ton équipe ?`, url: "./", tag: "remind-fav" };
    if (!msg && lm && lm.cur && lm.cur.day === t.ymd && lm.cur.match.t > now + 20 * 60e3 && !(await s.query(`select 1 from lm_picks where day = $1 and player = $2`, [lm.cur.day, p.id]))[0]) {
      const lg = (await s.query(`select m.code, (select count(*)::int from lm_picks x join league_members m2 on m2.player = x.player and m2.code = m.code where x.day = $2) as n
          from league_members m where m.player = $1 and m.code not in (select code from leagues where dark) order by m.joined_at limit 1`, [p.id, lm.cur.day]))[0];
      if (lg) msg = { title: "⚽ Match de la guilde", body: `${lm.cur.match.h} – ${lm.cur.match.a} à ${hhmm(lm.cur.match.t)}. ${lg.n ? `${lg.n} collègue${lg.n > 1 ? "s ont" : " a"} déjà voté` : "Personne n'a encore voté"}, et toi ? Bonne réponse = +${LM_PRIZE} jetons.`, url: go("rank", lg.code), tag: "remind-lm" };
    }
    if (!msg && slot === "soir") {
      // rivalité : le joueur juste devant moi cette semaine dans ma guilde la plus active
      const r = (await s.query(`with my as (select m.code from league_members m where m.player = $1 and m.code not in (select code from leagues where dark)),
          b as (select m.code, p.id, p.name, case when p.week = ${WEEK} then p.bal - coalesce(p.week_bal, p.bal) else 0 end as g
                from league_members m join my on my.code = m.code join players p on p.id = m.player)
        select me.code, l.name as lname, me.g as mine, up.name as up, up.g as upg, (select count(*) from b b2 where b2.code = me.code) as n
          from b me join leagues l on l.code = me.code
          left join lateral (select name, g from b o where o.code = me.code and o.id <> me.id and o.g > me.g order by o.g asc limit 1) up on true
         where me.id = $1 order by n desc limit 1`, [p.id]))[0];
      if (r && r.n >= 2) {
        const d = Math.round(Number(r.upg) - Number(r.mine));
        const body = r.up ? `${r.up} te devance de ${d} jeton${d > 1 ? "s" : ""} cette semaine dans « ${r.lname} ».` : `Tu mènes « ${r.lname} » cette semaine. Ne te fais pas rattraper !`;
        msg = { title: r.up ? "😤 Reprends ta place" : "👑 Tu es en tête", body: body + (tonight ? ` Ce soir : ${tonight}.` : ""), url: go("rank", r.code), tag: "remind" };
      }
    }
    if (!msg && tonight) msg = { title: slot === "midi" ? "⚽ Au programme aujourd'hui" : "⚽ Ce soir", body: `${tonight}. Tu paries quoi ?`, url: "./", tag: "remind" };
    if (!msg && slot === "midi") msg = { title: "🎡 Ta roue du jour t'attend", body: "Un tour gratuit et 3 défis à relever pour gagner des jetons.", url: "./", tag: "remind" };
    if (msg) { await notify(s, [p.id], msg); return 1; }
    return 0;
  });
  const n = (await Promise.all(jobs)).reduce((a, x) => a + x, 0);
  return { sent: n, matches: M.length };
}

// ---- Match de la guilde : un match par jour (le même pour tout le monde), on vote 1 / N / 2 ----
const LM_PRIZE = 30;
const outcome = (m) => (m && m.done && m.sh != null ? (m.sh > m.sa ? 0 : m.sh === m.sa ? 1 : 2) : null);
async function dayMatch(s) {
  const t = (await s.query(`select to_char(now() at time zone 'Europe/Paris', 'YYYYMMDD') as d,
      extract(epoch from (date_trunc('day', now() at time zone 'Europe/Paris') at time zone 'Europe/Paris')) * 1000 as sod`))[0];
  const sod = Math.round(Number(t.sod));
  let cur = (await s.query(`select day, match, extract(epoch from updated_at) * 1000 as up from day_match where day >= $1 and match is not null order by day limit 1`, [t.d]))[0];
  if (!cur && !(await s.query(`select 1 from day_match where day = $1`, [t.d]))[0]) {
    // pas encore choisi : aujourd'hui, sinon le prochain jour avec des matchs (5 jours au plus) ; les jours vides sont notés
    for (let i = 0; i < 6 && !cur; i++) {
      const from = sod + i * 864e5, ymd = new Date(from + 12 * 3600e3).toLocaleDateString("sv-SE", { timeZone: "Europe/Paris" }).replace(/-/g, "");
      if ((await s.query(`select 1 from day_match where day = $1`, [ymd]))[0]) break;
      const m = await bestOfDay(ymd, from, from + 864e5);
      await s.query(`insert into day_match (day, match) values ($1, $2::jsonb) on conflict (day) do nothing`, [ymd, m ? JSON.stringify(m) : null]);
      if (m) cur = { day: ymd, match: m, up: Date.now() };
    }
    if (!cur) cur = (await s.query(`select day, match, extract(epoch from updated_at) * 1000 as up from day_match where day >= $1 and match is not null order by day limit 1`, [t.d]))[0];
  }
  // matchs commencés et pas finis (celui du jour et ceux d'avant) : score rafraîchi toutes les 3 min
  const open = await s.query(`select day, match from day_match where match is not null and day >= to_char(now() - interval '8 days', 'YYYYMMDD')
      and (match->>'done')::boolean is not true and updated_at < now() - interval '3 minutes'`);
  const started = open.filter((r) => r.match.t < Date.now());
  if (started.length) {
    const M = started.map((r) => r.match);
    const changed = await refreshResults(M).catch(() => false);
    for (const r of started) await s.query(`update day_match set match = $2::jsonb, updated_at = now() where day = $1`, [r.day, JSON.stringify(r.match)]);
    if (changed && cur) { const c = started.find((r) => r.day === cur.day); if (c) cur.match = c.match; }
  }
  return { today: t.d, cur: cur ? { day: cur.day, match: cur.match } : null };
}

// ---- Récompenses du mois : à la fin du mois, chaque guilde (2 membres ou plus) donne des jetons selon le classement final ----
// (1er, 2e, 3e, puis « tous les autres » ; il faut avoir au moins un pari terminé dans le mois). Les égalités gagnent pareil.
// Montants IDENTIQUES pour toutes les guildes, fixés ici (même liste dans index.html : PRZ).
const PRIZES = [1000, 500, 250, 25];
const prizeOf = (P, rk) => PRIZES[Math.min(rk, 4) - 1] || 0;
async function ensurePrizes(s, month) {
  if (!(await s.query(`insert into meta (key, value) values ($1, '1') on conflict do nothing returning key`, ["prizes:" + month]))[0]) return false;
  const leagues = await s.query(`select l.code, l.prizes from leagues l where not l.dark and (select count(*) from league_members m where m.code = l.code) >= 2`);
  for (const L of leagues) {
    const R = await s.query(`${periodGains("monthly", "month", MONTH, "month_bal")}
       select r.player, r.rk::int as rk from r join league_members m on m.player = r.player and m.code = $1 where r.per = $2`, [L.code, month]);
    for (const x of R) {
      const amount = prizeOf(L.prizes, x.rk);
      if (amount > 0) await s.query(`insert into month_prizes (code, month, player, rank, amount) values ($1, $2, $3, $4, $5) on conflict do nothing`, [L.code, month, x.player, x.rk, amount]);
    }
  }
  return true;
}

// ---- Notifications de paris (appelé toutes les ~10 min par GitHub Actions, sans clé : idempotent et limité) ----
// Avant le coup d'envoi (≤ 20 min) : « ton match commence » ; matchs tous finis : gagné / perdu (paris 1N2) ou « terminé ».
const ESPN_API = "https://site.api.espn.com/apis/site/v2/sports/";
const FAV_PATHS = ["soccer/fra.1", "soccer/fra.2", "rugby/270559", "soccer/eng.1", "soccer/esp.1", "soccer/ita.1", "soccer/ger.1", "soccer/por.1", "basketball/nba"];
async function espnJSON(u) { const c = new AbortController(), t = setTimeout(() => c.abort(), 7000); try { const r = await fetch(u, { signal: c.signal }); if (!r.ok) throw new Error(r.status); return await r.json(); } finally { clearTimeout(t); } }
const sentOnce = async (s, key) => !!(await s.query(`insert into sent_notes (key) values ($1) on conflict do nothing returning key`, [key]))[0];
async function tick(s) {
  if (await overLimit("tick:global", 1, 240)) return { skipped: "trop tôt" };
  let settled = 0;
  try { settled = (await settleOpen(s, { budget: 25e3 })).length; } catch (e) { console.error("settle", e); }
  await s.query(`delete from sent_notes where at < now() - interval '30 days'`);
  try { await SOCIAL.publishDue(s); } catch (e) { console.error("social", e); }
  // match où tu as un pari en cours (foot et rugby réels) : buts, cartons, essais… regroupés en une notification par passage
  try {
    const now = Date.now(), open = await s.query(`select player, legs from bets where status = 'open' and at > now() - interval '3 days'`), seen = {}, M = {};
    const EVT = { g: "⚽ But", og: "⚽ CSC", yc: "🟨 Carton jaune", rc: "🟥 Carton rouge" };
    for (const x of open) for (const L of x.legs || []) {
      if (!L.mid || !L.path || !(L.sp === "foot" || L.sp === "rugby") || !(L.t < now && now < L.t + 3 * 3600e3)) continue;
      const k = L.mid + "|" + x.player;
      if (seen[k]) continue;
      seen[k] = 1;
      if (!(L.mid in M)) M[L.mid] = await loadMatch(L).catch(() => null);
      const m = M[L.mid];
      if (!m || m.state !== "in" || !m.st) continue;
      const sc = m.st.g || m.st.pts || [0, 0], lines = [];
      if (m.sp === "foot" && Array.isArray(m.ev)) {
        for (const e of m.ev) if (EVT[e.ty] && await sentOnce(s, `ev:${x.player}:${L.mid}:${e.ty}:${e.id}:${e.min}`))
          lines.push(`${e.min}’ ${EVT[e.ty]}${e.n ? " " + e.n : ""}${e.s != null ? " (" + ((e.ty === "og" ? 1 - e.s : e.s) ? m.a : m.h) + ")" : ""}`);
      } else if (sc[0] + sc[1] > 0 && await sentOnce(s, `goal:${x.player}:${L.mid}:${sc[0]}-${sc[1]}`)) lines.push(`${m.min != null ? m.min + "’ " : ""}Ça marque !`);
      if (!lines.length) continue;
      const goal = lines.some((l) => /But|CSC|marque/.test(l));
      await notify(s, [x.player], { title: `${goal ? (m.sp === "foot" ? "⚽" : "🏉") : lines.some((l) => l.includes("rouge")) ? "🟥" : "🟨"} ${m.h} ${sc[0]} – ${sc[1]} ${m.a}`,
        body: `${lines.slice(-4).join(" · ")} · Ton pari : ${L.l}`, url: "./?go=bets", tag: "live-" + L.mid });
    }
  } catch (e) { console.error("live", e); }
  // combiné de 3 sélections ou plus : plus qu'un match à passer
  try {
    for (const x of await s.query(`select id, player, stake, odds::float8 as odds, legs from bets where status = 'open' and combo and jsonb_array_length(legs) >= 3`)) {
      const L = x.legs, left = L.filter((y) => !y.r), w = L.filter((y) => y.r === "w").length;
      if (left.length !== 1 || L.some((y) => y.r === "l") || w < 2) continue;
      if (!(await sentOnce(s, `last:${x.id}`))) continue;
      await notify(s, [x.player], { title: `🔥 Plus qu'un match pour ton combiné de ${L.length} !`, body: `${w} sélection${w > 1 ? "s" : ""} déjà bonne${w > 1 ? "s" : ""}. Reste : ${left[0].l}${left[0].ml ? " (" + left[0].ml + ")" : ""} · gain possible ${Math.round(x.stake * x.odds)} jetons`, url: "./?go=bets", tag: "last-" + x.id });
    }
  } catch (e) { console.error("last", e); }
  let battles = null;
  try { battles = await battlesTick(s); } catch (e) { console.error("battles", e); }
  const ppl = await s.query(`select p.id, p.bets from players p where p.bets is not null and exists (select 1 from push_subs x where x.player = p.id)`);
  const now = Date.now(), out = { ko: 0, end: 0, fetched: 0, settled, battles };
  const open = [];
  for (const p of ppl) for (const b of (p.bets.list || [])) if (b.st === "open" && b.id && Array.isArray(b.legs) && b.legs.length && b.legs.every((L) => L.e && L.p && L.t)) open.push({ pid: p.id, b });
  // 1) coup d'envoi imminent (une fois par joueur et par match)
  for (const { pid, b } of open) for (const L of b.legs) {
    if (L.t - now > 0 && L.t - now <= 20 * 60e3 && await sentOnce(s, `ko:${pid}:${L.p}:${L.e}`)) {
      await notify(s, [pid], { title: `⏱️ ${L.ml || "Ton match"} commence à ${hhmm(L.t)}`, body: `Ton pari : ${L.l}${b.legs.length > 1 ? ` (combiné de ${b.legs.length})` : ""} · mise ${b.stake}`, url: "./?go=bets", tag: "ko-" + L.e });
      out.ko++;
    }
  }
  // 2) fin des matchs : on ne regarde que les paris dont tous les matchs ont commencé il y a plus de 1 h 45
  let cand = open.filter(({ b }) => b.legs.every((L) => now - L.t > 105 * 60e3) && now - Math.max(...b.legs.map((L) => L.t)) < 3 * 864e5);
  if (cand.length) {
    const done = new Set((await s.query(`select key from sent_notes where key = any($1::text[])`, [cand.map(({ pid, b }) => `end:${pid}:${b.id}`)])).map((x) => x.key));
    cand = cand.filter(({ pid, b }) => !done.has(`end:${pid}:${b.id}`));
  }
  const res = {};
  for (const { b } of cand) for (const L of b.legs) {
    const k = L.p + "|" + L.e;
    if (k in res || out.fetched >= 40) continue;
    out.fetched++;
    try {
      const j = await espnJSON(`${ESPN_API}${L.p}/summary?event=${encodeURIComponent(L.e)}`);
      const c = j.header && j.header.competitions && j.header.competitions[0];
      const H = c && c.competitors.find((x) => x.homeAway === "home"), A = c && c.competitors.find((x) => x.homeAway === "away");
      res[k] = c ? { post: c.status && c.status.type && c.status.type.state === "post", sh: H ? +H.score : null, sa: A ? +A.score : null } : null;
    } catch (e) { res[k] = null; }
  }
  for (const { pid, b } of cand) {
    const R = b.legs.map((L) => res[L.p + "|" + L.e]);
    if (R.some((r) => !r || !r.post)) continue;
    if (!(await sentOnce(s, `end:${pid}:${b.id}`))) continue;
    const score = b.legs.length === 1 ? `${b.legs[0].ml ? b.legs[0].ml + " : " : ""}${R[0].sh} – ${R[0].sa}` : `${b.legs.length} matchs terminés`;
    // résultat sûr seulement pour les paris « résultat du match » au foot, au rugby et au basket
    const simple = b.legs.every((L) => L.mk === "res" && (L.sp === "foot" || L.sp === "rugby" || L.sp === "basket"));
    let msg;
    if (simple) {
      const ok = b.legs.every((L, i) => { const r = R[i]; const o = L.sp === "basket" ? (r.sh > r.sa ? 0 : 1) : r.sh > r.sa ? 0 : r.sh === r.sa ? 1 : 2; return o === L.k; });
      msg = ok ? { title: `✅ Pari gagné : +${Math.round(b.stake * b.odds)} jetons !`, body: `${score} · ${b.legs.map((L) => L.l).join(" + ")}. Ouvre l'appli pour les encaisser.` }
        : { title: "❌ Pari perdu", body: `${score} · ${b.legs.map((L) => L.l).join(" + ")}. La prochaine sera la bonne !` };
    } else msg = { title: "🏁 Ton pari est joué", body: `${score} · « ${b.legs.map((L) => L.l).join(" + ").slice(0, 80)} » : ouvre l'appli pour voir s'il passe !` };
    await notify(s, [pid], { ...msg, url: "./?go=bets", tag: "end-" + b.id });
    out.end++;
  }
  return out;
}

// ---- Registre des jetons : chaque gain ou dépense hors paris, une seule fois par (joueur, type, référence) ----
async function credit(s, pid, delta, kind, ref) {
  return !!(await s.query(`insert into ledger (player, delta, kind, ref) values ($1, $2, $3, $4) on conflict do nothing returning id`, [pid, Math.round(delta), kind, String(ref)]))[0];
}
const parisDay = async (s) => (await s.query(`select to_char(now() at time zone 'Europe/Paris', 'YYYYMMDD') as d`))[0].d;
const EG = globalThis.ENGINE;

// gains d'un pari dark terminé (pot partagé entre les gagnants, ou tout le monde remboursé), notés une seule fois
async function darkPay(s, x) {
  const st = await s.query(`select player, opt, amount, guess::float8 as guess from dark_stakes where bet = $1`, [x.id]);
  if (!st.length) return;
  const T = st.reduce((a, y) => a + y.amount, 0);
  let win = [];
  if (x.state === "final") {
    if (x.kind === "num") { const near = Math.min(...st.map((y) => Math.abs(y.guess - x.resultNum))); win = st.filter((y) => Math.abs(y.guess - x.resultNum) === near); }
    else win = st.filter((y) => y.opt === x.result);
  }
  const W = win.reduce((a, y) => a + y.amount, 0);
  if (x.state === "void" || !W) { for (const y of st) await credit(s, y.player, y.amount, "dark_pay", x.id); return; }
  for (const y of win) await credit(s, y.player, Math.floor(y.amount * T / W), "dark_pay", x.id);
}

// prono du week-end terminé : 10 jetons par point, noté une seule fois par semaine
async function pronoCredit(s, pid, week) {
  const w = (await s.query(`select matches from prono_weeks where week = $1`, [week]))[0];
  if (!w || !w.matches.length || !w.matches.every((m) => m.done || m.cancel)) return;
  const picks = await s.query(`select mid, sh, sa, joker from prono_picks where week = $1 and player = $2`, [week, pid]);
  let pts = 0;
  for (const x of picks) { const M = w.matches.find((m) => m.mid === x.mid); const pt = M ? points(M, x) : null; if (pt) pts += pt; }
  if (pts > 0) await credit(s, pid, pts * 10, "prono", week);
}

// ---- Guildes : emblème, devise, accès (ouverte / sur demande / privée), rôles (chef, adjoints, membres) ----
const cardOpts = (k) => { const o = {}, ok = { d: ["rang", "bn"], bd: ["fav", "emo", "none"], sub: ["t", "lvl"], sp: ["auto", "foot", "rugby", "tennis", "nba", "none"] };
  for (const [x, vals] of Object.entries(ok)) if (k && vals.includes(k[x])) o[x] = k[x]; return o; };
// copie des messages « Nous écrire » dans la boîte de contact (si une clé Resend est configurée sur Vercel)
const CONTACT_MAIL = "contact.tribuneps@gmail.com";
async function mailContact(p, text, why) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return;
  try {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 5000);
    await fetch("https://api.resend.com/emails", { method: "POST", signal: ctl.signal,
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ from: process.env.RESEND_FROM || "Tribune <onboarding@resend.dev>", to: [process.env.CONTACT_MAIL || CONTACT_MAIL],
        subject: `Tribune · ${why ? why + " · " : ""}${String(p.name || "un joueur").slice(0, 40)}`, text: `${why ? "Raison : " + why + "\n\n" : ""}${text}\n\n— ${p.name} (joueur n° ${p.id})` }) });
    clearTimeout(t);
  } catch (e) { /* le message reste enregistré sur le serveur */ }
}
// ---- Parrainage : +250 pour le filleul à l'inscription, +500 pour le parrain quand le filleul a 3 paris terminés ----
const REF_NEW = 250, REF_GIVE = 500, REF_BETS = 3, REF_MAX = 20;
const REF_ABC = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
async function refCode(s, pid) {
  const r = (await s.query(`select ref_code from players where id = $1`, [pid]))[0];
  if (r && r.ref_code) return r.ref_code;
  for (let i = 0; i < 8; i++) {
    let c = ""; for (let k = 0; k < 6; k++) c += REF_ABC[randomInt(REF_ABC.length)];
    try { const u = await s.query(`update players set ref_code = $2 where id = $1 and ref_code is null returning ref_code`, [pid, c]); if (u[0]) return u[0].ref_code; return (await s.query(`select ref_code from players where id = $1`, [pid]))[0].ref_code; }
    catch (e) { if (!isTaken(e)) throw e; }
  }
  throw fail(500, "code");
}
const cleanRef = (v) => String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
// filleuls qui ont joué leurs 3 paris : cadeau pour le parrain (une seule fois chacun, 20 au plus)
async function refCheck(s, parrain) {
  const rows = await s.query(`select f.id, f.name from players f where f.ref_by = $1
      and (select count(*) from bets x where x.player = f.id and x.status in ('won', 'lost', 'cashed')) >= $2
      and not exists (select 1 from gifts g where g.player = $1 and g.kind = 'parrain' and g.ref = f.id::text)`, [parrain, REF_BETS]);
  if (!rows.length) return 0;
  let done = (await s.query(`select count(*)::int as n from gifts where player = $1 and kind = 'parrain'`, [parrain]))[0].n, n = 0;
  for (const f of rows) {
    if (done >= REF_MAX) break;
    const ins = await s.query(`insert into gifts (player, kind, ref, amount, label) values ($1, 'parrain', $2, $3, $4) on conflict do nothing returning player`,
      [parrain, String(f.id), REF_GIVE, `Parrainage : ${f.name} a joué ses ${REF_BETS} premiers paris`]);
    if (ins[0]) { done++; n++; await notify(s, [parrain], { title: "🎁 Parrainage validé !", body: `${f.name} a joué ses ${REF_BETS} premiers paris : +${REF_GIVE} jetons pour toi.`, url: "./", tag: "ref-" + f.id }); }
  }
  return n;
}
const GIMG = /^g\/[a-z0-9-]{1,40}\.(webp|png)$/;
const EMBLEMS = ["🦁","🐺","🦅","🐉","🦈","🐻","🦊","🐯","🔥","⚡","👑","🏆","⚽","🏉","🎾","🏀","💎","🚀","🎯","🛡️","⚔️","🌟","🍀","🐐"];
const GCOLORS = ["#35d07f","#ffd23f","#ff7a45","#5fa8ff","#c084fc","#ff5a5f","#2ec4b6","#f8fafc","#ff9f1c","#8ac926"];
async function guildRole(s, code, pid) {
  const r = (await s.query(`select l.owner, m.role from leagues l join league_members m on m.code = l.code and m.player = $2 where l.code = $1 and not l.dark`, [code, pid]))[0];
  if (!r) return null;
  return String(r.owner) === String(pid) ? "chef" : r.role === "officer" ? "adjoint" : "membre";
}
async function addMember(s, code, pid, name) {
  const l = (await s.query(`select name, (select count(*)::int from league_members m where m.code = leagues.code) as n from leagues where code = $1`, [code]))[0];
  if (!l) throw fail(404, "unknown");
  if (l.n >= MAX_MEMBERS) throw fail(400, "full");
  const n = (await s.query(`select count(*)::int as n from league_members where player = $1`, [pid]))[0].n;
  if (n >= MAX_LEAGUES) throw fail(400, "too_many");
  const r = await s.query(`insert into league_members (code, player) values ($1, $2) on conflict do nothing returning player`, [code, pid]);
  await s.query(`delete from requests where code = $1 and player = $2`, [code, pid]);
  if (r[0]) await notify(s, await members(s, code), { title: l.name, body: `${name} a rejoint la guilde 👋`, url: go("rank", code), tag: "join-" + code }, pid);
  return { code, name: l.name };
}

// ---- Premiers pas ----
const GUIDE = ["bet", "wheel", "guild", "push", "fav", "combo", "insta", "fb"], GUIDE_REWARD = 50, GUIDE_ALL = 100;
async function guideState(s, pid) {
  const r = (await s.query(`select
      exists (select 1 from bets where player = $1) as bet,
      exists (select 1 from bets where player = $1 and combo) as combo,
      coalesce(p.wheel->>'b', '') <> '' or coalesce(p.wheel->>'x', '') <> '' as wheel,
      exists (select 1 from league_members m join leagues l on l.code = m.code and not l.dark where m.player = $1) as guild,
      exists (select 1 from push_subs x where x.player = $1) as push,
      p.fav is not null as fav,
      exists (select 1 from ledger where player = $1 and kind = 'insta') as insta,
      exists (select 1 from ledger where player = $1 and kind = 'fb') as fb
    from players p where p.id = $1`, [pid]))[0];
  const got = new Set((await s.query(`select ref from ledger where player = $1 and kind = 'guide'`, [pid])).map((x) => x.ref));
  const done = {}, claimed = {};
  for (const g of GUIDE) { done[g] = !!r[g]; claimed[g] = got.has(g); }
  return { done, claimed, all: got.has("all"), reward: GUIDE_REWARD, bonus: GUIDE_ALL };
}

// ---- Style du joueur : ce qu'il a débloqué (tout est vérifié ici, rien ne s'achète) ----
async function cosFlags(s, pid) {
  const r = (await s.query(`select p.cos_all, p.cos_grant, p.badges, p.created_at < '2026-12-01' as pioneer,
      coalesce((select xp from pxp where player = p.id), 0) as xp,
      (select coalesce(json_agg(month order by month), '[]') from month_prizes where player = p.id and rank = 1) as months,
      exists (select 1 from month_prizes where player = p.id and rank <= 3) as podium,
      (select count(*)::int from battle_rewards where player = p.id and result = 'w') as battles,
      exists (select 1 from bets where player = p.id and status = 'won' and odds >= 10) as odds10,
      exists (select 1 from ledger where player = p.id and kind = 'wheel' and delta >= 500) as wheel500,
      exists (select 1 from ledger where player = p.id and kind = 'wheel' and delta >= 1000000) as jackpot,
      (select count(*)::int from ledger where player = p.id and kind = 'duel_win') as duels,
      (select count(*)::int from bets where player = p.id and status = 'won' and legs->0->>'sp' = 'rugby') as rugby,
      (select count(*)::int from bets where player = p.id and status = 'won' and legs->0->>'sp' = 'tennis') as tennis,
      (select count(*)::int from bets where player = p.id and status = 'won' and legs->0->>'sp' = 'basket') as nba,
      (select count(*)::int from bets where player = p.id and status = 'won' and exists (select 1 from jsonb_array_elements(legs) e where e->>'mk' = 'res' and e->>'k' = '1')) as draws,
      exists (select 1 from bets where player = p.id and status = 'won' and jsonb_array_length(legs) >= 4) as combo4,
      exists (select 1 from leagues l where l.owner = p.id and l.bw > 0) as chief,
      coalesce((select sum(delta) from ledger where player = p.id and kind = 'prono'), 0)::int as prono,
      (select count(*)::int from ledger where player = p.id and kind = 'lm') as lm,
      (select count(*)::int from bal_hist where player = p.id) as days,
      exists (select 1 from bets x where x.player = p.id and ((extract(month from x.at at time zone 'Europe/Paris') = 12 and extract(day from x.at at time zone 'Europe/Paris') >= 15)
        or (extract(month from x.at at time zone 'Europe/Paris') = 1 and extract(day from x.at at time zone 'Europe/Paris') <= 5))) as noel,
      (select count(*)::int from gifts where player = p.id and kind = 'parrain') as refs
    from players p where p.id = $1`, [pid]))[0];
  if (!r) return {};
  const badges = Array.isArray(r.badges) ? r.badges : [], grants = Object.fromEntries((Array.isArray(r.cos_grant) ? r.cos_grant : []).map((k) => [k, true]));
  return { ...grants, all: !!r.cos_all, lvl: EG.levelOf(r.xp).lvl, months: r.months || [], podium: r.podium, battles3: r.battles >= 3, odds10: r.odds10, wheel500: r.wheel500, jackpot: r.jackpot,
    duels5: r.duels >= 5, rugby10: r.rugby >= 10, tennis10: r.tennis >= 10, nba10: r.nba >= 10, pioneer: r.pioneer, streak5: badges.includes("s5"), draws5: r.draws >= 5,
    combo4: r.combo4, chief: r.chief, prono20: r.prono >= 200, lm10: r.lm >= 10, days30: r.days >= 30, noel: r.noel, ref3: r.refs >= 3, month1: (r.months || []).length > 0 };
}

// ---- Modération ----
// Mots refusés dans les pseudos, noms et devises de guilde, et masqués dans le chat (insultes, propos haineux, sexuels).
// Comparaison sans accents, sans chiffres « leet » (0→o, 1→i, 3→e…) et sans lettres répétées (« connnnard » = « conard »).
const BAD_TOK = new Set(("con conard conase pd pede tapete tafiole tarlouze tarlouse pute salope batard enfoire encule enculer fdp ntm tg nique niquer " +
  "negre negro bougnoul bougnoule youpin bicot bamboula chintok pedophile pedo gouine suceur suceuse bite couile chate nichon penis porn porno viol violer " +
  "nazi nazis hitler fuck fucker shit bitch niga nigga cunt whore slut dick pusy cock sperme").split(" "));
const BAD_SUB = ["encul", "salope", "pedophil", "bougnoul", "tarlouz", "hitler", "fuck", "niga", "conase", "conard", "filsdepute", "ntamere", "nikta"];
const LEET = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t", "@": "a", $: "s", "€": "e" };
const norm = (v) => String(v || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[013457@$€]/g, (c) => LEET[c]).replace(/(.)\1+/g, "$1");
function isBad(v) {
  const n = norm(v), toks = n.split(/[^a-z]+/).filter(Boolean), flat = toks.join("");
  return toks.some((w) => BAD_TOK.has(w)) || BAD_SUB.some((w) => flat.includes(w));
}
const maskBad = (text) => String(text).replace(/[\p{L}\p{N}@$€]+/gu, (w) => (BAD_TOK.has(norm(w)) || BAD_SUB.some((x) => norm(w).includes(x)) ? "•".repeat(Math.min(6, w.length)) : w));
const isBanned = async (s, name) => !!(await s.query(`select 1 from banned_names where name = $1`, [norm(name).replace(/[^a-z]/g, "")]))[0];
async function badName(s, name) { return isBad(name) || (await isBanned(s, name)); }
const banName = (s, name) => s.query(`insert into banned_names (name) values ($1) on conflict do nothing`, [norm(name).replace(/[^a-z]/g, "")]);

// ---- Combats de guildes ----
// Score d'une guilde = moyenne des gains EN PARIS de la semaine (vue sprofits, calculée par le serveur) de TOUS les membres engagés,
// inactifs compris (0). Les membres sont figés au début du combat. Défis : toujours pour la semaine suivante,
// pour que personne ne lance un défi en sachant déjà le résultat. Championnat : appariement auto le lundi.
// Résultat le mardi à 6 h (le lundi laisse le temps aux téléphones d'envoyer les paris du dimanche soir).
const NEXT_WEEK = `to_char(date_trunc('week', now() at time zone 'Europe/Paris') + interval '7 days', 'YYYY-MM-DD')`;
const BDIV = [[1200, "Diamant", "💎"], [1150, "Platine", "💠"], [1100, "Or", "🥇"], [1050, "Argent", "🥈"], [-1e9, "Bronze", "🥉"]];
const division = (elo) => { const d = BDIV.find((x) => elo >= x[0]); return { n: d[1], i: d[2] }; };
const BREWARD = { w: 200, d: 75, l: 25 }, BK = 32, MIN_BATTLE = 3;
const sgn = (x) => (x > 0 ? "+" : "") + x;
async function snapshot(s, id, code) {
  await s.query(`insert into battle_members (battle, code, player) select $1, $2, player from league_members where code = $2 on conflict do nothing`, [id, code]);
}
// {"id|code": {n, avg}} pour des combats donnés
async function battleScores(s, ids) {
  if (!ids.length) return {};
  const r = await s.query(`select bm.battle, bm.code, count(*)::int as n, coalesce(sum(pr.gain), 0)::float8 as total
     from battle_members bm join battles bt on bt.id = bm.battle left join sprofits pr on pr.player = bm.player and pr.per = bt.week
     where bm.battle = any($1::bigint[]) group by bm.battle, bm.code`, [ids.map(String)]);
  const out = {};
  for (const x of r) out[x.battle + "|" + x.code] = { n: x.n, avg: x.n ? Math.round(x.total / x.n) : 0 };
  return out;
}
async function settleBattle(s, id) {
  const bt = (await s.query(`select bt.id, bt.kind, bt.week, bt.a, bt.b, la.elo as ea, lb.elo as eb, la.name as na, lb.name as nb
     from battles bt join leagues la on la.code = bt.a join leagues lb on lb.code = bt.b where bt.id = $1 and bt.status = 'live'`, [id]))[0];
  if (!bt) return false;
  const sc = await battleScores(s, [id]);
  const sa = (sc[id + "|" + bt.a] || { avg: 0 }).avg, sb = (sc[id + "|" + bt.b] || { avg: 0 }).avg;
  const res = sa > sb ? 1 : sa < sb ? 0 : 0.5;
  const da = Math.round(BK * (res - 1 / (1 + 10 ** ((bt.eb - bt.ea) / 400))));
  const winner = res === 1 ? bt.a : res === 0 ? bt.b : null;
  const ok = (await s.query(`update battles set status = 'done', a_score = $2, b_score = $3, winner = $4, a_delta = $5, b_delta = $6, settled_at = now()
     where id = $1 and status = 'live' returning id`, [id, sa, sb, winner, da, -da]))[0];
  if (!ok) return false;
  const sides = [[bt.a, bt.na, bt.nb, sa, sb, da, res === 1 ? "w" : res === 0 ? "l" : "d"], [bt.b, bt.nb, bt.na, sb, sa, -da, res === 0 ? "w" : res === 1 ? "l" : "d"]];
  for (const [code, name, opp, my, their, d, r] of sides) {
    await s.query(`update leagues set elo = greatest(0, elo + $2), bw = bw + $3, bl = bl + $4, bd = bd + $5 where code = $1`, [code, d, +(r === "w"), +(r === "l"), +(r === "d")]);
    const all = await s.query(`select bm.player, exists (select 1 from sprofits pr where pr.player = bm.player and pr.per = $3) as bet
       from battle_members bm where bm.battle = $1 and bm.code = $2`, [id, code, bt.week]);
    const elo = (await s.query(`select elo from leagues where code = $1`, [code]))[0].elo, dv = division(elo);
    const head = r === "w" ? `🏆 Victoire de ${name} !` : r === "l" ? `😤 Défaite de ${name}` : `🤝 Match nul pour ${name}`;
    for (const x of all) {
      const amt = x.bet ? BREWARD[r] : 0;
      if (amt) await s.query(`insert into battle_rewards (battle, player, amount, result) values ($1, $2, $3, $4) on conflict do nothing`, [id, x.player, amt, r]);
      await notify(s, [x.player], { title: head, body: `Contre ${opp} : ${sgn(my)} à ${sgn(their)} de moyenne. ${amt ? `+${amt} jetons pour toi 🎁` : "Tu n'as pas parié cette semaine : pas de récompense."} Cote ${elo} (${dv.i} ${dv.n}).`,
        url: go("fights", code), tag: "battle-" + id });
    }
  }
  return true;
}
async function battlesTick(s) {
  const t = (await s.query(`select ${WEEK} as w, ${PREV_WEEK} as pw`))[0];
  const out = { settled: 0, started: 0, paired: 0 };
  // 1) combats terminés : résultat le mardi à 6 h
  const due = await s.query(`select id from battles where status = 'live' and week < $1
     and (now() at time zone 'Europe/Paris') >= week::date + interval '8 days 6 hours' order by id`, [t.w]);
  for (const x of due) if (await settleBattle(s, x.id)) out.settled++;
  // 2) défis acceptés qui commencent cette semaine : on fige les membres ; défis sans réponse : expirés
  for (const x of await s.query(`select id, a, b from battles where status = 'ready' and week <= $1`, [t.w])) {
    await snapshot(s, x.id, x.a); await snapshot(s, x.id, x.b);
    if (!(await s.query(`update battles set status = 'live' where id = $1 and status = 'ready' returning id`, [x.id]))[0]) continue;
    const n = await s.query(`select code, name from leagues where code in ($1, $2)`, [x.a, x.b]), nm = Object.fromEntries(n.map((y) => [y.code, y.name]));
    for (const [c, o] of [[x.a, x.b], [x.b, x.a]])
      await notify(s, await members(s, c), { title: `⚔️ Le défi commence · ${nm[c]}`, body: `Cette semaine contre ${nm[o]} : chaque pari compte pour la moyenne de la guilde. À vous de jouer !`, url: go("fights", c), tag: "battle-" + x.id });
    out.started++;
  }
  await s.query(`update battles set status = 'expired' where status = 'pending' and week <= $1`, [t.w]);
  // 3) championnat de la semaine : une fois, adversaires de cote proche (pas le même que la semaine passée si possible)
  if ((await s.query(`insert into meta (key, value) values ($1, '1') on conflict do nothing returning key`, ["champ:" + t.w]))[0]) {
    const G = await s.query(`select l.code, l.name, l.elo from leagues l where not l.dark and l.champ
       and (select count(*) from league_members m where m.code = l.code) >= $1 order by l.elo desc, l.gid`, [MIN_BATTLE]);
    const was = new Set((await s.query(`select a, b from battles where kind = 'league' and week = $1`, [t.pw])).flatMap((x) => [x.a + "|" + x.b, x.b + "|" + x.a]));
    if (G.length % 2) G.splice(randomInt(G.length), 1);   // nombre impair : une guilde au repos, tirée au sort
    while (G.length >= 2) {
      const A = G.shift();
      let j = G.findIndex((B, k) => k < 3 && !was.has(A.code + "|" + B.code));
      const B = G.splice(j < 0 ? 0 : j, 1)[0];
      const id = (await s.query(`insert into battles (kind, week, a, b, status) values ('league', $1, $2, $3, 'pending') returning id`, [t.w, A.code, B.code]))[0].id;
      await snapshot(s, id, A.code); await snapshot(s, id, B.code);
      await s.query(`update battles set status = 'live' where id = $1`, [id]);
      for (const [X, Y] of [[A, B], [B, A]]) { const dv = division(Y.elo);
        await notify(s, await members(s, X.code), { title: `⚔️ Championnat des guildes · ${X.name}`, body: `Cette semaine, vous affrontez ${Y.name} (${dv.i} ${dv.n}). Score = moyenne des gains en paris de tous les membres : chacun compte !`, url: go("fights", X.code), tag: "battle-" + id }); }
      out.paired++;
    }
  }
  return out;
}

const ACTIONS = {
  // Crée un joueur anonyme. Le jeton n'est gardé qu'en empreinte sha256.
  async session(s, b, req) {
    if (await overLimit(ipKey(req) + ":new", 30, 3600)) throw fail(429, "slow_down");
    const token = newToken();
    const bal = b.bal == null ? 1000 : num(b.bal, 0, MAX_BAL);
    const name = cleanName(b.name, 18) || "Joueur " + Math.floor(1000 + Math.random() * 9000);
    if (await badName(s, name)) throw fail(400, "name_bad");
    let r;
    try {
      r = await s.query(
        `insert into players (token_hash, name, bal, peak, won, lost, week, week_bal)
         values ($1, $2, $3::numeric, greatest($3::numeric, $4::numeric), $5::int, $6::int, ${WEEK}, $3::numeric) returning id`,
        [hashToken(token), name, bal, b.peak == null ? bal : num(b.peak, 0, MAX_BAL), int(b.won, 0, 1e7), int(b.lost, 0, 1e7)]);
    } catch (e) {
      if (isTaken(e)) throw fail(409, "name_taken");
      throw e;
    }
    await s.query(`insert into audit_base (player, bal) values ($1, $2::numeric) on conflict do nothing`, [r[0].id, bal]);
    let parrain = null;
    try {
      let code = cleanRef(b.ref);
      if (!code && req) { const h = (await s.query(`select code from link_hits where ip = $1 and code like 'R:%' and at > now() - interval '2 hours' order by at desc limit 1`, [ipKey(req)]))[0]; if (h) code = h.code.slice(2); }
      const pr = code ? (await s.query(`select id, name from players where ref_code = $1`, [code]))[0] : null;
      if (pr && String(pr.id) !== String(r[0].id)) {
        await s.query(`update players set ref_by = $2 where id = $1`, [r[0].id, pr.id]);
        await s.query(`insert into gifts (player, kind, ref, amount, label) values ($1, 'filleul', $2, $3, $4) on conflict do nothing`, [r[0].id, String(pr.id), REF_NEW, `Bienvenue de la part de ${pr.name}`]);
        parrain = pr.name;
      }
    } catch (e) { console.error(e); }
    return { token, id: r[0].id, name, parrain };
  },

  // Le pseudo est-il libre ? (pas déjà pris par un autre joueur, sans tenir compte des majuscules)
  async check_name(s, b) {
    const name = cleanName(b.name, 18);
    if (!name) return { free: false };
    if (await badName(s, name)) return { free: false, bad: true };
    const self = b.token ? (await s.query(`select id from players where token_hash = $1`, [hashToken(b.token)]))[0] : null;
    const r = await s.query(`select id from players where lower(name) = lower($1)`, [name]);
    return { free: !r[0] || !!(self && String(r[0].id) === String(self.id)) };
  },

  // Envoie le profil du joueur (pseudo, solde, record, bilan). Le solde de début de semaine est
  // retenu au premier envoi de chaque semaine : « cette semaine » = solde actuel − solde du lundi.
  // Si le pseudo demandé est déjà pris, le reste est enregistré et on répond name_taken.
  async sync(s, b) {
    const p = await me(s, b.token);
    await s.query(
      `insert into weekly (player, week, gain)
         select id, week, bal - coalesce(week_bal, bal) from players where id = $1 and week is not null and week <> ${WEEK}
       on conflict do nothing`, [p.id]);
    await s.query(
      `insert into monthly (player, month, gain)
         select id, month, bal - coalesce(month_bal, bal) from players where id = $1 and month is not null and month <> ${MONTH}
       on conflict do nothing`, [p.id]);
    await s.query(
      `update players set
         week_bal = case when week is distinct from ${WEEK} then bal else week_bal end,
         week = ${WEEK},
         month_bal = case when month is distinct from ${MONTH} then bal else month_bal end,
         month = ${MONTH},
         bal = $2::numeric, peak = greatest(peak, $3::numeric, $2::numeric), won = $4::int, lost = $5::int, seen_at = now()
       where id = $1`,
      [p.id, num(b.bal, 0, MAX_BAL), num(b.peak, 0, MAX_BAL), int(b.won, 0, 1e7), int(b.lost, 0, 1e7)]);
    await s.query(`insert into audit_base (player, bal) values ($1, $2::numeric) on conflict do nothing`, [p.id, num(b.bal, 0, MAX_BAL)]);
    await s.query(`insert into bal_hist (player, day, bal) values ($1, to_char(now() at time zone 'Europe/Paris', 'YYYYMMDD'), $2::numeric)
       on conflict (player, day) do update set bal = excluded.bal`, [p.id, num(b.bal, 0, MAX_BAL)]);
    const day = (v) => (/^\d{8}$/.test(String(v || "")) ? String(v) : "");
    const wr = (await s.query(`update players set wheel = jsonb_build_object(
        'b', greatest(coalesce(wheel->>'b', ''), $2::text), 'x', greatest(coalesce(wheel->>'x', ''), $3::text))
      where id = $1 returning wheel, avatar_v`, [p.id, day(b.wb), day(b.wx)]))[0];
    if (b.profits && typeof b.profits === "object") {
      const P = Object.entries(b.profits).filter(([k]) => /^\d{4}-\d{2}(-\d{2})?$/.test(k) && k >= "2026-10").slice(0, 40);
      for (const [per, g] of P) await s.query(`insert into profits (player, per, gain) values ($1, $2, $3::numeric) on conflict (player, per) do update set gain = excluded.gain`,
        [p.id, per, num(g, -MAX_BAL, MAX_BAL)]);
    }
    if (Array.isArray(b.badges)) await s.query(`update players set badges = $2::jsonb where id = $1`,
      [p.id, JSON.stringify([...new Set(b.badges.map((x) => cleanName(x, 20)).filter(Boolean))].slice(0, 60))]);
    if (Array.isArray(b.bets)) {
      const fin = b.bets.filter((x) => x && x.id && ["won", "lost", "void"].includes(x.st)).slice(0, 40);
      if (fin.length) {
        const srv = await s.query(`select cid, status, pay::float8 as pay from bets where player = $1 and cid = any($2::text[]) and status in ('won','lost','void')`, [p.id, fin.map((x) => String(x.id))]);
        for (const r of srv) {
          const c = fin.find((x) => String(x.id) === r.cid);
          if (c && (c.st !== r.status || (r.status === "won" && Math.abs((Number(c.pay) || 0) - r.pay) > 1)))
            await s.query(`insert into settle_diff (player, cid, server, client, spay, cpay) values ($1, $2, $3, $4, $5, $6) on conflict do nothing`,
              [p.id, r.cid, r.status, String(c.st), r.pay, Number(c.pay) || 0]);
        }
      }
    }
    if (Array.isArray(b.bets)) {
      const json = JSON.stringify({ list: b.bets.slice(0, 40), best: b.best && typeof b.best === "object" ? b.best : null });
      if (json.length <= 150000) await s.query(`update players set bets = $2::jsonb where id = $1`, [p.id, json]);
    }
    if (typeof b.so === "boolean") await s.query(`update players set social_ok = $2 where id = $1 and social_ok is distinct from $2`, [p.id, b.so]);
    if (typeof b.tos === "string" && b.tos) await s.query(`update players set tos = $2, tos_at = now() where id = $1 and tos is distinct from $2`, [p.id, cleanName(b.tos, 12)]);
    const name = cleanName(b.name, 18);
    if (name && name !== p.name && await badName(s, name)) return { ok: true, name_bad: true, name: p.name, wheel: wr && wr.wheel, av: wr ? wr.avatar_v || 0 : null };
    if (name && name !== p.name) {
      try {
        await s.query(`update players set name = $2 where id = $1`, [p.id, name]);
      } catch (e) {
        if (isTaken(e)) return { ok: true, name_taken: true, name: p.name, wheel: wr && wr.wheel, av: wr ? wr.avatar_v || 0 : null };
        throw e;
      }
    }
    const cancel = await s.query(`select cid from bets where player = $1 and cancelled and at > now() - interval '30 days'`, [p.id]);
    // passage aux niveaux d'XP : chacun repart du niveau qui correspond à son ancienne division (une seule fois, jamais au-dessus de Capo)
    const pk = (await s.query(`select peak::float8 as peak, xp_seed from players where id = $1`, [p.id]))[0];
    if (pk && pk.xp_seed == null) { const D = [0, 1300, 1700, 2200, 3000, 4000, 5500, 7500, 10000, 14000, 20000, 30000, 50000]; let di = 0; D.forEach((v, i) => { if (pk.peak >= v) di = i; });
      await s.query(`update players set xp_seed = $2 where id = $1 and xp_seed is null`, [p.id, EG.xpFor(EG.TIERS[Math.min(di, 5)][1])]); }
    const xp = (await s.query(`select xp from pxp where player = $1`, [p.id]))[0];
    return { ok: true, name: name || p.name, wheel: wr && wr.wheel, av: wr ? wr.avatar_v || 0 : null, cancel, xp: xp ? xp.xp : 0 };
  },

  // Code de transfert : emporter son compte (jetons, paris, défis…) dans l'app installée ou sur un
  // autre téléphone. Valable 48 h, utilisable une fois. L'ancien appareil est déconnecté.
  async make_transfer(s, b) {
    const p = await me(s, b.token);
    const state = b.state && typeof b.state === "object" ? b.state : null;
    const json = state ? JSON.stringify(state) : null;
    if (json && json.length > 400000) throw fail(400, "too_big");
    await s.query(`delete from transfers where player = $1 or expires < now()`, [p.id]);
    for (let i = 0; i < 8; i++) {
      let code = "";
      for (let j = 0; j < 8; j++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
      const r = await s.query(
        `insert into transfers (code, player, state, expires) values ($1, $2, $3::jsonb, now() + interval '48 hours') on conflict do nothing returning code`,
        [code, p.id, json]);
      if (r[0]) return { code: code.slice(0, 4) + "-" + code.slice(4) };
    }
    throw fail(500, "code");
  },

  // ---- Code de compte permanent (12 caractères, ne change jamais) + sauvegarde du téléphone sur le serveur ----
  // Le serveur ne garde que l'empreinte du code ; le téléphone garde le code en clair pour l'afficher.
  // ---- Paris enregistrés et contrôlés par le serveur ----
  // {bets:[{cid, stake, combo, odds, sels:[{mid,path,t,mk,k,line,o,l,ml,mt}]}]} : tout passe ou rien n'est enregistré.
  async place_bets(s, b) {
    const p = await me(s, b.token);
    if (await overLimit("place:" + p.id, 40, 60)) throw fail(429, "slow_down");
    const list = (Array.isArray(b.bets) ? b.bets : []).slice(0, 12);
    if (!list.length) throw fail(400, "empty");
    const bal = Number((await s.query(`select bal from players where id = $1`, [p.id]))[0].bal);
    const total = list.reduce((a, x) => a + int(x.stake, 0, 1e9), 0);
    if (list.some((x) => int(x.stake, 0, 1e9) < 1)) throw fail(400, "stake");
    if (total > bal + 0.5) return { error: "balance", bal: Math.round(bal) };
    const ok = [];
    for (let i = 0; i < list.length; i++) {
      const r = await checkBet(list[i]);
      if (!r.ok) return { ...r, index: i };
      ok.push(r);
    }
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const x = list[i], r = ok[i], cid = cleanName(x.cid, 40) || "b" + Date.now() + "-" + i;
      const legs = r.legs.map((L) => ({ mid: String(L.mid), path: String(L.path), eid: L.eid, t: L.t, sp: L.sp, lv: L.lv, mk: String(L.mk), k: L.k, line: L.line ?? null,
        o: Number(L.o), live: !!L.live, l: cleanName(L.l, 80), ml: cleanName(L.ml, 80), mt: cleanName(L.mt, 60) }));
      const row = (await s.query(`insert into bets (player, cid, stake, odds, combo, legs, groups) values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
         on conflict (player, cid) do nothing returning id`, [p.id, cid, int(x.stake, 1, 1e9), r.odds, !!(x.combo && legs.length > 1), JSON.stringify(legs), JSON.stringify(r.groups)]))[0];
      out.push({ cid, id: row ? row.id : null, odds: r.odds });
    }
    return { ok: true, bets: out };
  },

  // ---- Roue : tirage fait par le serveur (hasard cryptographique), un tour par jour (+ le tour bonus du jour offert) ----
  async wheel_spin(s, b) {
    const p = await me(s, b.token);
    const day = await parisDay(s);
    const w = (await s.query(`select wheel from players where id = $1`, [p.id]))[0].wheel || {};
    const extra = day === EG.EXTRA_DAY && w.b === day && w.x !== day;
    if (w.b === day && !extra) return { error: "done" };
    const jack = randomInt(EG.JACK_ODDS) === 0;
    let i = -1, v = EG.JACKPOT;
    if (!jack) { const r = randomInt(100); let c = 0; for (i = 0; i < EG.WP.length; i++) { c += EG.WP[i]; if (r < c) break; } v = EG.WHEEL[i]; }
    const we = EG.weekendOf(day), x2 = !jack && we.on && we.k === "roue";
    if (x2) v *= 2;
    const nw = extra ? { ...w, x: day } : { ...w, b: day };
    const u = await s.query(`update players set wheel = $2::jsonb where id = $1 and coalesce(wheel->>${extra ? "'x'" : "'b'"}, '') <> $3 returning id`, [p.id, JSON.stringify(nw), day]);
    if (!u[0]) return { error: "done" };
    await credit(s, p.id, v, "wheel", day + (extra ? "x" : ""));
    if (v >= 200) await s.query(`insert into activity (player, kind, data) values ($1, 'wheel', $2::jsonb)`, [p.id, JSON.stringify({ v })]);
    return { ok: true, i, v, jack, day, extra, x2 };
  },
  // ---- Défis du jour : vérifiés avec les paris enregistrés par le serveur ----
  async defi_claim(s, b) {
    const p = await me(s, b.token);
    const day = await parisDay(s);
    // on ne revérifie les paris (lent : flux ESPN) que si le défi dépend de paris gagnés pas encore réglés
    const needWin = b.all || ["w1e", "w1", "w2", "o25", "wcard", "wbt", "wcb"].includes(String(b.id || ""));
    if (needWin) await settleOpen(s, { player: p.id, budget: 5e3 });
    const rows = await s.query(`select legs, odds::float8 as odds, status, to_char(at at time zone 'Europe/Paris', 'YYYYMMDD') as d,
        to_char(settled_at at time zone 'Europe/Paris', 'YYYYMMDD') as sd from bets where player = $1 and (at > now() - interval '2 days' or settled_at > now() - interval '2 days')`, [p.id]);
    const P = rows.filter((r) => r.d === day), W = rows.filter((r) => r.status === "won" && r.sd === day);
    const we = EG.weekendOf(day), mul = we.on && we.k === "defis" ? 2 : 1;
    const D = EG.defisFor(day).map((d) => ({ id: d.id, r: d.r * mul, ok: d.f(P, W) >= d.g }));
    if (b.all) {
      const got = (await s.query(`select ref from ledger where player = $1 and kind = 'defi' and ref like $2`, [p.id, day + ":%"])).map((x) => x.ref.split(":")[1]);
      if (D.some((d) => !got.includes(d.id))) return { error: "not_done" };
      const ok = await credit(s, p.id, EG.DEFI_BONUS * mul, "defis", day);
      if (ok) await s.query(`insert into activity (player, kind, data) values ($1, 'defis', '{}'::jsonb)`, [p.id]);
      return ok ? { ok: true, v: EG.DEFI_BONUS * mul } : { error: "already" };
    }
    const d = D.find((x) => x.id === String(b.id || ""));
    if (!d) return { error: "unknown" };
    if (!d.ok) return { error: "not_done" };
    return (await credit(s, p.id, d.r, "defi", day + ":" + d.id)) ? { ok: true, v: d.r } : { error: "already" };
  },

  async cash_out(s, b) {
    const p = await me(s, b.token);
    const row = (await s.query(`select id, stake, odds, legs from bets where player = $1 and cid = $2 and status = 'open'`, [p.id, cleanName(b.cid, 40)]))[0];
    if (!row) return { error: "unknown" };
    const v = await cashValueServer(row);
    if (!v) return { error: "closed" };
    const u = await s.query(`update bets set status = 'cashed', pay = $2, settled_at = now() where id = $1 and status = 'open' returning id`, [row.id, v]);
    return u[0] ? { ok: true, pay: v } : { error: "closed" };
  },
  async admin_settle_report(s, b) {
    admin(b);
    const open = (await s.query(`select count(*)::int as n from bets where status = 'open'`))[0].n;
    const done = await s.query(`select status, count(*)::int as n from bets where status <> 'open' group by status`);
    const diffs = await s.query(`select d.*, pl.name from settle_diff d join players pl on pl.id = d.player order by d.at desc limit 50`);
    return { open, done, diffs };
  },

  // ---- Guildes ----
  async guild_update(s, b) {
    const p = await me(s, b.token);
    const code = cleanName(b.code, 8).toUpperCase(), role = await guildRole(s, code, p.id);
    if (role !== "chef" && role !== "adjoint") throw fail(403, "not_allowed");
    const e = b.emblem || {}, emblem = { i: EMBLEMS.includes(e.i) ? e.i : "🛡️", c: GCOLORS.includes(e.c) ? e.c : "#35d07f" };
    // un logo image posé par les organisateurs est conservé quand la guilde change son emblème
    const prevE = ((await s.query(`select emblem from leagues where code = $1`, [code]))[0] || {}).emblem;
    if (prevE && typeof prevE.img === "string" && GIMG.test(prevE.img)) emblem.img = prevE.img;
    if (prevE && typeof prevE.lg === "string" && /^\d{1,15}\.\d{1,6}$/.test(prevE.lg)) emblem.lg = prevE.lg;
    const access = ["open", "request", "private"].includes(b.access) ? b.access : "private";
    const name = cleanName(b.name, 24), motto = cleanName(b.motto, 60);
    if ((name && await badName(s, name)) || isBad(motto)) throw fail(400, "name_bad");
    await s.query(`update leagues set emblem = $2::jsonb, access = $3, motto = $4, name = case when $5 <> '' and $6 then $5 else name end where code = $1`,
      [code, JSON.stringify(emblem), access, motto || null, name, role === "chef"]);
    if (role === "chef" && typeof b.champ === "boolean") await s.query(`update leagues set champ = $2 where code = $1`, [code, b.champ]);
    return { ok: true };
  },
  async guild_members(s, b) {
    const p = await me(s, b.token);
    const code = cleanName(b.code, 8).toUpperCase(), role = await guildRole(s, code, p.id);
    if (!role) throw fail(403, "not_member");
    const owner = (await s.query(`select owner from leagues where code = $1`, [code]))[0].owner;
    const rows = await s.query(`select pl.id, pl.name, pl.avatar_v, m.role, extract(epoch from m.joined_at) * 1000 as since, extract(epoch from pl.seen_at) * 1000 as seen
       from league_members m join players pl on pl.id = m.player where m.code = $1 order by (pl.id = $2) desc, (m.role = 'officer') desc, m.joined_at`, [code, owner]);
    const req = role === "membre" ? [] : await s.query(`select pl.id, pl.name, pl.avatar_v, extract(epoch from r.at) * 1000 as at from requests r join players pl on pl.id = r.player where r.code = $1 order by r.at`, [code]);
    return { me: p.id, role, members: rows.map((r) => ({ id: r.id, name: r.name, av: r.avatar_v || 0, role: String(r.id) === String(owner) ? "chef" : r.role === "officer" ? "adjoint" : "membre",
      since: Math.round(Number(r.since)), seen: Math.round(Number(r.seen)) })), requests: req.map((r) => ({ id: r.id, name: r.name, av: r.avatar_v || 0, at: Math.round(Number(r.at)) })) };
  },
  async guild_kick(s, b) {
    const p = await me(s, b.token);
    const code = cleanName(b.code, 8).toUpperCase(), role = await guildRole(s, code, p.id), target = String(int(b.id, 0, 1e15));
    const trole = await guildRole(s, code, target);
    if (!trole || target === String(p.id)) throw fail(400, "unknown");
    if (!(role === "chef" || (role === "adjoint" && trole === "membre"))) throw fail(403, "not_allowed");
    await s.query(`delete from league_members where code = $1 and player = $2`, [code, target]);
    return { ok: true };
  },
  async guild_role(s, b) {
    const p = await me(s, b.token);
    const code = cleanName(b.code, 8).toUpperCase(), target = String(int(b.id, 0, 1e15));
    if ((await guildRole(s, code, p.id)) !== "chef") throw fail(403, "not_allowed");
    const trole = await guildRole(s, code, target);
    if (!trole || trole === "chef") throw fail(400, "unknown");
    if (b.role === "chef") {   // passer la main : l'ancien chef devient adjoint
      await s.query(`update leagues set owner = $2 where code = $1`, [code, target]);
      await s.query(`update league_members set role = 'officer' where code = $1 and player = $2`, [code, p.id]);
      await s.query(`update league_members set role = 'member' where code = $1 and player = $2`, [code, target]);
    } else await s.query(`update league_members set role = $3 where code = $1 and player = $2`, [code, target, b.role === "adjoint" ? "officer" : "member"]);
    return { ok: true };
  },
  // annuaire : guildes ouvertes ou sur demande, les plus actives d'abord
  async guild_dir(s, b) {
    const p = await me(s, b.token);
    const q = cleanName(b.q, 30);
    const rows = await s.query(`select l.code, l.gid, l.name, l.emblem, l.motto, l.access, l.elo, count(m.player)::int as n,
         count(*) filter (where pl.seen_at > now() - interval '7 days')::int as active,
         bool_or(m.player = $1) as mine, exists (select 1 from requests r where r.code = l.code and r.player = $1) as asked
       from leagues l join league_members m on m.code = l.code join players pl on pl.id = m.player
       where not l.dark and l.access in ('open', 'request') and ($2 = '' or l.name ilike '%' || $2 || '%')
       group by l.code order by active desc, n desc limit 50`, [p.id, q]);
    // le code d'une guilde sert d'invitation : on ne le montre qu'à ses membres
    return { guilds: rows.map((r) => ({ ...r, gid: String(r.gid), code: r.mine ? r.code : undefined, div: division(r.elo) })) };
  },
  // rejoindre depuis l'annuaire : tout de suite si ouverte, sinon une demande au chef et aux adjoints
  async guild_join(s, b, req) {
    const p = await me(s, b.token);
    if (await overLimit(ipKey(req) + ":join", 40, 3600)) throw fail(429, "slow_down");
    const l = (await s.query(b.gid ? `select code, name, access, owner from leagues where gid = $1 and not dark` : `select code, name, access, owner from leagues where code = $1 and not dark`,
      [b.gid ? String(int(b.gid, 0, 1e15)) : cleanName(b.code, 8).toUpperCase()]))[0];
    const code = l && l.code;
    if (!l || l.access === "private") throw fail(404, "unknown");
    if (l.access === "open") return { joined: true, ...(await addMember(s, code, p.id, p.name)) };
    await s.query(`insert into requests (code, player) values ($1, $2) on conflict do nothing`, [code, p.id]);
    const chiefs = (await s.query(`select player from league_members where code = $1 and (role = 'officer' or player = $2)`, [code, l.owner])).map((x) => x.player);
    await notify(s, chiefs, { title: `🛡️ ${l.name}`, body: `${p.name} demande à rejoindre la guilde.`, url: go("rank", code), tag: "req-" + code });
    return { requested: true, name: l.name };
  },
  async guild_answer(s, b) {
    const p = await me(s, b.token);
    const code = cleanName(b.code, 8).toUpperCase(), role = await guildRole(s, code, p.id), target = String(int(b.id, 0, 1e15));
    if (role !== "chef" && role !== "adjoint") throw fail(403, "not_allowed");
    const r = (await s.query(`delete from requests where code = $1 and player = $2 returning player`, [code, target]))[0];
    if (!r) throw fail(404, "unknown");
    const name = (await s.query(`select name from players where id = $1`, [target]))[0].name;
    if (b.accept) {
      const g = await addMember(s, code, target, name);
      await notify(s, [target], { title: `🛡️ ${g.name}`, body: "Ta demande est acceptée : bienvenue dans la guilde !", url: go("rank", code), tag: "acc-" + code });
    }
    return { ok: true };
  },

  // ---- Combats de guildes ----
  async battle_list(s, b) {
    const p = await me(s, b.token);
    const code = cleanName(b.code, 8).toUpperCase(), role = await guildRole(s, code, p.id);
    if (!role) throw fail(403, "not_member");
    const g = (await s.query(`select elo, bw, bl, bd, champ, (select count(*)::int from league_members m where m.code = l.code) as n from leagues l where code = $1`, [code]))[0];
    const rank = (await s.query(`select count(*)::int + 1 as r from leagues l where not l.dark and l.elo > $1 and (select count(*) from league_members m where m.code = l.code) >= $2`, [g.elo, MIN_BATTLE]))[0].r;
    const rows = await s.query(`select bt.id, bt.kind, bt.week, bt.a, bt.b, bt.status, bt.a_score::float8 as a_score, bt.b_score::float8 as b_score, bt.winner, bt.a_delta, bt.b_delta,
         extract(epoch from ((bt.week::date + 7)::timestamp at time zone 'Europe/Paris')) * 1000 as wend
       from battles bt where (bt.a = $1 or bt.b = $1) and (bt.status in ('live', 'ready', 'pending') or (bt.status = 'done' and bt.settled_at > now() - interval '120 days'))
       order by bt.week desc, bt.id desc limit 30`, [code]);
    const opp = [...new Set(rows.map((x) => (x.a === code ? x.b : x.a)))];
    const L = opp.length ? Object.fromEntries((await s.query(`select l.code, l.gid, l.name, l.emblem, l.elo, (select count(*)::int from league_members m where m.code = l.code) as n
       from leagues l where l.code = any($1::text[])`, [opp])).map((x) => [x.code, x])) : {};
    const live = rows.filter((x) => x.status === "live"), sc = await battleScores(s, live.map((x) => x.id));
    const out = [];
    for (const x of rows) {
      const side = x.a === code ? "a" : "b", o = L[side === "a" ? x.b : x.a];
      if (!o) continue;
      const B = { id: x.id, kind: x.kind, week: x.week, status: x.status, end: Math.round(Number(x.wend)), incoming: side === "b",
        vs: { gid: String(o.gid), name: o.name, emblem: o.emblem, elo: o.elo, div: division(o.elo), n: o.n } };
      if (x.status === "live") {
        const m = sc[x.id + "|" + code] || { n: 0, avg: 0 }, t = sc[x.id + "|" + (side === "a" ? x.b : x.a)] || { n: 0, avg: 0 };
        Object.assign(B, { my: m.avg, their: t.avg, myN: m.n, theirN: t.n });
        B.team = (await s.query(`select pl.id, pl.name, pl.avatar_v, pr.gain::float8 as gain from battle_members bm join players pl on pl.id = bm.player
           left join sprofits pr on pr.player = bm.player and pr.per = $3 where bm.battle = $1 and bm.code = $2 order by pr.gain desc nulls last, pl.name`, [x.id, code, x.week]))
          .map((r) => ({ id: r.id, name: r.name, av: r.avatar_v || 0, gain: r.gain == null ? null : Math.round(r.gain) }));
      }
      if (x.status === "done") {
        Object.assign(B, { my: side === "a" ? x.a_score : x.b_score, their: side === "a" ? x.b_score : x.a_score, delta: side === "a" ? x.a_delta : x.b_delta,
          res: !x.winner ? "d" : x.winner === code ? "w" : "l" });
      }
      out.push(B);
    }
    const nw = (await s.query(`select ${NEXT_WEEK} as w`))[0].w;
    return { me: p.id, role, next: nw, guild: { elo: g.elo, div: division(g.elo), w: g.bw, l: g.bl, d: g.bd, champ: g.champ, n: g.n, rank, ok: g.n >= MIN_BATTLE },
      battles: out, reward: BREWARD, min: MIN_BATTLE };
  },
  // classement mondial des guildes (cote Elo) ; jamais le code d'une guilde (il sert d'invitation)
  async guild_ranking(s, b) {
    const p = await me(s, b.token);
    const rows = await s.query(`select l.gid, l.name, l.emblem, l.elo, l.bw, l.bl, l.bd, count(m.player)::int as n, bool_or(m.player = $1) as mine
       from leagues l join league_members m on m.code = l.code where not l.dark group by l.code having count(m.player) >= $2
       order by l.elo desc, l.bw desc, l.gid limit 100`, [p.id, MIN_BATTLE]);
    return { guilds: rows.map((r) => ({ gid: String(r.gid), name: r.name, emblem: r.emblem, elo: r.elo, div: division(r.elo), w: r.bw, l: r.bl, d: r.bd, n: r.n, mine: !!r.mine })) };
  },
  // défi : le chef ou un adjoint défie une autre guilde, pour la semaine prochaine
  async battle_challenge(s, b) {
    const p = await me(s, b.token);
    const code = cleanName(b.code, 8).toUpperCase(), role = await guildRole(s, code, p.id);
    if (role !== "chef" && role !== "adjoint") throw fail(403, "not_allowed");
    const T = (await s.query(`select l.code, l.name, l.owner, (select count(*)::int from league_members m where m.code = l.code) as n from leagues l where l.gid = $1 and not l.dark`, [String(int(b.gid, 0, 1e15))]))[0];
    const M = (await s.query(`select name, (select count(*)::int from league_members m where m.code = l.code) as n from leagues l where code = $1`, [code]))[0];
    if (!T || T.code === code) throw fail(404, "unknown");
    if (M.n < MIN_BATTLE || T.n < MIN_BATTLE) throw fail(400, "too_small");
    const w = (await s.query(`select ${NEXT_WEEK} as w`))[0].w;
    const busy = await s.query(`select a, b, status from battles where kind = 'challenge' and week = $1 and status in ('pending', 'ready') and (a in ($2, $3) or b in ($2, $3))`, [w, code, T.code]);
    if (busy.some((x) => (x.a === code && x.b === T.code) || (x.a === T.code && x.b === code))) throw fail(400, "already");
    if (busy.some((x) => x.status === "ready")) throw fail(400, "busy");
    if (busy.filter((x) => x.a === code).length >= 3) throw fail(400, "too_many");
    await s.query(`insert into battles (kind, week, a, b, status, by_player) values ('challenge', $1, $2, $3, 'pending', $4)`, [w, code, T.code, p.id]);
    const chiefs = (await s.query(`select player from league_members where code = $1 and (role = 'officer' or player = $2)`, [T.code, T.owner])).map((x) => x.player);
    await notify(s, chiefs, { title: `⚔️ ${M.name} défie ${T.name} !`, body: "Un combat d'une semaine, à partir de lundi. Le chef ou un adjoint peut accepter ou refuser.", url: go("fights", T.code), tag: "chal-" + T.code });
    return { ok: true, week: w };
  },
  // répondre à un défi reçu (chef/adjoint de la guilde défiée) ou retirer un défi envoyé
  async battle_answer(s, b) {
    const p = await me(s, b.token);
    const bt = (await s.query(`select bt.*, la.name as na, lb.name as nb from battles bt join leagues la on la.code = bt.a join leagues lb on lb.code = bt.b
       where bt.id = $1 and bt.kind = 'challenge' and bt.status = 'pending'`, [String(int(b.id, 0, 1e15))]))[0];
    if (!bt) throw fail(404, "unknown");
    const rb = await guildRole(s, bt.b, p.id), ra = await guildRole(s, bt.a, p.id);
    const boss = (r) => r === "chef" || r === "adjoint";
    if (!b.accept && boss(ra)) { await s.query(`update battles set status = 'cancel' where id = $1 and status = 'pending'`, [bt.id]); return { ok: true }; }
    if (!boss(rb)) throw fail(403, "not_allowed");
    if (!b.accept) {
      await s.query(`update battles set status = 'refused' where id = $1 and status = 'pending'`, [bt.id]);
      const chiefs = (await s.query(`select m.player from league_members m join leagues l on l.code = m.code where m.code = $1 and (m.role = 'officer' or m.player = l.owner)`, [bt.a])).map((x) => x.player);
      await notify(s, chiefs, { title: `⚔️ ${bt.nb} refuse le défi`, body: "Trouve un autre adversaire dans le classement des guildes.", url: go("fights", bt.a), tag: "chal-" + bt.a });
      return { ok: true };
    }
    if ((await s.query(`select 1 from battles where kind = 'challenge' and week = $1 and status = 'ready' and (a in ($2, $3) or b in ($2, $3))`, [bt.week, bt.a, bt.b]))[0]) throw fail(400, "busy");
    if (!(await s.query(`update battles set status = 'ready' where id = $1 and status = 'pending' returning id`, [bt.id]))[0]) throw fail(404, "unknown");
    // un seul défi par semaine : les autres défis en attente de ces deux guildes tombent
    await s.query(`update battles set status = 'expired' where kind = 'challenge' and week = $1 and status = 'pending' and (a in ($2, $3) or b in ($2, $3))`, [bt.week, bt.a, bt.b]);
    for (const [c, o] of [[bt.a, bt.nb], [bt.b, bt.na]])
      await notify(s, await members(s, c), { title: `⚔️ Défi accepté contre ${o}`, body: "Ça commence lundi, pour une semaine : la moyenne des gains en paris de tous les membres compte. Préparez-vous !", url: go("fights", c), tag: "battle-" + bt.id });
    return { ok: true };
  },
  // récompenses de combats, créditées par le téléphone (et notées au registre)
  async battle_claim(s, b) {
    const p = await me(s, b.token);
    const r = await s.query(`update battle_rewards r set claimed = true from battles bt where bt.id = r.battle and r.player = $1 and not r.claimed returning r.battle, r.amount, r.result`, [p.id]);
    for (const x of r) await credit(s, p.id, x.amount, "battle", x.battle);
    return { rewards: r.map((x) => ({ amount: x.amount, result: x.result })) };
  },
  // ---- Modération : signaler un message, un pseudo ou une guilde. Tout est automatique :
  // message masqué dès 2 signalements (3 dans une guilde de plus de 6), pseudo ou nom de guilde remplacé dès 3 joueurs différents.
  async report(s, b) {
    const p = await me(s, b.token);
    if (await overLimit("report:" + p.id, 30, 3600)) throw fail(429, "slow_down");
    const kind = ["chat", "player", "guild"].includes(b.kind) ? b.kind : null;
    if (!kind) throw fail(400, "kind");
    const id = String(int(b.id, 0, 1e15));
    if (kind === "chat") {
      const m = (await s.query(`select c.code, c.player, c.text, (select count(*)::int from league_members x where x.code = c.code) as n from chat c where c.id = $1`, [id]))[0];
      if (!m || !(await isMember(s, m.code, p.id)) || String(m.player) === String(p.id)) throw fail(404, "unknown");
      await s.query(`insert into reports (reporter, kind, target, text) values ($1, 'chat', $2, $3) on conflict do nothing`, [p.id, id, m.text.slice(0, 400)]);
      const n = (await s.query(`select count(*)::int as n from reports where kind = 'chat' and target = $1`, [id]))[0].n;
      if (n >= (m.n > 6 ? 3 : 2)) await s.query(`update chat set hidden = true where id = $1`, [id]);
      return { ok: true, hidden: n >= (m.n > 6 ? 3 : 2) };
    }
    if (kind === "player") {
      const t = (await s.query(`select id, name from players where id = $1`, [id]))[0];
      if (!t || String(t.id) === String(p.id)) throw fail(404, "unknown");
      await s.query(`insert into reports (reporter, kind, target, text) values ($1, 'player', $2, $3) on conflict do nothing`, [p.id, id, t.name]);
      const n = (await s.query(`select count(*)::int as n from reports where kind = 'player' and target = $1 and text = $2`, [id, t.name]))[0].n;
      if (n < 3) return { ok: true };
      await banName(s, t.name);
      for (let i = 0; i < 5; i++) {
        try { await s.query(`update players set name = $2 where id = $1`, [id, "Joueur " + (1000 + randomInt(9000))]); break; } catch (e) { if (!isTaken(e)) throw e; }
      }
      await notify(s, [id], { title: "Ton pseudo a été remplacé", body: "Plusieurs joueurs l'ont signalé. Choisis-en un autre dans Carrière › Pseudo.", url: "./", tag: "rename" });
      return { ok: true, renamed: true };
    }
    const g = (await s.query(`select code, name from leagues where gid = $1 and not dark`, [id]))[0];
    if (!g || (await isMember(s, g.code, p.id))) throw fail(404, "unknown");
    await s.query(`insert into reports (reporter, kind, target, text) values ($1, 'guild', $2, $3) on conflict do nothing`, [p.id, g.code, g.name]);
    const n = (await s.query(`select count(*)::int as n from reports where kind = 'guild' and target = $1 and text = $2`, [g.code, g.name]))[0].n;
    if (n < 3) return { ok: true };
    await banName(s, g.name);
    await s.query(`update leagues set name = $2, motto = null, logo = null, emblem = coalesce(emblem, '{}'::jsonb) - 'lg' - 'img' where code = $1`, [g.code, "Guilde " + id]);
    return { ok: true, renamed: true };
  },
  // écrire aux organisateurs (question, bug, signalement grave)
  async contact(s, b) {
    const p = await me(s, b.token);
    if (await overLimit("contact:" + p.id, 5, 3600)) throw fail(429, "slow_down");
    const text = String(b.text ?? "").replace(/[\u0000-\u0008\u000b-\u001f]/g, "").trim().slice(0, 1500);
    if (text.length < 3) throw fail(400, "empty");
    const why = String(b.why ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 40);
    await s.query(`insert into reports (reporter, kind, target, text) values ($1, 'contact', $3, $2)`, [p.id, text, why]);
    await mailContact(p, text, why);
    return { ok: true };
  },
  // supprimer son compte : tout ce qui est lié au joueur part avec lui ; ses guildes passent à un autre membre
  async delete_account(s, b) {
    const p = await me(s, b.token);
    if (b.confirm !== "SUPPRIMER") throw fail(400, "confirm");
    await s.query(`update leagues l set owner = (select m.player from league_members m where m.code = l.code and m.player <> $1 order by (m.role = 'officer') desc, m.joined_at limit 1)
       where l.owner = $1`, [p.id]);
    await s.query(`delete from players where id = $1`, [p.id]);
    await s.query(`delete from leagues l where not exists (select 1 from league_members m where m.code = l.code)`);
    return { ok: true };
  },
  async admin_reports(s, b) {
    admin(b);
    const rows = await s.query(`select r.id, r.kind, r.target, r.text, r.at, pl.name as reporter from reports r left join players pl on pl.id = r.reporter order by r.id desc limit 200`);
    return { reports: rows };
  },
  // ---- Premiers pas : petites missions vérifiées par le serveur, 50 jetons chacune (+100 quand tout est fait) ----
  async guide_status(s, b) {
    const p = await me(s, b.token);
    return await guideState(s, p.id);
  },
  // apparaître (pseudo, carte, résultats) dans les publications Instagram / Facebook de Tribune
  async social_pref(s, b) {
    const p = await me(s, b.token);
    await s.query(`update players set social_ok = $2 where id = $1`, [p.id, b.ok !== false]);
    return { ok: true, social_ok: b.ok !== false };
  },
  // le joueur a ouvert le compte Instagram / la Page Facebook (missions « Suivre Tribune sur … »)
  async insta_click(s, b) {
    const p = await me(s, b.token);
    await credit(s, p.id, 0, "insta", "click");
    return { ok: true };
  },
  async fb_click(s, b) {
    const p = await me(s, b.token);
    await credit(s, p.id, 0, "fb", "click");
    return { ok: true };
  },
  async guide_claim(s, b) {
    const p = await me(s, b.token);
    const st = await guideState(s, p.id), step = String(b.step || "");
    const ok = step === "all" ? GUIDE.every((g) => st.done[g]) : GUIDE.includes(step) && st.done[step];
    if (!ok) throw fail(400, "not_done");
    const amount = step === "all" ? GUIDE_ALL : GUIDE_REWARD;
    return { ok: true, amount: (await credit(s, p.id, amount, "guide", step)) ? amount : 0 };
  },
  // cadeaux calculés par le serveur (bonus des combinés du week-end…), versés une seule fois
  async gifts_claim(s, b) {
    const p = await me(s, b.token);
    try { await refCheck(s, p.id); } catch (e) { console.error(e); }
    const r = await s.query(`update gifts set claimed = true where player = $1 and not claimed returning kind, ref, amount, label`, [p.id]);
    for (const x of r) await credit(s, p.id, x.amount, x.kind, x.ref);
    return { gifts: r.map((x) => ({ amount: x.amount, label: x.label })) };
  },
  // les 1 000 jetons de départ (gagnés sur le match d'entraînement) : notés une fois, seulement pour un compte tout neuf
  // statistiques de la guilde (paris enregistrés par le serveur, membres actuels)
  async guild_stats(s, b) {
    const p = await me(s, b.token);
    const code = cleanName(b.code, 8).toUpperCase();
    if (!(await isMember(s, code, p.id))) throw fail(403, "not_member");
    const B = await s.query(`select x.player, pl.name, pl.avatar_v, x.stake, x.odds::float8 as odds, x.pay::float8 as pay, x.status, x.legs, x.combo
       from bets x join league_members m on m.player = x.player and m.code = $1 join players pl on pl.id = x.player
       where x.at > now() - interval '60 days'`, [code]);
    const done = B.filter((x) => ["won", "lost", "cashed"].includes(x.status)), won = done.filter((x) => x.status === "won");
    const sp = {}, mk = {};
    for (const x of B) for (const L of x.legs || []) { sp[L.sp || "foot"] = (sp[L.sp || "foot"] || 0) + 1; mk[L.mt || L.mk] = (mk[L.mt || L.mk] || 0) + 1; }
    const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1])[0] || null;
    const by = {};
    for (const x of done) { const g = x.status === "lost" ? -x.stake : (x.pay || 0) - x.stake, o = by[x.player] || (by[x.player] = { id: x.player, name: x.name, av: x.avatar_v || 0, n: 0, w: 0, net: 0 }); o.n++; if (x.status === "won") o.w++; o.net += g; }
    const people = Object.values(by), pick = (f) => people.filter((x) => x.n >= 3).sort(f)[0] || null;
    const bo = won.sort((a, b) => b.odds - a.odds)[0], bg = won.slice().sort((a, b) => (b.pay - b.stake) - (a.pay - a.stake))[0];
    const who = (x) => x && { id: x.player, name: x.name, av: x.avatar_v || 0 };
    return { bets: B.length, settled: done.length, rate: done.length ? Math.round((won.length / done.length) * 100) : 0, combos: B.filter((x) => x.combo).length,
      staked: B.reduce((a, x) => a + x.stake, 0), sport: top(sp), market: top(mk),
      best: pick((a, b) => b.net - a.net), sniper: pick((a, b) => b.w / b.n - a.w / a.n), busy: people.sort((a, b) => b.n - a.n)[0] || null,
      bestOdds: bo ? { ...who(bo), odds: bo.odds, label: (bo.legs[0] || {}).l, n: bo.legs.length } : null,
      bigWin: bg ? { ...who(bg), gain: Math.round(bg.pay - bg.stake), odds: bg.odds } : null };
  },
  // partager un pari : code court (le même à chaque partage du même pari)
  // l'app installée vient de s'ouvrir : un ticket a-t-il été ouvert dans Safari sur cette connexion il y a moins de 20 min ?
  async pending_ticket(s, b, req) {
    const p = await me(s, b.token);
    const r = await s.query(`select code from link_hits where ip = $1 and at > now() - interval '20 minutes' order by at desc limit 3`, [ipKey(req)]);
    for (const x of r) if (await credit(s, p.id, 0, "pend", x.code)) return { code: x.code };
    return { code: null };
  },
  // parrainage : mon lien, mes filleuls
  async ref_get(s, b) {
    const p = await me(s, b.token);
    const code = await refCode(s, p.id);
    try { await refCheck(s, p.id); } catch (e) { console.error(e); }
    const fl = await s.query(`select f.id, f.name, f.avatar_v, (select count(*)::int from bets x where x.player = f.id and x.status in ('won', 'lost', 'cashed')) as n,
        exists (select 1 from gifts g where g.player = $1 and g.kind = 'parrain' and g.ref = f.id::text) as ok
        from players f where f.ref_by = $1 order by f.created_at desc limit 50`, [p.id]);
    const earned = (await s.query(`select coalesce(sum(amount), 0)::int as t from gifts where player = $1 and kind = 'parrain'`, [p.id]))[0].t;
    return { code, earned, give: REF_GIVE, gets: REF_NEW, need: REF_BETS, max: REF_MAX,
      friends: fl.map((f) => ({ id: f.id, name: f.name, av: f.avatar_v || 0, n: Math.min(f.n, REF_BETS), ok: f.ok })) };
  },
  // qui m'invite ? (sans compte) ; mark = lien ouvert dans Safari avant d'installer l'appli
  async ref_info(s, b, req) {
    let code = cleanRef(b.code);
    // appli installée sur iPhone (stockage séparé de Safari) : le lien a-t-il été ouvert sur cette connexion ?
    if (!code && b.pending && req) { const h = (await s.query(`select code from link_hits where ip = $1 and code like 'R:%' and at > now() - interval '2 hours' order by at desc limit 1`, [ipKey(req)]))[0]; if (h) code = h.code.slice(2); }
    const r = code ? (await s.query(`select name from players where ref_code = $1`, [code]))[0] : null;
    if (!r) return { name: null };
    if (b.mark && req) {
      await s.query(`delete from link_hits where at < now() - interval '3 hours'`);
      await s.query(`insert into link_hits (ip, code) values ($1, $2) on conflict (ip, code) do update set at = now()`, [ipKey(req), "R:" + code]);
    }
    return { name: r.name, gets: REF_NEW, code };
  },
  // mon style : ce que j'ai débloqué et ce que j'affiche
  async cos_get(s, b) {
    const p = await me(s, b.token);
    const f = await cosFlags(s, p.id), cur = (await s.query(`select cos from players where id = $1`, [p.id]))[0].cos || {};
    return { flags: f, unlocked: EG.cosUnlocked(f), cos: cur };
  },
  async cos_set(s, b) {
    const p = await me(s, b.token);
    const un = new Set(EG.cosUnlocked(await cosFlags(s, p.id))), pick = (v, ty) => (typeof v === "string" && un.has(v) && (v.startsWith("tm:") ? ty === "t" : v[0] === ty) ? v : null);
    const cos = { b: pick(b.b, "b"), c: pick(b.c, "c"), t: pick(b.t, "t"), f: pick(b.f, "f"), e: pick(b.e, "e"), v: pick(b.v, "v"), y: pick(b.y, "y") };
    const prevK = ((await s.query(`select cos from players where id = $1`, [p.id]))[0] || {}).cos;
    if (prevK && prevK.k) cos.k = cardOpts(prevK.k);
    await s.query(`update players set cos = $2::jsonb where id = $1`, [p.id, JSON.stringify(cos)]);
    return { ok: true, cos };
  },
  // réglages de la carte de joueur (design, écusson, texte, sport) : visibles par tous ceux qui ouvrent la carte
  async card_set(s, b) {
    const p = await me(s, b.token);
    const k = cardOpts(b.k || {});
    await s.query(`update players set cos = coalesce(cos, '{}'::jsonb) || jsonb_build_object('k', $2::jsonb) where id = $1`, [p.id, JSON.stringify(k)]);
    return { ok: true, k };
  },
  // style offert à un joueur (pack exclusif) : organisateurs seulement
  async admin_cos_grant(s, b) {
    admin(b);
    const key = String(b.req || "").replace(/[^a-z0-9]/g, "").slice(0, 20);
    if (!EG.COS_SECRET.includes(key)) throw fail(400, "unknown");
    const r = await s.query(`update players set cos_grant = (select coalesce(jsonb_agg(distinct x), '[]'::jsonb) from jsonb_array_elements_text(coalesce(cos_grant, '[]'::jsonb) || $2::jsonb) x)
       where lower(name) = lower($1) returning id, name, cos_grant`, [String(b.name || ""), JSON.stringify([key])]);
    return { ok: !!r[0], players: r };
  },
  // mode testeur : tout le style débloqué pour un joueur (organisateurs seulement)
  // logo de la guilde envoyé depuis le téléphone (chef ou adjoint) ; null le retire
  async guild_logo(s, b) {
    const p = await me(s, b.token);
    const code = cleanName(b.code, 8).toUpperCase(), role = await guildRole(s, code, p.id);
    if (role !== "chef" && role !== "adjoint") throw fail(403, "not_allowed");
    if (b.img == null) {
      const r = await s.query(`update leagues set logo = null, emblem = coalesce(emblem, '{}'::jsonb) - 'lg' - 'img' where code = $1 returning emblem`, [code]);
      return { ok: true, emblem: r[0] && r[0].emblem };
    }
    const img = String(b.img);
    if (!/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(img) || img.length > 220000) throw fail(400, "image");
    const cur = (await s.query(`select gid, emblem from leagues where code = $1`, [code]))[0];
    if (!cur) throw fail(404, "none");
    const v = ((cur.emblem && String(cur.emblem.lg || "").split(".")[1]) | 0) + 1, lg = `${cur.gid}.${v}`;
    const r = await s.query(`update leagues set logo = $2, emblem = (coalesce(emblem, '{}'::jsonb) - 'img') || jsonb_build_object('lg', $3::text) where code = $1 returning emblem`, [code, img, lg]);
    return { ok: true, emblem: r[0].emblem };
  },
  async admin_guild_img(s, b) {
    admin(b);
    const img = String(b.img || "");
    if (img && !GIMG.test(img)) throw fail(400, "bad_img");
    const r = await s.query(`update leagues set logo = case when $2 = '' then null else logo end, emblem = case when $2 = '' then coalesce(emblem, '{}'::jsonb) - 'img' - 'lg' else (coalesce(emblem, '{}'::jsonb) - 'lg') || jsonb_build_object('img', $2::text) end
       where lower(name) = lower($1) returning code, name, emblem`, [String(b.name || ""), img]);
    if (!r[0]) return { ok: false, guilds: (await s.query(`select code, name from leagues order by name`)).map((x) => x.name) };
    return { ok: true, guilds: r };
  },
  // liste des compétitions d'un sport chez ESPN (pour en ajouter) : organisateurs seulement
  async admin_espn_leagues(s, b) {
    admin(b);
    const sport = ["rugby", "soccer", "tennis", "basketball"].includes(b.sport) ? b.sport : "rugby";
    const get0 = async (u) => { const c = new AbortController(), t = setTimeout(() => c.abort(), 6000); try { const r = await fetch(u, { signal: c.signal }); return r.ok ? r.json() : null; } catch (e) { return null; } finally { clearTimeout(t); } };
    // essai d'un fil de matchs : ?test=rugby/24400 (+ dates)
    if (b.test) { const path = String(b.test).replace(/[^a-z0-9./_-]/gi, ""), d = String(b.dates || "").replace(/[^0-9-]/g, "");
      const j = await get0(`https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard?limit=200${d ? "&dates=" + d : ""}`);
      if (!j) return { ok: false };
      return { ok: true, league: j.leagues && j.leagues[0] && { id: j.leagues[0].id, uid: j.leagues[0].uid, name: j.leagues[0].name, slug: j.leagues[0].slug },
        events: (j.events || []).slice(0, 40).map((e) => [e.date, e.name]) }; }
    if (b.raw) return { raw: await get0(`https://sports.core.api.espn.com/v2/sports/${sport}/leagues/${String(b.raw).replace(/[^0-9]/g, "")}`) };
    const get = async (u) => { const c = new AbortController(), t = setTimeout(() => c.abort(), 6000); try { const r = await fetch(u, { signal: c.signal }); return r.ok ? r.json() : null; } catch (e) { return null; } finally { clearTimeout(t); } };
    const list = await get(`https://sports.core.api.espn.com/v2/sports/${sport}/leagues?limit=400`);
    const refs = ((list && list.items) || []).map((x) => x.$ref).filter(Boolean);
    const q = String(b.q || "").toLowerCase(), out = [];
    for (let i = 0; i < refs.length; i += 40) {
      const part = await Promise.all(refs.slice(i, i + 40).map(get));
      for (const L of part) if (L && (!q || String(L.name || "").toLowerCase().includes(q) || String(L.abbreviation || "").toLowerCase().includes(q)))
        out.push({ id: L.id, slug: L.slug, name: L.name, abbr: L.abbreviation, season: L.season && L.season.year });
    }
    return { count: refs.length, leagues: out };
  },
  // ---- Programmateur Instagram + Facebook (organisateurs seulement) ----
  async admin_social_setup(s, b) {
    admin(b);
    const tok = String(b.user_token || process.env.META_USER_TOKEN || "");
    if (!tok) throw fail(400, "token");
    try { return { ok: true, ...(await SOCIAL.setup(s, tok)) }; } catch (e) { return { ok: false, error: e.message }; }
  },
  async admin_social_check(s, b) {
    admin(b);
    try { return { ok: true, ...(await SOCIAL.check(s)) }; } catch (e) { return { ok: false, error: e.message }; }
  },
  async admin_social_add(s, b) {
    admin(b);
    const kind = ["story", "carousel", "reel"].includes(b.kind) ? b.kind : "post", nets = (Array.isArray(b.networks) ? b.networks : ["instagram", "facebook"]).filter((x) => x === "instagram" || x === "facebook");
    const at = new Date(String(b.at || "")); if (isNaN(at)) throw fail(400, "date");
    const okImg = (u) => (kind === "reel" ? /^https:\/\/[^\s]+\.mp4$/i : /^https:\/\/[^\s]+\.(png|jpe?g)$/i).test(String(u || ""));
    const imgs = kind === "carousel" ? (Array.isArray(b.images) ? b.images.map(String) : []) : null;
    if (imgs && (imgs.length < 2 || imgs.length > 10 || !imgs.every(okImg))) throw fail(400, "images");
    const img = imgs ? imgs[0] : String(b.image || "");
    if (!okImg(img)) throw fail(400, "image");
    const r = await s.query(`insert into social_posts (at, kind, networks, image, images, caption_ig, caption_fb, label, status) values ($1, $2, $3::jsonb, $4, $9::jsonb, $5, $6, $7, $8) returning id`,
      [at.toISOString(), kind, JSON.stringify(nets), img, b.caption_ig ? String(b.caption_ig).slice(0, 2200) : null, b.caption_fb ? String(b.caption_fb).slice(0, 5000) : null, b.label ? String(b.label).slice(0, 80) : null, b.approve ? "approved" : "draft", imgs ? JSON.stringify(imgs) : null]);
    return { ok: true, id: r[0].id };
  },
  // publier tout de suite ce qui est validé et dû (sans attendre le passage automatique)
  async admin_social_run(s, b) {
    admin(b);
    const n = await SOCIAL.publishDue(s);
    return { published: n, posts: await s.query(`select id, label, status, error, result from social_posts where published_at > now() - interval '10 minutes' or status in ('error', 'publishing') order by id desc limit 5`) };
  },
  // état d'une vidéo Facebook (Reel) après publication
  async admin_social_video(s, b) {
    admin(b);
    const c = await SOCIAL.creds(s);
    const id = b.id === "page" ? c.page : String(b.id || "").replace(/[^0-9]/g, "");
    const fields = b.id === "page" ? "name,username,link,is_published,is_webhooks_subscribed,followers_count,fan_count,category,verification_status" : "status,permalink_url,published";
    return await SOCIAL.call(SOCIAL.G(id), { access_token: c.tok, fields }, "GET");
  },
  async admin_social_list(s, b) {
    admin(b);
    return { posts: await s.query(`select id, label, kind, networks, image, images, status, error, result, to_char(at at time zone 'Europe/Paris', 'DD/MM HH24:MI') as quand, published_at
      from social_posts where at > now() - interval '14 days' or status <> 'published' order by at`),
      configured: !!(await SOCIAL.kvGet(s, "meta_page_token")) };
  },
  async admin_social_set(s, b) {
    admin(b);
    const st = ["draft", "approved", "cancelled"].includes(b.status) ? b.status : null;
    if (!st) throw fail(400, "status");
    const r = await s.query(`update social_posts set status = $2, error = null where id = $1 and status <> 'published' returning id, status`, [String(int(b.id, 0, 1e15)), st]);
    return { ok: !!r[0] };
  },
  async admin_cos_all(s, b) {
    admin(b);
    const r = await s.query(`update players set cos_all = $2 where lower(name) = lower($1) returning id, name`, [String(b.name || ""), b.on !== false]);
    return { ok: !!r[0], players: r };
  },
  async share_bet(s, b) {
    const p = await me(s, b.token);
    const bt = (await s.query(`select id from bets where player = $1 and cid = $2`, [p.id, cleanName(b.cid, 40)]))[0];
    if (!bt) throw fail(404, "unknown");
    const old = (await s.query(`select code from shared_bets where bet = $1`, [bt.id]))[0];
    if (old) return { code: old.code };
    for (let i = 0; i < 6; i++) {
      let code = "";
      for (let k = 0; k < 7; k++) code += CODE_CHARS[randomInt(CODE_CHARS.length)];
      const r = await s.query(`insert into shared_bets (code, bet) values ($1, $2) on conflict do nothing returning code`, [code, bt.id]);
      if (r[0]) {
        const x = (await s.query(`select stake, odds::float8 as odds, legs from bets where id = $1`, [bt.id]))[0];
        await s.query(`insert into activity (player, kind, data) values ($1, 'share', $2::jsonb)`, [p.id, JSON.stringify({ code, odds: x.odds, stake: x.stake, n: x.legs.length, l: (x.legs[0] || {}).l || "" })]);
        return { code };
      }
    }
    throw fail(500, "code");
  },
  // voir un ticket partagé (sans compte) ; follow = « je suis ce pari » (compté une fois par joueur)
  async shared_bet(s, b, req) {
    const code = cleanName(b.code, 10).toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (b.mark && req) {
      await s.query(`delete from link_hits where at < now() - interval '1 hour'`);
      await s.query(`insert into link_hits (ip, code) values ($1, $2) on conflict (ip, code) do update set at = now()`, [ipKey(req), code]);
    }
    const r = (await s.query(`select sb.code, sb.follows, x.player, pl.name, pl.avatar_v, x.stake, x.odds::float8 as odds, x.status, x.pay::float8 as pay, x.combo, x.legs,
         extract(epoch from x.at) * 1000 as at from shared_bets sb join bets x on x.id = sb.bet join players pl on pl.id = x.player where sb.code = $1`, [code]))[0];
    if (!r) throw fail(404, "unknown");
    if (b.follow && b.token) {
      const p = await me(s, b.token);
      if (String(p.id) !== String(r.player) && await credit(s, p.id, 0, "follow", code)) {
        await s.query(`update shared_bets set follows = follows + 1 where code = $1`, [code]);
        r.follows++;
        await notify(s, [r.player], { title: "🎟️ Quelqu'un suit ton pari !", body: `${p.name} a suivi ton ticket (cote ${Number(r.odds).toFixed(2).replace(".", ",")}). Pas de pression 😏`, url: "./?go=bets", tag: "follow-" + code });
      }
    }
    const legs = (r.legs || []).map((L) => ({ mid: L.mid, path: L.path, t: L.t, sp: L.sp, mk: L.mk, k: L.k, line: L.line, o: L.o, l: L.l, ml: L.ml, mt: L.mt, r: L.r || null }));
    return { code: r.code, name: r.name, pid: r.player, av: r.avatar_v || 0, stake: r.stake, odds: r.odds, status: r.status, pay: r.pay, combo: r.combo, legs,
      at: Math.round(Number(r.at)), follows: r.follows };
  },
  async starter_log(s, b) {
    const p = await me(s, b.token);
    const ok = (await s.query(`select 1 from players where id = $1 and created_at > now() - interval '3 days'`, [p.id]))[0];
    return { ok: !!ok && (await credit(s, p.id, 1000, "starter", "1")) };
  },
  // « Recommencer » : le joueur repart de 1 000 jetons, nouveau solde de référence
  async reset_log(s, b) {
    const p = await me(s, b.token);
    await s.query(`insert into audit_base (player, bal, at) values ($1, 1000, now()) on conflict (player) do update set bal = 1000, at = now()`, [p.id]);
    return { ok: true };
  },
  // anti-triche : pour chaque joueur, solde attendu d'après le serveur (référence + registre + paris) comparé au solde annoncé par son téléphone,
  // et gains de la semaine / du mois annoncés comparés à ceux calculés par le serveur
  async admin_audit(s, b) {
    admin(b);
    const rows = await s.query(`with a as (select p.id, p.name, p.bal::float8 as bal, p.seen_at, ab.bal::float8 as base, ab.at from players p join audit_base ab on ab.player = p.id)
      select a.id, a.name, a.bal, a.base, a.at, a.seen_at,
        coalesce((select sum(l.delta) from ledger l where l.player = a.id and l.at > a.at and l.at <= a.seen_at), 0)::float8 as led,
        coalesce((select sum(-x.stake) from bets x where x.player = a.id and x.at > a.at and x.at <= a.seen_at), 0)::float8 as placed,
        coalesce((select sum(coalesce(x.pay, 0)) from bets x where x.player = a.id and x.settled_at > a.at and x.settled_at <= a.seen_at and x.status in ('won', 'cashed', 'void')), 0)::float8 as paid,
        (select count(*)::int from bets x where x.player = a.id and x.status = 'open') as open,
        coalesce((select gain from profits where player = a.id and per = ${WEEK}), 0)::float8 as cw, coalesce((select gain from sprofits where player = a.id and per = ${WEEK}), 0)::float8 as sw,
        coalesce((select gain from profits where player = a.id and per = ${MONTH}), 0)::float8 as cm, coalesce((select gain from sprofits where player = a.id and per = ${MONTH}), 0)::float8 as sm
      from a order by a.id`);
    const out = rows.map((r) => {
      const expected = Math.round(r.base + r.led + r.placed + r.paid), gap = Math.round(r.bal - expected);
      // drapeau seulement quand le téléphone annonce PLUS que ce que le serveur peut expliquer (un retard de synchro donne un écart négatif)
      const flag = gap > Math.max(150, expected * 0.05) || r.cw - r.sw > 150 || r.cm - r.sm > 150;
      return { id: r.id, name: r.name, reported: Math.round(r.bal), expected, gap, open: r.open, week: { phone: Math.round(r.cw), server: Math.round(r.sw) }, month: { phone: Math.round(r.cm), server: Math.round(r.sm) }, flag };
    });
    return { players: out.length, flagged: out.filter((x) => x.flag), all: out };
  },
  async recovery_make(s, b) {
    const p = await me(s, b.token);
    const cur = (await s.query(`select recovery_hash from players where id = $1`, [p.id]))[0];
    const have = String(b.have || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (cur && cur.recovery_hash && !b.renew) return have && hashToken("rc:" + have) === cur.recovery_hash ? { ok: true } : { exists: true };
    if (b.renew && await overLimit("recov:" + p.id, 5, 86400)) throw fail(429, "slow_down");
    let code = "";
    for (let j = 0; j < 12; j++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    await s.query(`update players set recovery_hash = $2 where id = $1`, [p.id, hashToken("rc:" + code)]);
    return { code: code.slice(0, 4) + "-" + code.slice(4, 8) + "-" + code.slice(8) };
  },
  async backup(s, b) {
    const p = await me(s, b.token);
    const json = JSON.stringify(b.state && typeof b.state === "object" ? b.state : null);
    if (json.length > 400000) throw fail(400, "too_big");
    if (await overLimit("backup:" + p.id, 1, 240)) return { ok: true, later: true };
    await s.query(`update players set backup = $2::jsonb, backup_at = now() where id = $1`, [p.id, json]);
    return { ok: true };
  },

  async use_transfer(s, b, req) {
    if (await overLimit(ipKey(req) + ":transfer", 20, 3600)) throw fail(429, "slow_down");
    const code = String(b.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    // code de compte permanent : on se connecte et on récupère la dernière sauvegarde (le code reste valable)
    if (code.length === 12) {
      const r = (await s.query(`select id from players where recovery_hash = $1`, [hashToken("rc:" + code)]))[0];
      if (!r) throw fail(404, "unknown");
      const token = newToken();
      const p = (await s.query(`update players set token_hash = $2, seen_at = now() where id = $1 returning id, name, bal::float8 as bal, peak::float8 as peak, backup`, [r.id, hashToken(token)]))[0];
      return { token, id: p.id, name: p.name, bal: p.bal, peak: p.peak, state: p.backup || null, permanent: true };
    }
    const t = (await s.query(`select player, state from transfers where code = $1 and expires > now()`, [code]))[0];
    if (!t) throw fail(404, "unknown");
    const token = newToken();
    const p = (await s.query(`update players set token_hash = $2, seen_at = now() where id = $1 returning id, name, bal::float8 as bal, peak::float8 as peak`, [t.player, hashToken(token)]))[0];
    await s.query(`delete from transfers where code = $1`, [code]);
    return { token, id: p.id, name: p.name, bal: p.bal, peak: p.peak, state: t.state };
  },

  // ---- Administration (clé ADMIN_KEY dans les réglages Vercel ; désactivé sans elle) ----
  // paris d'un joueur (pour en annuler un à sa demande)
  async admin_bets(s, b) {
    admin(b);
    return { bets: await s.query(`select b.id, p.name, b.cid, b.stake, b.odds::float8 as odds, b.status, b.legs, b.at from bets b join players p on p.id = b.player
       where lower(p.name) = lower($1) order by b.id desc limit 30`, [String(b.name || "")]) };
  },
  // annuler un pari pas encore réglé : remboursé, et le téléphone du joueur l'apprend à la prochaine synchro
  async admin_void(s, b) {
    admin(b);
    const r = await s.query(`update bets set status = 'void', pay = stake, cancelled = true, settled_at = now() where id = $1 and status = 'open' returning id, cid, stake`, [String(int(b.id, 0, 1e15))]);
    return r[0] ? { ok: true, ...r[0] } : { error: "not_open" };
  },
  // paris encore ouverts sur les téléphones (copie envoyée à chaque synchro) : pour comprendre un pari bloqué
  async admin_open_client(s, b) {
    admin(b);
    const rows = await s.query(`select id, name, seen_at, bets from players where bets is not null`);
    const out = [];
    for (const r of rows) for (const x of (r.bets.list || [])) if (x.st === "open") out.push({ player: r.name, seen: r.seen_at, id: x.id, sid: x.sid || null, at: x.at, stake: x.stake, odds: x.odds,
      legs: (x.legs || []).map((L) => ({ l: L.l, ml: L.ml, mid: L.mid, sp: L.sp, t: L.t, r: L.r || null, path: L.snap && L.snap.path })) });
    return { open: out };
  },
  async admin_players(s, b) {
    admin(b);
    const rows = await s.query(
      `select p.id, p.name, p.bal::float8 as bal, p.won, p.lost, p.created_at, p.seen_at, p.social_ok,
         (select count(*)::int from league_members m where m.player = p.id) as leagues,
         (select count(*)::int from am_matches a where a.created_by = p.id) as matches
       from players p where lower(p.name) like lower($1) order by p.id`, ["%" + String(b.q || "") + "%"]);
    return { rows };
  },
  async admin_delete(s, b) {
    admin(b);
    const ids = (Array.isArray(b.ids) ? b.ids : []).map(Number).filter(Number.isInteger).slice(0, 200);
    if (!ids.length) return { deleted: 0 };
    const r = await s.query(`delete from players where id = any($1::bigint[]) returning id`, [ids]);
    await s.query(`delete from leagues l where not exists (select 1 from league_members m where m.code = l.code)`);
    return { deleted: r.length };
  },
  async admin_recovery(s, b) {
    admin(b);
    let code = "";
    for (let j = 0; j < 12; j++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    const r = await s.query(`update players set recovery_hash = $2 where id = $1 returning id`, [Number(b.id), hashToken("rc:" + code)]);
    if (!r[0]) throw fail(404, "unknown");
    return { code: code.slice(0, 4) + "-" + code.slice(4, 8) + "-" + code.slice(8) };
  },
  async admin_transfer(s, b) {
    admin(b);
    const id = Number(b.id);
    const p = (await s.query(`select id from players where id = $1`, [id]))[0];
    if (!p) throw fail(404, "unknown");
    await s.query(`delete from transfers where player = $1`, [id]);
    let code = "";
    for (let j = 0; j < 8; j++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    await s.query(`insert into transfers (code, player, state, expires) values ($1, $2, null, now() + interval '7 days')`, [code, id]);
    return { code: code.slice(0, 4) + "-" + code.slice(4) };
  },

  async create_league(s, b) {
    const p = await me(s, b.token);
    const name = cleanName(b.name, 24);
    if (!name) throw fail(400, "name");
    if (await badName(s, name)) throw fail(400, "name_bad");
    const n = (await s.query(`select count(*)::int as n from league_members where player = $1`, [p.id]))[0].n;
    if (n >= MAX_LEAGUES) throw fail(400, "too_many");
    for (let i = 0; i < 8; i++) {
      const code = newCode();
      const r = await s.query(`insert into leagues (code, name, owner, dark) values ($1, $2, $3, $4) on conflict do nothing returning code`, [code, name, p.id, !!b.dark]);
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
    const l = (await s.query(`select code, name, dark, (select count(*)::int from league_members m where m.code = leagues.code) as n from leagues where code = $1`, [code]))[0];
    if (!l || l.dark !== !!b.dark) throw fail(404, "unknown");
    const already = (await s.query(`select 1 from league_members where code = $1 and player = $2`, [code, p.id]))[0];
    if (!already) {
      if (l.n >= MAX_MEMBERS) throw fail(400, "full");
      const n = (await s.query(`select count(*)::int as n from league_members where player = $1`, [p.id]))[0].n;
      if (n >= MAX_LEAGUES) throw fail(400, "too_many");
      await s.query(`insert into league_members (code, player) values ($1, $2) on conflict do nothing`, [code, p.id]);
      await notify(s, await members(s, code), { title: l.name, body: `${p.name} a rejoint la guilde 👋`, url: go("rank", code), tag: "join-" + code }, p.id);
    }
    return { code, name: l.name, already: !!already };
  },

  async leave_league(s, b) {
    const p = await me(s, b.token);
    const code = cleanName(b.code, 8).toUpperCase();
    await s.query(`delete from league_members where code = $1 and player = $2`, [code, p.id]);
    await s.query(`update leagues l set owner = (select m.player from league_members m where m.code = l.code order by (m.role = 'officer') desc, m.joined_at limit 1)
       where l.code = $1 and l.owner = $2`, [code, p.id]);
    // guilde vide : on la supprime
    await s.query(`delete from leagues where code = $1 and not exists (select 1 from league_members where code = $1)`, [code]);
    return { ok: true };
  },

  // Mes guildes + le classement de celle demandée (ou le général si code = "")
  async boards(s, b) {
    const p = await me(s, b.token);
    const leagues = await myLeagues(s, p.id);
    const code = cleanName(b.code, 8).toUpperCase();
    let rows, total = null, rank = null;
    let trophies = {}, crowns = {}, last = null, lastSeason = null;
    if (code && leagues.some((l) => l.code === code)) {
      rows = await s.query(`select ${BOARD_COLS} from players p join league_members m on m.player = p.id where m.code = $1`, [code]);
      // gains par semaine des membres (y compris la semaine passée de ceux qui n'ont pas encore rouvert l'app)
      const wk = await s.query(`${periodGains("weekly", "week", WEEK, "week_bal")}
         select r.player, r.per as week, r.gain, pl.name from r join players pl on pl.id = r.player where r.rk = 1 and r.gain > 0 order by r.per desc`, [code]);
      for (const w of wk) trophies[w.player] = (trophies[w.player] || 0) + 1;
      const prev = (await s.query(`select ${PREV_WEEK} as w, ${PREV_MONTH} as m`))[0];
      const lw = wk.filter((w) => w.week === prev.w);
      if (lw.length) last = { week: prev.w, winners: lw.map((w) => ({ id: w.player, name: w.name, gain: Math.round(w.gain) })) };
      const ms = await s.query(`${periodGains("monthly", "month", MONTH, "month_bal")}
         select r.player, r.per as month, r.gain, pl.name from r join players pl on pl.id = r.player where r.rk = 1 and r.gain > 0 order by r.per desc`, [code]);
      for (const m of ms) crowns[m.player] = (crowns[m.player] || 0) + 1;
      const lm = ms.filter((m) => m.month === prev.m);
      if (lm.length) lastSeason = { month: prev.m, label: monthName(prev.m), winners: lm.map((m) => ({ id: m.player, name: m.name, gain: Math.round(m.gain) })) };
    } else {
      // général : les 100 meilleurs de la semaine et au total, plus ma place
      rows = await s.query(
        `(select ${BOARD_COLS} from players p where p.seen_at > now() - interval '60 days' order by p.bal desc limit 100)
         union
         (select ${BOARD_COLS} from players p where p.week = ${WEEK} order by week_gain desc limit 100)
         union
         (select ${BOARD_COLS} from players p where p.month = ${MONTH} order by month_gain desc limit 100)
         union
         (select ${BOARD_COLS} from players p where p.id = $1)`, [p.id]);
      total = (await s.query(`select count(*)::int as n from players where seen_at > now() - interval '60 days'`))[0].n;
      rank = (await s.query(
        `select count(*)::int + 1 as r from players where seen_at > now() - interval '60 days' and bal > (select bal from players where id = $1)`, [p.id]))[0].r;
    }
    const cur = (await s.query(`select ${MONTH} as m, ${WEEK} as w,
      extract(epoch from ((date_trunc('month', now() at time zone 'Europe/Paris') + interval '1 month') at time zone 'Europe/Paris')) * 1000 as mend`))[0];
    return {
      me: p.id, leagues, code: code && leagues.some((l) => l.code === code) ? code : "", total, rank, last, lastSeason,
      season: { month: cur.m, label: monthName(cur.m), end: Math.round(Number(cur.mend)) }, week: cur.w,
      rows: rows.map((r) => ({ id: r.id, name: r.name, bal: Math.round(r.bal), peak: Math.round(r.peak), won: r.won, lost: r.lost, week: Math.round(r.week_gain), season: Math.round(r.month_gain), tr: trophies[r.id] || 0, sc: crowns[r.id] || 0, av: r.avatar_v || 0, fav: r.fav ? { n: r.fav.name, l: r.fav.logo } : null, nb: Array.isArray(r.badges) ? r.badges.length : 0, xp: r.xp || 0, cos: r.cos || null })),
    };
  },

  // ---- Photo de profil ----
  async recap(s, b) {
    const p = await me(s, b.token);
    const code = cleanName(b.code, 8).toUpperCase();
    if (!(await isMember(s, code, p.id))) throw fail(403, "not_member");
    return { me: p.id, name: await lname(s, code), ...(await recapFor(s, code)) };
  },

  async set_avatar(s, b) {
    const p = await me(s, b.token);
    if (b.img == null) {
      await s.query(`update players set avatar = null, avatar_v = 0 where id = $1`, [p.id]);
      return { v: 0 };
    }
    const img = String(b.img);
    if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(img) || img.length > 160000) throw fail(400, "image");
    const r = await s.query(`update players set avatar = $2, avatar_v = avatar_v + 1 where id = $1 returning avatar_v`, [p.id, img]);
    return { v: r[0].avatar_v };
  },

  // ---- Fiche d'un joueur (visible si on partage une guilde avec lui) ----
  async profile(s, b) {
    const p = await me(s, b.token);
    const id = String(int(b.id, 0, 1e15));
    if (id !== String(p.id)) {
      const ok = (await s.query(
        `select 1 from league_members a join league_members c on c.code = a.code where a.player = $1 and c.player = $2 limit 1`, [p.id, id]))[0];
      if (!ok) throw fail(403, "not_friend");
    }
    const r = (await s.query(
      `select id, name, cos, bal::float8 as bal, peak::float8 as peak, won, lost, avatar_v, bets, fav, badges, extract(epoch from created_at) * 1000 as since,
         coalesce((select x.xp from pxp x where x.player = players.id), 0) as xp,
         (select count(*)::int from weekly w where w.player = players.id) as weeks
       from players where id = $1`, [id]))[0];
    if (!r) throw fail(404, "unknown");
    return { id: r.id, name: r.name, bal: Math.round(r.bal), peak: Math.round(r.peak), won: r.won, lost: r.lost, av: r.avatar_v || 0, xp: r.xp || 0, cos: r.cos || null,
      bets: (r.bets && r.bets.list) || [], best: (r.bets && r.bets.best) || null, since: Math.round(Number(r.since)),
      fav: r.fav || null, badges: Array.isArray(r.badges) ? r.badges : [],
      pal: (await s.query(`select
          (select count(*)::int from month_prizes where player = $1 and rank = 1) as months,
          (select count(*)::int from month_prizes where player = $1 and rank <= 3) as podiums,
          (select count(*)::int from battle_rewards where player = $1 and result = 'w') as battles,
          (select count(*)::int from bets where player = $1 and status in ('won', 'lost', 'cashed')) as settled,
          (select max(odds)::float8 from bets where player = $1 and status = 'won') as best_odds,
          (select max(pay - stake)::float8 from bets where player = $1 and status in ('won', 'cashed')) as big_win`, [id]))[0],
      hist: (await s.query(`select day, bal::float8 as bal from bal_hist where player = $1 and day >= to_char((now() at time zone 'Europe/Paris') - interval '30 days', 'YYYYMMDD') order by day`, [id])).map((x) => [x.day, Math.round(x.bal)]) };
  },

  // ---- Côté dark : paris inventés par les membres (anonymes, pari mutuel), seulement dans les guildes secrètes ----
  // (une guilde secrète n'apparaît pas dans les guildes normales et se rejoint seulement par son code, depuis l'entrée cachée)
  async dark_leagues(s, b) {
    const p = await me(s, b.token);
    const leagues = await s.query(`select l.code, l.name, l.owner = $1 as mine, (select count(*)::int from league_members m2 where m2.code = l.code) as n
       from leagues l join league_members m on m.code = l.code where m.player = $1 and l.dark order by m.joined_at`, [p.id]);
    return { leagues };
  },
  // Règles : le créateur ne peut pas parier sur son pari ; il donne le résultat après la fin ;
  // 12 h pour contester (2 contestations = annulé, tout le monde remboursé) ; 2 signalements = pari masqué.
  // Les jetons restent gérés par chaque téléphone (comme les duels).
  async dark_create(s, b) {
    const p = await me(s, b.token);
    const code = cleanName(b.code, 8).toUpperCase();
    if (!(await isDarkMember(s, code, p.id))) throw fail(403, "not_member");
    const q = cleanName(b.question, 140);
    if (q.length < 6) throw fail(400, "question");
    const kind = b.kind === "num" ? "num" : "choice";
    const opts = kind === "num" ? [] : (Array.isArray(b.options) ? b.options : []).map((o) => cleanName(o, 40)).filter(Boolean).slice(0, 4);
    if (kind === "choice" && (opts.length < 2 || new Set(opts.map((o) => o.toLowerCase())).size !== opts.length)) throw fail(400, "options");
    const closes = Number(b.closes);
    if (!Number.isFinite(closes) || closes < Date.now() + 5 * 60e3 || closes > Date.now() + 30 * 86400e3) throw fail(400, "closes");
    const n = (await s.query(`select count(*)::int as n from dark_bets where creator = $1 and created_at > now() - interval '1 day'`, [p.id]))[0].n;
    if (n >= 15) throw fail(429, "slow_down");
    const r = await s.query(
      `insert into dark_bets (code, creator, question, options, closes, kind, unit) values ($1, $2, $3, $4::jsonb, to_timestamp($5::float8 / 1000), $6, $7) returning id`,
      [code, p.id, q, JSON.stringify(opts), closes, kind, cleanName(b.unit, 12) || null]);
    await s.query(`insert into activity (player, kind, data) values ($1, 'darknew', $2::jsonb)`, [p.id, JSON.stringify({ code, q, id: r[0].id })]);
    await notify(s, await members(s, code), { title: "😈 " + (await lname(s, code)), body: "Nouveau pari secret : « " + q + " »", url: go("dark", code), tag: "dark-" + r[0].id }, p.id);
    return { id: r[0].id };
  },

  async dark_list(s, b) {
    const p = await me(s, b.token);
    const code = cleanName(b.code, 8).toUpperCase();
    if (!(await isDarkMember(s, code, p.id))) throw fail(403, "not_member");
    const rows = await s.query(
      `select d.id, d.question, d.options, d.kind, d.unit, d.result_num::float8 as result_num, extract(epoch from d.closes) * 1000 as closes, d.result,
         coalesce((select jsonb_agg(jsonb_build_object('g', g, 'a', a) order by g) from (select guess::float8 as g, sum(amount)::int as a from dark_stakes x where x.bet = d.id and x.guess is not null group by guess) gg), '[]') as guesses,
         extract(epoch from d.resolved_at) * 1000 as resolved, d.creator = $2 as mine,
         coalesce((select jsonb_object_agg(opt, tot) from (select opt, sum(amount)::int as tot from dark_stakes x where x.bet = d.id group by opt) z), '{}') as pools,
         (select count(*)::int from dark_stakes x where x.bet = d.id) as players,
         (select jsonb_build_object('opt', opt, 'amount', amount, 'guess', guess::float8) from dark_stakes x where x.bet = d.id and x.player = $2) as my,
         (select count(*)::int from dark_flags f where f.bet = d.id and f.kind = 'contest') as contests,
         (select count(*)::int from dark_flags f where f.bet = d.id and f.kind = 'report') as reports,
         exists (select 1 from dark_flags f where f.bet = d.id and f.player = $2 and f.kind = 'contest') as my_contest,
         exists (select 1 from dark_flags f where f.bet = d.id and f.player = $2 and f.kind = 'report') as my_report
       from dark_bets d where d.code = $1 and d.created_at > now() - interval '30 days'
       order by (d.result is null) desc, d.closes asc limit 80`, [code, p.id]);
    const now = Date.now();
    const out = {
      bets: rows.filter((r) => r.reports < 2).map((r) => {
        const resolved = r.resolved != null ? Math.round(Number(r.resolved)) : null;
        let state = "open";
        if (Number(r.closes) <= now) state = "closed";
        if (r.result != null) state = r.contests >= 2 ? "void" : now - resolved > 12 * 3600e3 ? "final" : "contest";
        if (r.result == null && now - Number(r.closes) > 7 * 86400e3) state = "void";   // jamais tranché en 7 jours
        return { id: r.id, question: r.question, options: r.options, kind: r.kind, unit: r.unit, resultNum: r.result_num, guesses: r.guesses, closes: Math.round(Number(r.closes)), result: r.result, resolved,
          mine: r.mine, pools: r.pools, players: r.players, my: r.my, contests: r.contests, myContest: r.my_contest, myReport: r.my_report, state };
      }),
    };
    for (const x of out.bets) if (x.state === "final" || x.state === "void") await darkPay(s, x);
    // pari masqué (2 signalements) : tout le monde est remboursé
    for (const r of rows) if (r.reports >= 2) await darkPay(s, { id: r.id, state: "void" });
    return out;
  },

  async dark_stake(s, b) {
    const p = await me(s, b.token);
    const id = int(b.id, 0, 1e15), opt = int(b.opt, 0, 3), amount = int(b.amount, 1, 1e6);
    const d = (await s.query(`select d.* from dark_bets d where d.id = $1`, [id]))[0];
    if (!d || !(await isDarkMember(s, d.code, p.id))) throw fail(404, "unknown");
    if (String(d.creator) === String(p.id)) throw fail(400, "own_bet");
    if (new Date(d.closes).getTime() <= Date.now()) throw fail(400, "closed");
    let guess = null;
    if (d.kind === "num") {
      guess = Number(b.guess);
      if (!Number.isFinite(guess) || Math.abs(guess) > 1e6) throw fail(400, "guess");
      guess = Math.round(guess * 100) / 100;
    } else if (opt >= d.options.length) throw fail(400, "option");
    const o = d.kind === "num" ? 0 : opt;
    const cur = (await s.query(`select opt, guess::float8 as guess from dark_stakes where bet = $1 and player = $2`, [id, p.id]))[0];
    if (cur && (cur.opt !== o || (d.kind === "num" && Number(cur.guess) !== guess))) throw fail(400, "other_option");
    await s.query(
      `insert into dark_stakes (bet, player, opt, amount, guess) values ($1, $2, $3, $4, $5)
       on conflict (bet, player) do update set amount = dark_stakes.amount + excluded.amount`, [id, p.id, o, amount, guess]);
    await credit(s, p.id, -amount, "dark", id + ":" + Date.now());
    return { ok: true };
  },

  async dark_resolve(s, b) {
    const p = await me(s, b.token);
    const id = int(b.id, 0, 1e15), result = int(b.result, 0, 3);
    const val = Number(b.value);
    const r = await s.query(
      `update dark_bets set result = $3, result_num = case when kind = 'num' then $4::numeric else null end, resolved_at = now()
       where id = $1 and creator = $2 and result is null and closes <= now()
         and ((kind = 'choice' and jsonb_array_length(options) > $3) or (kind = 'num' and $4::numeric is not null))
       returning id, code, question, kind, options, unit`, [id, p.id, result, Number.isFinite(val) && Math.abs(val) <= 1e6 ? val : null]);
    if (!r[0]) throw fail(400, "unavailable");
    const d = r[0], txt = d.kind === "num" ? String(val) + (d.unit ? " " + d.unit : "") : d.options[result];
    await s.query(`insert into activity (player, kind, data) values ($1, 'darkres', $2::jsonb)`, [p.id, JSON.stringify({ code: d.code, q: d.question, r: txt, id: d.id })]);
    const stakers = (await s.query(`select player from dark_stakes where bet = $1`, [d.id])).map((x) => x.player);
    await notify(s, stakers, { title: "😈 Résultat du pari dark", body: `« ${d.question} » : ${txt}. Tu as 12 h pour contester.`, url: go("dark", d.code), tag: "darkres-" + d.id }, p.id);
    return { ok: true };
  },

  // contester un résultat (12 h après) ou signaler un pari déplacé
  async dark_flag(s, b) {
    const p = await me(s, b.token);
    const id = int(b.id, 0, 1e15), kind = b.kind === "report" ? "report" : "contest";
    const d = (await s.query(`select code, creator from dark_bets where id = $1`, [id]))[0];
    if (!d || !(await isDarkMember(s, d.code, p.id))) throw fail(404, "unknown");
    if (String(d.creator) === String(p.id)) throw fail(400, "own_bet");
    await s.query(`insert into dark_flags (bet, player, kind) values ($1, $2, $3) on conflict do nothing`, [id, p.id, kind]);
    return { ok: true };
  },

  async dark_delete(s, b) {
    const p = await me(s, b.token);
    const r = await s.query(
      `delete from dark_bets d where d.id = $1 and d.creator = $2 and not exists (select 1 from dark_stakes x where x.bet = d.id) returning id`,
      [int(b.id, 0, 1e15), p.id]);
    if (!r[0]) throw fail(400, "locked");
    return { ok: true };
  },

  // ---- Prono du week-end ----

  async prono_get(s, b) {
    const p = await me(s, b.token);
    const wk = await pronoWeek(s);
    await pronoCredit(s, p.id, wk.week);
    await pronoCredit(s, p.id, (await s.query(`select ${PREV_WEEK} as w`))[0].w);
    const mine = await s.query(`select mid, sh, sa, joker from prono_picks where week = $1 and player = $2`, [wk.week, p.id]);
    const now = Date.now();
    const code = cleanName(b.code, 8).toUpperCase();
    let board = null;
    if (await isMember(s, code, p.id)) {
      const mem = await s.query(`select pl.id, pl.name, pl.avatar_v from league_members m join players pl on pl.id = m.player where m.code = $1`, [code]);
      const ids = mem.map((x) => x.id);
      const picks = await s.query(`select week, player, mid, sh, sa, joker from prono_picks where player = any($1::bigint[])`, [ids]);
      const weeks = await s.query(`select week, matches from prono_weeks where week in (select distinct week from prono_picks where player = any($1::bigint[]))`, [ids]);
      const W = Object.fromEntries(weeks.map((w) => [w.week, w.matches]));
      W[wk.week] = wk.matches;
      const tot = {};
      for (const m of mem) tot[m.id] = { id: m.id, name: m.name, av: m.avatar_v || 0, week: 0, season: 0, exact: 0, n: 0, weeks: {} };
      for (const x of picks) {
        const M = (W[x.week] || []).find((m) => m.mid === x.mid);
        const pt = M ? points(M, x) : null;
        const T = tot[x.player];
        if (!T) continue;
        if (x.week === wk.week) T.n++;
        if (pt == null) continue;
        T.season += pt; T.weeks[x.week] = (T.weeks[x.week] || 0) + pt;
        if (x.week === wk.week) { T.week += pt; if (pt >= 5 && x.sh === M.sh && x.sa === M.sa) T.exact++; }
      }
      // gagnant de la semaine précédente (et nombre de « pronos d'or » de chacun)
      const allWeeks = Object.keys(W).filter((w) => w !== wk.week && (W[w] || []).every((m) => m.done || m.cancel)).sort();
      for (const w of allWeeks) {
        const best = Math.max(0, ...Object.values(tot).map((t) => t.weeks[w] || 0));
        if (best > 0) for (const t of Object.values(tot)) if ((t.weeks[w] || 0) === best) t.gold = (t.gold || 0) + 1;
      }
      const last = allWeeks[allWeeks.length - 1];
      let lastWin = null;
      if (last) { const best = Math.max(0, ...Object.values(tot).map((t) => t.weeks[last] || 0)); if (best > 0) lastWin = { week: last, pts: best, names: Object.values(tot).filter((t) => (t.weeks[last] || 0) === best).map((t) => t.name) }; }
      // pronos des potes, visibles seulement après le coup d'envoi
      const others = {};
      for (const x of picks) {
        if (x.week !== wk.week) continue;
        const M = wk.matches.find((m) => m.mid === x.mid);
        if (!M || M.t > now) continue;
        (others[x.mid] ??= []).push({ name: tot[x.player] ? tot[x.player].name : "?", sh: x.sh, sa: x.sa, joker: x.joker, pts: points(M, x) });
      }
      board = { rows: Object.values(tot).map(({ weeks, ...t }) => t), lastWin, others };
    }
    return {
      week: wk.week, from: wk.from, to: wk.to, me: p.id, board,
      matches: wk.matches.map((m) => { const my = mine.find((x) => x.mid === m.mid); return { ...m, my: my || null, pts: my ? points(m, my) : null }; }),
    };
  },

  async prono_pick(s, b) {
    const p = await me(s, b.token);
    const wk = await pronoWeek(s, true);
    const M = wk.matches.find((m) => m.mid === String(b.mid || ""));
    if (!M) throw fail(404, "unknown");
    if (M.t <= Date.now()) throw fail(400, "started");
    const sh = int(b.sh, 0, 20), sa = int(b.sa, 0, 20);
    await s.query(
      `insert into prono_picks (week, player, mid, sh, sa) values ($1, $2, $3, $4, $5)
       on conflict (week, player, mid) do update set sh = excluded.sh, sa = excluded.sa, at = now()`, [wk.week, p.id, M.mid, sh, sa]);
    return { ok: true };
  },

  // Un joker (points ×2) par week-end ; déplaçable tant que son match n'a pas commencé
  async prono_joker(s, b) {
    const p = await me(s, b.token);
    const wk = await pronoWeek(s, true);
    const now = Date.now(), M = wk.matches.find((m) => m.mid === String(b.mid || ""));
    if (!M || M.t <= now) throw fail(400, "started");
    const cur = (await s.query(`select mid from prono_picks where week = $1 and player = $2 and joker`, [wk.week, p.id]))[0];
    if (cur) { const C = wk.matches.find((m) => m.mid === cur.mid); if (C && C.t <= now) throw fail(400, "joker_locked"); }
    const has = (await s.query(`select 1 from prono_picks where week = $1 and player = $2 and mid = $3`, [wk.week, p.id, M.mid]))[0];
    if (!has) throw fail(400, "no_pick");
    await s.query(`update prono_picks set joker = (mid = $3) where week = $1 and player = $2`, [wk.week, p.id, M.mid]);
    return { ok: true };
  },

  // ---- Notifications ----
  async push_sub(s, b) {
    const p = await me(s, b.token);
    const sub = b.sub || {};
    const ep = String(sub.endpoint || "");
    if (!/^https:\/\/[^\s]{10,600}$/.test(ep) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) throw fail(400, "sub");
    const keys = { p256dh: String(sub.keys.p256dh).slice(0, 200), auth: String(sub.keys.auth).slice(0, 100) };
    await s.query(`insert into push_subs (endpoint, player, keys) values ($1, $2, $3::jsonb) on conflict (endpoint) do update set player = excluded.player, keys = excluded.keys`,
      [ep, p.id, JSON.stringify(keys)]);
    return { ok: true };
  },
  async push_unsub(s, b) {
    const p = await me(s, b.token);
    await s.query(`delete from push_subs where endpoint = $1 and player = $2`, [String(b.endpoint || ""), p.id]);
    return { ok: true };
  },
  async set_remind(s, b) {
    const p = await me(s, b.token);
    await s.query(`update players set remind = $2 where id = $1`, [p.id, int(b.v, 0, 2)]);
    return { ok: true };
  },
  async set_fav(s, b) {
    const p = await me(s, b.token);
    const f = b.fav;
    if (f == null) { await s.query(`update players set fav = null where id = $1`, [p.id]); return { ok: true }; }
    const sp = ["rugby", "basket"].includes(f.sp) ? f.sp : "foot", id = String(f.id || "");
    const path = String(f.path || ""), logo0 = String(f.logo || "");
    if (!/^\d{1,9}$/.test(id) || !FAV_PATHS.includes(path)) throw fail(400, "fav");
    // logo : ESPN ou un des nôtres ; sinon on s'en passe (l'écusson est dessiné)
    const logo = /^https:\/\/a\.espncdn\.com\/[\w\/.\-]+$/.test(logo0) || /^logos\/[\w\-]+\.png$/.test(logo0) ? logo0 : "";
    const fav = { sp, id, path, name: cleanName(f.name, 40) || "?", logo: logo || null };
    await s.query(`update players set fav = $2::jsonb where id = $1`, [p.id, JSON.stringify(fav)]);
    return { ok: true, fav };
  },
  // récompenses du mois pas encore reçues : marquées « reçues » ici, le téléphone ajoute les jetons
  async prizes_claim(s, b) {
    const p = await me(s, b.token);
    const prev = (await s.query(`select ${PREV_MONTH} as m`))[0].m;
    if (prev >= CUT.month) await ensurePrizes(s, prev);
    const r = await s.query(`update month_prizes mp set claimed = true from leagues l where l.code = mp.code and mp.player = $1 and not mp.claimed
       returning mp.month, mp.rank, mp.amount, l.name`, [p.id]);
    for (const x of r) await credit(s, p.id, x.amount, "prize", x.month + ":" + x.name);
    return { prizes: r.map((x) => ({ month: x.month, label: monthName(x.month), rank: x.rank, amount: x.amount, league: x.name })) };
  },
  async lm_get(s, b) {
    const p = await me(s, b.token);
    const code = cleanName(b.code, 8).toUpperCase();
    if (!(await isMember(s, code, p.id))) throw fail(403, "not_member");
    const { today, cur } = await dayMatch(s);
    const mem = await s.query(`select pl.id, pl.name, pl.avatar_v from league_members m join players pl on pl.id = m.player where m.code = $1`, [code]);
    const ids = mem.map((x) => x.id), who = Object.fromEntries(mem.map((x) => [String(x.id), x]));
    const days = await s.query(`select day, match from day_match where match is not null and day >= to_char((now() at time zone 'Europe/Paris') - interval '40 days', 'YYYYMMDD') order by day desc`);
    const picks = await s.query(`select day, player, pick from lm_picks where player = any($1::bigint[]) and day = any($2::text[])`, [ids, days.map((d) => d.day)]);
    const byDay = {};
    for (const x of picks) (byDay[x.day] ??= []).push(x);
    const pub = (m) => m && ({ mid: m.mid, h: m.h, a: m.a, hl: m.hl, al: m.al, t: m.t, sh: m.sh, sa: m.sa, done: !!m.done, live: m.t < Date.now() && !m.done });
    const month = today.slice(0, 6), tally = {};
    const hist = [];
    for (const d of days) {
      const res = outcome(d.match), P = byDay[d.day] || [];
      if (d.day.startsWith(month) && res != null) for (const x of P) { const T = (tally[x.player] ??= { ok: 0, n: 0 }); T.n++; if (x.pick === res) T.ok++; }
      if (cur && d.day === cur.day) continue;
      if (hist.length < 7 && d.day < today) {
        const my = P.find((x) => String(x.player) === String(p.id));
        hist.push({ day: d.day, match: pub(d.match), res, my: my ? my.pick : null, n: P.length, ok: res == null ? 0 : P.filter((x) => x.pick === res).length });
      }
    }
    for (const d of days) { const res = outcome(d.match), mine = (byDay[d.day] || []).find((x) => String(x.player) === String(p.id)); if (res != null && mine && mine.pick === res) await credit(s, p.id, LM_PRIZE, "lm", d.day); }
    const curPicks = cur ? (byDay[cur.day] || []).map((x) => ({ id: x.player, name: (who[String(x.player)] || {}).name, av: (who[String(x.player)] || {}).avatar_v || 0, pick: x.pick })) : [];
    const myCur = curPicks.find((x) => String(x.id) === String(p.id));
    return { me: p.id, today, prize: LM_PRIZE,
      cur: cur ? { day: cur.day, match: pub(cur.match), res: outcome(cur.match), picks: curPicks, my: myCur ? myCur.pick : null } : null,
      hist, month: Object.entries(tally).map(([id, t]) => ({ id, name: (who[id] || {}).name, av: (who[id] || {}).avatar_v || 0, ...t })).filter((x) => x.name).sort((a, b) => b.ok - a.ok || a.n - b.n) };
  },
  async lm_pick(s, b) {
    const p = await me(s, b.token);
    const day = String(b.day || ""), pick = int(b.pick, 0, 2);
    const r = (await s.query(`select match from day_match where day = $1 and match is not null`, [day]))[0];
    if (!r) throw fail(404, "unknown");
    if (r.match.t <= Date.now()) throw fail(409, "started");
    await s.query(`insert into lm_picks (day, player, pick) values ($1, $2, $3) on conflict (day, player) do update set pick = excluded.pick, at = now()`, [day, p.id, pick]);
    return { ok: true };
  },

  async push_test(s, b) {
    const p = await me(s, b.token);
    if (await overLimit("pushtest:" + p.id, 5, 3600)) throw fail(429, "slow_down");
    await notify(s, [p.id], { title: "Tribune", body: "Les notifications marchent 🎉", url: "./", tag: "test" });
    return { ok: true };
  },

  // ---- Chat de la guilde ----
  async chat_send(s, b, req) {
    const p = await me(s, b.token);
    const code = cleanName(b.code, 8).toUpperCase();
    if (!(await isMember(s, code, p.id))) throw fail(403, "not_member");
    let text = String(b.text ?? "").replace(/[\u0000-\u0008\u000b-\u001f]/g, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 400);
    if (!text) throw fail(400, "empty");
    if (await overLimit("chat:" + p.id, 30, 60)) throw fail(429, "slow_down");
    text = maskBad(text);
    const r = await s.query(`insert into chat (code, player, text) values ($1, $2, $3) returning id, extract(epoch from at) * 1000 as ms`, [code, p.id, text]);
    // une notification de chat au plus toutes les 10 min par membre et par guilde
    const mem = (await members(s, code)).filter((x) => String(x) !== String(p.id));
    const to = [];
    for (const m of mem) if (!(await overLimit(`pushchat:${m}:${code}`, 1, 600))) to.push(m);
    if (to.length) await notify(s, to, { title: `💬 ${p.name} · ${await lname(s, code)}`, body: text.slice(0, 140), url: go("chat", code), tag: "chat-" + code });
    return { id: r[0].id, at: Math.round(Number(r[0].ms)) };
  },
  async chat_list(s, b) {
    const p = await me(s, b.token);
    const code = cleanName(b.code, 8).toUpperCase();
    if (!(await isMember(s, code, p.id))) throw fail(403, "not_member");
    const after = int(b.after, 0, 1e15);
    const rows = await s.query(
      `select c.id, c.player, pl.name, pl.avatar_v, pl.cos, c.text, extract(epoch from c.at) * 1000 as ms from chat c join players pl on pl.id = c.player
       where c.code = $1 and c.id > $2 and not c.hidden order by c.id desc limit 120`, [code, after]);
    return { me: p.id, msgs: rows.reverse().map((r) => ({ id: r.id, who: r.player, name: r.name, av: r.avatar_v || 0, cos: r.cos || null, text: r.text, at: Math.round(Number(r.ms)) })) };
  },
  async chat_delete(s, b) {
    const p = await me(s, b.token);
    const m = (await s.query(`select code, player from chat where id = $1`, [String(int(b.id, 0, 1e15))]))[0];
    if (!m) return { ok: true };
    const role = String(m.player) === String(p.id) ? "moi" : await guildRole(s, m.code, p.id);
    if (role !== "moi" && role !== "chef" && role !== "adjoint") throw fail(403, "not_allowed");
    await s.query(`delete from chat where id = $1`, [String(int(b.id, 0, 1e15))]);
    return { ok: true };
  },

  // ---- Fil d'activité ----
  async act(s, b) {
    const p = await me(s, b.token);
    const kind = String(b.kind || "");
    if (!ACT_KINDS.includes(kind)) throw fail(400, "kind");
    const json = JSON.stringify(b.data && typeof b.data === "object" ? b.data : {});
    if (json.length > 2000) throw fail(400, "too_big");
    const n = (await s.query(`select count(*)::int as n from activity where player = $1 and at > now() - interval '1 hour'`, [p.id]))[0].n;
    if (n >= 120) return { ok: true };
    await s.query(`insert into activity (player, kind, data) values ($1, $2, $3::jsonb)`, [p.id, kind, json]);
    return { ok: true };
  },

  async feed(s, b) {
    const p = await me(s, b.token);
    const code = cleanName(b.code, 8).toUpperCase();
    const inL = code && (await s.query(`select 1 from league_members where code = $1 and player = $2`, [code, p.id]))[0];
    if (!inL) throw fail(403, "not_member");
    const rows = await s.query(
      `select a.id, a.player, pl.name, pl.avatar_v, a.kind, a.data, extract(epoch from a.at) * 1000 as ms,
         coalesce((select jsonb_object_agg(emo, n) from (select emo, count(*)::int as n from reactions r where r.act = a.id group by emo) x), '{}') as reacts,
         (select emo from reactions r where r.act = a.id and r.player = $2) as mine
       from activity a join league_members m on m.player = a.player and m.code = $1 join players pl on pl.id = a.player
       where a.at > now() - interval '7 days' and a.kind not like 'dark%' order by a.at desc limit 60`, [code, p.id]);
    return { me: p.id, items: rows.map((r) => ({ id: r.id, who: r.player, name: r.name, av: r.avatar_v || 0, kind: r.kind, data: r.data, at: Math.round(Number(r.ms)), reacts: r.reacts, mine: r.mine })) };
  },

  async react(s, b) {
    const p = await me(s, b.token);
    const emo = String(b.emo || "");
    if (!EMOS.includes(emo)) throw fail(400, "emo");
    const id = int(b.act, 0, 1e15);
    const cur = (await s.query(`select emo from reactions where act = $1 and player = $2`, [id, p.id]))[0];
    if (cur && cur.emo === emo) await s.query(`delete from reactions where act = $1 and player = $2`, [id, p.id]);
    else {
      await s.query(`insert into reactions (act, player, emo) values ($1, $2, $3) on conflict (act, player) do update set emo = excluded.emo`, [id, p.id, emo]);
      const a = (await s.query(`select a.player, a.kind, a.data from activity a where a.id = $1`, [id]))[0];
      if (a && !a.kind.startsWith("dark") && !(await overLimit(`pushreact:${a.player}:${p.id}`, 1, 600))) {
        const what = { bet: "ton pari", won: "ton gain", cash: "ton encaissement", wheel: "ta roue", defis: "tes défis", duel: "ton duel", duelwin: "ta victoire en duel", join: "ton arrivée" }[a.kind] || "ton activité";
        const code = (await s.query(`select code from league_members where player = $1 and code not in (select code from leagues where dark) intersect select code from league_members where player = $2 limit 1`, [a.player, p.id]))[0];
        await notify(s, [a.player], { title: `${p.name} a réagi ${emo}`, body: `à ${what}`, url: code ? go("feed", code.code) : "./", tag: "react-" + id });
      }
    }
    return { ok: true };
  },

  // ---- Duels entre membres d'une guilde (sur le résultat d'un vrai match) ----
  // Les jetons restent gérés par chaque téléphone : le serveur garde l'état du duel et son vainqueur.
  async duel_create(s, b) {
    const p = await me(s, b.token);
    const code = cleanName(b.code, 8).toUpperCase();
    if (!(await s.query(`select 1 from league_members where code = $1 and player = $2`, [code, p.id]))[0]) throw fail(403, "not_member");
    const t = Number(b.t), stake = int(b.stake, 1, 1e6), ka = int(b.ka, 0, 2);
    if (!Number.isFinite(t) || t < Date.now() + 60e3) throw fail(400, "started");
    const opts = (Array.isArray(b.opts) ? b.opts : []).slice(0, 3).map((x) => cleanName(x, 32));
    const n = (await s.query(`select count(*)::int as n from duels where a = $1 and created_at > now() - interval '1 day'`, [p.id]))[0].n;
    if (n >= 20) throw fail(429, "slow_down");
    const r = await s.query(
      `insert into duels (code, a, mid, mlabel, opts, t, ka, stake, path) values ($1, $2, $3, $4, $5::jsonb, to_timestamp($6::float8 / 1000), $7, $8, $9) returning id`,
      [code, p.id, cleanName(b.mid, 80), cleanName(b.mlabel, 80), JSON.stringify(opts), t, ka, stake, /^[a-z]+\/[\w.]+$/.test(String(b.path || "")) ? String(b.path) : null]);
    await credit(s, p.id, -stake, "duel", r[0].id + ":a");
    await notify(s, await members(s, code), { title: `⚔️ ${p.name} lance un duel`, body: `${opts[ka] || ""} sur ${cleanName(b.mlabel, 80)} · ${stake} jetons. Qui relève ?`, url: go("duels", code), tag: "duel-" + r[0].id }, p.id);
    return { id: r[0].id };
  },

  async duel_accept(s, b) {
    const p = await me(s, b.token);
    const kb = int(b.kb, 0, 2);
    const r = await s.query(
      `update duels d set b = $2, kb = $3, status = 'live'
       where d.id = $1 and d.status = 'open' and d.a <> $2 and d.ka <> $3 and d.t > now()
         and exists (select 1 from league_members m where m.code = d.code and m.player = $2)
       returning id, stake, a, code, mlabel, opts`, [int(b.id, 0, 1e15), p.id, kb]);
    if (!r[0]) throw fail(400, "unavailable");
    const d = r[0];
    await credit(s, p.id, -d.stake, "duel", d.id + ":b");
    await notify(s, [d.a], { title: `⚔️ ${p.name} a relevé ton duel !`, body: `${d.mlabel} : il mise ${d.stake} jetons sur « ${(d.opts || [])[kb] || ""} ».`, url: go("duels", d.code), tag: "duel-" + d.id });
    return { ok: true, stake: d.stake };
  },

  // Le premier téléphone qui voit le match terminé donne le résultat (0, 1 ou 2) ; un duel jamais relevé expire.
  async duel_result(s, b) {
    const p = await me(s, b.token);
    const id = int(b.id, 0, 1e15), res = int(b.res, 0, 2);
    const d = (await s.query(`select d.* from duels d join league_members m on m.code = d.code and m.player = $2 where d.id = $1`, [id, p.id]))[0];
    if (!d) throw fail(404, "unknown");
    if (d.status === "live" && new Date(d.t).getTime() < Date.now()) {
      let rr = res;
      if (d.path) {   // le serveur lit lui-même le score final (le téléphone ne décide plus)
        const m = await loadMatch({ mid: d.mid, path: d.path, t: new Date(d.t).getTime() });
        const sc = m && EG.status(m) === "post" ? EG.realStats(m) : null, v = sc && (sc.g || sc.pts || sc.sets);
        if (!v) return { ok: true, pending: true };
        rr = m.sp === "tennis" || m.sp === "basket" ? (v[0] > v[1] ? 0 : 1) : EG.cmp3(v);
      }
      const winner = d.ka === rr ? d.a : d.kb === rr ? d.b : null;
      const u = await s.query(`update duels set status = 'done', res = $2, winner = $3 where id = $1 and status = 'live' returning id`, [id, rr, winner]);
      if (u[0]) {
        if (winner) await credit(s, winner, 2 * d.stake, "duel_win", id);
        else for (const x of [[d.a, "a"], [d.b, "b"]]) if (x[0]) await credit(s, x[0], d.stake, "duel_ref", id + ":" + x[1]);
        const names = Object.fromEntries((await s.query(`select id, name from players where id = any($1::bigint[])`, [[d.a, d.b].filter(Boolean)])).map((x) => [String(x.id), x.name]));
        await notify(s, [d.a, d.b].filter(Boolean), { title: "⚔️ Duel terminé · " + d.mlabel,
          body: winner ? `${names[String(winner)] || "?"} remporte ${2 * d.stake} jetons !` : "Personne n'a vu juste : mises remboursées.", url: go("duels", d.code), tag: "duel-" + id });
      }
    }
    const f = (await s.query(`select status, res, winner from duels where id = $1`, [id]))[0];
    return { ok: true, status: f.status, res: f.res, winner: f.winner };
  },

  async duels(s, b) {
    const p = await me(s, b.token);
    const code = cleanName(b.code, 8).toUpperCase();
    // les duels jamais relevés avant le coup d'envoi expirent
    const exp = await s.query(`update duels set status = 'expired' where status = 'open' and t < now() returning id, a, stake`);
    for (const x of exp) await credit(s, x.a, x.stake, "duel_ref", x.id + ":a");   // duel jamais relevé : mise rendue
    const rows = await s.query(
      `select d.id, d.code, d.a, pa.name as aname, pa.avatar_v as aav, d.b, pb.name as bname, pb.avatar_v as bav, d.mid, d.mlabel, d.opts, extract(epoch from d.t) * 1000 as tms,
         d.ka, d.kb, d.stake, d.status, d.res, d.winner
       from duels d join players pa on pa.id = d.a left join players pb on pb.id = d.b
       where ${code ? "d.code = $2" : "d.code in (select code from league_members where player = $1)"}
         and (d.a = $1 or d.b = $1 or d.status = 'open' or d.created_at > now() - interval '3 days')
         and exists (select 1 from league_members m where m.code = d.code and m.player = $1)
       order by d.created_at desc limit 40`, code ? [p.id, code] : [p.id]);
    return { me: p.id, duels: rows.map((d) => ({ ...d, t: Math.round(Number(d.tms)), tms: undefined })) };
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
  if (req.method === "GET") {
    const q = req.query || Object.fromEntries(new URL(req.url || "/", "http://x").searchParams);
    if (q.avatar) {
      try {
        const s = await db();
        const r = (await s.query(`select avatar from players where id = $1`, [String(int(q.avatar, 0, 1e15))]))[0];
        if (!r || !r.avatar) return res.status(404).json({ error: "none" });
        const buf = Buffer.from(r.avatar.slice(r.avatar.indexOf(",") + 1), "base64");
        res.setHeader("Content-Type", "image/jpeg");
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        return res.status(200).end(buf);
      } catch (e) { return res.status(500).json({ error: "server" }); }
    }
    if (q.glogo) {
      try {
        const s = await db();
        const r = (await s.query(`select logo from leagues where gid = $1`, [String(int(q.glogo, 0, 1e15))]))[0];
        if (!r || !r.logo) return res.status(404).json({ error: "none" });
        const m = /^data:(image\/(?:png|jpeg));base64,/.exec(r.logo);
        res.setHeader("Content-Type", m ? m[1] : "image/png");
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        return res.status(200).end(Buffer.from(r.logo.slice(r.logo.indexOf(",") + 1), "base64"));
      } catch (e) { return res.status(500).json({ error: "server" }); }
    }
    // équipes d'un championnat (équipe de cœur) : ESPN ne permet plus de les lire depuis le navigateur
    if (q.teams) {
      const path = String(q.teams);
      if (!FAV_PATHS.includes(path)) return res.status(404).json({ error: "unknown" });
      try {
        const j = await espnJSON(`${ESPN_API}${path}/teams`);
        const teams = j.sports[0].leagues[0].teams.map((x) => x.team).map((t) => ({ id: String(t.id), short: t.shortDisplayName, name: t.displayName, logo: (t.logos && t.logos[0] && t.logos[0].href) || null }));
        res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=86400");
        return res.status(200).json({ teams });
      } catch (e) { return res.status(502).json({ error: "espn" }); }
    }
    if (q.cron && q.slot === "tick") {
      try { return res.status(200).json(await tick(await db())); } catch (e) { console.error(e); return res.status(500).json({ error: "server" }); }
    }
    if (q.cron) {
      const want = process.env.CRON_SECRET || "", got = String(req.headers.authorization || "");
      if (want.length < 16 || got !== "Bearer " + want) return res.status(401).json({ error: "forbidden" });
      try { const s = await db(); return res.status(200).json(q.slot === "recap" ? await weeklyRecap(s) : q.slot === "midi" || q.slot === "soir" ? await reminders(s, q.slot) : await morning(s)); } catch (e) { console.error(e); return res.status(500).json({ error: "server" }); }
    }
    return res.status(200).json({ ok: true, service: "damateur-a-pro" });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "method" });
  res.setHeader("Cache-Control", "no-store");
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
export { ensurePrizes };   // pour les tests en local
