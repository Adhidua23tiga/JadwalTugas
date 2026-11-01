// Service worker sederhana.
// Fungsinya HANYA supaya notifikasi bisa tampil di HP (Chrome Android tidak
// mengizinkan "new Notification()" langsung, harus lewat service worker).
// Tidak ada cache, tidak ada push dari server.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// Saat notifikasi diketuk: buka / fokuskan kembali halaman dashboard
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((daftar) => {
      for (const c of daftar) {
        if ("focus" in c) return c.focus();
      }
      return self.clients.openWindow("./");
    })
  );
});
