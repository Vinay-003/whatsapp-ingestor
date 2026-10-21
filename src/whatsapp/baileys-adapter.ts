/**
 * Baileys implementation of the Connector interface.
 *
 * Everything here is grounded in the installed Baileys version and in the
 * behaviour observed during the local feasibility test. The three things that
 * differ from a naive implementation, and why:
 *
 * 1. HISTORY REQUEST SHAPE
 *    Baileys 7.0.0-rc14's `newsletterFetchMessages()` sends
 *      <iq type="get" xmlns="newsletter" to="<channel jid>">
 *        <message_updates count="N"/>
 *      </iq>
 *    and the WhatsApp server never answers it (the query silently times out
 *    and returns `undefined`). This is upstream issue #2555, fixed by commit
 *    cc4c345 but not shipped in rc14. The working shape is
 *      <iq type="get" to="s.whatsapp.net" xmlns="newsletter">
 *        <messages type="jid" jid="<channel jid>" count="N"/>
 *      </iq>
 *    sent through the public `sock.query()` API. `fetchHistory` below uses the
 *    working shape and parses the response the same way upstream does.
 *
 * 2. LIVE UPDATES
 *    There is no dedicated "channel post" event. A post arrives as a
 *    `notification` node with attrs.type === 'newsletter'; Baileys routes it
 *    to `upsertMessage(msg, 'append')`, so it shows up on the standard
 *    `messages.upsert` event. We filter on the newsletter JID so ordinary
 *    chat traffic can never be mistaken for a post.
 *    The server's live-update window is ~90 seconds, so the subscription must
 *    be re-issued (see `refreshSubscription`).
 *
 * 3. RECONNECT SEMANTICS
 *    Status 515 (restartRequired) is the NORMAL response after pairing and
 *    must be retried. Only 401 and 403 are terminal.
 */

import { makeWASocket, proto, DisconnectReason } from '@whiskeysockets/baileys';
import type { BaileysEventMap, WASocket } from '@whiskeysockets/baileys';
import { getBinaryNodeChild, getBinaryNodeChildren, S_WHATSAPP_NET } from '@whiskeysockets/baileys/lib/WABinary/index.js';
import { isJidNewsletter } from '@whiskeysockets/baileys/lib/WABinary/jid-utils.js';
import { initAuthCreds } from '@whiskeysockets/baileys/lib/Utils/auth-utils.js';

import type { ChannelInfo, Connector, ConnectorEvents, ConnectorStatus, SourcePost } from './connector.js';
import type { SupabaseSessionStore } from '../db/session-store.js';
import { log, errorMessage, errorCode, preview } from '../logging.js';

export type BaileysAdapterOptions = {
	events: ConnectorEvents;
	store: SupabaseSessionStore;
	/** Called when the connector needs to be restarted (e.g. re-pair). */
	onFatal?: (reason: string) => void;
};

type ParsedMessage = {
	id?: string;
	serverId?: string;
	timestamp?: number;
	text?: string;
	meta: Record<string, unknown>;
};

/**
 * Baileys logs protocol frames at trace/debug level, which is not acceptable
 * here. The library's own logger interface is used, but every method is a
 * no-op; the service's redacted logger is the single source of truth.
 */
function silentLogger() {
	const mk = () => ({
		level: 'silent',
		child: mk,
		trace: () => {},
		debug: () => {},
		info: () => {},
		warn: () => {},
		error: () => {}
	});
	return mk();
}

export class BaileysAdapter implements Connector {
	private sock: WASocket | null = null;
	private readonly options: BaileysAdapterOptions;
	private channelId: string | null = null;
	/** Every newsletter chat the linked device knows about, and its name. */
	private newsletterChats = new Map<string, string | null>();
	/** True once the app-state sync has reported completion. */
	private historySyncComplete = false;
	private connectedAt: string | null = null;
	private lastMessageAt: string | null = null;
	private reconnects = 0;
	private stopping = false;
	private restartTimer: NodeJS.Timeout | null = null;
	/** Resolves when the socket first reaches the `open` state. */
	private readyResolve: (() => void) | null = null;
	private readyPromise: Promise<void>;
	private readyReject: ((err: Error) => void) | null = null;

