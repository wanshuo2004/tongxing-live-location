/** 检查 PWA manifest 与可安装性：node scripts/pwa-check.mjs */
const CDP = process.env.CDP || 'http://127.0.0.1:9222';
const APP = process.env.APP_URL || 'http://127.0.0.1:8787';

const target = await (
  await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' })
).json();

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
await send('Page.navigate', { url: `${APP}/` });
await new Promise((resolve) => setTimeout(resolve, 2500));

const manifest = await send('Page.getAppManifest');
console.log('manifest url:', manifest.url);
console.log('manifest errors:', JSON.stringify(manifest.errors, null, 2));
console.log('manifest data:', manifest.data?.slice(0, 400));

const installability = await send('Page.getInstallabilityErrors');
console.log('installability errors:', JSON.stringify(installability.installabilityErrors, null, 2));

const serviceWorkers = await send('ServiceWorker.enable').catch((error) => ({ error: error.message }));
console.log('service worker domain:', JSON.stringify(serviceWorkers));

socket.close();
process.exit(0);
