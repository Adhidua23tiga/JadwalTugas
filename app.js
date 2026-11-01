// =========================================================
// Dashboard Jadwal & Tugas — logika aplikasi
// Vanilla JavaScript + Firebase (Auth & Firestore), tanpa build step.
// =========================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signOut,
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  sendPasswordResetEmail, updateProfile,
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
let animasi = true;        // true = daftar tugas tampil dengan animasi masuk (sekali saja)

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

// ---------- Tampilan: ikon & warna per mata pelajaran ----------
// Ikon dipilih dari kata kunci pada nama mapel; kalau tidak cocok dipakai 📝
const IKON_MAPEL = [
  ["matematika", "🧮"], ["indonesia", "📖"], ["inggris", "🔤"], ["ppkn", "⚖️"],
  ["agama", "🙏"], ["pjok", "⚽"], ["olahraga", "⚽"], ["sejarah", "🏛️"],
  ["informatika", "💻"], ["kejuruan", "🛠️"], ["ipas", "🔬"], ["seni", "🎨"],
  ["fisika", "⚡"], ["kimia", "🧪"], ["biologi", "🌱"], ["ekonomi", "💰"],
];
function ikonMapel(mapel) {
  const m = String(mapel || "").toLowerCase();
  const cocok = IKON_MAPEL.find(([kata]) => m.includes(kata));
  return cocok ? cocok[1] : "📝";
}

// Hue (0-360) tetap untuk satu nama mapel, jadi warnanya selalu sama
const HUE_MAPEL = [210, 265, 150, 335, 175, 40, 100, 15];
function hueMapel(mapel) {
  const m = String(mapel || "").trim().toLowerCase();
  let hash = 0;
  for (let i = 0; i < m.length; i++) hash = (hash * 31 + m.charCodeAt(i)) >>> 0;
  return HUE_MAPEL[hash % HUE_MAPEL.length];
}

// Sapaan sesuai jam & nama panggilan dari akun
function sapaan() {
  const jam = new Date().getHours();
  if (jam < 11) return "Selamat pagi";
  if (jam < 15) return "Selamat siang";
  if (jam < 18) return "Selamat sore";
  return "Selamat malam";
}
function namaPanggilan() {
  // 1) Nama yang diisi di halaman Profil (atau nama akun Google).
  //    Kalau terlalu panjang (mis. nama lengkap), pakai kata pertamanya saja.
  const dn = ((user && user.displayName) || "").trim();
  if (dn) return dn.length <= 16 ? dn : dn.split(/\s+/)[0];
  // 2) Cadangan: bagian depan email
  let nama = user && user.email ? user.email.split("@")[0] : "";
  nama = nama.split(/[\s._-]+/)[0] || "kamu";
  return nama.charAt(0).toUpperCase() + nama.slice(1);
}

// Ilustrasi sederhana untuk keadaan kosong (warna diatur di style.css)
const ILUSTRASI = `
  <svg class="ill" viewBox="0 0 200 160" aria-hidden="true">
    <circle class="bg" cx="100" cy="82" r="70"/>
    <rect class="paper" x="62" y="30" width="76" height="98" rx="10"/>
    <rect class="clip" x="84" y="22" width="32" height="16" rx="6"/>
    <line class="line" x1="76" y1="62" x2="124" y2="62"/>
    <line class="line" x1="76" y1="80" x2="112" y2="80"/>
    <path class="tick" d="M80 104 L94 117 L120 92"/>
    <path class="spark" d="M30 40 l4 10 10 4 -10 4 -4 10 -4 -10 -10 -4 10 -4z"/>
    <path class="spark" d="M165 105 l3 7 7 3 -7 3 -3 7 -3 -7 -7 -3 7 -3z"/>
  </svg>`;

