'use strict';
const { Connection } = require('./src/lib/connect');
const { getBinaryNodeChild, getBinaryNodeChildren, S_WHATSAPP_NET } = require('@whiskeysockets/baileys/lib/WABinary/index.js');
const JID = '120363328942292199@newsletter';
(async () => {
  const conn = new Connection({ autoReconnect: false, logLevel: 'error' });
  await conn.start();
  await conn.waitForOpen(120000);
  const sock = conn.sock;
  const fetchWith = async attrs => {
    const result = await sock.query({
      tag: 'iq',
      attrs: { id: sock.generateMessageTag(), type: 'get', to: S_WHATSAPP_NET, xmlns: 'newsletter' },
      content: [{ tag: 'messages', attrs }]
    });
    const node = getBinaryNodeChild(result, 'messages');
    const messages = getBinaryNodeChildren(node, 'message');
    return {
      count: messages.length,
      ids: messages.map(m => m.attrs?.server_id).filter(Boolean),
      ts: messages.map(m => (m.attrs?.t ? Number(m.attrs.t) : null)).filter(Boolean)
    };
  };
  for (const c of [20, 50, 100, 200, 500]) {
    try {
      const r = await fetchWith({ type: 'jid', jid: JID, count: String(c) });
      const oldest = r.ts.length ? new Date(r.ts[0] * 1000).toISOString() : 'n/a';
      console.log(`count=${String(c).padStart(3)} -> got=${String(r.count).padStart(3)} ids=${r.ids[0]}..${r.ids[r.ids.length - 1]} oldestTs=${oldest}`);
    } catch (e) {
      console.log(`count=${c} -> ERROR ${String(e?.message).split('\n')[0]}`);
    }
  }
  await conn.stop();
  process.exit(0);
})();
