import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertSegment } from '../src/segments.mjs';

const MD5 = 'befa16471df33822dd7c0de0543123e4';
const pic = (extra = {}) => ({ elementType: 2, picElement: { fileName: MD5.toUpperCase() + '.jpg', md5HexStr: MD5, fileSize: '79631', ...extra } });
const url = element => convertSegment(element, id => id).data.url;

test('absolute http(s) originImageUrl is kept as-is', () => {
  assert.equal(url(pic({ originImageUrl: 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=abc&rkey=r' })),
    'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=abc&rkey=r');
});

test('NT v2 relative url with rkey gets the NT media host', () => {
  assert.equal(url(pic({ originImageUrl: '/download?appid=1406&fileid=EhQx&spec=0&rkey=CAQSKA' })),
    'https://multimedia.nt.qq.com.cn/download?appid=1406&fileid=EhQx&spec=0&rkey=CAQSKA');
});

test('NT v2 relative url without rkey cannot be fetched, falls back to the md5 url', () => {
  assert.equal(url(pic({ originImageUrl: '/download?appid=1407&fileid=EhQx&spec=0' })),
    `https://gchat.qpic.cn/gchatpic_new/0/0-0-${MD5.toUpperCase()}/0`);
});

test('legacy relative path gets the gchat host', () => {
  assert.equal(url(pic({ originImageUrl: '/gchatpic_new/1/0-0-ABC/0?term=2' })), 'https://gchat.qpic.cn/gchatpic_new/1/0-0-ABC/0?term=2');
});

test('no originImageUrl but md5 present uses the md5 url', () => {
  assert.equal(url(pic()), `https://gchat.qpic.cn/gchatpic_new/0/0-0-${MD5.toUpperCase()}/0`);
});

test('no originImageUrl and no usable md5 gives no url', () => {
  assert.equal(url(pic({ md5HexStr: '' })), undefined);
  assert.equal(url(pic({ md5HexStr: 'not-a-md5' })), undefined);
});

test('protocol-relative or odd urls are not trusted', () => {
  assert.equal(url(pic({ originImageUrl: '//evil.example/x.jpg' })), `https://gchat.qpic.cn/gchatpic_new/0/0-0-${MD5.toUpperCase()}/0`);
  assert.equal(url(pic({ originImageUrl: 'javascript:alert(1)', md5HexStr: '' })), undefined);
});

test('other media types do not get an md5 image url', () => {
  const file = convertSegment({ elementType: 3, fileElement: { fileName: 'a.txt', md5HexStr: MD5 } }, id => id);
  assert.equal(file.type, 'file');
  assert.equal(file.data.url, undefined);
  const record = convertSegment({ elementType: 4, pttElement: { fileName: 'a.amr', md5HexStr: MD5 } }, id => id);
  assert.equal(record.data.url, undefined);
});

test('image segment keeps file and path fields', () => {
  const seg = convertSegment(pic({ filePath: 'C:\\QQ\\Pic\\a.jpg', originImageUrl: '/download?appid=1406&fileid=x&rkey=y' }), id => id);
  assert.equal(seg.type, 'image');
  assert.equal(seg.data.file, MD5.toUpperCase() + '.jpg');
  assert.equal(seg.data.path, 'C:\\QQ\\Pic\\a.jpg');
});
