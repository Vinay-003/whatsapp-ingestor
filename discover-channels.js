'use strict';
/**
 * Enumerate every newsletter/channel the linked account can see.
 * Channel discovery comes from app-state sync ('chats.upsert'), which is how
 * the WhatsApp Web client itself learns about followed channels.
 */
const { Connection } = require('./src/lib/connect');
const { flattenMetadata } = require('./src/lib/newsletter');

(async () => {
  const conn = new Connection({ autoReconnect: false, logLevel: 'debug' });
  await conn.start();
  await conn.waitForOpen(120000);
  const found = new Map();
  const jids = new Set();

  const note = (jid, name) => {
    jids.add(jid);
    if (!found.has(jid)) found.set(jid, { jid, chatName: name ?? null });
    else if (name && !found.get(jid).chatName) found.get(jid).chatName = name;
  };

  conn.on('chats.upsert', chats => {
    for (const c of chats || []) {
      if (String(c.id || '').endsWith('@newsletter')) note(c.id, c.name || c.subject || null);
    }
  });
  conn.on('messaging-history.set', payload => {
    for (const c of payload?.chats ?? []) {
      if (String(c?.id || '').endsWith('@newsletter')) note(c.id, c.name || null);
    }
  });
  conn.on('messaging-history.status', st => console.log('[sync] status', JSON.stringify(st)));
  conn.on('chats.update', ups => {
    for (const u of ups || []) {
      if (String(u.id || '').endsWith('@newsletter')) note(u.id, u.name || u.subject || null);
    }
  });

  // Give the app-state sync time to deliver the chat list.
  const deadline = Date.now() + 75_000;
  while (Date.now() < deadline) await new Promise(r => setTimeout(r, 1000));

  console.log(`\n=== ${jids.size} newsletter chat(s) seen by the linked device ===`);
  for (const jid of jids) {
    let meta = null;
    try { meta = await conn.sock.newsletterMetadata('jid', jid); } catch { /* ignore */ }
    const f = flattenMetadata(meta);
    console.log(
      `${jid}\n   chatName=${JSON.stringify(found.get(jid).chatName)}\n   metaName=${JSON.stringify(f?.name?.text ?? f?.name)}\n   invite=${f?.invite ?? 'n/a'} subs=${f?.subscribers ?? 'n/a'}`
    );
  }
  await conn.stop();
  process.exit(0);
})();
