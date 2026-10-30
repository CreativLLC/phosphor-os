// Service worker. Its main job: make Phosphor-OS installable as a real home-screen app
// (Firefox on Android needs one). It caches nothing, so the app always talks to the PC directly.
// When the PC can't be reached, page loads show a small retro "can't reach the PC" screen.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

const OFFLINE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Phosphor-OS: offline</title><style>
html,body{margin:0;height:100%;background:#0b0700;color:#ffb000;font:20px/1.4 ui-monospace,Consolas,monospace}
main{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:14px;padding:16px;text-align:center}
b{background:#ffb000;color:#0b0700;padding:2px 10px;letter-spacing:3px}button{font:inherit;color:#0b0700;background:#ffb000;border:0;padding:10px 22px;letter-spacing:2px}
</style></head><body><main><b>NO SIGNAL</b><div>CAN'T REACH THE PC.</div><div style="color:#a87400">Is the PC on and awake, and is Tailscale on here?</div>
<button onclick="location.reload()">RETRY</button></main></body></html>`;

self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return; // everything else: normal network
  e.respondWith(
    fetch(e.request).catch(() => new Response(OFFLINE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })),
  );
});

// ALERTS (server/push.ts, web/src/alerts.ts). A push wakes this worker even when the app is closed. The message is
// encrypted for this browser only (RFC 8291) and holds no chat text: a title, the tab's name and the tab id.
// One notification per tab (tag): a newer one replaces the older. src 'page' = the open page showed it itself
// (it was in the background); the push for the same moment then replaces it without a second buzz.
// k 'comments' (COMMENTS, server/comments.ts): new YouTube comments; one notification, a tap opens COMMENTS.
const BUZZ = { needs: [300, 120, 300, 120, 300], done: [180, 90, 180], test: [180, 90, 180], comments: [120, 80, 120] };
const SAME_MS = 10000; // page and push alerts for one event land within a few seconds; real repeats are 20 s apart

function showAlert(d) {
  const kind = d.k === 'needs' || d.k === 'done' || d.k === 'comments' ? d.k : 'test';
  const tab = typeof d.tab === 'string' ? d.tab.slice(0, 64) : '';
  const tag = kind === 'comments' ? 'phosphor-comments' : tab ? 'phosphor-' + tab : 'phosphor-test';
  const title = typeof d.title === 'string' && d.title ? d.title.slice(0, 60) : 'PHOSPHOR-OS';
  const body = typeof d.body === 'string' ? d.body.slice(0, 80) : '';
  return self.registration
    .getNotifications({ tag })
    .catch(() => [])
    .then((list) => {
      const twin = list.some((n) => n.data && n.data.src === 'page' && n.data.k === kind && Date.now() - (n.data.at || 0) < SAME_MS);
      const opts = { body, tag, icon: '/icons/icon-192.png', data: { tab, k: kind, at: Date.now(), src: 'push' } };
      if (twin) opts.silent = true;
      else {
        opts.renotify = true; // buzz again even if an older alert for this tab is still there
        opts.vibrate = BUZZ[kind];
      }
      return self.registration.showNotification(title, opts);
    });
}

self.addEventListener('push', (e) => {
  let d = {};
  try {
    d = (e.data && e.data.json()) || {};
  } catch (err) {
    d = {};
  }
  e.waitUntil(showAlert(d));
});

// Tap on an alert: bring an open app window to the front and switch it to that tab (or COMMENTS), or open the app on it.
function openApp(tab, comments) {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    const w = wins.find((c) => c.focused) || wins.find((c) => c.visibilityState === 'visible') || wins[0];
    if (!w) return self.clients.openWindow(comments ? '/?comments' : tab ? '/?tab=' + encodeURIComponent(tab) : '/');
    return w
      .focus()
      .catch(() => w)
      .then(() => {
        if (comments) w.postMessage({ t: 'phosphor-open-comments' });
        else if (tab) w.postMessage({ t: 'phosphor-open-tab', tab });
      });
  });
}

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const d = e.notification.data || {};
  e.waitUntil(openApp(d.tab || '', d.k === 'comments'));
});

// The browser renewed this device's push address: tell the server (same login cookie), keeping name and settings.
self.addEventListener('pushsubscriptionchange', (e) => {
  const old = e.oldSubscription;
  const key = old && old.options && old.options.applicationServerKey;
  const next = e.newSubscription ? Promise.resolve(e.newSubscription) : key ? self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }) : Promise.resolve(null);
  e.waitUntil(
    next
      .then((sub) =>
        sub
          ? fetch('/api/push/subscribe', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ subscription: sub.toJSON(), oldEndpoint: old ? old.endpoint : undefined }),
            })
          : null,
      )
      .catch(() => {}),
  );
});