	constructor(options: BaileysAdapterOptions) {
		this.options = options;
		this.readyPromise = new Promise<void>((resolve, reject) => {
			this.readyResolve = resolve;
			this.readyReject = reject;
		});
		// The promise is only awaited explicitly; avoid an unhandled rejection.
		this.readyPromise.catch(() => undefined);
	}

	/**
	 * Wait until the socket is connected.
	 * The mex queries (channel resolution) need an open connection, and the
	 * `connection: 'open'` event only fires after a successful login.
	 */
	async waitUntilConnected(timeoutMs = 180_000): Promise<void> {
		await Promise.race([
			this.readyPromise,
			new Promise<void>((_, reject) =>
				setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms waiting for the connector`)), timeoutMs)
			)
		]);
	}

	// ------------------------------------------------------------------ start

	async start(): Promise<void> {
		const store = this.options.store;

		let creds = await store.loadCreds();
		if (!creds) {
			creds = initAuthCreds();
			log.warn('connector_no_session', { detail: 'starting a fresh session; a QR scan is required' });
		}

		const sock = makeWASocket({
			auth: { creds, keys: store as never },
			logger: silentLogger(),
			browser: ['Chrome (120)', 'Desktop', 'Ubuntu'],
			markOnlineOnConnect: false,
			// The phone's chat history is not needed — channel posts come from
			// the newsletter APIs.
			//
			// The app-state sync MUST stay enabled though: it is the only way
			// the device learns which channels the account follows, and Baileys
			// warns that disabling all sync leads to session instability.
			// Only the FULL message-history type is filtered out.
			shouldSyncHistoryMessage: ({ syncType }) => syncType !== proto.HistorySync.HistorySyncType.FULL
		});
		this.sock = sock;

		sock.ev.on('creds.update', () => {
			// Persist credentials; the store serialises the writes.
			void store.saveCreds(sock.authState.creds).catch(err => {
				log.error('connector_creds_save_failed', { error: errorMessage(err) });
			});
		});

		sock.ev.on('connection.update', update => {
			void this.handleConnectionUpdate(update);
		});

		sock.ev.on('messages.upsert', ({ messages, type }) => {
			void this.handleUpsert(messages, type);
		});

		// The followed-channel list arrives through app-state sync.
		const noteChat = (id?: string | null, name?: string | null) => {
			if (!id || !isJidNewsletter(id)) return;
			if (!this.newsletterChats.has(id)) this.newsletterChats.set(id, name ?? null);
			else if (name && !this.newsletterChats.get(id)) this.newsletterChats.set(id, name);
		};
		sock.ev.on('chats.upsert', chats => {
			for (const chat of chats ?? []) {
				noteChat(chat.id, chat.name ?? null);
			}
		});
		sock.ev.on('chats.update', updates => {
			for (const update of updates ?? []) {
				noteChat(update.id, update.name ?? null);
			}
		});
		// The app-state sync delivers the chat list in 'messaging-history.set'.
		// Baileys' event buffer absorbs a matching 'chats.upsert' into that
		// history set, so the channel list has to be read from both places.
		sock.ev.on('messaging-history.set', payload => {
			for (const chat of payload?.chats ?? []) {
				noteChat(chat?.id, (chat as { name?: string | null })?.name ?? null);
			}
		});
		// The app-state sync reports when it is complete; until then the chat
		// list is only partially delivered.
		sock.ev.on('messaging-history.status', status => {
			if (status?.status === 'complete') this.historySyncComplete = true;
		});
	}

	private async handleConnectionUpdate(update: Partial<BaileysEventMap['connection.update']>): Promise<void> {
		if (update.connection === 'open') {
			this.connectedAt = new Date().toISOString();
			log.info('connector_connected', { channelId: this.channelId, reconnects: this.reconnects });
			this.readyResolve?.();
			await this.options.events.onStatus(this.status());
		}
		if (update.connection === 'close' && update.lastDisconnect) {
			const status = errorCode(update.lastDisconnect.error);
			log.warn('connector_disconnected', { status, error: errorMessage(update.lastDisconnect.error) });
			await this.options.events.onStatus(this.status());
			if (this.stopping) return;
			// 401 loggedOut and 403 forbidden are terminal. 515 restartRequired
			// is the expected post-pairing signal and must be retried.
			if (status === '401' || status === '403') {
				this.readyReject?.(new Error(`session rejected by WhatsApp (status ${status})`));
				this.options.onFatal?.(`session rejected by WhatsApp (status ${status})`);
				return;
			}
			this.reconnects += 1;
			const delay = Math.min(30_000, 2_000 * this.reconnects) + Math.floor(Math.random() * 1000);
			log.info('reconnect_attempt', { attempt: this.reconnects, delayMs: delay, status });
			if (this.restartTimer) clearTimeout(this.restartTimer);
			this.restartTimer = setTimeout(() => {
				this.restartTimer = null;
				void this.reconnect();
			}, delay);
			this.restartTimer.unref?.();
		}
	}

	/** Tear down the socket and build a new one from the persisted session. */
	private async reconnect(): Promise<void> {
		try {
			await this.sock?.end(undefined);
		} catch {
			/* ignore */
		}
		this.sock = null;
		try {
			await this.start();
		} catch (err) {
			log.error('connector_restart_failed', { error: errorMessage(err) });
		}
	}

	// ------------------------------------------------------------------- stop

	async stop(): Promise<void> {
		this.stopping = true;
		if (this.restartTimer) {
			clearTimeout(this.restartTimer);
			this.restartTimer = null;
		}
		try {
			await this.sock?.end(undefined);
		} catch {
			/* ignore */
		}
		this.sock = null;
	}

	// ------------------------------------------------------------- resolution

	async resolveChannel(urlOrInvite: string): Promise<ChannelInfo | null> {
		if (!this.sock) throw new Error('connector not started');
		const invite = this.extractInvite(urlOrInvite);
		const candidates: { type: 'invite' | 'jid'; key: string }[] = [];
		if (invite) {
			candidates.push({ type: 'invite', key: invite });
			candidates.push({ type: 'jid', key: `${invite}@newsletter` });
		} else {
			candidates.push({ type: 'jid', key: urlOrInvite });
		}

		for (const candidate of candidates) {
			try {
				const meta = await this.sock.newsletterMetadata(candidate.type, candidate.key);
				if (!meta?.id) continue;
				const thread = (meta as unknown as { thread_metadata?: Record<string, unknown> }).thread_metadata ?? {};
				const name = thread.name as { text?: string } | undefined;
				const info: ChannelInfo = {
					id: meta.id,
					name: name?.text ?? null,
					invite: (thread.invite as string | undefined) ?? null,
					subscribers: thread.subscribers_count ? Number(thread.subscribers_count) : null,
					verification: (thread.verification as string | undefined) ?? null
				};
				this.channelId = info.id;
				log.info('channel_resolved', {
					channelId: info.id,
					name: info.name,
					invite: info.invite,
					subscribers: info.subscribers,
					verification: info.verification
				});
				return info;
			} catch (err) {
				log.debug('channel_resolve_attempt_failed', { form: candidate.type, error: errorMessage(err) });
			}
		}
		return null;
	}

	private extractInvite(input: string): string | null {
		const match = String(input).match(/^https?:\/\/(?:www\.)?whatsapp\.com\/channel\/([^/?#]+)/i);
		if (match) return decodeURIComponent(match[1]!);
		if (String(input).endsWith('@newsletter')) return null;
		return /^[0-9A-Za-z]+$/.test(input) ? input : null;
	}

	// ---------------------------------------------------------------- history

	/**
	 * Fetch a page of posts using the WhatsApp-Web-shaped request.
	 *
	 * `before` is the sequential post id (`server_id`) of the OLDEST post the
	 * caller already holds. Passing it returns the next, older page. The
	 * response is ordered oldest-first, so the cursor for the next page is
	 * the FIRST element of this page, not the last.
	 *
	 * `count` is capped by the server at 200; a larger value is silently
	 * answered with an empty page.
	 */
	async fetchHistory(channelId: string, count: number, before?: string | null): Promise<SourcePost[]> {
		if (!this.sock) throw new Error('connector not started');
		const attrs: Record<string, string> = { type: 'jid', jid: channelId, count: String(count) };
		if (before) attrs.before = before;

		const result = await this.sock.query({
			tag: 'iq',
			attrs: { id: this.sock.generateMessageTag(), type: 'get', to: S_WHATSAPP_NET, xmlns: 'newsletter' },
			content: [{ tag: 'messages', attrs }]
		});

		const messagesNode = getBinaryNodeChild(result, 'messages');
		const nodes = getBinaryNodeChildren(messagesNode, 'message');
		return nodes.map(node => this.parseMessage(node)).map(p => this.toSourcePost(p));
	}

	/**
	 * Walk backwards through a channel's entire history.
	 *
	 * The server answers at most 200 posts per request, and the `before`
	 * cursor is the only pagination mechanism that works. Pages are ordered
	 * oldest-first, so the cursor is the first post of the page just read.
	 */
	async fetchAllHistory(
		channelId: string,
		options: { pageSize?: number; maxPages?: number } = {}
	): Promise<{ posts: SourcePost[]; pages: number; exhausted: boolean }> {
		const pageSize = Math.min(options.pageSize ?? 200, 200);
		const maxPages = options.maxPages ?? 60;
		const posts: SourcePost[] = [];
		const seen = new Set<string>();
		let cursor: string | null = null;
		let pages = 0;
		let exhausted = false;

		for (let page = 0; page < maxPages; page++) {
			const batch = await this.fetchHistory(channelId, pageSize, cursor);
			pages += 1;
			if (!batch.length) {
				exhausted = true;
				break;
			}
			let added = 0;
			for (const post of batch) {
				const key = post.serverId ?? post.messageId;
				if (seen.has(key)) continue;
				seen.add(key);
				posts.push(post);
				added += 1;
			}
			// The cursor is the OLDEST post of the page (the first element).
			const oldest = batch[0];
			cursor = oldest?.serverId ?? null;
			if (!cursor || added === 0) {
				exhausted = true;
				break;
			}
		}

		return { posts, pages, exhausted };
	}

	private parseMessage(node: {
		attrs?: Record<string, string | undefined>;
		content?: unknown;
	}): ParsedMessage {
		const attrs = node.attrs ?? {};
		const plaintext = getBinaryNodeChild(node as never, 'plaintext');
		const meta = getBinaryNodeChild(node as never, 'meta');
		const views = getBinaryNodeChild(node as never, 'views_count');
		const forwards = getBinaryNodeChild(node as never, 'forwards_count');
		const responses = getBinaryNodeChild(node as never, 'responses_count');
		const reactionsNode = getBinaryNodeChild(node as never, 'reactions');
		const rcat = getBinaryNodeChild(node as never, 'rcat');

		let text: string | undefined;
		if (plaintext?.content instanceof Uint8Array) {
			try {
				const decoded = proto.Message.decode(plaintext.content).toJSON();
				text = decoded.conversation ?? decoded.extendedTextMessage?.text ?? undefined;
			} catch {
				text = undefined;
			}
		}

		const reactions = reactionsNode
			? getBinaryNodeChildren(reactionsNode, 'reaction').map(r => ({
					code: r.attrs.code,
					count: r.attrs.count ? Number(r.attrs.count) : 0
				}))
			: [];

		return {
			id: attrs.id,
			serverId: attrs.server_id,
			timestamp: attrs.t ? Number(attrs.t) : undefined,
			text,
			meta: {
				type: attrs.type ?? null,
				views: views?.attrs?.count ? Number(views.attrs.count) : undefined,
				forwards: forwards?.attrs?.count ? Number(forwards.attrs.count) : undefined,
				responses: responses?.attrs?.count ? Number(responses.attrs.count) : undefined,
				reactions,
				editTimestamp: meta?.attrs?.msg_edit_t ? Number(meta.attrs.msg_edit_t) : undefined,
				originalTimestamp: meta?.attrs?.original_msg_t ? Number(meta.attrs.original_msg_t) : undefined,
				hasMedia: !!rcat
			}
		};
	}

	private toSourcePost(p: ParsedMessage): SourcePost {
		const messageId = p.id ?? p.serverId ?? `${p.timestamp ?? 0}`;
		return {
			messageId,
			serverId: p.serverId ?? null,
			timestamp: p.timestamp ? new Date(p.timestamp * 1000).toISOString() : null,
			text: p.text ?? '',
			meta: p.meta
		};
	}

	// ------------------------------------------------------------------ live

	async subscribe(channelId: string): Promise<void> {
		if (!this.sock) throw new Error('connector not started');
		try {
			await this.sock.newsletterFollow(channelId);
			log.info('newsletter_followed', { channelId });
		} catch (err) {
			log.warn('newsletter_follow_failed', { channelId, error: errorMessage(err) });
		}
		await this.refreshSubscription(channelId);
	}

	/** Re-assert the live subscription. The server window is ~90 seconds. */
	async refreshSubscription(channelId: string): Promise<void> {
		if (!this.sock) throw new Error('connector not started');
		try {
			const result = await this.sock.subscribeNewsletterUpdates(channelId);
			log.debug('newsletter_subscribed', { channelId, duration: result?.duration ?? null });
		} catch (err) {
			log.warn('newsletter_subscribe_failed', { channelId, error: errorMessage(err) });
		}
	}

	/**
	 * Discover the channels this account follows.
	 *
	 * The linked device learns about followed channels through the app-state
	 * sync, which arrives in chunks. The list is only complete once the sync
	 * reports completion, so this waits for that (with a timeout) and returns
	 * whatever it has.
	 */
	async listChannels(timeoutMs = 60_000): Promise<string[]> {
		if (!this.sock) throw new Error('connector not started');
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (this.historySyncComplete) break;
			// The chat list can also arrive through 'chats.upsert' without a
			// status event, so give it a moment before giving up.
			if (this.newsletterChats.size > 0 && Date.now() > deadline - timeoutMs + 8000) break;
			await new Promise(r => setTimeout(r, 500));
		}
		log.info('channels_discovered', { count: this.newsletterChats.size, syncComplete: this.historySyncComplete });
		return [...this.newsletterChats.keys()];
	}

	/** Every newsletter chat the device has seen, with its chat-side name. */
	seenChannels(): { id: string; chatName: string | null }[] {
		return [...this.newsletterChats.entries()].map(([id, chatName]) => ({ id, chatName }));
	}

	private async handleUpsert(messages: unknown[], type: string | undefined): Promise<void> {
		for (const raw of messages ?? []) {
			const msg = raw as {
				key?: { remoteJid?: string; id?: string; fromMe?: boolean };
				message?: { conversation?: string; extendedTextMessage?: { text?: string } };
				messageTimestamp?: number;
			};
			const jid = msg.key?.remoteJid;
			if (!jid || !isJidNewsletter(jid)) continue; // ordinary chat traffic
			// Accept a post from any newsletter the device follows. A channel
			// we have not seen before is still forwarded, so it can be
			// registered on the fly.
			this.newsletterChats.set(jid, this.newsletterChats.get(jid) ?? null);

			const text = msg.message?.conversation ?? msg.message?.extendedTextMessage?.text ?? '';
			const post: SourcePost = {
				messageId: msg.key?.id ?? `${msg.messageTimestamp ?? 0}`,
				serverId: null,
				timestamp: msg.messageTimestamp ? new Date(msg.messageTimestamp * 1000).toISOString() : null,
				text,
				meta: { upsertType: type, fromMe: msg.key?.fromMe ?? false, live: true }
			};
			this.lastMessageAt = new Date().toISOString();
			log.info('message_received', {
				channelId: jid,
				messageId: post.messageId,
				timestamp: post.timestamp,
				upsertType: type,
				textPreview: preview(text, 80)
			});
			await this.options.events.onPost(post);
		}
	}

	// ---------------------------------------------------------------- status

	status(): ConnectorStatus {
		return {
			connected: this.connectedAt !== null && this.sock !== null,
			channelId: this.channelId,
			lastMessageAt: this.lastMessageAt,
			connectedAt: this.connectedAt,
			reconnects: this.reconnects
		};
	}
}

export { DisconnectReason };
