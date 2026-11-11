/* =========================================================
   同行 · 双人实时定位
   前端状态机：房间 / SSE / 地理定位 / 地图
   ========================================================= */

'use strict';

const $ = (id) => document.getElementById(id);

const STORAGE = {
  session: 'tongxing.session.v1',
  name: 'tongxing.name.v1',
  wake: 'tongxing.wake.v1',
};

const LOCATION_INTERVAL_MIN = 3500;
const LOCATION_INTERVAL_MAX = 12000;
const LOCATION_HEARTBEAT = 15000;
const STALE_AFTER = 90000;

const state = {
  screen: 'landing',
  roomCode: null,
  memberId: null,
  token: null,
  snapshot: null,
  clockOffset: 0,
  lastSnapshotAt: 0,
  sessionLost: false,

  sse: null,
  sseState: 'idle',
  sseRetries: 0,
  validating: false,

  geo: {
    watchId: null,
    status: 'off',
    issue: null,
    lastFix: null,
    lastSentAt: 0,
    lastSentFix: null,
    sending: false,
    lastErrorAt: 0,
  },

  map: null,
  mapProvider: 'amap',
  tileLayer: null,
  line: null,
  markers: new Map(),
  initialViewDone: false,
  partnerViewDone: false,
  partnerSeen: false,
  noticeDismissed: false,

  paused: false,
  pauseBusy: false,
  wakeEnabled: false,
  wakeLock: null,
  installPrompt: null,
  toastTimer: null,
  tickTimer: null,
  locationTimer: null,
  pollTimer: null,
  polling: false,
  leaveTimer: null,
  dockObserver: null,
  compact: false,
};

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/* ---------------------------------------------------------
   Small utilities
   --------------------------------------------------------- */

function normalizeCode(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/[01IO]/g, '')
    .slice(0, 8);
}

function formatCode(value) {
  const code = normalizeCode(value);
  if (code.length <= 4) return code;
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function initialOf(name) {
  const chars = Array.from(String(name || 'TA').trim());
  return chars[0] ? chars[0].toUpperCase() : 'T';
}

function haversine(a, b) {
  if (!a || !b) return null;
  const toRad = (degree) => (degree * Math.PI) / 180;
  const earth = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * earth * Math.asin(Math.min(1, Math.sqrt(h)));
}

/* WGS-84 → GCJ-02：让 GPS 坐标正确贴合国内地图底图。 */
const GCJ_A = 6378245.0;
const GCJ_EE = 0.00669342162296594323;

function outOfChina(lat, lng) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x, y) {
  let result =
    -100 +
    2 * x +
    3 * y +
    0.2 * y * y +
    0.1 * x * y +
    0.2 * Math.sqrt(Math.abs(x));
  result += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  result += ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3;
  result +=
    ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) * 2) / 3;
  return result;
}

function transformLng(x, y) {
  let result =
    300 +
    x +
    2 * y +
    0.1 * x * x +
    0.1 * x * y +
    0.1 * Math.sqrt(Math.abs(x));
  result += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  result += ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3;
  result +=
    ((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x / 30) * Math.PI)) * 2) / 3;
  return result;
}

function wgs84ToGcj02(lat, lng) {
  if (outOfChina(lat, lng)) return [lat, lng];
  let dLat = transformLat(lng - 105, lat - 35);
  let dLng = transformLng(lng - 105, lat - 35);
  const radLat = (lat / 180) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - GCJ_EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180) / (((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic)) * Math.PI);
  dLng = (dLng * 180) / ((GCJ_A / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return [lat + dLat, lng + dLng];
}

function displayPoint(location) {
  if (!location) return null;
  if (state.mapProvider === 'amap') {
    const [lat, lng] = wgs84ToGcj02(location.lat, location.lng);
    return { lat, lng };
  }
  return { lat: location.lat, lng: location.lng };
}

function ageOf(serverTimestamp) {
  if (!serverTimestamp) return Infinity;
  return Math.max(0, Date.now() + state.clockOffset - serverTimestamp);
}

function relativeTime(timestamp, options = {}) {
  if (!timestamp) return '';
  const age = options.local
    ? Math.max(0, Date.now() - timestamp)
    : ageOf(timestamp);
  if (!Number.isFinite(age)) return '';
  if (age < 5000) return '刚刚';
  const seconds = Math.floor(age / 1000);
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function formatAccuracy(accuracy) {
  if (accuracy === null || accuracy === undefined || !Number.isFinite(Number(accuracy))) {
    return '定位中';
  }
  const value = Math.max(1, Math.round(Number(accuracy)));
  if (value <= 3) return '±3 米以内';
  if (value >= 100) return `±${value} 米 · 信号弱`;
  return `±${value} 米`;
}

function formatDistance(meters) {
  if (meters === null || meters === undefined || !Number.isFinite(meters)) {
    return { value: '--', unit: '' };
  }
  if (meters < 30) return { value: '很近', unit: '' };
  if (meters < 1000) {
    return { value: String(Math.max(10, Math.round(meters / 10) * 10)), unit: '米' };
  }
  if (meters < 10000) {
    return { value: (meters / 1000).toFixed(1), unit: '公里' };
  }
  return { value: String(Math.round(meters / 1000)), unit: '公里' };
}

function getName() {
  const value = $('nameInput').value.trim().replace(/\s+/g, ' ');
  return Array.from(value).slice(0, 16).join('') || '我';
}

function isStandalone() {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.navigator.standalone === true
  );
}

function isIOS() {
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/i.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
}

function isWeChat() {
  return /MicroMessenger/i.test(navigator.userAgent || '');
}

function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

function vibrate(pattern) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* ignore */
  }
}

/* ---------------------------------------------------------
   API
   --------------------------------------------------------- */

async function api(path, options = {}) {
  const headers = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.auth && state.token) headers.Authorization = `Bearer ${state.token}`;

  let response;
  try {
    response = await fetch(path, {
      method: options.method || 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      keepalive: Boolean(options.keepalive),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', '网络连接失败，请检查网络后重试');
  }

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    throw new ApiError(
      response.status,
      data?.error || 'ERROR',
      data?.message || `请求失败（${response.status}）`,
    );
  }
  return data;
}

/* ---------------------------------------------------------
   Session storage
   --------------------------------------------------------- */

