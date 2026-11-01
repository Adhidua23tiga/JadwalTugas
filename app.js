// =========================================================
// Dashboard Jadwal & Tugas — logika aplikasi
// Vanilla JavaScript + Firebase (Auth & Firestore), tanpa build step.
// =========================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signOut,
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  sendPasswordResetEmail,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getFirestore, collection, doc, addDoc, updateDoc, deleteDoc,
  onSnapshot, serverTimestamp, Timestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

// =========================================================
// 1) KONFIGURASI FIREBASE  ← GANTI BAGIAN INI SAJA
//    Ambil dari: Firebase Console > Project settings > Your apps > Web app.
//    Aman ditaruh di kode publik; keamanan data dijaga oleh firestore.rules.
// =========================================================
const firebaseConfig = {
  apiKey: "AIzaSyCMxhpHpngzkWc7jkjEOln3-UGkpp5gkmI",
  authDomain: "tugas-dc00b.firebaseapp.com",
  projectId: "tugas-dc00b",
  storageBucket: "tugas-dc00b.firebasestorage.app",
  messagingSenderId: "691971958757",
  appId: "1:691971958757:web:d2a6d093191b815c83f10c",
};
// =========================================================

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
auth.languageCode = "id"; // email dari Firebase memakai bahasa Indonesia
const db = getFirestore(app);

// ---------- Pengaturan pengingat ----------
const JAM = 60 * 60 * 1000;
const BATAS_24_JAM = 24 * JAM;
const BATAS_1_JAM = 1 * JAM;
const CEK_PENGINGAT_MS = 30 * 1000; // cek tiap 30 detik

// ---------- Helper DOM ----------
const $ = (id) => document.getElementById(id);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ---------- State ----------
let user = null;           // user yang sedang login
let tasks = [];            // semua tugas milik user
let tab = "pending";       // "pending" | "done"
let editingId = null;      // id tugas yang sedang diedit (null = tambah baru)
let unsubTasks = null;     // fungsi berhenti mendengarkan Firestore
let timerPengingat = null; // interval cek pengingat
let timerRender = null;    // interval segarkan tampilan
let authMode = "login";    // "login" | "register"
let swDidaftarkan = false;

// =========================================================
// Utilitas
// =========================================================

