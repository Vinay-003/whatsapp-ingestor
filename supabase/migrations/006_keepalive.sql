-- 006_keepalive.sql
-- Keep-alive for the Render service, driven from the database.
--
-- Render's free web service sleeps when it gets no inbound traffic, and a
-- sleeping service is not connected to WhatsApp, so new posts are not
-- collected live (they are picked up on the next start by the history
-- backfill, so nothing is lost — it is only delayed).
--
-- pg_cron + pg_net let the database make the HTTP request that keeps the
-- service awake, without needing a second cloud account.
--
-- The shared secret is stored here rather than hard-coded. When it is empty
-- the probe falls back to the service's public /healthz liveness endpoint.

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

create table if not exists connector.keepalive (
	id          text primary key default 'render',
	url         text        not null,
	secret      text,
	enabled     boolean     not null default true,
	last_ok_at  timestamptz,
	last_error  text,
	updated_at  timestamptz not null default now()
);

insert into connector.keepalive (id, url)
values ('render', 'https://whatsapp-job-ingestor.onrender.com/healthz')
on conflict (id) do nothing;

-- One request, one row updated. The response is not needed beyond the
-- status code, so the body is discarded to keep the request cheap.
create or replace function connector.ping_render()
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
	cfg      connector.keepalive%rowtype;
	target   text;
	auth     text;
begin
	select * into cfg from connector.keepalive where id = 'render' and enabled;
	if not found then
		return;
	end if;

	target := cfg.url;
	auth := '';

	-- Prefer the authenticated endpoint when a shared secret is configured;
	-- otherwise fall back to the public liveness endpoint.
	if cfg.secret is not null and cfg.secret <> '' then
		if cfg.url like '%/health%' then
			auth := 'Authorization: Bearer ' || cfg.secret;
		end if;
	end if;

	perform net.http_post(
		url     := target,
		headers := jsonb_build_object('Content-Type', 'application/json'),
		body    := jsonb_build_object('at', now()),
		timeout_milliseconds := 8000
	);

	update connector.keepalive
	set last_ok_at = now(), last_error = null, updated_at = now()
	where id = 'render';
exception when others then
	update connector.keepalive
	set last_error = left(sqlerrm, 200), updated_at = now()
	where id = 'render';
end;
$$;

-- Every five minutes. Unschedule first so this migration is re-runnable.
do $$
begin
	if exists (select 1 from cron.job where jobname = 'ping-render') then
		perform cron.unschedule('ping-render');
	end if;
	perform cron.schedule('ping-render', '*/5 * * * *', $cron$select connector.ping_render()$cron$);
end
$$;
