'use strict';

/**
 * Test A — authentication and channel resolution.
 *
 * Ground truth API (Baileys 7.0.0-rc14):
 *   sock.newsletterMetadata('invite', <invite code>)  -> NewsletterMetadata | null
 *   sock.newsletterMetadata('jid', <jid>)            -> NewsletterMetadata | null
 *   NewsletterMetadata = { id, name, description, invite, creation_time,
 *                           subscribers, verification, mute_state, ... }
 *   (lib/Socket/newsletter.d.ts, lib/Types/Mex.d.ts)
 */

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { Connection } = require('./src/lib/connect');
const { resolveChannel } = require('./src/lib/newsletter');
const { sanitizeError, previewText } = require('./src/lib/redact');

(async () => {
	const out = {
		test: 'A — authentication and channel resolution',
		startedAt: new Date().toISOString(),
		node: process.version,
		os: `${process.platform} ${process.arch}`,
		authSuccessful: false,
		channelUrlResolved: false,
		channelIdReturned: false,
		metadata: null,
		resolvedVia: null,
		attempts: [],
		qrPresented: 0,
		error: null
	};

	const conn = new Connection({ autoReconnect: true, qrTimeout: 300000 });
	try {
		await conn.start();
		console.log('[A] waiting for connection (scan the QR if shown)...');
		await conn.waitForOpen(300000);
		out.authSuccessful = true;
		out.qrPresented = conn.state.qrShown;
		console.log('[A] authentication OK');

		const url = process.env.WHATSAPP_CHANNEL_URL;
		console.log(`[A] resolving channel: ${url}`);

		const res = await resolveChannel(conn.sock, url);
		out.attempts = res.attempts;
		out.resolvedVia = res.resolvedVia;
		out.channelUrlResolved = !!res.metadata;

		if (res.metadata) {
			out.channelIdReturned = !!res.metadata.id;
			out.metadata = {
				id: res.metadata.id,
				idLooksLikeNewsletterJid: String(res.metadata.id).endsWith('@newsletter'),
				name: previewText(res.metadata.name, 120) || null,
				descriptionPresent: !!res.metadata.description,
				descriptionPreview: previewText(res.metadata.description, 120) || null,
				invitePresent: !!res.metadata.invite,
				creation_time: res.metadata.creation_time || null,
				subscribers: res.metadata.subscribers ?? null,
				verification: res.metadata.verification || null,
				mute_state: res.metadata.mute_state || null,
				thread_metadataKeys: res.metadata.thread_metadata ? Object.keys(res.metadata.thread_metadata) : null
			};
			console.log('[A] channel resolved:', JSON.stringify(out.metadata, null, 2));
		} else {
			console.log('[A] channel NOT resolved. attempts:', JSON.stringify(res.attempts, null, 2));
		}
	} catch (err) {
		out.error = sanitizeError(err);
		console.error('[A] FAILED:', out.error);
	} finally {
		await conn.stop();
	}

	out.finishedAt = new Date().toISOString();
	fs.mkdirSync(path.resolve(__dirname, 'test-output'), { recursive: true });
	fs.writeFileSync(path.resolve(__dirname, 'test-output', 'test-a.json'), JSON.stringify(out, null, 2));
	console.log('\n===== TEST A RESULT =====');
	console.log(JSON.stringify(out, null, 2));
	process.exit(out.authSuccessful && out.channelUrlResolved ? 0 : 1);
})();