// Hindari XSS: semua teks dari user di-escape sebelum masuk innerHTML
function esc(teks) {
  return String(teks ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

// Timestamp Firestore -> milidetik. Kalau masih null (baru ditulis, menunggu server), pakai waktu sekarang.
function ms(ts) {
  if (ts && typeof ts.toMillis === "function") return ts.toMillis();
  return Date.now();
}

function formatTanggal(msVal) {
  return new Date(msVal).toLocaleString("id-ID", {
    weekday: "short", day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  }).replace(/\./g, ":"); // format Indonesia memakai titik untuk jam (14.30), kita ubah jadi 14:30
}

// Durasi singkat: "15 menit", "3 jam", "2 hari"
function durasi(selisihMs) {
  const menit = Math.max(1, Math.round(selisihMs / 60000));
  if (menit < 60) return `${menit} menit`;
  const jam = Math.round(menit / 60);
  if (jam < 24) return `${jam} jam`;
  return `${Math.round(jam / 24)} hari`;
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// Status deadline: lewat (merah), hari ini (oranye), atau normal
function statusDeadline(deadlineMs) {
  const selisih = deadlineMs - Date.now();
  if (selisih < 0) return { kelas: "overdue", label: `Terlambat ${durasi(-selisih)}` };
  if (sameDay(new Date(deadlineMs), new Date())) return { kelas: "today", label: `Hari ini — sisa ${durasi(selisih)}` };
  return { kelas: "", label: `Sisa ${durasi(selisih)}` };
}

// Nilai untuk <input type="datetime-local">
function keInputLokal(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

let toastTimer = null;
function toast(pesan) {
  const t = $("toast");
  t.textContent = pesan;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
}

const NAMA_PRIORITAS = { rendah: "Rendah", sedang: "Sedang", tinggi: "Tinggi" };

// Terjemahan pesan error Firebase ke bahasa Indonesia
function pesanError(err) {
  const peta = {
    "auth/invalid-email": "Format email tidak valid.",
    "auth/missing-password": "Kata sandi belum diisi.",
    "auth/weak-password": "Kata sandi terlalu lemah (minimal 6 karakter).",
    "auth/email-already-in-use": "Email ini sudah terdaftar. Coba masuk.",
    "auth/invalid-credential": "Email atau kata sandi salah.",
    "auth/user-not-found": "Email atau kata sandi salah.",
    "auth/wrong-password": "Email atau kata sandi salah.",
    "auth/too-many-requests": "Terlalu banyak percobaan. Coba lagi beberapa menit lagi.",
    "auth/network-request-failed": "Koneksi internet bermasalah. Periksa jaringanmu.",
    "auth/popup-closed-by-user": "Jendela Google ditutup sebelum selesai.",
    "auth/cancelled-popup-request": "Permintaan masuk dibatalkan.",
    "auth/unauthorized-domain": "Domain situs ini belum diizinkan di Firebase (Authorized domains).",
    "auth/operation-not-allowed": "Metode masuk ini belum diaktifkan di Firebase.",
    "permission-denied": "Akses ditolak oleh aturan keamanan database.",
  };
  const kode = err && err.code ? err.code.replace(/^firestore\//, "") : "";
  return peta[err && err.code] || peta[kode] || "Terjadi kesalahan. Coba lagi.";
}

// =========================================================
// 2) AUTENTIKASI
// =========================================================

function setAuthMode(mode) {
  authMode = mode;
  $$(".seg").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  $("auth-submit").textContent = mode === "login" ? "Masuk" : "Daftar";
  $("auth-password").autocomplete = mode === "login" ? "current-password" : "new-password";
  $("forgot-btn").classList.toggle("hidden", mode !== "login");
  $("auth-error").textContent = "";
}

$$(".seg").forEach((b) => b.addEventListener("click", () => setAuthMode(b.dataset.mode)));

$("auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("auth-email").value.trim();
  const sandi = $("auth-password").value;
  const err = $("auth-error");
  err.textContent = "";
  if (!email || !sandi) { err.textContent = "Isi email dan kata sandi dulu."; return; }

  const tombol = $("auth-submit");
  tombol.disabled = true;
  try {
    if (authMode === "login") await signInWithEmailAndPassword(auth, email, sandi);
    else await createUserWithEmailAndPassword(auth, email, sandi);
  } catch (ex) {
    err.textContent = pesanError(ex);
  } finally {
    tombol.disabled = false;
  }
});

$("google-btn").addEventListener("click", async () => {
  const err = $("auth-error");
  err.textContent = "";
  const provider = new GoogleAuthProvider();
  try {
    await signInWithPopup(auth, provider);
  } catch (ex) {
    // Kalau popup diblokir browser HP, pakai cara alihan halaman
    if (ex.code === "auth/popup-blocked") {
      signInWithRedirect(auth, provider);
    } else {
      err.textContent = pesanError(ex);
    }
  }
});

$("forgot-btn").addEventListener("click", async () => {
  const email = $("auth-email").value.trim();
  const err = $("auth-error");
  if (!email) { err.textContent = "Isi email dulu, lalu tekan \"Lupa kata sandi?\"."; return; }
  try {
    await sendPasswordResetEmail(auth, email);
    err.textContent = "";
    toast("Email reset kata sandi dikirim. Cek kotak masukmu.");
  } catch (ex) {
    err.textContent = pesanError(ex);
  }
});

$("logout-btn").addEventListener("click", () => signOut(auth));

// Dipanggil otomatis saat status login berubah
onAuthStateChanged(auth, (u) => {
  user = u;
  $("loading").classList.add("hidden");
  if (u) {
    $("auth-view").classList.add("hidden");
    $("app-view").classList.remove("hidden");
    $("user-email").textContent = u.email || u.displayName || "";
    mulaiAplikasi();
  } else {
    hentikanAplikasi();
    $("app-view").classList.add("hidden");
    $("auth-view").classList.remove("hidden");
    $("auth-password").value = "";
  }
});

// =========================================================
// 3) DATA TUGAS (Firestore): users/{uid}/tasks/{taskId}
// =========================================================

function mulaiAplikasi() {
  hentikanAplikasi();
  tab = "pending";
  setTab("pending");

  const ref = collection(db, "users", user.uid, "tasks");
  // Urutan dilakukan di sisi browser, jadi tidak perlu membuat index Firestore
  unsubTasks = onSnapshot(ref, (snap) => {
    tasks = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
    cekPengingat();
  }, (ex) => toast(pesanError(ex)));

  daftarkanServiceWorker();
  tampilkanAjakanNotifikasi();
  timerPengingat = setInterval(cekPengingat, CEK_PENGINGAT_MS);
  timerRender = setInterval(render, 60 * 1000); // segarkan label "sisa waktu"
}

function hentikanAplikasi() {
  if (unsubTasks) { unsubTasks(); unsubTasks = null; }
  clearInterval(timerPengingat);
  clearInterval(timerRender);
  tasks = [];
  $("task-list").innerHTML = "";
}

function dataDariForm() {
  const judul = $("f-title").value.trim();
  const mapel = $("f-subject").value.trim();
  const deskripsi = $("f-desc").value.trim();
  const deadlineStr = $("f-deadline").value;
  const prioritas = (document.querySelector('input[name="priority"]:checked') || {}).value || "sedang";

  if (!judul) return { error: "Judul tugas wajib diisi." };
  if (!mapel) return { error: "Mata pelajaran wajib diisi." };
  if (!deadlineStr) return { error: "Deadline (tanggal & jam) wajib diisi." };
  const tgl = new Date(deadlineStr);
  if (isNaN(tgl.getTime())) return { error: "Deadline tidak valid." };

  return {
    data: {
      title: judul,
      subject: mapel,
      description: deskripsi,
      deadline: Timestamp.fromDate(tgl),
      priority: prioritas,
    },
  };
}

$("task-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!user) return;
  const { data, error } = dataDariForm();
  if (error) { $("form-error").textContent = error; return; }

  const idEdit = editingId;
  if (idEdit) {
    // Edit: hanya ubah field yang diisi di form
    updateDoc(doc(db, "users", user.uid, "tasks", idEdit), data)
      .catch((ex) => toast(pesanError(ex)));
    toast("Tugas diperbarui.");
  } else {
    // Tambah baru
    addDoc(collection(db, "users", user.uid, "tasks"), {
      ...data,
      completed: false,
      completedAt: null,
      createdAt: serverTimestamp(),
    }).catch((ex) => toast(pesanError(ex)));
    toast("Tugas ditambahkan.");
  }
  // Modal langsung ditutup; Firestore menyimpan lokal dulu lalu sinkron saat online
  tutupModal();
});

function toggleSelesai(id) {
  const t = tasks.find((x) => x.id === id);
  if (!t || !user) return;
  const sekarangSelesai = !t.completed;
  updateDoc(doc(db, "users", user.uid, "tasks", id), {
    completed: sekarangSelesai,
    completedAt: sekarangSelesai ? serverTimestamp() : null,
  }).catch((ex) => toast(pesanError(ex)));
  toast(sekarangSelesai ? "Tugas ditandai selesai 🎉" : "Tugas dikembalikan ke belum selesai.");
}

function hapusTugas(id) {
  const t = tasks.find((x) => x.id === id);
  if (!t || !user) return;
  if (!confirm(`Hapus tugas "${t.title}"?`)) return;
  deleteDoc(doc(db, "users", user.uid, "tasks", id)).catch((ex) => toast(pesanError(ex)));
  toast("Tugas dihapus.");
}

// =========================================================
// 4) TAMPILAN
// =========================================================

function setTab(nama) {
  tab = nama;
  $$(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === nama));
  $("page-title").textContent = nama === "pending" ? "Tugas Belum Selesai" : "Tugas Selesai";
  render();
}
$$(".tab").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));

