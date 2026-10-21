import Link from 'next/link';
import { listChannels, listRecentPosts, formatPostedAt, postPreview } from '@/lib/jobs';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
	const [channels, posts] = await Promise.all([listChannels(), listRecentPosts(40)]);
	const totalPosts = channels.reduce((sum, c) => sum + (c.post_count ?? 0), 0);

	return (
		<>
			<h1>Latest messages from the channels</h1>
			<p className="lede">
				{channels.length} channel{channels.length === 1 ? '' : 's'} · {totalPosts.toLocaleString('en-IN')} messages
				collected. Pick a channel above to read everything, or browse the newest messages below.
			</p>

			<div className="grid" style={{ marginBottom: 34 }}>
				{channels.map(c => (
					<Link className="card" key={c.id} href={`/channels/${c.id}`}>
						<div className="company">{c.name ?? 'Untitled channel'}</div>
						<h2>{(c.post_count ?? 0).toLocaleString('en-IN')} messages</h2>
						<div className="tags">
							{c.subscribers ? <span className="tag">{c.subscribers.toLocaleString('en-IN')} subscribers</span> : null}
							{c.newest_post_at ? <span className="tag">updated {formatPostedAt(c.newest_post_at)}</span> : null}
						</div>
					</Link>
				))}
			</div>

			<h2 style={{ fontSize: '1.1rem', marginBottom: 10 }}>Newest messages</h2>
			{posts.length === 0 ? (
				<div className="empty">No messages collected yet.</div>
			) : (
				<div className="msglist">
					{posts.map(post => (
						<article className="msg" key={post.id}>
							<div className="msg-head">
								<Link href={`/channels/${post.source_channel_id}`} className="msg-channel">
									{post.channel_name ?? 'Channel'}
								</Link>
								<span className="msg-time">{formatPostedAt(post.source_timestamp) ?? 'no date'}</span>
							</div>
							<div className="msg-body">
								{post.raw_text ? post.raw_text : <em className="muted">(media post)</em>}
							</div>
							<div className="msg-foot">
								{postPreview(post, 0) === '(no text)' && post.raw_payload?.hasMedia ? 'media' : ''}
							</div>
						</article>
					))}
				</div>
			)}
		</>
	);
}
