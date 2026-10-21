/**
 * Register channels with the ingestion service.
 *
 * Channel discovery from the device's app state is unreliable: the WhatsApp
 * server pushes the followed-channel list only once per device registration,
 * and never again on reconnect. So the channel list is kept in the database
 * and can be extended at any time with this script, which resolves an invite
 * code or channel link through the public `newsletterMetadata` API.
 *
 * Usage:
 *   npx tsx scripts/add-channels.ts <invite-or-link> [<invite-or-link> ...]
 *   npx tsx scripts/add-channels.ts --from-env
 */

import 'dotenv/config';
import { loadConfig } from '../src/config.js';
import { setLogLevel, log, errorMessage } from '../src/logging.js';
import { createPool } from '../src/db/supabase.js';
import { Repositories } from '../src/db/repositories.js';
import { BaileysAdapter } from '../src/whatsapp/baileys-adapter.js';
import { SupabaseSessionStore } from '../src/db/session-store.js';

function inviteOf(input: string): string | null {
	const match = String(input).match(/^https?:\/\/(?:www\.)?whatsapp\.com\/channel\/([^/?#]+)/i);
	if (match) return decodeURIComponent(match[1]!);
	const trimmed = String(input).trim();
	// A channel JID is accepted as-is.
	if (trimmed.endsWith('@newsletter')) return trimmed;
	if (/^[0-9A-Za-z]+$/.test(trimmed) && trimmed.length > 8) return trimmed;
	return null;
}

async function main(): Promise<void> {
	const config = loadConfig();
	setLogLevel(config.logLevel);

	const targets: string[] = [];
	for (const arg of process.argv.slice(2)) {
		if (arg === '--from-env') {
			for (const extra of (process.env.EXTRA_CHANNEL_URLS ?? '').split(',')) {
				if (extra.trim()) targets.push(extra.trim());
			}
			continue;
		}
		targets.push(arg);
	}
	if (!targets.length) {
		console.error('usage: tsx scripts/add-channels.ts <invite-or-link> [...]');
		process.exit(2);
	}

	const pool = createPool(config.databaseUrl);
	const repos = new Repositories(pool);
	const store = new SupabaseSessionStore({ pool, encryptionKey: config.sessionEncryptionKey });
	const adapter = new BaileysAdapter({ store, events: { onPost: async () => {}, onStatus: async () => {}, onError: async () => {} } });

	await adapter.start();
	await adapter.waitUntilConnected();

	let added = 0;
	for (const target of targets) {
		const invite = inviteOf(target);
		if (!invite) {
			console.error(`skipping (not an invite code or channel link): ${target}`);
			continue;
		}
		try {
			const meta = await adapter.resolveChannel(invite);
			if (!meta) {
				console.error(`could not resolve: ${target}`);
				continue;
			}
			await repos.upsertChannel({
				id: meta.id,
				name: meta.name,
				invite: meta.invite,
				subscribers: meta.subscribers,
				verification: meta.verification
			});
			added += 1;
			console.log(`added: ${meta.name} (${meta.id}) invite=${meta.invite ?? 'n/a'} subscribers=${meta.subscribers ?? 'n/a'}`);
		} catch (err) {
			log.error('add_channel_failed', { target, error: errorMessage(err) });
		}
	}

	console.log(`\n${added} channel(s) registered.`);
	await adapter.stop();
	await store.close();
	await pool.end();
	process.exit(0);
}

main().catch(err => {
	log.error('add_channels_failed', { error: errorMessage(err) });
	process.exit(1);
});
