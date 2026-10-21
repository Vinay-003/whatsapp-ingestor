import { anonClient, type JobRow } from './supabase';
import { unstable_cache } from 'next/cache';

/**
 * Read helpers for the public site.
 *
 * Everything here goes through the anon client, so the database's Row Level
 * Security is the last line of defence: only published jobs and stored
 * channel posts are readable.
 */

export type ChannelRow = {
	id: string;
	name: string | null;
	invite: string | null;
	subscribers: number | null;
	post_count: number;
	newest_post_at: string | null;
	oldest_post_at: string | null;
};

export type PostRow = {
	id: string;
	source_channel_id: string;
	source_message_id: string;
	source_server_id: string | null;
	source_timestamp: string | null;
	raw_text: string;
	raw_payload: Record<string, unknown> | null;
	channel_name: string | null;
	processing_status: string;
};

export type JobFilters = {
	query?: string;
	company?: string;
	location?: string;
	workMode?: string;
	batch?: string;
	limit?: number;
};

const PAGE_SIZE = 40;

/** The channel directory. Cached for a minute so every page load is cheap. */
export const listChannels = unstable_cache(
	async (): Promise<ChannelRow[]> => {
		const { data, error } = await anonClient()
			.from('channels')
			.select('id, name, invite, subscribers, post_count, newest_post_at, oldest_post_at')
			.order('name');
		if (error) {
			console.error('listChannels failed:', error.message);
			return [];
		}
		return (data ?? []) as ChannelRow[];
	},
	['channels'],
	{ revalidate: 60 }
);

export async function getChannel(id: string): Promise<ChannelRow | null> {
	const { data, error } = await anonClient()
		.from('channels')
		.select('id, name, invite, subscribers, post_count, newest_post_at, oldest_post_at')
		.eq('id', id)
		.maybeSingle();
	if (error) {
		console.error('getChannel failed:', error.message);
		return null;
	}
	return (data as ChannelRow | null) ?? null;
}

/** A page of a channel's posts, newest first. */
export async function listChannelPosts(
	channelId: string,
	page = 1,
	pageSize = PAGE_SIZE
): Promise<{ posts: PostRow[]; count: number }> {
	const from = Math.max(0, (page - 1) * pageSize);
	const { data, error, count } = await anonClient()
		.from('source_posts')
		.select('id, source_channel_id, source_message_id, source_server_id, source_timestamp, raw_text, raw_payload, channel_name, processing_status', { count: 'exact' })
		.eq('source_channel_id', channelId)
		.order('source_timestamp', { ascending: false, nullsFirst: false })
		.range(from, from + pageSize - 1);
	if (error) {
		console.error('listChannelPosts failed:', error.message);
		return { posts: [], count: 0 };
	}
	return { posts: (data ?? []) as PostRow[], count: count ?? 0 };
}

/** The most recent posts across every channel. */
export async function listRecentPosts(limit = 30): Promise<PostRow[]> {
	const { data, error } = await anonClient()
		.from('source_posts')
		.select('id, source_channel_id, source_message_id, source_server_id, source_timestamp, raw_text, raw_payload, channel_name, processing_status')
		.order('source_timestamp', { ascending: false, nullsFirst: false })
		.limit(limit);
	if (error) {
		console.error('listRecentPosts failed:', error.message);
		return [];
	}
	return (data ?? []) as PostRow[];
}

export async function listPublishedJobs(filters: JobFilters = {}): Promise<JobRow[]> {
	const limit = Math.min(filters.limit ?? 60, 200);
	let query = anonClient()
		.from('jobs')
		.select('*')
		.eq('status', 'published')
		.order('source_posted_at', { ascending: false, nullsFirst: false })
		.limit(limit);

	if (filters.company) query = query.eq('company', filters.company);
	if (filters.location) query = query.eq('location', filters.location);
	if (filters.workMode) query = query.eq('work_mode', filters.workMode);
	if (filters.batch) query = query.ilike('batch_years', `%${filters.batch}%`);
	if (filters.query) {
		const term = `%${filters.query}%`;
		query = query.or(
			`title.ilike.${term},company.ilike.${term},description.ilike.${term},eligibility.ilike.${term}`
		);
	}

	const { data, error } = await query;
	if (error) {
		console.error('listPublishedJobs failed:', error.message);
		return [];
	}
	return (data ?? []) as JobRow[];
}

export async function getPublishedJob(id: string): Promise<JobRow | null> {
	const { data, error } = await anonClient()
		.from('jobs')
		.select('*')
		.eq('id', id)
		.eq('status', 'published')
		.maybeSingle();
	if (error) {
		console.error('getPublishedJob failed:', error.message);
		return null;
	}
	return (data as JobRow | null) ?? null;
}

/** Distinct filter values, derived from the published rows only. */
export async function getFilterOptions(): Promise<{ companies: string[]; locations: string[]; workModes: string[] }> {
	const { data, error } = await anonClient()
		.from('jobs')
		.select('company,location,work_mode')
		.eq('status', 'published')
		.limit(2000);
	if (error) {
		console.error('getFilterOptions failed:', error.message);
		return { companies: [], locations: [], workModes: [] };
	}
	const rows = (data ?? []) as { company: string | null; location: string | null; work_mode: string | null }[];
	const uniq = (values: (string | null)[]) => [...new Set(values.filter((v): v is string => !!v))].sort();
	return {
		companies: uniq(rows.map(r => r.company)),
		locations: uniq(rows.map(r => r.location)),
		workModes: uniq(rows.map(r => r.work_mode))
	};
}

export function formatPostedAt(iso: string | null): string | null {
	if (!iso) return null;
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return null;
	return date.toLocaleString('en-IN', {
		day: 'numeric',
		month: 'short',
		year: 'numeric',
		hour: '2-digit',
		minute: '2-digit'
	});
}

export function isExpired(job: Pick<JobRow, 'deadline' | 'source_posted_at'>): boolean {
	if (job.deadline) {
		const deadline = new Date(job.deadline);
		if (!Number.isNaN(deadline.getTime()) && deadline.getTime() < Date.now()) return true;
	}
	return false;
}

/** A short label for a post, used for the page title and the list header. */
export function postPreview(post: PostRow, max = 90): string {
	const text = (post.raw_text ?? '').replace(/\s+/g, ' ').trim();
	if (!text) return post.raw_payload?.hasMedia ? 'Media post' : '(no text)';
	return text.length > max ? `${text.slice(0, max)}…` : text;
}
