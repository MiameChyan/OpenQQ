import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEventConverter } from '../src/onebot.mjs';
import { dispatchAction } from '../src/actions.mjs';

const self = { uin: '123456', uid: 'u_self' };
const text = content => ({ elementType: 1, textElement: { content } });
const incoming = (overrides = {}) => ({ type: 'message', self, message: { chatType: 1, msgId: '7001', msgTime: '1794470400',
  peerUid: 'u_actor', peerUin: '654321', senderUin: '654321', sendNickName: '示例昵称', elements: [text('要马上考试了')], ...overrides } });
function fakeChannel(reply) {
  const calls = [];
  return { calls, request: async (prepared, timeout) => { calls.push(prepared); return typeof reply === 'function' ? reply(prepared) : reply; } };
}

test('a received private message can be fetched by its OneBot id without asking QQ', async () => {
  const convert = createEventConverter();
  const event = convert(incoming());
  const channel = fakeChannel(() => { throw new Error('should not be called'); });
  const res = await dispatchAction(channel, convert, { action: 'get_msg', params: { message_id: event.message_id }, echo: 'e1' });
  assert.equal(res.status, 'ok');
  assert.equal(res.echo, 'e1');
  assert.equal(channel.calls.length, 0);
  assert.deepEqual({ ...res.data }, { time: 1794470400, message_type: 'private', message_id: event.message_id, real_id: event.message_id,
    sender: { user_id: 654321, nickname: '示例昵称' }, message: event.message, raw_message: event.raw_message });
});

test('a group message keeps group_id and the member card', async () => {
  const convert = createEventConverter();
  const event = convert(incoming({ chatType: 2, peerUid: '987654', peerUin: '987654', sendMemberName: '群名片' }));
  const res = await dispatchAction(fakeChannel(null), convert, { action: 'get_msg', params: { message_id: String(event.message_id) } });
  assert.equal(res.data.message_type, 'group');
  assert.equal(res.data.group_id, 987654);
  assert.equal(res.data.sender.card, '群名片');
});

test('a stored picture does not keep its base64 copy', async () => {
  const convert = createEventConverter();
  const pic = { elementType: 2, picElement: { fileName: 'A.jpg', md5HexStr: '', filePath: 'C:\\QQ\\Pic\\a.jpg' } };
  const event = convert(incoming({ elements: [pic] }));
  event.message[0].data.file = 'base64://SkVQRw==';  // what the live event carries after inlining
  const res = await dispatchAction(fakeChannel(null), convert, { action: 'get_msg', params: { message_id: event.message_id } });
  assert.equal(res.data.message[0].type, 'image');
  assert.ok(!String(res.data.message[0].data.file).startsWith('base64://'));
  assert.ok(!res.data.raw_message.includes('SkVQRw=='));
});

test('our own sent message can be fetched by the id the send returned', async () => {
  const convert = createEventConverter();
  const channel = fakeChannel({ status: 'ok', retcode: 0, data: { self, message: { chatType: 1, peerUid: 'u_actor', msgId: '9001' } } });
  const sent = await dispatchAction(channel, convert, { action: 'send_private_msg',
    params: { user_id: 654321, message: [{ type: 'text', data: { text: '唔姆，稳住' } }] } });
  assert.equal(sent.status, 'ok');
  const res = await dispatchAction(channel, convert, { action: 'get_msg', params: { message_id: sent.data.message_id } });
  assert.equal(res.status, 'ok');
  assert.equal(res.data.sender.user_id, 123456);
  assert.equal(res.data.message_type, 'private');
  assert.deepEqual(res.data.message, [{ type: 'text', data: { text: '唔姆，稳住' } }]);
  assert.equal(res.data.raw_message, '唔姆，稳住');
});

test('an unknown or invalid id is a clean 1404', async () => {
  const convert = createEventConverter();
  for (const message_id of [99999, 'abc', undefined]) {
    const res = await dispatchAction(fakeChannel(null), convert, { action: 'get_msg', params: { message_id } });
    assert.equal(res.status, 'failed');
    assert.equal(res.retcode, 1404);
  }
});

