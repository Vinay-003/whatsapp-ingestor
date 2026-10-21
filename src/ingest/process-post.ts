/**
 * Post processing: source post -> normalized job(s) -> database.
 *
 * One source post can advertise several openings (each with its own
 * application link), so a post may produce several job rows that all point
 * back at the same source post.
 *
 * The whole unit runs inside one database transaction so a retry can never
 * leave a source post without its jobs, or a job without its source post.
 */

import type { Pool } from 'pg';
import type { Repositories } from '../db/repositories.js';
import type { SourcePost } from '../whatsapp/connector.js';
import { normalizePost, splitRoleEntries, type NormalizeOptions, type NormalizedJob } from './normalize.js';
import { contentHash, dedupeKey } from './dedupe.js';
import { log, errorMessage } from '../logging.js';

export type ProcessResult = {
	outcome: 'created' | 'updated' | 'duplicate' | 'needs_review' | 'failed';
	sourcePostId?: string;
	jobIds?: string[];
	reason?: string;
};

export type ProcessOptions = {
	sourceName?: string;
	originalPostUrl?: string;
	/** 'draft' keeps new jobs unpublished for moderation. */
	publishPolicy?: 'draft' | 'published';
	normalize?: NormalizeOptions;
};

/** A job candidate: the normalized record plus the role it came from. */
type Candidate = NormalizedJob & { roleTitle?: string | null; roleApplyUrl?: string | null };

export class PostProcessor {
	constructor(
		private readonly pool: Pool,
		private readonly repos: Repositories,
		private readonly options: ProcessOptions
	) {}

	async process(post: SourcePost, channelId: string, channelName?: string | null): Promise<ProcessResult> {
		const sourceName = this.options.sourceName ?? 'whatsapp_channel';
		const hash = contentHash({ text: post.text });
		const base = normalizePost(post.text, this.options.normalize ?? {});

		// Multi-opening posts: one row per advertised role.
		const roleEntries = splitRoleEntries(post.text);
		const candidates: Candidate[] =
			roleEntries.length >= 2
				? roleEntries.map(entry => ({
						...base,
						title: entry.title,
						apply_url: entry.applyUrl ?? base.apply_url,
						// The per-role link is the strongest signal.
						needsReview: base.needsReview && !entry.applyUrl,
						reviewReasons: entry.applyUrl
							? base.reviewReasons.filter(r => r !== 'no_apply_url')
							: base.reviewReasons
					}))
				: [base];

		const client = await this.pool.connect();
		try {
			await client.query('begin');

			const inserted = await client.query<{ id: string }>(
				`insert into public.source_posts
					(source_name, source_channel_id, source_message_id, source_server_id,
					 source_timestamp, raw_text, raw_payload, content_hash, processing_status, channel_name)
				 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
				 on conflict (source_name, source_channel_id, source_message_id) do nothing
				 returning id`,
				[
					sourceName,
					channelId,
					post.messageId,
					post.serverId,
					post.timestamp,
					post.text,
					JSON.stringify(post.meta ?? null),
					hash,
					candidates.some(c => c.needsReview) ? 'needs_review' : 'pending',
					channelName ?? null
				]
			);

			if (!inserted.rows[0]) {
				await client.query('rollback');
				// Debug level: a backfill re-reads the whole history, so this
				// would otherwise emit thousands of lines per channel.
				log.debug('duplicate_skipped', { channelId, messageId: post.messageId });
				return { outcome: 'duplicate', reason: 'source post already stored' };
			}

			const sourcePostId = inserted.rows[0].id;
			const jobIds: string[] = [];

			for (const candidate of candidates) {
				const key = dedupeKey({
					company: candidate.company,
					title: candidate.title,
					location: candidate.location,
					applyUrl: candidate.apply_url,
					batchYears: candidate.batch_years,
					text: post.text
				});
				const jobStatus = candidate.needsReview ? 'draft' : (this.options.publishPolicy ?? 'draft');

				if (key) {
					const jobRes = await client.query<{ id: string }>(
						`insert into public.jobs
							(source_post_id, title, company, location, work_mode, employment_type,
							 eligibility, experience, batch_years, salary, description, apply_url, deadline,
							 original_post_url, source_posted_at, status, dedupe_key)
						 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
						 on conflict (dedupe_key) where dedupe_key is not null do update
							set title = excluded.title,
								company = excluded.company,
								location = excluded.location,
								work_mode = excluded.work_mode,
								employment_type = excluded.employment_type,
								eligibility = excluded.eligibility,
								experience = excluded.experience,
								batch_years = excluded.batch_years,
								salary = excluded.salary,
								description = excluded.description,
								apply_url = excluded.apply_url,
								deadline = excluded.deadline,
								original_post_url = excluded.original_post_url,
								source_posted_at = excluded.source_posted_at,
								status = excluded.status,
								updated_at = now()
						 returning id`,
						[
							sourcePostId,
							candidate.title,
							candidate.company,
							candidate.location,
							candidate.work_mode,
							candidate.employment_type,
							candidate.eligibility,
							candidate.experience,
							candidate.batch_years,
							candidate.salary,
							candidate.description,
							candidate.apply_url,
							candidate.deadline,
							this.options.originalPostUrl ?? null,
							post.timestamp,
							jobStatus,
							key
						]
					);
					if (jobRes.rows[0]) jobIds.push(jobRes.rows[0].id);
					continue;
				}

				const jobRes = await client.query<{ id: string }>(
					`insert into public.jobs
						(source_post_id, title, company, location, work_mode, employment_type,
						 eligibility, experience, batch_years, salary, description, apply_url, deadline,
						 original_post_url, source_posted_at, status, dedupe_key)
					 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
					 returning id`,
					[
						sourcePostId,
						candidate.title,
						candidate.company,
						candidate.location,
						candidate.work_mode,
						candidate.employment_type,
						candidate.eligibility,
						candidate.experience,
						candidate.batch_years,
						candidate.salary,
						candidate.description,
						candidate.apply_url,
						candidate.deadline,
						this.options.originalPostUrl ?? null,
						post.timestamp,
						jobStatus,
						null
					]
				);
				if (jobRes.rows[0]) jobIds.push(jobRes.rows[0].id);
			}

			const needsReview = candidates.some(c => c.needsReview);
			await client.query('update public.source_posts set processing_status = $2 where id = $1', [
				sourcePostId,
				needsReview ? 'needs_review' : 'processed'
			]);

			await client.query('commit');

			const outcome: ProcessResult = needsReview
				? {
						outcome: 'needs_review',
						sourcePostId,
						jobIds,
						reason: [...new Set(candidates.flatMap(c => c.reviewReasons))].join(',')
					}
				: { outcome: 'created', sourcePostId, jobIds };

			log.info(needsReview ? 'job_needs_review' : 'job_created', {
				sourcePostId,
				jobCount: jobIds.length,
				channelId,
				hasTitle: !!candidates[0]?.title,
				hasCompany: !!candidates[0]?.company,
				hasApplyUrl: !!candidates[0]?.apply_url,
				reviewReasons: [...new Set(candidates.flatMap(c => c.reviewReasons))]
			});
			return outcome;
		} catch (err) {
			await client.query('rollback').catch(() => undefined);
			log.error('ingestion_error', { error: errorMessage(err), messageId: post.messageId });
			return { outcome: 'failed', reason: errorMessage(err) };
		} finally {
			client.release();
		}
	}
}
