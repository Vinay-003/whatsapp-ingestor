'use strict';

const path = require('node:path');
const fs = require('node:fs');
const QRCode = require('qrcode');

const { sanitizeError } = require('./redact');

const AUTH_DIR = path.resolve(__dirname, '..', '..', 'auth_info_baileys');
const LOG_DIR = path.resolve(__dirname, '..', '..', 'logs');
const OUT_DIR = path.resolve(__dirname, '..', '..', 'test-output');

/**
 * Connection helper for the local Baileys test.
 *
 * API grounding (Baileys 7.0.0-rc14, as installed in node_modules):
 *  - `makeWASocket(config)` is the default export of `@whiskeysockets/baileys`
 *    (node_modules/@whiskeysockets/baileys/lib/index.d.ts).
 *  - `useMultiFileAuthState(folder)` is the supported local auth-state store
 *    (node_modules/@whiskeysockets/baileys/lib/Utils/use-multi-file-auth-state.d.ts).
 *  - The pairing QR is delivered through the `connection.update` event as the
 *    `qr` property (lib/Socket/socket.js line ~721). The `printQRInTerminal`
 *    socket option is deprecated/removed in this version, so we render it
 *    ourselves. `qrTimeout` controls how long each QR stays valid
 *    (lib/Socket/socket.js line ~709; default 60s for the first QR).
 *
 * Handlers registered through `on()` are attached to the *current* socket and
 * re-attached exactly once when the socket is replaced after a disconnect, so
 * no duplicate handlers can accumulate across reconnects.
 */
class Connection {
	constructor(opts = {}) {
		this.opts = opts;
		this.sock = null;
		this.handlers = new Map(); // event -> Set<fn>
		this.state = {
			connects: 0,
			qrShown: 0,
			openAt: null,
			disconnects: [],
			lastError: null,
			stopped: false
		};
		this._saveCreds = null;
		this._openCount = 0;
		this._closeCount = 0;
		this._lastOpenAt = null;
		this._lastCloseAt = null;
		this._fatal = null;
		this._qrResolvers = [];
	}

	/** Create a socket, wire internal events, and start it. */
	async start() {
		const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
		const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
		this._saveCreds = saveCreds;

		const sock = makeWASocket({
			auth: state,
			logger: makeLogger(this.opts.logLevel || 'error'),
			browser: ['Chrome (120)', 'Desktop', 'Ubuntu'],
			markOnlineOnConnect: false,
			syncFullHistory: false,
			// Keep the app-state sync enabled: it is how the device learns
			// which channels the account follows. Only the FULL message history
			// type is filtered out.
			shouldSyncHistoryMessage: ({ syncType }) => syncType !== 2,
			// Longer QR validity so a human has time to scan it.
			qrTimeout: this.opts.qrTimeout || 180000
		});
		this.sock = sock;
		this.state.connects += 1;
		this._fatal = null;

		sock.ev.on('creds.update', saveCreds);

		sock.ev.on('connection.update', async update => {
			if (update.qr) {
				this.state.qrShown += 1;
				await printQr(update.qr, { toTerminal: this.opts.printQrText !== false });
				if (typeof this.opts.onQr === 'function') {
					try {
						await this.opts.onQr(update.qr);
					} catch (err) {
						console.log('[connection] onQr hook failed:', sanitizeError(err));
					}
				}
				// The first QR is emitted by the server *after* the noise
				// handshake completed, i.e. the socket is in registration mode
				// and can accept a `link_code_companion_reg` stanza.
				for (const r of this._qrResolvers.splice(0)) r(update.qr);
			}
			if (update.connection) {
				this.state.disconnects.push({ at: new Date().toISOString(), state: update.connection });
				console.log(`[connection] ${update.connection}${update.isNewLogin ? ' (new login)' : ''}`);
			}
			if (update.connection === 'open') {
				this._openCount += 1;
				this._lastOpenAt = new Date();
				this.state.openAt = this._lastOpenAt.toISOString();
			}
			if (update.connection === 'close') {
				this._closeCount += 1;
				this._lastCloseAt = new Date();
			}
			if (update.lastDisconnect) {
				this.state.lastError = sanitizeError(update.lastDisconnect.error);
				console.log(`[connection] disconnected: ${this.state.lastError}`);
				this._maybeReconnect(update.lastDisconnect);
			}
		});

		// Re-attach user handlers to the new socket, exactly once each.
		for (const [event, fns] of this.handlers) {
			for (const fn of fns) sock.ev.on(event, fn);
		}

		return sock;
	}

