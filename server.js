'use strict';
// Server Asisten Akademik: menyajikan halaman, meneruskan permintaan AI (API key aman di server),
// dan membaca link soal publik / Google Form yang tidak wajib login.
// Jalankan: GEMINI_API_KEY=... node server.js   (atau ANTHROPIC_API_KEY=...; butuh Node 18+)

const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Muat file .env (opsional) tanpa dependensi: baris KUNCI=nilai
try { fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach(l => { const m = l.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }); } catch (e) {}
const PORT = Number(process.env.PORT) || 3000;
const KEY = process.env.ANTHROPIC_API_KEY || '';
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
const HAS_AI = !!(GEMINI_KEY || KEY);
const ACCESS_CODE = process.env.ACCESS_CODE || '';
const MODELS = (process.env.ALLOWED_MODELS || 'claude-sonnet-4-6').split(',').map(s => s.trim()).filter(Boolean);
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const INDEX = path.join(__dirname, 'public', 'index.html');
const MAX_BODY = 15 * 1024 * 1024;
const MAX_PAGE = 2 * 1024 * 1024;
const ADMIN_CODE = process.env.ADMIN_CODE || '';
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'akun.json');
const ADMIN_PAGE = path.join(__dirname, 'public', 'admin.html');

// ---------- utilitas ----------
const hits = new Map();
function limited(ip, max) {
  const now = Date.now(), a = (hits.get(ip) || []).filter(t => now - t < 60000);
  a.push(now); hits.set(ip, a);
  return a.length > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some(t => now - t < 60000)) hits.delete(k); }, 60000).unref();

function clientIp(req) {
  if (TRUST_PROXY) { const f = String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim(); if (f) return f; }
  return req.socket.remoteAddress || 'x';
}
function send(res, code, obj, extra) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, extra || {}));
  res.end(JSON.stringify(obj));
}
// Kode akses opsional (variabel ACCESS_CODE). Percobaan salah dibatasi 10 per menit per IP.
const digest = s => crypto.createHash('sha256').update(String(s)).digest();
function tooManyFails(ip) { const now = Date.now(); return (hits.get('gagal:' + ip) || []).filter(t => now - t < 60000).length >= 10; }
function checkCode(req, res) {
  if (!ACCESS_CODE) return true;
  const ip = clientIp(req);
  if (tooManyFails(ip)) { send(res, 429, { pesan: 'Terlalu banyak percobaan kode. Coba lagi sebentar.', error: { message: 'Terlalu banyak percobaan kode.' } }); return false; }
  if (crypto.timingSafeEqual(digest(req.headers['x-access-code'] || ''), digest(ACCESS_CODE))) return true;
  limited('gagal:' + ip, 999);
  send(res, 401, { pesan: 'Kode akses salah atau belum diisi.', error: { message: 'Kode akses salah.' } }, { 'X-Need-Code': '1' });
  return false;
}
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > max) { reject(new Error('too-large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}


// ---------- data akun (1 perangkat = 1 ID) ----------
let db = { akun: {}, percobaan: [] };
try { const j = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); if (j && j.akun) db = { akun: j.akun, percobaan: Array.isArray(j.percobaan) ? j.percobaan : [] }; } catch (e) {}
let saveTimer = null;
function saveDb(now) {
  const run = () => {
    saveTimer = null;
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); const tmp = DB_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, DB_FILE); }
    catch (e) { console.log('Gagal menyimpan data akun: ' + e.message); }
  };
  if (now) { if (saveTimer) clearTimeout(saveTimer); return run(); }
  if (!saveTimer) saveTimer = setTimeout(run, 2000);
}
const ID_RE = /^AA-[A-Z2-9]{8}$/;
const clip = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

