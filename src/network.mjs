import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';

function extractToken(request, url) {
  const header = request.headers.authorization;
  if (header !== undefined) {
    const match = header.match(/^Bearer\s+(.+)$/i);
    return match ? match[1] : '';
  }
  return url.searchParams.get('access_token') ?? '';
}

export async function startOneBot({ config, dispatch, onStatus = () => {} }) {
  const peers = new Map();
  const reverse = config.reverseWs.filter(item => item.enabled).map(item => ({ ...item, state: 'waiting', socket: null, timer: null }));
  const authFailures = new Map();
  let state = { phase: 'starting' };
  // 一帧要装得下内嵌 base64 的媒体（图片上限 30 MiB → base64 约 40 MiB）。
  // 原来的 256 KiB 会让带大于约 190 KB 图片的 send_msg 直接断开连接，调用方只能等到超时。
  const maxPayload = 64 * 1024 * 1024;
  let closed = false;
  let server;
  let wss;
  let address = null;
  const ready = () => state.phase === 'session_ready' && state.syncing !== true && Number.isSafeInteger(Number(state.self_id)) && Number(state.self_id) > 0;
  const report = () => onStatus({ ws: { enabled: config.ws.enabled, address, clients: [...peers.values()].filter(p => !p.reverse).length },
    reverseWs: reverse.map((item, index) => ({ index, state: item.state })) });
  const meta = extra => ({ time: Math.floor(Date.now() / 1000), self_id: Number(state.self_id), post_type: 'meta_event', ...extra });
  function send(socket, value) {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 1024 * 1024) { socket.terminate(); return; }
    socket.send(JSON.stringify(value));
  }
  function attach(socket, role, isReverse = false) {
    const peer = { role, reverse: isReverse, active: 0, announced: false, alive: true };
    peers.set(socket, peer);
    socket.on('error', () => {});
    socket.on('pong', () => { peer.alive = true; });
    socket.on('close', () => { peers.delete(socket); report(); });
    socket.on('message', async (data, binary) => {
      if (role === 'event') return;
      let request;
      try {
        if (binary) throw new Error();
        request = JSON.parse(data.toString());
        if (!request || typeof request !== 'object' || Array.isArray(request) || typeof request.action !== 'string') throw new Error();
      } catch { send(socket, { status: 'failed', retcode: 1400, data: null, message: '需要 JSON 动作对象' }); return; }
      const fail = (retcode, message) => ({ status: 'failed', retcode, data: null, message, ...(Object.hasOwn(request, 'echo') ? { echo: request.echo } : {}) });
      if (peer.active >= 8) { send(socket, fail(1503, '并发动作过多')); return; }
      if (!ready()) { send(socket, fail(1502, 'QQ 尚未就绪')); return; }
      peer.active++;
      try { send(socket, await dispatch(request)); }
      catch { send(socket, fail(1500, '动作执行异常')); }
      finally { peer.active--; }
    });
    announce(socket, peer);
    report();
  }
  function announce(socket, peer) {
    if (ready() && peer.role !== 'api' && !peer.announced) {
      send(socket, meta({ meta_event_type: 'lifecycle', sub_type: 'connect' })); peer.announced = true;
    }
  }
  function connect(item) {
    if (closed || !ready() || item.socket || item.timer) return;
    item.state = 'connecting'; report();
    const socket = new WebSocket(item.url, { headers: { 'X-Self-ID': String(state.self_id), 'X-Client-Role': 'Universal',
      ...(item.token ? { Authorization: 'Bearer ' + item.token } : {}) }, maxPayload, handshakeTimeout: 10000, followRedirects: false });
    item.socket = socket;
    socket.on('error', () => {});
    socket.once('open', () => { item.state = 'connected'; attach(socket, 'universal', true); });
    socket.once('close', () => {
      item.socket = null;
      if (closed || !ready()) { item.state = 'waiting'; report(); return; }
      item.state = 'reconnecting'; report();
      item.timer = setTimeout(() => { item.timer = null; connect(item); }, 3000);
    });
  }
  if (config.ws.enabled) {
    server = createServer((req, res) => { res.writeHead(426); res.end('OneBot v11: WebSocket required'); });
    server.headersTimeout = 10000;
    server.requestTimeout = 30000;
    wss = new WebSocketServer({ noServer: true, maxPayload, perMessageDeflate: false });
    server.on('upgrade', (request, socket, head) => {
      socket.on('error', () => {});
      if (!request.url || !request.url.startsWith('/') || request.url.startsWith('//')) { socket.destroy(); return; }
      let url; try { url = new URL(request.url, 'http://127.0.0.1'); } catch { socket.destroy(); return; }
      const remote = request.socket.remoteAddress || 'unknown';
      const now = Date.now();
      const record = authFailures.get(remote);
      if (record && record.resetAt > now && record.count >= 20) {
        socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return;
      }
      const token = extractToken(request, url);
      const supplied = Buffer.from(token), expected = Buffer.from(config.accessToken);
      let code = 0;
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        code = 401;
        const entry = record && record.resetAt > now ? record : { count: 0, resetAt: now + 60000 };
        entry.count++;
        if (authFailures.size >= 1000) authFailures.delete(authFailures.keys().next().value);
        authFailures.set(remote, entry);
      } else {
        authFailures.delete(remote);
      }
      const path = url.pathname.replace(/\/$/, '') || '/';
      if (!['/', '/api', '/event'].includes(path)) code = code || 404;
      if (closed || wss.clients.size >= 32) code = code || 503;
      if (code) { socket.end(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); return; }
      wss.handleUpgrade(request, socket, head, ws => attach(ws, path === '/api' ? 'api' : path === '/event' ? 'event' : 'universal'));
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.ws.port, config.ws.host, resolve); });
    address = `ws://${config.ws.host === '0.0.0.0' ? '127.0.0.1' : config.ws.host}:${server.address().port}`;
  }
  const heartbeat = setInterval(() => {
    for (const [socket, peer] of peers) {
      if (!peer.alive) { socket.terminate(); continue; }
      peer.alive = false; socket.ping();
      if (Number(state.self_id) > 0 && peer.role !== 'api') send(socket, meta({ meta_event_type: 'heartbeat', interval: 15000, status: { online: ready(), good: ready() } }));
    }
  }, 15000);
  heartbeat.unref();
  report();
  return {
    setStatus(next) {
      const previous = state;
      state = { ...next };
      for (const [socket, peer] of peers) {
        if (previous.self_id && String(previous.self_id) !== String(state.self_id)) { socket.terminate(); continue; }
        announce(socket, peer);
      }
      for (const item of reverse) {
        if (!ready() || (previous.self_id && String(previous.self_id) !== String(state.self_id))) {
          clearTimeout(item.timer); item.timer = null; item.state = 'waiting'; item.socket?.terminate();
        } else connect(item);
      }
      report();
    },
    broadcast(event) { for (const [socket, peer] of peers) if (peer.role !== 'api') send(socket, event); },
    async close() {
      closed = true; clearInterval(heartbeat);
      for (const item of reverse) { clearTimeout(item.timer); item.socket?.terminate(); }
      for (const socket of peers.keys()) socket.terminate();
      if (wss) await new Promise(resolve => wss.close(resolve));
      if (server) { const stopped = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await stopped; }
    },
  };
}
