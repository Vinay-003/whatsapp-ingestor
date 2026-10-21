'use strict';

/**
 * Test D1 — session persistence: restart the process and confirm it
 * reconnects WITHOUT a fresh QR, using the locally stored auth state.
 *
 * Auth-state store: `useMultiFileAuthState(folder)` (lib/Utils/use-multi-file-auth-state.d.ts),
 * which persists creds + signal keys under ./auth_info_baileys.
 */

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { Connection, AUTH_DIR } = require('./src/lib/connect');
const { resolveChannel } = require('./src/lib/newsletter');
const { sanitizeError } = require('./src/lib/redact');

(async () => {
	const out = {
		test: 'D1 — session restore after restart',
		startedAt: new Date().toISOString(),
		authStateDir: path.basename(AUTH_DIR),
		authStateFiles: fs.existsSync(AUTH_DIR) ? fs.readdirSync(AUTH_DIR).map(f => (f.endsWith('.json') ? f : `${f}/`)) : [],
		qrPresented: 0,
		restartWithoutNewQR: false,
		connected: false,
		channelResolved: false,
		credsFileMtime: null,
		error: null
	};

	const conn = new Connection({ autoReconnect: false });
	try {
		const started = Date.now();
		await conn.start();
		await conn.waitForOpen(120000);
		out.connected = true;
		out.qrPresented = conn.state.qrShown;
		out.connectMs = Date.now() - started;
		out.restartWithoutNewQR = conn.state.qrShown === 0;
		console.log(`[D1] connected in ${out.connectMs}ms, QR presented: ${conn.state.qrShown}`);

		const res = await resolveChannel(conn.sock, process.env.WHATSAPP_CHANNEL_URL);
		out.channelResolved = !!res.metadata;
		console.log(`[D1] channel resolved after restart: ${out.channelResolved}`);
	} catch (err) {
		out.error = sanitizeError(err);
		console.error('[D1] FAILED:', out.error);
	} finally {
		await conn.stop();
	}

	out.finishedAt = new Date().toISOString();
	fs.mkdirSync(path.resolve(__dirname, 'test-output'), { recursive: true });
	fs.writeFileSync(path.resolve(__dirname, 'test-output', 'test-d1.json'), JSON.stringify(out, null, 2));
	console.log('\n===== TEST D1 RESULT =====');
	console.log(JSON.stringify(out, null, 2));
	process.exit(out.restartWithoutNewQR ? 0 : 1);
})();
