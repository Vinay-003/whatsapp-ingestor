-- Least-privilege login role for the ingestion service.
--
-- The real password is set by scripts/create-db-access.sh, which writes a
-- separate, gitignored migration for it. Never put a password in a file that
-- is committed.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'ingestor_app') then
    create role ingestor_app with login password 'set-by-create-db-access';
  end if;
end
$$;

grant usage on schema public, connector to ingestor_app;
grant select, insert, update, delete on all tables in schema public to ingestor_app;
grant select, insert, update, delete on all tables in schema connector to ingestor_app;
grant usage, select on all sequences in schema public to ingestor_app;
