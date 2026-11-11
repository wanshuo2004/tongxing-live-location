/**
 * 同行 · 双人实时定位
 * 零依赖 Node.js 服务端：静态站点 + 房间 API + SSE 实时推送。
 *
 * 设计原则：
 * - 只做“两人房间”，配对码即入场凭证。
 * - 位置仅在内存中转发，不写数据库、不写日志，房间闲置 2 小时后自动消失。
 * - 无第三方运行时依赖，复制到任何支持 Node 18+ 的地方即可运行。
 */

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const PUBLIC_DIR = resolve(fileURLToPath(new URL('./public', import.meta.url)));
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const ROOM_CAPACITY = 2;
const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
const REQUEST_LIMIT_BYTES = 16 * 1024;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://*.is.autonavi.com https://*.amap.com https://tile.openstreetmap.org https://*.tile.openstreetmap.org",
    "connect-src 'self' https://*.is.autonavi.com https://*.amap.com https://tile.openstreetmap.org https://*.tile.openstreetmap.org",
    "font-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'Permissions-Policy': 'geolocation=(self), camera=(), microphone=(), payment=()',
  'Referrer-Policy': 'same-origin',
  'Strict-Transport-Security': 'max-age=31536000',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function fail(status, code, message) {
  throw new HttpError(status, code, message);
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store, max-age=0',
    ...extraHeaders,
  });
  res.end(body);
}

function sendEmpty(res, status = 204) {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Cache-Control': 'no-store, max-age=0',
  });
  res.end();
}

async function readJson(req) {
  const contentType = String(req.headers['content-type'] || '');
  if (contentType && !contentType.toLowerCase().includes('application/json')) {
    fail(415, 'UNSUPPORTED_MEDIA_TYPE', '请求需要 application/json');
  }

  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > REQUEST_LIMIT_BYTES) {
      fail(413, 'BODY_TOO_LARGE', '请求内容过大');
    }
    chunks.push(chunk);
  }

  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      fail(400, 'INVALID_BODY', '请求格式不正确');
    }
    return parsed;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    fail(400, 'INVALID_JSON', '请求格式不正确');
  }
}

function cleanName(value) {
  if (typeof value !== 'string') return '我';
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(cleaned).slice(0, 16).join('') || '我';
}

function normalizeCode(value) {
  if (typeof value !== 'string') return '';
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/[01IO]/g, '')
    .slice(0, 8);
}

function makeCode() {
  const bytes = randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i += 1) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return code;
}

function makeToken() {
  return randomBytes(24).toString('base64url');
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function authToken(req) {
  const header = String(req.headers.authorization || '');
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1] : '';
}

function publicRoom(room) {
  return {
    code: room.code,
    capacity: ROOM_CAPACITY,
    createdAt: room.createdAt,
    serverTime: Date.now(),
    members: [...room.members.values()].map((member) => ({
      id: member.id,
      name: member.name,
      // SSE 在线，或最近 15 秒内通过轮询报过平安。
      online: member.online || Date.now() - member.lastSeen < 15_000,
      sharing: member.sharing,
      joinedAt: member.joinedAt,
      lastSeen: member.lastSeen,
      location: member.location
        ? {
            lat: member.location.lat,
            lng: member.location.lng,
            accuracy: member.location.accuracy,
            heading: member.location.heading,
            speed: member.location.speed,
            at: member.location.at,
          }
        : null,
    })),
  };
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) {
    return forwarded.split(',')[0].trim().slice(0, 80);
  }
  return String(req.socket.remoteAddress || 'unknown');
}

function parseLatLng(body) {
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    fail(400, 'INVALID_COORDINATES', '经纬度不合法');
  }
  return { lat, lng };
}

function optionalNumber(value, min, max) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) return null;
  return number;
}

