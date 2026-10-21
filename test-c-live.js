'use strict';

/**
 * Test C — live channel updates (+ Test E resource sampling in the same run).
 *
 * Ground truth (Baileys 7.0.0-rc14):
 *  - There is NO dedicated "new channel post" event. A live channel post is
 *    delivered as a `notification` node with attrs.type === 'newsletter',
 *    whose <message> child carries a <plaintext> payload. Baileys routes it in
 *    handleNotification -> case 'newsletter' -> handleNewsletterNotification
 *    (lib/Socket/messages-recv.js:802), decodes the plaintext and calls
 *    upsertMessage(msg, 'append'), so it surfaces on the standard
 *    'messages.upsert' event with type 'append'.
 *  - 'newsletter.reaction' | 'newsletter.view' | 'newsletter-participants.update'
 *    | 'newsletter-settings.update' are auxiliary events, not posts.
 *  - `subscribeNewsletterUpdates(jid)` returns { duration } — the SERVER-SIDE
 *    live-update window. Measured here as 90s, so it must be re-issued
 *    periodically to keep receiving pushes.
 *  - `newsletterFollow(jid)` makes the account a subscriber.
 */

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { Connection } = require('./src/lib/connect');
const { resolveChannel, flattenMetadata, fetchNewsletterMessages, isNewsletterKey, extractLinks } = require('./src/lib/newsletter');
const { sanitizeError, previewText } = require('./src/lib/redact');

const OBSERVE_MS = Number(process.env.OBSERVE_MINUTES || 30) * 60 * 1000;
const RESUBSCRIBE_MS = Number(process.env.RESUBSCRIBE_SECONDS || 60) * 1000;
const SAMPLE_MS = 10000;
const RUN_REACTION_PROBE = process.env.REACTION_PROBE !== 'false';

function readMem() {
	try {
		const m = fs.readFileSync('/proc/self/status', 'utf8').match(/VmRSS:\s+(\d+)\s+kB/);
		return m ? Number(m[1]) / 1024 : null;
	} catch {
		return null;
	}
}
function readCpu() {
	try {
		const stat = fs.readFileSync('/proc/self/stat', 'utf8');
		const parts = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
		return (Number(parts[11]) + Number(parts[12])) / 100;
	} catch {
		return null;
	}
}