// Confetti kecil saat tugas selesai (dimatikan kalau pengguna memilih "kurangi animasi")
function confetti() {
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const wadah = $("confetti");
  const warna = ["#EECAA6", "#8A5A2B", "#E57373", "#FFB74D", "#81C995", "#64B5F6", "#BA68C8"];
  for (let i = 0; i < 32; i++) {
    const p = document.createElement("span");
    p.className = "konfeti";
    p.style.left = `${Math.random() * 100}%`;
    p.style.background = warna[i % warna.length];
    p.style.setProperty("--x", `${Math.round(Math.random() * 160 - 80)}px`);
    p.style.setProperty("--r", `${Math.round(Math.random() * 720 - 360)}deg`);
    p.style.setProperty("--d", `${(1.1 + Math.random() * 0.9).toFixed(2)}s`);
    p.style.animationDelay = `${(Math.random() * 0.25).toFixed(2)}s`;
    wadah.appendChild(p);
  }
  setTimeout(() => { wadah.innerHTML = ""; }, 2400);
}

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
$("logout-btn-2").addEventListener("click", () => signOut(auth)); // tombol keluar di halaman Profil

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
  if (sekarangSelesai) confetti();
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
  $("dash-top").classList.toggle("hidden", nama !== "pending"); // sapaan & statistik hanya di halaman "Belum Selesai"
  // Tab Profil: sembunyikan daftar tugas & tombol tambah, tampilkan halaman profil
  const diProfil = nama === "profile";
  $("tasks-area").classList.toggle("hidden", diProfil);
  $("profile-view").classList.toggle("hidden", !diProfil);
  $("add-btn").classList.toggle("hidden", diProfil);
  if (diProfil && user) { $("p-name").value = user.displayName || ""; $("profile-msg").textContent = ""; }
  animasi = true; // kartu tampil dengan animasi saat pindah halaman
  render();
}
$$(".tab").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));

