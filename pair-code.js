'use strict';

/**
 * Pairing via phone-number code.
 *
 * Ground truth (Baileys 7.0.0-rc14): `sock.requestPairingCode(phoneNumber,
 * customPairingCode?)` (lib/Socket/socket.d.ts; implementation
 * lib/Socket/socket.js:596-...) generates an 8-char Crockford code, stores it
 * in creds as `pairingCode`, sets creds.me to the given number's
 * s.whatsapp.net jid, and sends a `link_code_companion_reg` stanza.
 * The user then types that code into WhatsApp under
 * Settings > Linked devices > Link a device > Link with phone number.
 *
 * Usage:  node pair-code.js <phone-number-digits-with-country-code>
 *
 * The phone number is used only for this local pairing. It is never written
 * to the test reports; only a masked form is recorded.
 */

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { Connection, OUT_DIR } = require('./src/lib/connect');
const { resolveChannel } = require('./src/lib/newsletter');
const { sanitizeError, previewText } = require('./src/lib/redact');

const raw = process.argv[2] || process.env.WHATSAPP_PAIR_PHONE;
if (!raw) {
	console.error('usage: node pair-code.js <phone-number>');
	process.exit(2);
}
const phone = String(raw).replace(/[^\d]/g, '');
if (phone.length < 8) {
	console.error('phone number looks too short (need country code + number, digits only)');
	process.exit(2);
}
const masked = `${phone.slice(0, 2)}******${phone.slice(-2)}`;

const conn = new Connection({ autoReconnect: false });

(async () => {
	try {
		await conn.start();

		// `requestPairingCode` can only be sent once the socket is in
		// registration mode, i.e. after the noise handshake has completed.
		// The server's first pairing QR is emitted at exactly that point
		// (lib/Socket/socket.js:698-722 -> the `CB:iq,type:set,pair-device`
		// handler). Baileys' `connection: 'open'` event cannot be used here
		// because it only fires after a successful login.
		console.log('[pair-code] waiting for the server to enter registration mode...');
		await conn.waitForQr(120000);
		console.log('[pair-code] transport ready, requesting code...');

		// The pairing code is generated locally and validated server-side with
		// a short TTL, so a stale code is rejected by the phone with
		// "Couldn't link device". Keep rolling a fresh code and print it, so
		// the user always has a current one to type.
		let code = null;
		let lastErr = null;
		const requestFresh = async () => {
			try {
				code = await conn.sock.requestPairingCode(phone);
				console.log('\n=================================================');
				console.log(`   PAIRING CODE:  ${code}`);
				console.log('   WhatsApp > Settings > Linked devices >');
				console.log('   Link a device > Link with phone number');
				console.log('=================================================\n');
				fs.mkdirSync(OUT_DIR, { recursive: true });
				fs.writeFileSync(path.join(OUT_DIR, 'pairing-code.txt'), `${code}\n`);
				return true;
			} catch (err) {
				lastErr = err;
				console.log(`[pair-code] request failed: ${sanitizeError(err)}`);
				return false;
			}
		};

		for (let attempt = 1; attempt <= 5 && !code; attempt++) {
			if (await requestFresh()) break;
			await new Promise(r => setTimeout(r, 2000));
		}
		if (!code) throw new Error(`Could not obtain pairing code: ${sanitizeError(lastErr)}`);

		// Keep rolling the code until the device is linked.
		const roll = setInterval(async () => {
			if (conn._openCount > 0) return;
			await requestFresh();
		}, 45000);
		conn._rollTimer = roll;

		await conn.waitForOpen(300000);
		console.log('[pair-code] CONNECTED');

		const out = {
			test: 'A — authentication and channel resolution',
			startedAt: new Date().toISOString(),
			node: process.version,
			os: `${process.platform} ${process.arch}`,
			authSuccessful: true,
			pairedVia: 'phone-number pairing code',
			accountMasked: masked,
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
		console.log('[pair-code] ' + JSON.stringify(out, null, 2));
		console.log('[pair-code] session saved. Stopping; other tests can now reuse the session.');
		clearInterval(conn._rollTimer);
		await conn.stop();
		process.exit(0);
	} catch (err) {
		console.error('[pair-code] FAILED:', sanitizeError(err));
		process.exit(1);
	}
})();
