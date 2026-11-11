// Programmateur de publications Instagram + Facebook (API officielle de Meta).
// Les publications sont préparées en brouillon, validées, puis envoyées automatiquement à l'heure prévue
// par la tâche « tick » (toutes les ~10 min). Aucun sticker ni sondage : l'API de Meta ne les permet pas.
const GV = () => process.env.META_GRAPH_VERSION || "v27.0";
const G = (p) => `https://graph.facebook.com/${GV()}/${p}`;

async function kvGet(s, k) { const r = (await s.query(`select value from meta where key = $1`, [k]))[0]; return r ? r.value : null; }
async function kvSet(s, k, v) { await s.query(`insert into meta (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value`, [k, v]); }

async function call(url, params, method = "POST") {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 20000);
  try {
    const opts = { method, signal: ctl.signal };
    if (method === "POST") { opts.headers = { "Content-Type": "application/x-www-form-urlencoded" }; opts.body = new URLSearchParams(params).toString(); }
    else url += (url.includes("?") ? "&" : "?") + new URLSearchParams(params).toString();
    const r = await fetch(url, opts), j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error((j.error && (j.error.error_user_msg || j.error.message)) || "HTTP " + r.status);
    return j;
  } finally { clearTimeout(t); }
}

// Configuration unique : jeton utilisateur (court) → jeton longue durée → jeton de la Page (sans expiration) + identifiants.
// Le jeton est gardé côté serveur, jamais renvoyé.
async function setup(s, userToken) {
  const id = process.env.META_APP_ID, secret = process.env.META_APP_SECRET;
  if (!id || !secret) throw new Error("META_APP_ID et META_APP_SECRET manquent dans Vercel");
  const ll = await call(G("oauth/access_token"), { grant_type: "fb_exchange_token", client_id: id, client_secret: secret, fb_exchange_token: userToken }, "GET");
  const pages = await call(G("me/accounts"), { access_token: ll.access_token, fields: "id,name,access_token,instagram_business_account{id,username}" }, "GET");
  const pg = (pages.data || []).find((p) => /tribune/i.test(p.name)) || (pages.data || [])[0];
  if (!pg) throw new Error("Aucune Page trouvée pour ce compte");
  if (!pg.instagram_business_account) throw new Error("La Page « " + pg.name + " » n'est pas reliée à un compte Instagram professionnel");
  await kvSet(s, "meta_page_token", pg.access_token);
  await kvSet(s, "meta_page_id", pg.id);
  await kvSet(s, "meta_ig_id", pg.instagram_business_account.id);
  return { page: pg.name, instagram: "@" + (pg.instagram_business_account.username || "?") };
}

async function creds(s) {
  const tok = await kvGet(s, "meta_page_token"), page = await kvGet(s, "meta_page_id"), ig = await kvGet(s, "meta_ig_id");
  if (!tok || !page || !ig) throw new Error("Programmateur pas encore configuré (admin_social_setup)");
  return { tok, page, ig };
}

async function igPublish(c, p) {
  const params = { access_token: c.tok, image_url: p.image };
  if (p.kind === "story") params.media_type = "STORIES"; else params.caption = p.caption_ig || "";
  const box = await call(G(`${c.ig}/media`), params);
  for (let i = 0; i < 10; i++) {   // l'image doit être traitée par Instagram avant publication
    const st = await call(G(box.id), { access_token: c.tok, fields: "status_code" }, "GET");
    if (st.status_code === "FINISHED") break;
    if (st.status_code === "ERROR") throw new Error("Instagram a refusé l'image");
    await new Promise((r) => setTimeout(r, 1500));
  }
  const pub = await call(G(`${c.ig}/media_publish`), { access_token: c.tok, creation_id: box.id });
  return pub.id;
}

async function fbPublish(c, p) {
  if (p.kind === "story") {
    const ph = await call(G(`${c.page}/photos`), { access_token: c.tok, url: p.image, published: "false" });
    const st = await call(G(`${c.page}/photo_stories`), { access_token: c.tok, photo_id: ph.id });
    return st.post_id || st.id || ph.id;
  }
  const r = await call(G(`${c.page}/photos`), { access_token: c.tok, url: p.image, message: p.caption_fb || "" });
  return r.post_id || r.id;
}

// Publie les publications validées dont l'heure est passée (au plus 3 par passage).
async function publishDue(s) {
  const due = await s.query(`update social_posts set status = 'publishing', tries = tries + 1
      where id in (select id from social_posts where status = 'approved' and at <= now() order by at limit 3)
      returning id, kind, at, image, caption_ig, caption_fb, networks, result`);
  if (!due.length) return 0;
  let c; try { c = await creds(s); } catch (e) {
    for (const p of due) await s.query(`update social_posts set status = 'error', error = $2 where id = $1`, [p.id, e.message]);
    return 0;
  }
  let n = 0;
  for (const p of due) {
    const res = p.result || {}, errs = [];
    for (const net of p.networks || []) {
      if (res[net]) continue;   // déjà publié sur ce réseau (relance après une erreur partielle)
      try { res[net] = net === "instagram" ? await igPublish(c, p) : await fbPublish(c, p); }
      catch (e) { errs.push(`${net} : ${e.message}`); }
    }
    await s.query(`update social_posts set status = $2, result = $3::jsonb, error = $4, published_at = case when $2 = 'published' then now() else published_at end where id = $1`,
      [p.id, errs.length ? "error" : "published", JSON.stringify(res), errs.join(" · ") || null]);
    if (!errs.length) n++;
  }
  return n;
}

export { setup, publishDue, kvGet };
