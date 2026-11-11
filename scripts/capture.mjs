/**
 * 使用本机 Edge 的 CDP 端口截取真实视口截图。
 * 先启动：
 *   msedge --headless=new --remote-debugging-port=9222 ...
 * 再运行：
 *   node scripts/capture.mjs <url> <out.png> [width] [height] [mobile]
 */

import { writeFile } from 'node:fs/promises';

const port = process.env.CDP_PORT || 9222;
const url = process.argv[2] || 'http://127.0.0.1:8787/';
const output = process.argv[3] || 'shots/capture.png';
const width = Number(process.argv[4] || 390);
const height = Number(process.argv[5] || 844);
const mobile = process.argv[6] !== 'desktop';
const waitMs = Number(process.env.SHOT_WAIT || 2200);

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retry(fn, attempts = 40, delay = 250) {
  let lastError;
  for (let index = 0; index < attempts; index += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await sleep(delay);
    }
  }
  throw lastError;
}

async function createTarget() {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
    method: 'PUT',
  });
  if (!response.ok) throw new Error(`create target failed: ${response.status}`);
  return response.json();
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const pending = new Map();
    const waiters = new Map();
    let nextId = 1;

    socket.addEventListener('open', () => {
      resolve({
        send(method, params = {}) {
          return new Promise((resolveSend, rejectSend) => {
            const id = nextId++;
            pending.set(id, { resolve: resolveSend, reject: rejectSend });
            socket.send(JSON.stringify({ id, method, params }));
          });
        },
        once(method) {
          return new Promise((resolveEvent) => {
            waiters.set(method, resolveEvent);
          });
        },
        close() {
          socket.close();
        },
      });
    });

    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) entry.reject(new Error(message.error.message));
        else entry.resolve(message.result);
        return;
      }
      const waiter = waiters.get(message.method);
      if (waiter) {
        waiters.delete(message.method);
        waiter(message.params);
      }
    });

    socket.addEventListener('error', reject);
  });
}

async function main() {
  const target = await retry(createTarget);
  const client = await connect(target.webSocketDebuggerUrl);

  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 2,
    mobile,
    screenWidth: width,
    screenHeight: height,
  });
  await client.send('Emulation.setTouchEmulationEnabled', {
    enabled: mobile,
    maxTouchPoints: mobile ? 5 : 0,
  });
  if (mobile) {
    await client.send('Emulation.setUserAgentOverride', {
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      platform: 'iPhone',
    });
  }

  const loaded = client.once('Page.loadEventFired');
  await client.send('Page.navigate', { url });
  await loaded;
  await sleep(waitMs);

  const metrics = await client.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      innerWidth, innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      dpr: devicePixelRatio,
      title: document.title,
      landingHidden: document.getElementById('landing')?.hidden,
      roomHidden: document.getElementById('room')?.hidden,
      error: document.getElementById('landingError')?.textContent || '',
      bodyClass: document.body.className,
    })`,
    returnByValue: true,
  });
  console.log(metrics.result.value);

  const shot = await client.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  await writeFile(output, Buffer.from(shot.data, 'base64'));
  console.log('saved', output, width, height);
  client.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
