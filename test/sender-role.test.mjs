import { test } from 'node:test';
import assert from 'node:assert/strict';
import nativeEvents from '../native/events.cjs';
import { createEventConverter } from '../src/onebot.mjs';

// 群消息要带 sender.role（owner/admin/member），海豹等框架靠它判断群管理权限。
const self = { uin: '123456', uid: 'u_self' };
const base = (overrides = {}) => ({ chatType: 2, msgId: String(Math.floor(Math.random() * 1e9)), msgTime: '1794470400',
  peerUid: '987654', peerUin: '987654', senderUid: 'u_actor', senderUin: '654321',
  elements: [{ elementType: 1, textElement: { content: '.bot on' } }], ...overrides });

function fixture(memberInfo) {
  const events = [];
  const lookups = [];
  const convert = createEventConverter();
  const session = {
    getUixConvertService: () => ({ getUin: async uids => ({ uinInfo: new Map(uids.map(uid => [uid, { u_actor: '654321', u_self: self.uin }[uid]])) }) }),
    getGroupService: () => ({ getMemberInfo: async (group, uids) => { lookups.push([group, ...uids]); return memberInfo(group, uids); } }),
  };
  const receive = nativeEvents.createEventReceiver(session, self, event => { const result = convert(event); if (result) events.push(result); }, () => true);
  return { receive, events, lookups };
}
const infos = role => async (_group, uids) => ({ result: { infos: new Map(uids.map(uid => [uid, { uin: '654321', role }])) } });

test('group messages carry the sender role looked up from QQ', async () => {
  for (const [role, name] of [[4, 'owner'], [3, 'admin'], [2, 'member']]) {
    const f = fixture(infos(role));
    await f.receive('msg', 'onRecvMsg', [[base()]]);
    assert.equal(f.events.at(-1).sender.role, name);
  }
});

test('roles are cached per group member and refreshed by member info pushes', async () => {
  const f = fixture(infos(2));
  await f.receive('msg', 'onRecvMsg', [[base()]]);
  await f.receive('msg', 'onRecvMsg', [[base()]]);
  assert.equal(f.lookups.length, 1);
  await f.receive('group', 'onMemberInfoChange', ['987654', 0, new Map([['u_actor', { uin: '654321', role: 3 }]])]);
  await f.receive('msg', 'onRecvMsg', [[base()]]);
  assert.equal(f.events.at(-1).sender.role, 'admin');
  assert.equal(f.lookups.length, 1);
});

test('a failed role lookup degrades to member instead of dropping the message', async () => {
  const f = fixture(async () => { throw new Error('boom'); });
  await f.receive('msg', 'onRecvMsg', [[base()]]);
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].sender.role, 'member');
});

test('private messages have no group role', async () => {
  const f = fixture(infos(4));
  await f.receive('msg', 'onRecvMsg', [[base({ chatType: 1, peerUid: 'u_actor', peerUin: '654321', sendNickName: 'x' })]]);
  assert.equal(f.events[0].sender.role, undefined);
  assert.equal(f.lookups.length, 0);
});
