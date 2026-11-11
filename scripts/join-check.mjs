/** 验证邀请链接加入流程：node scripts/join-check.mjs */
const CDP = 'http://127.0.0.1:9222';
const APP = process.env.APP_URL || 'http://127.0.0.1:8787';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const created = await (
  await fetch(`${APP}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '发起人' }),
  })
).json();
const code = created.room.code;

const target = await (await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' })).json();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

let id = 1;
const pending = new Map();
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const entry = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const requestId = id++;
    pending.set(requestId, { resolve, reject });
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: `${APP}/?room=${code}` });
await sleep(1200);

const before = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    code: document.getElementById('codeInput').value,
    landing: !document.getElementById('landing').hidden,
    error: document.getElementById('landingError').textContent,
  })`,
  returnByValue: true,
});
console.log('invite page:', before.result.value);

await send('Runtime.evaluate', {
  expression: `
    document.getElementById('nameInput').value = '受邀人';
    document.getElementById('joinBtn').click();
  `,
});
await sleep(2600);

const after = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    room: !document.getElementById('room').hidden,
    code: document.getElementById('roomCodeLabel').textContent,
    partner: document.getElementById('partnerName').textContent,
    waiting: !document.getElementById('waitingPanel').hidden,
    tracking: !document.getElementById('trackingPanel').hidden,
    conn: document.getElementById('connText').textContent,
    error: document.getElementById('landingError').textContent,
  })`,
  returnByValue: true,
});
console.log('joined:', after.result.value);

socket.close();
process.exit(0);
