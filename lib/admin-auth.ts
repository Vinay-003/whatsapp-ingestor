import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Minimal admin authentication.
 *
 * The moderation area is protected by a shared password. On success a
 * signed, httpOnly cookie is issued. The signature is an HMAC over the
 * session payload, so the cookie cannot be forged without the server
 * secret, and the session expires on its own.
 *
 * This is intentionally small: the site has a single moderator. If the
 * project grows, replace it with Supabase Auth.
 */

const COOKIE_NAME = 'admin_session';
const SESSION_TTL_SECONDS = 60 * 60 * 8; // 8 hours

function secret(): string {
	const value = process.env.ADMIN_PASSWORD;
	if (!value) throw new Error('Missing environment variable: ADMIN_PASSWORD');
	return value;
}

function sign(payload: string): string {
	return createHmac('sha256', secret()).update(payload).digest('base64url');
}

export function createSessionToken(): string {
	const expires = Date.now() + SESSION_TTL_SECONDS * 1000;
	const payload = `admin.${expires}`;
	return `${payload}.${sign(payload)}`;
}

export function verifySessionToken(token: string | undefined): boolean {
	if (!token) return false;
	const parts = token.split('.');
	if (parts.length !== 3) return false;
	const [role, expires, signature] = parts as [string, string, string];
	if (role !== 'admin') return false;
	const payload = `${role}.${expires}`;
	const expected = sign(payload);
	const a = Buffer.from(signature);
	const b = Buffer.from(expected);
	if (a.length !== b.length) return false;
	if (!timingSafeEqual(a, b)) return false;
	return Number(expires) > Date.now();
}

export function checkPassword(candidate: string | undefined): boolean {
	if (!candidate) return false;
	const expected = secret();
	const a = Buffer.from(candidate);
	const b = Buffer.from(expected);
	if (a.length !== b.length) {
		timingSafeEqual(a, a);
		return false;
	}
	return timingSafeEqual(a, b);
}

export const adminCookie = {
	name: COOKIE_NAME,
	maxAge: SESSION_TTL_SECONDS
};
