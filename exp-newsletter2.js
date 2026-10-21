'use strict';

/**
 * Experiment 2: capture the exact response to the newsletter history IQ.
 *
 * The first pass showed the server answering with node=iq type=result, but the
 * structural capture was too shallow to tell whether the payload was empty or
 * simply nested. This version:
 *   - timestamps every event
 *   - dumps the full recursive structure (tag + attribute KEYS only) of any
 *     IQ result / notification, so no message content is exposed
 *   - reports the exact node whose id matches the newsletter query
 */

require('dotenv').config();
const { Connection } = require('./src/lib/connect');
const { resolveChannel } = require('./src/lib/newsletter');

const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

/** Recursive structural summary: tags + attribute keys only. */
function struct(node, depth = 0) {
	if (!node || typeof node !== 'object' || depth > 5) return null;
	const out = { tag: node.tag };
	if (node.attrs && typeof node.attrs === 'object') {
		out.attrKeys = Object.keys(node.attrs);
		for (const k of ['type', 'xmlns', 'count', 't', 'from', 'reason']) {
			if (node.attrs[k] !== undefined) out[k] = node.attrs[k];
		}
	}
	const kids = Array.isArray(node.content) ? node.content : node.content ? [node.content] : [];
	if (kids.length) out.children = kids.map(c => struct(c, depth + 1)).filter(Boolean).slice(0, 10);
	if (node.content && !Array.isArray(node.content) && typeof node.content === 'object' && !node.content.tag) {
		out.contentType = Object.keys(node.content).slice(0, 8);
	}
	return out;
}

(async () => {
	const conn = new Connection({ autoReconnect: false, logLevel: 'error' });
	await conn.start();
	await conn.waitForOpen(120000);
	const sock = conn.sock;

	const ws = sock.ws;
	const origEmit = ws.emit.bind(ws);
	ws.emit = (event, ...args) => {
		try {
			if (typeof event === 'string' && event.startsWith('TAG:')) {
				const node = args[0];
				const s = struct(node);
				const isNewsletter =
					/subscribers_count|message_updates|live_updates|mex|newsletter/i.test(JSON.stringify(s));
				if (isNewsletter || (node && node.tag === 'iq' && node.attrs?.type === 'result')) {
					console.log(`${ts()} [ws] ${event} ${JSON.stringify(s)}`);
				}
			}
		} catch {
			/* never break the socket */
		}
		return origEmit(event, ...args);
	};

	const res = await resolveChannel(sock, process.env.WHATSAPP_CHANNEL_URL);
	const jid = res.metadata.id;
	console.log(`${ts()} channel = ${jid}`);

	// Long timeout so we can see whether the server answers at all.
	console.log(`${ts()} --- fetch with 180s patience ---`);
	const started = Date.now();
	const raw = await sock.newsletterFetchMessages(jid, 5);
	console.log(`${ts()} fetch returned after ${Date.now() - started}ms`);
	console.log(`${ts()} raw = ${JSON.stringify(struct(raw))}`);
	console.log(`${ts()} raw type=${raw === null ? 'null' : typeof raw} tag=${raw?.tag}`);

	await conn.stop();
	process.exit(0);
})();