function readSession() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE.session) || 'null');
    if (
      parsed &&
      /^[A-Z0-9]{8}$/.test(parsed.code || '') &&
      typeof parsed.memberId === 'string' &&
      typeof parsed.token === 'string'
    ) {
      return parsed;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function saveSession(data) {
  try {
    localStorage.setItem(
      STORAGE.session,
      JSON.stringify({
        code: data.room.code,
        memberId: data.memberId,
        token: data.token,
        name: getName(),
        savedAt: Date.now(),
      }),
    );
  } catch {
    /* storage can be unavailable in private mode */
  }
}

function clearSession() {
  try {
    localStorage.removeItem(STORAGE.session);
  } catch {
    /* ignore */
  }
}

/* ---------------------------------------------------------
   Boot
   --------------------------------------------------------- */

function boot() {
  bindEvents();

  state.mapProvider =
    new URLSearchParams(location.search).get('map') === 'osm' ? 'osm' : 'amap';

  try {
    state.wakeEnabled = localStorage.getItem(STORAGE.wake) === '1';
  } catch {
    state.wakeEnabled = false;
  }

  const storedName = localStorage.getItem(STORAGE.name);
  if (storedName) $('nameInput').value = storedName;

  updateInstallUI();
  registerServiceWorker();
  wireInstallPrompt();
  wireNetwork();

  state.tickTimer = window.setInterval(tick, 1000);
  state.locationTimer = window.setInterval(() => {
    if (state.screen !== 'room' || state.paused || !state.geo.lastFix) return;
    if (Date.now() - state.geo.lastFix.at > 60000) return;
    postLocation(state.geo.lastFix, true);
  }, LOCATION_HEARTBEAT);

  const params = new URLSearchParams(location.search);
  const code = normalizeCode(params.get('room') || '');
  const session = readSession();

  if (code) {
    $('codeInput').value = formatCode(code);
    if (session && session.code === code) {
      autoRejoin(session);
      return;
    }
  }

  showLanding();
  if (session && !code) showResume(session);
  if (code && session && session.code !== code) {
    showLandingError('你有一个进行中的房间。继续上次同行，或直接加入新的配对码。');
    showResume(session);
  }
}

function showResume(session) {
  const button = $('resumeBtn');
  $('resumeCode').textContent = formatCode(session.code);
  button.hidden = false;
  button.onclick = () => {
    button.disabled = true;
    autoRejoin(session);
  };
}

/* ---------------------------------------------------------
   Landing / room transitions
   --------------------------------------------------------- */

async function autoRejoin(session) {
  setBusy($('createBtn'), true, '正在回到房间…');
  try {
    const data = await api(`/api/rooms/${session.code}/join`, {
      method: 'POST',
      body: {
        name: getName() === '我' ? session.name || '我' : getName(),
        memberId: session.memberId,
        token: session.token,
      },
    });
    enterRoom(data, { rejoin: true });
  } catch (error) {
    if (error.status === 401 || error.status === 404) {
      clearSession();
      $('resumeBtn').hidden = true;
      history.replaceState(null, '', location.pathname);
      showLandingError('上次的房间已结束。创建一个新房间，或输入对方的配对码。');
    } else if (error.status === 0) {
      showLandingError(error.message);
      showResume(session);
    } else {
      showLandingError(error.message);
    }
  } finally {
    setBusy($('createBtn'), false);
  }
}

async function createRoom() {
  hideLandingError();
  const name = getName();
  $('nameInput').value = name;
  setBusy($('createBtn'), true, '正在创建房间…');

  try {
    const data = await api('/api/rooms', { method: 'POST', body: { name } });
    rememberName(name);
    enterRoom(data, { created: true });
  } catch (error) {
    showLandingError(error.message);
  } finally {
    setBusy($('createBtn'), false);
  }
}

async function joinRoom() {
  hideLandingError();
  const code = normalizeCode($('codeInput').value);
  if (code.length !== 8) {
    showLandingError('配对码应为 8 位，请检查后再试。');
    $('codeInput').focus();
    return;
  }

  const name = getName();
  $('nameInput').value = name;
  $('codeInput').value = formatCode(code);
  setBusy($('joinBtn'), true, '加入中…');

  try {
    const data = await api(`/api/rooms/${code}/join`, {
      method: 'POST',
      body: { name },
    });
    rememberName(name);
    enterRoom(data, { joined: true });
  } catch (error) {
    if (error.status === 409) {
      showLandingError('这个房间已经有两个人了。请让对方创建一个新房间。');
    } else if (error.status === 404) {
      showLandingError('配对码不存在，或房间已经过期。');
    } else {
      showLandingError(error.message);
    }
  } finally {
    setBusy($('joinBtn'), false);
  }
}

function rememberName(name) {
  try {
    localStorage.setItem(STORAGE.name, name);
  } catch {
    /* ignore */
  }
}

function enterRoom(data, options = {}) {
  state.sessionLost = false;
  state.roomCode = data.room.code;
  state.memberId = data.memberId;
  state.token = data.token;
  state.snapshot = data.room;
  state.screen = 'room';
  state.partnerSeen = false;
  state.initialViewDone = false;
  state.partnerViewDone = false;

  const self = data.room.members.find((member) => member.id === state.memberId);
  state.paused = self ? !self.sharing : false;

  saveSession(data);
  rememberName(getName());

  $('landing').hidden = true;
  $('room').hidden = false;
  document.body.classList.add('is-room');
  document.title = `同行 · ${formatCode(state.roomCode)}`;

  $('roomCodeLabel').textContent = formatCode(state.roomCode);
  $('settingsCode').textContent = formatCode(state.roomCode);
  $('bigCode').textContent = formatCode(state.roomCode);
  $('codeInput').value = '';
  hideLandingError();
  updateHistory();

  initMap();
  setupDockObserver();
  applySnapshot(data.room, { initial: true });

  window.requestAnimationFrame(() => {
    state.map?.invalidateSize();
    window.setTimeout(() => state.map?.invalidateSize(), 280);
  });

  connectSSE();
  startPolling();
  startGeo();

  if (state.wakeEnabled) requestWakeLock();

  window.setTimeout(() => {
    if (state.screen !== 'room') return;
    if (options.joined) {
      showToast('已加入同行');
    } else if (options.rejoin) {
      showToast('已回到房间');
    } else {
      showToast('房间已创建，把配对码发给 TA');
    }
  }, 420);
}

function exitRoom(options = {}) {
  const { message = '', clear = true } = options;
  const code = state.roomCode;
  const token = state.token;

  if (code && token && clear) {
    fetch(`/api/rooms/${code}/leave`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      keepalive: true,
    }).catch(() => {});
  }

  teardownRoom();
  if (clear) clearSession();
  history.replaceState(null, '', location.pathname);
  document.title = '同行 · 两个人的实时地图';
  $('landing').hidden = false;
  $('room').hidden = true;
  document.body.classList.remove('is-room');
  hideLandingError();

  const session = readSession();
  if (session) showResume(session);
  else $('resumeBtn').hidden = true;

  if (message) showLandingError(message);
}

function teardownRoom() {
  closeSSE();
  stopPolling();
  stopGeo(true);
  releaseWakeLock();
  closeAllDialogs();

  if (state.map) {
    state.map.remove();
    state.map = null;
    state.tileLayer = null;
  }
  state.line = null;
  state.markers.clear();
  state.dockObserver?.disconnect();
  state.dockObserver = null;

  $('dock').classList.remove('is-compact', 'is-paused');
  $('trackingPanel').hidden = true;
  $('waitingPanel').hidden = false;
  $('mapNotice').hidden = true;
  $('geoWarning').hidden = true;
  $('toast').classList.remove('is-visible');

  state.screen = 'landing';
  state.roomCode = null;
  state.memberId = null;
  state.token = null;
  state.snapshot = null;
  state.paused = false;
  state.pauseBusy = false;
  state.initialViewDone = false;
  state.partnerViewDone = false;
  state.partnerSeen = false;
  state.compact = false;
  state.noticeDismissed = false;
  state.sseState = 'idle';
  state.sseRetries = 0;
  state.geo.lastSentAt = 0;
  document.documentElement.style.removeProperty('--dock-height');
}

