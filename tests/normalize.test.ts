import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { normalizePost, extractLinks, isLikelyApplyUrl, splitRoleEntries } from '../src/ingest/normalize.js';
import { contentHash, dedupeKey } from '../src/ingest/dedupe.js';

const SAMPLE = `Company name: Discover Dollar
Role: AI Engineer Intern
Batch Eligible: 2027, 2028 & 2029
Location: Bangalore
Work Mode: Remote
Experience: 0-1 years
Apply here: https://forms.gle/abcdefgh
`;

test('extractLinks finds and tidies URLs', () => {
	const links = extractLinks('see https://forms.gle/abc123. and https://x.test/path,');
	assert.deepEqual(links, ['https://forms.gle/abc123', 'https://x.test/path']);
});

test('isLikelyApplyUrl accepts known hosts and rejects unknown ones', () => {
	assert.equal(isLikelyApplyUrl('https://forms.gle/abc'), true);
	assert.equal(isLikelyApplyUrl('https://www.linkedin.com/jobs/view/1'), true);
	assert.equal(isLikelyApplyUrl('https://unknown-random-site.test/jobs'), false);
	assert.equal(isLikelyApplyUrl('javascript:alert(1)'), false);
});

test('normalizePost extracts the labelled fields', () => {
	const job = normalizePost(SAMPLE);
	assert.equal(job.company, 'Discover Dollar');
	assert.equal(job.title, 'AI Engineer Intern');
	assert.equal(job.location, 'Bangalore');
	assert.equal(job.work_mode, 'Remote');
	assert.equal(job.experience, '0-1 years');
	assert.equal(job.eligibility, null);
	assert.equal(job.batch_years, '2027, 2028, 2029');
	assert.equal(job.apply_url, 'https://forms.gle/abcdefgh');
	assert.equal(job.needsReview, false);
});

test('normalizePost flags a post with no apply url for review', () => {
	const job = normalizePost('Company name: Acme\nRole: Intern');
	assert.equal(job.needsReview, true);
	assert.ok(job.reviewReasons.includes('no_apply_url'));
});

test('normalizePost flags a post with no recognisable job fields', () => {
	const job = normalizePost('just some text about nothing in particular');
	assert.equal(job.needsReview, true);
	assert.ok(job.reviewReasons.includes('no_job_fields_recognised'));
});

test('normalizePost never invents a title or company', () => {
	const job = normalizePost('Company name: Acme\nRole: Intern\nhttps://forms.gle/x');
	assert.equal(job.title, 'Intern');
	assert.equal(job.company, 'Acme');
	const empty = normalizePost('https://forms.gle/x');
	assert.equal(empty.title, null);
	assert.equal(empty.company, null);
});

test('contentHash is stable and sensitive to content', () => {
	assert.equal(contentHash({ text: 'abc' }), contentHash({ text: 'abc' }));
	assert.notEqual(contentHash({ text: 'abc' }), contentHash({ text: 'abd' }));
});

test('dedupeKey requires a company and a title or apply url', () => {
	// company alone is not enough
	assert.equal(dedupeKey({ company: 'Acme' }), null);
	// no company is not enough
	assert.equal(dedupeKey({ title: 'Intern', applyUrl: 'https://x.test' }), null);
	// company + title is enough
	assert.ok(dedupeKey({ company: 'Acme', title: 'Intern' }));
	const key = dedupeKey({ company: 'Acme', title: 'Intern', applyUrl: 'https://x.test' });
	assert.ok(key);
	assert.equal(key!.length, 64);
});

test('dedupeKey separates the same role advertised for a different batch', () => {
	const a = dedupeKey({ company: 'Acme', title: 'Intern', batchYears: '2027' });
	const b = dedupeKey({ company: 'Acme', title: 'Intern', batchYears: '2028' });
	assert.notEqual(a, b);
});

test('dedupeKey collapses the same vacancy with different wording', () => {
	const a = dedupeKey({ company: 'Acme', title: 'Intern', location: 'Remote', applyUrl: 'https://forms.gle/x' });
	const b = dedupeKey({ company: 'acme ', title: 'intern', location: 'remote', applyUrl: 'https://forms.gle/x' });
	assert.equal(a, b);
});

test('dedupeKey separates different vacancies at the same company', () => {
	const a = dedupeKey({ company: 'Acme', title: 'Intern', applyUrl: 'https://forms.gle/x' });
	const b = dedupeKey({ company: 'Acme', title: 'Engineer', applyUrl: 'https://forms.gle/x' });
	assert.notEqual(a, b);
});

// --- rules derived from the real posts in the target channel ---------------

const HPE_POST = `Company name: HPE
Role: Software Engineering Intern
Batch Eligible: 2027, 2028 & 2029 graduates

Apply Link: https://careers.hpe.com/us/en/job/1211844/Intern?utm_source=KrishanKumarLinkedin

Join for more opportunities: https://whatsapp.com/channel/0029Vb75YXBIt5rn6dTs2D2i`;

test('a URL on an "Apply Link:" line is used even for an unknown host', () => {
	const job = normalizePost(HPE_POST);
	assert.equal(job.apply_url, 'https://careers.hpe.com/us/en/job/1211844/Intern?utm_source=KrishanKumarLinkedin');
	assert.equal(job.title, 'Software Engineering Intern');
	assert.equal(job.company, 'HPE');
	assert.equal(job.batch_years, '2027, 2028, 2029');
	assert.equal(job.needsReview, false);
});

test('a channel link is never treated as an apply link', () => {
	const job = normalizePost(HPE_POST);
	assert.ok(!String(job.apply_url).includes('whatsapp.com/channel'));
});

test('work mode is taken out of the location', () => {
	const job = normalizePost('Company name: micro1\nRole: Intern\nLocation: Remote (Work From Home)');
	assert.equal(job.work_mode, 'Remote');
	assert.ok(!String(job.location).toLowerCase().includes('remote'));
});

test('salary is captured', () => {
	const job = normalizePost('Company name: micro1\nRole: Intern\nSalary: $60 - $120 per hour');
	assert.equal(job.salary, '$60 - $120 per hour');
});

test('"Students eligible" is recognised as eligibility', () => {
	const job = normalizePost(
		'Company Name: Reliance\nRole: GET Program\nStudents eligible: Freshers with full-time BTech/BE degrees graduating in 2027'
	);
	assert.ok(String(job.eligibility).startsWith('Freshers with full-time'));
});

test('a textual batch is kept and not flagged', () => {
	const job = normalizePost('Company name: micro1\nRole: Intern\nBatch Eligible: All college students + Working Professionals');
	assert.equal(job.batch_years, 'All college students + Working Professionals');
	assert.equal(job.reviewReasons.includes('batch_not_year_based'), false);
});

test('a multi-opening post is split into one entry per role', () => {
	const post = `micro1 is hiring for below roles

Company name: micro1
Batch Eligible: All college students + Working Professionals
Location: Remote (Work From Home)

Coding Puzzle Solver/ DSA Solver (Referral Link): https://bit.ly/482EV0d

AI Product Evaluator (Referral Link): https://bit.ly/4zLyZVq

Software Engineer (Referral Link): https://bit.ly/abc123`;
	const entries = splitRoleEntries(post);
	assert.equal(entries.length, 3);
	assert.equal(entries[0]!.title, 'Coding Puzzle Solver/ DSA Solver');
	assert.equal(entries[0]!.applyUrl, 'https://bit.ly/482EV0d');
	assert.equal(entries[2]!.title, 'Software Engineer');
});

test('a single-role post is not split', () => {
	assert.equal(splitRoleEntries(HPE_POST).length, 0);
});
