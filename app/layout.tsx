import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';
import { listChannels } from '@/lib/jobs';

export const metadata: Metadata = {
	title: 'Job Board — WhatsApp channel listings',
	description: 'Internship and job openings collected from public WhatsApp channels.'
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
	const channels = await listChannels();
	return (
		<html lang="en">
			<body>
				<header className="site">
					<div className="wrap">
						<div className="brand">
							<Link href="/">
								<span>◆</span> Job Board
							</Link>
							<small>collected from public WhatsApp channels</small>
						</div>
						<nav>
							<Link href="/">Latest</Link>
							<Link href="/jobs">Parsed jobs</Link>
							<Link href="/admin">Moderation</Link>
						</nav>
					</div>
					{channels.length > 0 && (
						<div className="channelbar">
							<div className="wrap">
								<span className="channelbar-label">Channels</span>
								{channels.map(c => (
									<Link key={c.id} href={`/channels/${c.id}`} className="channelchip">
										{c.name ?? 'Untitled channel'}
										{c.post_count > 0 && <em>{c.post_count}</em>}
									</Link>
								))}
							</div>
						</div>
					)}
				</header>
				<main className="wrap">{children}</main>
				<footer className="site">
					<div className="wrap">
						Messages are collected from public WhatsApp channels and shown as posted. Always confirm the details on
						the original posting before applying. Nothing here is affiliated with WhatsApp.
					</div>
				</footer>
			</body>
		</html>
	);
}