function updateHistory() {
  const params = new URLSearchParams();
  params.set('room', state.roomCode);
  if (state.mapProvider === 'osm') params.set('map', 'osm');
  history.replaceState(null, '', `${location.pathname}?${params.toString()}`);
}

function showLanding() {
  $('landing').hidden = false;
  $('room').hidden = true;
  document.body.classList.remove('is-room');
}

function showLandingError(message) {
  const element = $('landingError');
  element.textContent = message;
  element.hidden = !message;
}

function hideLandingError() {
  $('landingError').hidden = true;
  $('landingError').textContent = '';
}

function setBusy(button, busy, label = '') {
  if (!button) return;
  if (busy) {
    if (!button.dataset.originalHtml) button.dataset.originalHtml = button.innerHTML;
    button.disabled = true;
    button.classList.add('is-loading');
    button.textContent = label;
  } else {
    button.disabled = false;
    button.classList.remove('is-loading');
    if (button.dataset.originalHtml) {
      button.innerHTML = button.dataset.originalHtml;
      delete button.dataset.originalHtml;
    }
  }
}

/* ---------------------------------------------------------
   Real-time connection (SSE)
   --------------------------------------------------------- */

function connectSSE() {
  if (!state.roomCode || !state.token) return;
  closeSSE();
  state.sseRetries = 0;
  setConnection('connecting');

  const url =
    `/api/rooms/${state.roomCode}/events` +
    `?memberId=${encodeURIComponent(state.memberId)}` +
    `&token=${encodeURIComponent(state.token)}`;

  let source;
  try {
    source = new EventSource(url);
  } catch {
    setConnection('bad');
    return;
  }
  state.sse = source;

  source.onopen = () => {
    if (state.sse !== source) return;
    state.sseRetries = 0;
    setConnection('live');
  };

  source.addEventListener('room', (event) => {
    if (state.sse !== source) return;
    try {
      const snapshot = JSON.parse(event.data);
      applySnapshot(snapshot);
    } catch {
      /* ignore malformed frame */
    }
  });

  source.onerror = () => {
    if (state.sse !== source) return;
    state.sseRetries += 1;
    setConnection(navigator.onLine ? 'wait' : 'bad');
    if (navigator.onLine && state.sseRetries >= 3) {
      validateSession();
    }
  };
}

function closeSSE() {
  if (state.sse) {
    state.sse.onopen = null;
    state.sse.onerror = null;
    state.sse.close();
    state.sse = null;
  }
}

function startPolling() {
  stopPolling();
  if (state.screen !== 'room' || !state.roomCode || !state.token) return;
  pollState();
  state.pollTimer = window.setInterval(pollState, 2500);
}

