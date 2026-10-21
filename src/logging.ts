/**
 * Redacted structured logging.
 *
 * Rules enforced here (see the local test's safety notes):
 *  - never print credentials, session payloads, QR codes or secret values
 *  - never print full post bodies; only counts, ids, timestamps and short
 *    redacted previews
 *  - phone numbers and long opaque tokens are masked
 */

/**
 * Redaction rules.
 *
 * The goal is to hide *secrets* (phone numbers, tokens, URL credentials)
 * without mangling the identifiers an operator needs to debug with: channel
 * JIDs, UUIDs, message ids and reason codes.
 *
 * A phone number is at most 15 digits (E.164), so a longer digit run — such
 * as a channel JID like `120363184225204114@newsletter` — is not a phone
 * number. Digits inside a UUID are not standalone either, so word-boundary
 * anchors are used.
 */
const URL_CREDENTIALS_RE = /(\w+:\/\/)([^:@/\s]+):([^@/\s]+)@/g;
const DIGIT_RUN_RE = /(?<![\w-])\+?\d[\d\s().-]{5,20}\d(?![\w-])/g;
/** A token that looks random: long, mixed case, contains digits. */
const SECRET_TOKEN_RE = /(?<![\w-])[A-Za-z0-9+/=]{40,}(?![\w-])/g;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold = LEVELS.info;

export function setLogLevel(level: string): void {
	if (level in LEVELS) threshold = LEVELS[level as LogLevel];
}

function maskPhoneRuns(text: string): string {
	return text.replace(DIGIT_RUN_RE, match => {
		const digits = match.replace(/\D/g, '').length;
		// 7..15 digits is a plausible phone number; more is an identifier.
		if (digits < 7 || digits > 15) return match;
		return '[phone]';
	});
}

function maskSecretTokens(text: string): string {
	return text.replace(SECRET_TOKEN_RE, match => {
		if (UUID_RE.test(match)) return match;
		const hasUpper = /[A-Z]/.test(match);
		const hasLower = /[a-z]/.test(match);
		const hasDigit = /\d/.test(match);
		// Random-looking (mixed case + digits) -> a secret. A long word such as
		// "links_present_but_no_recognised_apply_url" is not.
		if (hasUpper && hasLower && hasDigit) return '[token]';
		return match;
	});
}

/** Mask anything that looks like a phone number, token or URL credential. */
export function redact(value: unknown): string {
	if (value === null || value === undefined) return String(value);
	return maskSecretTokens(maskPhoneRuns(String(value).replace(URL_CREDENTIALS_RE, '$1[redacted]:[redacted]@')));
}

/** Short, non-identifying preview of free text. */
export function preview(text: string | null | undefined, maxChars = 80): string | null {
	if (!text) return null;
	let s = String(text).replace(/\s+/g, ' ').trim();
	s = s.replace(/https?:\/\/\S+/gi, '[link]');
	if (s.length > maxChars) s = `${s.slice(0, maxChars)}…`;
	return s;
}

/** Recursively redact a value for logging. */
function sanitize(value: unknown, depth = 0): unknown {
	if (depth > 4) return '[deep]';
	if (value === null || value === undefined) return value;
	if (typeof value === 'string') return redact(value);
	if (typeof value === 'number' || typeof value === 'boolean') return value;
	if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `[binary ${value.length}b]`;
	if (value instanceof Date) return value.toISOString();
	if (Array.isArray(value)) return value.slice(0, 20).map(v => sanitize(v, depth + 1));
	if (typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			out[k] = sanitize(v, depth + 1);
		}
		return out;
	}
	return redact(value);
}

function emit(level: LogLevel, event: string, fields?: Record<string, unknown>): void {
	if (LEVELS[level] < threshold) return;
	const line = {
		t: new Date().toISOString(),
		level,
		event,
		...(fields ? (sanitize(fields) as Record<string, unknown>) : {})
	};
	const out = JSON.stringify(line);
	if (level === 'error' || level === 'warn') process.stderr.write(`${out}\n`);
	else process.stdout.write(`${out}\n`);
}

export const log = {
	debug: (event: string, fields?: Record<string, unknown>) => emit('debug', event, fields),
	info: (event: string, fields?: Record<string, unknown>) => emit('info', event, fields),
	warn: (event: string, fields?: Record<string, unknown>) => emit('warn', event, fields),
	error: (event: string, fields?: Record<string, unknown>) => emit('error', event, fields)
};

/** Sanitize an error into a short single-line string safe for logs. */
export function errorMessage(err: unknown): string {
	if (!err) return 'unknown';
	const raw =
		err instanceof Error
			? err.message
			: typeof err === 'string'
				? err
				: JSON.stringify(err);
	return redact(String(raw).split('\n')[0]?.slice(0, 300));
}

/** Extract a machine-readable status code when the error carries one. */
export function errorCode(err: unknown): string | null {
	const anyErr = err as { output?: { statusCode?: number }; statusCode?: number } | undefined;
	return anyErr?.output?.statusCode ? String(anyErr.output.statusCode) : (anyErr?.statusCode ? String(anyErr.statusCode) : null);
}
