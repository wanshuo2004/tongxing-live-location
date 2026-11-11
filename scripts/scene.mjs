/**
 * 截取真实的房间界面：模拟定位、创建房间、让第二位成员加入。
 * 需要先启动带 CDP 端口的 Edge，并运行 server.js。
 */

import { writeFile } from 'node:fs/promises';

const CDP = 'http://127.0.0.1:9222';
const APP = process.env.APP_URL || 'http://127.0.0.1:8787';
const mobile = process.env.SHOT_MOBILE !== '0';
const width = Number(process.env.SHOT_WIDTH || (mobile ? 390 : 1440));
const height = Number(process.env.SHOT_HEIGHT || (mobile ? 844 : 1000));
const out = process.argv[2] || 'shots/room-mobile.png';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function retry(fn, attempts = 40, delay = 250) {
  let error;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (caught) {
      error = caught;
      await sleep(delay);
    }
  }
  throw error;
}

async function newTarget() {
  const response = await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' });
  return response.json();
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const pending = new Map();
    const waiters = new Map();
    let id = 1;

    socket.addEventListener('open', () => {
      resolve({
        send(method, params = {}) {
          return new Promise((ok, fail) => {
            const requestId = id++;
            pending.set(requestId, { ok, fail });
            socket.send(JSON.stringify({ id: requestId, method, params }));
          });
        },
        once(method) {
          return new Promise((ok) => waiters.set(method, ok));
        },
        close: () => socket.close(),
      });
    });

    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) entry.fail(new Error(`${message.error.message} (${message.error.code})`));
        else entry.ok(message.result);
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
  const target = await retry(newTarget);
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
  await client.send('Emulation.setTouchEmulationEnabled', mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
  if (mobile) {
    await client.send('Emulation.setUserAgentOverride', {
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      platform: 'iPhone',
    });
  }

  try {
    await client.send('Browser.grantPermissions', {
      origin: APP,
      permissions: ['geolocation'],
    });
  } catch (error) {
    console.log('grantPermissions skipped:', error.message);
  }

  await client.send('Emulation.setGeolocationOverride', {
    latitude: 31.2304,
    longitude: 121.4737,
    accuracy: 9,
  });

  const loaded = client.once('Page.loadEventFired');
  await client.send('Page.navigate', { url: APP + '/' });
  await loaded;
  await sleep(900);

  await client.send('Runtime.evaluate', {
    expression: `
      document.getElementById('nameInput').value = '小满';
      document.getElementById('createBtn').click();
    `,
  });

  await sleep(1800);

  const state = await client.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      roomHidden: document.getElementById('room').hidden,
      landingHidden: document.getElementById('landing').hidden,
      title: document.title,
      error: document.getElementById('landingError')?.textContent || '',
      code: document.getElementById('roomCodeLabel')?.textContent || '',
      session: localStorage.getItem('tongxing.session.v1'),
      conn: document.getElementById('connText')?.textContent || '',
      waiting: !document.getElementById('waitingPanel')?.hidden,
    })`,
    returnByValue: true,
  });
  console.log('room:', state.result.value);
  const parsed = JSON.parse(state.result.value);
  if (!parsed.session) throw new Error('room was not created');

  await sleep(500);
  const waitingShot = await client.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  await writeFile(out.replace('.png', '-waiting.png'), Buffer.from(waitingShot.data, 'base64'));

  const session = JSON.parse(parsed.session);
  const joinResponse = await fetch(`${APP}/api/rooms/${session.code}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '阿远' }),
  });
  if (!joinResponse.ok) throw new Error(`join failed: ${joinResponse.status}`);
  const partner = await joinResponse.json();

  // 让第二位成员真正建立 SSE 连接，界面显示“在线”。
  const partnerAbort = new AbortController();
  const partnerStream = await fetch(
    `${APP}/api/rooms/${session.code}/events?memberId=${encodeURIComponent(partner.memberId)}&token=${encodeURIComponent(partner.token)}`,
    { signal: partnerAbort.signal },
  );
  const partnerReader = partnerStream.body.getReader();
  (async () => {
    try {
      while (true) {
        const { done } = await partnerReader.read();
        if (done) break;
      }
    } catch {
      /* ignore */
    }
  })();
  await sleep(350);

  await fetch(`${APP}/api/rooms/${session.code}/location`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${partner.token}`,
    },
    body: JSON.stringify({
      lat: 31.2243,
      lng: 121.4768,
      accuracy: 12,
      heading: 120,
      speed: 2.4,
    }),
  });

  await sleep(3800);

  const roomState = await client.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      distance: document.getElementById('distanceValue')?.textContent,
      unit: document.getElementById('distanceUnit')?.textContent,
      partner: document.getElementById('partnerName')?.textContent,
      partnerMeta: document.getElementById('partnerMeta')?.textContent,
      selfMeta: document.getElementById('selfMeta')?.textContent,
      waiting: !document.getElementById('waitingPanel')?.hidden,
      tracking: !document.getElementById('trackingPanel')?.hidden,
      conn: document.getElementById('connText')?.textContent,
      dockHeight: document.getElementById('dock')?.offsetHeight,
      mapTiles: document.querySelectorAll('.leaflet-tile-loaded').length,
    })`,
    returnByValue: true,
  });
  console.log('tracking:', roomState.result.value);

  const shot = await client.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  await writeFile(out, Buffer.from(shot.data, 'base64'));
  console.log('saved', out, 'waiting screenshot:', out.replace('.png', '-waiting.png'));

  if (process.env.SHOT_PAUSE === '1') {
    await client.send('Runtime.evaluate', {
      expression: `document.getElementById('pauseBtn').click()`,
    });
    await sleep(1400);
    const paused = await client.send('Runtime.evaluate', {
      expression: `JSON.stringify({
        label: document.querySelector('#pauseBtn span:last-child')?.textContent,
        tag: document.getElementById('shareStateTag')?.textContent,
        selfMeta: document.getElementById('selfMeta')?.textContent,
        selfMarkers: document.querySelectorAll('.pin-me').length,
        partnerMarkers: document.querySelectorAll('.pin-partner').length,
      })`,
      returnByValue: true,
    });
    console.log('paused:', paused.result.value);
    const pausedShot = await client.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    });
    await writeFile(out.replace('.png', '-paused.png'), Buffer.from(pausedShot.data, 'base64'));
  }

  if (process.env.SHOT_RELOAD === '1') {
    await client.send('Page.reload');
    await sleep(3000);
    const reloaded = await client.send('Runtime.evaluate', {
      expression: `JSON.stringify({
        roomHidden: document.getElementById('room').hidden,
        landingHidden: document.getElementById('landing').hidden,
        title: document.title,
        conn: document.getElementById('connText')?.textContent,
        partner: document.getElementById('partnerName')?.textContent,
        error: document.getElementById('landingError')?.textContent || '',
      })`,
      returnByValue: true,
    });
    console.log('reloaded:', reloaded.result.value);
  }

  if (process.env.SHOT_SETTINGS === '1') {
    await client.send('Runtime.evaluate', {
      expression: `document.getElementById('settingsBtn').click()`,
    });
    await sleep(700);
    const dialogShot = await client.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    });
    await writeFile(out.replace('.png', '-settings.png'), Buffer.from(dialogShot.data, 'base64'));
    console.log('settings screenshot saved');

    if (process.env.SHOT_INSTALL === '1') {
      await client.send('Runtime.evaluate', {
        expression: `document.getElementById('settingsInstall').click()`,
      });
      await sleep(650);
      const installShot = await client.send('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: false,
      });
      await writeFile(out.replace('.png', '-install.png'), Buffer.from(installShot.data, 'base64'));
      console.log('install screenshot saved');
    }
  }

  partnerAbort.abort();
  client.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
