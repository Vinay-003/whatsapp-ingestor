'use strict';

/**
 * Experiment 3: try alternative request shapes for newsletter history.
 *
 * `sock.newsletterFetchMessages()` sends:
 *   <iq type="get" xmlns="newsletter" to="<jid>"><message_updates count="N"/></iq>
 * and the server never answers it (only bare keepalive pings come back).
 *
 * `sock.query()` IS exposed on the socket, so raw IQ variants can be tried
 * without patching the library. Only node structure and counts are printed.
 */

require('dotenv').config();
const { Connection } = require('./src/lib/connect');
const { resolveChannel } = require('./src/lib/newsletter');

const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

function struct(node, depth = 0) {
	if (!node || typeof node !== 'object' || depth > 4) return null;
	const out = { tag: node.tag };
	if (node.attrs && typeof node.attrs === 'object') {
		out.attrKeys = Object.keys(node.attrs);
		for (const k of ['type', 'xmlns', 'count', 'to', 'from']) if (node.attrs[k] !== undefined) out[k] = node.attrs[k];
	}
	const kids = Array.isArray(node.content) ? node.content : node.content ? [node.content] : [];
	if (kids.length) out.children = kids.map(c => struct(c, depth + 1)).filter(Boolean).slice(0, 8);
	return out;
}

const variants = [
	{
		label: 'A. current library shape (newsletter xmlns, to=jid)',
		node: jid => ({ tag: 'iq', attrs: { type: 'get', xmlns: 'newsletter', to: jid }, content: [{ tag: 'message_updates', attrs: { count: '5' } }] })
	},
	{
		label: 'B. to=@s.whatsapp.net, jid on message_updates',
		node: jid => ({ tag: 'iq', attrs: { type: 'get', xmlns: 'newsletter', to: '@s.whatsapp.net' }, content: [{ tag: 'message_updates', attrs: { count: '5', jid } }] })
	},
	{
		label: 'C. xmlns=w:newsletter, to=jid',
		node: jid => ({ tag: 'iq', attrs: { type: 'get', xmlns: 'w:newsletter', to: jid }, content: [{ tag: 'message_updates', attrs: { count: '5' } }] })
	},
	{
		label: 'D. newsletter xmlns, message_updates with since=0',
		node: jid => ({ tag: 'iq', attrs: { type: 'get', xmlns: 'newsletter', to: jid }, content: [{ tag: 'message_updates', attrs: { count: '5', since: '0' } }] })
	},
	{
		label: 'E. newsletter xmlns, no content (bare get)',
		node: jid => ({ tag: 'iq', attrs: { type: 'get', xmlns: 'newsletter', to: jid } })
	},
	{
		label: 'F. newsletter xmlns, type=set (server-style live_updates namespace)',
		node: jid => ({ tag: 'iq', attrs: { type: 'set', xmlns: 'newsletter', to: jid }, content: [{ tag: 'live_updates', attrs: {} }] })
	}
];

(async () => {
	const conn = new Connection({ autoReconnect: false, logLevel: 'error' });
	await conn.start();
	await conn.waitForOpen(120000);
	const sock = conn.sock;

	const res = await resolveChannel(sock, process.env.WHATSAPP_CHANNEL_URL);
	const jid = res.metadata.id;
	console.log(`${ts()} channel = ${jid}`);

	for (const v of variants) {
		const started = Date.now();
		try {
			const r = await sock.query(v.node(jid), 20000);
			const s = struct(r);
			const json = JSON.stringify(s);
			const hasMessages = /message_updates|"message"/.test(json);
			console.log(
				`${ts()} ${v.label}\n     -> ${Date.now() - started}ms  hasMessagePayload=${hasMessages}  ${json.slice(0, 600)}`
			);
		} catch (err) {
			console.log(`${ts()} ${v.label}\n     -> ERROR after ${Date.now() - started}ms: ${err?.message}`);
		}
		await new Promise(r => setTimeout(r, 1500));
	}

	await conn.stop();
	process.exit(0);
})();
