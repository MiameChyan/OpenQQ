'use strict';

const { fail, identifier, flag, integer, nativeId } = require('./common.cjs');

// QQ group roles: 4 owner, 3 administrator, anything else an ordinary member.
const roleName = role => role === 4 ? 'owner' : role === 3 ? 'admin' : 'member';
const GROUP_REQUEST = /^g:(\d{1,20}):(\d{1,3}):(\d{1,24})$/;
const FRIEND_REQUEST = /^f:(u_[\w-]{1,64}):(\d{1,24})$/;

function text(value, name, max, fallback) {
  if (value === undefined || value === null) {
    if (fallback === undefined) throw fail(`${name} 不能为空`);
    return fallback;
  }
  if (typeof value !== 'string' || [...value].length > max || /[\u0000-\u001f]/.test(value)) throw fail(`${name} 必须是不超过 ${max} 个字符的文本`);
  return value;
}

function messageRef(value) {
  if (!value || typeof value !== 'object' || ![1, 2, 100].includes(value.chatType) || typeof value.peerUid !== 'string' || !value.peerUid
    || value.peerUid.length > 64 || !nativeId(value.msgId)) return null;
  return { chatType: value.chatType, peerUid: value.peerUid, msgId: value.msgId };
}

// Returns a validated action, or null when `request.action` is not handled here.
function validate(request, params) {
  const group = () => identifier(params.group_id, 'group_id');
  const user = () => identifier(params.user_id, 'user_id');
  switch (request.action) {
    case 'set_group_kick': return { kind: 'group_kick', group: group(), user: user(), refuse: flag(params.reject_add_request, 'reject_add_request', false) };
    case 'set_group_ban': return { kind: 'group_ban', group: group(), user: user(), duration: integer(params.duration, 'duration', 0, 2592000, 1800) };
    case 'set_group_whole_ban': return { kind: 'group_whole_ban', group: group(), enable: flag(params.enable, 'enable', true) };
    case 'set_group_admin': return { kind: 'group_admin', group: group(), user: user(), enable: flag(params.enable, 'enable', true) };
    case 'set_group_card': return { kind: 'group_card', group: group(), user: user(), card: text(params.card, 'card', 60, '') };
    case 'set_group_name': {
      const name = text(params.group_name, 'group_name', 48);
      if (!name.trim()) throw fail('group_name 不能为空');
      return { kind: 'group_name', group: group(), name };
    }
    case 'set_group_leave': return { kind: 'group_leave', group: group(), dismiss: flag(params.is_dismiss, 'is_dismiss', false) };
    case 'set_group_add_request': {
      const match = typeof params.flag === 'string' ? GROUP_REQUEST.exec(params.flag) : null;
      if (!match) throw fail('flag 无效：请使用入群申请事件里的 flag', 1404);
      return { kind: 'group_request', group: match[1], type: Number(match[2]), seq: match[3], approve: flag(params.approve, 'approve', true), reason: text(params.reason, 'reason', 256, '') };
    }
    case 'set_friend_add_request': {
      const match = typeof params.flag === 'string' ? FRIEND_REQUEST.exec(params.flag) : null;
      if (!match) throw fail('flag 无效：请使用好友申请事件里的 flag', 1404);
      return { kind: 'friend_request', uid: match[1], reqTime: match[2], approve: flag(params.approve, 'approve', true) };
    }
    case 'delete_msg': {
      const ref = messageRef(params.openqq_ref);
      if (!ref) throw fail('message_id 无效或已过期（仅支持本次运行期间收发过的消息）', 1404);
      return { kind: 'delete_msg', ref };
    }
    case 'send_like': return { kind: 'send_like', user: user(), times: integer(params.times, 'times', 1, 20, 1) };
    case 'get_group_list': return { kind: 'group_list' };
    case 'get_group_info': return { kind: 'group_info', group: group() };
    case 'get_group_member_list': return { kind: 'group_member_list', group: group() };
    case 'get_group_member_info': return { kind: 'group_member_info', group: group(), user: user() };
    // Frameworks look up the nickname of an @-mentioned user here when the group card is empty; failing it makes
    // AstrBot drop the whole @ segment, so a mention of the bot no longer wakes it.
    case 'get_stranger_info': return { kind: 'stranger_info', user: user() };
    default: return null;
  }
}

const kinds = new Set(['group_kick', 'group_ban', 'group_whole_ban', 'group_admin', 'group_card', 'group_name', 'group_leave', 'group_request', 'friend_request',
  'delete_msg', 'send_like', 'group_list', 'group_info', 'group_member_list', 'group_member_info', 'stranger_info']);

// QQ reports refusals inside the resolved value; methods that return nothing are treated as accepted.
function outcome(result, what) {
  if (result === undefined || result === null || typeof result !== 'object') return result;
  const code = typeof result.errCode === 'number' ? result.errCode : typeof result.result === 'number' ? result.result : 0;
  if (code !== 0) throw fail(`QQ 拒绝${what}：${result.errMsg || code}`, 1500);
  return result;
}

function groupOf(item) {
  return { group_id: Number(item.groupCode), group_name: String(item.groupName ?? ''), member_count: Number(item.memberCount ?? 0), max_member_count: Number(item.maxMember ?? 0) };
}

