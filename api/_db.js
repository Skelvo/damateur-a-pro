// Connexion à la base Neon « damateur-db » (variable DATABASE_URL posée par l'intégration Vercel) et schéma.
import { neon } from "@neondatabase/serverless";
import { createHash, randomBytes } from "node:crypto";

const SCHEMA_VERSION = "33";
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
  // match de la ligue (un par jour, le même pour toutes les ligues) et votes 1 / N / 2
  `create table if not exists day_match (day text primary key, match jsonb, updated_at timestamptz not null default now())`,
  `create table if not exists lm_picks (
     day text not null,
     player bigint not null references players(id) on delete cascade,
     pick int not null,
     at timestamptz not null default now(),
     primary key (day, player))`,
  // équipe de cœur, historique des jetons, succès
  `alter table players add column if not exists fav jsonb`,
  `alter table players add column if not exists badges jsonb`,
  `create table if not exists bal_hist (
     player bigint not null references players(id) on delete cascade,
     day text not null,
     bal numeric not null,
     primary key (player, day))`,
  // ligues secrètes (côté dark caché)
  `alter table leagues add column if not exists dark boolean not null default false`,
  // gains des paris seuls, par semaine (YYYY-MM-DD, le lundi) et par mois (YYYY-MM) : base des classements
  `create table if not exists profits (
     player bigint not null references players(id) on delete cascade,
     per text not null,
     gain numeric not null,
     primary key (player, per))`,
  // récompenses du mois (montants choisis par le créateur de la ligue, crédités tout seuls)
  `alter table leagues add column if not exists prizes jsonb`,
  `create table if not exists month_prizes (
     code text not null references leagues(code) on delete cascade,
     month text not null,
     player bigint not null references players(id) on delete cascade,
     rank int not null,
     amount int not null,
     claimed boolean not null default false,
     primary key (code, month, player))`,
  // notifications de paris déjà envoyées (anti-doublons)
  `create table if not exists sent_notes (key text primary key, at timestamptz not null default now())`,
  // code de compte permanent (empreinte) et sauvegarde complète du téléphone
  `alter table players add column if not exists recovery_hash text`,
  `create index if not exists players_recovery on players(recovery_hash)`,
  `alter table players add column if not exists backup jsonb`,
  `alter table players add column if not exists backup_at timestamptz`,
  // roue : jour du dernier tour (b) et du tour bonus (x), gardés sur le compte
  `alter table players add column if not exists wheel jsonb`,
  // paris enregistrés par le serveur (contrôle des cotes et des horaires ; règlement à l'étape suivante)
  `create table if not exists bets (
     id bigserial primary key,
     player bigint not null references players(id) on delete cascade,
     cid text not null,
     at timestamptz not null default now(),
     stake int not null,
     odds numeric not null,
     combo boolean not null default false,
     legs jsonb not null,
     groups jsonb,
     status text not null default 'open',
     pay numeric,
     settled_at timestamptz,
     unique (player, cid))`,
  `create index if not exists bets_open on bets(status) where status = 'open'`,
  // désaccords entre le règlement du serveur et celui du téléphone (phase de contrôle)
  `create table if not exists settle_diff (
     player bigint not null references players(id) on delete cascade,
     cid text not null,
     server text, client text, spay numeric, cpay numeric,
     at timestamptz not null default now(),
     primary key (player, cid))`,
  // registre des jetons hors paris (roue, défis, prono, match de la ligue, récompenses…)
  `create table if not exists ledger (
     id bigserial primary key,
     player bigint not null references players(id) on delete cascade,
     delta int not null,
     kind text not null,
     ref text not null,
     at timestamptz not null default now(),
     unique (player, kind, ref))`,
  `alter table duels add column if not exists path text`,
  // guildes : emblème, devise, accès, rôles, demandes d'adhésion
  `alter table leagues add column if not exists emblem jsonb`,
  `alter table leagues add column if not exists motto text`,
  `alter table leagues add column if not exists access text not null default 'private'`,
  `alter table league_members add column if not exists role text not null default 'member'`,
  `create table if not exists requests (
     code text not null references leagues(code) on delete cascade,
     player bigint not null references players(id) on delete cascade,
     at timestamptz not null default now(),
     primary key (code, player))`,
  // combats de guildes : défis directs et championnat du lundi (cote Elo, divisions Bronze → Diamant)
  `alter table leagues add column if not exists gid bigserial`,
  `alter table leagues add column if not exists elo int not null default 1000`,
  `alter table leagues add column if not exists bw int not null default 0`,
  `alter table leagues add column if not exists bl int not null default 0`,
  `alter table leagues add column if not exists bd int not null default 0`,
  `alter table leagues add column if not exists champ boolean not null default true`,
  `create table if not exists battles (
     id bigserial primary key,
     kind text not null,
     week text not null,
     a text not null references leagues(code) on delete cascade,
     b text not null references leagues(code) on delete cascade,
     status text not null,
     by_player bigint,
     a_score numeric, b_score numeric, winner text,
     a_delta int, b_delta int,
     created_at timestamptz not null default now(),
     settled_at timestamptz)`,
  `create index if not exists battles_a on battles(a, week)`,
  `create index if not exists battles_b on battles(b, week)`,
  `create index if not exists battles_status on battles(status)`,
  `create table if not exists battle_members (
     battle bigint not null references battles(id) on delete cascade,
     code text not null,
     player bigint not null references players(id) on delete cascade,
     primary key (battle, code, player))`,
  `create table if not exists battle_rewards (
     battle bigint not null references battles(id) on delete cascade,
     player bigint not null references players(id) on delete cascade,
     amount int not null,
     result text not null,
     claimed boolean not null default false,
     primary key (battle, player))`,
  // modération et cadre légal : signalements, noms retirés, messages masqués, acceptation des règles
  `create table if not exists reports (
     id bigserial primary key,
     reporter bigint references players(id) on delete set null,
     kind text not null,
     target text not null,
     text text,
     at timestamptz not null default now())`,
  `create unique index if not exists reports_u on reports(reporter, kind, target) where kind <> 'contact'`,
  `create table if not exists banned_names (name text primary key, at timestamptz not null default now())`,
  `alter table chat add column if not exists hidden boolean not null default false`,
  `alter table players add column if not exists tos text`,
  `alter table players add column if not exists tos_at timestamptz`,
  // cadeaux calculés par le serveur et versés à l'ouverture de l'appli (bonus des combinés du week-end…)
  `create table if not exists gifts (
     player bigint not null references players(id) on delete cascade,
     kind text not null,
     ref text not null,
     amount int not null,
     label text,
     claimed boolean not null default false,
     at timestamptz not null default now(),
     primary key (player, kind, ref))`,
  `alter table bets add column if not exists cancelled boolean not null default false`,
  // anti-triche : gains EN PARIS calculés par le serveur à partir des paris qu'il a lui-même réglés
  // (semaine = lundi heure de Paris, mois = YYYY-MM) ; la table profits (envoyée par les téléphones) ne sert plus qu'à comparer
  `create or replace view sprofits as
     select player, per, sum(gain)::numeric as gain from (
       select player, to_char(date_trunc('week', settled_at at time zone 'Europe/Paris'), 'YYYY-MM-DD') as per,
              case when status = 'lost' then -stake else coalesce(pay, 0) - stake end as gain
         from bets where status in ('won', 'lost', 'cashed', 'void') and settled_at is not null
       union all
       select player, to_char(settled_at at time zone 'Europe/Paris', 'YYYY-MM') as per,
              case when status = 'lost' then -stake else coalesce(pay, 0) - stake end as gain
         from bets where status in ('won', 'lost', 'cashed', 'void') and settled_at is not null) x
     group by player, per`,
  // anti-triche : solde de référence de chaque joueur (pris à sa première synchro, ou après « Recommencer »)
  `create table if not exists audit_base (
     player bigint primary key references players(id) on delete cascade,
     bal numeric not null,
     at timestamptz not null default now())`,
  // tickets partagés : un code court par pari, pour ouvrir le ticket depuis un lien et le suivre
  `create table if not exists shared_bets (
     code text primary key,
     bet bigint not null references bets(id) on delete cascade,
     follows int not null default 0,
     at timestamptz not null default now(),
     unique (bet))`,
  // lien de ticket ouvert dans Safari (iPhone) : empreinte brouillée de la connexion, gardée 20 min, pour que l'app installée ouvre le ticket
  `create table if not exists link_hits (ip text not null, code text not null, at timestamptz not null default now(), primary key (ip, code))`,
  // XP : calculée par le serveur à partir des paris qu'il a réglés et du registre (défis, combats, prono, match de la guilde, podiums)
  `alter table players add column if not exists xp_seed int`,
  `create or replace view pxp as
     with b as (select player, status, stake, odds::float8 as odds, pay::float8 as pay,
                  row_number() over (partition by player, (settled_at at time zone 'Europe/Paris')::date order by settled_at, id) as rn
                from bets where status in ('won', 'lost', 'cashed') and settled_at is not null),
     bx as (select player, sum(
              case when rn <= 10 and stake >= 5 then 10 else 0 end
              + case when status = 'won' and stake >= 5 then least(200, round(15 * (odds - 1)))
                     when status = 'cashed' and stake >= 5 and pay > stake then least(100, round(7.5 * (pay / stake - 1)))
                     else 0 end) as xp from b group by player),
     lx as (select player, sum(case kind when 'defi' then 15 when 'defis' then 30
              when 'battle' then case when delta >= 200 then 50 when delta >= 75 then 25 else 10 end
              when 'prono' then delta / 2 when 'lm' then 10
              when 'prize' then case when delta >= 1000 then 100 when delta >= 500 then 60 when delta >= 250 then 40 else 0 end
              else 0 end) as xp from ledger group by player)
     select p.id as player, (coalesce(bx.xp, 0) + coalesce(lx.xp, 0) + coalesce(p.xp_seed, 0))::int as xp
     from players p left join bx on bx.player = p.id left join lx on lx.player = p.id`,
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
