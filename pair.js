'use strict';

/**
 * Pairing helper — long-running.
 *
 * Keeps the socket alive, re-issues a fresh pairing QR whenever WhatsApp
 * rotates it, and writes the current QR to:
 *   test-output/qr-latest.txt   (plain ASCII, scannable from a terminal)
 *   test-output/pairing-qr.png  (image copy)
 *
 * Once the socket opens it resolves the channel and writes
 * test-output/test-a.json, then stays connected until SIGINT.
 */

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { Connection, OUT_DIR } = require('./src/lib/connect');
const { resolveChannel } = require('./src/lib/newsletter');
const { sanitizeError, previewText } = require('./src/lib/redact');

const QR_TXT = path.join(OUT_DIR, 'qr-latest.txt');

fs.mkdirSync(OUT_DIR, { recursive: true });

const conn = new Connection({
	autoReconnect: true,
	qrTimeout: 240000,
	printQrText: false, // PNG only — no ASCII rendering in the terminal
	logLevel: 'debug', // capture the server's replies to diagnose rejections
	// Mirror every fresh QR to a file so it can be displayed on demand.
	onQr: async qr => {
		const QRCode = require('qrcode');
		const ascii = await QRCode.toString(qr, { type: 'terminal', small: true, errorCorrectionLevel: 'M' });
		fs.writeFileSync(QR_TXT, ascii.replace(/\x1b\[[0-9;]*m/g, ''));
		console.log(`[pair] QR refreshed -> ${QR_TXT}`);
	}
});

(async () => {
	try {
		await conn.start();
		console.log('[pair] waiting for scan...');
		await conn.waitForOpen(3600000);
		console.log('[pair] CONNECTED');

		const out = {
			test: 'A — authentication and channel resolution',
			startedAt: new Date().toISOString(),
			node: process.version,
			os: `${process.platform} ${process.arch}`,
			authSuccessful: true,
			channelUrlResolved: false,
			channelIdReturned: false,
			metadata: null,
			resolvedVia: null,
			attempts: [],
			qrPresented: conn.state.qrShown,
			error: null
		};

		const res = await resolveChannel(conn.sock, process.env.WHATSAPP_CHANNEL_URL);
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
		}
		fs.writeFileSync(path.join(OUT_DIR, 'test-a.json'), JSON.stringify(out, null, 2));
		console.log('[pair] ' + JSON.stringify(out, null, 2));
		console.log('[pair] staying connected. Ctrl-C to stop.');

		// Keep the process alive so the session stays usable for the other tests.
		setInterval(() => {}, 1 << 30);
	} catch (err) {
		console.error('[pair] FAILED:', sanitizeError(err));
		process.exitCode = 1;
	}
})();

process.on('SIGINT', async () => {
	console.log('\n[pair] stopping');
	await conn.stop();
	process.exit(0);
});
