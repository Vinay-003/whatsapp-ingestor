# Installed Library API — Ground Truth (verified against the live server)

**Library:** `@whiskeysockets/baileys` **7.0.0-rc14** (npm `latest` dist-tag;
`legacy` = 6.7.24). Installed at `whatsapp-channel-test/node_modules/@whiskeysockets/baileys`.
**Node:** v24.14.1 · **OS:** Linux x64 · **Target channel:** `Krishan Kumar - Jobs & Internships Updates`

Everything below was read from the *installed* package and then confirmed
against the live WhatsApp server. Where the installed library is wrong, that is
called out explicitly.

---

## 1. Channel/newsletter read API

Declared in `lib/Socket/newsletter.d.ts` (impl `lib/Socket/newsletter.js`).

| Method | Signature | Source | Live result |
|---|---|---|---|
| `newsletterMetadata` | `(type: "invite" \| "jid", key) => Promise<NewsletterMetadata \| null>` | `newsletter.d.ts:9` | **works** (invite-code form) |
| `newsletterFetchMessages` | `(jid, count, since, after) => Promise<any>` | `newsletter.d.ts:19` | **BROKEN** — see §1.2 |
| `subscribeNewsletterUpdates` | `(jid) => Promise<{ duration: string } \| null>` | `newsletter.d.ts:20` | **works**, `duration = 90` |
| `newsletterFollow` | `(jid) => Promise<unknown>` | `newsletter.d.ts:10` | **works** (mex `xwa2_newsletter_join_v2`) |
| `newsletterUnfollow` | `(jid) => Promise<unknown>` | `newsletter.d.ts:11` | not exercised |
| `newsletterSubscribers` | `(jid) => Promise<{ subscribers: number }>` | `newsletter.d.ts:6` | not exercised |
| `newsletterReactMessage` | `(jid, serverId, reaction?) => Promise<void>` | `newsletter.d.ts:18` | works (used as transport probe) |
| `newsletterMetadata` response shape | `NewsletterMetadata` | `lib/Types/Mex.d.ts:115` | see §1.3 |

All of these exist on the socket returned by the default export
`makeWASocket` (confirmed `lib/Socket/index.d.ts:97-117`).

### 1.1 Resolving a channel — CONFIRMED WORKING

`newsletterMetadata` is a **mex query** (`QueryIds.METADATA` +
`XWAPaths.xwa2_newsletter_metadata` = `"xwa2_newsletter"`,
`lib/Socket/newsletter.js:68-79`). Request body:

```
{ fetch_creation_time: true, fetch_full_image: true, fetch_viewer_metadata: true,
  input: { key, type: type.toUpperCase() } }     // "INVITE" | "JID"
```

Live result — invite code resolved on the **first attempt**:

```
newsletterMetadata('invite', '0029Va6I79K60eBfQ92DwH0W')
  -> { id: '120363184225204114@newsletter',
       thread_metadata: { name: {text: 'Krishan Kumar - Jobs & Internships Updates'},
                          description: {text: '...'}, invite: '0029Va6I79K60eBfQ92DwH0W',
                          creation_time: '1695898620', subscribers_count: '311076',
                          verification: 'UNVERIFIED', picture, preview, settings,
                          handle, subscribers_count } }
```

Fallback chain used by the test (nothing hard-coded): **invite-code → full
URL → `<code>@newsletter`** (`src/lib/newsletter.js:resolveChannel`).

### 1.2 Fetching history — THE INSTALLED LIBRARY IS BROKEN HERE

`newsletterFetchMessages` in 7.0.0-rc14 sends (`lib/Socket/newsletter.js:124-150`):

```xml
<iq type="get" xmlns="newsletter" to="<CHANNEL JID>">
  <message_updates count="N" [since=] [after=] />
</iq>
```

**The WhatsApp server never answers this.** Measured directly:

* The request is sent; the only IQ results that come back are the server's
  30-second keepalive pings (`<iq type="result" t=…/>` with no children).
* The query therefore hits Baileys' 60 s `defaultQueryTimeoutMs`
  (`lib/Defaults/index.js:56`) and `waitForMessage` returns `undefined`
  (`lib/Socket/socket.js:86-119` catches the timeout and returns undefined
  instead of throwing) — so the caller gets `undefined`, **not** an error.
* Log line: `warn | timed out waiting for message | {"msgId":"…-8"}`.

