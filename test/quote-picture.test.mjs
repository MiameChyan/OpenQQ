import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import nativeEvents from '../native/events.cjs';
import { createEventConverter } from '../src/onebot.mjs';
import { dispatchAction } from '../src/actions.mjs';

// A reply carries a copy of the quoted message in `records`. Its pictures are never downloaded by QQ on their own and
// the url QQ gives for them returns 404, so the quoted picture has to be fetched like a received one.
const MD5 = 'a2e8c67f2bdad07a0e8d37d130c692af';
const self = { uin: '123456', uid: 'u_self' };
const quotedPic = (pic = {}) => ({ elementType: 2, elementId: '6101', picElement: { md5HexStr: MD5, fileName: MD5.toUpperCase() + '.jpg',
  sourcePath: 'C:\\QQ\\Pic\\Ori\\quoted.jpg', ...pic } });
const quoting = (record = {}, reply = {}) => ({ chatType: 2, msgId: '7200', msgSeq: '90', msgTime: '1794470400', peerUid: '987654', peerUin: '987654',
  senderUid: 'u_actor', senderUin: '654321',
  elements: [{ elementType: 7, elementId: '7201', replyElement: { sourceMsgIdInRecords: '6001', replayMsgSeq: '88', ...reply } },
    { elementType: 1, elementId: '7202', textElement: { content: '这张图' } }],
  records: [{ msgId: '6001', msgSeq: '88', msgTime: '1794470200', senderUid: 'u_other', senderUin: '456789', elements: [quotedPic()], ...record }] });

function receiver({ exists = () => false, timeoutMs = 60, result = 0, history } = {}) {
  const raw = [];
  const calls = [];
  const lookups = [];
  const session = {
    getUixConvertService: () => ({ getUin: async uids => ({ uinInfo: new Map(uids.map(uid => [uid, '654321'])) }) }),
    getMsgService: () => ({
      downloadRichMedia: async params => { calls.push(params); return { result: typeof result === 'function' ? result(params) : result }; },
      getMsgsBySeqAndCount: async (peer, seq, count, desc, reverse) => {
        lookups.push({ peer, seq, count });
        if (history instanceof Error) throw history;
        return { result: 0, msgList: history ?? [] };
      },
    }),
  };
  const receive = nativeEvents.createEventReceiver(session, self, event => raw.push(event), () => true,
    { mediaTimeoutMs: timeoutMs, mediaExists: exists });
  const message = () => raw.find(event => event.type === 'message')?.message;
  return { receive, raw, calls, lookups, message };
}

test('a picture inside the quoted record is downloaded before the event goes out', async () => {
  const f = receiver({ timeoutMs: 2000 });
  const pending = f.receive('msg', 'onRecvMsg', [[quoting()]]);
  await setImmediate();
  assert.equal(f.calls.length, 1);
  assert.deepEqual({ msgId: f.calls[0].msgId, elementId: f.calls[0].elementId, peerUid: f.calls[0].peerUid, chatType: f.calls[0].chatType },
    { msgId: '6001', elementId: '6101', peerUid: '987654', chatType: 2 });
  assert.equal(f.message(), undefined, 'event waits for the quoted picture');
  await f.receive('msg', 'onRichMediaDownloadComplete', [{ msgId: '6001', msgElementId: '6101', fileErrCode: 0, filePath: 'C:\\QQ\\Pic\\Ori\\quoted.jpg' }]);
  await pending;
  assert.equal(f.message().records[0].elements[0].picElement.filePath, 'C:\\QQ\\Pic\\Ori\\quoted.jpg');
  assert.equal(f.message().elements[1].textElement.content, '这张图', 'the message itself is unchanged');
});

test('a quoted picture already on disk is not downloaded again', async () => {
  const f = receiver({ exists: path => path === 'C:\\QQ\\Pic\\Ori\\quoted.jpg' });
  await f.receive('msg', 'onRecvMsg', [[quoting()]]);
  assert.equal(f.calls.length, 0);
  assert.equal(f.lookups.length, 0);
  assert.equal(f.message().records[0].elements[0].picElement.filePath, 'C:\\QQ\\Pic\\Ori\\quoted.jpg');
});