function round(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function createApp(options = {}) {
  const rooms = new Map();
  const rateBuckets = new Map();
  const roomTtlMs = options.roomTtlMs ?? ROOM_TTL_MS;
  const now = () => Date.now();

  const server = createServer(async (req, res) => {
    try {
      await handleRequest(req, res);
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.code, message: error.message });
        return;
      }
      console.error('[server] unexpected error:', error);
      sendJson(res, 500, { error: 'INTERNAL', message: '服务暂时不可用' });
    }
  });

  function allow(ip, bucket, limit, windowMs) {
    const key = `${bucket}:${ip}`;
    const timestamp = now();
    let entry = rateBuckets.get(key);
    if (!entry || timestamp > entry.resetAt) {
      entry = { count: 0, resetAt: timestamp + windowMs };
      rateBuckets.set(key, entry);
    }
    entry.count += 1;
    return entry.count <= limit;
  }

  function getRoom(code) {
    const room = rooms.get(code);
    if (!room) fail(404, 'ROOM_NOT_FOUND', '房间不存在或已经过期');
    return room;
  }

  function getMember(room, memberId) {
    const member = room.members.get(memberId);
    if (!member) fail(401, 'SESSION_EXPIRED', '登录状态已失效，请重新加入');
    return member;
  }

  function requireMember(req, room) {
    const token = authToken(req);
    if (!token) fail(401, 'UNAUTHORIZED', '缺少房间凭证');
    for (const member of room.members.values()) {
      if (safeEqual(member.token, token)) return member;
    }
    fail(401, 'UNAUTHORIZED', '房间凭证无效');
  }

  function scheduleBroadcast(room, delay = 60) {
    if (room.broadcastTimer) return;
    room.broadcastTimer = setTimeout(() => {
      room.broadcastTimer = null;
      broadcast(room);
    }, delay);
    room.broadcastTimer.unref?.();
  }

  function broadcast(room) {
    if (!room.members.size) return;
    const payload = JSON.stringify(publicRoom(room));
    for (const member of room.members.values()) {
      for (const connection of member.connections) {
        try {
          connection.write(`event: room\ndata: ${payload}\n\n`);
        } catch {
          connection.destroy();
        }
      }
    }
  }

  function touch(room) {
    room.lastActivity = now();
  }

  function removeMember(room, member) {
    for (const connection of member.connections) {
      try {
        connection.end();
      } catch {
        /* ignore */
      }
    }
    member.connections.clear();
    if (member.offlineTimer) clearTimeout(member.offlineTimer);
    room.members.delete(member.id);
    room.lastActivity = now();
    if (room.members.size === 0) {
      if (room.broadcastTimer) clearTimeout(room.broadcastTimer);
      rooms.delete(room.code);
      return;
    }
    scheduleBroadcast(room);
  }

  function markOfflineSoon(room, member) {
    if (member.offlineTimer) clearTimeout(member.offlineTimer);
    if (member.connections.size > 0) return;
    member.offlineTimer = setTimeout(() => {
      member.offlineTimer = null;
      if (member.connections.size === 0 && room.members.has(member.id)) {
        member.online = false;
        scheduleBroadcast(room);
      }
    }, 4000);
    member.offlineTimer.unref?.();
  }

  async function handleRequest(req, res) {
    const method = req.method || 'GET';
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const pathname = requestUrl.pathname;

    if (pathname === '/healthz' && (method === 'GET' || method === 'HEAD')) {
      sendJson(res, 200, { ok: true, rooms: rooms.size, uptime: Math.round(process.uptime()) });
      return;
    }

    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, method, requestUrl);
      return;
    }

    if (method !== 'GET' && method !== 'HEAD') {
      fail(405, 'METHOD_NOT_ALLOWED', '不支持的请求方法');
    }
    await serveStatic(req, res, pathname, method === 'HEAD');
  }

  async function handleApi(req, res, method, requestUrl) {
    const ip = getClientIp(req);
    const pathname = requestUrl.pathname;

    if (pathname === '/api/rooms' && method === 'POST') {
      if (!allow(ip, 'create', 30, 60_000)) fail(429, 'RATE_LIMITED', '操作太频繁，请稍后再试');
      if (rooms.size >= 5000) fail(503, 'ROOM_LIMIT', '服务繁忙，请稍后再试');

      const body = await readJson(req);
      const name = cleanName(body.name);
      let code = makeCode();
      while (rooms.has(code)) code = makeCode();

      const creator = {
        id: randomUUID(),
        token: makeToken(),
        name,
        joinedAt: now(),
        lastSeen: now(),
        online: false,
        sharing: true,
        location: null,
        connections: new Set(),
        offlineTimer: null,
      };

      const room = {
        code,
        createdAt: now(),
        lastActivity: now(),
        members: new Map([[creator.id, creator]]),
        broadcastTimer: null,
      };
      rooms.set(code, room);

      sendJson(res, 201, {
        room: publicRoom(room),
        memberId: creator.id,
        token: creator.token,
      });
      return;
    }

    const match = /^\/api\/rooms\/([A-Z0-9]{8})(?:\/([a-z]+))?$/.exec(pathname);
    if (!match) fail(404, 'NOT_FOUND', '接口不存在');
    const code = match[1];
    const action = match[2] || '';
    const room = getRoom(code);

    if (action === 'state' && method === 'GET') {
      const member = requireMember(req, room);
      member.lastSeen = now();
      touch(room);
      sendJson(res, 200, { room: publicRoom(room) });
      return;
    }

    if (action === 'join' && method === 'POST') {
      if (!allow(ip, 'join', 120, 60_000)) fail(429, 'RATE_LIMITED', '操作太频繁，请稍后再试');
      const body = await readJson(req);
      const name = cleanName(body.name);

      const hasCredentials = typeof body.memberId === 'string' && typeof body.token === 'string';
      if (hasCredentials) {
        const member = getMember(room, body.memberId);
        if (!safeEqual(member.token, body.token)) {
          fail(401, 'UNAUTHORIZED', '房间凭证无效');
        }
        member.name = name;
        member.lastSeen = now();
        room.lastActivity = now();
        scheduleBroadcast(room);
        sendJson(res, 200, {
          room: publicRoom(room),
          memberId: member.id,
          token: member.token,
        });
        return;
      }

      if (room.members.size >= ROOM_CAPACITY) {
        fail(409, 'ROOM_FULL', '这个房间已经有两个人了');
      }

      const member = {
        id: randomUUID(),
        token: makeToken(),
        name,
        joinedAt: now(),
        lastSeen: now(),
        online: false,
        sharing: true,
        location: null,
        connections: new Set(),
        offlineTimer: null,
      };
      room.members.set(member.id, member);
      room.lastActivity = now();
      scheduleBroadcast(room);

      sendJson(res, 200, {
        room: publicRoom(room),
        memberId: member.id,
        token: member.token,
      });
      return;
    }

    if (action === 'events' && method === 'GET') {
      const member = getMember(room, String(requestUrl.searchParams.get('memberId') || ''));
      const token = String(requestUrl.searchParams.get('token') || '');
      if (!safeEqual(member.token, token)) {
        fail(401, 'UNAUTHORIZED', '房间凭证无效');
      }

      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 2500\n\n');
      res.write(`event: room\ndata: ${JSON.stringify(publicRoom(room))}\n\n`);

      if (member.offlineTimer) {
        clearTimeout(member.offlineTimer);
        member.offlineTimer = null;
      }
      member.connections.add(res);
      member.online = true;
      member.lastSeen = now();
      room.lastActivity = now();
      scheduleBroadcast(room);

      const heartbeat = setInterval(() => {
        try {
          res.write(`: ping ${now()}\n\n`);
        } catch {
          /* closed */
        }
      }, 20_000);
      heartbeat.unref?.();

      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        clearInterval(heartbeat);
        member.connections.delete(res);
        if (member.connections.size === 0) {
          member.lastSeen = now();
          markOfflineSoon(room, member);
        }
      };
      res.on('close', cleanup);
      res.on('error', cleanup);
      req.on('error', cleanup);
      return;
    }

    if (action === 'location' && method === 'POST') {
      const member = requireMember(req, room);
      if (!member.sharing) fail(409, 'SHARING_PAUSED', '你已暂停共享位置');
      const body = await readJson(req);
      const { lat, lng } = parseLatLng(body);

      member.location = {
        lat: round(lat),
        lng: round(lng),
        accuracy: optionalNumber(body.accuracy, 0, 100_000),
        heading: optionalNumber(body.heading, 0, 360),
        speed: optionalNumber(body.speed, 0, 1000),
        at: now(),
      };
      member.lastSeen = now();
      touch(room);
      scheduleBroadcast(room);
      sendJson(res, 200, { ok: true, at: member.location.at });
      return;
    }

    if (action === 'sharing' && method === 'POST') {
      const member = requireMember(req, room);
      const body = await readJson(req);
      if (typeof body.sharing !== 'boolean') fail(400, 'INVALID_BODY', 'sharing 必须是布尔值');
      member.sharing = body.sharing;
      member.lastSeen = now();
      if (!member.sharing) member.location = null;
      touch(room);
      scheduleBroadcast(room);
      sendJson(res, 200, { ok: true, sharing: member.sharing });
      return;
    }

    if (action === 'leave' && method === 'POST') {
      const member = requireMember(req, room);
      removeMember(room, member);
      sendEmpty(res);
      return;
    }

    fail(405, 'METHOD_NOT_ALLOWED', '不支持的请求方法');
  }

  async function serveStatic(req, res, rawPathname, headOnly) {
    let pathname;
    try {
      pathname = decodeURIComponent(rawPathname);
    } catch {
      fail(400, 'BAD_PATH', '路径不合法');
    }
    if (pathname.includes('\0')) fail(400, 'BAD_PATH', '路径不合法');
    if (pathname === '/') pathname = '/index.html';

    const filePath = resolve(join(PUBLIC_DIR, pathname));
    if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + sep)) {
      fail(403, 'FORBIDDEN', '禁止访问');
    }

    const base = filePath.split(sep).pop() || '';
    if (base.startsWith('.')) fail(404, 'NOT_FOUND', '文件不存在');

    let info;
    try {
      info = await stat(filePath);
    } catch {
      fail(404, 'NOT_FOUND', '页面不存在');
    }
    if (!info.isFile()) fail(404, 'NOT_FOUND', '文件不存在');

    const extension = extname(filePath).toLowerCase();
    const isServiceWorker = base === 'sw.js';
    const isHtml = extension === '.html';
    const immutable = pathname.startsWith('/vendor/') || pathname.startsWith('/icons/');
    const cacheControl = isServiceWorker || isHtml
      ? 'no-cache, max-age=0, must-revalidate'
      : immutable
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=3600';

    const headers = {
      ...SECURITY_HEADERS,
      'Content-Type': MIME_TYPES[extension] || 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': cacheControl,
      'Last-Modified': info.mtime.toUTCString(),
      'Accept-Ranges': 'bytes',
    };
    if (isServiceWorker) headers['Service-Worker-Allowed'] = '/';

    if (headOnly) {
      res.writeHead(200, headers);
      res.end();
      return;
    }

    res.writeHead(200, headers);
    createReadStream(filePath)
      .on('error', () => res.destroy())
      .pipe(res);
  }

  function cleanupRooms() {
    const timestamp = now();
    for (const [code, room] of rooms) {
      const activeConnections = [...room.members.values()].reduce(
        (total, member) => total + member.connections.size,
        0,
      );
      if (activeConnections > 0) continue;
      if (timestamp - room.lastActivity > roomTtlMs) {
        for (const member of room.members.values()) {
          if (member.offlineTimer) clearTimeout(member.offlineTimer);
        }
        if (room.broadcastTimer) clearTimeout(room.broadcastTimer);
        rooms.delete(code);
      }
    }
    for (const [key, bucket] of rateBuckets) {
      if (timestamp > bucket.resetAt + 60_000) rateBuckets.delete(key);
    }
  }

  const cleanupTimer = setInterval(cleanupRooms, 10 * 60 * 1000);
  cleanupTimer.unref?.();

  function close() {
    clearInterval(cleanupTimer);
    for (const room of rooms.values()) {
      if (room.broadcastTimer) clearTimeout(room.broadcastTimer);
      for (const member of room.members.values()) {
        if (member.offlineTimer) clearTimeout(member.offlineTimer);
        for (const connection of member.connections) {
          try {
            connection.end();
          } catch {
            /* ignore */
          }
        }
      }
    }
    rooms.clear();
    return new Promise((resolveClose) => server.close(resolveClose));
  }

  return { server, rooms, close, cleanupRooms };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const app = createApp();
  app.server.listen(PORT, HOST, () => {
    const shownHost = HOST === '0.0.0.0' ? 'localhost' : HOST;
    console.log(`\n  同行 · 双人实时定位\n  http://${shownHost}:${PORT}\n`);
    console.log('  提示：手机定位需要 HTTPS（localhost 除外）。');
    console.log('  部署方式见 README.md。\n');
  });

  const shutdown = () => {
    app.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