function limpDev(d) {
  d = d && typeof d === 'object' ? d : {};
  return { lang: clip(d.lang, 20), plat: clip(d.plat, 30), model: clip(d.model, 40), mem: Number(d.mem) || 0 };
}
function perkiraHp(ua, dev) {
  ua = String(ua || ''); dev = dev || {};
  let hp = dev.model || '';
  if (!hp) { const m = ua.match(/Android [\d.]+; ([^;)]+)/); if (m && !['K', 'Mobile', 'Tablet'].includes(m[1].trim())) hp = m[1].trim(); }
  if (!hp && /iPhone/.test(ua)) hp = 'iPhone'; else if (!hp && /iPad/.test(ua)) hp = 'iPad';
  const browser = /Firefox\//.test(ua) ? 'Firefox' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /EdgA|Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const a = /Android ([\d.]+)/.exec(ua);
  return { hp: hp || 'tidak terbaca (disembunyikan browser)', browser, os: a ? 'Android ' + a[1] : (/iPhone|iPad/.test(ua) ? 'iOS' : '') };
}
const semuaAkun = () => Object.values(db.akun);
function noteIp(a, ip) { a.ip = ip; a.ips = a.ips || []; if (!a.ips.includes(ip)) { a.ips.push(ip); if (a.ips.length > 10) a.ips.shift(); } }
function buatAkun(id, name, email, kelas, fp, req) {
  const ip = clientIp(req), now = Date.now();
  const a = { id, name, email, kelas, fp, ip, ips: [ip], ua: clip(req.headers['user-agent'], 200), dibuat: now, terakhir: now, pakai: 0, banned: false, alasan: '' };
  db.akun[id] = a; return a;
}
function catat(req, extra) {
  db.percobaan.push(Object.assign({ waktu: Date.now(), ip: clientIp(req), ua: clip(req.headers['user-agent'], 200) }, extra));
  if (db.percobaan.length > 500) db.percobaan.splice(0, db.percobaan.length - 500);
  saveDb();
}
async function handleDaftar(req, res) {
  const ip = clientIp(req);
  if (limited('reg:' + ip, 20)) return send(res, 429, { ok: false, pesan: 'Terlalu banyak permintaan. Coba lagi sebentar.' });
  let b; try { b = JSON.parse(await readBody(req, 10000)); } catch (e) { return send(res, 400, { ok: false }); }
  const op = b && b.op, fp = clip(b && b.fp, 64), id = clip(b && b.id, 20), fp2 = clip(b && b.fp2, 64), dev = limpDev(b && b.dev);
  if (!fp || !ID_RE.test(id)) return send(res, 400, { ok: false });
  const mine = db.akun[id];
  if (op === 'verify') {
    if (mine) {
      if (mine.fp !== fp) return send(res, 200, { ok: false });
      if (mine.banned) return send(res, 200, { ok: false, banned: true });
      if (fp2 && !mine.fp2) mine.fp2 = fp2; if (dev.model || !mine.dev) mine.dev = dev;
      mine.terakhir = Date.now(); noteIp(mine, ip); saveDb();
      return send(res, 200, { ok: true });
    }
    const lain = semuaAkun().find(a => a.fp === fp);
    if (lain) { catat(req, { aksi: 'verify-bentrok', id, fp, bentrokDengan: lain.id, sebab: 'perangkat' }); return send(res, 200, { ok: false, banned: !!lain.banned }); }
    Object.assign(buatAkun(id, '', '', '', fp, req), { fp2, dev }); saveDb();   // pengguna lama yang profilnya dibuat sebelum server ini aktif
    return send(res, 200, { ok: true });
  }
  if (op === 'register') {
    if (mine) return send(res, 200, { ok: mine.fp === fp && !mine.banned });
    const name = clip(b.name, 100), email = clip(b.email, 120).toLowerCase(), kelas = clip(b.kelas, 40);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return send(res, 400, { ok: false });
    const dev = semuaAkun().find(a => a.fp === fp), mail = semuaAkun().find(a => a.email && a.email === email), lain = dev || mail;
    if (lain) {
      catat(req, { aksi: 'daftar-ganda', id, name, email, fp, bentrokDengan: lain.id, sebab: dev ? 'perangkat' : 'email', diblokir: !!lain.banned });
      return send(res, 200, { ok: false, banned: !!lain.banned });
    }
    Object.assign(buatAkun(id, name, email, kelas, fp, req), { fp2, dev }); saveDb(true);
    return send(res, 200, { ok: true });
  }
  send(res, 400, { ok: false });
}
// Dipanggil sebelum memakai AI / pembaca link: ID harus terdaftar dan tidak diblokir.
function cekAkun(req, res) {
  const id = clip(req.headers['x-aa-id'], 20), a = ID_RE.test(id) ? db.akun[id] : null;
  const tolak = (code, msg) => { send(res, code, { pesan: msg, error: { message: msg } }); return null; };
  if (!a) return tolak(403, 'Buat profil dan dapatkan ID Asisten Akademik dulu.');
  if (a.banned) return tolak(403, 'ID ' + id + ' diblokir.' + (a.alasan ? ' Alasan: ' + a.alasan : ''));
  if (limited('id:' + id, 20)) return tolak(429, 'Terlalu banyak permintaan. Coba lagi sebentar.');
  a.terakhir = Date.now(); a.pakai = (a.pakai || 0) + 1; noteIp(a, clientIp(req)); saveDb();
  return a;
}

