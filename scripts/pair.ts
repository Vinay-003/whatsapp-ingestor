/**
 * Pairing helper.
 *
 * Run this once per WhatsApp account, from the machine that will run the
 * service, to create the session that the ingestor will then restore:
 *
 *   npm run pair              # reuse the stored session if there is one
 *   npm run pair -- --fresh   # DISCARD the stored session and pair again
 *
 * The QR is written to ./pairing-qr.png; the QR itself is never logged. The
 * session is written straight to the same database the service uses, so the
 * service starts without a QR scan.
 *
 * Use --fresh when:
 *   * the device was removed from the WhatsApp account (the stored session is
 *     dead and would otherwise be reused, so no QR would ever appear), or
 *   * you want to pair a different account.
 *
 * NOTE: only one client may use a WhatsApp session at a time (a second client
 * is disconnected with status 440). Stop the running service before pairing.
 */

import 'dotenv/config';
import { makeWASocket } from '@whiskeysockets/baileys';
import { writeFile } from 'node:fs/promises';
import QRCode from 'qrcode';

import { loadConfig } from '../src/config.js';
import { setLogLevel, log, errorMessage } from '../src/logging.js';
import { createPool } from '../src/db/supabase.js';
import { SupabaseSessionStore } from '../src/db/session-store.js';

/** Baileys logs protocol frames; the service's own redacted logger is used instead. */
function silentLogger() {
	const mk = () => ({
		level: 'silent',
		child: mk,
		trace: () => {},
		debug: () => {},
		info: () => {},
		warn: () => {},
		error: () => {}
	});
	return mk();
}

async function main(): Promise<void> {
	const config = loadConfig();
	setLogLevel(config.logLevel);

	const fresh = process.argv.includes('--fresh');

	const pool = createPool(config.databaseUrl);
	const store = new SupabaseSessionStore({ pool, encryptionKey: config.sessionEncryptionKey });

	let creds = await store.loadCreds();
	if (creds && fresh) {
		// The stored session is dead (or belongs to another account). Remove
		// it, otherwise Baileys would try to log in with it and never show a
		// QR code.
		log.info('pair_clearing_session', { detail: 'discarding the stored session (--fresh)' });
		await store.clear();
		await pool.query('delete from connector.session_creds');
		creds = null;
	}
	if (creds) {
		log.info('pair_session_exists', {
			hint: 'run with --fresh to discard it and pair again (a removed device leaves a dead session behind)'
		});
	}

	const sock = makeWASocket({
		auth: {
			creds: creds ?? (await import('@whiskeysockets/baileys/lib/Utils/auth-utils.js')).initAuthCreds(),
			keys: store as never
		},
		logger: silentLogger(),
		browser: ['Chrome (120)', 'Desktop', 'Ubuntu'],
		markOnlineOnConnect: false,
		syncFullHistory: false,
		// The app-state sync must stay enabled: it is how the device learns
		// which channels the account follows, and Baileys warns that disabling
		// all sync causes session instability.
		shouldSyncHistoryMessage: ({ syncType }) => syncType !== 2, // 2 = FULL
		// How long each pairing QR stays valid. The default is only 60 s for
		// the first QR (20 s for the rest), which is not enough for a human
		// to find the phone and scan it.
		qrTimeout: 240000
	});

	sock.ev.on('creds.update', () => {
		void store.saveCreds(sock.authState.creds).catch(err => log.error('creds_save_failed', { error: errorMessage(err) }));
	});

	let qrWritten = false;
	let finished = false;

	/** Flush the session state, stop the socket and exit. */
	const finish = async (code: number): Promise<never> => {
		if (finished) process.exit(code);
		finished = true;
		try {
			await store.flush();
			await store.close();
		} catch {
			/* ignore */
		}
		try {
			await sock.end(undefined);
		} catch {
			/* ignore */
		}
		await pool.end();
		process.exit(code);
	};

	sock.ev.on('connection.update', async update => {
		if (update.qr && !qrWritten) {
			qrWritten = true;
			await writeFile('pairing-qr.png', await QRCode.toBuffer(update.qr, { width: 800, margin: 2 }));
			log.info('pairing_qr_ready', { file: 'pairing-qr.png' });
			console.log('Scan ./pairing-qr.png in WhatsApp > Settings > Linked devices > Link a device');
		}
		if (update.connection === 'open') {
			log.info('pairing_complete');
			await finish(0);
		}
		if (update.connection === 'close') {
			const status = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
			// 515 "restart required" is the NORMAL response after a successful
			// pairing: WhatsApp has stored the new credentials and wants the
			// client to reconnect and log in with them. It is not a failure.
			if (status === 515) {
				log.info('pairing_restart_required', { detail: 'pairing accepted, reconnecting to log in' });
				try {
					await store.flush();
					await sock.end(undefined);
				} catch {
					/* ignore */
				}
				// Rebuild the socket with the freshly stored credentials.
				await restartSocket();
				return;
			}
			log.error('pairing_closed', {
				status: status ?? null,
				error: errorMessage(update.lastDisconnect?.error),
				hint: status === 401 ? 'the stored session was rejected — rerun with --fresh' : undefined
			});
			await finish(1);
		}
	});

	/** Reconnect with the credentials that were just stored. */
	async function restartSocket(): Promise<void> {
		const creds = await store.loadCreds();
		if (!creds) {
			await finish(1);
			return;
		}
		const next = makeWASocket({
			auth: { creds, keys: store as never },
			logger: silentLogger(),
			browser: ['Chrome (120)', 'Desktop', 'Ubuntu'],
			markOnlineOnConnect: false,
			syncFullHistory: false,
			shouldSyncHistoryMessage: ({ syncType }) => syncType !== 2,
			qrTimeout: 240000
		});
		next.ev.on('creds.update', () => {
			void store.saveCreds(next.authState.creds).catch(err => log.error('creds_save_failed', { error: errorMessage(err) }));
		});
		next.ev.on('connection.update', async update => {
			if (update.connection === 'open') {
				log.info('pairing_complete', { detail: 'logged in with the new session' });
				await finish(0);
			}
			if (update.connection === 'close') {
				log.error('pairing_restart_failed', { error: errorMessage(update.lastDisconnect?.error) });
				await finish(1);
			}
		});
	}
}

main().catch(err => {
	log.error('pairing_failed', { error: errorMessage(err) });
	process.exit(1);
});