function kartuTugas(t, i) {
  const deadlineMs = ms(t.deadline);
  let kelas = "";
  let infoWaktu = "";
  if (t.completed) {
    kelas = "done";
    infoWaktu = `<div class="deadline">⏰ Deadline: ${formatTanggal(deadlineMs)}</div>
      <span class="pill pill-done">✅ Selesai ${formatTanggal(ms(t.completedAt))}</span>`;
  } else {
    const st = statusDeadline(deadlineMs);
    kelas = st.kelas;
    infoWaktu = `<div class="deadline">⏰ ${formatTanggal(deadlineMs)}</div>
      <span class="pill pill-${st.kelas || "normal"}">${esc(st.label)}</span>`;
  }
  const prio = NAMA_PRIORITAS[t.priority] ? t.priority : "sedang";
  const deskripsi = t.description ? `<p class="desc">${esc(t.description)}</p>` : "";
  const labelCek = t.completed ? "Batalkan selesai" : "Tandai selesai";
  const tombolKembali = t.completed
    ? `<button type="button" class="restore" data-aksi="toggle">↩ Kembalikan ke belum selesai</button>`
    : "";

  return `
    <article class="task ${kelas}" data-id="${esc(t.id)}" style="--i:${Math.min(i, 10)}">
      <button type="button" class="check" data-aksi="toggle" aria-label="${labelCek}: ${esc(t.title)}"></button>
      <div class="task-body">
        <div class="task-title"><span class="ico" aria-hidden="true">${ikonMapel(t.subject)}</span><span>${esc(t.title)}</span></div>
        <div class="chips">
          <span class="chip subj" style="--h:${hueMapel(t.subject)}">${esc(t.subject)}</span>
          <span class="chip prio-${prio}">Prioritas ${NAMA_PRIORITAS[prio]}</span>
        </div>
        ${deskripsi}
        ${infoWaktu}
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
  const listEl = $("task-list");
  listEl.classList.toggle("anim", animasi); // animasi masuk hanya sekali, bukan tiap penyegaran
  animasi = false;
  listEl.innerHTML = daftar.map(kartuTugas).join("");

  const kosong = $("empty-state");
  if (daftar.length === 0) {
    kosong.classList.remove("hidden");
    kosong.innerHTML = tab === "pending"
      ? `${ILUSTRASI}<span class="empty-title">Semua tugas beres! 🎉</span>Tekan <strong>Tambah Tugas</strong> untuk mencatat yang baru.`
      : `${ILUSTRASI}<span class="empty-title">Belum ada tugas selesai</span>Tugas yang kamu selesaikan akan muncul di sini.`;
  } else {
    kosong.classList.add("hidden");
  }

  renderRingkasan(belum, selesai);
  renderBanner(belum);
  segarProfil(belum, selesai);
}

// Sapaan, kartu statistik, dan progress bar
function renderRingkasan(belum, selesai) {
  const sekarang = Date.now();
  const terlambat = belum.filter((t) => ms(t.deadline) < sekarang).length;
  const hariIni = belum.filter((t) => ms(t.deadline) >= sekarang && sameDay(new Date(ms(t.deadline)), new Date())).length;
  const mingguIni = belum.filter((t) => ms(t.deadline) >= sekarang && ms(t.deadline) - sekarang <= 7 * 24 * JAM).length;
  const selesai7Hari = selesai.filter((t) => sekarang - ms(t.completedAt) <= 7 * 24 * JAM).length;

  $("greeting").textContent = `${sapaan()}, ${namaPanggilan()}! 👋`;

  let ringkas;
  if (belum.length === 0) ringkas = tasks.length ? "Semua tugas sudah selesai. Mantap! 🎉" : "Belum ada tugas. Yuk catat tugas pertamamu!";
  else {
    const bagian = [`${belum.length} tugas belum selesai`];
    if (hariIni > 0) bagian.push(`${hariIni} deadline hari ini`);
    else if (mingguIni > 0) bagian.push(`${mingguIni} deadline minggu ini`);
    if (terlambat > 0) bagian.push(`${terlambat} terlambat`);
    ringkas = bagian.join(" · ");
  }
  $("summary").textContent = ringkas;

  $("stat-overdue").textContent = terlambat;
  $("stat-today").textContent = hariIni;
  $("stat-week").textContent = selesai7Hari;

  // Progress: selesai dibanding semua tugas
  const total = tasks.length;
  const persen = total ? Math.round((selesai.length / total) * 100) : 0;
  $("progress").classList.toggle("hidden", total === 0);
  $("progress-text").textContent = `Selesai ${selesai.length} dari ${total} tugas`;
  $("progress-pct").textContent = `${persen}%`;
  $("progress-fill").style.width = `${persen}%`;
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

// ---------- Halaman profil ----------
// Segarkan teks di halaman profil (tidak menyentuh kolom isian yang sedang diketik)
function segarProfil(belum, selesai) {
  if (!user) return;
  const nama = namaPanggilan();
  $("avatar").textContent = nama.charAt(0).toUpperCase();
  $("profile-name-show").textContent = user.displayName || nama;
  $("profile-email").textContent = user.email || "";
  $("p-total").textContent = tasks.length;
  $("p-pending").textContent = belum.length;
  $("p-done").textContent = selesai.length;
  // Ajakan ganti nama hanya muncul kalau belum punya nama
  $("name-hint").classList.toggle("hidden", !!user.displayName);
}

$("name-hint").addEventListener("click", () => setTab("profile"));

// Simpan nama ke profil akun Firebase Auth (tidak perlu mengubah aturan Firestore)
$("profile-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!user) return;
  const msg = $("profile-msg");
  msg.textContent = "";
  const nama = $("p-name").value.trim().replace(/\s+/g, " ");
  if (nama.length < 2) { msg.textContent = "Nama minimal 2 huruf."; return; }

  const tombol = $("profile-save");
  tombol.disabled = true;
  try {
    await updateProfile(auth.currentUser, { displayName: nama });
    toast("Nama berhasil disimpan 👍");
    render(); // sapaan & avatar langsung berganti
  } catch (ex) {
    msg.textContent = pesanError(ex);
  } finally {
    tombol.disabled = false;
  }
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