test('storage copies drop base64 payloads and native reply refs, and do not share objects', async () => {
  const { slimForStorage } = await import('../src/onebot.mjs');
  const live = [
    { type: 'image', data: { file: 'base64://SkVQRw==', path: 'C:\\QQ\\Pic\\Ori\\a.jpg' } },
    { type: 'record', data: { file: 'base64://QUFB' } },
    { type: 'reply', data: { id: '3', openqq_ref: { chatType: 1, peerUid: 'u_actor', msgId: '1' } } },
    { type: 'text', data: { text: 'hi' } },
  ];
  const stored = slimForStorage(live);
  assert.deepEqual(stored, [
    { type: 'image', data: { file: 'a.jpg', path: 'C:\\QQ\\Pic\\Ori\\a.jpg' } },
    { type: 'record', data: { file: 'record' } },
    { type: 'reply', data: { id: '3' } },
    { type: 'text', data: { text: 'hi' } },
  ]);
  live[3].data.text = 'changed';
  assert.equal(stored[3].data.text, 'hi');
});

// ---- a quoted message from before this run: fetched from QQ's own history once, then cached ----
const quoting = (convert, oldMsgId = '5001') => convert(incoming({ msgId: '7100',
  elements: [{ elementType: 7, replyElement: { sourceMsgIdInRecords: oldMsgId } }, text('好的，我出发了')] }));
const oldOwnMessage = { chatType: 1, peerUid: 'u_actor', peerUin: '654321', msgId: '5001', msgTime: '1794470300',
  senderUin: '123456', senderUid: 'u_self', sendNickName: '', elements: [text('唔姆，稳住')] };

test('a quoted message missing from the cache is fetched from QQ history and then cached', async () => {
  const convert = createEventConverter();
  const quoteId = quoting(convert).message[0].data.id;
  const channel = fakeChannel({ status: 'ok', retcode: 0, data: { self, message: oldOwnMessage } });
  const res = await dispatchAction(channel, convert, { action: 'get_msg', params: { message_id: quoteId } });
  assert.equal(res.status, 'ok');
  assert.equal(channel.calls.length, 1);
  assert.equal(channel.calls[0].action, 'get_msg');
  assert.deepEqual(channel.calls[0].params.openqq_ref, { chatType: 1, peerUid: 'u_actor', msgId: '5001' });
  assert.equal(String(res.data.message_id), String(quoteId));
  assert.equal(res.data.sender.user_id, 123456, 'our own old reply is returned too');
  assert.deepEqual(res.data.message, [{ type: 'text', data: { text: '唔姆，稳住' } }]);
  const again = await dispatchAction(channel, convert, { action: 'get_msg', params: { message_id: quoteId } });
  assert.equal(again.status, 'ok');
  assert.equal(channel.calls.length, 1, 'served from the cache the second time');
});

test('a history lookup QQ cannot answer is passed through as a failure', async () => {
  const convert = createEventConverter();
  const quoteId = quoting(convert).message[0].data.id;
  const channel = fakeChannel({ status: 'failed', retcode: 1404, data: null, message: '这条消息在本机已不存在' });
  const res = await dispatchAction(channel, convert, { action: 'get_msg', params: { message_id: quoteId } });
  assert.equal(res.status, 'failed');
  assert.equal(res.retcode, 1404);
});

// ---- native side ----
import nativeActions from '../native/actions.cjs';
function nativeFixture(t, reply) {
  const calls = [];
  const session = { getMsgService: () => ({ getMsgsByMsgId: async (peer, ids) => { calls.push({ peer, ids }); return typeof reply === 'function' ? reply() : reply; } }) };
  const handler = nativeActions.createActionHandler(session, self, () => true);
  t.after(() => handler.dispose());
  return { handler, calls };
}
const ref = { chatType: 1, peerUid: 'u_actor', msgId: '5001' };

