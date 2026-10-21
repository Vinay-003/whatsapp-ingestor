import { listPublishedJobs, getFilterOptions, formatPostedAt, isExpired } from '@/lib/jobs';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function one(value: string | string[] | undefined): string | undefined {
	if (Array.isArray(value)) return value[0];
	return value;
}

export default async function JobsPage({ searchParams }: { searchParams: SearchParams }) {
	const params = await searchParams;
	const query = one(params.q);
	const company = one(params.company);
	const location = one(params.location);
	const workMode = one(params.work_mode);
	const batch = one(params.batch);

	const [jobs, options] = await Promise.all([
		listPublishedJobs({ query, company, location, workMode, batch }),
		getFilterOptions()
	]);

	return (
		<>
			<h1>Open roles</h1>
			<p className="lede">
				Every listing below was read from a public WhatsApp channel and normalised into a structured record. Apply
				through the original link so the employer receives your application directly.
			</p>

			<form className="filters" method="get" action="/jobs">
				<input type="search" name="q" placeholder="Search title, company…" defaultValue={query ?? ''} />
				<select name="company" defaultValue={company ?? ''}>
					<option value="">All companies</option>
					{options.companies.map(c => (
						<option key={c} value={c}>
							{c}
						</option>
					))}
				</select>
				<select name="location" defaultValue={location ?? ''}>
					<option value="">All locations</option>
					{options.locations.map(c => (
						<option key={c} value={c}>
							{c}
						</option>
					))}
				</select>
				<select name="work_mode" defaultValue={workMode ?? ''}>
					<option value="">Any work mode</option>
					{options.workModes.map(c => (
						<option key={c} value={c}>
							{c}
						</option>
					))}
				</select>
				<input type="text" name="batch" placeholder="Batch (e.g. 2027)" defaultValue={batch ?? ''} />
				<button type="submit">Filter</button>
				<Link className="reset" href="/jobs">
					Reset
				</Link>
			</form>

			<p className="count">
				{jobs.length} {jobs.length === 1 ? 'listing' : 'listings'}
			</p>

			{jobs.length === 0 ? (
				<div className="empty">
					No published listings match these filters yet. New postings appear as soon as the channel publishes them.
				</div>
			) : (
				<div className="grid">
					{jobs.map(job => {
						const expired = isExpired(job);
						const posted = formatPostedAt(job.source_posted_at);
						return (
							<article className="card" key={job.id}>
								<div className="company">{job.company ?? 'Unknown company'}</div>
								<h2>
									<Link href={`/jobs/${job.id}`}>{job.title ?? 'Untitled role'}</Link>
								</h2>
								<div className="tags">
									{job.work_mode && <span className="tag remote">{job.work_mode}</span>}
									{job.location && <span className="tag">{job.location}</span>}
									{job.batch_years && <span className="tag">Batch: {job.batch_years}</span>}
									{job.salary && <span className="tag">{job.salary}</span>}
									{expired && <span className="tag expired">Deadline passed</span>}
								</div>
								<div className="meta">{posted ? `Posted ${posted}` : 'Date not published'}</div>
								{job.apply_url && (
									<a className="apply" href={job.apply_url} target="_blank" rel="noopener noreferrer nofollow">
										Apply
									</a>
								)}
							</article>
						);
					})}
				</div>
			)}
		</>
	);
}