function stopPolling() {
  if (state.pollTimer) {
    window.clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

async function pollState() {
  if (
    state.screen !== 'room' ||
    !state.roomCode ||
    !state.token ||
    state.polling ||
    navigator.onLine === false
  ) {
    return;
  }

  state.polling = true;
  try {
    // SSE 是主通道；轮询是兜底，保证在会缓冲 SSE 的代理/隧道后也能更新。
    const data = await api(`/api/rooms/${state.roomCode}/state`, { auth: true });
    if (state.screen !== 'room') return;
    if (data?.room) applySnapshot(data.room);
  } catch (error) {
    if (error.status === 401 || error.status === 404) {
      handleSessionLost('房间已结束，请重新创建或加入。');
    }
  } finally {
    state.polling = false;
  }
}

function setConnection(kind) {
  state.sseState = kind;
  const pill = $('connPill');
  const text = $('connText');
  if (!pill || !text) return;

  pill.classList.remove('is-wait', 'is-bad');
  if (kind === 'live') {
    text.textContent = '实时同步';
  } else if (kind === 'connecting') {
    text.textContent = '连接中';
    pill.classList.add('is-wait');
  } else if (kind === 'wait') {
    text.textContent = '正在重连';
    pill.classList.add('is-wait');
  } else if (kind === 'bad') {
    text.textContent = '网络离线';
    pill.classList.add('is-bad');
  } else {
    text.textContent = '未连接';
    pill.classList.add('is-wait');
  }
}

async function validateSession() {
  if (state.validating || !state.token || state.screen !== 'room') return;
  state.validating = true;
  try {
    const data = await api(`/api/rooms/${state.roomCode}/join`, {
      method: 'POST',
      body: { name: getName(), memberId: state.memberId, token: state.token },
    });
    if (state.screen !== 'room') return;
    applySnapshot(data.room);
    state.sseRetries = 0;
    if (state.sse && state.sse.readyState === EventSource.CLOSED) {
      connectSSE();
    }
  } catch (error) {
    if (error.status === 401 || error.status === 404) {
      handleSessionLost('房间已结束，请重新创建或加入。');
    }
  } finally {
    state.validating = false;
  }
}

function handleSessionLost(message) {
  if (state.sessionLost) return;
  state.sessionLost = true;
  closeSSE();
  showToast(message, true);
  window.setTimeout(() => {
    exitRoom({ message, clear: true });
  }, 1200);
}

/* ---------------------------------------------------------
   Snapshot / rendering
   --------------------------------------------------------- */

function applySnapshot(snapshot, options = {}) {
  if (!snapshot || snapshot.code !== state.roomCode) return;

  state.snapshot = snapshot;
  state.lastSnapshotAt = Date.now();
  if (snapshot.serverTime) state.clockOffset = snapshot.serverTime - Date.now();

  const self = getSelf();
  if (self) state.paused = !self.sharing;

  const partner = getPartner();
  if (partner) {
    if (!state.partnerSeen && !options.initial) {
      showToast(`${partner.name} 已加入同行`);
      vibrate(18);
    }
    state.partnerSeen = true;
  } else if (state.partnerSeen) {
    state.partnerSeen = false;
    if (!options.initial) showToast('对方已离开房间');
  } else {
    state.partnerSeen = false;
  }

  renderAll();
}

function getSelf(snapshot = state.snapshot) {
  return snapshot?.members.find((member) => member.id === state.memberId) || null;
}

function getPartner(snapshot = state.snapshot) {
  return snapshot?.members.find((member) => member.id !== state.memberId) || null;
}

function getSelfLocation() {
  if (state.paused) return null;
  const self = getSelf();
  if (!self) return null;
  const local = state.geo.lastFix;
  if (local && Date.now() - local.at < 30000) return local;
  return self.location;
}

function getPartnerLocation() {
  const partner = getPartner();
  if (!partner || !partner.sharing) return null;
  return partner.location;
}

function renderAll() {
  if (state.screen !== 'room' || !state.snapshot) return;

  renderPanels();
  renderCode();
  renderPaused();
  renderMeta();
  renderMapMarkers();
  updateDockHeight();
  maybeInitialView();
}

function renderPanels() {
  const partner = getPartner();
  $('waitingPanel').hidden = Boolean(partner);
  $('trackingPanel').hidden = !partner;
}

function renderCode() {
  const formatted = formatCode(state.roomCode);
  $('roomCodeLabel').textContent = formatted;
  $('settingsCode').textContent = formatted;
  $('bigCode').textContent = formatted;
}

function renderPaused() {
  const dock = $('dock');
  dock.classList.toggle('is-paused', state.paused);

  const label = state.paused ? '恢复共享' : '暂停共享';
  const icon = state.paused ? '#i-play' : '#i-pause';

  const pauseButton = $('pauseBtn');
  pauseButton.disabled = state.pauseBusy;
  pauseButton.querySelector('use')?.setAttribute('href', icon);
  const pauseLabel = pauseButton.querySelector('span:last-child');
  if (pauseLabel) pauseLabel.textContent = label;

  const settingsPause = $('settingsPause');
  settingsPause.disabled = state.pauseBusy;
  settingsPause.querySelector('.setting-icon use')?.setAttribute('href', icon);
  settingsPause.querySelector('.setting-text strong').textContent = state.paused
    ? '恢复共享位置'
    : '暂停共享位置';

  const tag = $('shareStateTag');
  tag.textContent = state.paused ? '已暂停' : '共享中';
  tag.classList.toggle('is-paused', state.paused);

  const wakeToggle = $('wakeToggle');
  if (wakeToggle) wakeToggle.checked = state.wakeEnabled;

  const mapLabel = $('mapProviderLabel');
  if (mapLabel) {
    mapLabel.textContent =
      state.mapProvider === 'amap' ? '高德地图 · 国内加载更稳' : 'OpenStreetMap · 海外可用';
  }
}

function renderMeta() {
  const self = getSelf();
  const partner = getPartner();
  const selfLocation = getSelfLocation();
  const partnerLocation = getPartnerLocation();

  if (partner) {
    $('partnerName').textContent = partner.name;
    $('partnerRowName').textContent = partner.name;
    $('partnerAvatar').textContent = initialOf(partner.name);
    $('partnerRowAvatar').textContent = initialOf(partner.name);
  }

  const selfMeta = $('selfMeta');
  if (!self) {
    selfMeta.textContent = '—';
  } else if (state.paused) {
    selfMeta.textContent = '已暂停共享位置';
  } else if (state.geo.status === 'denied') {
    selfMeta.textContent = '定位权限未开启';
  } else if (state.geo.issue === 'insecure') {
    selfMeta.textContent = '需要 HTTPS 才能定位';
  } else if (selfLocation) {
    const local = selfLocation === state.geo.lastFix;
    selfMeta.textContent = `${formatAccuracy(selfLocation.accuracy)} · ${
      local ? relativeTime(selfLocation.at, { local: true }) : relativeTime(selfLocation.at)
    }`;
  } else if (state.geo.status === 'locating') {
    selfMeta.textContent = '正在获取位置…';
  } else {
    selfMeta.textContent = '等待定位信号…';
  }

  const signal = $('selfSignal');
  signal.className = 'signal';
  if (
    state.paused ||
    state.geo.status === 'denied' ||
    state.geo.issue === 'insecure' ||
    !selfLocation
  ) {
    signal.classList.add('is-off');
  } else if ((selfLocation.accuracy || 0) > 60) {
    signal.classList.add('is-weak');
  }

  const partnerMeta = $('partnerMeta');
  const onlineLabel = $('partnerOnline');
  const partnerState = $('partnerState');

  if (!partner) {
    partnerMeta.textContent = '等待对方加入';
    onlineLabel.className = 'online-label is-offline';
    onlineLabel.innerHTML = '<i></i>等待';
    partnerState.className = 'partner-state is-offline';
    partnerState.innerHTML = '<i></i>等待加入';
  } else if (!partner.sharing) {
    partnerMeta.textContent = '已暂停共享位置';
    onlineLabel.className = 'online-label is-offline';
    onlineLabel.innerHTML = '<i></i>已暂停';
    partnerState.className = 'partner-state is-paused';
    partnerState.innerHTML = '<i></i>已暂停共享';
  } else if (partnerLocation) {
    const ageText = relativeTime(partnerLocation.at);
    partnerMeta.textContent = `${formatAccuracy(partnerLocation.accuracy)} · ${
      partner.online ? ageText : `最后位置 ${ageText}`
    }`;
    onlineLabel.className = partner.online ? 'online-label' : 'online-label is-offline';
    onlineLabel.innerHTML = partner.online ? '<i></i>在线' : '<i></i>离线';
    partnerState.className = partner.online ? 'partner-state' : 'partner-state is-offline';
    partnerState.innerHTML = partner.online ? '<i></i>实时在线' : '<i></i>已离线';
  } else if (partner.online) {
    partnerMeta.textContent = '正在获取对方位置…';
    onlineLabel.className = 'online-label';
    onlineLabel.innerHTML = '<i></i>在线';
    partnerState.className = 'partner-state';
    partnerState.innerHTML = '<i></i>正在定位';
  } else {
    partnerMeta.textContent = '对方已离线';
    onlineLabel.className = 'online-label is-offline';
    onlineLabel.innerHTML = '<i></i>离线';
    partnerState.className = 'partner-state is-offline';
    partnerState.innerHTML = '<i></i>已离线';
  }

  if (self && partner && selfLocation && partnerLocation) {
    const distance = haversine(selfLocation, partnerLocation);
    const formatted = formatDistance(distance);
    $('distanceValue').textContent = formatted.value;
    $('distanceUnit').textContent = formatted.unit;
  } else {
    $('distanceValue').textContent = '--';
    $('distanceUnit').textContent = '';
  }

  renderGeoWarning();
}

function renderGeoWarning() {
  const warning = $('geoWarning');
  if (!warning) return;

  if (state.geo.issue === 'insecure') {
    warning.hidden = false;
    $('geoWarningTitle').textContent = '需要 HTTPS 才能定位';
    $('geoWarningText').textContent = '手机浏览器只允许在 HTTPS 页面获取位置。';
    return;
  }
  if (state.geo.status === 'denied') {
    warning.hidden = false;
    $('geoWarningTitle').textContent = '定位权限未开启';
    $('geoWarningText').textContent = '允许定位后，对方才能看到你的位置。';
    return;
  }
  if (state.geo.issue === 'unsupported') {
    warning.hidden = false;
    $('geoWarningTitle').textContent = '浏览器不支持定位';
    $('geoWarningText').textContent = '请使用 Safari、Chrome 或 Edge 打开。';
    return;
  }
  warning.hidden = true;
}

function tick() {
  if (state.screen !== 'room' || !state.snapshot) return;
  renderMeta();
  renderMapMarkers();
}

function updateDockHeight() {
  const dock = $('dock');
  if (!dock || state.screen !== 'room') return;
  const height = dock.offsetHeight;
  if (height) document.documentElement.style.setProperty('--dock-height', `${height}px`);
}

function setupDockObserver() {
  if (state.dockObserver || typeof ResizeObserver === 'undefined') {
    window.addEventListener('resize', updateDockHeight, { passive: true });
    return;
  }
  state.dockObserver = new ResizeObserver(() => updateDockHeight());
  state.dockObserver.observe($('dock'));
}

/* ---------------------------------------------------------
   Map
   --------------------------------------------------------- */

function renderMapCredit() {
  const credit = $('mapCredit');
  if (!credit) return;
  if (state.mapProvider === 'amap') {
    credit.textContent = '地图数据 © 高德地图';
    credit.href = 'https://www.amap.com/';
  } else {
    credit.textContent = '地图数据 © OpenStreetMap 贡献者';
    credit.href = 'https://www.openstreetmap.org/copyright';
  }
}

function initMap() {
  if (state.map) {
    window.setTimeout(() => state.map?.invalidateSize(), 60);
    return;
  }
  if (!window.L) {
    showMapNotice();
    return;
  }

  state.map = window.L.map('map', {
    zoomControl: false,
    attributionControl: false,
    preferCanvas: true,
    worldCopyJump: true,
    minZoom: 3,
    maxZoom: 19,
  }).setView([33.8, 108.9], 4);

  if (state.mapProvider === 'amap') {
    state.tileLayer = window.L.tileLayer(
      'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
      {
        subdomains: ['1', '2', '3', '4'],
        maxZoom: 19,
        maxNativeZoom: 18,
      },
    ).addTo(state.map);
  } else {
    state.tileLayer = window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
    }).addTo(state.map);
  }
  renderMapCredit();

  let tileErrors = 0;
  let tileLoads = 0;
  state.tileLayer.on('tileerror', () => {
    tileErrors += 1;
    if (tileErrors >= 4 && !state.noticeDismissed) showMapNotice();
  });
  state.tileLayer.on('tileload', () => {
    tileLoads += 1;
    if (tileLoads > 2 && !state.noticeDismissed) $('mapNotice').hidden = true;
  });

  state.line = window.L.polyline([], {
    color: '#7c8f7a',
    weight: 2,
    opacity: 0.65,
    dashArray: '4 9',
    interactive: false,
  }).addTo(state.map);

  state.map.on('resize', () => updateDockHeight());
}