	/** Register a handler that survives socket replacement, without duplicates. */
	on(event, fn) {
		if (!this.handlers.has(event)) this.handlers.set(event, new Set());
		const set = this.handlers.get(event);
		if (set.has(fn)) return; // exactly-once
		set.add(fn);
		if (this.sock) this.sock.ev.on(event, fn);
	}

	/** Total number of registered handlers (used to prove no duplicates). */
	handlerCount(event) {
		return this.handlers.get(event)?.size || 0;
	}

	/** Schedule a reconnect unless the session was explicitly invalidated. */
	_maybeReconnect(lastDisconnect) {
		if (this.state.stopped || !this.opts.autoReconnect) return;
		const status = lastDisconnect?.error?.output?.statusCode;
		// 401 loggedOut / 403 forbidden => the session is gone, do not retry.
		// 515 restartRequired is the NORMAL post-pairing / post-login signal:
		// the server asks the client to restart the socket and log in with the
		// credentials it just stored, so it MUST be retried.
		if ([401, 403].includes(status)) {
			this._fatal = `fatal status ${status}`;
			console.log(`[connection] not auto-reconnecting (status ${status})`);
			return;
		}
		const attempt = this.state.connects;
		const delay = Math.min(20000, 1500 * attempt) + Math.floor(Math.random() * 800);
		console.log(`[connection] reconnecting in ${delay}ms (attempt ${attempt}, status ${status ?? 'n/a'})`);
		setTimeout(async () => {
			if (this.state.stopped) return;
			try {
				await this.start();
			} catch (err) {
				this.state.lastError = sanitizeError(err);
				this._maybeReconnect({ error: { output: { statusCode: 408 } } });
			}
		}, delay);
	}

	/**
	 * Wait until the socket reports the `open` connection state.
	 *
	 * Resilient to the socket being replaced during the wait: state is tracked
	 * by the internal connection.update handler, so this polls shared state
	 * instead of attaching a one-shot listener to a specific socket instance.
	 */
	async waitForOpen(timeoutMs = 180000) {
		const deadline = Date.now() + timeoutMs;
		const alreadyOpen = this._openCount;
		while (Date.now() < deadline) {
			if (this._openCount > alreadyOpen) return;
			if (this._fatal) throw new Error(`Connection failed: ${this._fatal}`);
			await new Promise(r => setTimeout(r, 250));
		}
		throw new Error(`Timed out after ${timeoutMs}ms waiting for connection open`);
	}

	/**
	 * Wait until the server has issued a pairing QR.
	 *
	 * The QR is only produced once the noise handshake has finished and the
	 * socket is in registration mode, which is exactly when
	 * `requestPairingCode()` can be sent safely. Baileys' own
	 * `connection: 'open'` event is useless here because it only fires after a
	 * successful login.
	 */
	waitForQr(timeoutMs = 120000) {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this._qrResolvers = this._qrResolvers.filter(r => r !== onQr);
				reject(new Error(`Timed out after ${timeoutMs}ms waiting for a pairing QR`));
			}, timeoutMs);
			const onQr = qr => {
				clearTimeout(timer);
				resolve(qr);
			};
			this._qrResolvers.push(onQr);
		});
	}

	async stop() {
		this.state.stopped = true;
		try {
			await this.sock?.end(undefined);
		} catch {
			/* ignore */
		}
	}
}

