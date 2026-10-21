/**
 * Environment validation. Fails fast at startup rather than at first use.
 */

import { randomUUID } from 'node:crypto';

export type Config = {
	nodeEnv: string;
	port: number;
	logLevel: string;

	channelUrl: string;
	historyBatchSize: number;
	historyBackfillIntervalMinutes: number;
	liveResubscribeSeconds: number;
	/** How often to look for newly joined channels. */
	channelDiscoveryIntervalMinutes: number;
	/** Page size for a history request (the server accepts at most 200). */
	historyPageSize: number;
	/** Safety cap on the number of history pages read per channel. */
	maxHistoryPages: number;

	databaseUrl: string;
	sessionEncryptionKey: Buffer;
	sessionLocalDir: string | null;

	healthPingSecret: string | null;

	leaseTtlSeconds: number;
	leaseWaitSeconds: number;
	instanceId: string;
};

function required(name: string): string {
	const v = process.env[name];
	if (!v || !v.trim()) throw new Error(`Missing required environment variable: ${name}`);
	return v.trim();
}

function optional(name: string): string | null {
	const v = process.env[name];
	return v && v.trim() ? v.trim() : null;
}

function int(name: string, fallback: number): number {
	const v = process.env[name];
	if (!v) return fallback;
	const n = Number.parseInt(v, 10);
	if (!Number.isFinite(n)) throw new Error(`Environment variable ${name} must be an integer`);
	return n;
}

/** Accept a 64-char hex string or any base64 string that decodes to 32 bytes. */
function parseEncryptionKey(raw: string): Buffer {
	const hex = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
	if (hex.length !== 32) {
		throw new Error('SESSION_ENCRYPTION_KEY must decode to exactly 32 bytes (64 hex chars or base64)');
	}
	return hex;
}

export function loadConfig(): Config {
	const encryptionKeyRaw = required('SESSION_ENCRYPTION_KEY');
	return {
		nodeEnv: process.env.NODE_ENV ?? 'development',
		port: int('PORT', 10000),
		logLevel: process.env.LOG_LEVEL ?? 'info',

		channelUrl: optional('WHATSAPP_CHANNEL_URL') ?? '',
		historyBatchSize: int('HISTORY_BATCH_SIZE', 25),
		historyBackfillIntervalMinutes: int('HISTORY_BACKFILL_INTERVAL_MINUTES', 60),
		liveResubscribeSeconds: int('LIVE_RESUBSCRIBE_SECONDS', 60),
		channelDiscoveryIntervalMinutes: int('CHANNEL_DISCOVERY_INTERVAL_MINUTES', 30),
		historyPageSize: Math.min(int('HISTORY_PAGE_SIZE', 200), 200),
		maxHistoryPages: int('MAX_HISTORY_PAGES', 60),

		databaseUrl: required('DATABASE_URL'),
		sessionEncryptionKey: parseEncryptionKey(encryptionKeyRaw),
		sessionLocalDir: optional('SESSION_LOCAL_DIR'),

		healthPingSecret: optional('HEALTH_PING_SECRET'),

	leaseTtlSeconds: int('LEASE_TTL_SECONDS', 120),
	leaseWaitSeconds: int('LEASE_WAIT_SECONDS', 180),
	instanceId: optional('INSTANCE_ID') ?? `${process.env.HOSTNAME ?? 'local'}-${randomUUID().slice(0, 8)}`
	};
}
