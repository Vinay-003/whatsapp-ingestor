'use strict';

/**
 * Discover newsletter/channel chats visible to this linked device.
 *
 * When a channel is created on the phone, the linked web device receives the
 * chat through app-state sync ('chats.upsert'). This lists every
 * @newsletter chat the session can see, with its metadata, so a test channel
 * can be resolved without asking for a link.
 */

require('dotenv').config();
const { Connection } = require('./src/lib/connect');
const { flattenMetadata } = require('./src/lib/newsletter');
const { previewText } = require('./src/lib/redact');

const WATCH_MS = Number(process.env.WATCH_SECONDS || 25) * 1000;
const found = new Map();

(async () => {
	const conn = new Connection({ autoReconnect: false });
	await conn.start();
	await conn.waitForOpen(120000);
	console.log('[disc] connected');

	conn.on('chats.upsert', chats => {
		for (const c of chats || []) {
			if (!String(c.id || '').endsWith('@newsletter')) continue;
			found.set(c.id, { jid: c.id, nameFromChat: c.name || c.subject || null });
		}
	});
	conn.on('chats.update', updates => {
		for (const u of updates || []) {
			if (!String(u.id || '').endsWith('@newsletter')) continue;
			const prev = found.get(u.id) || { jid: u.id };
			if (u.name || u.subject) prev.nameFromChat = u.name || u.subject;
			found.set(u.id, prev);
		}
	});

	const deadline = Date.now() + WATCH_MS;
	while (Date.now() < deadline) {
		await new Promise(r => setTimeout(r, 1000));
	}

	console.log(`[disc] found ${found.size} newsletter chat(s)`);
	for (const [jid, info] of found.entries()) {
		let meta = null;
		try {
			meta = await conn.sock.newsletterMetadata('jid', jid);
		} catch (err) {
			meta = null;
		}
		const flat = flattenMetadata(meta);
		console.log(
			`[disc] ${jid} | chatName=${previewText(info.nameFromChat, 60) || 'n/a'} | metaName=${previewText(flat?.name?.text || flat?.name, 60) || 'n/a'} | invite=${flat?.invite || 'n/a'} | subs=${flat?.subscribers ?? 'n/a'}`
		);
	}

	await conn.stop();
	process.exit(0);
})();
