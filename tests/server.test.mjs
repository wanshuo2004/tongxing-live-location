import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../server.js';

let app;
let base;

before(async () => {
  app = createApp();
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const { port } = app.server.address();
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await app.close();
});

async function json(path, options = {}) {
  const response = await fetch(base + path, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { response, data };
}

function createSSEClient(path) {
  const controller = new AbortController();
  const events = [];
  let notify = null;
  let closed = false;

  const ready = (async () => {
    const response = await fetch(base + path, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
    read(response.body.getReader());
    return response;
  })();

  async function read(reader) {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index = buffer.indexOf('\n\n');
        while (index !== -1) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const event = parseEvent(block);
          if (event) {
            events.push(event);
            notify?.();
          }
          index = buffer.indexOf('\n\n');
        }
      }
    } catch (error) {
      if (error.name !== 'AbortError') throw error;
    } finally {
      closed = true;
      notify?.();
    }
  }

  function waitFor(predicate, timeout = 3000, label = 'event') {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const check = () => {
        const found = events.find(predicate);
        if (found) {
          cleanup();
          resolve(found);
          return;
        }
        if (closed) {
          cleanup();
          reject(new Error(`stream closed before ${label}`));
          return;
        }
        if (Date.now() - started > timeout) {
          cleanup();
          reject(new Error(`timed out waiting for ${label}`));
        }
      };
      const timer = setInterval(check, 20);
      const cleanup = () => {
        clearInterval(timer);
        notify = null;
      };
      notify = check;
      check();
    });
  }

  return { ready, waitFor, close: () => controller.abort() };
}

function parseEvent(block) {
  let event = 'message';
  const data = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return null;
  return { event, data: JSON.parse(data.join('\n')) };
}

async function createRoom(name = '小满') {
  const { response, data } = await json('/api/rooms', {
    method: 'POST',
    body: { name },
  });
  assert.equal(response.status, 201);
  assert.match(data.room.code, /^[A-Z0-9]{8}$/);
  assert.equal(data.room.members.length, 1);
  assert.equal(data.room.members[0].name, name);
  assert.ok(data.token);
  return data;
}

test('serves the PWA shell with security headers', async () => {
  const response = await fetch(base + '/');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/html/);
  assert.match(response.headers.get('content-security-policy') || '', /default-src 'self'/);
  assert.match(response.headers.get('permissions-policy') || '', /geolocation=\(self\)/);
  const html = await response.text();
  assert.match(html, /同行/);
  assert.match(html, /manifest\.webmanifest/);

  const manifest = await fetch(base + '/manifest.webmanifest');
  assert.equal(manifest.status, 200);
  assert.match(manifest.headers.get('content-type') || '', /application\/manifest\+json/);

  const missing = await fetch(base + '/nope.html');
  assert.equal(missing.status, 404);
});

test('rejects path traversal and oversized bodies', async () => {
  const traversal = await fetch(base + '/..%2f..%2fserver.js');
  assert.ok([403, 404].includes(traversal.status));

  const huge = await fetch(base + '/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'x'.repeat(20_000) }),
  });
  assert.equal(huge.status, 413);
});

test('creates a two-person room and blocks a third person', async () => {
  const creator = await createRoom();
  const code = creator.room.code;

  const partner = await json(`/api/rooms/${code}/join`, {
    method: 'POST',
    body: { name: '阿远' },
  });
  assert.equal(partner.response.status, 200);
  assert.equal(partner.data.room.members.length, 2);
  assert.notEqual(partner.data.memberId, creator.memberId);

  const third = await json(`/api/rooms/${code}/join`, {
    method: 'POST',
    body: { name: '第三人' },
  });
  assert.equal(third.response.status, 409);
  assert.equal(third.data.error, 'ROOM_FULL');

  const rejoin = await json(`/api/rooms/${code}/join`, {
    method: 'POST',
    body: {
      name: '小满',
      memberId: creator.memberId,
      token: creator.token,
    },
  });
  assert.equal(rejoin.response.status, 200);
  assert.equal(rejoin.data.memberId, creator.memberId);

  const wrongToken = await json(`/api/rooms/${code}/join`, {
    method: 'POST',
    body: { name: '小满', memberId: creator.memberId, token: 'wrong-token' },
  });
  assert.equal(wrongToken.response.status, 401);
});

