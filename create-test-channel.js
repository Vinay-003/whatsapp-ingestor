'use strict';

/**
 * Creates a TEMPORARY channel owned by the test account, so that a real post
 * can be published into it and observed arriving LIVE (the target channel is
 * never written to).
 *
 * The runbook forbids posting to channels we do not administer; this channel is
 * administered by the test account, so it is safe, and it is deleted again at
 * the end of the run.
 *
 * Usage: node create-test-channel.js [observeMinutes]
 */

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { Connection } = require('./src/lib/connect');
const { isNewsletterKey, extractLinks, fetchNewsletterMessages } = require('./src/lib/newsletter');
const { sanitizeError, previewText } = require('./src/lib/redact');

const OBSERVE_MS = Number(process.argv[2] || 20) * 60 * 1000;
const CHANNEL_NAME = 'Connector Feasibility Test (temporary)';
const CHANNEL_DESC = 'Temporary channel used to verify live post delivery. Will be deleted.';

(async () => {
	const out = {
		test: 'C-live — controlled live-post verification via a temporary owned channel',
		startedAt: new Date().toISOString(),
		channelCreated: false,
		channelJid: null,
		channelInvite: null,
		livePostReceived: false,
		observations: [],
		historyAfterPost: [],
		error: null
	};

	const conn = new Connection({ autoReconnect: true });
	try {
		await conn.start();
		await conn.waitForOpen(120000);
		console.log('[ctl] connected');

		// --- create the temporary channel ---
		const created = await conn.sock.newsletterCreate(CHANNEL_NAME, CHANNEL_DESC);
		out.channelCreated = true;
		out.channelJid = created?.id || null;
		out.channelInvite = created?.invite || created?.thread_metadata?.invite || null;
		out.channelName = created?.thread_metadata?.name?.text || created?.name || CHANNEL_NAME;
		console.log(`[ctl] channel created: ${out.channelJid}`);
		console.log(`[ctl] invite: ${out.channelInvite}`);
		console.log(`[ctl] link:   https://whatsapp.com/channel/${out.channelInvite}`);

		// --- subscribe to live updates for it ---
		try {
			await conn.sock.newsletterFollow(out.channelJid);
			console.log('[ctl] followed');
		} catch (err) {
			console.log('[ctl] follow failed:', sanitizeError(err));
		}
		const sub = await conn.sock.subscribeNewsletterUpdates(out.channelJid);
		console.log(`[ctl] live updates subscribed, duration=${sub?.duration}s`);
		const reSub = setInterval(async () => {
			try {
				await conn.sock.subscribeNewsletterUpdates(out.channelJid);
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
					isOurTestChannel: msg.key.remoteJid === out.channelJid,
					keyId: msg.key.id,
					upsertType: type,
					fromMe: msg.key.fromMe,
					messageTimestamp: msg.messageTimestamp || null,
					textPreview: previewText(text, 80) || null,
					linkCount: text ? extractLinks(text).length : 0,
					hasMedia: !!(msg.message?.imageMessage || msg.message?.videoMessage || msg.message?.documentMessage)
				};
				out.observations.push(rec);
				console.log('[ctl] LIVE POST RECEIVED:', JSON.stringify(rec));
				if (rec.isOurTestChannel) out.livePostReceived = true;
			}
		});

		console.log(`[ctl] observing for ${OBSERVE_MS / 60000} minutes — post a message in the test channel now`);
		const deadline = Date.now() + OBSERVE_MS;
		while (Date.now() < deadline && !out.livePostReceived) {
			await new Promise(r => setTimeout(r, 2000));
		}
		clearInterval(reSub);

		// --- confirm the same post is readable via history ---
		if (out.livePostReceived) {
			try {
				const { messages } = await fetchNewsletterMessages(conn.sock, out.channelJid, 5);
				out.historyAfterPost = messages.map(m => ({
					serverId: m.serverId,
					messageId: m.messageId,
					timestampIso: m.timestampIso,
					type: m.type,
					textPreview: previewText(m.decoded?.text, 80) || null
				}));
				console.log('[ctl] history after post:', JSON.stringify(out.historyAfterPost, null, 2));
			} catch (err) {
				out.historyError = sanitizeError(err);
			}
		}

		// --- clean up: delete the temporary channel ---
		try {
			await conn.sock.newsletterDelete(out.channelJid);
			out.channelDeleted = true;
			console.log('[ctl] temporary channel deleted');
		} catch (err) {
			out.channelDeleted = false;
			out.channelDeleteError = sanitizeError(err);
			console.log('[ctl] delete failed:', out.channelDeleteError);
		}
	} catch (err) {
		out.error = sanitizeError(err);
		console.error('[ctl] FAILED:', out.error);
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
