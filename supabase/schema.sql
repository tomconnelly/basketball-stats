-- Basketball Stats Tracker schema. Paste into Supabase: SQL Editor > New query > Run.
-- Safe to re-run.

create table if not exists public.players (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  number text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.games (
  id uuid primary key default gen_random_uuid(),
  date date not null default current_date,
  opponent text not null default '',
  format text not null default 'quarters' check (format in ('quarters', 'halves')),
  period text not null default 'Q1',
  ot int not null default 0,
  on_court jsonb not null default '[]'::jsonb,  -- player ids currently on court
  played jsonb not null default '[]'::jsonb,    -- everyone who has been on court (games played)
  created_at timestamptz not null default now()
);

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games(id) on delete cascade,
  player_id uuid references public.players(id) on delete set null,
  period text not null,
  type text not null check (type in ('shot', 'free_throw', 'rebound', 'assist', 'foul', 'turnover', 'steal', 'block')),
  shot_type text check (shot_type in ('three', 'two', 'layup')),
  made boolean,
  rebound_type text check (rebound_type in ('offensive', 'defensive')),
  linked_event_id uuid,  -- assist -> made shot, rebound -> missed shot
  created_at timestamptz not null default now(),
  device_id text,
  coach text
);

create index if not exists events_game_id_idx on public.events (game_id);

-- No user accounts in the MVP: the anon key can read and write everything.
alter table public.players enable row level security;
alter table public.games enable row level security;
alter table public.events enable row level security;

drop policy if exists "anon full access" on public.players;
drop policy if exists "anon full access" on public.games;
drop policy if exists "anon full access" on public.events;
create policy "anon full access" on public.players for all to anon using (true) with check (true);
create policy "anon full access" on public.games for all to anon using (true) with check (true);
create policy "anon full access" on public.events for all to anon using (true) with check (true);

-- Realtime: broadcast every change, with full rows on delete.
alter table public.players replica identity full;
alter table public.games replica identity full;
alter table public.events replica identity full;

do $$
declare t text;
begin
  foreach t in array array['players', 'games', 'events'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