function kartuTugas(t) {
  const deadlineMs = ms(t.deadline);
  let kelas = "";
  let infoWaktu = "";
  if (t.completed) {
    kelas = "done";
    infoWaktu = `✅ Selesai ${formatTanggal(ms(t.completedAt))}<br>⏰ Deadline: ${formatTanggal(deadlineMs)}`;
  } else {
    const st = statusDeadline(deadlineMs);
    kelas = st.kelas;
    infoWaktu = `⏰ ${formatTanggal(deadlineMs)}<br>${esc(st.label)}`;
  }
  const prio = NAMA_PRIORITAS[t.priority] ? t.priority : "sedang";
  const deskripsi = t.description ? `<p class="desc">${esc(t.description)}</p>` : "";
  const labelCek = t.completed ? "Batalkan selesai" : "Tandai selesai";
  const tombolKembali = t.completed
    ? `<button type="button" class="restore" data-aksi="toggle">↩ Kembalikan ke belum selesai</button>`
    : "";

  return `
    <article class="task ${kelas}" data-id="${esc(t.id)}">
      <button type="button" class="check" data-aksi="toggle" aria-label="${labelCek}: ${esc(t.title)}"></button>
      <div class="task-body">
        <div class="task-title">${esc(t.title)}</div>
        <div class="chips">
          <span class="chip">${esc(t.subject)}</span>
          <span class="chip prio-${prio}">Prioritas ${NAMA_PRIORITAS[prio]}</span>
        </div>
        ${deskripsi}
        <div class="deadline">${infoWaktu}</div>
        <div class="task-actions">
          ${tombolKembali}
          <button type="button" data-aksi="edit">✏️ Edit</button>
          <button type="button" class="danger" data-aksi="delete">🗑 Hapus</button>
        </div>
      </div>
    </article>`;
}