function showMapNotice() {
  if (state.noticeDismissed) return;
  $('mapNotice').hidden = false;
}

function renderMapMarkers() {
  if (!state.map || !window.L) return;

  const self = getSelf();
  const partner = getPartner();
  const selfLocation = getSelfLocation();
  const partnerLocation = getPartnerLocation();
  const active = new Set();

  if (self && selfLocation) {
    active.add(self.id);
    updateMarker(self, selfLocation, true);
  }
  if (partner && partner.sharing && partnerLocation) {
    active.add(partner.id);
    updateMarker(partner, partnerLocation, false);
  }

  for (const id of [...state.markers.keys()]) {
    if (!active.has(id)) removeMarker(id);
  }

  if (state.line) {
    const selfPoint = displayPoint(selfLocation);
    const partnerPoint = displayPoint(partnerLocation);
    if (selfPoint && partnerPoint) {
      state.line.setLatLngs([
        [selfPoint.lat, selfPoint.lng],
        [partnerPoint.lat, partnerPoint.lng],
      ]);
    } else {
      state.line.setLatLngs([]);
    }
  }
}

function updateMarker(member, location, isSelf) {
  const point = displayPoint(location);
  if (!point) return;
  const age =
    location === state.geo.lastFix
      ? Math.max(0, Date.now() - location.at)
      : ageOf(location.at);
  const paused = !member.sharing;
  const offline = !isSelf && !member.online;
  const stale = !paused && !offline && age > STALE_AFTER;

  const key = [
    member.name,
    isSelf ? 'self' : 'partner',
    paused ? 'paused' : 'sharing',
    offline ? 'offline' : 'online',
    stale ? 'stale' : 'fresh',
  ].join('|');

  let record = state.markers.get(member.id);

  if (!record) {
    const icon = createMarkerIcon(member, isSelf, { paused, offline, stale });
    const marker = window.L.marker([point.lat, point.lng], {
      icon,
      interactive: false,
      keyboard: false,
      zIndexOffset: isSelf ? 1000 : 900,
    }).addTo(state.map);

    const circle = window.L.circle([point.lat, point.lng], {
      radius: Math.max(8, Math.min(Number(location.accuracy) || 12, 600)),
      color: isSelf ? '#ff6a4d' : '#1e6b5c',
      weight: 1,
      opacity: 0.55,
      fillColor: isSelf ? '#ff6a4d' : '#1e6b5c',
      fillOpacity: 0.09,
      interactive: false,
    }).addTo(state.map);

    record = { marker, circle, key, accuracy: location.accuracy };
    state.markers.set(member.id, record);
  } else {
    if (record.key !== key) {
      record.marker.setIcon(createMarkerIcon(member, isSelf, { paused, offline, stale }));
      record.key = key;
    }
    record.marker.setLatLng([point.lat, point.lng]);
    record.circle.setLatLng([point.lat, point.lng]);
    if (record.accuracy !== location.accuracy) {
      record.circle.setRadius(Math.max(8, Math.min(Number(location.accuracy) || 12, 600)));
      record.accuracy = location.accuracy;
    }
  }
}

