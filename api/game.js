// Seule fonction serveur de Tribune : comptes anonymes, ligues entre amis, classements,
// et « ce que parient les autres ». Tout passe par POST /api/game {action, ...}.
import { db, hashToken, newToken, ipKey, overLimit } from "./_db.js";
import { timingSafeEqual } from "node:crypto";
import { buildWeek, refreshResults, points, todayMatches, bestOfDay } from "./_prono.js";
import { notify, members } from "./_push.js";

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
const lname = async (s, code) => ((await s.query(`select name from leagues where code = $1`, [code]))[0] || {}).name || "ta ligue";
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
const BOARD_COLS = `p.id, p.name, p.bal::float8 as bal, p.peak::float8 as peak, p.won, p.lost, p.avatar_v, p.fav, p.badges,
  coalesce((select x.gain from profits x where x.player = p.id and x.per = ${WEEK}), 0)::float8 as week_gain,
  coalesce((select x.gain from profits x where x.player = p.id and x.per = ${MONTH}), 0)::float8 as month_gain`;
// Gains par semaine (ou par mois) des membres d'une ligue, y compris la dernière période de ceux
// qui n'ont pas rouvert l'app depuis ; rk = place dans la ligue pour cette période.
// Depuis le 9 novembre 2026, seuls les PARIS comptent (table profits, envoyée par chaque téléphone) :
// la roue, les défis, le prono et le match de la ligue ne comptent plus. Avant, c'était l'écart de solde.
const CUT = { week: "2026-11-09", month: "2026-11" };
const periodGains = (tbl, col, cur, bal) => `with mem as (select player from league_members where code = $1),
  g as (select pr.player, pr.per, pr.gain from profits pr join mem on mem.player = pr.player where length(pr.per) = ${col === "week" ? 10 : 7} and pr.per >= '${CUT[col]}'
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
    `select l.code, l.name, l.owner = $1 as mine, l.prizes, (select count(*)::int from league_members m2 where m2.code = l.code) as n
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

