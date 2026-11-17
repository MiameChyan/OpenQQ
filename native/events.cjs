'use strict';

const { existsSync } = require('node:fs');
const { readSystemEvent } = require('./system.cjs');
const validUin = value => /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value));
const now = () => Math.floor(Date.now() / 1000);
// Merged-forward expansion limits: nesting depth, messages per root and serialized size (IPC frames cap at 1 MiB).
const FORWARD_DEPTH = 3;
const FORWARD_LIMIT = 200;
const FORWARD_BYTES = 512 * 1024;
// A member who just joined or left is often unknown to every UID store until QQ pushes the refreshed member list.
const MEMBER_RETRY_MS = 1500;
// Received pictures are not on disk yet. Ask QQ to fetch the original before reporting the message, so the
// event can carry a local file (the host inlines it); give up after this long and report the message anyway.
const MEDIA_TIMEOUT_MS = 10000;

function createEventReceiver(session, self, report, current, {
  memberRetryMs = MEMBER_RETRY_MS, mediaTimeoutMs = MEDIA_TIMEOUT_MS, mediaExists = existsSync,
} = {}) {
  const cache = new Map();
  // Group role of each sender (OneBot sender.role). Frameworks such as SealDice gate group-admin commands on it.
  // One lookup per member, refreshed by member info pushes; a failed lookup answers "member" (least privilege).
  const roles = new Map();
  const ROLE_TTL_MS = 10 * 60 * 1000;
  const roleName = role => role === 4 ? 'owner' : role === 3 ? 'admin' : 'member';
  const rememberRole = (group, uid, role) => {
    if (!uid || typeof role !== 'number') return;
    roles.set(`${group}:${uid}`, { role, at: Date.now() });
    if (roles.size > 10000) roles.delete(roles.keys().next().value);
  };
  async function roleOf(group, uid) {
    const hit = roles.get(`${group}:${uid}`);
    if (hit && Date.now() - hit.at < ROLE_TTL_MS) return roleName(hit.role);
    try {
      const infos = (await session.getGroupService().getMemberInfo(group, [uid], false))?.result?.infos;
      const role = infos instanceof Map ? infos.get(uid)?.role : undefined;
      if (typeof role === 'number') { rememberRole(group, uid, role); return roleName(role); }
    } catch { /* degrade to member below */ }
    return 'member';
  }
  // QQ leaves sendNickName empty on private messages. Nicknames come from the buddy list when it carries them,
  // otherwise from one profile lookup per user; a failed lookup only means the message goes out without a name.
  const nicks = new Map();
  const rememberNick = (uid, nick) => {
    if (!uid || typeof nick !== 'string' || !nick) return;
    nicks.set(uid, nick);
    if (nicks.size > 5000) nicks.delete(nicks.keys().next().value);
  };
  async function nickOf(uid) {
    if (!uid) return '';
    if (nicks.has(uid)) return nicks.get(uid);
    try {
      const result = await session.getProfileService().getCoreAndBaseInfo('nodeStore', [uid]);
      const core = (result instanceof Map ? result.get(uid) : undefined)?.coreInfo;
      rememberNick(uid, String(core?.nick || core?.remark || ''));
    } catch { /* report without a nickname */ }
    return nicks.get(uid) ?? '';
  }
  const mediaWaiters = new Map();
  const safeExists = value => { try { return typeof value === 'string' && value.length > 0 && mediaExists(value); } catch { return false; } };
  async function downloadPicture(peer, msgId, element) {
    const pic = element.picElement;
    if (safeExists(pic.sourcePath)) return pic.sourcePath;
    const elementId = String(element.elementId ?? '');
    if (!/^\d+$/.test(msgId) || !/^\d+$/.test(elementId)) return undefined;
    const key = `${msgId}:${elementId}`;
    let finish;
    const done = new Promise(resolve => {
      const timer = setTimeout(() => finish(undefined), mediaTimeoutMs);
      finish = value => { clearTimeout(timer); mediaWaiters.delete(key); resolve(value); };
      mediaWaiters.set(key, finish);
    });
    try {
      const result = await session.getMsgService().downloadRichMedia({ fileModelId: '0', downSourceType: 0, downloadSourceType: 0,
        triggerType: 1, msgId, chatType: peer.chatType, peerUid: peer.peerUid, elementId, thumbSize: 0, downloadType: 1,
        filePath: typeof pic.thumbPath?.get === 'function' ? (pic.thumbPath.get(0) ?? '') : '' });
      if (result && Number(result.result ?? 0) !== 0) finish(undefined);
    } catch (error) {
      emit({ type: 'event_error', stage: 'msg/picture', error: error.message + '，图片未下载，消息照常上报' });
      finish(undefined);
    }
    return done;
  }
  // A reply carries a copy of the quoted message in `records`; QQ does not download its pictures either, and the url
  // it gives for them returns 404. Try the copy first, then the original message found by the quote's seq.
  async function quotedPicture(peer, record, element, seq) {
    const direct = await downloadPicture(peer, String(record.msgId ?? ''), element);
    if (direct) return direct;
    const md5 = String(element.picElement?.md5HexStr ?? '').toLowerCase();
    if (!/^\d+$/.test(String(seq ?? '')) || !/^[0-9a-f]{32}$/.test(md5)) return undefined;
    try {
      const result = await session.getMsgService().getMsgsBySeqAndCount({ chatType: peer.chatType, peerUid: peer.peerUid, guildId: '' },
        String(seq), 1, true, true);
      const original = (Array.isArray(result?.msgList) ? result.msgList : []).find(item => String(item?.msgSeq) === String(seq));
      const match = (Array.isArray(original?.elements) ? original.elements : [])
        .find(item => item?.elementType === 2 && String(item.picElement?.md5HexStr ?? '').toLowerCase() === md5);
      if (match) return await downloadPicture(peer, String(original.msgId ?? ''), match);
    } catch (error) {
      emit({ type: 'event_error', stage: 'msg/quote-picture', error: error.message + '，被引用的图片未下载，消息照常上报' });
    }
    return undefined;
  }
  async function prepareQuotes(input, peer) {
    const records = input.records;
    if (!Array.isArray(records) || !records.length) return undefined;
    const quoted = new Map();
    for (const element of Array.isArray(input.elements) ? input.elements : []) {
      const reply = element?.elementType === 7 ? element.replyElement : undefined;
      const original = reply ? String(reply.sourceMsgIdInRecords || reply.replayMsgId || '') : '';
      if (/^\d+$/.test(original) && original !== '0') quoted.set(original, reply.replayMsgSeq);
    }
    if (!quoted.size) return undefined;
    return Promise.all(records.map(async record => {
      if (!record || !quoted.has(String(record.msgId)) || !Array.isArray(record.elements)) return record;
      const elements = await Promise.all(record.elements.map(async element => {
        if (element?.elementType !== 2 || !element.picElement) return element;
        const filePath = await quotedPicture(peer, record, element, quoted.get(String(record.msgId)));
        return filePath ? { ...element, picElement: { ...element.picElement, filePath } } : element;
      }));
      return { ...record, elements };
    }));
  }
  const seenShapes = new Set();
  const members = new Map();
  const started = now();
  let friends;
  let syncing = true;
  // Groups QQ has told us about, for get_group_list / get_group_info. QQ answers a refresh through the group listener.
  const groups = { map: new Map(), version: 0 };
  const groupWaiters = new Set();
  groups.waitForUpdate = (since, ms) => new Promise(resolve => {
    const finish = () => { clearTimeout(timer); groupWaiters.delete(finish); resolve(); };
    const timer = setTimeout(finish, ms);
    groupWaiters.add(finish);
    if (groups.version !== since) finish();
  });
  function updateGroups(type, list) {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (!item || !/^\d+$/.test(String(item.groupCode))) continue;
      if (type === 3) groups.map.delete(String(item.groupCode));
      else groups.map.set(String(item.groupCode), item);
    }
    groups.version++;
    for (const finish of [...groupWaiters]) finish();
  }
  const remember = (uid, uin) => {
    if (uid && validUin(uin)) cache.set(uid, String(uin));
    if (cache.size > 10000) cache.delete(cache.keys().next().value);
  };
  remember(self.uid, self.uin);

  const inflight = new Map();
  async function uin(uid, hint) {
    if (!current()) throw new Error('会话已失效');
    if (validUin(hint)) { remember(uid, hint); return String(hint); }
    if (validUin(uid)) return String(uid);
    if (typeof uid !== 'string' || !uid) throw new Error('事件缺少用户 UID');
    if (cache.has(uid)) return cache.get(uid);
    // NT UIDs are always "u_"-prefixed; anything else (e.g. the "0" placeholder) can never convert,
    // so fail fast instead of spending the 5-second lookup budget.
    if (!/^u_[\w-]+$/.test(uid)) throw new Error(`UID 格式无效：${uid.slice(0, 40)}`);
    // Bursts (a message with several @, a member leaving several groups) share one native lookup.
    if (inflight.has(uid)) return inflight.get(uid);
    const pending = lookup(uid).finally(() => inflight.delete(uid));
    inflight.set(uid, pending);
    return pending;
  }
  // Optional identities (operators, @ targets) degrade instead of discarding the whole event.
  async function optionalUin(uid, stage, hint) {
    try { return await uin(uid, hint); }
    catch (error) {
      if (!current()) throw error;
      emit({ type: 'event_error', stage, error: error.message + '，已按未知处理并继续上报' });
      return undefined;
    }
  }
  // The subject of a membership notice gets one delayed retry (member list pushes fill the cache meanwhile),
  // then degrades to unknown like an operator, so the join/leave itself is still reported.
  async function memberUin(uid, stage) {
    try { return await uin(uid); }
    catch (error) {
      if (!current()) throw error;
      await new Promise(resolve => setTimeout(resolve, memberRetryMs));
      return optionalUin(uid, stage);
    }
  }

  async function lookup(uid) {
    let timer;
    let finished = false;
    // Same fallback order as mature NTQQ bridges: strangers and members who just left a group
    // are often missing from the friend/profile store but still known to the group service.
    const lookups = [
      async () => (await session.getUixConvertService().getUin([uid]))?.uinInfo?.get(uid),
      async () => (await session.getProfileService().getUinByUid('FriendsServiceImpl', [uid]))?.get(uid),
      async () => (await session.getGroupService().getUinByUids([uid]))?.uins?.get(uid),
    ];
    const timeout = Symbol('timeout');
    let result;
    try {
      result = await Promise.race([
        (async () => {
          for (const lookup of lookups) {
            if (!current() || finished) return undefined;
            let value;
            try { value = await lookup(); } catch {}
            if (validUin(value)) return value;
          }
          return undefined;
        })(),
        new Promise(resolve => { timer = setTimeout(() => resolve(timeout), 5000); }),
      ]);
    } finally { finished = true; clearTimeout(timer); }
    if (result === timeout) throw new Error(`UID ${uid} 转 QQ 号超时（5 秒）`);
    if (!validUin(result)) throw new Error(`UID ${uid} 未能转换为 QQ 号（UixConvert/Profile/Group 均无映射）`);
    remember(uid, result);
    return String(result);
  }

  function emit(event) { if (current()) report(event); }
  function notice(event, key, time = now(), message) {
    emit({ type: 'notice', self, event, key, time, message });
  }
  async function batch(values, action, stage) {
    if (!Array.isArray(values)) throw new Error('事件列表必须为数组');
    await Promise.all(values.map(value => Promise.resolve().then(() => current() ? action(value) : undefined).catch(error => {
      emit({ type: 'event_error', stage, error: error.message });
    })));
  }
  function native(source, name, args) {
    // Unknown callbacks report structure once, never opaque network buffers or credentials.
    const key = `${source}/${name}`;
    if (seenShapes.has(key)) return;
    if (seenShapes.size >= 500) seenShapes.delete(seenShapes.values().next().value);
    seenShapes.add(key);
    const shape = value => value === null ? 'null' : Array.isArray(value) ? `array(${value.length})`
      : value instanceof Map ? `map(${value.size})` : typeof value === 'object' ? Object.keys(value).slice(0, 50) : typeof value;
    emit({ type: 'native_callback', source, event: name, argument_shapes: args.map(shape) });
  }

  // Reply sends need msgSeq/clientSeq of the quoted message; keep them for recently seen messages.
  const recent = new Map();
  function record(input, senderUin = input.senderUin) {
    if (!/^\d+$/.test(String(input?.msgId ?? ''))) return;
    recent.set(`${input.chatType}:${input.peerUid}:${input.msgId}`, { msgId: String(input.msgId), msgSeq: String(input.msgSeq ?? ''),
      clientSeq: String(input.clientSeq ?? ''), senderUin: String(senderUin ?? ''), senderUid: String(input.senderUid ?? '') });
    if (recent.size > 5000) recent.delete(recent.keys().next().value);
  }
  const lookupRecent = ref => recent.get(`${ref.chatType}:${ref.peerUid}:${ref.msgId}`);

  // Merged forwards: QQ fetches the content with getMultiMsg(peer, rootMsgId, parentMsgId), where root is the
  // message in the chat and parent is the message that directly carries the (possibly nested) forward.
  async function multiMsg(peer, root, parent) {
    let timer;
    try {
      const result = await Promise.race([
        session.getMsgService().getMultiMsg({ chatType: peer.chatType, peerUid: peer.peerUid, guildId: '' }, root, parent),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('合并转发内容获取超时（8 秒）')), 8000); }),
      ]);
      if (result?.result !== undefined && result.result !== 0) throw new Error(`QQ 拒绝获取合并转发：${result.errMsg || result.result}`);
      if (!Array.isArray(result?.msgList)) throw new Error('合并转发内容结构未适配');
      return result.msgList;
    } finally { clearTimeout(timer); }
  }
  async function forwardMessages(ctx, parent) {
    const list = await multiMsg(ctx.peer, ctx.root, parent);
    const messages = [];
    for (const item of list) {
      if (!current()) throw new Error('会话已失效');
      if (ctx.budget.left-- <= 0) break;
      remember(item.senderUid, item.senderUin);
      let senderUin = '0';
      // Forwarded authors are often strangers; the nickname still identifies them, so a missing QQ number is not an error.
      try { senderUin = await uin(item.senderUid, item.senderUin); } catch (error) { if (!current()) throw error; }
      messages.push({ msgId: String(item.msgId ?? ''), msgTime: item.msgTime, senderUin, senderUid: item.senderUid,
        sendNickName: item.sendNickName, sendMemberName: item.sendMemberName,
        elements: await prepare(Array.isArray(item.elements) ? item.elements : [], { ...ctx, depth: ctx.depth + 1 }, String(item.msgId ?? '')) });
    }
    return messages;
  }
  async function expandForward(ref) {
    return forwardMessages({ peer: { chatType: ref.chatType, peerUid: ref.peerUid }, root: ref.root, depth: 0, budget: { left: FORWARD_LIMIT } }, ref.parent);
  }
  const forwardSize = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? String(item) : item).length;

  async function prepare(elements, ctx, msgId) {
    return Promise.all(elements.map(async element => {
      const text = element.textElement;
      if (element.elementType === 1 && Number(text?.atType) === 2 && !validUin(text.atUid)) {
        // An unresolvable @ target keeps the native element (delivered as openqq_element) rather than losing the message.
        const target = await optionalUin(text.atNtUid, 'msg/at');
        return target ? { ...element, textElement: { ...text, atUid: target } } : element;
      }
      const forward = element.multiForwardMsgElement;
      if (element.elementType === 16 && forward && /^\d+$/.test(msgId)) {
        const ref = { chatType: ctx.peer.chatType, peerUid: ctx.peer.peerUid, root: ctx.root, parent: msgId };
        let messages;
        if (ctx.depth < FORWARD_DEPTH) {
          try {
            messages = await forwardMessages(ctx, msgId);
            if (forwardSize(messages) > FORWARD_BYTES) {
              messages = undefined;
              emit({ type: 'event_error', stage: 'msg/forward', error: '合并转发内容超过 512 KiB，事件只携带 id，请用 get_forward_msg 获取' });
            }
          } catch (error) {
            if (!current()) throw error;
            emit({ type: 'event_error', stage: 'msg/forward', error: error.message + '，事件只携带 id，可稍后用 get_forward_msg 重试' });
          }
        }
        return { ...element, multiForwardMsgElement: { ...forward, openqq: { ...ref, ...(messages ? { messages } : {}) } } };
      }
      if (element.elementType === 2 && element.picElement && ctx.depth === 0) {
        const filePath = await downloadPicture(ctx.peer, msgId, element);
        return filePath ? { ...element, picElement: { ...element.picElement, filePath } } : element;
      }
      return element;
    }));
  }

  async function message(input, update = false) {
    if (![1, 2, 100].includes(input.chatType)) { native('msg', 'unsupported_chat', [input]); return; }
    remember(input.senderUid, input.senderUin);
    if (input.chatType !== 2) remember(input.peerUid, input.peerUin);
    const gray = input.elements?.find(element => element.elementType === 8)?.grayTipElement;
    const key = `${input.chatType}:${input.peerUid}:${input.msgId}`;
    const time = input.recallTime && Number(input.recallTime) > 0
      ? Math.floor(Number(input.recallTime) / (Number(input.recallTime) > 1e11 ? 1000 : 1)) : input.msgTime;
    if (gray?.revokeElement) {
      if (update && (!Number(input.recallTime) || Number(time) < started - 5)) return;
      const user = await uin(input.senderUid, input.senderUin);
      // Only group recalls carry an operator; a friend recall must not fail on an unused lookup.
      const operator = input.chatType === 2 ? await optionalUin(gray.revokeElement.operatorUid, 'msg/recall/operator',
        gray.revokeElement.isSelfOperate ? self.uin : undefined) : undefined;
      notice({ notice_type: input.chatType === 2 ? 'group_recall' : 'friend_recall', user_id: user,
        ...(input.chatType === 2 ? { group_id: input.peerUin ?? input.peerUid, operator_id: operator ?? 0,
          ...(operator ? {} : { openqq_operator_unknown: true }) } : {}),
      }, `recall:${key}`, time, input);
      return;
    }
    if (update) return;
    // Offline sync replays placeholder records with no elements; there is nothing to report.
    // Note each msgType once at debug level (type numbers only, never content) instead of warning per record.
    if (!Array.isArray(input.elements) || !input.elements.length) {
      native('msg', `empty_message(msgType=${Number(input.msgType)},subMsgType=${Number(input.subMsgType)})`, []);
      return;
    }
    if (String(gray?.jsonGrayTipElement?.busiId) === '1061') {
      if (input.elements.length !== 1) throw new Error('戳一戳包含非预期的混合元素');
      let data;
      try { data = JSON.parse(gray.jsonGrayTipElement.jsonStr); } catch { throw new Error('戳一戳 JSON 无效'); }
      const users = Array.isArray(data?.items) ? data.items.filter(item => item?.uid) : [];
      if (users.length !== 2 || users.some(item => typeof item.uid !== 'string')) throw new Error('戳一戳缺少操作者或被戳者 UID');
      const [userUin, targetUin] = await Promise.all(users.map(item => uin(item.uid)));
      emit({ type: 'message', self, message: { ...input, poke: { userUin, targetUin } } });
      return;
    }
    if (input.chatType !== 2 && String(gray?.jsonGrayTipElement?.busiId) === '19324') {
      if (friends) friends.set(input.peerUid, input.peerUin);
      notice({ notice_type: 'friend_add', user_id: await uin(input.peerUid, input.peerUin) }, `friend-add:${key}`, input.msgTime);
      return;
    }
    if (gray?.groupElement && input.chatType === 2) {
      const group = gray.groupElement;
      const group_id = input.peerUin ?? input.peerUid;
      if (group.shutUp) {
        const ban = group.shutUp;
        const duration = Number(ban.duration);
        // user_id 0 means "whole group" in OneBot, so an unresolved member must still fail loudly;
        // only the operator may degrade.
        const operator = await optionalUin(ban.admin?.uid, 'msg/ban/operator');
        notice({ notice_type: 'group_ban', group_id,
          user_id: ban.member?.uid ? await uin(ban.member.uid) : 0,
          operator_id: operator ?? 0, ...(operator ? {} : { openqq_operator_unknown: true }), duration,
          sub_type: duration > 0 ? 'ban' : 'lift_ban',
        }, `ban:${key}`, input.msgTime);
        return;
      }
      if (group.type === 5) {
        notice({ notice_type: 'group_name', group_id, user_id: await uin(group.memberUid), group_name: String(group.groupName ?? '') }, key, input.msgTime);
        return;
      }
      // Membership changes use authoritative system pushes, which include the subtype and operator.
      if (group.type === 1) return;
    }
    if (gray) {
      notice({ notice_type: 'openqq_gray_tip', chat_type: input.chatType, peer_id: input.peerUin ?? input.peerUid,
        element: gray }, `gray:${key}`, input.msgTime);
      return;
    }
    const senderUin = await uin(input.senderUid, input.senderUin);
    record(input, senderUin);
    const peer = { chatType: input.chatType, peerUid: String(input.peerUid) };
    const [elements, records, senderRole] = await Promise.all([
      prepare(input.elements ?? [], { peer, root: String(input.msgId), depth: 0, budget: { left: FORWARD_LIMIT } }, String(input.msgId)),
      prepareQuotes(input, peer),
      input.chatType === 2 ? roleOf(String(input.peerUin ?? input.peerUid), input.senderUid) : undefined,
    ]);
    const nick = input.chatType !== 2 && !input.sendNickName ? await nickOf(input.senderUid) : '';
    emit({ type: 'message', self, message: { ...input, senderUin, elements, ...(records ? { records } : {}), ...(nick ? { sendNickName: nick } : {}),
      ...(senderRole ? { senderRole } : {}) } });
    if (input.chatType === 2) for (const element of elements) {
      const file = element.fileElement;
      if (element.elementType === 3 && file?.fileUuid) notice({ notice_type: 'group_upload', group_id: input.peerUin ?? input.peerUid,
        user_id: senderUin, file: { id: String(file.fileUuid), name: file.fileName, size: file.fileSize, busid: file.fileBizId ?? 0 },
      }, `upload:${key}:${element.elementId ?? file.fileUuid}`, input.msgTime);
    }
  }

  async function groupNotifies(notifies) {
    await batch(notifies, async item => {
      const group_id = item.group?.groupCode;
      const key = `group-notify:${item.seq}:${item.type}`;
      const rawTime = /^\d+$/.test(String(item.seq)) ? Number(BigInt(item.seq) / 1000000n) : 0;
      const time = rawTime > 0 ? rawTime : now();
      if ([1, 5, 7].includes(item.type) && item.status === 1) {
        emit({ type: 'request', self, key, time, event: { request_type: 'group', group_id,
          sub_type: item.type === 1 ? 'invite' : 'add', user_id: await uin(item.type === 1 ? item.user2?.uid : item.user1?.uid),
          // The flag carries everything set_group_add_request needs to answer this notification.
          comment: String(item.postscript ?? ''), flag: `g:${group_id}:${item.type}:${item.seq}`,
        } });
      } else native('group', 'onGroupNotifiesUpdated', [item]);
    }, 'group/notifies');
  }

  async function receive(source, name, args) {
    if (source === 'msg') {
      if (name === 'onRichMediaDownloadComplete') {
        const info = args[0] ?? {};
        const finish = mediaWaiters.get(`${info.msgId}:${info.msgElementId}`);
        // QQ reports completion after the file is written; a non-zero error code means the download failed.
        if (finish) finish(Number(info.fileErrCode ?? 0) === 0 && typeof info.filePath === 'string' && info.filePath ? info.filePath : undefined);
        return;
      }
      if (name === 'onNtMsgSyncStart' || name === 'onNtMsgSyncEnd') {
        syncing = name === 'onNtMsgSyncStart';
        emit({ type: 'sync_state', syncing });
        return;
      }
      if (['onRecvMsg', 'onRecvOnlineFileMsg', 'onMsgInfoListUpdate'].includes(name)) {
        await batch(args[0], value => message(value, name === 'onMsgInfoListUpdate'), name);
        return;
      }
      if (name === 'onRecvSysMsg') {
        const event = readSystemEvent(args[0]);
        if (!event) { native(source, name, args); return; }
        const { user_uid, operator_uid, ...fields } = event.event;
        if (!user_uid && fields.openqq_reason !== 'disband') throw new Error('系统通知缺少成员 UID');
        const member = await memberUin(user_uid || self.uid, `${source}/${name}/member`);
        fields.user_id = member ?? 0;
        if (!member) fields.openqq_user_unknown = true;
        if (operator_uid) {
          // A missing operator mapping must not discard the membership change itself.
          const operator = await optionalUin(operator_uid, `${source}/${name}/operator`);
          fields.operator_id = operator ?? 0;
          if (!operator) fields.openqq_operator_unknown = true;
        } else if (fields.notice_type === 'group_decrease' && fields.sub_type === 'leave') {
          fields.operator_id = fields.user_id;
          if (!member) fields.openqq_operator_unknown = true;
        }
        if (fields.notice_type === 'group_decrease' && fields.sub_type === 'kick' && fields.user_id === self.uin) fields.sub_type = 'kick_me';
        notice(fields, event.key, event.time);
        return;
      }
      if (name === 'onInputStatusPush') {
        const value = args[0];
        if (!value || typeof value !== 'object') return;
        notice({ notice_type: 'notify', sub_type: 'input_status', user_id: await uin(value.fromUin),
          status_text: String(value.statusText ?? ''), event_type: value.eventType }, undefined);
        return;
      }
      if (name === 'onKickedOffLine') {
        emit({ type: 'offline', self_id: self.uin });
        notice({ notice_type: 'bot_offline', reason: String(args[0]?.tipsDesc ?? '') });
        return;
      }
    }
    if (source === 'group') {
      if (name === 'onGroupListUpdate') { updateGroups(args[0], args[1]); return; }
      if (name === 'onGroupNotifiesUpdated') return groupNotifies(args[1]);
      if (name === 'onGroupNotifiesUpdatedV2') return groupNotifies(args[2]);
      if (name === 'onGroupSingleScreenNotifies') return groupNotifies(args[2]);
      if (name === 'onMemberListChange') {
        // Member list pushes carry uid → uin pairs; caching them lets membership notices and mentions resolve.
        const infos = args[0]?.infos;
        if (!(infos instanceof Map)) { native(source, name, args); return; }
        for (const [uid, info] of infos) { remember(uid, info?.uin); rememberRole(String(args[0]?.groupCode ?? ''), uid, info?.role); }
        return;
      }
      if (name === 'onMemberInfoChange') {
        for (const [uid, info] of args[2] instanceof Map ? args[2] : []) {
          remember(uid, info.uin);
          rememberRole(String(args[0]), uid, info.role);
          const key = `${args[0]}:${uid}`;
          const previous = members.get(key);
          members.set(key, { cardName: info.cardName, memberSpecialTitle: info.memberSpecialTitle });
          if (members.size > 10000) members.delete(members.keys().next().value);
          if (previous && info.cardName !== undefined && previous.cardName !== undefined && info.cardName !== previous.cardName) {
            notice({ notice_type: 'group_card', group_id: args[0], user_id: await uin(uid, info.uin), card_old: previous.cardName, card_new: info.cardName });
          }
          if (previous && info.memberSpecialTitle !== undefined && previous.memberSpecialTitle !== undefined && info.memberSpecialTitle !== previous.memberSpecialTitle) {
            notice({ notice_type: 'notify', sub_type: 'title', group_id: args[0], user_id: await uin(uid, info.uin), title: info.memberSpecialTitle });
          }
        }
        return;
      }
    }
    if (source === 'buddy') {
      if (name === 'onBuddyReqChange') {
        await batch(args[0]?.buddyReqs, async req => {
          if (req.isInitiator || !req.isUnread || (req.isDecide && req.reqType !== 13)) return;
          emit({ type: 'request', self, time: req.reqTime, key: `friend:${req.friendUid}:${req.reqTime}`, event: {
            request_type: 'friend', user_id: await uin(req.friendUid), comment: String(req.extWords ?? ''), flag: `f:${req.friendUid}:${req.reqTime}`,
          } });
        }, 'buddy/requests');
        return;
      }
      if (name === 'onBuddyListChange') {
        if (!Array.isArray(args[0]) || args[0].some(category => !Array.isArray(category.buddyList))) throw new Error('好友列表回调结构未适配');
        const next = new Map();
        for (const category of args[0] ?? []) for (const buddy of category.buddyList ?? []) {
          remember(buddy.uid, buddy.uin);
          rememberNick(buddy.uid, buddy.coreInfo?.nick || buddy.nick || buddy.coreInfo?.remark || buddy.remark);
          next.set(buddy.uid, buddy.uin);
        }
        if (friends && !syncing) {
          for (const [uid, hint] of next) if (!friends.has(uid)) notice({ notice_type: 'friend_add', user_id: await uin(uid, hint) });
          for (const [uid, hint] of friends) if (!next.has(uid)) notice({ notice_type: 'friend_delete', user_id: await uin(uid, hint) });
        }
        // The first complete list establishes a baseline; it is not a wave of new friends.
        friends = next;
        return;
      }
    }
    native(source, name, args);
  }
  // Services the action handler shares: forward fetching, quoted-message metadata and self-sent records.
  receive.expandForward = expandForward;
  receive.lookupRecent = lookupRecent;
  receive.record = record;
  receive.groups = groups;
  return receive;
}

module.exports = { createEventReceiver };