function render() {
  if (!user) return;
  // Belum selesai: deadline terdekat dulu
  const belum = tasks.filter((t) => !t.completed).sort((a, b) => ms(a.deadline) - ms(b.deadline));
  // Selesai: yang terbaru diselesaikan dulu
  const selesai = tasks.filter((t) => t.completed).sort((a, b) => ms(b.completedAt) - ms(a.completedAt));

  $("count-pending").textContent = belum.length;
  $("count-done").textContent = selesai.length;

  const daftar = tab === "pending" ? belum : selesai;
  $("task-list").innerHTML = daftar.map(kartuTugas).join("");

  const kosong = $("empty-state");
  if (daftar.length === 0) {
    kosong.classList.remove("hidden");
    kosong.innerHTML = tab === "pending"
      ? `<span class="big">🎉</span>Tidak ada tugas yang belum selesai.<br>Tekan <strong>Tambah Tugas</strong> untuk mencatat yang baru.`
      : `<span class="big">📭</span>Belum ada tugas yang selesai.`;
  } else {
    kosong.classList.add("hidden");
  }

  renderBanner(belum);
}

// Banner pengingat: tugas belum selesai yang deadline-nya kurang dari 24 jam (termasuk yang sudah lewat)
function renderBanner(belum) {
  const banner = $("reminder-banner");
  const sekarang = Date.now();
  const mendesak = belum.filter((t) => ms(t.deadline) - sekarang < BATAS_24_JAM);
  if (mendesak.length === 0) { banner.classList.add("hidden"); return; }

  const adaTerlambat = mendesak.some((t) => ms(t.deadline) < sekarang);
  banner.classList.toggle("danger", adaTerlambat);
  banner.classList.remove("hidden");

  const maks = 4;
  const item = mendesak.slice(0, maks).map((t) => {
    const selisih = ms(t.deadline) - sekarang;
    const ket = selisih < 0 ? `terlambat ${durasi(-selisih)}` : `${durasi(selisih)} lagi`;
    return `<li><strong style="display:inline">${esc(t.title)}</strong> (${esc(t.subject)}) — ${ket}</li>`;
  }).join("");
  const sisa = mendesak.length > maks ? `<div>…dan ${mendesak.length - maks} tugas lainnya.</div>` : "";
  banner.innerHTML = `<strong>⚠️ ${mendesak.length} tugas butuh perhatianmu (deadline &lt; 24 jam)</strong><ul>${item}</ul>${sisa}`;
}

// Klik pada kartu (satu listener untuk semua tombol)
$("task-list").addEventListener("click", (e) => {
  const tombol = e.target.closest("[data-aksi]");
  if (!tombol) return;
  const id = tombol.closest(".task").dataset.id;
  const aksi = tombol.dataset.aksi;
  if (aksi === "toggle") toggleSelesai(id);
  else if (aksi === "edit") bukaModal(id);
  else if (aksi === "delete") hapusTugas(id);
});

// ---------- Modal tambah / edit ----------
function bukaModal(id = null) {
  editingId = id;
  $("form-error").textContent = "";
  $("task-form").reset();
  $("modal-title").textContent = id ? "Edit Tugas" : "Tambah Tugas";
  $("form-submit").textContent = id ? "Simpan Perubahan" : "Simpan";

  if (id) {
    const t = tasks.find((x) => x.id === id);
    if (!t) return;
    $("f-title").value = t.title || "";
    $("f-subject").value = t.subject || "";
    $("f-desc").value = t.description || "";
    $("f-deadline").value = keInputLokal(new Date(ms(t.deadline)));
    const radio = document.querySelector(`input[name="priority"][value="${t.priority}"]`);
    if (radio) radio.checked = true;
  }
  $("modal").classList.remove("hidden");
  document.body.classList.add("no-scroll");
  setTimeout(() => $("f-title").focus(), 50);
}

function tutupModal() {
  $("modal").classList.add("hidden");
  document.body.classList.remove("no-scroll");
  editingId = null;
}