// ---------- panel admin ----------
function adminAuth(req, res) {
  if (!ADMIN_CODE) { send(res, 503, { pesan: 'ADMIN_CODE belum diisi di server, jadi panel admin nonaktif.' }); return false; }
  const ip = clientIp(req);
  if (tooManyFails(ip)) { send(res, 429, { pesan: 'Terlalu banyak percobaan. Coba lagi sebentar.' }); return false; }
  if (crypto.timingSafeEqual(digest(req.headers['x-admin-code'] || ''), digest(ADMIN_CODE))) return true;
  limited('gagal:' + ip, 999);
  send(res, 401, { pesan: 'Kode admin salah.' });
  return false;
}
async function handleAdmin(req, res) {
  if (!adminAuth(req, res)) return;
  let b; try { b = JSON.parse(await readBody(req, 10000)); } catch (e) { return send(res, 400, { pesan: 'Permintaan tidak valid.' }); }
  const op = b && b.op, id = clip(b && b.id, 20), a = db.akun[id];
  if (op === 'list') {
    const ipMap = {};
    semuaAkun().forEach(x => (x.ips || [x.ip]).forEach(p => { (ipMap[p] = ipMap[p] || []).push(x.id); }));
    const list = semuaAkun().map(x => {
      const serumah = [...new Set((x.ips || [x.ip]).flatMap(p => ipMap[p] || []))].filter(i => i !== x.id);
      const mirip = x.fp2 ? semuaAkun().filter(y => y.id !== x.id && y.fp2 === x.fp2).map(y => y.id) : [];
      return Object.assign({}, x, { fp: String(x.fp).slice(0, 8), fp2: undefined, serumah, mirip }, perkiraHp(x.ua, x.dev));
    }).sort((p, q) => q.dibuat - p.dibuat);
    const nama = {}; semuaAkun().forEach(x => { nama[x.id] = x.name || x.email || ''; });
    return send(res, 200, { akun: list, percobaan: db.percobaan.slice(-150).reverse().map(p => Object.assign({}, p, { fp: String(p.fp || '').slice(0, 8), namaBentrok: nama[p.bentrokDengan] || '' })) });
  }
  if (!a) return send(res, 404, { pesan: 'ID tidak ditemukan.' });
  if (op === 'ban') { a.banned = true; a.alasan = clip(b.alasan, 200); a.diblokirPada = Date.now(); saveDb(true); return send(res, 200, { ok: true }); }
  if (op === 'unban') { a.banned = false; a.alasan = ''; saveDb(true); return send(res, 200, { ok: true }); }
  if (op === 'hapus') { delete db.akun[id]; saveDb(true); return send(res, 200, { ok: true }); }
  send(res, 400, { pesan: 'Operasi tidak dikenal.' });
}

