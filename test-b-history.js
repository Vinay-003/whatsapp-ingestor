'use strict';

/**
 * Test B — historical message retrieval.
 *
 * Ground truth API (Baileys 7.0.0-rc14):
 *   sock.newsletterFetchMessages(jid, count, since, after) -> raw binary node
 *   (lib/Socket/newsletter.d.ts line 19; implementation lib/Socket/newsletter.js
 *   line 124 — sends an <iq type="get" xmlns="newsletter"> containing
 *   <message_updates count=... since=... after=...> and returns the raw response.)
 */

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { Connection } = require('./src/lib/connect');
const {
	resolveChannel,
	flattenMetadata,
	fetchNewsletterMessages,
	parseNewsletterFetchResult,
	extractLinks
} = require('./src/lib/newsletter');
const { sanitizeError, previewText } = require('./src/lib/redact');

const BATCH = Number(process.env.HISTORY_BATCH || 15);

/** Structural summary of a raw binary node (tags + attr keys only). */
function parsed_shape(node, depth = 0) {
	if (!node || typeof node !== 'object' || depth > 4) return null;
	const out = { tag: node.tag };
	if (node.attrs && typeof node.attrs === 'object') {
		out.attrKeys = Object.keys(node.attrs);
		if (node.attrs.count !== undefined) out.count = node.attrs.count;
	}
	const kids = Array.isArray(node.content) ? node.content : node.content ? [node.content] : [];
	if (kids.length) out.children = kids.map(c => parsed_shape(c, depth + 1)).filter(Boolean).slice(0, 4);
	return out;
}

function summarize(posts) {
	return posts.map(p => {
		const text = p.decoded?.text || null;
		return {
			serverId: p.serverId,
			messageId: p.messageId,
			id: p.id,
			timestampIso: p.timestampIso,
			type: p.type,
			views: p.views,
			forwards: p.forwards,
			responses: p.responses,
			reactionCount: p.reactions?.length || 0,
			contentTypes: p.decoded?.contentTypes || [],
			textPreview: previewText(text, 70) || null,
			linkCount: text ? extractLinks(text).length : 0,
			hasMediaRef: !!p.hasMediaRef,
			forwarded: p.decoded?.contextInfo?.forwarded || false,
			adUrl: p.decoded?.adUrl || p.decoded?.contextInfo?.externalAdUrl || null
		};
	});
}

(async () => {
	const out = {
		test: 'B — historical message retrieval',
		startedAt: new Date().toISOString(),
		batchSize: BATCH,
		historyApiExists: true,
		callSucceeds: false,
		postsReturned: 0,
		postsFromTargetChannel: null,
		stableIds: false,
		timestampsAvailable: false,
		textAvailable: false,
		linksRetained: false,
		mediaRefsPresent: null,
		ordering: null,
		paginationPossible: null,
		secondRunIdsMatch: null,
		shape: null,
		channel: null,
		error: null
	};

	const conn = new Connection({ autoReconnect: true, logLevel: process.env.LOG_LEVEL || 'error' });
	try {
		await conn.start();
		await conn.waitForOpen(120000);
		console.log('[B] connected');

		const res = await resolveChannel(conn.sock, process.env.WHATSAPP_CHANNEL_URL);
		if (!res.metadata) throw new Error('Channel could not be resolved: ' + JSON.stringify(res.attempts));
		const jid = res.metadata.id;
		out.channel = flattenMetadata(res.metadata);
		console.log(`[B] channel jid: ${jid}`);
		console.log(`[B] metadata: ${JSON.stringify(out.channel)}`);

		// --- first fetch (WA-Web shaped request, see src/lib/newsletter.js) ---
		const started = Date.now();
		const fetched = await fetchNewsletterMessages(conn.sock, jid, BATCH);
		out.callSucceeds = true;
		out.fetchMs = Date.now() - started;
		out.requestShape = '<iq type="get" to="s.whatsapp.net" xmlns="newsletter"><messages type="jid" jid count/></iq>';
		const posts = fetched.messages;
		out.postsReturned = posts.length;
		out.rawShape = parsed_shape(fetched.raw);
		console.log(`[B] fetch returned ${posts.length} posts in ${out.fetchMs}ms`);
		console.log(`[B] raw shape: ${JSON.stringify(out.rawShape)}`);

		const summary = summarize(posts);
		console.log('[B] posts summary:');
		console.log(JSON.stringify(summary, null, 2));
		out.posts = summary;

		// ordering: compare timestamps of first and last
		const ts = posts.map(p => p.timestamp).filter(t => typeof t === 'number');
		if (ts.length >= 2) {
			out.ordering = ts[0] >= ts[ts.length - 1] ? 'newest-first' : 'oldest-first';
		}

		// membership + field availability
		out.postsFromTargetChannel = posts.length === 0 ? null : true; // the request is jid-scoped
		out.stableIds = posts.length > 0 && posts.every(p => !!(p.serverId || p.messageId || p.id));
		out.timestampsAvailable = posts.length > 0 && posts.every(p => typeof p.timestamp === 'number');
		out.textAvailable = posts.length > 0 && posts.some(p => !!p.decoded?.text);
		out.linksRetained = posts.length > 0 && posts.some(p => extractLinks(p.decoded?.text || '').length > 0);
		out.mediaRefsPresent = posts.length > 0 ? posts.some(p => !!p.hasMediaRef) : null;

		// --- second fetch: are ids stable? ---
		await new Promise(r => setTimeout(r, 1500));
		const fetched2 = await fetchNewsletterMessages(conn.sock, jid, BATCH);
		const ids1 = posts.map(p => p.serverId || p.messageId || p.id).filter(Boolean);
		const ids2 = fetched2.messages.map(p => p.serverId || p.messageId || p.id).filter(Boolean);
		out.secondRunIdsMatch = JSON.stringify(ids1) === JSON.stringify(ids2);
		out.secondRunIds = ids2;
		out.sampleIdExample = ids1[0] || null;
		console.log(`[B] second run ids identical: ${out.secondRunIdsMatch}`);

		// --- pagination attempt: ask for messages after the oldest id we have ---
		const oldest = posts[posts.length - 1];
		const cursor = oldest?.serverId || oldest?.messageId || oldest?.id;
		if (cursor) {
			try {
				const fetched3 = await fetchNewsletterMessages(conn.sock, jid, BATCH, undefined, cursor);
				const ids3 = fetched3.messages.map(p => p.serverId || p.messageId || p.id).filter(Boolean);
				const newIds = ids3.filter(i => !ids1.includes(i));
				out.paginationPossible = newIds.length > 0;
				console.log(`[B] pagination probe: ${fetched3.messages.length} posts, ${newIds.length} new ids`);
				out.paginationSample = summarize(fetched3.messages).slice(0, 3);
			} catch (err) {
				out.paginationPossible = 'UNKNOWN';
				out.paginationError = sanitizeError(err);
				console.log('[B] pagination probe error:', out.paginationError);
			}
		} else {
			out.paginationPossible = 'UNKNOWN';
		}
	} catch (err) {
		out.error = sanitizeError(err);
		console.error('[B] FAILED:', out.error);
	} finally {
		await conn.stop();
	}

	out.finishedAt = new Date().toISOString();
	fs.mkdirSync(path.resolve(__dirname, 'test-output'), { recursive: true });
	fs.writeFileSync(path.resolve(__dirname, 'test-output', 'test-b.json'), JSON.stringify(out, null, 2));
	console.log('\n===== TEST B RESULT =====');
	console.log(JSON.stringify(out, null, 2));
	process.exit(out.callSucceeds && out.postsReturned > 0 ? 0 : 1);
})();
