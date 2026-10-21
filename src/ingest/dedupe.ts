/**
 * Deduplication.
 *
 * Two independent keys are produced:
 *  - `contentHash`  : hash of the normalized text + the apply URL. Identical
 *                      reposts of the same post collapse even if the source
 *                      assigned a new message id.
 *  - `dedupeKey`    : hash of the business identity (company + title +
 *                      location + apply URL). This is what stops the same
 *                      vacancy being published twice when it is reposted with
 *                      different wording.
 *
 * A dedupe key is only produced when the identity is confident enough
 * (company AND (title OR apply url)); otherwise the record is left without one
 * so that a legitimate second listing is not silently dropped.
 */

import { createHash } from 'node:crypto';

export type DedupeInput = {
	company?: string | null;
	title?: string | null;
	location?: string | null;
	applyUrl?: string | null;
	batchYears?: string | null;
	text?: string | null;
};

function norm(value: string | null | undefined): string {
	return (value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function sha(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

/** Hash of the full post content, used to detect exact reposts. */
export function contentHash(input: DedupeInput): string {
	return sha(norm(input.text ?? ''));
}

/**
 * Business-identity key, or null when the identity is not confident enough.
 * Returns a 64-char hex string.
 *
 * A key requires a company plus a title or an apply URL. The batch years are
 * included so that the same role advertised for a different batch is not
 * merged into one listing.
 */
export function dedupeKey(input: DedupeInput): string | null {
	const company = norm(input.company);
	const title = norm(input.title);
	const location = norm(input.location);
	const applyUrl = norm(input.applyUrl);
	const batchYears = norm(input.batchYears);

	const hasCompany = company.length > 0;
	const hasTitle = title.length > 0;
	const hasApply = applyUrl.length > 0;
	if (!hasCompany || (!hasTitle && !hasApply)) return null;

	// The apply URL is the strongest signal when present; include the text
	// fields as well so that the same URL reused for a different role is
	// still distinguishable.
	const parts = [company, title, location, batchYears, hasApply ? applyUrl : ''];
	return sha(parts.join('|'));
}
