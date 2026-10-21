'use strict';

const { isJidNewsletter } = require('@whiskeysockets/baileys/lib/WABinary/jid-utils.js');
const { getBinaryNodeChild, getBinaryNodeChildren, S_WHATSAPP_NET } = require('@whiskeysockets/baileys/lib/WABinary/index.js');
const { proto } = require('@whiskeysockets/baileys');

/**
 * Newsletter/channel helpers, grounded in the installed Baileys 7.0.0-rc14.
 *
 * Source of truth:
 *  node_modules/@whiskeysockets/baileys/lib/Socket/newsletter.d.ts
 *    - newsletterMetadata(type: "invite" | "jid", key): Promise<NewsletterMetadata | null>
 *    - newsletterFetchMessages(jid, count, since, after): Promise<any>   (raw binary node)
 *    - subscribeNewsletterUpdates(jid): Promise<{ duration: string } | null>
 *    - newsletterFollow(jid) / newsletterUnfollow(jid)
 *  node_modules/@whiskeysockets/baileys/lib/Socket/messages-recv.js
 *    - handleNewsletterNotification(): a live channel post arrives as a
 *      notification node with a <message> child holding a <plaintext> payload;
 *      it is pushed through upsertMessage(msg, 'append'), so it surfaces on the
 *      standard 'messages.upsert' event with type 'append'.
 *  node_modules/@whiskeysockets/baileys/lib/Types/Events.d.ts
 *    - 'newsletter.reaction' | 'newsletter.view' | 'newsletter-participants.update'
 *      | 'newsletter-settings.update'  (NOT post messages)
 */

