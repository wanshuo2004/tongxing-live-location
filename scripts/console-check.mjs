/** 收集页面控制台错误：node scripts/console-check.mjs [url] */
const CDP = process.env.CDP || 'http://127.0.0.1:9222';
const url = process.argv[2] || process.env.APP_URL || 'http://127.0.0.1:8787/';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const target = await (await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' })).json();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

let id = 1;
const pending = new Map();
const logs = [];

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const entry = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
    return;
  }
  if (message.method === 'Log.entryAdded') logs.push(message.params.entry);
  if (message.method === 'Runtime.exceptionThrown') {
    logs.push({
      level: 'error',
      text: message.params.exceptionDetails?.exception?.description || 'runtime exception',
    });
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
await send('Log.enable');
await send('Page.navigate', { url });
await sleep(3000);

const severe = logs.filter((entry) => entry.level === 'error');
console.log('errors:', JSON.stringify(severe, null, 2));
console.log('warnings:', logs.filter((entry) => entry.level === 'warning').length);
socket.close();
process.exit(0);
