/**
 * Imports a session from a local `useMultiFileAuthState` folder into the
 * database-backed session store.
 *
 * This makes it possible to reuse a session that was paired locally without
 * scanning a QR again, and it is how a session moves from one machine to
 * another.
 *
 * Usage: tsx scripts/import-session.ts <auth-folder>
 */

import 'dotenv/config';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { BufferJSON } from '@whiskeysockets/baileys';

import { loadConfig } from '../src/config.js';
import { setLogLevel, log, errorMessage } from '../src/logging.js';
import { createPool } from '../src/db/supabase.js';
import { SupabaseSessionStore } from '../src/db/session-store.js';

async function main(): Promise<void> {
	const config = loadConfig();
	setLogLevel(config.logLevel);

	const folder = process.argv[2];
	if (!folder) {
		console.error('usage: tsx scripts/import-session.ts <auth-folder>');
		process.exit(2);
	}

	const pool = createPool(config.databaseUrl);
	const store = new SupabaseSessionStore({ pool, encryptionKey: config.sessionEncryptionKey });

	// The local files were written with BufferJSON.replacer, so they must be
	// read with BufferJSON.reviver. Without the reviver the binary key
	// material stays in its { type: 'Buffer', data } form and is encoded a
	// second time, which corrupts the session.
	const credsRaw = await readFile(join(folder, 'creds.json'), 'utf8');
	const creds = JSON.parse(credsRaw, BufferJSON.reviver);
	await store.saveCreds(creds);
	log.info('session_creds_imported', { registered: creds.registered === true });

	const files = await readdir(folder);
	const keyFiles = files.filter(f => f.endsWith('.json') && f !== 'creds.json');
	const signalKeyStore = store as unknown as {
		set(data: Record<string, Record<string, unknown>>): Promise<void>;
	};
	let count = 0;
	for (const file of keyFiles) {
		const raw = await readFile(join(folder, file), 'utf8');
		const value = JSON.parse(raw, BufferJSON.reviver);
		// The file name is "<type>-<id>.json" with '/' and ':' replaced.
		const match = file.match(/^(.*)-([^/]+)\.json$/);
		if (!match) continue;
		const type = match[1]!;
		const id = match[2]!;
		await signalKeyStore.set({ [type]: { [id]: value } });
		count += 1;
	}
	await store.flush();
	log.info('session_keys_imported', { count });
	await store.close();
	await pool.end();
	console.log(`Imported ${count} key files and the credentials blob.`);
}

main().catch(err => {
	log.error('import_failed', { error: errorMessage(err) });
	process.exit(1);
});
