// Notifications push (Web Push, clés VAPID dans les réglages Vercel). Sans les clés, rien n'est envoyé.
import webpush from "web-push";

let ready = null;
function setup() {
  if (ready !== null) return ready;
  const pub = process.env.VAPID_PUBLIC, priv = process.env.VAPID_PRIVATE;
  ready = !!(pub && priv);
  if (ready) webpush.setVapidDetails("mailto:skelvo.web@gmail.com", pub, priv);
  return ready;
}

// Envoie à tous les téléphones des joueurs donnés (sauf `except`). Ne bloque jamais plus de ~4 s.
export async function notify(s, players, payload, except) {
  if (globalThis.__dapPushLog) { globalThis.__dapPushLog.push({ to: players.map(String), ...payload }); return; }   // tests en local
  if (!setup() || !players || !players.length) return;
  const ids = [...new Set(players.map(String))].filter((id) => String(id) !== String(except));
  if (!ids.length) return;
  const subs = await s.query(`select player, endpoint, keys from push_subs where player = any($1::bigint[])`, [ids]);
  if (!subs.length) return;
  const body = JSON.stringify(payload), res = {};
  const R = (pl) => (res[pl] ||= { ok: 0, fail: 0, err: "" });
  const jobs = subs.map((x) => webpush.sendNotification({ endpoint: x.endpoint, keys: x.keys }, body, { TTL: 6 * 3600, urgency: "high" })
    .then(() => { R(String(x.player)).ok++; })
    .catch(async (e) => {   // abonnement expiré ou révoqué : on l'oublie
      const r = R(String(x.player)); r.fail++; r.err = String((e && (e.statusCode || e.code || e.message)) || "err").slice(0, 60);
      if (e && (e.statusCode === 404 || e.statusCode === 410)) await s.query(`delete from push_subs where endpoint = $1`, [x.endpoint]).catch(() => {});
    }));
  await Promise.race([Promise.allSettled(jobs), new Promise((r) => setTimeout(r, 4000))]);
  // journal (diagnostic) : une ligne par joueur
  try {
    const rows = Object.entries(res);
    if (rows.length) await s.query(`insert into push_log (player, tag, title, ok, fail, err)
        select x.p::bigint, $2, $3, x.ok, x.fail, nullif(x.err, '') from jsonb_to_recordset($1::jsonb) as x(p text, ok int, fail int, err text)`,
      [JSON.stringify(rows.map(([p, r]) => ({ p, ...r }))), String(payload.tag || "").slice(0, 40), String(payload.title || "").slice(0, 120)]);
    if (Math.random() < 0.02) await s.query(`delete from push_log where at < now() - interval '14 days'`);
  } catch (e) { console.error("push_log", e); }
}

export const members = async (s, code) => (await s.query(`select player from league_members where code = $1`, [code])).map((x) => x.player);
