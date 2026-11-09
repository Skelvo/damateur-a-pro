// Connexion à la base Neon « damateur-db » (variable DATABASE_URL posée par l'intégration Vercel) et schéma.
import { neon } from "@neondatabase/serverless";
import { createHash, randomBytes } from "node:crypto";

const SCHEMA_VERSION = "13";
const STATEMENTS = [
  `create table if not exists meta (key text primary key, value text)`,
  `create table if not exists players (
     id bigserial primary key,
     token_hash text unique not null,
     name text not null default 'Joueur',
     bal numeric not null default 1000,
     peak numeric not null default 1000,
     won int not null default 0,
     lost int not null default 0,
     week text,
     week_bal numeric,
     created_at timestamptz not null default now(),
     seen_at timestamptz not null default now())`,
  `create table if not exists leagues (
     code text primary key,
     name text not null,
     owner bigint references players(id) on delete set null,
     created_at timestamptz not null default now())`,
  `create table if not exists league_members (
     code text not null references leagues(code) on delete cascade,
     player bigint not null references players(id) on delete cascade,
     joined_at timestamptz not null default now(),
     primary key (code, player))`,
  `create index if not exists league_members_player on league_members(player)`,
  `create table if not exists picks (
     mid text not null,
     mk text not null,
     k int not null,
     player bigint not null references players(id) on delete cascade,
     at timestamptz not null default now(),
     primary key (mid, mk, player))`,
  `create table if not exists am_matches (
     id text primary key,
     sp text not null,
     lv int not null,
     dep text not null default '',
     h text not null,
     a text not null,
     t timestamptz not null,
     s jsonb not null default '[0,0]',
     created_by bigint references players(id) on delete set null,
     created_at timestamptz not null default now(),
     hidden boolean not null default false)`,
  `create index if not exists am_matches_t on am_matches(t)`,
  `create table if not exists am_reports (
     mid text not null references am_matches(id) on delete cascade,
     player bigint not null references players(id) on delete cascade,
     st jsonb not null,
     at timestamptz not null default now(),
     primary key (mid, player))`,
  // pseudos uniques (sans tenir compte des majuscules) : les doublons existants reçoivent leur numéro
  `update players p set name = left(p.name, 12) || ' ' || p.id
     where exists (select 1 from players q where lower(q.name) = lower(p.name) and q.id < p.id)`,
  `create unique index if not exists players_name_u on players (lower(name))`,
  // codes de transfert (passer de Safari à l'app installée, ou changer de téléphone)
  `create table if not exists transfers (
     code text primary key,
     player bigint not null references players(id) on delete cascade,
     state jsonb,
     expires timestamptz not null)`,
  // ligues vivantes : fil d'activité, réactions, gains de chaque semaine, duels
  `create table if not exists activity (
     id bigserial primary key,
     player bigint not null references players(id) on delete cascade,
     kind text not null,
     data jsonb not null default '{}',
     at timestamptz not null default now())`,
  `create index if not exists activity_player_at on activity(player, at desc)`,
  `create table if not exists reactions (
     act bigint not null references activity(id) on delete cascade,
     player bigint not null references players(id) on delete cascade,
     emo text not null,
     primary key (act, player))`,
  `create table if not exists weekly (
     player bigint not null references players(id) on delete cascade,
     week text not null,
     gain numeric not null,
     primary key (player, week))`,
  `create table if not exists duels (
     id bigserial primary key,
     code text not null references leagues(code) on delete cascade,
     a bigint not null references players(id) on delete cascade,
     b bigint references players(id) on delete set null,
     mid text not null,
     mlabel text not null,
     opts jsonb not null default '[]',
     t timestamptz not null,
     ka int not null,
     kb int,
     stake int not null,
     status text not null default 'open',
     res int,
     winner bigint,
     created_at timestamptz not null default now())`,
  `create index if not exists duels_code on duels(code, created_at desc)`,
  // photo de profil (JPEG recadré sur le téléphone, en base64) + paris visibles par les potes
  `alter table players add column if not exists avatar text`,
  `alter table players add column if not exists avatar_v int not null default 0`,
  `alter table players add column if not exists bets jsonb`,
  // côté dark : paris inventés par les membres d'une ligue (anonymes, pari mutuel)
  `create table if not exists dark_bets (
     id bigserial primary key,
     code text not null references leagues(code) on delete cascade,
     creator bigint not null references players(id) on delete cascade,
     question text not null,
     options jsonb not null,
     closes timestamptz not null,
     result int,
     resolved_at timestamptz,
     created_at timestamptz not null default now())`,
  `create index if not exists dark_bets_code on dark_bets(code, created_at desc)`,
  `create table if not exists dark_stakes (
     bet bigint not null references dark_bets(id) on delete cascade,
     player bigint not null references players(id) on delete cascade,
     opt int not null,
     amount int not null,
     primary key (bet, player))`,
  `create table if not exists dark_flags (
     bet bigint not null references dark_bets(id) on delete cascade,
     player bigint not null references players(id) on delete cascade,
     kind text not null,
     primary key (bet, player, kind))`,
  // côté dark : paris sur un chiffre (le plus proche gagne)
  `alter table dark_bets add column if not exists kind text not null default 'choice'`,
  `alter table dark_bets add column if not exists unit text`,
  `alter table dark_bets add column if not exists result_num numeric`,
  `alter table dark_stakes add column if not exists guess numeric`,
  // prono du week-end : matchs choisis par le serveur, scores exacts devinés par les joueurs
  `create table if not exists prono_weeks (
     week text primary key,
     matches jsonb not null,
     updated_at timestamptz not null default now())`,
  `create table if not exists prono_picks (
     week text not null,
     player bigint not null references players(id) on delete cascade,
     mid text not null,
     sh int not null,
     sa int not null,
     joker boolean not null default false,
     at timestamptz not null default now(),
     primary key (week, player, mid))`,
  // notifications (abonnements de chaque téléphone) et chat de ligue
  `create table if not exists push_subs (
     endpoint text primary key,
     player bigint not null references players(id) on delete cascade,
     keys jsonb not null,
     created_at timestamptz not null default now())`,
  `create index if not exists push_subs_player on push_subs(player)`,
  `create table if not exists chat (
     id bigserial primary key,
     code text not null references leagues(code) on delete cascade,
     player bigint not null references players(id) on delete cascade,
     text text not null,
     at timestamptz not null default now())`,
  `create index if not exists chat_code on chat(code, id desc)`,
  // saisons (un mois, heure de Paris) : gains du mois, comme le classement de la semaine
  `alter table players add column if not exists month text`,
  `alter table players add column if not exists month_bal numeric`,
  `create table if not exists monthly (
     player bigint not null references players(id) on delete cascade,
     month text not null,
     gain numeric not null,
     primary key (player, month))`,
  // rappels pour parier : 2 par jour, 1 (midi) ou 0
  `alter table players add column if not exists remind int not null default 2`,
  `create table if not exists rate_hits (key text not null, win bigint not null, n int not null default 0, primary key (key, win))`,
];

