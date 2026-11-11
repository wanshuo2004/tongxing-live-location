/** 验证 Service Worker 离线应用外壳：node scripts/offline-check.mjs */
const CDP = process.env.CDP || 'http://127.0.0.1:9222';
const APP = process.env.APP_URL || 'http://127.0.0.1:8787';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const requestId = id++;
    pending.set(requestId, { resolve, reject });
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
}

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Page.navigate', { url: `${APP}/` });
await sleep(3500);

const ready = await send('Runtime.evaluate', {
  expression: `navigator.serviceWorker.ready.then(r => ({scope:r.scope, controller: !!navigator.serviceWorker.controller}))`,
  awaitPromise: true,
  returnByValue: true,
});
console.log('service worker ready:', JSON.stringify(ready.result.value));

await send('Network.emulateNetworkConditions', {
  offline: true,
  latency: 0,
  downloadThroughput: 0,
  uploadThroughput: 0,
});
await send('Page.reload', { ignoreCache: true });
await sleep(2000);

const offline = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    title: document.title,
    landing: !!document.getElementById('landing'),
    hasNameInput: !!document.getElementById('nameInput'),
    hasStyles: getComputedStyle(document.body).backgroundColor,
    online: navigator.onLine,
  })`,
  returnByValue: true,
});
console.log('offline page:', offline.result.value);

await send('Network.emulateNetworkConditions', {
  offline: false,
  latency: 0,
  downloadThroughput: -1,
  uploadThroughput: -1,
});
socket.close();
process.exit(0);
