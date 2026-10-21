'use strict';
/**
 * Does the `before` cursor actually page backwards through a channel's
 * history? (The upstream fix maps the `since` argument onto a `before`
 * attribute on the <messages> request.)
 */
const { Connection } = require('./src/lib/connect');
const { resolveChannel, fetchNewsletterMessages } = require('./src/lib/newsletter');

(async () => {
  const conn = new Connection({ autoReconnect: false, logLevel: 'error' });
  await conn.start();
  await conn.waitForOpen(120000);

  const jid = '120363328942292199@newsletter'; // Job Opportunities - Freshers & Experienced
  let cursor = null;
  const seen = new Set();
  const pages = [];

  for (let page = 0; page < 4; page++) {
    const { messages } = await fetchNewsletterMessages(conn.sock, jid, 20, cursor);
    const ids = messages.map(m => m.serverId).filter(Boolean);
    const fresh = ids.filter(i => !seen.has(i));
    fresh.forEach(i => seen.add(i));
    const oldest = messages[messages.length - 1];
    pages.push({
      page,
      requested: 20,
      got: messages.length,
      fresh: fresh.length,
      firstId: ids[0] ?? null,
      lastId: ids[ids.length - 1] ?? null,
      oldestTs: oldest?.timestampIso ?? null
    });
    console.log(JSON.stringify(pages[pages.length - 1]));
    if (!messages.length || !fresh.length || !oldest?.serverId) break;
    cursor = oldest.serverId;
  }

  console.log('\ntotal unique server_ids across pages:', seen.size);
  const sorted = [...seen].map(Number).sort((a, b) => a - b);
  console.log('server_id range:', sorted[0], '..', sorted[sorted.length - 1]);
  await conn.stop();
  process.exit(0);
})();
