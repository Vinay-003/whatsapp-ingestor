/**
 * Pairing helper.
 *
 * Run this once per WhatsApp account, from the machine that will run the
 * service, to create the session that the ingestor will then restore:
 *
 *   npm run pair
 *
 * The QR is written to ./pairing-qr.png and printed as a PNG path; the QR is
 * never logged. The session is written to the same database the service uses,
 * so the service starts without a QR scan.
 *
 * NOTE: only one client may use a WhatsApp session at a time (a second client
 * is disconnected with status 440). Stop the service before pairing.
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

	const pool = createPool(config.databaseUrl);
	const store = new SupabaseSessionStore({ pool, encryptionKey: config.sessionEncryptionKey });

	let creds = await store.loadCreds();
	if (creds) {
		log.info('pair_session_exists', { hint: 'delete the stored session first to pair a different account' });
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
		shouldSyncHistoryMessage: () => false
	});

	sock.ev.on('creds.update', () => {
		void store.saveCreds(sock.authState.creds).catch(err => log.error('creds_save_failed', { error: errorMessage(err) }));
	});

	let qrWritten = false;
	sock.ev.on('connection.update', async update => {
		if (update.qr && !qrWritten) {
			qrWritten = true;
			await writeFile('pairing-qr.png', await QRCode.toBuffer(update.qr, { width: 800, margin: 2 }));
			log.info('pairing_qr_ready', { file: 'pairing-qr.png' });
			console.log('Scan ./pairing-qr.png in WhatsApp > Settings > Linked devices > Link a device');
		}
		if (update.connection === 'open') {
			log.info('pairing_complete');
			await store.close();
			await sock.end(undefined);
			await pool.end();
			process.exit(0);
		}
		if (update.connection === 'close') {
			log.error('pairing_closed', { error: errorMessage(update.lastDisconnect?.error) });
			await store.close();
			await pool.end();
			process.exit(1);
		}
	});
}

main().catch(err => {
	log.error('pairing_failed', { error: errorMessage(err) });
	process.exit(1);
});
