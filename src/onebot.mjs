import { win32 } from 'node:path';
import { convertSegment, cqString, inlinePicture } from './segments.mjs';

// get_msg answers from messages seen in this run (received, and sent through OpenQQ); QQ is not asked.
const STORED_LIMIT = 2000;
// Stored copies are independent of the live event and drop inline media, which only matters for the first delivery.
export function slimForStorage(segments) {
  return segments.filter(segment => segment && typeof segment === 'object').map(segment => {
    const copy = structuredClone(segment);
    if (typeof copy.data?.file === 'string' && copy.data.file.startsWith('base64://')) {
      copy.data.file = typeof copy.data.path === 'string' && copy.data.path ? win32.basename(copy.data.path) : String(copy.type);
    }
    if (copy.type === 'reply' && copy.data) delete copy.data.openqq_ref;
    return copy;
  });
}

// get_msg answers with pictures inlined again from disk, so a quoted picture reaches a framework that cannot read
// this machine's files; the cache keeps only the path. raw_message keeps the short form.
export function inlineStored(payload, io) {
  if (!payload || !Array.isArray(payload.message)) return payload;
  const message = payload.message.map(segment => {
    if (segment?.type !== 'image' || typeof segment.data?.path !== 'string' || String(segment.data.file).startsWith('base64://')) return segment;
    const data = { ...segment.data };
    inlinePicture(data, io);
    return { ...segment, data };
  });
  return { ...payload, message };
}

function integer(value, field, min = 0) {
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^-?\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < min) {
    throw new Error(field + ' 不是有效的 OneBot 数值标识');
  }
  return Number(value);
}
const id = (value, field) => integer(value, field, 1);

