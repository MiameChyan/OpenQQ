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
