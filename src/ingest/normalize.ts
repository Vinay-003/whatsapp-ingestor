/**
 * Deterministic normalization of a channel post into job record(s).
 *
 * No paid LLM and no inference: the source posts follow a regular
 * "Label: value" shape, so fields are extracted with explicit rules and
 * anything not confidently recognised is left empty for review rather than
 * guessed.
 *
 * Real shapes seen in the target channel:
 *   Company name: Discover Dollar
 *   Role: AI Engineer Intern
 *   Batch Eligible: 2027, 2028 & 2029
 *   Location: Remote (Work From Home)
 *   Apply Link: https://careers.hpe.com/...
 *   Students eligible: Freshers with full-time BTech/BE degrees graduating in 2027
 *   Salary: $60 - $120 per hour
 *
 * and, for posts that advertise several openings at once:
 *   Coding Puzzle Solver/ DSA Solver (Referral Link): https://bit.ly/...
 *   AI Product Evaluator (Referral Link): https://bit.ly/...
 */

export type NormalizedJob = {
	title: string | null;
	company: string | null;
	location: string | null;
	work_mode: string | null;
	employment_type: string | null;
	eligibility: string | null;
	experience: string | null;
	batch_years: string | null;
	salary: string | null;
	description: string | null;
	apply_url: string | null;
	deadline: string | null;
	/** True when some field looked present but could not be parsed safely. */
	needsReview: boolean;
	/** Which fields triggered needsReview. */
	reviewReasons: string[];
};

export type NormalizeOptions = {
	/** Only treat URLs from these hosts as application links. Empty = any host. */
	applyUrlHosts?: string[];
	/** Maximum length of a stored description. */
	maxDescriptionLength?: number;
};

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;

/** Hosts that are commonly used for job applications. */
const APPLY_HOSTS = [
	'forms.gle',
	'google.com',
	'linkedin.com',
	'lnkd.in',
	'naukri.com',
	'ambitionbox.com',
	'indeed.com',
	'greenhouse.io',
	'lever.co',
	'workday.com',
	'myworkdayjobs.com',
	'jobvite.com',
	'zohoforms.com',
	'microsoft.com',
	'jotform.com',
	'formsubmit.co',
	'formsmulti.com',
	'registrationforms.com',
	'workable.com',
	'breezy.hr',
	'ashbyhq.com',
	'notinboard.com',
	'teampubs.com',
	'kontactnow.com',
	'surveymonkey.com',
	'frm.io',
	'typeform.com',
	'bit.ly',
	'cutt.ly',
	'apply.workindia.com',
	'job Hai',
	'jobhai.com',
	'apple.com',
	'microsoft365.com',
	'hp.com',
	'hpe.com',
	'honeywell.com',
	'ibm.com',
	'oracle.com',
	'intel.com',
	'amazon.com',
	'adobe.com',
	'salesforce.com',
	'accenture.com',
	'cognizant.com',
	'tcs.com',
	'wipro.com',
	'infosys.com',
	'hcltech.com',
	'lti.com',
	'capgemini.com',
	'airbnb.com',
	'stripe.com',
	'deloitte.com',
	'pwc.com',
	'ey.com',
	'kpmg.com',
	'netflix.com',
	'databricks.com',
	'coinbase.com',
	'zerodha.com',
	'razorpay.com',
	'meesho.com',
	'flipkart.com',
	'instacart.com',
	'fidelity.com',
	'jpmorgan.com',
	'goldmansachs.com',
	'ubs.com',
	'morganstanley.com'
];

/** Hosts that are definitely NOT apply links. */
const NEVER_APPLY_HOSTS = ['whatsapp.com', 'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'linkedin.com/share'];

function tidyUrl(raw: string): string {
	return raw.replace(/[.,;:!?)\]}'"]+$/, '');
}

export function extractLinks(text: string): string[] {
	const found = new Set<string>();
	for (const match of text.matchAll(URL_RE)) {
		const url = tidyUrl(match[0]);
		if (url) found.add(url);
	}
	return [...found];
}

function hostOf(url: string): string | null {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return null;
	}
}

/**
 * Decide whether a URL is plausibly an application/registration link.
 *
 * Two rules, in order:
 *  1. The URL appeared on a line whose label says it is an application link.
 *     This is the strongest signal and works for any host (careers.hpe.com,
 *     ag.wd3.myworkdayjobs.com, ...) without needing a host list.
 *  2. Otherwise the host must be a well-known job board or ATS.
 */
export function isLikelyApplyUrl(url: string, allowedHosts: string[] = []): boolean {
	const host = hostOf(url);
	if (!host) return false;
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
	if (NEVER_APPLY_HOSTS.some(h => host === h || host.endsWith(`.${h}`))) return false;
	if (allowedHosts.some(h => host === h.toLowerCase() || host.endsWith(`.${h.toLowerCase()}`))) return true;
	return APPLY_HOSTS.some(h => host === h || host.endsWith(`.${h}`));
}

/**
 * A URL that the post itself labels as an application link. The label is the
 * signal, so an unknown host is fine — but a link to the channel itself or to
 * a social profile never is.
 */
