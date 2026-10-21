-- 007_keepalive_auth.sql
-- Fixes the keep-alive probe: the Authorization header was built but never
-- passed to net.http_post, so a configured shared secret was ignored.
--
-- Behaviour:
--   secret set   -> the stored url is called with the bearer token
--                   (use .../health, which requires it)
--   secret empty -> the stored url is called without a header
--                   (use .../healthz, the public liveness endpoint)
create or replace function connector.ping_render()
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
	cfg      connector.keepalive%rowtype;
	headers  jsonb := jsonb_build_object('Content-Type', 'application/json');
begin
	select * into cfg from connector.keepalive where id = 'render' and enabled;
	if not found then
		return;
	end if;

	if cfg.secret is not null and cfg.secret <> '' then
		headers := headers || jsonb_build_object('Authorization', 'Bearer ' || cfg.secret);
	end if;

	perform net.http_post(
		url     := cfg.url,
		headers := headers,
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