export function createEventConverter() {
  const ids = new Map();
  const refs = new Map();
  const seen = new Map();
  const stored = new Map();
  const store = (messageId, payload) => {
    stored.set(messageId, payload);
    if (stored.size > STORED_LIMIT) stored.delete(stored.keys().next().value);
  };
  let nextId = 1;
  const keyOf = (selfId, message, nativeId = message.msgId) => {
    if (!/^\d+$/.test(String(nativeId)) || (typeof nativeId === 'number' && !Number.isSafeInteger(nativeId))) {
      throw new Error('原生消息标识无效或已丢失精度');
    }
    return [selfId, message.chatType, message.peerUid, nativeId].join(':');
  };
  // Every OneBot id maps back to the native reference actions need (reply quotes, get_forward_msg).
  function messageId(key, ref) {
    if (!ids.has(key)) {
      ids.set(key, nextId);
      if (ref) refs.set(nextId, ref);
      nextId++;
    }
    // Id mappings and dedup keys live in memory (10000 entries); they would need persisting before any history API.
    if (ids.size > 10000) {
      const [, oldest] = ids.entries().next().value;
      ids.delete(ids.keys().next().value);
      refs.delete(oldest);
    }
    return ids.get(key);
  }
  const messageRef = (selfId, message, nativeId = message.msgId) => messageId(keyOf(selfId, message, nativeId),
    { kind: 'message', selfId, chatType: message.chatType, peerUid: String(message.peerUid), msgId: String(nativeId) });
  function forwardId(selfId, ref) {
    if (![ref?.root, ref?.parent].every(value => /^\d+$/.test(String(value)))) throw new Error('合并转发标识无效');
    return messageId(['forward', selfId, ref.chatType, ref.peerUid, ref.root, ref.parent].join(':'),
      { kind: 'forward', selfId, chatType: ref.chatType, peerUid: String(ref.peerUid), root: String(ref.root), parent: String(ref.parent) });
  }
  // Forwarded messages become go-cqhttp/NapCat compatible nodes: sender, time and the segments as message/content.
  function forwardNodes(selfId, ref, messages) {
    return messages.map(item => {
      const segments = (item.elements ?? []).map(element => convertSegment(element,
        original => messageRef(selfId, ref, original), inner => forwardSegment(selfId, inner)));
      const userId = /^[1-9]\d*$/.test(String(item.senderUin)) && Number.isSafeInteger(Number(item.senderUin)) ? Number(item.senderUin) : 0;
      const nickname = String(item.sendMemberName || item.sendNickName || '');
      const time = /^\d+$/.test(String(item.msgTime)) ? Number(item.msgTime) : 0;
      return { time, message_type: ref.chatType === 2 ? 'group' : 'private', user_id: userId,
        sender: { user_id: userId, nickname }, message: segments, content: segments, raw_message: cqString(segments), message_format: 'array' };
    });
  }
  function forwardSegment(selfId, ref) {
    const data = { id: String(forwardId(selfId, ref)) };
    if (Array.isArray(ref.messages)) data.content = forwardNodes(selfId, ref, ref.messages);
    return { type: 'forward', data };
  }
  // A reply carries a copy of the quoted message in `records` (sourceMsgIdInRecords points at that copy, not at the
  // message in chat history), so keep it under the quote's id: get_msg then answers any quote, however old.
  function storeQuotes(self, selfId, message, groupId) {
    if (!Array.isArray(message.records) || !message.records.length) return;
    for (const element of message.elements) {
      const reply = element?.elementType === 7 ? element.replyElement : undefined;
      const original = reply ? reply.sourceMsgIdInRecords || reply.replayMsgId : undefined;
      if (!/^\d+$/.test(String(original ?? ''))) continue;
      const record = message.records.find(item => String(item?.msgId) === String(original));
      if (!record || !Array.isArray(record.elements) || !record.elements.length) continue;
      try {
        const messageId = messageRef(selfId, message, original);
        if (stored.has(messageId)) continue;
        const senderId = /^[1-9]\d*$/.test(String(record.senderUin)) && Number.isSafeInteger(Number(record.senderUin)) ? Number(record.senderUin)
          : record.senderUid && record.senderUid === self.uid ? selfId : 0;
        const kept = slimForStorage(record.elements.map(item => convertSegment(item, inner => messageRef(selfId, message, inner),
          ref => forwardSegment(selfId, ref))));
        const sender = { user_id: senderId, nickname: String(record.sendNickName ?? '') };
        if (message.chatType === 2) sender.card = String(record.sendMemberName ?? '');
        store(messageId, { time: /^\d+$/.test(String(record.msgTime)) ? Number(record.msgTime) : 0,
          message_type: message.chatType === 2 ? 'group' : 'private', message_id: messageId, real_id: messageId, sender,
          message: kept, raw_message: cqString(kept), ...(groupId !== undefined ? { group_id: groupId } : {}) });
      } catch { /* a quote that cannot be converted is just not cached; get_msg falls back to QQ history */ }
    }
  }
  function messageEvent(self, message) {
    if (![1, 2, 100].includes(message.chatType)) return null;
    const selfId = id(self.uin, 'self_id');
    if (!Array.isArray(message.elements) || !message.elements.length) throw new Error('原生消息元素为空');
    const grayTips = message.elements.filter(element => element.elementType === 8);
    if (grayTips.length && !message.poke) throw new Error('尚未支持的灰条通知');
    const time = id(message.msgTime, 'time');
    const groupId = message.chatType === 2 ? id(message.peerUin ?? message.peerUid, 'group_id') : undefined;
    const key = keyOf(selfId, message);
    let event;
    if (message.poke) {
      if (message.elements.length !== 1 || grayTips.length !== 1 || String(grayTips[0].grayTipElement?.jsonGrayTipElement?.busiId) !== '1061') throw new Error('戳一戳缺少原生灰条标识');
      event = { post_type: 'notice', notice_type: 'notify', sub_type: 'poke',
        user_id: id(message.poke.userUin, 'user_id'), target_id: id(message.poke.targetUin, 'target_id') };
    } else {
      const senderId = id(message.senderUin, 'user_id');
      if (senderId === selfId) return null;
      const segments = message.elements.map(element => convertSegment(element, original => messageRef(selfId, message, original),
        ref => forwardSegment(selfId, ref)));
      event = { post_type: 'message', message_type: message.chatType === 2 ? 'group' : 'private',
        sub_type: message.chatType === 2 ? 'normal' : message.chatType === 100 ? 'group' : 'other',
        message_id: messageRef(selfId, message), user_id: senderId, message: segments, raw_message: cqString(segments),
        font: 0, sender: { user_id: senderId, nickname: String(message.sendNickName ?? '') },
      };
      if (message.chatType === 2) {
        event.sender.card = String(message.sendMemberName ?? '');
        event.sender.role = ['owner', 'admin', 'member'].includes(message.senderRole) ? message.senderRole : 'member';
        event.anonymous = null;
      }
      const kept = slimForStorage(segments);
      store(event.message_id, { time, message_type: event.message_type, message_id: event.message_id, real_id: event.message_id,
        sender: { ...event.sender }, message: kept, raw_message: cqString(kept), ...(groupId !== undefined ? { group_id: groupId } : {}) });
      storeQuotes(self, selfId, message, groupId);
    }
    if (groupId !== undefined) event.group_id = groupId;
    return { event: { time, self_id: selfId, ...event }, key: key + ':' + event.post_type };
  }
  function convert(raw) {
    let result;
    if (raw.type === 'message') result = messageEvent(raw.self, raw.message);
    else if (raw.type === 'notice' || raw.type === 'request') {
      const selfId = id(raw.self.uin, 'self_id');
      const event = { ...raw.event };
      const type = event.notice_type ?? event.request_type;
      if (!type) throw new Error('事件缺少类型');
      if (['group_admin', 'group_increase', 'group_decrease', 'group_ban', 'group_recall', 'group_upload', 'group_card', 'group_name', 'group'].includes(type)) event.group_id = id(event.group_id, 'group_id');
      // 0 is valid for whole-group bans and for membership notices whose member could not be resolved (flagged).
      const unknownMember = event.openqq_user_unknown === true && ['group_increase', 'group_decrease', 'group_admin'].includes(type);
      if (!['openqq_native', 'openqq_gray_tip', 'bot_offline'].includes(type)) event.user_id = integer(event.user_id, 'user_id', type === 'group_ban' || unknownMember ? 0 : 1);
      if ('target_id' in event) event.target_id = id(event.target_id, 'target_id');
      if ('operator_id' in event) event.operator_id = integer(event.operator_id, 'operator_id');
      if (['group_increase', 'group_decrease', 'group_ban', 'group_recall'].includes(type) && !('operator_id' in event)) throw new Error('通知缺少 operator_id');
      const subtypes = { group_admin: ['set', 'unset'], group_increase: ['approve', 'invite'], group_decrease: ['leave', 'kick', 'kick_me'], group_ban: ['ban', 'lift_ban'], group: ['add', 'invite'] };
      if (Object.hasOwn(subtypes, type) && !subtypes[type].includes(event.sub_type)) throw new Error('事件 sub_type 无效');
      if (type === 'group_ban') event.duration = integer(event.duration, 'duration', -1);
      if (type === 'group_recall' || type === 'friend_recall') event.message_id = messageRef(selfId, raw.message);
      if (type === 'group_upload') {
        if (typeof event.file?.id !== 'string' || !event.file.id || typeof event.file.name !== 'string') throw new Error('群文件标识无效');
        event.file = { ...event.file, size: integer(event.file.size, 'file.size'), busid: integer(event.file.busid, 'file.busid') };
      }
      if (raw.type === 'request' && (!['friend', 'group'].includes(event.request_type) || typeof event.flag !== 'string' || !event.flag)) throw new Error('请求类型或 flag 无效');
      result = { event: { time: id(raw.time ?? Math.floor(Date.now() / 1000), 'time'), self_id: selfId, post_type: raw.type, ...event },
        key: raw.key ? [selfId, raw.type, raw.key].join(':') : undefined };
    } else return null;
    if (!result) return null;
    if (result.key) {
      if (seen.has(result.key)) return null;
      seen.set(result.key, true);
      if (seen.size > 10000) seen.delete(seen.keys().next().value);
    }
    return result.event;
  };
  convert.messageId = (self, message) => messageRef(id(self.uin, 'self_id'), message);
  // A message we sent: QQ's receipt has no content, so keep the segments that were asked to be sent.
  convert.recordSent = (self, message, segments) => {
    const selfId = id(self.uin, 'self_id');
    const messageId = messageRef(selfId, message);
    const kept = slimForStorage(Array.isArray(segments) ? segments : []);
    store(messageId, { time: Math.floor(Date.now() / 1000), message_type: message.chatType === 2 ? 'group' : 'private',
      message_id: messageId, real_id: messageId, sender: { user_id: selfId, nickname: '' }, message: kept, raw_message: cqString(kept),
      ...(message.chatType === 2 ? { group_id: id(message.peerUid, 'group_id') } : {}) });
    return messageId;
  };
  // A message read back from QQ's history (any sender, ourselves included): convert it like a received one and keep it.
  convert.rememberHistory = (self, message) => {
    const selfId = id(self.uin, 'self_id');
    if (!message || ![1, 2, 100].includes(message.chatType) || !Array.isArray(message.elements) || !message.elements.length) {
      throw new Error('原生消息记录无效');
    }
    const senderId = id(message.senderUin, 'user_id');
    const segments = message.elements.map(element => convertSegment(element, original => messageRef(selfId, message, original),
      ref => forwardSegment(selfId, ref)));
    const messageId = messageRef(selfId, message);
    const sender = { user_id: senderId, nickname: String(message.sendNickName ?? '') };
    if (message.chatType === 2) sender.card = String(message.sendMemberName ?? '');
    const kept = slimForStorage(segments);
    store(messageId, { time: id(message.msgTime, 'time'), message_type: message.chatType === 2 ? 'group' : 'private',
      message_id: messageId, real_id: messageId, sender, message: kept, raw_message: cqString(kept),
      ...(message.chatType === 2 ? { group_id: id(message.peerUin ?? message.peerUid, 'group_id') } : {}) });
    return structuredClone(stored.get(messageId));
  };
  convert.getMessage = value => {
    if ((typeof value !== 'string' && typeof value !== 'number') || !/^[1-9]\d*$/.test(String(value))) return undefined;
    const found = stored.get(Number(value));
    return found ? structuredClone(found) : undefined;
  };
  // OneBot id → native reference (message or forward) seen in this run, or undefined.
  convert.resolve = value => {
    if ((typeof value !== 'string' && typeof value !== 'number') || !/^[1-9]\d*$/.test(String(value))) return undefined;
    return refs.get(Number(value));
  };
  convert.forwardResult = (self, forward) => {
    if (!forward?.ref || !Array.isArray(forward.messages)) throw new Error('合并转发回执无效');
    return { messages: forwardNodes(id(self.uin, 'self_id'), forward.ref, forward.messages) };
  };
  return convert;
}

export function createMessageConverter() {
  const convert = createEventConverter();
  return (self, message) => convert({ type: 'message', self, message });
}
