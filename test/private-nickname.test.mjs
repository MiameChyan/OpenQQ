import { test } from 'node:test';
import assert from 'node:assert/strict';
import nativeEvents from '../native/events.cjs';

const self = { uin: '123456', uid: 'u_self' };
const textMessage = (overrides = {}) => ({ chatType: 1, msgId: '7001', msgTime: '1794470400', peerUid: 'u_actor', peerUin: '654321',
  senderUid: 'u_actor', senderUin: '654321', sendNickName: '', elements: [{ elementType: 1, textElement: { content: 'hi' } }], ...overrides });

function receiver({ profile } = {}) {
  const raw = [];
  const lookups = [];
  const session = {
    getUixConvertService: () => ({ getUin: async uids => ({ uinInfo: new Map(uids.map(uid => [uid, '654321'])) }) }),
    getProfileService: () => ({
      getCoreAndBaseInfo: async (from, uids) => {
        lookups.push({ from, uids });
        if (profile instanceof Error) throw profile;
        return new Map(uids.map(uid => [uid, { coreInfo: { uid, nick: profile?.nick ?? '', remark: profile?.remark ?? '' } }]));
      },
    }),
  };
  const receive = nativeEvents.createEventReceiver(session, self, event => raw.push(event), () => true);
  const messages = () => raw.filter(event => event.type === 'message').map(event => event.message);
  return { receive, raw, lookups, messages };
}

test('a private message without a nickname gets it from the profile service, cached per uid', async () => {
  const f = receiver({ profile: { nick: '示例昵称' } });
  await f.receive('msg', 'onRecvMsg', [[textMessage()]]);
  await f.receive('msg', 'onRecvMsg', [[textMessage({ msgId: '7002' })]]);
  assert.deepEqual(f.messages().map(message => message.sendNickName), ['示例昵称', '示例昵称']);
  assert.equal(f.lookups.length, 1, 'second message uses the cache');
  assert.deepEqual(f.lookups[0], { from: 'nodeStore', uids: ['u_actor'] });
});

test('the remark is used only when the nickname is empty', async () => {
  const f = receiver({ profile: { nick: '', remark: '备注名' } });
  await f.receive('msg', 'onRecvMsg', [[textMessage()]]);
  assert.equal(f.messages()[0].sendNickName, '备注名');
});

test('a nickname QQ already supplied is kept and nothing is looked up', async () => {
  const f = receiver({ profile: { nick: '别的' } });
  await f.receive('msg', 'onRecvMsg', [[textMessage({ sendNickName: '原有昵称' })]]);
  assert.equal(f.messages()[0].sendNickName, '原有昵称');
  assert.equal(f.lookups.length, 0);
});

test('group messages are left alone', async () => {
  const f = receiver({ profile: { nick: '别的' } });
  await f.receive('msg', 'onRecvMsg', [[textMessage({ chatType: 2, peerUid: '987654', peerUin: '987654' })]]);
  assert.equal(f.messages()[0].sendNickName, '');
  assert.equal(f.lookups.length, 0);
});

test('a failing profile lookup still reports the message', async () => {
  const f = receiver({ profile: new Error('boom') });
  await f.receive('msg', 'onRecvMsg', [[textMessage()]]);
  assert.equal(f.messages().length, 1);
  assert.equal(f.messages()[0].sendNickName, '');
});

test('the buddy list fills the cache so no lookup is needed', async () => {
  const f = receiver({ profile: { nick: '不该用到' } });
  await f.receive('buddy', 'onBuddyListChange', [[{ buddyList: [{ uid: 'u_actor', uin: '654321', coreInfo: { nick: '好友列表昵称' } }] }]]);
  await f.receive('msg', 'onRecvMsg', [[textMessage()]]);
  assert.equal(f.messages()[0].sendNickName, '好友列表昵称');
  assert.equal(f.lookups.length, 0);
});