$("add-btn").addEventListener("click", () => bukaModal());
$("modal-close").addEventListener("click", tutupModal);
$("form-cancel").addEventListener("click", tutupModal);
$("modal").addEventListener("click", (e) => { if (e.target === $("modal")) tutupModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("modal").classList.contains("hidden")) tutupModal(); });

// =========================================================
// 5) PENGINGAT DEADLINE (tanpa server)
//    Notifikasi hanya muncul selama halaman ini terbuka.
// =========================================================

function daftarkanServiceWorker() {
  // Chrome di HP hanya mengizinkan notifikasi lewat service worker
  if (swDidaftarkan || !("serviceWorker" in navigator)) return;
  swDidaftarkan = true;
  navigator.serviceWorker.register("sw.js").catch(() => { /* abaikan; kita punya cadangan */ });
}

function notifikasiDidukung() {
  return "Notification" in window;
}

// Jelaskan dulu alasannya sebelum meminta izin
function tampilkanAjakanNotifikasi() {
  const kartu = $("notif-prompt");
  const sudahDitunda = localStorage.getItem("notif-ditunda") === "1";
  const tampil = notifikasiDidukung() && Notification.permission === "default" && !sudahDitunda;
  kartu.classList.toggle("hidden", !tampil);
}

$("notif-allow").addEventListener("click", async () => {
  try {
    const hasil = await Notification.requestPermission();
    $("notif-prompt").classList.add("hidden");
    if (hasil === "granted") { toast("Pengingat aktif. Biarkan halaman ini terbuka ya."); cekPengingat(); }
    else if (hasil === "denied") toast("Izin ditolak. Kamu bisa mengubahnya di pengaturan situs browser.");
  } catch (_) {
    $("notif-prompt").classList.add("hidden");
  }
});
$("notif-later").addEventListener("click", () => {
  localStorage.setItem("notif-ditunda", "1");
  $("notif-prompt").classList.add("hidden");
});

// Catatan notifikasi yang sudah dikirim, disimpan di browser supaya tidak berulang
function kunciCatatan() { return `pengingat:${user ? user.uid : ""}`; }
function bacaCatatan() {
  try { return JSON.parse(localStorage.getItem(kunciCatatan()) || "{}"); } catch (_) { return {}; }
}
function simpanCatatan(obj) {
  try { localStorage.setItem(kunciCatatan(), JSON.stringify(obj)); } catch (_) { /* abaikan */ }
}

async function tampilkanNotifikasi(judul, isi, tag) {
  try {
    if ("serviceWorker" in navigator && swDidaftarkan) {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification(judul, { body: isi, tag });
      return;
    }
  } catch (_) { /* lanjut ke cadangan */ }
  try { new Notification(judul, { body: isi, tag }); } catch (_) { /* tidak didukung */ }
}

function cekPengingat() {
  if (!user || !notifikasiDidukung() || Notification.permission !== "granted") return;

  const catatan = bacaCatatan();
  const idAktif = new Set(tasks.map((t) => t.id));
  // Bersihkan catatan tugas yang sudah dihapus
  Object.keys(catatan).forEach((k) => { if (!idAktif.has(k.split("|")[0])) delete catatan[k]; });

  const sekarang = Date.now();
  for (const t of tasks) {
    if (t.completed) continue;
    const dl = ms(t.deadline);
    const sisa = dl - sekarang;
    if (sisa <= 0 || sisa > BATAS_24_JAM) continue;

    // Kunci memuat deadline, jadi kalau deadline diubah, pengingat dihitung ulang
    const k24 = `${t.id}|${dl}|24`;
    const k1 = `${t.id}|${dl}|1`;

    if (sisa <= BATAS_1_JAM) {
      if (!catatan[k1]) {
        tampilkanNotifikasi("⏰ Deadline 1 jam lagi!", `${t.title} (${t.subject}) — tepat ${formatTanggal(dl)}`, k1);
        catatan[k1] = 1;
        catatan[k24] = 1; // pengingat 24 jam tidak perlu lagi
      }
    } else if (!catatan[k24]) {
      tampilkanNotifikasi("📌 Deadline kurang dari 24 jam", `${t.title} (${t.subject}) — sisa ${durasi(sisa)}`, k24);
      catatan[k24] = 1;
    }
  }
  simpanCatatan(catatan);
}

// Saat tab dibuka lagi (mis. setelah di-minimize), langsung cek & segarkan
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && user) { render(); cekPengingat(); }
});

// Mulai dari mode masuk
setAuthMode("login");
