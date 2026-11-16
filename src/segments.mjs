import { readFileSync, statSync } from 'node:fs';

function numeric(value) { return /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)); }
const text = value => typeof value === 'string' && value.length > 0;

// A downloaded picture is inlined as base64 so a bot that cannot read this machine's disk (e.g. in a container)
// still sees it. Larger files keep only the url fallback.
const INLINE_LIMIT = 5 * 1024 * 1024;
const defaultIo = { stat: statSync, read: readFileSync };
function inlinePicture(data, io) {
  if (!text(data.path)) return;
  try {
    const info = io.stat(data.path);
    if (!info.isFile() || info.size > INLINE_LIMIT) return;
    data.file = 'base64://' + io.read(data.path).toString('base64');
    delete data.url;
  } catch { /* keep the url fallback */ }
}

// 收到的图片不会自动下载到本地，事件里给出一个可直接下载的地址，
// 否则跑在别处（如容器里）的机器人框架看不到图片内容。做法与 NapCat 一致：
// 相对路径补上官方媒体域名；NT 新版地址缺 rkey 时无法下载，退回按 MD5 拼的旧式地址。
const NT_HOST = 'https://multimedia.nt.qq.com.cn';
const GCHAT_HOST = 'https://gchat.qpic.cn';
function imageUrl(value) {
  const origin = typeof value.originImageUrl === 'string' ? value.originImageUrl : '';
  if (/^https?:\/\//.test(origin)) return origin;
  if (origin.startsWith('/') && !origin.startsWith('//')) {
    const params = new URL(GCHAT_HOST + origin).searchParams;
    const ntV2 = ['1406', '1407'].includes(params.get('appid') ?? '') && params.get('fileid');
    if (ntV2 && params.get('rkey')) return NT_HOST + origin;
    if (!ntV2) return GCHAT_HOST + origin;
  }
  const md5 = typeof value.md5HexStr === 'string' ? value.md5HexStr : '';
  if (/^[0-9a-fA-F]{32}$/.test(md5)) return `${GCHAT_HOST}/gchatpic_new/0/0-0-${md5.toUpperCase()}/0`;
  return undefined;
}

export function convertSegment(element, replyId, forward, io = defaultIo) {
  const fallback = () => ({ type: 'openqq_element', data: { element_type: element.elementType, element } });
  if (element.elementType === 1) {
    const value = element.textElement;
    if (typeof value?.content !== 'string') throw new Error('文本元素缺少 content');
    const at = Number(value.atType ?? 0);
    if (at === 0) return { type: 'text', data: { text: value.content } };
    if (at === 1) return { type: 'at', data: { qq: 'all' } };
    if (at === 2 && numeric(value.atUid) && Number(value.atUid) > 0) return { type: 'at', data: { qq: String(value.atUid) } };
    return fallback();
  }
  if (element.elementType === 6 && numeric(element.faceElement?.faceIndex)) {
    return { type: 'face', data: { id: String(element.faceElement.faceIndex) } };
  }
  const media = { 2: ['image', 'picElement'], 3: ['file', 'fileElement'], 4: ['record', 'pttElement'], 5: ['video', 'videoElement'] }[element.elementType];
  if (media) {
    const value = element[media[1]];
    if (!value) return fallback();
    const file = value.fileName || value.md5HexStr || value.fileUuid;
    if (!text(file)) return fallback();
    const data = { file, ...(value.fileUuid ? { file_id: String(value.fileUuid) } : {}) };
    if (text(value.filePath)) data.path = value.filePath;
    if (media[0] === 'image') {
      const url = imageUrl(value);
      if (url) data.url = url;
      inlinePicture(data, io);
    } else if (text(value.originImageUrl) && /^https?:\/\//.test(value.originImageUrl)) data.url = value.originImageUrl;
    if (numeric(value.fileSize)) data.file_size = Number(value.fileSize);
    return { type: media[0], data };
  }
  if (element.elementType === 7 && element.replyElement) {
    const value = element.replyElement;
    const original = value.sourceMsgIdInRecords || value.replayMsgId;
    if (/^\d+$/.test(String(original)) && String(original) !== '0' && (typeof original !== 'number' || Number.isSafeInteger(original))) {
      return { type: 'reply', data: { id: String(replyId(original)) } };
    }
    return fallback();
  }
  if (element.elementType === 16 && element.multiForwardMsgElement?.openqq && forward) return forward(element.multiForwardMsgElement.openqq);
  if (element.elementType === 10 && text(element.arkElement?.bytesData)) return { type: 'json', data: { data: element.arkElement.bytesData } };
  if (element.elementType === 13 && text(element.structLongMsgElement?.xmlContent)) return { type: 'xml', data: { data: element.structLongMsgElement.xmlContent } };
  if (element.elementType === 11 && element.marketFaceElement) {
    const value = element.marketFaceElement;
    return { type: 'mface', data: { emoji_id: String(value.emojiId ?? ''), emoji_package_id: value.emojiPackageId, summary: String(value.faceName ?? '') } };
  }
  if (element.elementType === 14 && element.markdownElement) return { type: 'markdown', data: element.markdownElement };
  return fallback();
}

const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('[', '&#91;').replaceAll(']', '&#93;');
export function cqString(segments) {
  // A forward's expanded content stays in the array form; its CQ code carries only the id, as in go-cqhttp.
  // An inlined picture keeps its base64 in the array form only, so raw_message does not carry the file twice.
  const brief = data => typeof data.file === 'string' && data.file.startsWith('base64://') ? { ...data, file: 'base64://...' } : data;
  return segments.map(segment => segment.type === 'text' ? escape(segment.data.text)
    : `[CQ:${segment.type}${Object.entries(segment.type === 'forward' ? { id: segment.data.id } : brief(segment.data)).map(([key, value]) => `,${key}=${escape(typeof value === 'object' ? JSON.stringify(value) : value).replaceAll(',', '&#44;')}`).join('')}]`).join('');
}
