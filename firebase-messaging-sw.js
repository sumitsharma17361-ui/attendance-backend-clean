// ============================================================
// firebase-messaging-sw.js — Service Worker for Push Notifications & PWA
// BM Group ERP · v6.1 (Offline Caching + Deep Linking + Custom App Icon)
// Handles: attendance, notes, docs, fees, library, exams,
//          results, announcements, device resets, undo alerts,
//          emergency broadcasts, passcode publishes,
//          chat marks, subscriptions, achievements, admin bulk
// ============================================================

importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyBBD3V20eKCo8S9Smi6LY--klDj-pBVXYQ",
  authDomain: "bm-attedance.firebaseapp.com",
  projectId: "bm-attedance",
  storageBucket: "bm-attedance.firebasestorage.app",
  messagingSenderId: "760728083416",
  appId: "1:760728083416:web:0ff3d79ac1b5d89ab5f0ad"
});

const messaging = firebase.messaging();

// ============================================================
//  ★ NEW: PWA OFFLINE CACHING SETUP
// ============================================================
const CACHE_NAME = 'bm-erp-cache-v6.1';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// ============================================================
//  ICON / BADGE
// ============================================================
// Large Icon (App Icon) — Colored (Updated to local file)
const ICON_URL = './icon-192.png';

// Badge (Status bar) — MUST be pure white with transparent background
const BADGE_URL = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
     <text x="50" y="68" font-size="46" text-anchor="middle" fill="white"
           font-family="Arial,sans-serif" font-weight="900">BM</text>
   </svg>`
);

const BRAND_COLOR = '#2563eb';

// ============================================================
//  NOTIFICATION TITLE / TAG / ACTIONS PER TYPE
// ============================================================
const NOTIFICATION_CONFIG = {
  attendance_marked: { emoji: '✅', tag: 'bm-attendance', requireInteraction: false, vibrate: [200, 100, 200], actions: [{ action: 'view', title: '📊 View' }] },
  attendance_reminder: { emoji: '⏰', tag: 'bm-reminder', requireInteraction: true, vibrate: [300, 200, 300, 200, 300], actions: [{ action: 'mark', title: '✅ Mark Now' }, { action: 'dismiss', title: 'Later' }] },
  mark: { emoji: '✅', tag: 'bm-mark', requireInteraction: false, vibrate: [200, 100, 200], actions: [{ action: 'view', title: '✅ View' }] },
  mark_lecture: { emoji: '✅', tag: 'bm-mark', requireInteraction: false, vibrate: [200, 100, 200], actions: [{ action: 'view', title: '✅ View' }] },
  chat_mark: { emoji: '✅', tag: 'bm-chat-mark', requireInteraction: false, vibrate: [200, 100, 200], actions: [{ action: 'view', title: '✅ View' }] },
  admin_manual_mark: { emoji: '✅', tag: 'bm-admin-mark', requireInteraction: false, vibrate: [200, 100, 200], actions: [{ action: 'view', title: '✅ View' }] },
  admin_bulk_mark: { emoji: '✅', tag: 'bm-admin-bulk', requireInteraction: false, vibrate: [200, 100, 200], actions: [{ action: 'view', title: '✅ View' }] },
  bulk_mark: { emoji: '✅', tag: 'bm-bulk', requireInteraction: false, vibrate: [200, 100, 200], actions: [{ action: 'view', title: '✅ View' }] },
  fac_bulk: { emoji: '✅', tag: 'bm-fac-bulk', requireInteraction: false, vibrate: [200, 100, 200], actions: [{ action: 'view', title: '✅ View' }] },
  faculty_mark: { emoji: '✅', tag: 'bm-faculty-mark', requireInteraction: false, vibrate: [200, 100, 200], actions: [{ action: 'view', title: '✅ View' }] },
  faculty_bulk_mark: { emoji: '✅', tag: 'bm-faculty-bulk', requireInteraction: false, vibrate: [200, 100, 200], actions: [{ action: 'view', title: '✅ View' }] },
  attendance_deleted: { emoji: '⚠️', tag: 'bm-att-deleted', requireInteraction: true, vibrate: [400, 200, 400], actions: [{ action: 'view', title: '⚠️ View' }] },
  attendance_updated: { emoji: '⚠️', tag: 'bm-att-updated', requireInteraction: false, vibrate: [200, 100, 200], actions: [{ action: 'view', title: '📊 View' }] },
  request_approved: { emoji: '✅', tag: 'bm-request', requireInteraction: false, vibrate: [200, 100, 200], actions: [{ action: 'view', title: '📋 View' }] },
  request_rejected: { emoji: '❌', tag: 'bm-request', requireInteraction: false, vibrate: [300, 200, 300], actions: [{ action: 'view', title: '📋 View' }] },
  request_undone: { emoji: '↩️', tag: 'bm-request-undo', requireInteraction: true, vibrate: [200, 100, 200, 100, 200], actions: [{ action: 'view', title: '📋 View' }] },
  attendance_request: { emoji: '📩', tag: 'bm-att-req', requireInteraction: true, vibrate: [200, 100, 200], actions: [{ action: 'view', title: '✅ Review' }] },
  request_pending_student: { emoji: '📋', tag: 'bm-pending-student', requireInteraction: false, vibrate: [100, 50, 100], actions: [{ action: 'view', title: '📋 View' }] },
  passcode: { emoji: '🔐', tag: 'bm-passcode', requireInteraction: true, vibrate: [400, 200, 400, 200, 400], actions: [{ action: 'mark', title: '✅ Mark Now' }] },
  notice: { emoji: '📢', tag: 'bm-notice', requireInteraction: true, vibrate: [200, 100, 200], actions: [{ action: 'view', title: '📖 Read' }] },
  faculty_announcement: { emoji: '👨‍🏫', tag: 'bm-announcement', requireInteraction: false, vibrate: [200, 100, 200], actions: [{ action: 'view', title: '📖 Read' }] },
  emergency: { emoji: '🚨', tag: 'bm-emergency', requireInteraction: true, vibrate: [1000, 500, 1000, 500, 1000, 500, 1000], actions: [{ action: 'view', title: '🚨 Open' }], urgent: true },
  system_alert: { emoji: '🚨', tag: 'bm-system', requireInteraction: true, vibrate: [1000, 500, 1000], actions: [{ action: 'view', title: '🚨 Open' }], urgent: true },
  holiday_added: { emoji: '🎉', tag: 'bm-holiday', requireInteraction: false, vibrate: [100, 50, 100], actions: [{ action: 'view', title: '📅 Calendar' }] },
  holiday_cancelled: { emoji: '⚠️', tag: 'bm-holiday', requireInteraction: true, vibrate: [300, 200, 300], actions: [{ action: 'view', title: '📅 Calendar' }] },
  new_device_login: { emoji: '🔐', tag: 'bm-security', requireInteraction: true, vibrate: [500, 200, 500, 200, 500], actions: [{ action: 'view', title: '⚠️ Check' }] },
  device_reset: { emoji: '📱', tag: 'bm-device', requireInteraction: false, vibrate: [200, 100, 200], actions: [{ action: 'view', title: '🔐 Login' }] },
  password_reset: { emoji: '🔑', tag: 'bm-password', requireInteraction: true, vibrate: [200, 100, 200], actions: [{ action: 'view', title: '🔐 Login' }] },
  account_request: { emoji: '🔔', tag: 'bm-account', requireInteraction: true, vibrate: [200, 100, 200], actions: [{ action: 'view', title: '🔍 Review' }] },
  account_approved: { emoji: '✅', tag: 'bm-account', requireInteraction: false, vibrate: [200, 100, 200], actions: [{ action: 'view', title: '🔍 View' }] },
  account_rejected: { emoji: '❌', tag: 'bm-account', requireInteraction: false, vibrate: [300, 200, 300], actions: [{ action: 'view', title: '🔍 View' }] },
  registration: { emoji: '📝', tag: 'bm-registration', requireInteraction: true, vibrate: [200, 100, 200], actions: [{ action: 'view', title: '👤 Review' }] },
  note_added: { emoji: '📚', tag: 'bm-notes', requireInteraction: false, vibrate: [150, 100, 150], actions: [{ action: 'view', title: '📖 Open' }, { action: 'download', title: '📥 Download' }] },
  doc_request: { emoji: '📤', tag: 'bm-doc-request', requireInteraction: true, vibrate: [200, 100, 200], actions: [{ action: 'view', title: '📝 Review' }] },
  doc_approved: { emoji: '✅', tag: 'bm-doc', requireInteraction: false, vibrate: [200, 100, 200], actions: [{ action: 'view', title: '📚 View Notes' }] },
  doc_rejected: { emoji: '❌', tag: 'bm-doc', requireInteraction: false, vibrate: [300, 200, 300], actions: [{ action: 'view', title: '📚 View' }] },
  fee_added: { emoji: '💰', tag: 'bm-fee', requireInteraction: true, vibrate: [300, 150, 300], actions: [{ action: 'view', title: '💰 Pay Now' }, { action: 'dismiss', title: 'Later' }] },
  fee_paid: { emoji: '✅', tag: 'bm-fee', requireInteraction: false, vibrate: [200, 100, 200], actions: [{ action: 'view', title: '✅ View Receipt' }] },
  fee_reminder: { emoji: '💰', tag: 'bm-fee-reminder', requireInteraction: true, vibrate: [400, 200, 400], actions: [{ action: 'view', title: '💰 Pay Now' }, { action: 'dismiss', title: 'Later' }] },
  book_issued: { emoji: '📚', tag: 'bm-library', requireInteraction: false, vibrate: [150, 100, 150], actions: [{ action: 'view', title: '📖 View' }] },
  library_due: { emoji: '📚', tag: 'bm-library-due', requireInteraction: true, vibrate: [300, 150, 300], actions: [{ action: 'view', title: '📚 Return' }] },
  result_published: { emoji: '📊', tag: 'bm-result', requireInteraction: false, vibrate: [200, 100, 200], actions: [{ action: 'view', title: '📊 View Result' }] },
  new_exam: { emoji: '📝', tag: 'bm-exam', requireInteraction: true, vibrate: [200, 100, 200], actions: [{ action: 'view', title: '📅 View' }] },
  exam_reminder: { emoji: '📝', tag: 'bm-exam-reminder', requireInteraction: true, vibrate: [300, 200, 300, 200, 300], actions: [{ action: 'view', title: '📅 View' }] },
  new_assignment: { emoji: '📝', tag: 'bm-assignment', requireInteraction: false, vibrate: [200, 100, 200], actions: [{ action: 'view', title: '📝 View' }] },
  assignment_deadline: { emoji: '📝', tag: 'bm-assignment-due', requireInteraction: true, vibrate: [300, 150, 300], actions: [{ action: 'view', title: '📝 Submit' }] },
  leave: { emoji: '📋', tag: 'bm-leave', requireInteraction: true, vibrate: [200, 100, 200], actions: [{ action: 'view', title: '📋 Review' }] },
  leave_review: { emoji: '📋', tag: 'bm-leave', requireInteraction: false, vibrate: [200, 100, 200], actions: [{ action: 'view', title: '📋 View' }] },
  pending_admin_reminder: { emoji: '⏰', tag: 'bm-pending-admin', requireInteraction: false, vibrate: [200, 100, 200], actions: [{ action: 'view', title: '📋 Review' }] },
  subject_assigned: { emoji: '📚', tag: 'bm-subject', requireInteraction: false, vibrate: [150, 100, 150], actions: [{ action: 'view', title: '📚 View' }] },
  db_op: { emoji: '✅', tag: 'bm-db-op', requireInteraction: false, vibrate: [100, 50, 100], actions: [{ action: 'view', title: '✅ View' }] },
  achievement: { emoji: '🏆', tag: 'bm-achievement', requireInteraction: false, vibrate: [200, 100, 200, 100, 200], actions: [{ action: 'view', title: '🏆 View' }] },
  milestone: { emoji: '🎉', tag: 'bm-milestone', requireInteraction: false, vibrate: [200, 100, 200, 100, 200], actions: [{ action: 'view', title: '🎉 Celebrate' }] },
  streak: { emoji: '🔥', tag: 'bm-streak', requireInteraction: false, vibrate: [200, 100, 200], actions: [{ action: 'view', title: '🔥 View' }] },
  subscription_activated: { emoji: '🎉', tag: 'bm-subscription', requireInteraction: false, vibrate: [200, 100, 200, 100, 200], actions: [{ action: 'view', title: '⭐ View Plan' }] },
  subscription_granted: { emoji: '🎉', tag: 'bm-subscription', requireInteraction: false, vibrate: [200, 100, 200, 100, 200], actions: [{ action: 'view', title: '⭐ View Plan' }] },
  subscription_cancelled: { emoji: '⚠️', tag: 'bm-subscription', requireInteraction: true, vibrate: [300, 200, 300], actions: [{ action: 'view', title: '⚠️ Check' }] },
  shortage_alert: { emoji: '⚠️', tag: 'bm-shortage', requireInteraction: true, vibrate: [400, 200, 400], actions: [{ action: 'view', title: '📊 View' }] },
  shortage_warning: { emoji: '⚡', tag: 'bm-shortage', requireInteraction: false, vibrate: [200, 100, 200], actions: [{ action: 'view', title: '📊 View' }] },
  daily_summary: { emoji: '📊', tag: 'bm-daily', requireInteraction: false, vibrate: [100, 50, 100], actions: [{ action: 'view', title: '📊 View' }] },
  weekly_report: { emoji: '📈', tag: 'bm-weekly', requireInteraction: false, vibrate: [100, 50, 100], actions: [{ action: 'view', title: '📈 View' }] },
  monthly_progress: { emoji: '📊', tag: 'bm-monthly', requireInteraction: false, vibrate: [100, 50, 100], actions: [{ action: 'view', title: '📊 View' }] },
  birthday: { emoji: '🎂', tag: 'bm-birthday', requireInteraction: false, vibrate: [150, 100, 150, 100, 150], actions: [{ action: 'view', title: '🎂 Open' }] },
  location_failed: { emoji: '📍', tag: 'bm-location', requireInteraction: true, vibrate: [300, 200, 300], actions: [{ action: 'view', title: '📍 Retry' }] },
  class_reminder_student: { emoji: '⏰', tag: 'bm-class-reminder', requireInteraction: false, vibrate: [200, 100, 200], actions: [{ action: 'view', title: '📅 View' }] },
  class_reminder_faculty: { emoji: '⏰', tag: 'bm-class-reminder', requireInteraction: true, vibrate: [300, 200, 300], actions: [{ action: 'view', title: '📅 View' }] },
  download: { emoji: '📥', tag: 'bm-download', requireInteraction: false, vibrate: [100, 50, 100], actions: [] },
  fcm_foreground: { emoji: '🔔', tag: 'bm-foreground', requireInteraction: false, vibrate: [100, 50, 100], actions: [] },
  test: { emoji: '🧪', tag: 'bm-test', requireInteraction: false, vibrate: [200, 100, 200], actions: [] }
};

// ============================================================
//  UTILITIES
// ============================================================
function getNotificationConfig(type) {
  return NOTIFICATION_CONFIG[type] || { emoji: '🔔', tag: 'bm-notification', requireInteraction: false, vibrate: [200, 100, 200], actions: [] };
}

function buildTitle(emoji, rawTitle) {
  const t = (rawTitle || 'BM Attendance').trim();
  if (/^[\u2700-\u27BF]|[\uD800-\uDBFF][\uDC00-\uDFFF]|[\u2600-\u26FF]/.test(t)) return t;
  return emoji ? `${emoji} ${t}` : t;
}

function getNotificationTargetUrl(data) {
  const type = data?.type || '';
  const baseUrl = data?.url || data?.link || '/';
  if (data.url && data.url !== '/') return data.url;

  switch (type) {
    case 'passcode': case 'attendance_reminder': case 'attendance_marked': case 'mark': case 'mark_lecture': case 'chat_mark': return '/?tab=mark';
    case 'note_added': case 'doc_approved': case 'doc_rejected': return '/?tab=notes';
    case 'fee_added': case 'fee_paid': case 'fee_reminder': return '/?tab=fees';
    case 'book_issued': case 'library_due': return '/?tab=library';
    case 'result_published': return '/?tab=results';
    case 'new_exam': case 'exam_reminder': return '/?tab=exams';
    case 'new_assignment': case 'assignment_deadline': return '/?tab=assignments';
    case 'faculty_announcement': return '/?tab=announcements';
    case 'request_approved': case 'request_rejected': case 'request_undone': case 'attendance_request': case 'request_pending_student': return '/?tab=requests';
    case 'holiday_added': case 'holiday_cancelled': return '/?tab=calendar';
    case 'device_reset': case 'new_device_login': case 'password_reset': return '/?tab=login';
    case 'emergency': case 'system_alert': return '/?tab=alerts';
    case 'registration': case 'account_request': case 'account_approved': case 'account_rejected': case 'doc_request': case 'leave': case 'leave_review': case 'pending_admin_reminder': return '/?tab=admin';
    case 'achievement': case 'milestone': case 'streak': return '/?tab=achievements';
    case 'subscription_activated': case 'subscription_granted': case 'subscription_cancelled': return '/?tab=subscription';
    case 'class_reminder_student': case 'class_reminder_faculty': return '/?tab=timetable';
    case 'shortage_alert': case 'shortage_warning': case 'daily_summary': case 'weekly_report': case 'monthly_progress': return '/?tab=mark';
    default: return baseUrl;
  }
}

// ============================================================
//  BACKGROUND MESSAGE HANDLER
// ============================================================
messaging.onBackgroundMessage((payload) => {
  console.log('[SW] Background message received:', payload);

  const data = payload.data || {};
  const rawTitle = data.title || payload.notification?.title || 'BM Attendance';
  const rawBody = data.body || payload.notification?.body || 'You have a new notification';
  const type = String(data.type || 'generic');
  const cfg = getNotificationConfig(type);

  if (payload.notification && !data.title && !data.body) {
    console.log('[SW] Auto-displayed by FCM, skipping manual showNotification');
    return;
  }

  const options = {
    body: rawBody,
    icon: ICON_URL,
    badge: BADGE_URL,
    image: data.image || undefined,
    color: BRAND_COLOR,
    vibrate: cfg.vibrate || [200, 100, 200],
    requireInteraction: !!cfg.requireInteraction,
    tag: cfg.tag || (data.tag || 'bm-notification'),
    renotify: true,
    silent: false,
    timestamp: Date.now(),
    data: { ...data, type, url: data.url || data.link || getNotificationTargetUrl(data), notificationId: data.notificationId || `ntf_${Date.now()}`, receivedAt: Date.now() },
    actions: (cfg.actions && cfg.actions.length > 0) ? cfg.actions : undefined
  };

  if (cfg.urgent) {
    options.requireInteraction = true;
    options.silent = false;
  }

  const title = buildTitle(cfg.emoji, rawTitle);
  self.registration.showNotification(title, options);

  try {
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        client.postMessage({ __bmNotification: true, payload: { title, body: rawBody, data: options.data } }).catch(() => {});
      }
    }).catch(() => {});
  } catch (e) { /* ignore */ }
});

// ============================================================
//  NOTIFICATION CLICK HANDLER
// ============================================================
self.addEventListener('notificationclick', (event) => {
  console.log('[SW] Notification clicked:', event.notification);
  const notif = event.notification;
  const notifData = notif.data || {};
  const action = event.action || 'default';
  const type = notifData.type || '';

  event.notification.close();

  if (action === 'dismiss') {
    event.waitUntil(Promise.resolve());
    return;
  }

  let absoluteTarget;
  try {
    absoluteTarget = new URL(notifData.url || getNotificationTargetUrl(notifData), self.location.origin).href;
  } catch (e) {
    absoluteTarget = self.location.origin + '/';
  }

  const finalTarget = (action === 'download' && notifData.downloadUrl) ? notifData.downloadUrl : absoluteTarget;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        try {
          const clientUrl = new URL(client.url);
          if (clientUrl.origin === self.location.origin) {
            client.postMessage({ __bmNotificationClick: true, data: notifData, action, type, targetUrl: finalTarget });

            if (action === 'download') {
              if (clients.openWindow) return clients.openWindow(finalTarget);
            } else if ('focus' in client) {
              return client.focus().then((focusedClient) => {
                if (focusedClient && 'navigate' in focusedClient && focusedClient.url !== finalTarget) {
                  return focusedClient.navigate(finalTarget);
                }
                return focusedClient;
              });
            }
            return client;
          }
        } catch (e) { /* ignore bad URL */ }
      }
      if (clients.openWindow) return clients.openWindow(finalTarget);
    }).catch((err) => {
      console.error('[SW] notificationclick error:', err);
      if (clients.openWindow) return clients.openWindow(finalTarget);
    })
  );
});

// ============================================================
//  NOTIFICATION CLOSE HANDLER
// ============================================================
self.addEventListener('notificationclose', (event) => {
  const data = event.notification?.data || {};
  console.log('[SW] Notification closed by user:', data.type || 'unknown');
});

// ============================================================
//  RAW PUSH FALLBACK
// ============================================================
self.addEventListener('push', (event) => {
  console.log('[SW] Raw push event received');
  try {
    let payload = {};
    if (event.data) {
      try { payload = event.data.json(); } catch (e) { payload = { notification: { body: event.data.text() } }; }
    }
    if (!payload || !payload.data || payload.__bmHandled) return;

    const data = payload.data || {};
    const cfg = getNotificationConfig(data.type || 'generic');
    const title = buildTitle(cfg.emoji, data.title || payload.notification?.title || 'BM Attendance');
    const body = data.body || payload.notification?.body || 'You have a new notification';

    event.waitUntil(
      self.registration.showNotification(title, {
        body, icon: ICON_URL, badge: BADGE_URL, color: BRAND_COLOR,
        vibrate: cfg.vibrate || [200, 100, 200], requireInteraction: !!cfg.requireInteraction,
        tag: cfg.tag || 'bm-notification', renotify: true,
        data: { ...data, type: data.type || 'generic', url: data.url || getNotificationTargetUrl(data) },
        actions: (cfg.actions && cfg.actions.length > 0) ? cfg.actions : undefined
      })
    );
  } catch (err) {
    console.error('[SW] Raw push error:', err);
  }
});

// ============================================================
//  MESSAGE HANDLER (from page)
// ============================================================
self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.__bmNotification || msg.__bmNotificationClick) return;
  if (msg.type === 'SKIP_WAITING') { self.skipWaiting(); return; }
  if (msg.type === 'TEST_NOTIFICATION') {
    const title = msg.title || '🧪 Test Notification';
    const body = msg.body || 'This is a test notification.';
    self.registration.showNotification(title, {
      body, icon: ICON_URL, badge: BADGE_URL, color: BRAND_COLOR,
      vibrate: [200, 100, 200], tag: 'bm-test', renotify: true, data: { type: 'test', url: '/' }
    }).catch(() => {});
    return;
  }
  if (msg.type === 'CLEAR_ALL_NOTIFICATIONS') {
    self.registration.getNotifications().then((notifs) => { notifs.forEach(n => n.close()); }).catch(() => {});
    return;
  }
});

// ============================================================
//  ★ NEW: INSTALL & ACTIVATE (For PWA Caching & Notifications)
// ============================================================
self.addEventListener('install', (event) => {
  console.log('[SW] Installing v6.1...');
  self.skipWaiting();
  // Pre-cache core files
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Pre-caching core assets');
      return cache.addAll(ASSETS_TO_CACHE);
    }).catch(err => console.warn('[SW] Cache addAll failed:', err))
  );
});

self.addEventListener('activate', (event) => {
  console.log('[SW] Activated v6.1');
  event.waitUntil(
    (async () => {
      try { await self.clients.claim(); } catch (e) {}

      // Clean up old caches
      const cacheKeys = await caches.keys();
      await Promise.all(
        cacheKeys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('[SW] Deleting old cache:', key);
            return caches.delete(key);
          }
        })
      );

      // Clean up stale notifications
      try {
        const notifs = await self.registration.getNotifications();
        const now = Date.now();
        notifs.forEach((n) => {
          const receivedAt = n.data?.receivedAt || 0;
          if (receivedAt && (now - receivedAt) > 7 * 24 * 60 * 60 * 1000) n.close();
        });
      } catch (e) {}
    })()
  );
});

// ============================================================
//  ★ NEW: FETCH HANDLER (PWA Offline Caching)
// ============================================================
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // 1. Skip non-GET requests
  if (req.method !== 'GET') return;

  // 2. Skip external domains & API calls
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/api/')) return;

  // 3. Navigation Requests (HTML pages)
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then((response) => {
        const resClone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
        return response;
      }).catch(() => {
        return caches.match(req).then((cachedResponse) => {
          if (cachedResponse) return cachedResponse;
          
          // Offline fallback page
          return new Response(
            `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
             <title>Offline — BM ERP</title>
             <style>
               body{font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;
               min-height:100vh;margin:0;background:#f1f5f9;color:#0f172a;text-align:center;padding:24px}
               .card{background:#fff;padding:40px 28px;border-radius:20px;box-shadow:0 12px 32px rgba(15,23,42,.10);max-width:380px}
               h1{margin:0 0 8px;color:#2563eb;font-size:22px}
               p{color:#64748b;font-size:14px;line-height:1.6;margin:0 0 20px}
               button{background:linear-gradient(135deg,#2563eb,#1d4ed8);color:#fff;border:none;
               padding:12px 24px;border-radius:10px;font-size:14px;font-weight:700;cursor:pointer;
               transition:transform .15s ease}
               button:active{transform:scale(0.96)}
             </style></head>
             <body><div class="card">
               <h1>📡 You're Offline</h1>
               <p>BM Group ERP needs an internet connection to fetch live data.<br>Please check your connection and try again.</p>
               <button onclick="location.reload()">🔄 Retry</button>
             </div></body></html>`,
            { headers: { 'Content-Type': 'text/html;charset=utf-8' } }
          );
        });
      })
    );
    return;
  }

  // 4. Static Assets (Cache First, fallback to Network)
  event.respondWith(
    caches.match(req).then((cachedResponse) => {
      if (cachedResponse) {
        // Stale-While-Revalidate
        fetch(req).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            caches.open(CACHE_NAME).then((cache) => cache.put(req, networkResponse));
          }
        }).catch(() => {});
        return cachedResponse;
      }
      
      return fetch(req).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const resClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
        }
        return networkResponse;
      }).catch(() => {
        return new Response('', { status: 408, statusText: 'Offline' });
      });
    })
  );
});

// ============================================================
//  LOG
// ============================================================
console.log('%c[SW] BM Group ERP — Service Worker v6.1 ready ✅ (PWA + Push)', 'color:#10b981;font-weight:900;font-size:14px;');
