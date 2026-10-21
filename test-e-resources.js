'use strict';

/**
 * Test E — lightweight resource usage.
 *
 * Runs the listener with no browser, no large history fetch, and no full
 * message bodies printed, then samples RSS/CPU over time.
 *
 * On Linux the process's own /proc/<pid>/status and /proc/<pid>/stat are used,
 * so the numbers are for this Node process only (not the whole shell).
 */

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { Connection } = require('./src/lib/connect');
const { resolveChannel, isNewsletterKey } = require('./src/lib/newsletter');

const RUN_MS = Number(process.env.E_RUN_MINUTES || 20) * 60 * 1000;
const SAMPLE_MS = 10000;

function readMem() {
	try {
		const status = fs.readFileSync('/proc/self/status', 'utf8');
		const m = status.match(/VmRSS:\s+(\d+)\s+kB/);
		return m ? Number(m[1]) / 1024 : null; // MB
	} catch {
		return null;
	}
}

function readCpu() {
	try {
		const stat = fs.readFileSync('/proc/self/stat', 'utf8');
		const parts = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
		// utime (idx 11) and stime (idx 12) after the comm field
		const utime = Number(parts[11]);
		const stime = Number(parts[12]);
		const clk = 100; // USER_HZ
		return (utime + stime) / clk; // cumulative CPU seconds
	} catch {
		return null;
	}
}

(async () => {
	const out = {
		test: 'E — resource usage',
		startedAt: new Date().toISOString(),
		runMinutes: RUN_MS / 60000,
		sampleIntervalSec: SAMPLE_MS / 1000,
		historyBatchSize: 0,
		idleRssMb: null,
		peakRssMb: null,
		idleCpuPct: null,
		peakCpuPct: null,
		durationSec: null,
		memoryGrowthMb: null,
		eventsHandled: 0,
		newsletterPostsHandled: 0,
		nonNewsletterMessagesIgnored: 0,
		samples: [],
		error: null
	};

	const conn = new Connection({ autoReconnect: true });
	const t0 = Date.now();
	let lastCpu = readCpu();
	let lastCpuAt = Date.now();
	let peakCpuPct = 0;

	try {
		await conn.start();
		await conn.waitForOpen(300000);
		const res = await resolveChannel(conn.sock, process.env.WHATSAPP_CHANNEL_URL);
		out.channelResolved = !!res.metadata;
		console.log('[E] connected, channel resolved:', out.channelResolved);

		conn.on('messages.upsert', ({ messages }) => {
			for (const m of messages || []) {
				out.eventsHandled += 1;
				if (isNewsletterKey(m.key)) out.newsletterPostsHandled += 1;
				else out.nonNewsletterMessagesIgnored += 1;
			}
		});

		const deadline = Date.now() + RUN_MS;
		let idleSamples = [];
		while (Date.now() < deadline) {
			await new Promise(r => setTimeout(r, SAMPLE_MS));
			const rss = readMem();
			const cpu = readCpu();
			const now = Date.now();
			const cpuPct = cpu !== null && lastCpu !== null ? ((cpu - lastCpu) / ((now - lastCpuAt) / 1000)) * 100 : null;
			lastCpu = cpu;
			lastCpuAt = now;
			if (rss !== null) {
				out.peakRssMb = Math.max(out.peakRssMb || 0, rss);
				out.samples.push({ at: new Date().toISOString(), rssMb: Math.round(rss * 10) / 10, cpuPct: cpuPct === null ? null : Math.round(cpuPct * 10) / 10 });
				idleSamples.push(rss);
			}
			if (cpuPct !== null) peakCpuPct = Math.max(peakCpuPct, cpuPct);
		}
		out.idleRssMb = idleSamples.length ? Math.round(Math.min(...idleSamples) * 10) / 10 : null;
		out.peakCpuPct = Math.round(peakCpuPct * 10) / 10;
		out.idleCpuPct = out.samples.length ? out.samples[out.samples.length - 1].cpuPct : null;
		if (idleSamples.length) {
			out.memoryGrowthMb = Math.round((Math.max(...idleSamples) - Math.min(...idleSamples)) * 10) / 10;
		}
	} catch (err) {
		out.error = err?.message || String(err);
		console.error('[E] FAILED:', out.error);
	} finally {
		out.durationSec = Math.round((Date.now() - t0) / 1000);
		await conn.stop();
	}

	out.finishedAt = new Date().toISOString();
	fs.mkdirSync(path.resolve(__dirname, 'test-output'), { recursive: true });
	fs.writeFileSync(path.resolve(__dirname, 'test-output', 'test-e.json'), JSON.stringify(out, null, 2));
	console.log('\n===== TEST E RESULT =====');
	console.log(
		JSON.stringify(
			{
				...out,
				samples: `${out.samples.length} samples (first 3: ${JSON.stringify(out.samples.slice(0, 3))})`
			},
			null,
			2
		)
	);
	process.exit(0);
})();
