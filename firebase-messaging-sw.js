// firebase-messaging-sw.js
importScripts('https://gstatic.com');
importScripts('https://gstatic.com');

// Продублируйте сюда тот же самый firebaseConfig из script.js
firebase.initializeApp({
  apiKey: "ВАШ_API_KEY",
  authDomain: "ВАШ_://firebaseapp.com",
  projectId: "ВАШ_PROJECT_ID",
  messagingSenderId: "ВАШ_SENDER_ID",
  appId: "ВАШ_APP_ID"
});

const messaging = firebase.messaging();

// Этот метод разбудит телефон из очереди Google, когда он включится
messaging.onBackgroundMessage((payload) => {
  self.registration.showNotification(payload.notification.title, {
    body: payload.notification.body
  });
});
