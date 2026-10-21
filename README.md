# Job Board — public listings

Next.js site that serves the job listings collected by
[`../whatsapp-job-ingestor`](../whatsapp-job-ingestor).

Live at **https://jobs-site-omega.vercel.app**

---

## How it reads data

The public pages use the **anon** Supabase key only. Row Level Security is
the actual boundary:

* `public.jobs` — anon may read rows with `status = 'published'`
* `public.source_posts`, `public.ingestion_status` — no policies, so the
  anon key reads nothing
* the `connector` schema (session state) — not exposed through PostgREST at
  all, so it is not reachable from the API surface

The **service role** key is used only inside server-side route handlers
(the admin area). It must never reach a client component; it is not
prefixed with `NEXT_PUBLIC_` for exactly that reason.

## Pages

| Route | What it does |
|---|---|
| `/` | short introduction |
| `/jobs` | the listing with filters (search, company, location, work mode, batch) |
| `/jobs/[id]` | a single listing with all extracted fields and the apply link |
| `/admin` | moderation: publish, reject or expire a listing |

## Moderation

`/admin` is behind a shared password (`ADMIN_PASSWORD`). On success a
signed, httpOnly, same-site cookie is issued (8 h expiry, HMAC-signed so it
cannot be forged). Status changes go through
`PATCH /api/admin/jobs/:id`, which re-checks the cookie server-side and
only accepts `draft | published | expired | rejected`.

The ingestion service writes every new listing as `draft`, so nothing is
public until a moderator publishes it.

## Local development

```bash
npm install
cp .env.example .env.local   # fill in the values
npm run dev
```

| Variable | Where it runs | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | browser + server | project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | browser + server | safe to expose: RLS restricts it |
| `SUPABASE_SERVICE_ROLE_KEY` | server only | bypasses RLS — never expose |
| `ADMIN_PASSWORD` | server only | moderator password |

## Deployment

Deployed with the Vercel CLI:

```bash
vercel env add NEXT_PUBLIC_SUPABASE_URL production --value "..."
vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY production --type config --value "..."
vercel env add SUPABASE_SERVICE_ROLE_KEY production --value "..."
vercel env add ADMIN_PASSWORD production --value "..."
vercel deploy --prod
```

Vercel requires an explicit `--type config` for `NEXT_PUBLIC_*` variables
that look like credentials, even though the anon key is meant to be public.
