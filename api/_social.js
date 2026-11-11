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

// attend qu'Instagram ait traité un conteneur (image, élément ou carrousel)
async function igReady(c, id, tries = 12) {
  for (let i = 0; i < tries; i++) {
    const st = await call(G(id), { access_token: c.tok, fields: "status_code" }, "GET");
    if (st.status_code === "FINISHED") return;
    if (st.status_code === "ERROR") throw new Error("Instagram a refusé l'image");
    await new Promise((r) => setTimeout(r, 1500));
  }
}

async function igPublish(c, p) {
  let box;
  if (p.kind === "reel") {   // vidéo : traitement plus long côté Instagram
    const prm = { access_token: c.tok, media_type: "REELS", video_url: p.image, caption: p.caption_ig || "", share_to_feed: "true" };
    if (p.cover) prm.cover_url = p.cover;   // couverture personnalisée
    box = await call(G(`${c.ig}/media`), prm);
    await igReady(c, box.id, 40);
    const pub = await call(G(`${c.ig}/media_publish`), { access_token: c.tok, creation_id: box.id });
    return pub.id;
  }
  if (p.kind === "carousel") {
    const kids = [];
    for (const url of p.images) {
      const k = await call(G(`${c.ig}/media`), { access_token: c.tok, image_url: url, is_carousel_item: "true" });
      kids.push(k.id);
    }
    for (const k of kids) await igReady(c, k);
    box = await call(G(`${c.ig}/media`), { access_token: c.tok, media_type: "CAROUSEL", children: kids.join(","), caption: p.caption_ig || "" });
  } else {
    const params = { access_token: c.tok, image_url: p.image };
    if (p.kind === "story") params.media_type = "STORIES"; else params.caption = p.caption_ig || "";
    box = await call(G(`${c.ig}/media`), params);
  }
  await igReady(c, box.id);
  const pub = await call(G(`${c.ig}/media_publish`), { access_token: c.tok, creation_id: box.id });
  return pub.id;
}

async function fbPublish(c, p) {
  if (p.kind === "story") {
    const ph = await call(G(`${c.page}/photos`), { access_token: c.tok, url: p.image, published: "false" });
    const st = await call(G(`${c.page}/photo_stories`), { access_token: c.tok, photo_id: ph.id });
    return st.post_id || st.id || ph.id;
  }
  if (p.kind === "reel") {   // Reel Facebook : début → envoi de la vidéo par son adresse → publication
    const st = await call(G(`${c.page}/video_reels`), { access_token: c.tok, upload_phase: "start" });
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 60000);
    try {
      const r = await fetch(`https://rupload.facebook.com/video-upload/${GV()}/${st.video_id}`, { method: "POST", signal: ctl.signal, headers: { Authorization: "OAuth " + c.tok, file_url: p.image } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.success) throw new Error("envoi de la vidéo refusé : " + ((j.debug_info && j.debug_info.message) || (j.error && j.error.message) || r.status));
    } finally { clearTimeout(t); }
    if (p.cover) {   // couverture personnalisée (avant publication) ; si ça échoue, Facebook en choisit une
      try {
        const img = await fetch(p.cover); if (!img.ok) throw new Error("couverture introuvable");
        const fd = new FormData(); fd.append("access_token", c.tok); fd.append("is_preferred", "true");
        fd.append("source", new Blob([await img.arrayBuffer()], { type: img.headers.get("content-type") || "image/jpeg" }), "cover.jpg");
        await fetch(G(`${st.video_id}/thumbnails`), { method: "POST", body: fd });
      } catch (e) { /* sans gravité */ }
    }
    await call(G(`${c.page}/video_reels`), { access_token: c.tok, upload_phase: "finish", video_id: st.video_id, video_state: "PUBLISHED", description: p.caption_fb || "" });
    return st.video_id;
  }
  if (p.kind === "carousel") {   // sur Facebook : une publication avec plusieurs photos
    const params = { access_token: c.tok, message: p.caption_fb || "" };
    let i = 0;
    for (const url of p.images) {
      const ph = await call(G(`${c.page}/photos`), { access_token: c.tok, url, published: "false" });
      params[`attached_media[${i++}]`] = JSON.stringify({ media_fbid: ph.id });
    }
    const r = await call(G(`${c.page}/feed`), params);
    return r.id;
  }
  const r = await call(G(`${c.page}/photos`), { access_token: c.tok, url: p.image, message: p.caption_fb || "" });
  return r.post_id || r.id;
}

// Publie les publications validées dont l'heure est passée (au plus 3 par passage ; un carrousel compte pour une).
async function publishDue(s) {
  const due = await s.query(`update social_posts set status = 'publishing', tries = tries + 1
      where id in (select id from social_posts where status = 'approved' and at <= now() order by at limit 3)
      returning id, kind, at, image, images, cover, caption_ig, caption_fb, networks, result`);
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

// vérification sans rien publier : compte Instagram lisible et quota de publication accessible (= droit de publier)
async function check(s) {
  const c = await creds(s), out = {};
  try { const a = await call(G(c.ig), { access_token: c.tok, fields: "username,media_count" }, "GET"); out.instagram = "@" + a.username + " (" + a.media_count + " publications)"; } catch (e) { out.instagram = "erreur : " + e.message; }
  try { const q = await call(G(`${c.ig}/content_publishing_limit`), { access_token: c.tok, fields: "quota_usage,config" }, "GET"); out.publication_instagram = "OK (quota : " + JSON.stringify((q.data || [])[0] || {}) + ")"; } catch (e) { out.publication_instagram = "erreur : " + e.message; }
  try { const p = await call(G(c.page), { access_token: c.tok, fields: "name,followers_count" }, "GET"); out.page = p.name.trim() + " (lisible)"; } catch (e) { out.page = "erreur : " + e.message; }
  return out;
}

export { setup, publishDue, kvGet, check, call, G, creds };
