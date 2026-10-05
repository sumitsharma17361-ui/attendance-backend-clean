// firebase-messaging-sw.js — Service Worker for Push Notifications
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

messaging.onBackgroundMessage((payload) => {
  console.log('[SW] Background message:', payload);
  const title = payload.notification?.title || 'BM Attendance';
  const options = {
    body: payload.notification?.body || 'You have a new notification',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    vibrate: [200, 100, 200],
    data: payload.data || {},
    requireInteraction: false
  };
  self.registration.showNotification(title, options);
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow('/');
    })
  );
});
