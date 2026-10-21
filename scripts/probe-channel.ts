/** Probe a single channel by invite or jid and print what the server returns. */
import 'dotenv/config';
import { loadConfig } from '../src/config.js';
import { setLogLevel } from '../src/logging.js';
import { createPool } from '../src/db/supabase.js';
import { SupabaseSessionStore } from '../src/db/session-store.js';
import { BaileysAdapter } from '../src/whatsapp/baileys-adapter.js';

async function main() {
	const config = loadConfig();
	setLogLevel('info');
	const pool = createPool(config.databaseUrl);
	const store = new SupabaseSessionStore({ pool, encryptionKey: config.sessionEncryptionKey });
	const adapter = new BaileysAdapter({ store, events: { onPost: async () => {}, onStatus: async () => {}, onError: async () => {} } });
	await adapter.start();
	await adapter.waitUntilConnected();
	for (const target of process.argv.slice(2)) {
		try {
			const meta = await adapter.resolveChannel(target);
			console.log(target, '->', meta ? JSON.stringify(meta) : 'null');
		} catch (err) {
			console.log(target, '-> ERROR', String((err as Error).message).split('\n')[0]);
		}
	}
	await adapter.stop();
	await store.close();
	await pool.end();
	process.exit(0);
}
main();
