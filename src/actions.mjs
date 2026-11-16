import nativeActions from '../native/actions.cjs';

const fail = (message, retcode = 1400) => Object.assign(new Error(message), { retcode });
const sendActions = ['send_private_msg', 'send_group_msg', 'send_msg'];

// OneBot ids are local to this process; translate them into the native references QQ needs before validation.
function resolveReferences(converter, request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return request;
  const params = request.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return request;
  if (request.action === 'get_forward_msg') {
    const ref = converter.resolve(params.id ?? params.message_id);
    if (!ref) throw fail('合并转发 id 不存在或已过期（仅支持本次运行期间收到的消息）', 1404);
    // A message id also works: QQ keys a top-level forward by the message that carries it.
    const forward = ref.kind === 'forward' ? ref : { chatType: ref.chatType, peerUid: ref.peerUid, root: ref.msgId, parent: ref.msgId };
    return { ...request, params: { ...params, openqq_ref: { chatType: forward.chatType, peerUid: forward.peerUid, root: forward.root, parent: forward.parent } } };
  }
  if (request.action === 'delete_msg') {
    const ref = converter.resolve(params.message_id);
    if (ref?.kind !== 'message') throw fail('message_id 不存在或已过期（仅支持本次运行期间收发过的消息）', 1404);
    return { ...request, params: { ...params, openqq_ref: { chatType: ref.chatType, peerUid: ref.peerUid, msgId: ref.msgId } } };
  }
  if (!sendActions.includes(request.action) || !Array.isArray(params.message)) return request;
  const message = params.message.map(segment => {
    if (segment?.type !== 'reply') return segment;
    const ref = converter.resolve(segment.data?.id);
    if (ref?.kind !== 'message') throw fail('引用的消息不存在或已过期（仅支持本次运行期间收发过的消息）', 1404);
    return { type: 'reply', data: { id: String(segment.data.id), openqq_ref: { chatType: ref.chatType, peerUid: ref.peerUid, msgId: ref.msgId } } };
  });
  return { ...request, params: { ...params, message } };
}

// Answers that need no QQ session. `can_send_*` is always yes because sending media is implemented here.
function localAnswer(request, options) {
  if (request?.action === 'get_version_info') {
    return { app_name: 'OpenQQ', app_version: options.version ?? '', protocol_version: 'v11' };
  }
  if (request?.action === 'can_send_image' || request?.action === 'can_send_record') return { yes: true };
  return undefined;
}

// `options.media` (see src/media.mjs) turns image / record / video / file segments into prepared local files.
export async function dispatchAction(channel, converter, request, options = {}) {
  let response;
  let release = async () => {};
  try {
    const local = localAnswer(request, options);
    if (request?.action === 'get_msg') {
      const messageId = request.params?.message_id;
      let found = converter.getMessage?.(messageId);
      if (!found) {
        // Not seen in this run (e.g. a quote of a message from before a restart): ask QQ's own history once.
        const ref = converter.resolve?.(messageId);
        if (ref?.kind !== 'message') throw fail('message_id 不存在或已过期（仅支持本次运行期间收发过的消息）', 1404);
        const prepared = { action: 'get_msg', params: { message_id: messageId, openqq_ref: { chatType: ref.chatType, peerUid: ref.peerUid, msgId: ref.msgId } } };
        const action = nativeActions.validateAction(prepared);
        const reply = await channel.request(prepared, (action.timeout ?? 15000) + 5000);
        if (!reply || !['ok', 'failed'].includes(reply.status) || !Number.isSafeInteger(reply.retcode)) throw new Error('原生动作回执无效');
        if (reply.status !== 'ok') throw fail(reply.message ?? '读取消息失败', reply.retcode);
        found = converter.rememberHistory(reply.data.self, reply.data.message);
      }
      response = { status: 'ok', retcode: 0, data: found };
    } else if (local !== undefined) {
      response = { status: 'ok', retcode: 0, data: local };
    } else {
      let prepared = resolveReferences(converter, nativeActions.normalizeParams(request));
      const sentSegments = Array.isArray(prepared?.params?.message) ? prepared.params.message : [];
      if (options.media && sendActions.includes(prepared?.action) && prepared.params && typeof prepared.params === 'object') {
        const media = await options.media.prepare(prepared.params);
        prepared = { ...prepared, params: media.params };
        release = media.release;
      }
      const action = nativeActions.validateAction(prepared);
      response = await channel.request(prepared, (action.timeout ?? 15000) + 5000);
      if (!response || !['ok', 'failed'].includes(response.status) || !Number.isSafeInteger(response.retcode)) throw new Error('原生动作回执无效');
      if (response.status === 'ok' && response.retcode !== 0) throw new Error('原生动作回执状态不一致');
      if (response.status === 'ok' && action.kind === 'send') {
        const messageId = converter.recordSent
          ? converter.recordSent(response.data.self, response.data.message, sentSegments)
          : converter.messageId(response.data.self, response.data.message);
        response = { status: 'ok', retcode: 0, data: { message_id: messageId } };
      }
      if (response.status === 'ok' && action.kind === 'forward') {
        response = { status: 'ok', retcode: 0, data: converter.forwardResult(response.data.self, response.data.forward) };
      }
    }
  } catch (error) {
    response = { status: 'failed', retcode: error.retcode ?? 1500, data: null, message: error.message };
  } finally {
    await release();
  }
  return { ...response, ...(request && Object.hasOwn(request, 'echo') ? { echo: request.echo } : {}) };
}
