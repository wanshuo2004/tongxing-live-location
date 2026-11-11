/** 在已打开的 CDP 页面里执行一段表达式：node scripts/eval.mjs "expression" */
const CDP = process.env.CDP || 'http://127.0.0.1:9222';
const expression = process.argv.slice(2).join(' ') || 'location.href';

const list = await (await fetch(`${CDP}/json/list`)).json();
const page = list.find((item) => item.type === 'page');
if (!page) throw new Error('no page target');

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

let nextId = 1;
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
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

const result = await send('Runtime.evaluate', {
  expression,
  awaitPromise: true,
  returnByValue: true,
});
console.log(JSON.stringify(result.result.value ?? result.result.description, null, 2));
socket.close();