function isLabelledApplyUrl(url: string): boolean {
	const host = hostOf(url);
	if (!host) return false;
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
	} catch {
		return false;
	}
	return !NEVER_APPLY_HOSTS.some(h => host === h || host.endsWith(`.${h}`));
}

/** Labels that explicitly mark the URL on the same line as an application link. */
const APPLY_LABEL_RE = /^\s*(apply\s*link|apply\s*here|apply|application\s*link|registration\s*link|register\s*now|sign\s*up|apply\s*now|job\s*link|apply\s*at|referral\s*link|apply\s*via)\b\s*[:\-]/i;

const LABEL_PATTERNS: { field: keyof NormalizedJob; patterns: RegExp[] }[] = [
	{ field: 'company', patterns: [/^company\s*name\s*[:\-]\s*(.+)$/i, /^company\s*[:\-]\s*(.+)$/i] },
	{
		field: 'title',
		patterns: [/^role\s*[:\-]\s*(.+)$/i, /^job\s*role\s*[:\-]\s*(.+)$/i, /^position\s*[:\-]\s*(.+)$/i, /^title\s*[:\-]\s*(.+)$/i]
	},
	{ field: 'location', patterns: [/^location\s*[:\-]\s*(.+)$/i, /^city\s*[:\-]\s*(.+)$/i] },
	{ field: 'work_mode', patterns: [/^work\s*mode\s*[:\-]\s*(.+)$/i, /^mode\s*[:\-]\s*(.+)$/i, /^work\s*from\s*home\s*[:\-]\s*(.+)$/i] },
	{
		field: 'employment_type',
		patterns: [/^(employment|job)\s*type\s*[:\-]\s*(.+)$/i, /^type\s*[:\-]\s*(.+)$/i, /^internship\s*type\s*[:\-]\s*(.+)$/i, /^category\s*[:\-]\s*(.+)$/i]
	},
	{
		field: 'eligibility',
		patterns: [
			/^eligibility\s*[:\-]\s*(.+)$/i,
			/^eligible\s*[:\-]\s*(.+)$/i,
			/^students?\s+eligible\s*[:\-]\s*(.+)$/i,
			/^who\s+can\s+apply\s*[:\-]\s*(.+)$/i,
			/^eligibility\s*criteria\s*[:\-]\s*(.+)$/i
		]
	},
	{ field: 'experience', patterns: [/^experience\s*[:\-]\s*(.+)$/i, /^exp\s*[:\-]\s*(.+)$/i, /^experience\s*required\s*[:\-]\s*(.+)$/i] },
	{
		field: 'batch_years',
		patterns: [/^batch\s*eligible\s*[:\-]\s*(.+)$/i, /^batch\s*[:\-]\s*(.+)$/i, /^batch\s*years\s*[:\-]\s*(.+)$/i, /^graduating\s*batch\s*[:\-]\s*(.+)$/i]
	},
	{ field: 'salary', patterns: [/^salary\s*[:\-]\s*(.+)$/i, /^ctc\s*[:\-]\s*(.+)$/i, /^package\s*[:\-]\s*(.+)$/i, /^pay\s*[:\-]\s*(.+)$/i] },
	{ field: 'deadline', patterns: [/^(last\s*date|apply\s*by|deadline|closing\s*date|last\s*date\s+to\s+apply)\s*[:\-]\s*(.+)$/i] }
];

function clean(value: string): string {
	return value.replace(/\s+/g, ' ').replace(/^\*+|\*+$/g, '').trim();
}

/** Extract 4-digit years (graduation/batch) from a phrase. */
function extractYears(value: string): string | null {
	const years = [...value.matchAll(/\b(20[0-9]{2})\b/g)].map(m => m[1]!);
	const unique = [...new Set(years)];
	return unique.length ? unique.join(', ') : null;
}

/** Parse a deadline into YYYY-MM-DD when unambiguous. */
function parseDeadline(value: string): string | null {
	const iso = value.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
	if (iso) {
		const [, y, m, d] = iso;
		return `${y}-${m!.padStart(2, '0')}-${d!.padStart(2, '0')}`;
	}
	const dmy = value.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](20\d{2})\b/);
	if (dmy) {
		const [, d, m, y] = dmy;
		return `${y}-${m!.padStart(2, '0')}-${d!.padStart(2, '0')}`;
	}
	return null;
}

const WORK_MODE_PATTERNS: { mode: string; re: RegExp }[] = [
	{ mode: 'Remote', re: /\b(remote|work\s*from\s*home|wfh|fully\s*remote)\b/i },
	{ mode: 'Hybrid', re: /\bhybrid\b/i },
	{ mode: 'On-site', re: /\b(on[-\s]?site|in[-\s]?office|in[-\s]?person)\b/i }
];

