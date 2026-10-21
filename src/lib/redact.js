'use strict';

/**
 * Redaction helpers. The test runbook requires that logs and reports contain
 * method names, statuses, counts, IDs, timestamps and sanitized errors only.
 * Never print credentials, auth payloads, phone numbers or full post bodies.
 */

const PHONE_RE = /(\+?\d[\d\s().-]{7,}\d)/g;
const LONG_TOKEN_RE = /\b[A-Za-z0-9_-]{40,}\b/g;
const LID_RE = /@lid\b/gi;

/** Redact anything that looks like a phone number. */
function redactPhone(value) {
	if (value === undefined || value === null) return value;
	return String(value).replace(PHONE_RE, '[phone]');
}

/** Redact long opaque tokens (keys, session ids, invite codes are kept separate). */
function redactToken(value) {
	if (value === undefined || value === null) return value;
	return String(value).replace(LONG_TOKEN_RE, '[token]');
}

/** Sanitize an error into a short, safe, single-line string. */
function sanitizeError(err) {
	if (!err) return 'none';
	const raw =
		typeof err === 'string'
			? err
			: err.stack || err.message || JSON.stringify(err) || String(err);
	const firstLine = String(raw).split('\n').slice(0, 3).join(' | ');
	return redactPhone(firstLine).slice(0, 400);
}

/**
 * Produce a short, non-identifying preview of post text.
 * Keeps the first words only and strips anything that looks like a link or number.
 */
function previewText(text, maxChars = 80) {
	if (!text) return '';
	let s = String(text).replace(/\s+/g, ' ').trim();
	s = s.replace(/https?:\/\/\S+/gi, '[link]');
	s = s.replace(PHONE_RE, '[phone]');
	if (s.length > maxChars) s = `${s.slice(0, maxChars)}...`;
	return s;
}

/** Short hash for comparing values without revealing them. */
function shortHash(value) {
	if (value === undefined || value === null) return null;
	// eslint-disable-next-line no-undef
	const crypto = require('node:crypto');
	return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

module.exports = { redactPhone, redactToken, sanitizeError, previewText, shortHash };
