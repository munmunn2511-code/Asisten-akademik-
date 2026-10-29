# Server Asisten Akademik

Satu file Node (tanpa dependensi, butuh Node 18+) yang:
- menyajikan halaman Asisten Akademik di `/`,
- meneruskan permintaan AI ke Anthropic lewat `/api/ai` (API key tersimpan di server, tidak di HTML),
- membaca link soal publik dan Google Form yang tidak wajib login lewat `/api/baca-link`.

## Jalankan
```
ANTHROPIC_API_KEY=sk-ant-... node server.js
```
Buka `http://localhost:3000`. Halaman otomatis memakai server ini saat dibuka dari alamatnya.

Untuk dibuka dari HP di jaringan yang sama, buka `http://IP-KOMPUTER:3000`. Untuk dipakai umum, pasang di hosting Node (Render, Railway, VPS) dengan HTTPS, isi variabel lingkungan `ANTHROPIC_API_KEY`, dan isi `TRUST_PROXY=1` bila di belakang proxy.

## Variabel lingkungan
- `ANTHROPIC_API_KEY` wajib.
- `ACCESS_CODE` kode akses opsional (sangat disarankan di hosting). Bila diisi, halaman meminta kode sekali dan menyimpannya di perangkat; tanpa kode yang benar, `/api/ai` dan `/api/baca-link` ditolak. Percobaan kode salah dibatasi 10 per menit per IP.
- `PORT` bawaan 3000.
- `ALLOWED_MODELS` daftar model yang boleh dipakai, dipisah koma (bawaan `claude-sonnet-4-6`).
- `TRUST_PROXY=1` pakai `X-Forwarded-For` untuk batas laju per pengguna.

## Dipakai di HP
Buka alamat server di Chrome HP. Di Jawab Soal, salin teks soal dari halaman soal lalu ketuk **Tempel & Jawab**, atau pilih sumber Link untuk link publik / Google Form tanpa login. Opsi "Tambahkan ke layar utama" di browser membuatnya tampil seperti aplikasi.

## Perlindungan bawaan
- Batas laju: 30 permintaan AI dan 20 pembacaan link per menit per alamat IP.
- Pembaca link menolak alamat internal (localhost, jaringan privat), port selain 80/443, ukuran halaman di atas 2 MB, dan alihan lebih dari 5 kali.
- Hanya model dan alat pencarian web yang diizinkan yang diteruskan ke Anthropic; `max_tokens` dibatasi 8000.

Tanpa `ACCESS_CODE`, siapa pun yang tahu alamat server memakai kuota API-mu. Isi `ACCESS_CODE` sebelum dibagikan, dan bagikan kodenya hanya ke orang yang kamu percaya.

## Batasan
- Google Form wajib login, form yang ditutup, dan halaman yang soalnya dibuat dengan JavaScript tidak terbaca; pakai ekstensi atau salin dan tempel teks soal.
- PDF dari link tidak dibaca; unggah sebagai file.
- Parser Google Form membaca data bawaan halaman form. Google bisa mengubah strukturnya kapan saja.


## Akun, blokir, dan panel admin
- Setiap pengguna mendaftar dari halaman (profil), dan server mencatat ID, nama, email, kelas, IP, dan sidik perangkat di `data/akun.json`.
- 1 perangkat = 1 ID. Percobaan membuat ID kedua dari perangkat yang sama (atau email yang sama) ditolak dan dicatat di tab "Percobaan ganda".
- Panel admin: buka `/admin`, masukkan `ADMIN_CODE`. Dari sana akun bisa diblokir, dibuka blokirnya, atau dihapus.
- ID yang diblokir tidak bisa memakai AI dan pembaca link, dan perangkatnya tidak bisa mendaftar ID baru.
- Jalankan: `GEMINI_API_KEY=... ACCESS_CODE=... ADMIN_CODE=... node server.js`
- Bila server diakses lewat tunnel/proxy (Cloudflare, ngrok), tambahkan `TRUST_PROXY=1` agar IP pengguna tercatat benar.

## Online (hosting)
Halaman utama `/`, panel admin `/admin`, dan cek status `/healthz` semua dilayani satu server ini, jadi cukup satu alamat.
1. Unggah folder ini ke GitHub (file `.gitignore` sudah menyembunyikan `.env` dan `data/`).
2. Render/Railway: buat Web Service dari repo, perintah mulai `node server.js` (`render.yaml` sudah disiapkan).
3. Isi variabel: `GEMINI_API_KEY` (atau `ANTHROPIC_API_KEY`), `ACCESS_CODE`, `ADMIN_CODE`, `TRUST_PROXY=1`.
4. Pasang disk/volume di folder `data/` supaya akun dan blokir tidak hilang saat server restart.
5. Buka `https://alamat-anda/` dan `https://alamat-anda/admin`.
Lokal: salin `.env.example` jadi `.env`, isi, lalu `node server.js`.