This is upstream **Baileys issue #2555** ("newsletterFetchMessages returns no
message, and timeouts"), fixed by commit
`cc4c34585b317358e3c53486893fb59d6498014c` (2026-06-05), which is **not** in
7.0.0-rc14. The fix states the request must be WhatsApp-Web shaped:

```xml
<iq type="get" to="s.whatsapp.net" xmlns="newsletter">
  <messages type="jid" jid="<CHANNEL JID>" count="N" [before=] [after=] />
</iq>
```

i.e. addressed to the **server** (not the channel) and using the `<messages>`
element, not `<message_updates>`.

**Verified against the live server** (all via the public `sock.query()` API):

| Variant | Request | Live result |
|---|---|---|
| A | installed library shape (`<message_updates>` to channel jid) | **timeout, no response** |
| B | `<message_updates>` to `@s.whatsapp.net` | timeout |
| C | `xmlns="w:newsletter"` | timeout |
| D | `<message_updates count since="0">` | timeout |
| E | bare `<iq type="get" xmlns="newsletter">`, no content | timeout |
| F | `<iq type="set" xmlns="newsletter"><live_updates/></iq>` to channel jid | **OK in 409 ms** → `<live_updates duration=…>` |
| **G** | **`<iq type="get" to="s.whatsapp.net" xmlns="newsletter"><messages type="jid" jid count/></iq>`** | **OK — 15 posts in 296 ms** |

Variant G is implemented in `src/lib/newsletter.js:fetchNewsletterMessages`
together with the upstream response parsing
(`parseFetchedNewsletterMessage`): `<plaintext>` → `proto.Message`,
`views_count`, `forwards_count`, `responses_count`, `reactions`, `votes`,
`meta/msg_edit_t`, `meta/original_msg_t`, `rcat`.

Note `S_WHATSAPP_NET` in this version is the string `"@s.whatsapp.net"`
(`lib/WABinary/index.js`).

### 1.3 Response shape (live)

```
<iq type="result">
  <messages jid="…">
    <message server_id="2959" id="ACE21EC2E0F6D7B5E8FC76EBA7ECA6C0" type="text" t="1759927858">
      <forwards_count count="722"/>
      <reactions><reaction code="…" count="4"/>…</reactions>
      <plaintext>{proto.Message bytes}</plaintext>
    </message>
    …
  </messages>
</iq>
```

* `server_id` — small sequential integer, **stable across repeated fetches**,
  ideal dedupe cursor. Observed `2959 … 2973`.
* `id` — 32-char hex message id, also stable.
* `t` — unix seconds.
* `type` — `"text"` (one sampled post was `"media"`).
* `<plaintext>` decodes to a normal `proto.Message`; text arrives in
  `conversation`, links are preserved verbatim in the body.

### 1.4 Live updates — how channel posts actually arrive

There is **no dedicated "new channel post" event** in this version.

* `BaileysEventMap` (`lib/Types/Events.d.ts`) contains only
  `newsletter.reaction` (:132), `newsletter.view` (:141),
  `newsletter-participants.update` (:146), `newsletter-settings.update` (:153)
  — none of which carries post content.
* A live channel post arrives as a `notification` node with
  `attrs.type === 'newsletter'`, whose `<message>` child carries a
  `<plaintext>` payload. `handleNotification` dispatches it at
  `lib/Socket/messages-recv.js:802` → `handleNewsletterNotification`
  (:273-355) → `upsertMessage(fullMessage, 'append')`.
* Therefore a post surfaces on the **standard `messages.upsert` event with
  `type: 'append'`**, with `key.remoteJid = <jid>@newsletter`,
  `key.id = message_id || server_id`, `key.fromMe = false`,
  `messageTimestamp = Number(child.attrs.t)`.
* Live-confirmed server push: `notification` node, `attrs.type="newsletter"`,
  child tags `["live_updates"]` (subscription acknowledgement).

### 1.5 Distinguishing channel posts from ordinary chat messages

`isJidNewsletter(jid)` — `lib/WABinary/jid-utils.js:75`:
`jid?.endsWith('@newsletter')`.

The test filters on `isJidNewsletter(msg.key.remoteJid)` **and**
`msg.key.remoteJid === <resolved channel jid>`, and counts every discarded
non-newsletter upsert, so chat traffic can never be mistaken for a post.