test('when QQ refuses the record copy, the original message is found by its seq and downloaded instead', async () => {
  const original = { msgId: '5001', msgSeq: '88', elements: [{ elementType: 1, elementId: '5100', textElement: { content: 'x' } },
    { elementType: 2, elementId: '5101', picElement: { md5HexStr: MD5.toUpperCase(), sourcePath: 'C:\\QQ\\Pic\\Ori\\orig.jpg' } }] };
  const f = receiver({ timeoutMs: 2000, history: [original], result: params => params.msgId === '6001' ? 1 : 0 });
  const pending = f.receive('msg', 'onRecvMsg', [[quoting()]]);
  for (let i = 0; i < 5 && f.calls.length < 2; i++) await setImmediate();
  assert.deepEqual(f.lookups.map(item => ({ seq: item.seq, peerUid: item.peer.peerUid, chatType: item.peer.chatType })),
    [{ seq: '88', peerUid: '987654', chatType: 2 }]);
  assert.deepEqual(f.calls.map(call => `${call.msgId}:${call.elementId}`), ['6001:6101', '5001:5101']);
  await f.receive('msg', 'onRichMediaDownloadComplete', [{ msgId: '5001', msgElementId: '5101', fileErrCode: 0, filePath: 'C:\\QQ\\Pic\\Ori\\orig.jpg' }]);
  await pending;
  assert.equal(f.message().records[0].elements[0].picElement.filePath, 'C:\\QQ\\Pic\\Ori\\orig.jpg');
});

test('a failed history lookup leaves the quote without a local file but still reports the message', async () => {
  const f = receiver({ result: 1, history: new Error('boom') });
  await f.receive('msg', 'onRecvMsg', [[quoting()]]);
  assert.equal(f.message().records[0].elements[0].picElement.filePath, undefined);
  assert.ok(f.raw.some(event => event.type === 'event_error' && event.stage === 'msg/quote-picture'));
});

test('no matching picture in the original message means no second download', async () => {
  const original = { msgId: '5001', msgSeq: '88', elements: [{ elementType: 2, elementId: '5101', picElement: { md5HexStr: 'ff'.repeat(16) } }] };
  const f = receiver({ result: 1, history: [original] });
  await f.receive('msg', 'onRecvMsg', [[quoting()]]);
  assert.deepEqual(f.calls.map(call => call.msgId), ['6001']);
  assert.equal(f.message().records[0].elements[0].picElement.filePath, undefined);
});

test('records that are not quoted, and messages without records, are left alone', async () => {
  const f = receiver();
  await f.receive('msg', 'onRecvMsg', [[quoting({ msgId: '6999' })]]);
  assert.equal(f.calls.length, 0);
  assert.equal(f.message().records[0].elements[0].picElement.filePath, undefined);

  const g = receiver();
  const plain = quoting();
  delete plain.records;
  await g.receive('msg', 'onRecvMsg', [[plain]]);
  assert.equal(g.calls.length, 0);
  assert.equal(g.message().records, undefined);
});

test('get_msg on a quote re-inlines the picture from disk, though the stored copy drops base64', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'openqq-quote-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'quoted.jpg');
  writeFileSync(path, Buffer.from('JPEG'));
  const convert = createEventConverter();
  const event = convert({ type: 'message', self, message: { ...quoting({ elements: [quotedPic({ filePath: path })] }), senderUin: '654321' } });
  const quoteId = event.message[0].data.id;
  const res = await dispatchAction({ request: async () => { throw new Error('should not be called'); } }, convert,
    { action: 'get_msg', params: { message_id: quoteId } });
  assert.equal(res.status, 'ok');
  assert.equal(res.data.message[0].type, 'image');
  assert.equal(res.data.message[0].data.file, 'base64://' + Buffer.from('JPEG').toString('base64'));
  assert.equal(res.data.message[0].data.url, undefined, 'the dead url is not offered');
  assert.ok(!res.data.raw_message.includes(Buffer.from('JPEG').toString('base64')), 'raw_message stays short');

  // the cache itself still holds no base64: a second read inlines again from disk
  rmSync(path);
  const again = await dispatchAction({ request: async () => { throw new Error('should not be called'); } }, convert,
    { action: 'get_msg', params: { message_id: quoteId } });
  assert.ok(!String(again.data.message[0].data.file).startsWith('base64://'));
});
