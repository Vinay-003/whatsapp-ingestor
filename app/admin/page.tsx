import { cookies } from 'next/headers';
import { verifySessionToken, adminCookie } from '@/lib/admin-auth';
import { serviceClient } from '@/lib/supabase';
import { LoginForm, StatusButton } from '@/components/admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type JobRow = {
	id: string;
	title: string | null;
	company: string | null;
	status: string;
	apply_url: string | null;
	created_at: string;
	source_posted_at: string | null;
};

export default async function AdminPage() {
	const token = (await cookies()).get(adminCookie.name)?.value;
	if (!verifySessionToken(token)) {
		return (
			<>
				<h1>Moderation</h1>
				<p className="lede">Sign in to review and publish the listings collected by the ingestion service.</p>
				<LoginForm />
			</>
		);
	}

	const { data, error } = await serviceClient()
		.from('jobs')
		.select('id,title,company,status,apply_url,created_at,source_posted_at')
		.order('created_at', { ascending: false })
		.limit(200);

	if (error) {
		return (
			<>
				<h1>Moderation</h1>
				<div className="empty">Could not load listings: {error.message}</div>
			</>
		);
	}

	const jobs = (data ?? []) as JobRow[];
	const counts = jobs.reduce<Record<string, number>>((acc, j) => {
		acc[j.status] = (acc[j.status] ?? 0) + 1;
		return acc;
	}, {});

	return (
		<>
			<h1>Moderation</h1>
			<p className="lede">
				{jobs.length} listings · {Object.entries(counts)
					.map(([status, n]) => `${status}: ${n}`)
					.join(' · ')}
			</p>
			<div className="grid">
				{jobs.map(job => (
					<article className="card" key={job.id}>
						<div className="company">{job.company ?? 'Unknown company'}</div>
						<h2>{job.title ?? 'Untitled role'}</h2>
						<div className="tags">
							<span className="tag">{job.status}</span>
							{job.apply_url && <span className="tag">has apply link</span>}
						</div>
						<div className="meta">collected {new Date(job.created_at).toISOString().slice(0, 19).replace('T', ' ')} UTC</div>
						<div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
							{job.status !== 'published' && <StatusButton id={job.id} status={job.status} next="published" />}
							{job.status !== 'rejected' && <StatusButton id={job.id} status={job.status} next="rejected" />}
							{job.status !== 'expired' && <StatusButton id={job.id} status={job.status} next="expired" />}
						</div>
					</article>
				))}
			</div>
		</>
	);
}
