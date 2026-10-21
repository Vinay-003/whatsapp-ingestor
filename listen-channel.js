'use strict';

/**
 * Listen for live channel posts in ANY channel given by invite code or jid.
 *
 * Used for the controlled live-delivery test: a channel that the human
 * administers (and can post into on demand) gives a decisive answer for
 * "do live channel posts actually arrive?".
 *
 * Usage: node listen-channel.js <invite-code-or-jid> [observeMinutes]
 *
 * Also prints the channel metadata and a short history snapshot, so the live
 * observation can be compared against the history read.
 */

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { Connection } = require('./src/lib/connect');
const { resolveChannel, flattenMetadata, fetchNewsletterMessages, isNewsletterKey, extractLinks } = require('./src/lib/newsletter');
const { sanitizeError, previewText } = require('./src/lib/redact');

const target = process.argv[2];
const OBSERVE_MS = Number(process.argv[3] || 15) * 60 * 1000;

if (!target) {
	console.error('usage: node listen-channel.js <invite-code-or-jid> [observeMinutes]');
	process.exit(2);
}

(async () => {
	const out = {
		test: 'C-live — controlled live-delivery observation',
		startedAt: new Date().toISOString(),
		target,
		observeMinutes: OBSERVE_MS / 60000,
		channelResolved: false,
		channel: null,
		historySnapshot: [],
		livePostReceived: false,
		observations: [],
		auxEvents: {},
		subscribeDurationSeconds: null,
		error: null
	};

	const conn = new Connection({ autoReconnect: true });
	try {
		await conn.start();
		await conn.waitForOpen(120000);
		console.log('[lsn] connected');

		const isJid = String(target).endsWith('@newsletter');
		const res = await resolveChannel(conn.sock, isJid ? target : undefined);
		let jid;
		if (isJid) {
			const meta = await conn.sock.newsletterMetadata('jid', target);
			jid = meta?.id || target;
			out.channel = flattenMetadata(meta);
			out.resolvedVia = 'jid';
		} else {
			if (!res.metadata) throw new Error('could not resolve: ' + JSON.stringify(res.attempts));
			jid = res.metadata.id;
			out.channel = flattenMetadata(res.metadata);
			out.resolvedVia = res.resolvedVia;
		}
		out.channelResolved = true;
		console.log(`[lsn] channel ${jid} -> ${JSON.stringify(out.channel)}`);

		try {
			const { messages } = await fetchNewsletterMessages(conn.sock, jid, 5);
			out.historySnapshot = messages.map(m => ({
				serverId: m.serverId,
				messageId: m.messageId,
				timestampIso: m.timestampIso,
				type: m.type,
				textPreview: previewText(m.decoded?.text, 70) || null
			}));
			console.log('[lsn] history snapshot:', JSON.stringify(out.historySnapshot, null, 2));
		} catch (err) {
			out.historyError = sanitizeError(err);
			console.log('[lsn] history snapshot failed:', out.historyError);
		}

		try {
			await conn.sock.newsletterFollow(jid);
			console.log('[lsn] followed');
		} catch (err) {
			console.log('[lsn] follow failed:', sanitizeError(err));
		}
		const sub = await conn.sock.subscribeNewsletterUpdates(jid);
		out.subscribeDurationSeconds = sub?.duration ? Number(sub.duration) : null;
		console.log(`[lsn] live updates subscribed, duration=${sub?.duration}s`);
		const reSub = setInterval(async () => {
			try {
				await conn.sock.subscribeNewsletterUpdates(jid);
			} catch {
				/* ignore */
			}
		}, 60000);

		conn.on('messages.upsert', ({ messages, type }) => {
			for (const msg of messages || []) {
				if (!isNewsletterKey(msg.key)) continue;
				const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || null;
				const rec = {
					at: new Date().toISOString(),
					channelJid: msg.key.remoteJid,
					keyId: msg.key.id,
					upsertType: type,
					fromMe: msg.key.fromMe,
					messageTimestamp: msg.messageTimestamp || null,
					textPreview: previewText(text, 80) || null,
					linkCount: text ? extractLinks(text).length : 0,
					hasMedia: !!(msg.message?.imageMessage || msg.message?.videoMessage || msg.message?.documentMessage)
				};
				out.observations.push(rec);
				out.livePostReceived = true;
				console.log('[lsn] LIVE POST:', JSON.stringify(rec));
			}
		});
		for (const ev of ['newsletter.reaction', 'newsletter.view', 'newsletter-participants.update', 'newsletter-settings.update']) {
			out.auxEvents[ev] = 0;
			conn.on(ev, () => {
				out.auxEvents[ev] += 1;
				console.log(`[lsn] aux ${ev}`);
			});
		}

		console.log(`[lsn] observing for ${OBSERVE_MS / 60000} minutes`);
		const deadline = Date.now() + OBSERVE_MS;
		while (Date.now() < deadline) {
			await new Promise(r => setTimeout(r, 2000));
		}
		clearInterval(reSub);
	} catch (err) {
		out.error = sanitizeError(err);
		console.error('[lsn] FAILED:', out.error);
	} finally {
		await conn.stop();
	}

	out.finishedAt = new Date().toISOString();
	fs.mkdirSync(path.resolve(__dirname, 'test-output'), { recursive: true });
	fs.writeFileSync(path.resolve(__dirname, 'test-output', 'test-c-live-controlled.json'), JSON.stringify(out, null, 2));
	console.log('\n===== CONTROLLED LIVE TEST RESULT =====');
	console.log(JSON.stringify(out, null, 2));
	process.exit(0);
})();
