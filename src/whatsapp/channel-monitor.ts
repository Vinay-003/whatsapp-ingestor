/**
 * Channel monitor.
 *
 * Owns the whole channel lifecycle:
 *   1. discover the channels the linked account follows
 *   2. resolve and store each channel's metadata
 *   3. backfill the full available history of every channel
 *   4. keep a live subscription to each channel alive
 *   5. re-discover periodically, because the user can join new channels
 */

import type { Connector, SourcePost } from './connector.js';
import type { Repositories } from '../db/repositories.js';
import { PostProcessor } from '../ingest/process-post.js';
import { log, errorMessage } from '../logging.js';

export type ChannelMonitorOptions = {
	connector: Connector;
	repos: Repositories;
	processor: PostProcessor;
	/** How often to look for newly joined channels. */
	discoveryIntervalMinutes?: number;
	/** How often to re-read history (to pick up anything missed). */
	backfillIntervalMinutes?: number;
	/** How often to re-assert the live subscriptions. */
	resubscribeSeconds?: number;
	/** Maximum pages of history to read per channel per backfill. */
	maxHistoryPages?: number;
	/** Page size for the history request (the server accepts at most 200). */
	historyPageSize?: number;
	/** On a live post, which channel it came from. */
	onPost?: (post: SourcePost, channelId: string) => void | Promise<void>;
};

export class ChannelMonitor {
	private readonly options: ChannelMonitorOptions;
	private readonly known = new Map<string, { name: string | null; invite: string | null }>();
	private timers: NodeJS.Timeout[] = [];
	private stopped = false;

	constructor(options: ChannelMonitorOptions) {
		this.options = options;
	}

	/** Channels currently tracked, with their stored metadata. */
	channels(): { id: string; name: string | null; invite: string | null }[] {
		return [...this.known.entries()].map(([id, meta]) => ({ id, ...meta }));
	}

	/**
	 * Discover channels, register them, and backfill their history.
	 *
	 * The channel list is the union of:
	 *   - the channels already registered in the database, and
	 *   - any channel the device reports through the app state
	 *     ('chats.upsert' / 'messaging-history.set'), which is how a newly
	 *     joined channel is picked up.
	 *
	 * The server only pushes the full followed-channel list once per device
	 * registration, so the database is the durable source of truth and
	 * `scripts/add-channels.ts` is how a channel is added explicitly.
	 */
	async sync(options: { full?: boolean } = {}): Promise<void> {
		const { connector, repos, processor } = this.options;

		// 1. what the device knows about right now
		const ids = await connector.listChannels(30_000).catch(err => {
			log.warn('channel_discovery_failed', { error: errorMessage(err) });
			return [] as string[];
		});

		// 2. what we already know about
		const stored = await repos.listChannels().catch(() => []);
		const all = new Set<string>([...ids, ...stored.map(c => c.id)]);
		for (const channel of stored) {
			if (!this.known.has(channel.id)) {
				this.known.set(channel.id, { name: channel.name, invite: channel.invite });
			}
		}

		if (!all.size) {
			log.info('channel_discovery_empty', { hint: 'run scripts/add-channels.ts with a channel link' });
			return;
		}

		// 3. register + resolve metadata
		for (const id of all) {
			try {
				const meta = await connector.resolveChannel(id);
				const name = meta?.name ?? this.known.get(id)?.name ?? null;
				const invite = meta?.invite ?? this.known.get(id)?.invite ?? null;
				this.known.set(id, { name, invite });
				await repos.upsertChannel({
					id,
					name,
					invite,
					subscribers: meta?.subscribers ?? null,
					verification: meta?.verification ?? null
				});
			} catch (err) {
				log.warn('channel_resolve_failed', { channelId: id, error: errorMessage(err) });
			}
		}
		log.info('channels_registered', { count: this.known.size });

		// 4. backfill history
		for (const id of this.known.keys()) {
			await this.backfillChannel(id, options.full ?? false);
		}
	}

	/** Read the full available history of one channel and store it. */
	async backfillChannel(channelId: string, full = false): Promise<{ fetched: number; stored: number }> {
		const { connector, repos, processor } = this.options;
		const maxPages = full ? (this.options.maxHistoryPages ?? 60) : 1;
		try {
			const { posts, pages, exhausted } = await connector.fetchAllHistory(channelId, {
				pageSize: this.options.historyPageSize ?? 200,
				maxPages
			});
			const name = this.known.get(channelId)?.name ?? null;
			let stored = 0;
			let duplicates = 0;
			for (const post of posts) {
				const result = await processor.process(post, channelId, name);
				if (result.outcome === 'created' || result.outcome === 'needs_review') stored += 1;
				if (result.outcome === 'duplicate') duplicates += 1;
			}
			if (stored) await repos.bumpCounter('posts_ingested', stored).catch(() => undefined);
			if (duplicates) await repos.bumpCounter('duplicates_skipped', duplicates).catch(() => undefined);
			const timestamps = posts.map(p => p.timestamp).filter((t): t is string => !!t).sort();
			await repos.updateChannelStats(channelId, {
				postCount: posts.length,
				newestPostAt: timestamps[timestamps.length - 1] ?? null,
				oldestPostAt: timestamps[0] ?? null
			});
			log.info('channel_backfilled', {
				channelId,
				fetched: posts.length,
				stored,
				pages,
				exhausted
			});
			return { fetched: posts.length, stored };
		} catch (err) {
			log.warn('channel_backfill_failed', { channelId, error: errorMessage(err) });
			return { fetched: 0, stored: 0 };
		}
	}

	/** Subscribe to live updates for every known channel. */
	async subscribeAll(): Promise<void> {
		for (const id of this.known.keys()) {
			try {
				await this.options.connector.subscribe(id);
			} catch (err) {
				log.warn('channel_subscribe_failed', { channelId: id, error: errorMessage(err) });
			}
		}
	}

	/** Re-assert every live subscription (the server window is ~90 s). */
	async refreshSubscriptions(): Promise<void> {
		for (const id of this.known.keys()) {
			try {
				await this.options.connector.refreshSubscription(id);
			} catch {
				/* the next tick will try again */
			}
		}
	}

	/** Start the periodic jobs. */
	start(): void {
		const { discoveryIntervalMinutes = 30, backfillIntervalMinutes = 60, resubscribeSeconds = 60 } = this.options;

		const discovery = setInterval(() => {
			if (this.stopped) return;
			void this.sync({ full: false }).catch(err => log.warn('channel_sync_failed', { error: errorMessage(err) }));
		}, discoveryIntervalMinutes * 60_000);
		discovery.unref?.();

		const backfill = setInterval(() => {
			if (this.stopped) return;
			for (const id of this.known.keys()) {
				void this.backfillChannel(id, false);
			}
		}, backfillIntervalMinutes * 60_000);
		backfill.unref?.();

		const resubscribe = setInterval(() => {
			if (this.stopped) return;
			void this.refreshSubscriptions();
		}, resubscribeSeconds * 1000);
		resubscribe.unref?.();

		this.timers = [discovery, backfill, resubscribe];
	}

	stop(): void {
		this.stopped = true;
		for (const timer of this.timers) clearInterval(timer);
		this.timers = [];
	}
}
