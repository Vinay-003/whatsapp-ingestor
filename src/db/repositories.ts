/**
 * Database access: pool, repositories and the single-writer lease.
 */

import { Pool } from 'pg';
import { log, errorMessage } from '../logging.js';

export function createPool(connectionString: string): Pool {
	const pool = new Pool({
		connectionString,
		max: 4,
		idleTimeoutMillis: 30_000,
		connectionTimeoutMillis: 15_000,
		ssl: { rejectUnauthorized: false }
	});
	pool.on('error', err => {
		log.error('db_pool_error', { error: errorMessage(err) });
	});
	return pool;
}

export type SourcePostRow = {
	id: string;
	source_name: string;
	source_channel_id: string;
	source_message_id: string;
	source_server_id: string | null;
	source_timestamp: string | null;
	raw_text: string;
	content_hash: string;
	processing_status: string;
	received_at: string;
};

export type JobRow = {
	id: string;
	source_post_id: string;
	title: string | null;
	company: string | null;
	location: string | null;
	work_mode: string | null;
	employment_type: string | null;
	eligibility: string | null;
	experience: string | null;
	batch_years: string | null;
	salary: string | null;
	description: string | null;
	apply_url: string | null;
	deadline: string | null;
	original_post_url: string | null;
	source_posted_at: string | null;
	status: string;
	dedupe_key: string | null;
	created_at: string;
	updated_at: string;
};

export type UpsertPostInput = {
	sourceName: string;
	channelId: string;
	messageId: string;
	serverId: string | null;
	timestamp: string | null;
	rawText: string;
	rawPayload: unknown;
	contentHash: string;
	status: string;
};

export type UpsertJobInput = {
	sourcePostId: string;
	title: string | null;
	company: string | null;
	location: string | null;
	workMode: string | null;
	employmentType: string | null;
	eligibility: string | null;
	experience: string | null;
	batchYears: string | null;
	salary: string | null;
	description: string | null;
	applyUrl: string | null;
	deadline: string | null;
	originalPostUrl: string | null;
	sourcePostedAt: string | null;
	status: string;
	dedupeKey: string | null;
};

export type ChannelRow = {
	id: string;
	name: string | null;
	invite: string | null;
	subscribers: number | null;
	verification: string | null;
	post_count: number;
	newest_post_at: string | null;
	oldest_post_at: string | null;
};

export class Repositories {
	constructor(private readonly pool: Pool) {}

	/** Insert or refresh a channel's metadata. */
	async upsertChannel(input: {
		id: string;
		name: string | null;
		invite: string | null;
		subscribers: number | null;
		verification: string | null;
	}): Promise<void> {
		await this.pool.query(
			`insert into public.channels (id, name, invite, subscribers, verification, last_seen_at, updated_at)
			 values ($1,$2,$3,$4,$5, now(), now())
			 on conflict (id) do update
			 set name = coalesce(excluded.name, public.channels.name),
					invite = coalesce(excluded.invite, public.channels.invite),
					subscribers = coalesce(excluded.subscribers, public.channels.subscribers),
					verification = coalesce(excluded.verification, public.channels.verification),
					last_seen_at = now(),
					updated_at = now()`,
			[input.id, input.name, input.invite, input.subscribers, input.verification]
		);
	}

	/** Update a channel's post statistics after a backfill. */
	async updateChannelStats(
		id: string,
		stats: { postCount: number; newestPostAt: string | null; oldestPostAt: string | null }
	): Promise<void> {
		await this.pool.query(
			`update public.channels
			 set post_count = greatest(post_count, $2),
					newest_post_at = coalesce(greatest(newest_post_at, $3), $3),
					oldest_post_at = coalesce(least(oldest_post_at, $4), $4),
					updated_at = now()
			 where id = $1`,
			[id, stats.postCount, stats.newestPostAt, stats.oldestPostAt]
		);
	}

	async listChannels(): Promise<ChannelRow[]> {
		const res = await this.pool.query<ChannelRow>(
			'select id, name, invite, subscribers, verification, post_count, newest_post_at, oldest_post_at from public.channels order by name'
		);
		return res.rows;
	}

	/**
	 * Insert a source post, ignoring duplicates.
	 * Returns the row id and whether the post was newly created.
	 */
	async upsertSourcePost(input: UpsertPostInput): Promise<{ id: string; created: boolean }> {
		const res = await this.pool.query<SourcePostRow>(
			`insert into public.source_posts
				(source_name, source_channel_id, source_message_id, source_server_id,
				 source_timestamp, raw_text, raw_payload, content_hash, processing_status)
			 values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
			 on conflict (source_name, source_channel_id, source_message_id) do nothing
			 returning id`,
			[
				input.sourceName,
				input.channelId,
				input.messageId,
				input.serverId,
				input.timestamp,
				input.rawText,
				JSON.stringify(input.rawPayload ?? null),
				input.contentHash,
				input.status
			]
		);
		if (res.rows[0]) return { id: res.rows[0].id, created: true };

		const existing = await this.pool.query<SourcePostRow>(
			`select id from public.source_posts
			 where source_name = $1 and source_channel_id = $2 and source_message_id = $3`,
			[input.sourceName, input.channelId, input.messageId]
		);
		const id = existing.rows[0]?.id;
		if (!id) throw new Error('source post upsert produced no id');
		return { id, created: false };
	}