/** Extract the invite code from a whatsapp.com/channel/<code> URL. */
function parseChannelUrl(url) {
	const raw = String(url || '').trim();
	const m = raw.match(/^https?:\/\/(?:www\.)?whatsapp\.com\/channel\/([^/?#]+)/i);
	if (!m) return { raw, invite: null, jid: null };
	const invite = decodeURIComponent(m[1]);
	return { raw, invite, jid: `${invite}@newsletter` };
}

/**
 * Resolve a channel URL to a NewsletterMetadata object.
 * Tries the invite code first, then the raw URL, then a JID-style lookup.
 * Records which form actually worked instead of hard-coding a guessed ID.
 */
async function resolveChannel(sock, url) {
	const { raw, invite, jid } = parseChannelUrl(url);
	const candidates = [];

	if (invite) {
		candidates.push({ type: 'invite', key: invite, label: 'invite-code' });
		candidates.push({ type: 'invite', key: raw, label: 'full-url' });
		candidates.push({ type: 'jid', key: jid, label: 'invite@newsletter' });
	} else {
		candidates.push({ type: 'jid', key: raw, label: 'raw' });
	}

	const attempts = [];
	for (const cand of candidates) {
		try {
			const meta = await sock.newsletterMetadata(cand.type, cand.key);
			attempts.push({ form: cand.label, type: cand.type, ok: !!meta });
			if (meta && meta.id) {
				return { metadata: meta, resolvedVia: cand.label, attempts, invite };
			}		} catch (err) {
			attempts.push({ form: cand.label, type: cand.type, ok: false, error: err?.message });
		}
	}
	return { metadata: null, resolvedVia: null, attempts, invite };
}

/** Recursively collect nodes with a given tag from a binary node tree. */
function collectNodes(node, tag, out = [], depth = 0) {
	if (!node || depth > 12) return out;
	if (node.tag === tag) out.push(node);
	const children = node.content;
	if (Array.isArray(children)) {
		for (const child of children) collectNodes(child, tag, out, depth + 1);
	} else if (children && typeof children === 'object') {
		collectNodes(children, tag, out, depth + 1);
	}
	return out;
}

/**
 * Structural summary of a binary node: tag names and attribute keys only.
 * Used to learn the real server response shape without dumping content.
 */
function nodeShape(node, depth = 0, maxDepth = 4) {
	if (!node || depth > maxDepth) return null;
	const children = node.content;
	const kids = Array.isArray(children) ? children : children ? [children] : [];
	return {
		tag: node.tag,
		attrs: node.attrs ? Object.keys(node.attrs) : [],
		children: kids.slice(0, 6).map(c => nodeShape(c, depth + 1, maxDepth)),
		childCount: kids.length,
		hasContent: !!node.content && !Array.isArray(node.content)
	};
}

/**
 * Parse the raw result of sock.newsletterFetchMessages into post records.
 *
 * The result is the raw IQ node; the posts live in <message> children of
 * <message_updates>. Each post carries stable attributes used for dedupe.
 */
function parseNewsletterFetchResult(result) {
	const messageNodes = collectNodes(result, 'message');
	const posts = [];

	for (const node of messageNodes) {
		const attrs = node.attrs || {};
		const post = {
			// Stable identifiers reported by WhatsApp for the post.
			serverId: attrs.server_id || attrs.message_id || attrs.id || null,
			messageId: attrs.message_id || attrs.id || null,
			timestamp: attrs.t ? Number(attrs.t) : null,
			timestampIso: attrs.t ? new Date(Number(attrs.t) * 1000).toISOString() : null,
			type: attrs.type || null,
			viewCount: attrs.views ? Number(attrs.views) : null,
			rawAttrs: { ...attrs }
		};

		// The <message> node content is an encoded proto.Message (or plaintext).
		const content = node.content;
		if (content && !Array.isArray(content)) {
			try {
				const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
				const { proto } = require('@whiskeysockets/baileys');
				const decoded = proto.Message.decode(buf).toJSON();
				post.decoded = summarizeProtoMessage(decoded);
			} catch {
				post.decoded = null;
			}
		}
		posts.push(post);
	}

	return { posts, messageNodeCount: messageNodes.length, shape: nodeShape(result) };
}

/** Summarize a decoded proto.Message without dumping the full body. */
function summarizeProtoMessage(msg) {
	if (!msg) return null;
	const out = { contentTypes: [] };
	const text = msg.conversation || msg.extendedTextMessage?.text;
	if (text) {
		out.text = text;
		out.contentTypes.push('conversation');
	}
	if (msg.extendedTextMessage) {
		out.contentTypes.push('extendedTextMessage');
		if (msg.extendedTextMessage.contextInfo?.externalAdResponse?.url) {
			out.adUrl = msg.extendedTextMessage.contextInfo.externalAdResponse.url;
		}
		if (msg.extendedTextMessage.contextInfo?.forwardedNewsletterMessageInfo) {
			out.forwardedNewsletter = true;
		}
	}
	for (const key of [
		'imageMessage',
		'videoMessage',
		'audioMessage',
		'documentMessage',
		'stickerMessage',
		'locationMessage',
		'contactMessage',
		'liveLocationMessage',
		'pollCreationMessage',
		'viewOnceMessage'
	]) {
		if (msg[key]) {
			out.contentTypes.push(key);
			const m = msg[key];
			out[`${key}Info`] = {
				mimetype: m.mimetype || null,
				length: m.fileLength ?? m.length ?? null,
				directPath: m.directPath ? 'present' : null,
				mediaKey: m.mediaKey ? 'present' : null,
				caption: m.caption || null
			};
		}
	}
	if (msg.contextInfo) {
		out.contextInfo = {
			forwarded: !!msg.contextInfo.forwarded,
			externalAdUrl: msg.contextInfo.externalAdResponse?.url || null,
			newsletterForwarded: !!msg.contextInfo.forwardedNewsletterMessageInfo
		};
	}
	return out;
}

/** True when the message key belongs to a newsletter/channel JID. */
function isNewsletterKey(key) {
	return !!key?.remoteJid && isJidNewsletter(key.remoteJid);
}

/** Extract every URL found in a text body. */
function extractLinks(text) {
	if (!text) return [];
	const out = [];
	const re = /https?:\/\/[^\s<>"']+/gi;
	let m;
	while ((m = re.exec(text)) !== null) out.push(m[0].replace(/[.,;:)\]]+$/, ''));
	return [...new Set(out)];
}

/**
 * Flatten a NewsletterMetadata object.
 *
 * Depending on the query, WhatsApp returns the descriptive fields either at
 * the top level or nested under `thread_metadata` (observed in this run:
 * thread_metadata = { creation_time, description, handle, invite, name,
 * picture, preview, settings, subscribers_count, verification }).
 * This helper reports both, with a preference for the top-level value.
 */
function flattenMetadata(meta) {
	if (!meta) return null;
	const tm = meta.thread_metadata || {};
	const pick = (a, b) => (meta[a] !== undefined && meta[a] !== null ? meta[a] : tm[b] ?? null);
	return {
		id: meta.id,
		name: pick('name', 'name'),
		description: pick('description', 'description'),
		invite: pick('invite', 'invite'),
		handle: tm.handle ?? null,
		creation_time: pick('creation_time', 'creation_time'),
		subscribers:
			meta.subscribers ?? (tm.subscribers_count !== undefined ? Number(tm.subscribers_count) : null),
		verification: pick('verification', 'verification'),
		mute_state: meta.mute_state ?? null,
		hasPicture: !!(meta.picture || tm.picture),
		hasPreview: !!tm.preview,
		settingsKeys: tm.settings ? Object.keys(tm.settings) : null,
		thread_metadataKeys: tm ? Object.keys(tm) : null
	};
}

/**
 * Fetch newsletter/channel post history using the WA-Web-shaped request.
 *
 * WHY THIS EXISTS
 * ---------------
 * The installed Baileys 7.0.0-rc14 implements `newsletterFetchMessages` as
 *   <iq type="get" to="<channel jid>" xmlns="newsletter">
 *     <message_updates count="N"/>
 *   </iq>
 * which the WhatsApp server does NOT answer (the request simply times out).
 * This is upstream Baileys issue #2555, fixed by commit
 * cc4c34585b317358e3c53486893fb59d6498014c ("fix(newsletter): parse metadata
 * and fetch-messages responses", 2026-06-05), which is NOT in 7.0.0-rc14.
 *
 * The server expects the WhatsApp-Web shape:
 *   <iq type="get" to="s.whatsapp.net" xmlns="newsletter">
 *     <messages type="jid" jid="<channel jid>" count="N"/>
 *   </iq>
 * addressed to the server (not to the channel), and the response carries
 * <messages><message .../></messages>.
 *
 * This function implements that request + the upstream response parsing, using
 * only the public `sock.query()` / `sock.generateMessageTag()` API.
 */
async function fetchNewsletterMessages(sock, jid, count, before, after) {
	const attrs = { type: 'jid', jid, count: String(count) };
	if (typeof before === 'number' && before) attrs.before = String(before);
	if (after) attrs.after = String(after);

	const result = await sock.query({
		tag: 'iq',
		attrs: { id: sock.generateMessageTag(), type: 'get', to: S_WHATSAPP_NET, xmlns: 'newsletter' },
		content: [{ tag: 'messages', attrs }]
	});

	const messagesNode = getBinaryNodeChild(result, 'messages');
	return {
		raw: result,
		messages: getBinaryNodeChildren(messagesNode, 'message').map(parseFetchedNewsletterMessage)
	};
}

/** Parse one <message> node from the <messages> response (upstream cc4c345). */
function parseFetchedNewsletterMessage(node) {
	const plaintext = getBinaryNodeChild(node, 'plaintext');
	const meta = getBinaryNodeChild(node, 'meta');
	const viewsCount = getBinaryNodeChild(node, 'views_count');
	const forwardsCount = getBinaryNodeChild(node, 'forwards_count');
	const responsesCount = getBinaryNodeChild(node, 'responses_count');
	const rcat = getBinaryNodeChild(node, 'rcat');

	const reactionsNode = getBinaryNodeChild(node, 'reactions');
	const reactions = reactionsNode
		? getBinaryNodeChildren(reactionsNode, 'reaction').map(r => ({
				code: r.attrs.code,
				count: r.attrs.count ? parseInt(r.attrs.count, 10) : 0
			}))
		: [];

	const votesNode = getBinaryNodeChild(node, 'votes');
	const pollVotes = votesNode
		? getBinaryNodeChildren(votesNode, 'vote').map(v => ({
				count: v.attrs.count ? parseInt(v.attrs.count, 10) : 0
			}))
		: [];

	let decoded = null;
	if (plaintext?.content instanceof Uint8Array) {
		try {
			decoded = summarizeProtoMessage(proto.Message.decode(plaintext.content).toJSON());
		} catch {
			decoded = null;
		}
	}

	return {
		id: node.attrs.id,
		serverId: node.attrs.server_id,
		messageId: node.attrs.id,
		type: node.attrs.type,
		timestamp: node.attrs.t ? parseInt(node.attrs.t, 10) : undefined,
		timestampIso: node.attrs.t ? new Date(parseInt(node.attrs.t, 10) * 1000).toISOString() : null,
		isSender: node.attrs.is_sender === 'true',
		views: viewsCount?.attrs?.count ? parseInt(viewsCount.attrs.count, 10) : undefined,
		forwards: forwardsCount?.attrs?.count ? parseInt(forwardsCount.attrs.count, 10) : undefined,
		responses: responsesCount?.attrs?.count ? parseInt(responsesCount.attrs.count, 10) : undefined,
		editTimestamp: meta?.attrs?.msg_edit_t ? parseInt(meta.attrs.msg_edit_t, 10) : undefined,
		originalTimestamp: meta?.attrs?.original_msg_t ? parseInt(meta.attrs.original_msg_t, 10) : undefined,
		hasMediaRef: !!rcat,
		reactions,
		pollVotes,
		decoded
	};
}

module.exports = {
	parseChannelUrl,
	resolveChannel,
	flattenMetadata,
	fetchNewsletterMessages,
	parseFetchedNewsletterMessage,
	collectNodes,
	nodeShape,
	parseNewsletterFetchResult,
	summarizeProtoMessage,
	isNewsletterKey,
	extractLinks
};