/**
 * Save the pairing QR as a PNG (always) and optionally render it as ASCII in
 * the terminal. The PNG is the recommended delivery channel: WhatsApp's QR
 * payload is dense and a terminal rendering is hard to scan reliably.
 */
async function printQr(qr, { toTerminal = true } = {}) {
	if (toTerminal) {
		console.log('\n=== WhatsApp pairing QR (scan from your phone terminal) ===');
		try {
			const url = await QRCode.toString(qr, { type: 'terminal', small: true, errorCorrectionLevel: 'M' });
			console.log(url);
		} catch {
			console.log('Could not render QR as text; raw payload length =', String(qr).length);
		}
		console.log('=== End QR ===\n');
	}
	try {
		fs.mkdirSync(OUT_DIR, { recursive: true });
		const file = path.join(OUT_DIR, 'pairing-qr.png');
		await QRCode.toFile(file, qr, { width: 600, margin: 2 });
		console.log(`[qr] PNG written: ${file}`);
	} catch {
		/* ignore */
	}
}

/** A Baileys-compatible logger that writes redacted lines to ./logs/test.log. */
function makeLogger(level = 'error') {
	const file = path.join(LOG_DIR, 'test.log');
	fs.mkdirSync(LOG_DIR, { recursive: true });
	const write = (lvl, obj, msg) => {
		try {
			const line = JSON.stringify({ t: new Date().toISOString(), level: lvl, msg: msg ? String(msg) : undefined, ...safeObj(obj) });
			fs.appendFileSync(file, `${line}\n`);
		} catch {
			/* logging must never crash the test */
		}
	};
	const mk = () => ({
		level,
		child: mk,
		trace: (o, m) => write('trace', o, m),
		debug: (o, m) => write('debug', o, m),
		info: (o, m) => write('info', o, m),
		warn: (o, m) => write('warn', o, m),
		error: (o, m) => write('error', o, m)
	});
	return mk();
}

/** Summarise a binary node: tag + a small set of safe attrs, recursively. */
const SAFE_ATTRS = ['id', 'type', 'from', 'to', 'reason', 'status', 'code', 'xmlns', 'stage', 'jid', 't', 'text'];
function nodeSummary(node, depth = 0) {
	if (!node || typeof node !== 'object' || depth > 3) return undefined;
	const out = { node: node.tag };
	if (node.attrs && typeof node.attrs === 'object') {
		out.attrs = {};
		for (const [k, v] of Object.entries(node.attrs)) {
			if (!SAFE_ATTRS.includes(k)) continue;
			out.attrs[k] = typeof v === 'string' && v.length > 80 ? `${v.slice(0, 80)}…` : v;
		}
	}
	if (Array.isArray(node.content)) {
		const kids = node.content.filter(c => c && typeof c === 'object').map(c => nodeSummary(c, depth + 1));
		if (kids.length) out.children = kids.slice(0, 6);
	}
	return out;
}

/** Drop binary/buffer payloads and huge values before writing to disk. */
function safeObj(obj) {
	if (!obj || typeof obj !== 'object') return {};
	const out = {};
	for (const [k, v] of Object.entries(obj)) {
		if (Buffer.isBuffer(v) || v instanceof Uint8Array) out[k] = `[binary ${v.length}b]`;
		else if (typeof v === 'string' && v.length > 300) out[k] = `[string ${v.length}]`;
		else if (v && typeof v === 'object') {
			// Binary nodes are the most useful thing to see when a stanza is
			// rejected, so keep a sanitised structural summary of them.
			if (typeof v.tag === 'string') {
				out[k] = nodeSummary(v);
			} else {
				out[k] = '[object]';
			}
		} else out[k] = v;
	}
	return out;
}

module.exports = { Connection, printQr, makeLogger, AUTH_DIR, LOG_DIR, OUT_DIR };
