-- The source posts carry a salary/CTC line, so the job record keeps it.
alter table public.jobs add column if not exists salary text;
