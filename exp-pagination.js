'use strict';
/**
 * Find the attribute/value shape that actually pages backwards through a
 * channel's history. The upstream `before`/`after` names do not work, so the
 * real shape has to be found empirically against the live server.
 */
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
      hexIds: messages.map(m => m.attrs?.id).filter(Boolean),
      ts: messages.map(m => (m.attrs?.t ? Number(m.attrs.t) : null)).filter(Boolean)
    };
  };

  const base = await fetchWith({ type: 'jid', jid: JID, count: '10' });
  console.log('base window:', base.count, 'ids', base.ids[0], '..', base.ids[base.ids.length - 1]);
  console.log('base oldest ts:', base.ts[0], new Date(base.ts[0] * 1000).toISOString());
  console.log('base newest ts:', base.ts[base.ts.length - 1], new Date(base.ts[base.ts.length - 1] * 1000).toISOString());

  const oldestServerId = base.ids[0];
  const oldestHexId = base.hexIds[0];
  const oldestTs = base.ts[0];

  const variants = [
    ['before=server_id', { type: 'jid', jid: JID, count: '10', before: oldestServerId }],
    ['before=hex_id', { type: 'jid', jid: JID, count: '10', before: oldestHexId }],
    ['after=server_id', { type: 'jid', jid: JID, count: '10', after: oldestServerId }],
    ['after=hex_id', { type: 'jid', jid: JID, count: '10', after: oldestHexId }],
    ['before=ts', { type: 'jid', jid: JID, count: '10', before: String(oldestTs) }],
    ['since=ts', { type: 'jid', jid: JID, count: '10', since: String(oldestTs) }],
    ['offset', { type: 'jid', jid: JID, count: '10', offset: '10' }],
    ['start=server_id', { type: 'jid', jid: JID, count: '10', start: oldestServerId }],
    ['from=server_id', { type: 'jid', jid: JID, count: '10', from: oldestServerId }],
    ['older_than=server_id', { type: 'jid', jid: JID, count: '10', older_than: oldestServerId }],
    ['before_id=server_id', { type: 'jid', jid: JID, count: '10', before_id: oldestServerId }],
    ['cursor=server_id', { type: 'jid', jid: JID, count: '10', cursor: oldestServerId }],
    ['count=40 (bigger window)', { type: 'jid', jid: JID, count: '40' }],
    ['count=100', { type: 'jid', jid: JID, count: '100' }],
    ['count=200', { type: 'jid', jid: JID, count: '200' }]
  ];

  for (const [label, attrs] of variants) {
    try {
      const r = await fetchWith(attrs);
      const fresh = r.ids.filter(i => !base.ids.includes(i)).length;
      const older = r.ids.length && Number(r.ids[0]) < Number(base.ids[0]) ? 'OLDER' : 'same/newer';
      console.log(
        `${label.padEnd(24)} -> got=${String(r.count).padStart(3)} fresh=${String(fresh).padStart(3)} ${older} range=${r.ids[0]}..${r.ids[r.ids.length - 1]}`
      );
    } catch (err) {
      console.log(`${label.padEnd(24)} -> ERROR ${String(err?.message).split('\n')[0]}`);
    }
  }

  await conn.stop();
  process.exit(0);
})();
