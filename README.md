# WhatsApp Job Ingestor

Reads a public WhatsApp channel, normalises every post into a structured job
record, and stores it in Supabase for the public job board.

The connector is **Baileys 7.0.0-rc14**. Everything this service does was
verified against the live WhatsApp server first — see
[`../LOCAL_TEST_RESULTS.md`](../LOCAL_TEST_RESULTS.md) for the feasibility
test and [`../whatsapp-channel-test/API_NOTES.md`](../whatsapp-channel-test/API_NOTES.md)
for the exact API ground truth.

---

## Two upstream defects you must know about

### 1. `newsletterFetchMessages` cannot read history (upstream #2555)

The stock method sends

```xml
<iq type="get" xmlns="newsletter" to="<channel jid>"><message_updates count="N"/></iq>
```

and the WhatsApp server **never answers it** — the query times out and
`waitForMessage` returns `undefined` rather than throwing, so the failure is
silent. Fixed upstream by commit `cc4c345`, not shipped in rc14.

This service therefore sends the WhatsApp-Web shaped request instead:

```xml
<iq type="get" to="s.whatsapp.net" xmlns="newsletter"><messages type="jid" jid="…" count="N"/></iq>
```

via the public `sock.query()` API, and parses the response the same way
upstream does. See `src/whatsapp/baileys-adapter.ts:fetchHistory`.

> If you later upgrade Baileys to a version that contains `cc4c345`, re-run
> the history test and then drop the local implementation.

### 2. `requestPairingCode` is rejected by the server

The phone-number pairing flow is answered with
`<error code="400" text="bad-request"/>`, so the code never becomes valid and
the phone reports *"Couldn't link device"*. **Use QR pairing**
(`npm run pair`).

---

## Operational requirements