function createMarkerIcon(member, isSelf, flags) {
  const classes = [
    'pin',
    isSelf ? 'pin-me' : 'pin-partner',
    flags.paused ? 'is-paused' : '',
    flags.offline ? 'is-offline' : '',
    flags.stale ? 'is-stale' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const label = isSelf ? '我' : member.name;
  const core = isSelf
    ? '<span class="pin-dot"></span>'
    : `<span>${escapeHtml(initialOf(member.name))}</span>`;

  return window.L.divIcon({
    className: 'person-marker',
    html:
      `<div class="${classes}">` +
      '<span class="pin-halo"></span>' +
      `<span class="pin-core">${core}</span>` +
      `<span class="pin-label">${escapeHtml(label)}</span>` +
      '</div>',
    iconSize: [44, 44],
    iconAnchor: [22, 22],
  });
}

function removeMarker(id) {
  const record = state.markers.get(id);
  if (!record) return;
  record.marker.remove();
  record.circle.remove();
  state.markers.delete(id);
}

function maybeInitialView() {
  if (!state.map || !window.L) return;
  const selfLocation = getSelfLocation();
  const partnerLocation = getPartnerLocation();
  if (!selfLocation) return;

  if (!state.initialViewDone) {
    if (partnerLocation) {
      fitBoth(false);
      state.partnerViewDone = true;
    } else {
      const selfPoint = displayPoint(selfLocation);
      state.map.flyTo([selfPoint.lat, selfPoint.lng], 16, {
        animate: !prefersReducedMotion(),
        duration: 1,
      });
    }
    state.initialViewDone = true;
    return;
  }

  if (!state.partnerViewDone && partnerLocation) {
    fitBoth(true);
    state.partnerViewDone = true;
  }
}

function fitBoth(animate = true) {
  if (!state.map || !window.L) return;
  const points = [];
  const selfLocation = getSelfLocation();
  const partnerLocation = getPartnerLocation();
  const selfPoint = displayPoint(selfLocation);
  const partnerPoint = displayPoint(partnerLocation);
  if (selfPoint) points.push([selfPoint.lat, selfPoint.lng]);
  if (partnerPoint) points.push([partnerPoint.lat, partnerPoint.lng]);
  if (!points.length) return;

  if (points.length === 1) {
    state.map.flyTo(points[0], 16, {
      animate: animate && !prefersReducedMotion(),
      duration: 0.9,
    });
    return;
  }

  const desktop = window.matchMedia('(min-width: 900px)').matches;
  const dockHeight = $('dock').offsetHeight || 320;
  const padding = desktop
    ? { paddingTopLeft: [70, 110], paddingBottomRight: [440, 70] }
    : { paddingTopLeft: [46, 100], paddingBottomRight: [46, dockHeight + 34] };

  state.map.fitBounds(window.L.latLngBounds(points), {
    ...padding,
    maxZoom: 17,
    animate: animate && !prefersReducedMotion(),
    duration: 0.9,
  });
}

/* ---------------------------------------------------------
   Geolocation
   --------------------------------------------------------- */

function startGeo() {
  if (state.paused || state.screen !== 'room') return;
  if (state.geo.watchId !== null) return;

  if (!navigator.geolocation) {
    state.geo.issue = 'unsupported';
    state.geo.status = 'unavailable';
    renderMeta();
    return;
  }

  if (!window.isSecureContext) {
    const localHost = ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
    if (!localHost) {
      state.geo.issue = 'insecure';
      state.geo.status = 'unavailable';
      renderMeta();
      return;
    }
  }

  state.geo.issue = null;
  state.geo.status = 'locating';
  renderMeta();

  state.geo.watchId = navigator.geolocation.watchPosition(onPosition, onGeoError, {
    enableHighAccuracy: true,
    maximumAge: 2000,
    timeout: 20000,
  });
}

function stopGeo(clearFix = false) {
  if (state.geo.watchId !== null) {
    navigator.geolocation.clearWatch(state.geo.watchId);
    state.geo.watchId = null;
  }
  state.geo.status = 'off';
  if (clearFix) {
    state.geo.lastFix = null;
    state.geo.lastSentFix = null;
  }
}

function onPosition(position) {
  if (state.screen !== 'room' || state.paused) return;
  const coords = position.coords;
  const fix = {
    lat: coords.latitude,
    lng: coords.longitude,
    accuracy: Number.isFinite(coords.accuracy) ? coords.accuracy : null,
    heading:
      coords.heading !== null && Number.isFinite(coords.heading) ? coords.heading : null,
    speed: coords.speed !== null && Number.isFinite(coords.speed) ? coords.speed : null,
    at: Date.now(),
  };

  state.geo.lastFix = fix;
  state.geo.status = fix.accuracy && fix.accuracy > 80 ? 'weak' : 'live';
  state.geo.issue = null;
  state.geo.lastErrorAt = 0;

  renderMeta();
  renderMapMarkers();
  maybeInitialView();
  postLocation(fix, false);
}

function onGeoError(error) {
  state.geo.lastErrorAt = Date.now();
  if (error.code === 1) {
    state.geo.status = 'denied';
    state.geo.issue = 'denied';
    stopGeo(false);
    renderMeta();
    return;
  }
  if (error.code === 3) {
    if (!state.geo.lastFix) state.geo.status = 'weak';
    renderMeta();
    return;
  }
  if (!state.geo.lastFix) state.geo.status = 'weak';
  renderMeta();
}

async function retryGeo() {
  stopGeo(false);
  state.geo.status = 'locating';
  state.geo.issue = null;
  renderMeta();
  startGeo();
  showToast('正在重新获取定位');
}

async function postLocation(fix, force = false) {
  if (state.paused || state.screen !== 'room' || !state.token || state.geo.sending) return;
  if (!navigator.onLine || !fix) return;

  const now = Date.now();
  if (!force && now - state.geo.lastSentAt < LOCATION_INTERVAL_MIN) return;

  if (!force && state.geo.lastSentFix && now - state.geo.lastSentAt < LOCATION_INTERVAL_MAX) {
    const moved = haversine(state.geo.lastSentFix, fix);
    if (moved !== null && moved < 6) return;
  }

  state.geo.lastSentAt = now;
  state.geo.lastSentFix = { ...fix };
  state.geo.sending = true;

  try {
    const response = await fetch(`/api/rooms/${state.roomCode}/location`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${state.token}`,
      },
      body: JSON.stringify({
        lat: fix.lat,
        lng: fix.lng,
        accuracy: fix.accuracy,
        heading: fix.heading,
        speed: fix.speed,
      }),
    });

    if (response.status === 401 || response.status === 404) {
      handleSessionLost('房间已结束，请重新创建或加入。');
      return;
    }
    if (response.status === 409) {
      state.paused = true;
      stopGeo(true);
      renderAll();
      return;
    }
    if (!response.ok) state.geo.lastSentAt = 0;
  } catch {
    state.geo.lastSentAt = 0;
  } finally {
    state.geo.sending = false;
  }
}

async function togglePause() {
  if (state.pauseBusy || state.screen !== 'room') return;
  state.pauseBusy = true;
  renderPaused();

  const nextPaused = !state.paused;
  try {
    await api(`/api/rooms/${state.roomCode}/sharing`, {
      method: 'POST',
      auth: true,
      body: { sharing: !nextPaused },
    });

    state.paused = nextPaused;
    if (nextPaused) stopGeo(true);
    else startGeo();

    renderAll();
    showToast(nextPaused ? '已暂停位置共享' : '已恢复位置共享');
  } catch (error) {
    showToast(error.message, true);
  } finally {
    state.pauseBusy = false;
    renderPaused();
  }
}

/* ---------------------------------------------------------
   Wake lock
   --------------------------------------------------------- */

async function requestWakeLock() {
  if (!state.wakeEnabled || state.screen !== 'room') return;
  if (!('wakeLock' in navigator) || state.wakeLock) return;
  try {
    state.wakeLock = await navigator.wakeLock.request('screen');
    state.wakeLock.addEventListener('release', () => {
      state.wakeLock = null;
    });
  } catch {
    state.wakeLock = null;
  }
}

function releaseWakeLock() {
  if (state.wakeLock) {
    state.wakeLock.release().catch(() => {});
    state.wakeLock = null;
  }
}

async function setWakePreference(enabled) {
  if (enabled && !('wakeLock' in navigator)) {
    showToast('当前浏览器不支持屏幕常亮', true);
    $('wakeToggle').checked = false;
    return;
  }

  state.wakeEnabled = enabled;
  try {
    localStorage.setItem(STORAGE.wake, enabled ? '1' : '0');
  } catch {
    /* ignore */
  }

  if (enabled) {
    await requestWakeLock();
    if (!state.wakeLock) showToast('屏幕常亮未能开启');
  } else {
    releaseWakeLock();
  }
}

/* ---------------------------------------------------------
   Sharing / install / dialogs
   --------------------------------------------------------- */

function inviteUrl() {
  const url = new URL(location.pathname || '/', location.origin);
  url.searchParams.set('room', state.roomCode || '');
  if (state.mapProvider === 'osm') url.searchParams.set('map', 'osm');
  return url.toString();
}

async function shareInvite() {
  if (!state.roomCode) return;
  const url = inviteUrl();
  const text = `我在「同行」等你，配对码 ${formatCode(state.roomCode)}`;

  if (navigator.share) {
    try {
      await navigator.share({ title: '同行 · 双人实时定位', text, url });
      return;
    } catch (error) {
      if (error?.name === 'AbortError') return;
    }
  }

  const copied = await copyText(`${text}\n${url}`);
  showToast(copied ? '邀请已复制，发给 TA 吧' : '复制失败，请手动复制配对码', !copied);
}

async function copyInvite() {
  if (!state.roomCode) return;
  const copied = await copyText(inviteUrl());
  showToast(copied ? '邀请链接已复制' : '复制失败，请手动复制', !copied);
}

async function copyCode() {
  if (!state.roomCode) return;
  const copied = await copyText(formatCode(state.roomCode));
  showToast(copied ? '配对码已复制' : '复制失败，请手动复制', !copied);
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }

  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '-1000px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    textarea.remove();
    return ok;
  } catch {
    return false;
  }
}

function showToast(message, isError = false) {
  const toast = $('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.toggle('is-error', Boolean(isError));
  toast.classList.remove('is-visible');
  void toast.offsetWidth;
  toast.classList.add('is-visible');
  window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => {
    toast.classList.remove('is-visible');
  }, 3200);
}

function wireInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    state.installPrompt = event;
    updateInstallUI();
  });
  window.addEventListener('appinstalled', () => {
    state.installPrompt = null;
    updateInstallUI();
    closeDialog('installDialog');
    showToast('已安装到主屏幕');
  });
  window.matchMedia?.('(display-mode: standalone)').addEventListener?.('change', updateInstallUI);
}

function updateInstallUI() {
  const standalone = isStandalone();
  const installNav = $('installNav');
  if (installNav) installNav.hidden = standalone;
  const settingsInstall = $('settingsInstall');
  if (settingsInstall) {
    const small = settingsInstall.querySelector('small');
    if (small) {
      small.textContent = standalone ? '已安装，当前为主屏幕模式' : '像原生 App 一样从桌面打开';
    }
  }
}

function openInstall() {
  if (isStandalone()) {
    showToast('已经在主屏幕模式中');
    return;
  }

  const body = $('installBody');
  const action = $('installAction');
  action.hidden = true;

  if (state.installPrompt) {
    body.innerHTML = `
      <p>把「同行」添加到主屏幕，下次打开不用再找链接，也不会出现在应用商店的更新列表里。</p>
      <div class="install-note">
        <svg><use href="#i-phone"/></svg>
        <span>安装后会以独立窗口打开，和普通 App 的体验一样。</span>
      </div>`;
    action.hidden = false;
    action.textContent = '立即安装';
  } else if (isIOS()) {
    body.innerHTML = `
      <p>${isWeChat() ? '微信内无法直接安装，请先点右上角“…” → 在 Safari 中打开。' : '在 Safari 中按下面的步骤添加：'}</p>
      <ol class="install-steps">
        <li>点击 Safari 底部工具栏的 <b>分享按钮</b>（方框向上箭头）。</li>
        <li>在菜单里向下滑，选择 <b>“添加到主屏幕”</b>。</li>
        <li>确认名称后点右上角 <b>“添加”</b>，从桌面就能打开同行。</li>
      </ol>
      <div class="install-note">
        <svg><use href="#i-lock"/></svg>
        <span>iOS 的定位权限需要在 HTTPS 页面才能使用，部署后的链接默认已满足。</span>
      </div>`;
  } else {
    body.innerHTML = `
      <p>${isWeChat() ? '微信内无法直接安装，请点右上角“…” → 在浏览器中打开。' : '用 Chrome / Edge 打开时，可以这样添加：'}</p>
      <ol class="install-steps">
        <li>点击浏览器右上角的 <b>⋮ 菜单</b>。</li>
        <li>选择 <b>“安装应用”</b> 或 <b>“添加到主屏幕”</b>。</li>
        <li>确认后，从桌面图标打开同行。</li>
      </ol>
      <div class="install-note">
        <svg><use href="#i-shield"/></svg>
        <span>不需要应用商店，不会索取额外权限。</span>
      </div>`;
  }

  openDialog('installDialog');
}

async function runInstallPrompt() {
  const prompt = state.installPrompt;
  if (!prompt) {
    openInstall();
    return;
  }
  state.installPrompt = null;
  $('installAction').hidden = true;
  try {
    await prompt.prompt();
    const choice = await prompt.userChoice;
    if (choice?.outcome === 'accepted') {
      showToast('正在添加到主屏幕');
      closeDialog('installDialog');
    } else {
      showToast('已取消安装');
    }
  } catch {
    showToast('安装没有完成，可以稍后再试', true);
  }
  updateInstallUI();
}

function openPrivacy() {
  openInfo(
    '你的位置，只属于这个房间',
    'PRIVACY',
    `
    <h3>位置怎样被使用</h3>
    <p>你的经纬度只会发送到当前同行房间的服务端，并通过实时连接转发给房间里的另一位成员。服务端不写数据库，也不记录位置日志。</p>
    <h3>保存多久</h3>
    <p>位置只存在于服务器内存中。你暂停共享或退出房间时，位置会被清除；房间在无人连接且闲置 <strong>2 小时</strong>后自动删除。</p>
    <h3>谁能看到</h3>
    <p>只有拿到 8 位配对码的人。一个房间最多两个人。请把配对码当作一小串钥匙，不要公开发布。</p>
    <h3>你可以随时</h3>
    <ul>
      <li>在房间内点“暂停共享”，立刻让位置从对方地图上消失。</li>
      <li>点“退出这个房间”，释放你在房间里的位置。</li>
      <li>在浏览器设置中撤销定位权限。</li>
    </ul>
    <h3>地图与后台</h3>
    <p>地图底图由高德或 OpenStreetMap 提供，加载底图时会向对应服务发出网络请求。手机锁屏或切到后台后，系统可能暂停定位；回到同行页面会自动恢复。</p>
    <p>定位需要 HTTPS。页面不会读取通讯录、相册、麦克风或摄像头。</p>`,
  );
}

function openGeoHelp() {
  let html;
  if (state.geo.issue === 'insecure') {
    html = `
      <h3>为什么需要 HTTPS</h3>
      <p>iOS 和 Android 的浏览器都只允许在安全上下文中使用定位。请通过部署后的 <strong>https://</strong> 链接打开，或在本机使用 localhost 预览。</p>
      <h3>怎样部署</h3>
      <p>项目附带 Dockerfile 和 Render 配置。按 README 中的说明部署后，平台会自动提供 HTTPS 地址。</p>`;
  } else {
    html = `
      <h3>iPhone / Safari</h3>
      <ol>
        <li>打开“设置”→“隐私与安全性”→“定位服务”。</li>
        <li>确认“定位服务”已开启，并在浏览器（Safari 或 Chrome）中选择“使用 App 期间”。</li>
        <li>回到同行页面，刷新后点“处理”重试。</li>
      </ol>
      <h3>Android / Chrome</h3>
      <ol>
        <li>点地址栏左侧的锁形或信息图标。</li>
        <li>把“位置”权限改为“允许”。</li>
        <li>刷新页面后重试。</li>
      </ol>
      <h3>微信 / 内置浏览器</h3>
      <p>部分内置浏览器不允许定位。请点右上角“…”→“在浏览器打开”。</p>
      <button class="btn btn-primary install-action" type="button" data-retry-geo>重新获取定位</button>`;
  }
  openInfo('开启定位权限', 'LOCATION', html);
}

function openInfo(title, eyebrow, html) {
  $('infoTitle').textContent = title;
  $('infoEyebrow').textContent = eyebrow;
  $('infoBody').innerHTML = html;
  openDialog('infoDialog');
}

function openSettings() {
  if (state.screen !== 'room') return;
  $('settingsCode').textContent = formatCode(state.roomCode);
  $('wakeToggle').checked = state.wakeEnabled;
  resetLeaveButton();
  renderPaused();
  openDialog('settingsDialog');
}

function switchMapProvider() {
  const params = new URLSearchParams(location.search);
  if (state.mapProvider === 'amap') params.set('map', 'osm');
  else params.delete('map');
  location.href = `${location.pathname}?${params.toString()}`;
}

function openDialog(id) {
  const dialog = $(id);
  if (!dialog || dialog.open) return;
  try {
    dialog.showModal();
  } catch {
    dialog.setAttribute('open', '');
  }
}

function closeDialog(id) {
  const dialog = $(id);
  if (dialog?.open) dialog.close();
}

function closeAllDialogs() {
  for (const id of ['settingsDialog', 'installDialog', 'infoDialog']) closeDialog(id);
}

function resetLeaveButton() {
  const button = $('leaveBtn');
  if (!button) return;
  button.classList.remove('is-confirming');
  button.textContent = '退出这个房间';
  window.clearTimeout(state.leaveTimer);
}

function handleLeave() {
  const button = $('leaveBtn');
  if (!button.classList.contains('is-confirming')) {
    button.classList.add('is-confirming');
    button.textContent = '再点一次，确认退出';
    window.clearTimeout(state.leaveTimer);
    state.leaveTimer = window.setTimeout(resetLeaveButton, 3500);
    return;
  }

  resetLeaveButton();
  closeAllDialogs();
  exitRoom({ message: '', clear: true });
}

/* ---------------------------------------------------------
   Network / visibility
   --------------------------------------------------------- */

function wireNetwork() {
  window.addEventListener('online', () => {
    showToast('网络已恢复');
    if (state.screen === 'room') {
      connectSSE();
      startPolling();
      if (!state.paused) startGeo();
    }
  });

  window.addEventListener('offline', () => {
    setConnection('bad');
    showToast('网络已断开，正在等待恢复', true);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      releaseWakeLock();
      return;
    }
    if (state.screen !== 'room') return;

    state.map?.invalidateSize();
    if (state.sse && state.sse.readyState === EventSource.CLOSED) connectSSE();
    if (!state.paused && state.geo.watchId === null) startGeo();
    if (state.wakeEnabled) requestWakeLock();
    pollState();
    renderAll();
    if (state.geo.lastFix) postLocation(state.geo.lastFix, true);
  });
}

/* ---------------------------------------------------------
   Service worker
   --------------------------------------------------------- */

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const secure =
    location.protocol === 'https:' ||
    ['localhost', '127.0.0.1'].includes(location.hostname);
  if (!secure) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

/* ---------------------------------------------------------
   Events
   --------------------------------------------------------- */

function bindEvents() {
  $('createBtn').addEventListener('click', createRoom);
  $('joinBtn').addEventListener('click', joinRoom);

  $('nameInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      createRoom();
    }
  });

  $('codeInput').addEventListener('input', () => {
    const input = $('codeInput');
    input.value = formatCode(input.value);
  });
  $('codeInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      joinRoom();
    }
  });

  $('installNav').addEventListener('click', openInstall);
  $('privacyLink').addEventListener('click', openPrivacy);
  $('menuBtn').addEventListener('click', openSettings);
  $('settingsBtn').addEventListener('click', openSettings);

  $('roomCodeBtn').addEventListener('click', copyCode);
  $('bigCode').addEventListener('click', copyCode);
  $('settingsCopy').addEventListener('click', copyCode);
  $('copyBtn').addEventListener('click', copyInvite);
  $('shareBtn').addEventListener('click', shareInvite);
  $('inviteBtn').addEventListener('click', shareInvite);
  $('settingsShare').addEventListener('click', () => {
    closeDialog('settingsDialog');
    shareInvite();
  });

  $('pauseBtn').addEventListener('click', togglePause);
  $('settingsPause').addEventListener('click', togglePause);
  $('wakeToggle').addEventListener('change', (event) => setWakePreference(event.target.checked));
  $('settingsMap').addEventListener('click', switchMapProvider);

  $('settingsInstall').addEventListener('click', () => {
    closeDialog('settingsDialog');
    openInstall();
  });
  $('settingsPrivacy').addEventListener('click', () => {
    closeDialog('settingsDialog');
    openPrivacy();
  });
  $('installAction').addEventListener('click', runInstallPrompt);

  $('leaveBtn').addEventListener('click', handleLeave);

  $('dockHandle').addEventListener('click', () => {
    if (!getPartner()) return;
    state.compact = !state.compact;
    $('dock').classList.toggle('is-compact', state.compact);
    $('dockHandle').setAttribute('aria-expanded', String(!state.compact));
    updateDockHeight();
  });

  $('zoomInBtn').addEventListener('click', () => state.map?.zoomIn());
  $('zoomOutBtn').addEventListener('click', () => state.map?.zoomOut());
  $('fitBtn').addEventListener('click', () => fitBoth(true));

  $('geoHelpBtn').addEventListener('click', openGeoHelp);
  $('infoBody').addEventListener('click', (event) => {
    if (event.target.closest('[data-retry-geo]')) {
      closeDialog('infoDialog');
      retryGeo();
    }
  });

  $('mapNotice').querySelector('[data-dismiss]').addEventListener('click', () => {
    state.noticeDismissed = true;
    $('mapNotice').hidden = true;
  });

  for (const button of document.querySelectorAll('[data-close]')) {
    button.addEventListener('click', () => closeDialog(button.dataset.close));
  }

  for (const dialog of document.querySelectorAll('dialog.sheet')) {
    dialog.addEventListener('click', (event) => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      const outside =
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom;
      if (outside) dialog.close();
    });
  }

  window.addEventListener('resize', () => {
    state.map?.invalidateSize();
    updateDockHeight();
  }, { passive: true });

  window.addEventListener('orientationchange', () => {
    window.setTimeout(() => {
      state.map?.invalidateSize();
      updateDockHeight();
    }, 250);
  });
}

/* Kick things off. Scripts use defer, but keep this safe for tests. */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
