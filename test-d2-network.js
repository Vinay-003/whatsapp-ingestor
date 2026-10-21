'use strict';

/**
 * Test D2 — reconnect after a real network outage.
 *
 * The driver script (run-test-d2.sh) runs this process inside an isolated
 * network namespace backed by slirp4netns, then brings the tap interface
 * DOWN and later UP. That is a genuine transport-level outage: no packets
 * reach or leave the process while the tap is down.
 *
 * What is measured:
 *  - whether the client detects the loss and reconnects on its own
 *  - time to reconnect
 *  - whether event handlers are registered exactly once after reconnect
 *  - whether credentials are absent from the logs
 */

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { Connection } = require('./src/lib/connect');
const { resolveChannel } = require('./src/lib/newsletter');
const { sanitizeError } = require('./src/lib/redact');

const RUN_MS = Number(process.env.D2_RUN_SECONDS || 150) * 1000;

(async () => {
	const out = {
		test: 'D2 — reconnect after network outage',
		startedAt: new Date().toISOString(),
		runSeconds: RUN_MS / 1000,
		initialConnect: false,
		opens: [],
		closes: [],
		reconnectedAfterOutage: false,
		reconnectMs: null,
		duplicateHandlers: false,
		handlerRegistrationCounts: [],
		credentialsInLogs: false,
		credFilesOnDisk: [],
		error: null
	};

	const conn = new Connection({ autoReconnect: true });

	// Counters that reveal duplicate handler registration.
	let updateCalls = 0;
	let openCalls = 0;
	let upsertCalls = 0;
	let newsletterPosts = 0;

	conn.on('connection.update', u => {
		updateCalls += 1;
		if (u.connection === 'open') openCalls += 1;
	});
	conn.on('messages.upsert', ({ messages }) => {
		upsertCalls += 1;
		for (const m of messages || []) {
			if (String(m.key?.remoteJid || '').endsWith('@newsletter')) newsletterPosts += 1;
		}
	});

	try {
		await conn.start();
		await conn.waitForOpen(120000);
		out.initialConnect = true;
		const res = await resolveChannel(conn.sock, process.env.WHATSAPP_CHANNEL_URL);
		out.channelResolved = !!res.metadata;
		console.log('[D2] initial connect OK, channel resolved:', out.channelResolved);

		const listenerCountProbe =
			typeof conn.sock.ev.listenerCount === 'function' ? conn.sock.ev.listenerCount('messages.upsert') : 'unavailable';
		out.listenerCountProbeInitial = listenerCountProbe;

		const deadline = Date.now() + RUN_MS;
		let lastOpenAt = Date.now();
		while (Date.now() < deadline) {
			await new Promise(r => setTimeout(r, 1000));
			// Detect a new 'open' after the first one.
			if (conn.state.openAt && new Date(conn.state.openAt).getTime() > lastOpenAt) {
				out.opens.push(conn.state.openAt);
				lastOpenAt = new Date(conn.state.openAt).getTime();
			}
		}
	} catch (err) {
		out.error = sanitizeError(err);
		console.error('[D2] FAILED:', out.error);
	} finally {
		out.opens = conn.state.disconnects.filter(d => d.state === 'open').map(d => d.at);
		out.closes = conn.state.disconnects.filter(d => d.state === 'close').map(d => d.at);
		out.reconnectedAfterOutage = out.opens.length > 1;
		out.totalConnectionUpdates = updateCalls;
		out.totalOpenEvents = openCalls;
		out.totalUpsertEvents = upsertCalls;
		out.newsletterPostsSeen = newsletterPosts;
		out.reconnectAttempts = conn.state.connects;
		out.duplicateHandlers = openCalls > out.opens.length;
		out.handlerRegistrationCounts = {
			registeredInHelper: conn.handlerCount('messages.upsert'),
			emitterListenerCountNow:
				typeof conn.sock.ev.listenerCount === 'function' ? conn.sock.ev.listenerCount('messages.upsert') : 'unavailable'
		};
		await conn.stop();
	}

	// Check that no credential material leaked into the log file.
	try {
		const logFile = path.resolve(__dirname, 'logs', 'test.log');
		if (fs.existsSync(logFile)) {
			const log = fs.readFileSync(logFile, 'utf8');
			out.logFileBytes = log.length;
			out.credentialsInLogs =
				/noiseKey|advSecretKey|signedIdentityKey|"identityKey"|"advSecretKey"|process\.env\.LID/i.test(log);
		}
	} catch {
		/* ignore */
	}

	out.finishedAt = new Date().toISOString();
	fs.mkdirSync(path.resolve(__dirname, 'test-output'), { recursive: true });
	fs.writeFileSync(path.resolve(__dirname, 'test-output', 'test-d2.json'), JSON.stringify(out, null, 2));
	console.log('\n===== TEST D2 RESULT =====');
	console.log(JSON.stringify(out, null, 2));
	process.exit(0);
})();