	/** Update the processing status of a source post. */
	async setSourcePostStatus(id: string, status: string): Promise<void> {
		await this.pool.query('update public.source_posts set processing_status = $2 where id = $1', [id, status]);
	}

	/** Create or update the job attached to a source post. */
	async upsertJob(input: UpsertJobInput): Promise<{ id: string; created: boolean }> {
		if (input.dedupeKey) {
			const res = await this.pool.query<JobRow>(
				`insert into public.jobs
					(source_post_id, title, company, location, work_mode, employment_type,
					 eligibility, experience, batch_years, description, apply_url, deadline,
					 original_post_url, source_posted_at, status, dedupe_key)
				 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
				 on conflict (dedupe_key) where dedupe_key is not null do update
					set title = excluded.title,
						company = excluded.company,
						location = excluded.location,
						work_mode = excluded.work_mode,
						employment_type = excluded.employment_type,
						eligibility = excluded.eligibility,
						experience = excluded.experience,
						batch_years = excluded.batch_years,
						description = excluded.description,
						apply_url = excluded.apply_url,
						deadline = excluded.deadline,
						original_post_url = excluded.original_post_url,
						source_posted_at = excluded.source_posted_at,
						status = excluded.status,
						updated_at = now()
				 returning id`,
				[
					input.sourcePostId,
					input.title,
					input.company,
					input.location,
					input.workMode,
					input.employmentType,
					input.eligibility,
					input.experience,
					input.batchYears,
					input.description,
					input.applyUrl,
					input.deadline,
					input.originalPostUrl,
					input.sourcePostedAt,
					input.status,
					input.dedupeKey
				]
			);
			if (res.rows[0]) {
				const created = res.rows[0].source_post_id === input.sourcePostId;
				return { id: res.rows[0].id, created };
			}
		}

		const res = await this.pool.query<JobRow>(
			`insert into public.jobs
				(source_post_id, title, company, location, work_mode, employment_type,
				 eligibility, experience, batch_years, description, apply_url, deadline,
				 original_post_url, source_posted_at, status, dedupe_key)
			 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
			 returning id, source_post_id`,
			[
				input.sourcePostId,
				input.title,
				input.company,
				input.location,
				input.workMode,
				input.employmentType,
				input.eligibility,
				input.experience,
				input.batchYears,
				input.description,
				input.applyUrl,
				input.deadline,
				input.originalPostUrl,
				input.sourcePostedAt,
				input.status,
				input.dedupeKey
			]
		);
		const row = res.rows[0];
		if (!row) throw new Error('job insert produced no id');
		return { id: row.id, created: true };
	}

	/** Update the singleton ingestion status row. */
	async updateStatus(patch: Record<string, unknown>): Promise<void> {
		const allowed = new Set([
			'connector_status',
			'last_connected_at',
			'last_message_at',
			'last_success_at',
			'last_error_at',
			'last_error_code',
			'reconnect_count',
			'posts_ingested',
			'duplicates_skipped',
			'needs_review',
			'channel_id',
			'process_memory_mb',
			'process_uptime_s'
		]);
		const entries = Object.entries(patch).filter(([k]) => allowed.has(k));
		if (!entries.length) return;
		const sets = entries.map(([k], i) => `${k} = $${i + 1}`).join(', ');
		const values = entries.map(([, v]) => (v === undefined ? null : v));
		await this.pool.query(
			`update public.ingestion_status set ${sets}, updated_at = now() where id = 1`,
			values
		);
	}

	/**
	 * Atomically increment one of the counter columns.
	 * Done in SQL so concurrent writers cannot lose a count.
	 */
	async bumpCounter(column: 'posts_ingested' | 'duplicates_skipped' | 'needs_review', by = 1): Promise<void> {
		const allowed = ['posts_ingested', 'duplicates_skipped', 'needs_review'];
		if (!allowed.includes(column)) throw new Error(`not a counter column: ${column}`);
		await this.pool.query(
			`update public.ingestion_status set ${column} = ${column} + $1, updated_at = now() where id = 1`,
			[by]
		);
	}

	async readStatus(): Promise<Record<string, unknown> | null> {
		const res = await this.pool.query('select * from public.ingestion_status where id = 1');
		return (res.rows[0] as Record<string, unknown>) ?? null;
	}

	/**
	 * Acquire (or renew) the single-writer lease.
	 * Two ingestor instances sharing one WhatsApp session would knock each
	 * other off with status 440, so only one may run.
	 */
	async acquireLease(owner: string, ttlSeconds: number): Promise<boolean> {
		const res = await this.pool.query(
			`insert into connector.lease (id, owner, acquired_at, expires_at)
			 values ('ingestor', $1, now(), now() + ($2 || ' seconds')::interval)
			 on conflict (id) do update
			 set owner = excluded.owner,
					acquired_at = case when connector.lease.expires_at < now() then now() else connector.lease.acquired_at end,
					expires_at = excluded.expires_at
			 where connector.lease.expires_at < now() or connector.lease.owner = $1
			 returning id`,
			[owner, String(ttlSeconds)]
		);
		return (res.rowCount ?? 0) > 0;
	}

	async releaseLease(owner: string): Promise<void> {
		await this.pool.query('delete from connector.lease where id = $1 and owner = $2', ['ingestor', owner]);
	}
}
