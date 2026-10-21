import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getChannel, listChannelPosts, formatPostedAt } from '@/lib/jobs';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 40;

export default async function ChannelPage({
	params,
	searchParams
}: {
	params: Promise<{ id: string }>;
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	// The channel id contains '@' (…@newsletter), which is percent-encoded
	// in a URL path segment and is not decoded by the router.
	const { id: rawId } = await params;
	const id = decodeURIComponent(rawId);
	const sp = await searchParams;
	const page = Math.max(1, Number((Array.isArray(sp.page) ? sp.page[0] : sp.page) ?? '1') || 1);

	const channel = await getChannel(id);
	if (!channel) notFound();

	const { posts, count } = await listChannelPosts(id, page, PAGE_SIZE);
	const totalPages = Math.max(1, Math.ceil(count / PAGE_SIZE));

	return (
		<>
			<p className="count">
				<Link href="/">← All channels</Link>
			</p>
			<h1>{channel.name ?? 'Untitled channel'}</h1>
			<p className="lede">
				{count.toLocaleString('en-IN')} messages
				{channel.subscribers ? ` · ${channel.subscribers.toLocaleString('en-IN')} subscribers` : ''}
				{channel.newest_post_at ? ` · newest ${formatPostedAt(channel.newest_post_at)}` : ''}
				{channel.oldest_post_at ? ` · oldest ${formatPostedAt(channel.oldest_post_at)}` : ''}
			</p>

			{posts.length === 0 ? (
				<div className="empty">No messages collected for this channel yet.</div>
			) : (
				<>
					<div className="msglist">
						{posts.map(post => (
							<article className="msg" key={post.id}>
								<div className="msg-head">
									<span className="msg-time">{formatPostedAt(post.source_timestamp) ?? 'no date'}</span>
									{post.raw_payload?.hasMedia ? <span className="tag">media</span> : null}
								</div>
								<div className="msg-body">
									{post.raw_text ? post.raw_text : <em className="muted">(media post — no text)</em>}
								</div>
							</article>
						))}
					</div>

					{totalPages > 1 && (
						<nav className="pager">
							{page > 1 && <Link href={`/channels/${id}?page=${page - 1}`}>← Newer</Link>}
							<span className="muted">
								page {page} of {totalPages}
							</span>
							{page < totalPages && <Link href={`/channels/${id}?page=${page + 1}`}>Older →</Link>}
						</nav>
					)}
				</>
			)}
		</>
	);
}