test('native get_msg reads QQ history with a validated peer and returns the raw message', async t => {
  const f = nativeFixture(t, { result: 0, msgList: [oldOwnMessage] });
  const out = await f.handler.execute({ action: 'get_msg', params: { message_id: 1, openqq_ref: ref } });
  assert.deepEqual(f.calls, [{ peer: { chatType: 1, peerUid: 'u_actor', guildId: '' }, ids: ['5001'] }], 'same peer shape as NapCat');
  assert.equal(out.self, self);
  assert.equal(out.message.msgId, '5001');
  assert.equal(out.message.senderUin, '123456');
  assert.deepEqual(out.message.elements, oldOwnMessage.elements);
});

test('native get_msg never calls QQ with an invalid reference', async t => {
  const f = nativeFixture(t, { result: 0, msgList: [] });
  for (const bad of [undefined, { ...ref, chatType: 9 }, { ...ref, peerUid: '' }, { ...ref, msgId: 'x' }]) {
    await assert.rejects(f.handler.execute({ action: 'get_msg', params: { openqq_ref: bad } }), error => error.retcode === 1404);
  }
  assert.equal(f.calls.length, 0);
});

test('native get_msg reports a missing or refused message', async t => {
  await assert.rejects(nativeFixture(t, { result: 0, msgList: [] }).handler.execute({ action: 'get_msg', params: { openqq_ref: ref } }),
    error => error.retcode === 1404);
  await assert.rejects(nativeFixture(t, { result: 5, errMsg: 'denied' }).handler.execute({ action: 'get_msg', params: { openqq_ref: ref } }),
    error => error.retcode === 1500);
});

// ---- the quoted message's own copy travels in `records`; that is enough to answer get_msg without asking QQ ----
const recordCopy = { msgId: '6001', msgTime: '1794470200', senderUid: 'u_self', senderUin: '0', sendNickName: '',
  elements: [text('考完说一声')] };
const quotingWithRecord = (convert, record = recordCopy) => convert(incoming({ msgId: '7200',
  elements: [{ elementType: 7, replyElement: { sourceMsgIdInRecords: '6001', replayMsgSeq: '88' } }, text('好的')],
  records: [record] }));

test('a quote is answered from the copy QQ attaches in records, with no QQ call', async () => {
  const convert = createEventConverter();
  const quoteId = quotingWithRecord(convert).message[0].data.id;
  const channel = fakeChannel(() => { throw new Error('should not be called'); });
  const res = await dispatchAction(channel, convert, { action: 'get_msg', params: { message_id: quoteId } });
  assert.equal(res.status, 'ok');
  assert.equal(channel.calls.length, 0);
  assert.equal(String(res.data.message_id), String(quoteId));
  assert.equal(res.data.sender.user_id, 123456, 'senderUin 0 with our own uid resolves to self');
  assert.equal(res.data.time, 1794470200);
  assert.deepEqual(res.data.message, [{ type: 'text', data: { text: '考完说一声' } }]);
});

test('a record from someone else keeps their number and nickname', async () => {
  const convert = createEventConverter();
  const quoteId = quotingWithRecord(convert, { ...recordCopy, senderUid: 'u_other', senderUin: '456789', sendNickName: '别人' })
    .message[0].data.id;
  const res = await dispatchAction(fakeChannel(null), convert, { action: 'get_msg', params: { message_id: quoteId } });
  assert.deepEqual(res.data.sender, { user_id: 456789, nickname: '别人' });
});

test('a record with no usable content falls back to the history lookup', async () => {
  const convert = createEventConverter();
  const quoteId = quotingWithRecord(convert, { ...recordCopy, elements: [] }).message[0].data.id;
  const channel = fakeChannel({ status: 'failed', retcode: 1404, data: null, message: '这条消息在本机记录中已不存在' });
  const res = await dispatchAction(channel, convert, { action: 'get_msg', params: { message_id: quoteId } });
  assert.equal(channel.calls.length, 1);
  assert.equal(res.retcode, 1404);
});