// ---------- proteksi SSRF ----------
function isPrivate(ip) {
  ip = String(ip).replace(/^\[|\]$/g, '');
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    return l === '::' || l === '::1' || l.startsWith('fc') || l.startsWith('fd') || /^fe[89ab]/.test(l);
  }
  return true; // tidak dikenali: anggap tidak aman
}
function safeLookup(hostname, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  dns.lookup(hostname, { all: true }, (err, addrs) => {
    if (err) return cb(err);
    const ok = addrs.filter(a => !isPrivate(a.address));
    if (!ok.length) return cb(new Error('blocked'));
    if (opts && opts.all) return cb(null, ok);
    cb(null, ok[0].address, ok[0].family);
  });
}
function getOnce(u) {
  return new Promise((resolve, reject) => {
    if (net.isIP(u.hostname.replace(/^\[|\]$/g, '')) && isPrivate(u.hostname)) return reject(new Error('blocked'));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: 'GET', lookup: safeLookup, timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AsistenAkademik/1.0)',
        'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        'Accept-Language': 'id,en;q=0.8',
        'Accept-Encoding': 'identity'
      }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve({ redirect: new URL(res.headers.location, u).href });
      }
      const chunks = []; let size = 0;
      res.on('data', c => { size += c.length; if (size > MAX_PAGE) { req.destroy(new Error('too-large')); return; } chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, type: String(res.headers['content-type'] || ''), body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}
async function fetchSafe(url) {
  let cur = url;
  for (let i = 0; i < 6; i++) {
    const u = new URL(cur);
    if (!/^https?:$/.test(u.protocol)) throw new Error('blocked');
    if (u.port && u.port !== '80' && u.port !== '443') throw new Error('blocked');
    if (u.hostname === 'accounts.google.com') throw new Error('login');
    const r = await getOnce(u);
    if (r.redirect) { cur = r.redirect; continue; }
    r.finalUrl = cur;
    return r;
  }
  throw new Error('too-many-redirects');
}

// ---------- parser ----------
const BIODATA = /^(nama|nama lengkap|kelas|no\.?\s*absen|absen|nis|nisn|email|alamat email)\b/i;
const HURUF = 'ABCDE';

// Struktur data Google Form (FB_PUBLIC_LOAD_DATA_): data[1][1] = daftar item.
// Tiap item: [id, judul, deskripsi, tipe, [[entryId, opsi[[label,...]], wajib, ...]], ...]
// Tipe: 0 isian singkat, 1 paragraf, 2 pilihan ganda, 3 dropdown, 4 kotak centang, 5 skala, 7 kisi, 8 pemisah bagian, 9 tanggal, 10 waktu.
function parseForm(html) {
  const m = String(html).match(/FB_PUBLIC_LOAD_DATA_\s*=\s*(\[[\s\S]*?\])\s*;\s*<\/script>/);
  if (!m) return null;
  let data;
  try { data = JSON.parse(m[1]); } catch (e) { return null; }
  const items = data && data[1] && data[1][1];
  if (!Array.isArray(items)) return null;
  const out = []; let n = 0, bagian = 1;
  items.forEach(it => {
    if (!Array.isArray(it)) return;
    const judul = String(it[1] || '').replace(/\s+/g, ' ').trim(), tipe = it[3];
    if (tipe === 8) { bagian++; return; }
    if (![0, 1, 2, 3, 4, 5, 9, 10].includes(tipe)) return;
    if (!judul || BIODATA.test(judul)) return;
    const q = Array.isArray(it[4]) ? it[4][0] : null;
    let opsi = [];
    if ([2, 3, 4, 5].includes(tipe) && q && Array.isArray(q[1])) {
      opsi = q[1].map(o => (Array.isArray(o) ? String(o[0] == null ? '' : o[0]) : '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    }
    n++;
    let t = n + '. ' + judul;
    opsi.slice(0, 5).forEach((o, i) => { t += '\n' + HURUF[i] + '. ' + o; });
    if (!opsi.length) t += '\n[isian singkat / uraian]';
    out.push(t);
  });
  if (!out.length) return null;
  return { teks: out.join('\n\n'), jumlah: out.length, bagian, judul: String(data[3] || '') };
}
function decodeEntities(s) {
  return s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Math.min(0x10FFFF, Number(d)))).replace(/&amp;/g, '&');
}
function htmlToText(html) {
  let s = String(html).replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/ul|\/ol)\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s).replace(/[ \t\f\v]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return s;
}
async function bacaLink(url) {
  const r = await fetchSafe(url);
  if (r.status === 401 || r.status === 403) throw new Error('login');
  if (r.status >= 400) throw new Error('http-' + r.status);
  if (!/text\/(html|plain)|xhtml/i.test(r.type)) throw new Error('tipe');
  const host = new URL(r.finalUrl).hostname;
  if (/(^|\.)google\.com$/.test(host) && /\/forms\//.test(r.finalUrl)) {
    const f = parseForm(r.body);
    if (f) return { jenis: 'google-form', ...f };
    throw new Error('form-tidak-terbaca');
  }
  const teks = htmlToText(r.body).slice(0, 50000);
  if (teks.length < 50) throw new Error('kosong');
  return { jenis: 'halaman', jumlah: 0, bagian: 1, teks };
}
const PESAN = {
  login: 'Link ini butuh login Google, jadi tidak bisa dibaca server. Buka link, login sendiri, lalu salin teks soal atau pakai ekstensi, dan tempel di kolom teks soal.',
  blocked: 'Alamat link tidak diizinkan.',
  timeout: 'Link terlalu lama merespons. Coba lagi.',
  'too-large': 'Halaman terlalu besar untuk dibaca.',
  'too-many-redirects': 'Link dialihkan terlalu banyak kali.',
  tipe: 'Link ini bukan halaman teks (misalnya PDF atau gambar). Unggah sebagai foto atau file.',
  kosong: 'Halaman tidak memuat teks yang bisa dibaca (kemungkinan dibuat dengan JavaScript). Salin teks soal secara manual atau unggah foto.',
  'form-tidak-terbaca': 'Soal Google Form ini tidak terbaca. Kemungkinan form wajib login, sudah ditutup, atau struktur datanya berubah. Salin teks soal secara manual.'
};

// ---------- penerjemah Anthropic -> Gemini ----------
function textOf(c) {
  if (typeof c === 'string') return c;
  return (Array.isArray(c) ? c : []).map(p => (p && p.type === 'text' ? p.text : '')).join('\n');
}
function toGemini(b) {
  const contents = [];
  for (const m of b.messages) {
    const role = m.role === 'assistant' ? 'model' : 'user';
    const parts = [];
    if (typeof m.content === 'string') parts.push({ text: m.content });
    else for (const p of (Array.isArray(m.content) ? m.content : [])) {
      if (!p) continue;
      if (p.type === 'text') parts.push({ text: String(p.text || '') });
      else if ((p.type === 'image' || p.type === 'document') && p.source && p.source.type === 'base64') {
        parts.push({ inlineData: { mimeType: p.source.media_type, data: p.source.data } });
      }
    }
    if (!parts.length) parts.push({ text: ' ' });
    contents.push({ role, parts });
  }
  const g = {
    contents,
    generationConfig: { maxOutputTokens: Math.min(b.max_tokens + 4096, 12000) }
  };
  const sys = textOf(b.system);
  if (sys) g.systemInstruction = { parts: [{ text: sys }] };
  if (Array.isArray(b.tools) && b.tools.length) g.tools = [{ google_search: {} }];
  return g;
}
function fromGemini(d) {
  const cand = d && d.candidates && d.candidates[0];
  const text = ((cand && cand.content && cand.content.parts) || []).filter(p => p.text && !p.thought).map(p => p.text).join('');
  return { type: 'message', role: 'assistant', model: GEMINI_MODEL, content: [{ type: 'text', text }], stop_reason: cand && cand.finishReason === 'MAX_TOKENS' ? 'max_tokens' : 'end_turn' };
}

// ---------- penangan ----------
async function callGemini(b, res) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(GEMINI_MODEL) + ':generateContent';
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
    body: JSON.stringify(toGemini(b))
  });
  let d; try { d = await r.json(); } catch (e) { d = null; }
  if (!r.ok || !d || d.error) {
    const msg = (d && d.error && d.error.message) || ('Gemini http ' + r.status);
    console.log('Gemini error ' + r.status + ': ' + msg);
    return send(res, r.status >= 400 ? r.status : 502, { error: { message: msg } });
  }
  if (d.promptFeedback && d.promptFeedback.blockReason) return send(res, 422, { error: { message: 'Permintaan diblokir oleh Gemini: ' + d.promptFeedback.blockReason } });
  send(res, 200, fromGemini(d));
}
async function handleAI(req, res) {
  if (!checkCode(req, res)) return;
  if (!cekAkun(req, res)) return;
  if (!HAS_AI) return send(res, 500, { error: { message: 'GEMINI_API_KEY (atau ANTHROPIC_API_KEY) belum diisi di server.' } });
  if (limited(clientIp(req), 30)) return send(res, 429, { error: { message: 'Terlalu banyak permintaan. Coba lagi sebentar.' } });
  let b;
  try { b = JSON.parse(await readBody(req, MAX_BODY)); } catch (e) { return send(res, 400, { error: { message: 'Permintaan tidak valid.' } }); }
  if (!b || typeof b.model !== 'string' || !Array.isArray(b.messages)) return send(res, 400, { error: { message: 'Model atau pesan tidak valid.' } });
  b.max_tokens = Math.min(Number(b.max_tokens) || 1000, 8000);
  b.stream = false;
  if (Array.isArray(b.tools)) {
    b.tools = b.tools.filter(t => t && t.type === 'web_search_20250305').slice(0, 1);
    if (!b.tools.length) delete b.tools;
  } else delete b.tools;
  try {
    if (GEMINI_KEY) return await callGemini(b, res);
    if (!MODELS.includes(b.model)) return send(res, 400, { error: { message: 'Model tidak diizinkan.' } });
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(b)
    });
    const t = await r.text();
    res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(t);
  } catch (e) { send(res, 502, { error: { message: 'Tidak bisa menghubungi layanan AI.' } }); }
}
async function handleBaca(req, res) {
  if (!checkCode(req, res)) return;
  if (!cekAkun(req, res)) return;
  if (limited(clientIp(req), 20)) return send(res, 429, { pesan: 'Terlalu banyak permintaan. Coba lagi sebentar.' });
  let url;
  try { url = String(JSON.parse(await readBody(req, 10000)).url || '').trim(); } catch (e) { return send(res, 400, { pesan: 'Permintaan tidak valid.' }); }
  if (!/^https?:\/\/\S+\.\S+/i.test(url) || url.length > 2000) return send(res, 400, { pesan: 'Link tidak valid.' });
  try { send(res, 200, await bacaLink(url)); }
  catch (e) {
    const k = e && e.message;
    send(res, k === 'login' ? 401 : (PESAN[k] ? 422 : 502), { pesan: PESAN[k] || 'Link tidak bisa dibaca. Coba salin teks soal secara manual atau unggah foto.' });
  }
}
const server = http.createServer(async (req, res) => {
  try {
    const p = req.url.split('?')[0];
    if (req.method === 'GET' && p === '/healthz') return send(res, 200, { ok: true });
    if (req.method === 'GET' && p === '/api/ping') return send(res, 200, { aa: true, ai: HAS_AI, needCode: !!ACCESS_CODE });
    if (req.method === 'POST' && p === '/api/ai') return await handleAI(req, res);
    if (req.method === 'POST' && p === '/api/daftar') return await handleDaftar(req, res);
    if (req.method === 'POST' && p === '/api/admin') return await handleAdmin(req, res);
    if (req.method === 'GET' && p === '/admin') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      return fs.createReadStream(ADMIN_PAGE).pipe(res);
    }
    if (req.method === 'POST' && p === '/api/baca-link') return await handleBaca(req, res);
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      const html = fs.readFileSync(INDEX, 'utf8').replace(/<head[^>]*>/i, m => m + "<script>window.DEVICE_REGISTRY='/api/daftar';</script>");
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
      return res.end(html);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Tidak ditemukan');
  } catch (e) { if (!res.headersSent) send(res, 500, { pesan: 'Kesalahan server.' }); else res.end(); }
});

if (require.main === module) {
  ['SIGINT', 'SIGTERM'].forEach(sg => process.on(sg, () => { saveDb(true); process.exit(0); }));
  server.listen(PORT, '0.0.0.0', () => {
    console.log('Asisten Akademik berjalan di http://localhost:' + PORT);
    console.log('Beranda: http://localhost:' + PORT + '/');
    console.log(ADMIN_CODE ? 'Panel admin: http://localhost:' + PORT + '/admin' : 'PERINGATAN: ADMIN_CODE belum diisi, panel admin nonaktif.');
    console.log(GEMINI_KEY ? 'AI: Gemini (' + GEMINI_MODEL + ')' : (KEY ? 'AI: Anthropic' : 'PERINGATAN: GEMINI_API_KEY belum diisi, fitur AI belum akan jalan.'));
  });
}
module.exports = { parseForm, htmlToText, isPrivate, server, toGemini, fromGemini };