### 1.6 Subscription mechanics (important for production)

* `newsletterFollow(jid)` → mex `xwa2_newsletter_join_v2` — makes the account
  a subscriber. Works. The server confirms with a `notification` node
  `attrs.type="mex"`, child `<update>`.
* `subscribeNewsletterUpdates(jid)` → `<iq type="set" xmlns="newsletter">`
  with `<live_updates/>`; returns `{ duration: "90" }` — a **90-second
  server-side live-update window**. It must be **re-issued roughly every
  60 s** to keep receiving pushes, otherwise pushes stop.

---

## 2. Connection / auth API

| Item | Source | Live result |
|---|---|---|
| `makeWASocket(config)` — default export | `lib/index.d.ts` | works |
| `useMultiFileAuthState(folder)` → `{ state, saveCreds }` | `lib/Utils/use-multi-file-auth-state.d.ts` | works, 815 files written |
| `sock.ev.on('creds.update', saveCreds)` | standard pattern | works |
| `sock.ev.on('connection.update', …)` | `lib/Types/Events.d.ts:14` | works |
| QR is delivered as `connection.update` → `update.qr` | `lib/Socket/socket.js:721` | works |
| `printQRInTerminal` is **deprecated/removed** in v7 | `lib/Types/Socket.d.ts` | must render QR yourself |
| `qrTimeout` — QR lifetime (default 60 s first, 20 s after) | `lib/Socket/socket.js:709,723` | set to 240 s here |
| `requestPairingCode(phone, custom?)` | `lib/Socket/socket.js:596` | **server rejects it** — see §3 |
| `sock.ws.isOpen` | `lib/Socket/Client/websocket.d.ts` | raw transport flag |
| `sock.query(node, timeoutMs)` | `lib/Socket/socket.d.ts` | public, used to send custom IQs |
| `sock.generateMessageTag()` | `lib/Socket/socket.d.ts` | public |
| `DisconnectReason` (401 loggedOut, 403 forbidden, 408 timeout, 440 conflict, 515 restartRequired) | `lib/Types/index.d.ts:26-35` | all observed |

### 2.1 Gotcha: 515 is not fatal

After a successful pairing the server sends `stream:error code=515`
(`restartRequired`) and expects the client to restart the socket and log in
with the stored credentials. Treating 515 as fatal kills the session; it must
be retried. Only **401** and **403** are genuinely terminal.

### 2.2 Gotcha: 440 conflict means "another client is using this session"

Running two processes against the same `auth_info_baileys` folder produces
`Stream Errored (conflict)` / status 440. One process at a time.

---

## 3. Pairing-code path is broken in 7.0.0-rc14 (QR path is fine)

`sock.requestPairingCode('918619865958')` (digits + country code, as the
upstream README requires) is rejected by the server:

```
<iq type="error" id="…">
  <error code="400" text="bad-request"/>
</iq>
```

captured from the decrypted frame stream. Because the 8-character code is
generated **locally** by Baileys (`bytesToCrockford(randomBytes(5))`) and the
server never creates a pending request, the phone reports
*"Couldn't link device — check the phone number is correct"*. The phone number
format was correct; the stanza is rejected.

The **QR path is not affected**: the server accepted registration and issued
pairing refs with no error. QR pairing succeeded, and
`pairing configured successfully` → `stream:error 515` → restart → login →
`connection: 'open'`.

---

## 4. Test harness files

| File | Purpose |
|---|---|
| `src/lib/connect.js` | socket lifecycle, redacted logger, QR→PNG, auto-reconnect, exactly-once handler re-registration |
| `src/lib/newsletter.js` | channel resolution, **corrected history request (§1.2)**, response parsing, newsletter-JID detection, link extraction |
| `src/lib/redact.js` | phone/token redaction, error sanitisation, text preview |
| `pair.js` / `pair-code.js` / `diag-pairing.js` | pairing + protocol diagnostics |
| `exp-newsletter*.js` | the request-shape experiments of §1.2 |
| `test-a-auth-resolve.js` | Test A — auth + channel resolution |
| `test-b-history.js` | Test B — history, ID stability, pagination |
| `test-c-live.js` | Test C — live updates (+ Test E resource sampling) |
| `test-d1-restore.js` / `test-d2-network.js` + `run-test-d2.sh` | Test D — session restore, network outage, reconnect |