| Requirement | Why | How it is handled |
|---|---|---|
| Re-subscribe to live updates every ~60 s | The server's live-update window is **90 s** (`subscribeNewsletterUpdates` returns `{ duration: "90" }`); without re-issuing, pushes stop silently | `LIVE_RESUBSCRIBE_SECONDS`, default 60 |
| Exactly one client per session | A second client on the same session is disconnected with status **440 conflict** | `connector.lease` table + `LEASE_TTL_SECONDS` |
| 515 is not fatal | 515 = `restartRequired`, the normal post-pairing signal; only **401**/**403** are terminal | handled in `baileys-adapter.ts` |
| Session must survive restarts | Render's filesystem is ephemeral | the session is stored **encrypted in Postgres** (`connector.session_keys` / `connector.session_creds`) |

---

## Layout

```text
src/
├── index.ts                     startup, wiring, graceful shutdown
├── config.ts                    environment validation
├── logging.ts                   redacted structured logging
├── whatsapp/
│   ├── connector.ts             the adapter interface (keep the rest connector-agnostic)
│   ├── baileys-adapter.ts       the Baileys implementation
├── ingest/
│   ├── normalize.ts             post -> job record (deterministic, no LLM)
│   ├── dedupe.ts                content hash + business-identity key
│   └── process-post.ts          transactional persistence, multi-role splitting
├── db/
│   ├── supabase.ts              pg pool
│   ├── repositories.ts          data access + single-writer lease
│   └── session-store.ts         encrypted, serialised, debounced session storage
└── health/
    └── server.ts                /health and /ready

supabase/migrations/             version-controlled schema
scripts/
├── pair.ts                      QR pairing (writes the session to the database)
├── import-session.ts            import a session from a local auth folder
└── create-db-access.sh          create the app role and write DATABASE_URL
tests/                           unit tests for the parsing and dedupe rules
```

---

## Setup

```bash
npm install
cp .env.example .env        # then fill it in
```

Required environment variables:

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | Postgres connection string (Supabase pooler) |
| `SESSION_ENCRYPTION_KEY` | 32 bytes, hex or base64 — encrypts the stored session |
| `WHATSAPP_CHANNEL_URL` | the channel to read |
| `HEALTH_PING_SECRET` | bearer token for `/health` (used by the Cloudflare Worker) |

Optional: `PORT`, `LOG_LEVEL`, `HISTORY_BATCH_SIZE`,
`HISTORY_BACKFILL_INTERVAL_MINUTES`, `LIVE_RESUBSCRIBE_SECONDS`,
`LEASE_TTL_SECONDS`, `INSTANCE_ID`.

### Database

```bash
supabase link --project-ref <ref>
supabase db push --linked
```

The schema lives in `supabase/migrations/`:

* `public.source_posts` — one row per source post (raw text, payload, hash)
* `public.jobs` — the normalised, publishable records
* `public.ingestion_status` — singleton health row
* `connector.session_creds`, `connector.session_keys` — the encrypted session
  (this schema is **not** exposed through PostgREST, so it is unreachable
  from the public API surface)
* `connector.lease` — the single-writer lease

Row Level Security: the anon role can only read `public.jobs` rows whose
status is `published`. `source_posts` and `ingestion_status` have no
policies and are therefore unreadable with the anon key.

### Pairing

```bash
npm run pair
```

Writes `./pairing-qr.png`; scan it in **WhatsApp → Settings → Linked devices
→ Link a device**. The session is saved to the database, so the service
starts without a QR afterwards.

To reuse a session that was paired locally with `useMultiFileAuthState`:

```bash
npx tsx scripts/import-session.ts <auth-folder>
```

### Run

```bash
npm run dev     # tsx watch
npm run build && npm start
```

---

## Behaviour

1. Restores the session from the database and connects.
2. Resolves the channel from `WHATSAPP_CHANNEL_URL`.
3. Backfills a bounded window of recent posts (default 25) and normalises
   them.
4. Subscribes to live updates and re-asserts the subscription every 60 s.
5. Every post — live or backfilled — goes through the same idempotent path:
   `source_posts` insert (unique on source + channel + message id) then the
   normalised `jobs` upsert (unique on the dedupe key).

### Normalisation rules

Deterministic and rule-based; nothing is inferred. The rules were derived
from the real posts in the target channel:

* `Company name:`, `Role:`, `Location:`, `Work mode:`, `Job type:`,
  `Eligibility:` / `Students eligible:`, `Experience:`, `Batch Eligible:`,
  `Salary:` / `CTC:`, `Last date:` / `Apply by:`
* An apply URL is taken from a line explicitly labelled `Apply Link:` /
  `Apply here:` / `Referral Link:` (any host), otherwise from a known job
  board or ATS host. A link back to the channel itself is never used.
* `Location: Remote (Work From Home)` is split into work mode + location.
* A post that advertises several openings — one line per role, each with its
  own link — produces **one job row per opening**.
* A post that yields no company *and* no title, or no apply URL, is stored
  as `needs_review` rather than published. Nothing is invented.

### Deduplication

* `content_hash` — sha256 of the normalised post text: catches an exact repost.
* `dedupe_key` — sha256 of company + title + location + batch years + apply
  URL: catches the same vacancy re-advertised with different wording. It is
  only produced when the identity is confident enough (a company plus a title
  or an apply URL).

---

## Endpoints

| Path | Auth | Purpose |
|---|---|---|
| `GET /health` | bearer token | liveness, used by the keep-alive Worker. Cheap: no history fetch, no database round trip |
| `GET /ready` | none | readiness: reports whether the WhatsApp socket is connected **and** the database is reachable. Returns 503 when not ready |

A running HTTP server with a dead WhatsApp socket is reported as **not
ready** — the keep-alive endpoint must not report health just because the
process is alive.

---

## Deployment notes (Render)

* Free web service: ~512 MB RAM, 0.1 CPU, no persistent disk, idle
  spin-down. The measured footprint is ~115 MB RSS and ~0 % CPU, so it fits.
* The filesystem is ephemeral, which is exactly why the session lives in the
  database.
* Set the secrets in the Render dashboard; never commit them.
* `render.yaml` at the repository root describes the service.
* The free tier may spin the service down when idle; the Cloudflare Worker
  in `../render-keepalive` pings `/health` every five minutes to reduce that.
  It is a convenience, not an uptime guarantee.
