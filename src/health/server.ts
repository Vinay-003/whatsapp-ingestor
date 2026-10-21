/**
 * Minimal health server.
 *
 * Kept deliberately cheap: no history fetches, no database round trips on the
 * hot path. `/ready` reports whether the WhatsApp socket is actually
 * connected, not merely whether the HTTP process is alive — a running HTTP
 * server with a dead socket must be reported as degraded.
 *
 * `/health` is the endpoint the Cloudflare Worker pings. It requires a
 * bearer token compared in constant time.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { log } from '../logging.js';

export type HealthState = {
	/** Whether the WhatsApp socket is connected right now. */
	connectorConnected: () => boolean;
	/** Whether the database is reachable. */
	databaseReachable: () => Promise<boolean>;
	/** Additional readiness detail. */
	detail?: () => Record<string, unknown>;
};

function safeEqual(a: string, b: string): boolean {
	const ab = Buffer.from(a);
	const bb = Buffer.from(b);
	if (ab.length !== bb.length) {
		// Still do a comparison so the timing does not leak the length.
		timingSafeEqual(ab, ab);
		return false;
	}
	return timingSafeEqual(ab, bb);
}

export function createHealthServer(state: HealthState, pingSecret: string | null): Server {
	return createServer((req: IncomingMessage, res: ServerResponse) => {
		const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

		// Unauthenticated liveness probe for the platform's own health check
		// (Render). It must not require the shared secret, and it must stay
		// cheap: no history fetch, no database round trip.
		if (url.pathname === '/healthz') {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ ok: true, ts: new Date().toISOString() }));
			return;
		}

		if (url.pathname === '/health') {
			if (!pingSecret) {
				// No secret configured: the endpoint is open but says so.
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ ok: true, note: 'HEALTH_PING_SECRET not configured' }));
				return;
			}
			const header = req.headers.authorization ?? '';
			const token = header.startsWith('Bearer ') ? header.slice(7) : '';
			if (!safeEqual(token, pingSecret)) {
				res.writeHead(401, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
				return;
			}
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ ok: true, ts: new Date().toISOString() }));
			return;
		}

		if (url.pathname === '/ready') {
			void (async () => {
				const connected = state.connectorConnected();
				const db = await state.databaseReachable().catch(() => false);
				const payload = {
					ready: connected && db,
					connectorConnected: connected,
					databaseReachable: db,
					...(state.detail ? state.detail() : {})
				};
				res.writeHead(payload.ready ? 200 : 503, { 'content-type': 'application/json' });
				res.end(JSON.stringify(payload));
			})();
			return;
		}

		res.writeHead(404, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ error: 'not_found' }));
	});
}

export function startHealthServer(server: Server, port: number): void {
	server.listen(port, () => {
		log.info('health_server_listening', { port });
	});
}
