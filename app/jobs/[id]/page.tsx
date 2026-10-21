import { getPublishedJob, formatPostedAt, isExpired } from '@/lib/jobs';
import { notFound } from 'next/navigation';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default async function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const job = await getPublishedJob(id);
	if (!job) notFound();

	const expired = isExpired(job);
	const posted = formatPostedAt(job.source_posted_at);

	return (
		<>
			<p className="count">
				<Link href="/jobs">← Back to all listings</Link>
			</p>
			<div className="detail">
				<div className="company">{job.company ?? 'Unknown company'}</div>
				<h1>{job.title ?? 'Untitled role'}</h1>

				<div className="tags" style={{ marginTop: 10 }}>
					{job.work_mode && <span className="tag remote">{job.work_mode}</span>}
					{job.location && <span className="tag">{job.location}</span>}
					{job.batch_years && <span className="tag">Batch: {job.batch_years}</span>}
					{job.employment_type && <span className="tag">{job.employment_type}</span>}
					{expired && <span className="tag expired">Deadline passed</span>}
				</div>

				<dl>
					{job.salary && (
						<>
							<dt>Salary / CTC</dt>
							<dd>{job.salary}</dd>
						</>
					)}
					{job.eligibility && (
						<>
							<dt>Eligibility</dt>
							<dd>{job.eligibility}</dd>
						</>
					)}
					{job.experience && (
						<>
							<dt>Experience</dt>
							<dd>{job.experience}</dd>
						</>
					)}
					{job.deadline && (
						<>
							<dt>Deadline</dt>
							<dd>{job.deadline}</dd>
						</>
					)}
					{posted && (
						<>
							<dt>Posted on the channel</dt>
							<dd>{posted}</dd>
						</>
					)}
					{job.original_post_url && (
						<>
							<dt>Source</dt>
							<dd>
								<a className="source" href={job.original_post_url} target="_blank" rel="noopener noreferrer">
									Original WhatsApp channel
								</a>
							</dd>
						</>
					)}
				</dl>

				{job.description && <div className="prose">{job.description}</div>}

				<div style={{ marginTop: 22, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
					{job.apply_url && (
						<a className="apply" href={job.apply_url} target="_blank" rel="noopener noreferrer nofollow">
							Apply on the employer&apos;s site
						</a>
					)}
					<span className="count" style={{ margin: 0 }}>
						Always check the original posting for the latest details.
					</span>
				</div>
			</div>
		</>
	);
}
