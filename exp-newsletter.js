'use strict';

/**
 * Experiment: why does the newsletter history IQ get no answer?
 *
 * Taps every WebSocket event the server emits (so the real response shape is
 * observed, not assumed) and tries the plausible preconditions in order:
 *   1. plain newsletterFetchMessages
 *   2. after newsletterFollow
 *   3. after subscribeNewsletterUpdates
 *   4. with a longer query timeout
 *   5. newsletterMetadata round-trip
 *
 * Only node tags / attribute keys / counts are printed. No content is dumped.
 */

require('dotenv').config();
const { Connection } = require('./src/lib/connect');
const { resolveChannel, flattenMetadata } = require('./src/lib/newsletter');

const sockRef = { current: null };

function tapWs(sock) {
	const ws = sock.ws;
	const origEmit = ws.emit.bind(ws);
	ws.emit = (event, ...args) => {
		try {
			if (typeof event === 'string' && (event.startsWith('TAG:') || event.startsWith('CB:'))) {
				const node = args[0];
				if (node && typeof node === 'object') {
					const kids = Array.isArray(node.content) ? node.content.map(c => c?.tag).filter(Boolean) : [];
					const attrs = {};
					for (const [k, v] of Object.entries(node.attrs || {})) {
						if (['id', 'type', 'from', 'to', 'xmlns', 'count', 'reason'].includes(k)) {
							attrs[k] = typeof v === 'string' && v.length > 40 ? `${v.slice(0, 40)}…` : v;
						}
					}
					console.log(`[ws] event=${event} node=${node.tag} attrs=${JSON.stringify(attrs)} children=${JSON.stringify(kids.slice(0, 8))}`);
				}
			}
		} catch {
			/* never break the socket */
		}
		return origEmit(event, ...args);
	};
}

(async () => {
	const conn = new Connection({ autoReconnect: false, logLevel: 'error' });
	await conn.start();
	await conn.waitForOpen(120000);
	const sock = conn.sock;
	tapWs(sock);

	const res = await resolveChannel(sock, process.env.WHATSAPP_CHANNEL_URL);
	const jid = res.metadata.id;
	console.log(`[exp] channel = ${jid}`);

	const attempt = async (label, fn) => {
		const t0 = Date.now();
		try {
			const r = await fn();
			const kids = r && Array.isArray(r.content) ? r.content.map(c => c?.tag).filter(Boolean) : null;
			console.log(`[exp] ${label}: OK in ${Date.now() - t0}ms tag=${r?.tag} children=${JSON.stringify(kids)}`);
			return r;
		} catch (err) {
			console.log(`[exp] ${label}: ERROR after ${Date.now() - t0}ms -> ${err?.message}`);
			return null;
		}
	};

	console.log('\n--- 1. plain fetch ---');
	await attempt('fetch(5)', () => sock.newsletterFetchMessages(jid, 5));

	console.log('\n--- 2. newsletterFollow then fetch ---');
	await attempt('follow', () => sock.newsletterFollow(jid));
	await new Promise(r => setTimeout(r, 3000));
	await attempt('fetch(5) after follow', () => sock.newsletterFetchMessages(jid, 5));

	console.log('\n--- 3. subscribeNewsletterUpdates then fetch ---');
	await attempt('subscribeNewsletterUpdates', () => sock.subscribeNewsletterUpdates(jid));
	await new Promise(r => setTimeout(r, 3000));
	await attempt('fetch(5) after subscribe', () => sock.newsletterFetchMessages(jid, 5));

	console.log('\n--- 4. fetch with explicit since/after variants ---');
	await attempt('fetch(5, since=0)', () => sock.newsletterFetchMessages(jid, 5, 0, undefined));
	await attempt('fetch(5, after=undefined,since=undefined)', () => sock.newsletterFetchMessages(jid, 5, undefined, undefined));

	console.log('\n--- 5. newsletterSubscribers (is the account a subscriber?) ---');
	await attempt('subscribers', () => sock.newsletterSubscribers(jid));

	console.log('\n--- 6. metadata round-trip ---');
	await attempt('metadata(jid)', () => sock.newsletterMetadata('jid', jid));

	await conn.stop();
	process.exit(0);
})();
