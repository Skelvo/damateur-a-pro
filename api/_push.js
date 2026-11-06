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
  if (!setup() || !players || !players.length) return;
  const ids = [...new Set(players.map(String))].filter((id) => String(id) !== String(except));
  if (!ids.length) return;
  const subs = await s.query(`select endpoint, keys from push_subs where player = any($1::bigint[])`, [ids]);
  if (!subs.length) return;
  const body = JSON.stringify(payload);
  const jobs = subs.map((x) => webpush.sendNotification({ endpoint: x.endpoint, keys: x.keys }, body, { TTL: 6 * 3600, urgency: "normal" })
    .catch(async (e) => {   // abonnement expiré ou révoqué : on l'oublie
      if (e && (e.statusCode === 404 || e.statusCode === 410)) await s.query(`delete from push_subs where endpoint = $1`, [x.endpoint]).catch(() => {});
    }));
  await Promise.race([Promise.allSettled(jobs), new Promise((r) => setTimeout(r, 4000))]);
}

export const members = async (s, code) => (await s.query(`select player from league_members where code = $1`, [code])).map((x) => x.player);
