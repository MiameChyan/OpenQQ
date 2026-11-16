import { test } from 'node:test';
import assert from 'node:assert/strict';
import nativeActions from '../native/actions.cjs';

const self = { uin: '123456', uid: 'u_self' };
function fixture(t, { uid = 'u_target', profile } = {}) {
  const lookups = [];
  const session = {
    getUixConvertService: () => ({ getUid: async uins => ({ uidInfo: new Map(uid ? uins.map(uin => [uin, uid]) : []) }) }),
    getProfileService: () => ({
      getUidByUin: async () => new Map(),
      getCoreAndBaseInfo: async (from, uids) => {
        lookups.push({ from, uids });
        if (profile instanceof Error) throw profile;
        return new Map(uids.map(value => [value, { coreInfo: { uid: value, nick: profile?.nick ?? '', remark: '' } }]));
      },
    }),
    getGroupService: () => ({ getUidByUins: async () => ({ uids: new Map() }) }),
  };
  const handler = nativeActions.createActionHandler(session, self, () => true);
  t.after(() => handler.dispose());
  return { handler, lookups };
}

test('get_stranger_info returns the nickname from the profile service', async t => {
  const f = fixture(t, { profile: { nick: '示例昵称' } });
  const info = await f.handler.execute({ action: 'get_stranger_info', params: { user_id: 654321 } });
  assert.deepEqual(info, { user_id: 654321, nickname: '示例昵称', sex: 'unknown', age: 0, qid: '', level: 0, login_days: 0 });
  assert.deepEqual(f.lookups, [{ from: 'nodeStore', uids: ['u_target'] }]);
});

test('a failing profile lookup still answers, with an empty nickname', async t => {
  const f = fixture(t, { profile: new Error('boom') });
  const info = await f.handler.execute({ action: 'get_stranger_info', params: { user_id: '654321' } });
  assert.equal(info.user_id, 654321);
  assert.equal(info.nickname, '');
});

test('an invalid user_id is rejected before QQ is asked', async t => {
  const f = fixture(t, { profile: { nick: 'x' } });
  for (const user_id of [undefined, 'u_uid', 0, -1]) await assert.rejects(f.handler.execute({ action: 'get_stranger_info', params: { user_id } }));
  assert.equal(f.lookups.length, 0);
});

test('a QQ number that cannot be resolved to a UID is reported', async t => {
  const f = fixture(t, { uid: null, profile: { nick: 'x' } });
  await assert.rejects(f.handler.execute({ action: 'get_stranger_info', params: { user_id: 654321 } }), error => error.retcode === 1500);
  assert.equal(f.lookups.length, 0);
});