test('streams room snapshots and locations over SSE', async () => {
  const creator = await createRoom('小满');
  const code = creator.room.code;
  const client = createSSEClient(
    `/api/rooms/${code}/events?memberId=${encodeURIComponent(creator.memberId)}&token=${encodeURIComponent(creator.token)}`,
  );

  try {
    await client.ready;
    const initial = await client.waitFor((event) => event.event === 'room', 3000, 'initial snapshot');
    assert.equal(initial.data.members.length, 1);

    const partner = await json(`/api/rooms/${code}/join`, {
      method: 'POST',
      body: { name: '阿远' },
    });
    assert.equal(partner.response.status, 200);

    const joined = await client.waitFor(
      (event) => event.event === 'room' && event.data.members.length === 2,
      3000,
      'partner joined',
    );
    assert.equal(joined.data.members.find((member) => member.id === partner.data.memberId).name, '阿远');

    const locationResponse = await json(`/api/rooms/${code}/location`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${partner.data.token}` },
      body: { lat: 31.2304, lng: 121.4737, accuracy: 8, heading: 90, speed: 1.2 },
    });
    assert.equal(locationResponse.response.status, 200);

    const located = await client.waitFor(
      (event) =>
        event.event === 'room' &&
        event.data.members.some(
          (member) =>
            member.id === partner.data.memberId &&
            member.location &&
            Math.abs(member.location.lat - 31.2304) < 0.00001,
        ),
      3000,
      'location update',
    );
    const partnerView = located.data.members.find((member) => member.id === partner.data.memberId);
    assert.equal(partnerView.location.accuracy, 8);
    assert.equal(partnerView.sharing, true);

    const state = await json(`/api/rooms/${code}/state`, {
      headers: { Authorization: `Bearer ${partner.data.token}` },
    });
    assert.equal(state.response.status, 200);
    assert.equal(state.data.room.code, code);
    assert.equal(state.data.room.members.length, 2);

    const stateUnauthorized = await json(`/api/rooms/${code}/state`);
    assert.equal(stateUnauthorized.response.status, 401);

    const pause = await json(`/api/rooms/${code}/sharing`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${partner.data.token}` },
      body: { sharing: false },
    });
    assert.equal(pause.response.status, 200);

    const paused = await client.waitFor(
      (event) =>
        event.event === 'room' &&
        event.data.members.some(
          (member) => member.id === partner.data.memberId && member.sharing === false && !member.location,
        ),
      3000,
      'paused snapshot',
    );
    assert.ok(paused);

    const blocked = await json(`/api/rooms/${code}/location`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${partner.data.token}` },
      body: { lat: 31.2, lng: 121.4 },
    });
    assert.equal(blocked.response.status, 409);
    assert.equal(blocked.data.error, 'SHARING_PAUSED');
  } finally {
    client.close();
  }
});

test('removes a member on leave and invalidates their token', async () => {
  const creator = await createRoom('小满');
  const code = creator.room.code;
  const partner = await json(`/api/rooms/${code}/join`, {
    method: 'POST',
    body: { name: '阿远' },
  });

  const leave = await fetch(`${base}/api/rooms/${code}/leave`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${partner.data.token}` },
  });
  assert.equal(leave.status, 204);

  const reuse = await json(`/api/rooms/${code}/location`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${partner.data.token}` },
    body: { lat: 31.2, lng: 121.4 },
  });
  assert.equal(reuse.response.status, 401);

  const room = app.rooms.get(code);
  assert.equal(room.members.size, 1);
});

test('validates coordinates and JSON', async () => {
  const creator = await createRoom();
  const code = creator.room.code;

  const invalid = await json(`/api/rooms/${code}/location`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${creator.token}` },
    body: { lat: 999, lng: 121 },
  });
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.data.error, 'INVALID_COORDINATES');

  const malformed = await fetch(`${base}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not-json',
  });
  assert.equal(malformed.status, 400);
});

test('health endpoint reports room count', async () => {
  await createRoom();
  const response = await fetch(base + '/healthz');
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.ok, true);
  assert.ok(data.rooms >= 1);
});
