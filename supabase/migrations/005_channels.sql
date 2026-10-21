-- 005_channels.sql
-- One row per WhatsApp channel the account follows. The ingestion service
-- discovers them from the device's chat list, resolves their metadata and
-- stores every post it can read.
create table if not exists public.channels (
	id              text primary key,                    -- the @newsletter jid
	name            text,
	invite          text,
	subscribers     integer,
	verification    text,
	source          text        not null default 'whatsapp_channel',
	enabled         boolean     not null default true,
	post_count      integer     not null default 0,
	newest_post_at  timestamptz,
	oldest_post_at  timestamptz,
	last_seen_at    timestamptz not null default now(),
	first_seen_at   timestamptz not null default now(),
	updated_at      timestamptz not null default now()
);

create index if not exists channels_enabled_idx on public.channels (enabled, name);

-- The channel a post belongs to, denormalised onto the post so the public
-- site can list a channel's posts without a join.
alter table public.source_posts add column if not exists channel_name text;

alter table public.source_posts enable row level security;

-- The public site may read the channel directory. It contains no personal
-- data: a channel id, its public name and its subscriber count.
drop policy if exists "anon read channels" on public.channels;
create policy "anon read channels" on public.channels for select to anon, authenticated using (true);

drop policy if exists "service insert channels" on public.channels;
create policy "service insert channels" on public.channels for insert to service_role with check (true);
drop policy if exists "service update channels" on public.channels;
create policy "service update channels" on public.channels for update to service_role using (true);

-- Published raw posts are readable by the public site. Posts that the
-- ingestion service has not finished with (or that are still being
-- backfilled) stay hidden.
drop policy if exists "anon read processed posts" on public.source_posts;
create policy "anon read processed posts" on public.source_posts for select to anon, authenticated
	using (processing_status in ('processed', 'needs_review'));

drop policy if exists "service insert source_posts" on public.source_posts;
create policy "service insert source_posts" on public.source_posts for insert to service_role with check (true);
drop policy if exists "service update source_posts" on public.source_posts;
create policy "service update source_posts" on public.source_posts for update to service_role using (true);

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
	new.updated_at = now();
	return new;
end;
$$;

drop trigger if exists channels_set_updated_at on public.channels;
create trigger channels_set_updated_at
	before update on public.channels
	for each row execute function public.touch_updated_at();
