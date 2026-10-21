import { createClient } from '@supabase/supabase-js';

/**
 * Supabase clients.
 *
 * The *anon* client is used for everything the public site reads. Row Level
 * Security is what actually protects the data: the anon role can only see
 * rows in `public.jobs` whose status is 'published'. Source posts, raw
 * payloads, ingestion status and the connector session state are not
 * readable with this key.
 *
 * The *service* client bypasses RLS and is used only inside server-side
 * route handlers (admin moderation). It must never be imported by a client
 * component.
 */

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

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Missing environment variable: ${name}`);
	return value;
}

/** Public client. Safe to use from the browser. */
export function anonClient() {
	return createClient(requireEnv('NEXT_PUBLIC_SUPABASE_URL'), requireEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY'), {
		auth: { persistSession: false }
	});
}

/** Server-side client with RLS bypass. Never import from a client component. */
export function serviceClient() {
	return createClient(requireEnv('NEXT_PUBLIC_SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
		auth: { persistSession: false, autoRefreshToken: false }
	});
}