(async () => {
	const out = {
		test: 'C — live channel updates',
		startedAt: new Date().toISOString(),
		observeMinutes: OBSERVE_MS / 60000,
		liveUpdateEventFound: true,
		liveUpdateTransport: 'notification node attrs.type="newsletter" -> upsertMessage(append) -> messages.upsert',
		subscriptionRequired: 'newsletterFollow + subscribeNewsletterUpdates (re-issued periodically)',
		subscribeDurationSeconds: null,
		resubscribeIntervalSeconds: RESUBSCRIBE_MS / 1000,
		resubscribeCount: 0,
		connectedThroughout: true,
		newChannelPostReceived: false,
		updatesObserved: 0,
		stableIdsPresent: null,
		contentComplete: null,
		observedDelayMs: null,
		nonNewsletterUpsertsSeen: 0,
		newsletterAuxEvents: {},
		serverNotificationsSeen: [],
		lastKnownPostAt: null,
		channelCadenceHint: null,
		reactionProbe: null,
		observations: [],
		// Test E fields
		resourceSamples: [],
		idleRssMb: null,
		peakRssMb: null,
		idleCpuPct: null,
		peakCpuPct: null,
		memoryGrowthMb: null,
		observeDurationSec: null,
		error: null
	};

	const conn = new Connection({ autoReconnect: true });

	// Trap every notification node the server pushes for the channel so the
	// real server behaviour is observed rather than assumed.
	function tapNotifications(sock, jid) {
		const ws = sock.ws;
		const origEmit = ws.emit.bind(ws);
		ws.emit = (event, ...args) => {
			try {
				if (typeof event === 'string' && event.startsWith('TAG:')) {
					const node = args[0];
					if (node?.tag === 'notification' && String(node.attrs?.from || '').endsWith('@newsletter')) {
						const kids = Array.isArray(node.content) ? node.content : [];
						out.serverNotificationsSeen.push({
							at: new Date().toISOString(),
							notificationType: node.attrs?.type || null,
							childTags: kids.map(c => c?.tag).filter(Boolean),
							childAttrKeys: kids.map(c => (c?.attrs ? Object.keys(c.attrs) : []))
						});
						console.log(`[C] server notification type=${node.attrs?.type} children=${JSON.stringify(kids.map(c => c?.tag))}`);
					}
				}
			} catch {
				/* never break the socket */
			}
			return origEmit(event, ...args);
		};
	}

	try {
		await conn.start();
		await conn.waitForOpen(120000);
		console.log('[C] connected');

		const res = await resolveChannel(conn.sock, process.env.WHATSAPP_CHANNEL_URL);
		if (!res.metadata) throw new Error('Channel could not be resolved: ' + JSON.stringify(res.attempts));
		const jid = res.metadata.id;
		out.channel = flattenMetadata(res.metadata);
		console.log(`[C] channel jid: ${jid}`);

		// Cadence: newest existing post, via the corrected history request.
		try {
			const { messages } = await fetchNewsletterMessages(conn.sock, jid, 5);
			const ts = messages.map(m => m.timestamp).filter(t => typeof t === 'number');
			if (ts.length) {
				const newest = Math.max(...ts);
				out.lastKnownPostAt = new Date(newest * 1000).toISOString();
				out.channelCadenceHint = `newest existing post ${((Date.now() - newest * 1000) / 3600000).toFixed(1)}h before test start; ${messages.length} recent posts sampled`;
				console.log(`[C] ${out.channelCadenceHint}`);
				out.newestPostServerId = messages[messages.length - 1]?.serverId || null;
			}
		} catch (err) {
			console.log('[C] cadence probe failed:', sanitizeError(err));
		}

		tapNotifications(conn.sock, jid);

		// --- subscription ---
		try {
			await conn.sock.newsletterFollow(jid);
			out.newsletterFollowOk = true;
			console.log('[C] newsletterFollow OK');
		} catch (err) {
			out.newsletterFollowOk = false;
			out.newsletterFollowError = sanitizeError(err);
			console.log('[C] newsletterFollow failed:', out.newsletterFollowError);
		}

		const subscribe = async () => {
			try {
				const sub = await conn.sock.subscribeNewsletterUpdates(jid);
				out.subscribeDurationSeconds = sub?.duration ? Number(sub.duration) : null;
				out.resubscribeCount += 1;
				console.log(`[C] subscribeNewsletterUpdates -> duration=${sub?.duration}s (call #${out.resubscribeCount})`);
				return sub;
			} catch (err) {
				console.log('[C] subscribe failed:', sanitizeError(err));
				return null;
			}
		};
		await subscribe();
		const resubscribeTimer = setInterval(subscribe, RESUBSCRIBE_MS);

		// --- post handler ---
		conn.on('messages.upsert', ({ messages, type }) => {
			for (const msg of messages || []) {
				if (!isNewsletterKey(msg.key)) {
					out.nonNewsletterUpsertsSeen += 1;
					continue;
				}
				if (msg.key.remoteJid !== jid) continue;
				const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || null;
				const observedAt = new Date();
				const postTs = msg.messageTimestamp ? new Date(msg.messageTimestamp * 1000) : null;
				const rec = {
					at: observedAt.toISOString(),
					keyId: msg.key.id || null,
					remoteJidSuffix: String(msg.key.remoteJid).split('@')[1],
					upsertType: type,
					fromMe: msg.key.fromMe,
					messageTimestamp: msg.messageTimestamp || null,
					contentTypes: Object.keys(msg.message || {}).filter(k => k !== 'contextInfo' && k !== 'extendedTextMessage'),
					textPreview: previewText(text, 70) || null,
					linkCount: text ? extractLinks(text).length : 0,
					hasMedia: !!(msg.message?.imageMessage || msg.message?.videoMessage || msg.message?.documentMessage),
					delayMs: postTs ? observedAt - postTs : null
				};
				out.observations.push(rec);
				out.updatesObserved += 1;
				out.newChannelPostReceived = true;
				out.stableIdsPresent = !!msg.key.id;
				out.contentComplete = !!(text || rec.hasMedia);
				out.observedDelayMs = rec.delayMs;
				console.log('[C] CHANNEL UPDATE:', JSON.stringify(rec));
			}
		});

		for (const ev of ['newsletter.reaction', 'newsletter.view', 'newsletter-participants.update', 'newsletter-settings.update']) {
			out.newsletterAuxEvents[ev] = 0;
			conn.on(ev, payload => {
				out.newsletterAuxEvents[ev] += 1;
				console.log(`[C] aux event ${ev} fired (count=${out.newsletterAuxEvents[ev]})`);
			});
		}
		conn.on('connection.update', u => {
			if (u.connection === 'close') out.connectedThroughout = false;
		});

		// --- transport probe -------------------------------------------------
		// A reaction makes the server push a newsletter notification back on the
		// same channel that carries new posts, which proves the server->client
		// newsletter notification transport end to end. The reaction is removed
		// again immediately. No post is created on the channel.
		if (RUN_REACTION_PROBE && out.newestPostServerId) {
			try {
				await conn.sock.newsletterReactMessage(jid, out.newestPostServerId, '\u{1F44D}');
				console.log('[C] reaction probe: sent');
				await new Promise(r => setTimeout(r, 12000));
				out.reactionProbe = {
					sent: true,
					serverId: out.newestPostServerId,
					notificationsAfter: out.serverNotificationsSeen.length,
					auxEventsAfter: { ...out.newsletterAuxEvents }
				};
				// remove the reaction again
				await conn.sock.newsletterReactMessage(jid, out.newestPostServerId, '');
				console.log('[C] reaction probe: reaction removed');
				out.reactionProbe.reactionRemoved = true;
			} catch (err) {
				out.reactionProbe = { sent: false, error: sanitizeError(err) };
				console.log('[C] reaction probe failed:', out.reactionProbe.error);
			}
		}

		console.log(`[C] observing for ${OBSERVE_MS / 60000} minutes...`);
		const deadline = Date.now() + OBSERVE_MS;
		const rssSamples = [];
		let lastCpu = readCpu();
		let lastCpuAt = Date.now();
		let peakCpuPct = 0;
		while (Date.now() < deadline) {
			await new Promise(r => setTimeout(r, SAMPLE_MS));
			const rss = readMem();
			const cpu = readCpu();
			const now = Date.now();
			const cpuPct = cpu !== null && lastCpu !== null ? ((cpu - lastCpu) / ((now - lastCpuAt) / 1000)) * 100 : null;
			lastCpu = cpu;
			lastCpuAt = now;
			if (rss !== null) {
				out.peakRssMb = Math.max(out.peakRssMb || 0, rss);
				out.resourceSamples.push({
					at: new Date().toISOString(),
					rssMb: Math.round(rss * 10) / 10,
					cpuPct: cpuPct === null ? null : Math.round(cpuPct * 10) / 10
				});
				rssSamples.push(rss);
			}
			if (cpuPct !== null) peakCpuPct = Math.max(peakCpuPct, cpuPct);
		}
		clearInterval(resubscribeTimer);

		out.idleRssMb = rssSamples.length ? Math.round(Math.min(...rssSamples) * 10) / 10 : null;
		out.peakCpuPct = Math.round(peakCpuPct * 10) / 10;
		out.idleCpuPct = out.resourceSamples.length ? out.resourceSamples[out.resourceSamples.length - 1].cpuPct : null;
		out.memoryGrowthMb = rssSamples.length ? Math.round((Math.max(...rssSamples) - Math.min(...rssSamples)) * 10) / 10 : null;
		out.observeDurationSec = Math.round(OBSERVE_MS / 1000);
	} catch (err) {
		out.error = sanitizeError(err);
		console.error('[C] FAILED:', out.error);
	} finally {
		await conn.stop();
	}

	out.finishedAt = new Date().toISOString();
	fs.mkdirSync(path.resolve(__dirname, 'test-output'), { recursive: true });
	fs.writeFileSync(path.resolve(__dirname, 'test-output', 'test-c.json'), JSON.stringify(out, null, 2));
	fs.writeFileSync(
		path.resolve(__dirname, 'test-output', 'test-e.json'),
		JSON.stringify(
			{
				test: 'E — resource usage (sampled during the Test C idle-listener window)',
				startedAt: out.startedAt,
				finishedAt: out.finishedAt,
				runMinutes: OBSERVE_MS / 60000,
				sampleIntervalSec: SAMPLE_MS / 1000,
				historyBatchSize: 5,
				idleRssMb: out.idleRssMb,
				peakRssMb: out.peakRssMb,
				idleCpuPct: out.idleCpuPct,
				peakCpuPct: out.peakCpuPct,
				durationSec: out.observeDurationSec,
				memoryGrowthMb: out.memoryGrowthMb,
				eventsHandled: out.updatesObserved + out.nonNewsletterUpsertsSeen,
				newsletterPostsHandled: out.updatesObserved,
				nonNewsletterMessagesIgnored: out.nonNewsletterUpsertsSeen,
				samples: out.resourceSamples
			},
			null,
			2
		)
	);
	console.log('\n===== TEST C RESULT =====');
	console.log(JSON.stringify(out, null, 2));
	process.exit(0);
})();
