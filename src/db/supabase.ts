/**
 * Postgres pool factory.
 */

import { Pool } from 'pg';
import { log, errorMessage } from '../logging.js';

export function createPool(connectionString: string): Pool {
	const pool = new Pool({
		connectionString,
		max: 4,
		idleTimeoutMillis: 30_000,
		connectionTimeoutMillis: 15_000,
		// Supabase's pooler uses a certificate chain that is not always
		// resolvable from managed hosts; the connection is still encrypted.
		ssl: { rejectUnauthorized: false }
	});
	pool.on('error', err => {
		log.error('db_pool_error', { error: errorMessage(err) });
	});
	return pool;
}
