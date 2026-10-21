-- 001_initial_schema.sql
-- WhatsApp job channel ingestion: raw posts, normalized jobs, health status and
-- a private schema for the connector's session state.
--
-- Access model:
--   * The ingestion service connects with the postgres role (direct/pooler URL)
--     and therefore bypasses RLS. It is the only writer.
--   * The website reads through PostgREST with the anon key, so RLS decides
--     what is visible. Only published jobs are readable by anon.
--   * The `connector` schema is NOT exposed through PostgREST, so session
--     state is unreachable from the public API surface.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- public.source_posts — one row per source post/update
-- ---------------------------------------------------------------------------
create table if not exists public.source_posts (
	id                  uuid primary key default gen_random_uuid(),
	source_name         text        not null default 'whatsapp_channel',
	source_channel_id   text        not null,
	source_message_id   text        not null,
	source_server_id    text,
	source_timestamp    timestamptz,
	raw_text            text        not null default '',
	raw_payload         jsonb,
	content_hash        text        not null,
	processing_status   text        not null default 'pending'
	                    check (processing_status in ('pending','processed','needs_review','failed','duplicate')),
	received_at         timestamptz not null default now(),
	constraint source_posts_identity unique (source_name, source_channel_id, source_message_id)
);

create index if not exists source_posts_channel_time_idx
	on public.source_posts (source_channel_id, source_timestamp desc);
create index if not exists source_posts_status_idx on public.source_posts (processing_status);
create index if not exists source_posts_hash_idx on public.source_posts (content_hash);

-- ---------------------------------------------------------------------------
-- public.jobs — normalized job records
-- ---------------------------------------------------------------------------
create table if not exists public.jobs (
	id                 uuid primary key default gen_random_uuid(),
	source_post_id     uuid not null references public.source_posts(id) on delete cascade,
	title              text,
	company            text,
	location           text,
	work_mode          text,
	employment_type    text,
	eligibility        text,
	experience         text,
	batch_years        text,
	description        text,
	apply_url          text,
	deadline           date,
	original_post_url  text,
	source_posted_at   timestamptz,
	status             text not null default 'draft'
	                   check (status in ('draft','published','expired','rejected')),
	dedupe_key         text,
	created_at         timestamptz not null default now(),
	updated_at         timestamptz not null default now()
);

create unique index if not exists jobs_dedupe_key_uniq
	on public.jobs (dedupe_key) where dedupe_key is not null;
create index if not exists jobs_status_created_idx on public.jobs (status, created_at desc);
create index if not exists jobs_company_idx on public.jobs (company);
create index if not exists jobs_location_idx on public.jobs (location);
create index if not exists jobs_source_post_idx on public.jobs (source_post_id);

-- ---------------------------------------------------------------------------
-- public.ingestion_status — singleton health row
-- ---------------------------------------------------------------------------
create table if not exists public.ingestion_status (
	id                 smallint primary key default 1 check (id = 1),
	connector_status   text        not null default 'starting',
	last_connected_at  timestamptz,
	last_message_at    timestamptz,
	last_success_at    timestamptz,
	last_error_at      timestamptz,
	last_error_code    text,
	reconnect_count    integer     not null default 0,
	posts_ingested     bigint      not null default 0,
	duplicates_skipped bigint      not null default 0,
	needs_review       bigint      not null default 0,
	channel_id         text,
	process_memory_mb  numeric,
	process_uptime_s   integer,
	updated_at         timestamptz not null default now()
);

insert into public.ingestion_status (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- connector.* — private session state, not exposed through PostgREST
-- ---------------------------------------------------------------------------
create schema if not exists connector;

create table if not exists connector.session_creds (
	id         text primary key default 'default',
	payload    text        not null,   -- AES-256-GCM encrypted JSON
	updated_at timestamptz not null default now()
);

create table if not exists connector.session_keys (
	key_type   text        not null,
	key_id     text        not null,
	payload    text        not null,   -- AES-256-GCM encrypted JSON
	updated_at timestamptz not null default now(),
	primary key (key_type, key_id)
);

-- Single-writer lease: prevents two ingestor instances from sharing one
-- WhatsApp session (a second client would be kicked with status 440).
create table if not exists connector.lease (
	id         text primary key default 'ingestor',
	owner      text        not null,
	acquired_at timestamptz not null default now(),
	expires_at timestamptz not null
);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.source_posts    enable row level security;
alter table public.jobs            enable row level security;
alter table public.ingestion_status enable row level security;

-- No policies on source_posts / ingestion_status: only the ingestion service
-- (postgres role, RLS-bypassing) can read them. The anon key gets nothing.

-- The website may read published jobs only.
drop policy if exists "anon read published jobs" on public.jobs;
create policy "anon read published jobs"
	on public.jobs for select
	to anon, authenticated
	using (status = 'published');

-- Writes go through the service role / postgres role only.
drop policy if exists "service insert jobs" on public.jobs;
create policy "service insert jobs" on public.jobs for insert to service_role with check (true);
drop policy if exists "service update jobs" on public.jobs;
create policy "service update jobs" on public.jobs for update to service_role using (true);

drop policy if exists "service insert source_posts" on public.source_posts;
create policy "service insert source_posts" on public.source_posts for insert to service_role with check (true);
drop policy if exists "service update source_posts" on public.source_posts;
create policy "service update source_posts" on public.source_posts for update to service_role using (true);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
	new.updated_at = now();
	return new;
end;
$$;

drop trigger if exists jobs_set_updated_at on public.jobs;
create trigger jobs_set_updated_at
	before update on public.jobs
	for each row execute function public.set_updated_at();

drop trigger if exists ingestion_status_set_updated_at on public.ingestion_status;
create trigger ingestion_status_set_updated_at
	before update on public.ingestion_status
	for each row execute function public.set_updated_at();
