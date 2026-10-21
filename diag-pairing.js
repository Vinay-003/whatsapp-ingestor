'use strict';

/**
 * Diagnostic: capture what the server actually replies to the
 * `link_code_companion_reg` IQ, so the pairing failure is diagnosed from
 * evidence instead of guesswork.
 *
 * Hooks the raw WebSocket 'message' stream (lib/Socket/Client/websocket.js
 * emits 'message' with the encoded frame) and decodes only the node tag and
 * a few safe attributes, so no credentials are printed.
 */

require('dotenv').config();

const { Connection } = require('./src/lib/connect');

const phone = String(process.env.WHATSAPP_PAIR_PHONE || '').replace(/\D/g, '');

const conn = new Connection({ autoReconnect: false, logLevel: 'debug' });

(async () => {
	await conn.start();
	const sock = conn.sock;

	// The raw WebSocket 'message' payload is the *encrypted* frame, so it
	// cannot be decoded here. Baileys' own debug logger does decode it; the
	// redacted logger in src/lib/connect.js keeps node tag + safe attrs.

	console.log('[diag] waiting for registration mode...');
	await conn.waitForQr(120000);
	console.log('[diag] registration mode reached, requesting code...');
	const code = await sock.requestPairingCode(phone);
	console.log(`[diag] pairing code = ${code}`);

	// Give the server time to answer, and see whether the phone-side code works.
	for (let i = 0; i < 20; i++) {
		await new Promise(r => setTimeout(r, 3000));
		if (conn._openCount > 0) {
			console.log('[diag] CONNECTED');
			break;
		}
	}
	console.log('[diag] openCount =', conn._openCount, ' qrShown =', conn.state.qrShown);
	await conn.stop();
	process.exit(0);
})();