// ---- Bilan de la semaine passée d'une ligue (calculé à la demande, rien n'est stocké) ----
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
  const t = (await s.query(`select extract(isodow from now() at time zone 'Europe/Paris')::int as dow,
      extract(day from now() at time zone 'Europe/Paris')::int as day, ${PREV_WEEK} as w, ${PREV_MONTH} as m`))[0];
  const once = async (key) => !!(await s.query(`insert into meta (key, value) values ($1, '1') on conflict do nothing returning key`, [key]))[0];
  const leagues = await s.query(`select l.code, l.name from leagues l where not l.dark and (select count(*) from league_members m where m.code = l.code) >= 2`);
  const out = { recap: 0, season: 0 };
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
async function reminders(s, slot) {
  const t = (await s.query(`select to_char(now() at time zone 'Europe/Paris', 'YYYYMMDD') as ymd, extract(isodow from now() at time zone 'Europe/Paris')::int as dow,
      extract(epoch from ((date_trunc('day', now() at time zone 'Europe/Paris') + interval '1 day') at time zone 'Europe/Paris')) * 1000 as eod`))[0];
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
      if (lg) msg = { title: "⚽ Match de la ligue", body: `${lm.cur.match.h} – ${lm.cur.match.a} à ${hhmm(lm.cur.match.t)}. ${lg.n ? `${lg.n} collègue${lg.n > 1 ? "s ont" : " a"} déjà voté` : "Personne n'a encore voté"}, et toi ? Bonne réponse = +${LM_PRIZE} jetons.`, url: go("rank", lg.code), tag: "remind-lm" };
    }
    if (!msg && slot === "soir") {
      // rivalité : le joueur juste devant moi cette semaine dans ma ligue la plus active
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

// ---- Match de la ligue : un match par jour (le même pour tout le monde), on vote 1 / N / 2 ----
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

// ---- Récompenses du mois : à la fin du mois, chaque ligue (2 membres ou plus) donne des jetons selon le classement final ----
// (1er, 2e, 3e, puis « tous les autres » ; il faut avoir au moins un pari terminé dans le mois). Les égalités gagnent pareil.
// Montants IDENTIQUES pour toutes les ligues, fixés ici (même liste dans index.html : PRZ).
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
async function espnJSON(u) { const c = new AbortController(), t = setTimeout(() => c.abort(), 7000); try { const r = await fetch(u, { signal: c.signal }); if (!r.ok) throw new Error(r.status); return await r.json(); } finally { clearTimeout(t); } }
const sentOnce = async (s, key) => !!(await s.query(`insert into sent_notes (key) values ($1) on conflict do nothing returning key`, [key]))[0];
async function tick(s) {
  if (await overLimit("tick:global", 1, 240)) return { skipped: "trop tôt" };
  await s.query(`delete from sent_notes where at < now() - interval '30 days'`);
  const ppl = await s.query(`select p.id, p.bets from players p where p.bets is not null and exists (select 1 from push_subs x where x.player = p.id)`);
  const now = Date.now(), out = { ko: 0, end: 0, fetched: 0 };
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

const ACTIONS = {
  // Crée un joueur anonyme. Le jeton n'est gardé qu'en empreinte sha256.
  async session(s, b, req) {
    if (await overLimit(ipKey(req) + ":new", 30, 3600)) throw fail(429, "slow_down");
    const token = newToken();
    const bal = b.bal == null ? 1000 : num(b.bal, 0, MAX_BAL);
    const name = cleanName(b.name, 18) || "Joueur " + Math.floor(1000 + Math.random() * 9000);
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
    return { token, id: r[0].id, name };
  },

  // Le pseudo est-il libre ? (pas déjà pris par un autre joueur, sans tenir compte des majuscules)
  async check_name(s, b) {
    const name = cleanName(b.name, 18);
    if (!name) return { free: false };
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
    await s.query(`insert into bal_hist (player, day, bal) values ($1, to_char(now() at time zone 'Europe/Paris', 'YYYYMMDD'), $2::numeric)
       on conflict (player, day) do update set bal = excluded.bal`, [p.id, num(b.bal, 0, MAX_BAL)]);
    if (b.profits && typeof b.profits === "object") {
      const P = Object.entries(b.profits).filter(([k]) => /^\d{4}-\d{2}(-\d{2})?$/.test(k) && k >= "2026-10").slice(0, 40);
      for (const [per, g] of P) await s.query(`insert into profits (player, per, gain) values ($1, $2, $3::numeric) on conflict (player, per) do update set gain = excluded.gain`,
        [p.id, per, num(g, -MAX_BAL, MAX_BAL)]);
    }
    if (Array.isArray(b.badges)) await s.query(`update players set badges = $2::jsonb where id = $1`,
      [p.id, JSON.stringify([...new Set(b.badges.map((x) => cleanName(x, 20)).filter(Boolean))].slice(0, 60))]);
    if (Array.isArray(b.bets)) {
      const json = JSON.stringify({ list: b.bets.slice(0, 40), best: b.best && typeof b.best === "object" ? b.best : null });
      if (json.length <= 150000) await s.query(`update players set bets = $2::jsonb where id = $1`, [p.id, json]);
    }
    const name = cleanName(b.name, 18);
    if (name && name !== p.name) {
      try {
        await s.query(`update players set name = $2 where id = $1`, [p.id, name]);
      } catch (e) {
        if (isTaken(e)) return { ok: true, name_taken: true, name: p.name };
        throw e;
      }
    }
    return { ok: true, name: name || p.name };
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
  async recovery_make(s, b) {
    const p = await me(s, b.token);
    const cur = (await s.query(`select recovery_hash from players where id = $1`, [p.id]))[0];
    if (cur && cur.recovery_hash && !b.renew) return { exists: true };
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
  async admin_players(s, b) {
    admin(b);
    const rows = await s.query(
      `select p.id, p.name, p.bal::float8 as bal, p.won, p.lost, p.created_at, p.seen_at,
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
      await notify(s, await members(s, code), { title: l.name, body: `${p.name} a rejoint la ligue 👋`, url: go("rank", code), tag: "join-" + code }, p.id);
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
      rows: rows.map((r) => ({ id: r.id, name: r.name, bal: Math.round(r.bal), peak: Math.round(r.peak), won: r.won, lost: r.lost, week: Math.round(r.week_gain), season: Math.round(r.month_gain), tr: trophies[r.id] || 0, sc: crowns[r.id] || 0, av: r.avatar_v || 0, fav: r.fav ? { n: r.fav.name, l: r.fav.logo } : null, nb: Array.isArray(r.badges) ? r.badges.length : 0 })),
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

  // ---- Fiche d'un joueur (visible si on partage une ligue avec lui) ----
  async profile(s, b) {
    const p = await me(s, b.token);
    const id = String(int(b.id, 0, 1e15));
    if (id !== String(p.id)) {
      const ok = (await s.query(
        `select 1 from league_members a join league_members c on c.code = a.code where a.player = $1 and c.player = $2 limit 1`, [p.id, id]))[0];
      if (!ok) throw fail(403, "not_friend");
    }
    const r = (await s.query(
      `select id, name, bal::float8 as bal, peak::float8 as peak, won, lost, avatar_v, bets, fav, badges, extract(epoch from created_at) * 1000 as since,
         (select count(*)::int from weekly w where w.player = players.id) as weeks
       from players where id = $1`, [id]))[0];
    if (!r) throw fail(404, "unknown");
    return { id: r.id, name: r.name, bal: Math.round(r.bal), peak: Math.round(r.peak), won: r.won, lost: r.lost, av: r.avatar_v || 0,
      bets: (r.bets && r.bets.list) || [], best: (r.bets && r.bets.best) || null, since: Math.round(Number(r.since)),
      fav: r.fav || null, badges: Array.isArray(r.badges) ? r.badges : [],
      hist: (await s.query(`select day, bal::float8 as bal from bal_hist where player = $1 and day >= to_char((now() at time zone 'Europe/Paris') - interval '30 days', 'YYYYMMDD') order by day`, [id])).map((x) => [x.day, Math.round(x.bal)]) };
  },

  // ---- Côté dark : paris inventés par les membres (anonymes, pari mutuel), seulement dans les ligues secrètes ----
  // (une ligue secrète n'apparaît pas dans les ligues normales et se rejoint seulement par son code, depuis l'entrée cachée)
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
    return {
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
    const sp = f.sp === "rugby" ? "rugby" : "foot", id = String(f.id || "");
    const path = String(f.path || ""), logo = String(f.logo || "");
    if (!/^\d{1,9}$/.test(id) || !/^(soccer|rugby)\/[\w.]{2,30}$/.test(path) || (logo && !/^https:\/\/a\.espncdn\.com\/[\w\/.\-]+$/.test(logo))) throw fail(400, "fav");
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

  // ---- Chat de la ligue ----
  async chat_send(s, b, req) {
    const p = await me(s, b.token);
    const code = cleanName(b.code, 8).toUpperCase();
    if (!(await isMember(s, code, p.id))) throw fail(403, "not_member");
    const text = String(b.text ?? "").replace(/[\u0000-\u0008\u000b-\u001f]/g, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 400);
    if (!text) throw fail(400, "empty");
    if (await overLimit("chat:" + p.id, 30, 60)) throw fail(429, "slow_down");
    const r = await s.query(`insert into chat (code, player, text) values ($1, $2, $3) returning id, extract(epoch from at) * 1000 as ms`, [code, p.id, text]);
    // une notification de chat au plus toutes les 10 min par membre et par ligue
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
      `select c.id, c.player, pl.name, pl.avatar_v, c.text, extract(epoch from c.at) * 1000 as ms from chat c join players pl on pl.id = c.player
       where c.code = $1 and c.id > $2 order by c.id desc limit 120`, [code, after]);
    return { me: p.id, msgs: rows.reverse().map((r) => ({ id: r.id, who: r.player, name: r.name, av: r.avatar_v || 0, text: r.text, at: Math.round(Number(r.ms)) })) };
  },
  async chat_delete(s, b) {
    const p = await me(s, b.token);
    await s.query(`delete from chat where id = $1 and player = $2`, [int(b.id, 0, 1e15), p.id]);
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

  // ---- Duels entre membres d'une ligue (sur le résultat d'un vrai match) ----
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
      `insert into duels (code, a, mid, mlabel, opts, t, ka, stake) values ($1, $2, $3, $4, $5::jsonb, to_timestamp($6::float8 / 1000), $7, $8) returning id`,
      [code, p.id, cleanName(b.mid, 80), cleanName(b.mlabel, 80), JSON.stringify(opts), t, ka, stake]);
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
      const winner = d.ka === res ? d.a : d.kb === res ? d.b : null;
      const u = await s.query(`update duels set status = 'done', res = $2, winner = $3 where id = $1 and status = 'live' returning id`, [id, res, winner]);
      if (u[0]) {
        const names = Object.fromEntries((await s.query(`select id, name from players where id = any($1::bigint[])`, [[d.a, d.b].filter(Boolean)])).map((x) => [String(x.id), x.name]));
        await notify(s, [d.a, d.b].filter(Boolean), { title: "⚔️ Duel terminé · " + d.mlabel,
          body: winner ? `${names[String(winner)] || "?"} remporte ${2 * d.stake} jetons !` : "Personne n'a vu juste : mises remboursées.", url: go("duels", d.code), tag: "duel-" + id });
      }
    }
    return { ok: true };
  },

  async duels(s, b) {
    const p = await me(s, b.token);
    const code = cleanName(b.code, 8).toUpperCase();
    // les duels jamais relevés avant le coup d'envoi expirent
    await s.query(`update duels set status = 'expired' where status = 'open' and t < now()`);
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
    if (q.cron && q.slot === "tick") {
      try { return res.status(200).json(await tick(await db())); } catch (e) { console.error(e); return res.status(500).json({ error: "server" }); }
    }
    if (q.cron) {
      const want = process.env.CRON_SECRET || "", got = String(req.headers.authorization || "");
      if (want.length < 16 || got !== "Bearer " + want) return res.status(401).json({ error: "forbidden" });
      try { const s = await db(); return res.status(200).json(q.slot === "midi" || q.slot === "soir" ? await reminders(s, q.slot) : await morning(s)); } catch (e) { console.error(e); return res.status(500).json({ error: "server" }); }
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