let sql = null;
let ready = null;

async function migrate() {
  try {
    const r = await sql.query(`select value from meta where key = 'schema'`);
    if (r[0]?.value === SCHEMA_VERSION) return;
  } catch {
    // table meta pas encore créée
  }
  for (const s of STATEMENTS) {
    try { await sql.query(s); } catch (e) {
      // deux démarrages simultanés peuvent se croiser sur « create if not exists » : on réessaie une fois
      await sql.query(s);
    }
  }
  // ménage : les anciens « limites anti-abus » ne servent plus après une journée
  await sql.query(`delete from rate_hits where win < $1`, [Math.floor(Date.now() / 1000) - 86400]);
  await sql.query(`insert into meta (key, value) values ('schema', $1) on conflict (key) do update set value = excluded.value`, [SCHEMA_VERSION]);
}

export async function db() {
  // globalThis.__dapSql : base de test locale (PGlite), jamais posée en ligne
  sql ??= globalThis.__dapSql ?? neon(process.env.DATABASE_URL);
  if (!ready) ready = migrate().catch((e) => { ready = null; throw e; });
  await ready;
  return sql;
}

export const hashToken = (t) => createHash("sha256").update(String(t)).digest("hex");
export const newToken = () => randomBytes(24).toString("base64url");

// Adresse IP seulement en empreinte salée qui change chaque jour (impossible de suivre quelqu'un).
export function ipKey(req) {
  const raw = String(req.headers["x-real-ip"] || req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return "ip:" + hashToken("dap-ip:" + new Date().toISOString().slice(0, 10) + ":" + raw).slice(0, 32);
}

// Limites anti-abus : true si la clé a déjà servi plus de `max` fois dans la fenêtre (en secondes).
export async function overLimit(key, max, windowSec) {
  if (globalThis.__dapNoLimits) return false;
  const s = await db();
  const win = Math.floor(Date.now() / 1000 / windowSec) * windowSec;
  const r = await s.query(
    `insert into rate_hits (key, win, n) values ($1, $2, 1) on conflict (key, win) do update set n = rate_hits.n + 1 returning n`,
    [key, win]);
  return r[0].n > max;
}
