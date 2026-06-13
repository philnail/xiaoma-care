// 小马护理 · Service Worker v4
// 锁屏提醒 — SW 先于主页面注册，独立运行定时器

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));

let checkTimer = null;
let config = null;
let scheduledTimers = [];

const today = () => {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
};
const fmtHM = d => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');

// ── IndexedDB helpers ──
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('XiaomaCare', 1);
    req.onupgradeneeded = () => { req.result.createObjectStore('config'); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function loadConfig() {
  try {
    const db = await openDB();
    return new Promise(resolve => {
      const tx = db.transaction('config', 'readonly');
      const req = tx.objectStore('config').get('current');
      req.onsuccess = () => { db.close(); resolve(req.result || null); };
      req.onerror = () => { db.close(); resolve(null); };
    });
  } catch (e) { return null; }
}

async function saveConfig(cfg) {
  try {
    const db = await openDB();
    return new Promise(resolve => {
      const tx = db.transaction('config', 'readwrite');
      tx.objectStore('config').put(cfg, 'current');
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); resolve(); };
    });
  } catch (e) { /* ignore */ }
}

// ── Notification helpers ──
const lastFired = {};

function show(title, body, tag, vibe) {
  const now = Date.now();
  if (lastFired[tag] && (now - lastFired[tag]) < 30000) return;
  lastFired[tag] = now;
  return self.registration.showNotification(title, {
    body, tag,
    icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🌿</text></svg>',
    badge: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🌿</text></svg>',
    requireInteraction: true, silent: false,
    vibrate: vibe || [200, 100, 200, 100, 400], renotify: true,
  });
}

// ── Targeted scheduling ──
function clearAllTimers() {
  scheduledTimers.forEach(t => clearTimeout(t));
  scheduledTimers = [];
}

function scheduleTargeted(timeStr, fn) {
  if (!timeStr) return;
  const [h, m] = timeStr.split(':').map(Number);
  const now = new Date();
  const target = new Date(now);
  target.setHours(h, m, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  const delay = target - now;
  if (delay > 0 && delay < 86400000) {
    const tid = setTimeout(() => { fn(); scheduleTargeted(timeStr, fn); }, delay);
    scheduledTimers.push(tid);
  }
}

// ── Check logic ──
function check() {
  if (!config) { checkTimer = setTimeout(check, 10000); return; }
  const now = new Date();
  const current = fmtHM(now);
  const td = today();

  console.log('SW check @', current, '| meds:', (config.meds||[]).map(m=>m.name+':'+m.time+'('+(m.done?'done':'pending')+')').join(', '));

  (config.meds || []).forEach(m => {
    if (m.time && m.time === current && !m.done) {
      show('💊 用药提醒', '该服用 ' + m.name + ' 了', 'med-' + m.name + '-' + td, [200, 100, 200, 100, 400]);
    }
  });

  if (config.scoreRemindTime === current) {
    const count = config._scoreRemindCount || 0;
    const scoreTag = 'score-' + td;
    if (count < 2 && (!lastFired[scoreTag] || Date.now() - lastFired[scoreTag] >= 60000)) {
      show('📊 状态记录', '该记录今天的状态评分了（1-10分）', scoreTag, [200, 100, 200]);
      config._scoreRemindCount = count + 1;
      saveConfig(config);
    }
  }

  const visit = config.visitInfo;
  if (visit) {
    const vDate = new Date(visit.date);
    const daysLeft = Math.ceil((vDate - now) / 86400000);
    if (daysLeft === visit.remindDays) {
      show('🏥 复诊提醒', '还有' + daysLeft + '天复诊：' + (visit.doctor || '') + ' (' + visit.date + ')', 'visit-' + visit.date, [200, 100, 200, 100, 400]);
    }
  }

  const lastReset = config._lastResetDay || '';
  if (lastReset !== td) {
    (config.meds || []).forEach(m => { m.done = false; });
    config._lastResetDay = td;
    config._scoreRemindCount = 0;
    saveConfig(config);
  }

  checkTimer = setTimeout(check, 10000);
}

function startCheck() {
  if (checkTimer) clearTimeout(checkTimer);
  clearAllTimers();
  if (config && config.meds) {
    config.meds.forEach(m => {
      if (m.time && !m.done) {
        scheduleTargeted(m.time, () => {
          show('💊 用药提醒(精准)', '该服用 ' + m.name + ' 了', 'med-targeted-' + m.name + '-' + today(), [200, 100, 200, 100, 400]);
        });
      }
    });
    if (config.scoreRemindTime) {
      scheduleTargeted(config.scoreRemindTime, () => {
        show('📊 状态记录(精准)', '该记录今天的状态评分了（1-10分）', 'score-targeted-' + today(), [200, 100, 200]);
      });
    }
  }
  check();
}

// ── Messages ──
self.addEventListener('message', async e => {
  if (e.data && e.data.type === 'config') {
    config = e.data.config;
    config._lastResetDay = config._lastResetDay || today();
    console.log('SW config received:', JSON.stringify(config.meds?.map(m=>m.name+':'+m.time)));
    await saveConfig(config);
    startCheck();
  }
  if (e.data && e.data.type === 'test') {
    if (config) {
      show('🧪 SW测试', 'Service Worker 正常工作！提醒功能已就绪。', 'sw-test-' + Date.now(), [200,100,200,100,400]);
    } else {
      show('🧪 SW测试（无配置）', 'SW 工作中，但还没收到用药配置。请去设置页保存。', 'sw-test-noconfig-' + Date.now(), [200,100,200]);
    }
  }
});

// ── Notification click → open app ──
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window' }).then(cls => {
      if (cls.length > 0) { cls[0].focus(); cls[0].navigate(cls[0].url); }
      else { clients.openWindow('/'); }
    })
  );
});

// ── Startup ──
(async () => {
  const saved = await loadConfig();
  if (saved) { config = saved; startCheck(); }
})();