/** Split "Remote (Work From Home)" into a work mode and a cleaner location. */
function splitLocationAndWorkMode(location: string | null, explicitWorkMode: string | null) {
	let workMode = explicitWorkMode ?? null;
	let place = location;
	if (place) {
		for (const { mode, re } of WORK_MODE_PATTERNS) {
			if (re.test(place)) {
				if (!workMode) workMode = mode;
				place = place.replace(re, '').replace(/[(),]/g, ' ').replace(/\s+/g, ' ').trim();
			}
		}
	}
	return { location: place && place.length > 1 ? place : null, workMode };
}

/** One "Role (Referral Link): url" entry in a multi-opening post. */
export type RoleEntry = { title: string; applyUrl: string | null };

/**
 * Detect posts that advertise several openings, each on its own line with a
 * link: "Coding Puzzle Solver (Referral Link): https://…".
 */
export function splitRoleEntries(text: string): RoleEntry[] {
	const entries: RoleEntry[] = [];
	for (const rawLine of (text ?? '').split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		const match = line.match(/^(.{3,120}?)\s*\((?:referral|apply|registration|job)\s*link\)\s*[:\-]\s*(\S+)\s*$/i);
		if (!match) continue;
		const title = clean(match[1]!);
		const url = tidyUrl(match[2]!);
		if (title) entries.push({ title, applyUrl: /^https?:\/\//i.test(url) ? url : null });
	}
	return entries;
}

/**
 * Normalize a raw post into a job record.
 * Never throws: unrecognised content yields a `needsReview` record.
 */
export function normalizePost(rawText: string, options: NormalizeOptions = {}): NormalizedJob {
	const maxLen = options.maxDescriptionLength ?? 4000;
	const allowedHosts = options.applyUrlHosts ?? [];
	const reviewReasons: string[] = [];

	const text = (rawText ?? '').replace(/\r\n/g, '\n');
	const lines = text
		.split('\n')
		.map(l => l.trim())
		.filter(Boolean);

	const values: Partial<Record<keyof NormalizedJob, string>> = {};
	const usedLines = new Set<number>();

	for (const { field, patterns } of LABEL_PATTERNS) {
		for (let i = 0; i < lines.length; i += 1) {
			if (usedLines.has(i)) continue;
			const line = lines[i]!;
			for (const pattern of patterns) {
				const match = line.match(pattern);
				if (match) {
					const value = clean(match[1] ?? '');
					if (value) {
						values[field] = value;
						usedLines.add(i);
					}
					break;
				}
			}
			if (values[field]) break;
		}
	}

	// --- apply URL -------------------------------------------------------
	// A URL on a line explicitly labelled as an application link wins; then
	// any other link that passes the host test.
	let applyUrl: string | null = null;
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i]!;
		if (!APPLY_LABEL_RE.test(line)) continue;
		const url = line.match(URL_RE)?.[0];
		if (!url) continue;
		const tidy = tidyUrl(url);
		if (isLabelledApplyUrl(tidy)) {
			applyUrl = tidy;
			usedLines.add(i);
			break;
		}
	}
	if (!applyUrl) {
		const candidates = extractLinks(text).filter(l => isLikelyApplyUrl(l, allowedHosts));
		applyUrl = candidates[0] ?? null;
	}
	const links = extractLinks(text);
	if (links.length > 0 && !applyUrl) {
		reviewReasons.push('links_present_but_no_recognised_apply_url');
	}

	// --- batch years -----------------------------------------------------
	let batchYears = values.batch_years ?? null;
	if (batchYears) {
		const years = extractYears(batchYears);
		if (years) {
			batchYears = years;
		} else if (/\d/.test(batchYears)) {
			// Digits that are not years: probably parseable but risky.
			reviewReasons.push('batch_not_year_based');
		}
		// A purely textual batch ("All college students") is kept as-is.
	}

	// --- deadline --------------------------------------------------------
	let deadline: string | null = null;
	if (values.deadline) {
		deadline = parseDeadline(values.deadline);
		if (!deadline) reviewReasons.push('deadline_unparsed');
	}

	// --- location / work mode --------------------------------------------
	const { location, workMode } = splitLocationAndWorkMode(values.location ?? null, values.work_mode ?? null);

	// --- description ------------------------------------------------------
	const descriptionLines = lines.filter((_, i) => !usedLines.has(i) && !URL_RE.test(lines[i]!));
	const description = clean(descriptionLines.join('\n')).slice(0, maxLen) || null;

	// --- completeness -----------------------------------------------------
	const recognised = ['company', 'title', 'eligibility', 'batch_years'].filter(f => values[f as keyof NormalizedJob]);
	if (recognised.length === 0 && !applyUrl) {
		reviewReasons.push('no_job_fields_recognised');
	}
	if (!values.title && !values.company) {
		reviewReasons.push('missing_title_and_company');
	}
	if (!applyUrl) {
		reviewReasons.push('no_apply_url');
	}

	return {
		title: values.title ?? null,
		company: values.company ?? null,
		location,
		work_mode: workMode,
		employment_type: values.employment_type ?? null,
		eligibility: values.eligibility ?? null,
		experience: values.experience ?? null,
		batch_years: batchYears,
		salary: values.salary ?? null,
		description,
		apply_url: applyUrl,
		deadline,
		needsReview: reviewReasons.length > 0,
		reviewReasons
	};
}
