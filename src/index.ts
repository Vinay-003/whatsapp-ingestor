/**
 * Process entry point.
 *
 * Startup order:
 *   1. validate configuration
 *   2. open the database pool
 *   3. start the health server (so the instance is reachable even while it
 *      waits for the single-writer lease — Render's health check must not
 *      fail while the service is starting up)
 *   4. take the single-writer lease, retrying until it is free
 *   5. connect the WhatsApp socket and restore the session
 *   6. discover the channels, backfill their history, then listen live
 *
 * Shutdown is graceful: stop accepting posts, flush the session store, stop
 * the socket, release the lease and close the pool.
 */

import 'dotenv/config';
import { loadConfig } from './config.js';
import { setLogLevel, log, errorMessage, errorCode } from './logging.js';
import { createPool } from './db/supabase.js';
import { Repositories } from './db/repositories.js';
import { SupabaseSessionStore } from './db/session-store.js';
import { BaileysAdapter } from './whatsapp/baileys-adapter.js';
import { ChannelMonitor } from './whatsapp/channel-monitor.js';
import { PostProcessor } from './ingest/process-post.js';
import { createHealthServer, startHealthServer } from './health/server.js';
import type { SourcePost } from './whatsapp/connector.js';

async function main(): Promise<void> {
	const config = loadConfig();
	setLogLevel(config.logLevel);
	log.info('service_starting', {
		nodeEnv: config.nodeEnv,
		port: config.port,
		instanceId: config.instanceId
	});

	let shuttingDown = false;

	const pool = createPool(config.databaseUrl);
	const repos = new Repositories(pool);

	// --- health server -------------------------------------------------------
	// Started before the lease is taken: on a free-tier platform a second
	// instance may be started while the previous one is still winding down,
	// and the new one has to stay healthy while it waits rather than
	// crash-looping.
	let connectorConnected = false;
	let leaseHeld = false;
	const health = createHealthServer(
		{
			connectorConnected: () => connectorConnected,
			databaseReachable: async () => {
				try {
					await pool.query('select 1');
					return true;
				} catch {
					return false;
				}
			},
			detail: () => ({
				leaseHeld,
				uptimeSeconds: Math.round(process.uptime()),
				memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024)
			})
		},
		config.healthPingSecret
	);
	startHealthServer(health, config.port);

	// --- single writer lease -------------------------------------------------
	// Only one client may use a WhatsApp session: a second one is disconnected
	// with status 440. Wait for the lease instead of exiting, so a rolling
	// restart does not turn into a crash loop.
	const leaseDeadline = Date.now() + config.leaseWaitSeconds * 1000;
	while (Date.now() < leaseDeadline) {
		if (await repos.acquireLease(config.instanceId, config.leaseTtlSeconds)) break;
		log.info('lease_busy', { instanceId: config.instanceId, retryInSeconds: 10 });
		await new Promise(r => setTimeout(r, 10_000));
	}
	if (!(await repos.acquireLease(config.instanceId, config.leaseTtlSeconds))) {
		log.error('lease_not_acquired', { instanceId: config.instanceId });
		throw new Error('another ingestor instance holds the lease');
	}
	leaseHeld = true;
	log.info('lease_acquired', { instanceId: config.instanceId });

	// RENEW the lease while this instance is alive.
	//
	// The lease row has an expiry, and the holder has to keep pushing it out.
	// Without this renewal the lease silently expires while its holder is
	// still connected, a second instance can then take it, and the two
	// clients fight over the same WhatsApp session (status 440, kicking each
	// other off in a loop).
	const leaseRenewTimer = setInterval(
		() => {
			if (shuttingDown) return;
			void repos
				.acquireLease(config.instanceId, config.leaseTtlSeconds)
				.then(ok => {
					if (!ok) log.warn('lease_renew_failed', { instanceId: config.instanceId });
				})
				.catch(err => log.warn('lease_renew_error', { error: errorMessage(err) }));
		},
		Math.max(15_000, Math.floor((config.leaseTtlSeconds * 1000) / 3))
	);
	leaseRenewTimer.unref?.();

	// --- connector ------------------------------------------------------------
	const store = new SupabaseSessionStore({ pool, encryptionKey: config.sessionEncryptionKey });
	const adapter = new BaileysAdapter({
		store,
		events: {
			onStatus: async status => {
				connectorConnected = status.connected;
				await repos
					.updateStatus({
						connector_status: status.connected ? 'connected' : 'disconnected',
						last_connected_at: status.connected ? new Date().toISOString() : undefined,
						reconnect_count: status.reconnects,
						process_memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
						process_uptime_s: Math.round(process.uptime())
					})
					.catch(err => log.error('status_update_failed', { error: errorMessage(err) }));
			},
			onError: async err => {
				await repos
					.updateStatus({
						last_error_at: new Date().toISOString(),
						last_error_code: errorCode(err)
					})
					.catch(() => undefined);
			},
			onPost: async (post: SourcePost) => {
				connectorConnected = true;
				await repos
					.updateStatus({
						last_message_at: new Date().toISOString(),
						last_success_at: new Date().toISOString(),
						process_memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
						process_uptime_s: Math.round(process.uptime())
					})
					.catch(() => undefined);
			}
		},
		onFatal: reason => {
			log.error('connector_fatal', { reason });
		}
	});

	await adapter.start();
	// Channel resolution and history are mex queries: they need an open
	// connection.
	await adapter.waitUntilConnected();

	// --- channels -------------------------------------------------------------
	const processor = new PostProcessor(pool, repos, { publishPolicy: 'draft' });
	const monitor = new ChannelMonitor({
		connector: adapter,
		repos,
		processor,
		discoveryIntervalMinutes: config.channelDiscoveryIntervalMinutes,
		backfillIntervalMinutes: config.historyBackfillIntervalMinutes,
		resubscribeSeconds: config.liveResubscribeSeconds,
		historyPageSize: config.historyPageSize,
		maxHistoryPages: config.maxHistoryPages
	});

	// Discover the channels and read their history. The first run reads
	// everything available; later runs only top up.
	await monitor.sync({ full: true });
	await monitor.subscribeAll();
	monitor.start();

	await repos.updateStatus({
		connector_status: 'connected',
		channel_id: monitor.channels()[0]?.id ?? null
	});
	log.info('service_ready', { channels: monitor.channels().length });

	// --- process lifetime -----------------------------------------------------
	const memoryTimer = setInterval(() => {
		void repos
			.updateStatus({
				process_memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
				process_uptime_s: Math.round(process.uptime())
			})
			.catch(() => undefined);
	}, 60_000);
	memoryTimer.unref?.();

	const shutdown = async (signal: string): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		log.info('service_stopping', { signal });
		monitor.stop();
		clearInterval(leaseRenewTimer);
		try {
			await adapter.stop();
		} catch {
			/* ignore */
		}
		try {
			await store.close();
		} catch {
			/* ignore */
		}
		try {
			health.close();
		} catch {
			/* ignore */
		}
		try {
			await repos.releaseLease(config.instanceId);
		} catch {
			/* ignore */
		}
		try {
			await pool.end();
		} catch {
			/* ignore */
		}
		process.exit(0);
	};

	process.on('SIGTERM', () => void shutdown('SIGTERM'));
	process.on('SIGINT', () => void shutdown('SIGINT'));
	process.on('unhandledRejection', reason => {
		log.error('unhandled_rejection', { error: errorMessage(reason) });
	});
	process.on('uncaughtException', err => {
		log.error('uncaught_exception', { error: errorMessage(err) });
	});
}

main().catch(err => {
	log.error('service_start_failed', { error: errorMessage(err) });
	process.exit(1);
});
