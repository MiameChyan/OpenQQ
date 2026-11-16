import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import nativeEvents from '../native/events.cjs';
import { convertSegment } from '../src/segments.mjs';

const MD5 = 'a2e8c67f2bdad07a0e8d37d130c692af';
const self = { uin: '123456', uid: 'u_self' };
const picMessage = (pic = {}) => ({ chatType: 1, msgId: '7001', msgTime: '1794470400', peerUid: 'u_actor', peerUin: '654321',
  senderUid: 'u_actor', senderUin: '654321',
  elements: [{ elementType: 2, elementId: '8001', picElement: { md5HexStr: MD5, fileName: MD5.toUpperCase() + '.jpg',
    sourcePath: 'C:\\QQ\\Pic\\Ori\\a.jpg', ...pic } }] });

function receiver({ exists = () => false, timeoutMs = 60, result = 0 } = {}) {
  const raw = [];
  const calls = [];
  const session = {
    getUixConvertService: () => ({ getUin: async uids => ({ uinInfo: new Map(uids.map(uid => [uid, '654321'])) }) }),
    getMsgService: () => ({ downloadRichMedia: async params => { calls.push(params); return { result }; } }),
  };
  const receive = nativeEvents.createEventReceiver(session, self, event => raw.push(event), () => true,
    { mediaTimeoutMs: timeoutMs, mediaExists: exists });
  const message = () => raw.find(event => event.type === 'message')?.message;
  return { receive, raw, calls, message };
}

test('a received picture is downloaded and its local path is attached before the event goes out', async () => {
  const f = receiver({ timeoutMs: 2000 });
  const pending = f.receive('msg', 'onRecvMsg', [[picMessage()]]);
  await setImmediate();
  assert.equal(f.calls.length, 1, 'downloadRichMedia called once');
  assert.deepEqual({ msgId: f.calls[0].msgId, elementId: f.calls[0].elementId, peerUid: f.calls[0].peerUid, chatType: f.calls[0].chatType },
    { msgId: '7001', elementId: '8001', peerUid: 'u_actor', chatType: 1 });
  assert.equal(f.message(), undefined, 'event waits for the download');
  await f.receive('msg', 'onRichMediaDownloadComplete', [{ msgId: '7001', msgElementId: '8001', fileErrCode: 0, filePath: 'C:\\QQ\\Pic\\Ori\\a.jpg' }]);
  await pending;
  assert.equal(f.message().elements[0].picElement.filePath, 'C:\\QQ\\Pic\\Ori\\a.jpg');
});

test('a picture already on disk is not downloaded again', async () => {
  const f = receiver({ exists: path => path === 'C:\\QQ\\Pic\\Ori\\a.jpg' });
  await f.receive('msg', 'onRecvMsg', [[picMessage()]]);
  assert.equal(f.calls.length, 0);
  assert.equal(f.message().elements[0].picElement.filePath, 'C:\\QQ\\Pic\\Ori\\a.jpg');
});

test('a download that never completes does not block the message', async () => {
  const f = receiver({ timeoutMs: 40 });
  const started = Date.now();
  await f.receive('msg', 'onRecvMsg', [[picMessage()]]);
  assert.ok(Date.now() - started < 1000);
  assert.equal(f.message().elements[0].picElement.filePath, undefined);
});

test('completion for another element or a failed download is ignored', async () => {
  const f = receiver({ timeoutMs: 80 });
  const pending = f.receive('msg', 'onRecvMsg', [[picMessage()]]);
  await setImmediate();
  await f.receive('msg', 'onRichMediaDownloadComplete', [{ msgId: '7001', msgElementId: '9999', fileErrCode: 0, filePath: 'C:\\other.jpg' }]);
  await f.receive('msg', 'onRichMediaDownloadComplete', [{ msgId: '7001', msgElementId: '8001', fileErrCode: 1, filePath: 'C:\\broken.jpg' }]);
  await pending;
  assert.equal(f.message().elements[0].picElement.filePath, undefined);
});

test('a rejected download request does not wait or throw', async () => {
  const f = receiver({ timeoutMs: 5000, result: 1 });
  const started = Date.now();
  await f.receive('msg', 'onRecvMsg', [[picMessage()]]);
  assert.ok(Date.now() - started < 1000, 'non-zero result returns at once');
  assert.ok(f.message(), 'message still emitted');
});

// ---- host side: inline the downloaded file so a bot in another environment (e.g. a container) can see it ----
const pic = (extra = {}) => ({ elementType: 2, picElement: { md5HexStr: MD5, fileName: MD5.toUpperCase() + '.jpg',
  originImageUrl: '/download?appid=1406&fileid=x&spec=0', filePath: 'C:\\QQ\\Pic\\Ori\\a.jpg', ...extra } });
const io = (bytes, { size = bytes?.length } = {}) => ({
  stat: path => { if (!bytes) throw new Error('ENOENT ' + path); return { size, isFile: () => true }; },
  read: () => bytes,
});

test('a local picture is inlined as base64 and the unusable url is dropped', () => {
  const seg = convertSegment(pic(), id => id, undefined, io(Buffer.from('JPEGDATA')));
  assert.equal(seg.data.file, 'base64://' + Buffer.from('JPEGDATA').toString('base64'));
  assert.equal(seg.data.url, undefined);
  assert.equal(seg.data.path, 'C:\\QQ\\Pic\\Ori\\a.jpg');
});

test('a missing or oversized file keeps the url fallback', () => {
  const missing = convertSegment(pic(), id => id, undefined, io(null));
  assert.equal(missing.data.file, MD5.toUpperCase() + '.jpg');
  assert.ok(missing.data.url);
  const big = convertSegment(pic(), id => id, undefined, io(Buffer.from('x'), { size: 6 * 1024 * 1024 }));
  assert.equal(big.data.file, MD5.toUpperCase() + '.jpg');
  assert.ok(big.data.url);
});

test('only pictures are inlined', () => {
  const file = convertSegment({ elementType: 3, fileElement: { fileName: 'a.txt', filePath: 'C:\\a.txt' } }, id => id, undefined, io(Buffer.from('T')));
  assert.equal(file.data.file, 'a.txt');
});

test('raw_message (CQ code) does not repeat the inlined picture', async () => {
  const { cqString } = await import('../src/segments.mjs');
  const seg = convertSegment(pic(), id => id, undefined, io(Buffer.from('JPEGDATA')));
  const cq = cqString([seg]);
  assert.ok(!cq.includes(Buffer.from('JPEGDATA').toString('base64')));
  assert.ok(cq.startsWith('[CQ:image,file=base64://...'));
});