function memberOf(group, info) {
  const number = value => /^\d+$/.test(String(value ?? '')) ? Number(value) : 0;
  return { group_id: Number(group), user_id: number(info.uin), nickname: String(info.nick ?? ''), card: String(info.cardName ?? ''), sex: 'unknown', age: 0, area: '',
    join_time: number(info.joinTime), last_sent_time: number(info.lastSpeakTime), level: String(info.memberRealLevel ?? 0), role: roleName(info.role), unfriendly: false,
    title: String(info.memberSpecialTitle ?? ''), title_expire_time: 0, card_changeable: false, shut_up_timestamp: number(info.shutUpTime) };
}

async function run(action, ctx) {
  const { session, ensure } = ctx;
  const groups = () => session.getGroupService();
  const members = async (group, force) => {
    const result = outcome(await groups().getAllMemberList(group, force), '获取群成员');
    const infos = result?.result?.infos;
    if (!(infos instanceof Map)) throw fail('群成员列表结构未适配', 1500);
    ensure();
    return [...infos.values()].filter(info => info && !info.isDelete);
  };
  switch (action.kind) {
    case 'group_kick': {
      const uid = await ctx.memberUid(action.group, action.user);
      ensure();
      outcome(await groups().kickMember(action.group, [uid], action.refuse, ''), '踢出成员');
      return null;
    }
    case 'group_ban': {
      const uid = await ctx.memberUid(action.group, action.user);
      ensure();
      outcome(await groups().setMemberShutUp(action.group, [{ uid, timeStamp: action.duration }]), '禁言');
      return null;
    }
    case 'group_whole_ban': outcome(await groups().setGroupShutUp(action.group, action.enable), '全员禁言'); return null;
    case 'group_admin': {
      const uid = await ctx.memberUid(action.group, action.user);
      ensure();
      outcome(await groups().modifyMemberRole(action.group, uid, action.enable ? 3 : 2), '设置管理员');
      return null;
    }
    case 'group_card': {
      const uid = await ctx.memberUid(action.group, action.user);
      ensure();
      outcome(await groups().modifyMemberCardName(action.group, uid, action.card), '修改群名片');
      return null;
    }
    case 'group_name': outcome(await groups().modifyGroupName(action.group, action.name, false), '修改群名'); return null;
    case 'group_leave':
      if (action.dismiss) outcome(await groups().destroyGroup(action.group), '解散群');
      else if (typeof groups().quitGroupV2 === 'function') outcome(await groups().quitGroupV2({ groupCode: action.group, needDeleteLocalMsg: false }), '退群');
      else outcome(await groups().quitGroup(action.group), '退群');
      return null;
    case 'group_request':
      outcome(await groups().operateSysNotify(false, { operateType: action.approve ? 1 : 2,
        targetMsg: { seq: action.seq, type: action.type, groupCode: action.group, postscript: action.reason || ' ' } }), '处理入群申请');
      return null;
    case 'friend_request':
      outcome(await session.getBuddyService().approvalFriendRequest({ friendUid: action.uid, reqTime: action.reqTime, accept: action.approve }), '处理好友申请');
      return null;
    case 'delete_msg':
      outcome(await session.getMsgService().recallMsg({ chatType: action.ref.chatType, peerUid: action.ref.peerUid, guildId: '0' }, [action.ref.msgId]), '撤回消息');
      return null;
    case 'send_like': {
      const uid = await ctx.uidFor(action.user);
      ensure();
      outcome(await session.getProfileLikeService().setBuddyProfileLike({ friendUid: uid, sourceId: 71, doLikeCount: action.times, doLikeTollCount: 0 }), '点赞');
      return null;
    }
    case 'group_list': return (await ctx.groupList(true)).map(groupOf);
    case 'group_info': {
      const item = (await ctx.groupList(false)).find(value => String(value.groupCode) === action.group);
      if (!item) throw fail('没有找到这个群', 1404);
      return groupOf(item);
    }
    case 'group_member_list': {
      let list = await members(action.group, false);
      if (!list.length) list = await members(action.group, true);
      return list.map(info => memberOf(action.group, info));
    }
    case 'group_member_info': {
      let info = (await members(action.group, false)).find(value => String(value.uin) === action.user);
      if (!info) info = (await members(action.group, true)).find(value => String(value.uin) === action.user);
      if (!info) throw fail('没有找到这个群成员', 1404);
      return memberOf(action.group, info);
    }
    case 'stranger_info': {
      const uid = await ctx.uidFor(action.user);
      ensure();
      let core;
      try {
        const result = await session.getProfileService().getCoreAndBaseInfo('nodeStore', [uid]);
        core = (result instanceof Map ? result.get(uid) : undefined)?.coreInfo;
      } catch { /* answer without a nickname rather than failing the caller */ }
      ensure();
      return { user_id: Number(action.user), nickname: String(core?.nick || ''), sex: 'unknown', age: 0, qid: '', level: 0, login_days: 0 };
    }
    default: throw fail('尚未支持动作: ' + action.kind, 1404);
  }
}

module.exports = { validate, run, kinds, groupOf, memberOf, GROUP_REQUEST, FRIEND_REQUEST };
