'use strict';
/*
 * Cyber Entertainment — site + JSON API + admin.
 *
 * This module exports a plain (req, res) handler and is used in two ways:
 *   - Vercel:  api/index.js re-exports `handler` (static files in /public are served by Vercel's CDN)
 *   - Local:   dev-server.js wraps `handler` in http.createServer() and also serves /public
 *
 * Storage:
 *   - Local            -> data/db.json + data/media/
 *   - Vercel + Blob    -> Vercel Blob (database JSON + uploaded images)
 *   - Vercel, no Blob  -> read-only: the site works from the bundled data/db.json,
 *                         admin saves answer with a clear "connect Blob" message instead of crashing.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DIR, 'db.json');
const MEDIA = path.join(DIR, 'media');
const PORT = +process.env.PORT || 3000;

const ON_VERCEL = !!process.env.VERCEL;
const BLOB_OK = !!(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);
const USE_BLOB = BLOB_OK;
const READONLY = ON_VERCEL && !BLOB_OK;
const STORAGE = USE_BLOB ? 'blob' : READONLY ? 'readonly' : 'local';
// A Vercel Blob store is either private or public. Match it here (default: private, recommended).
const ACCESS = process.env.BLOB_ACCESS === 'public' ? 'public' : 'private';
const BLOB_DB = process.env.BLOB_DB_PATH || 'cyber-entertainment/db.json';
const DB_TTL = 5000; // ms a serverless instance may reuse its copy of the database

const MAX_AUDIO = (+process.env.MAX_UPLOAD_MB || 300) * 1048576;
const MAX_IMG_LOCAL = 8 * 1048576;
const MAX_IMG_BLOB = 4 * 1048576; // Vercel Functions reject request bodies above ~4.5 MB
const AUD = ['.mp3', '.m4a', '.aac', '.wav', '.ogg'];
const IMG = ['.jpg', '.jpeg', '.png', '.webp'];
const AUDRE = /\.(mp3|m4a|aac|wav|ogg)(\?.*)?$/i;

if (!ON_VERCEL) { try { fs.mkdirSync(MEDIA, { recursive: true }); } catch { /* ignore */ } }

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.txt': 'text/plain', '.xml': 'application/xml', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
  '.aac': 'audio/aac', '.wav': 'audio/wav', '.ogg': 'audio/ogg'
};
const SEC = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'strict-origin-when-cross-origin' };

/* ---------- helpers ---------- */
const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });
const clone = v => JSON.parse(JSON.stringify(v));
const s = (v, n) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const web = v => (/^https?:\/\//.test(v) ? v : '');
const uid = () => crypto.randomUUID();
const idOr = v => (/^[\w-]{1,40}$/.test(v) ? v : uid());
const send = (r, c, o, h = {}) => {
  r.writeHead(c, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...h });
  r.end(JSON.stringify(o));
};

// @vercel/blob error classes do not set `.name`, so match on class name or message.
const isBlobErr = (e, cls, re) => !!e && ((e.constructor && e.constructor.name === cls) || e.name === cls || re.test(String(e.message)));
const isNotFound = e => isBlobErr(e, 'BlobNotFoundError', /does not exist/i);
const isConflict = e => !!e && (e.conflict === true || isBlobErr(e, 'BlobPreconditionFailedError', /ETag mismatch/i));

let blobApiPromise;
const blobApi = () => blobApiPromise || (blobApiPromise = import('@vercel/blob'));

// Image references may be an external link or a /media/<file> path.
const okImg = v => /^https?:\/\//.test(v) || (/^\/media\/[\w.\-]+$/.test(v) && (USE_BLOB || fs.existsSync(path.join(MEDIA, v.slice(7)))));

/* ---------- passwords + stateless sessions (work across serverless instances) ---------- */
const hash = (pw, salt = crypto.randomBytes(16).toString('hex')) => salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
const check = (pw, h) => {
  try {
    const [salt, key] = String(h).split(':');
    const a = Buffer.from(key, 'hex'), b = crypto.scryptSync(pw, salt, 64);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
};
// The signing key includes the password hash, so changing the password signs everyone out.
const sign = v => crypto.createHmac('sha256', (process.env.SESSION_SECRET || '') + '|' + db.admin).update(v).digest('hex');
const makeToken = () => { const v = (Date.now() + 288e5) + '.' + crypto.randomBytes(8).toString('hex'); return v + '.' + sign(v); };
const sid = q => ((q.headers.cookie || '').match(/cy_sid=([\w.\-]+)/) || [])[1];
const authed = q => {
  const a = (sid(q) || '').split('.');
  if (a.length !== 3 || !(+a[0] > Date.now())) return false;
  try {
    const x = Buffer.from(a[2], 'hex'), y = Buffer.from(sign(a[0] + '.' + a[1]), 'hex');
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  } catch { return false; }
};

// Best-effort rate limiting (per instance).
const hits = new Map();
const limited = (k, max, ms) => {
  const n = Date.now(), a = (hits.get(k) || []).filter(t => n - t < ms);
  a.push(n); hits.set(k, a);
  if (hits.size > 5000) for (const [key, v] of hits) if (!v.some(t => n - t < ms)) hits.delete(key);
  return a.length > max;
};

/* ---------- database ---------- */
const G = n => ({ id: uid(), name: n, description: 'Available for hire — message us for availability and rates.', price: '', available: true });
const DEF = {
  settings: { tagline: 'Great Vybz Nothingless', phone: '+256703046409', whatsapp: '256703046409', email: 'academy@cyberentertainment.com', address: 'Seguku Katale, Wankulukuku Road, Kampala', hours: 'Mon – Fri 8 AM – 8 PM · Sat 8 AM – 2 PM', instagram: '', youtube: '', tiktok: '', facebook: '' },
  gear: ['Controllers & Decks', 'Mixers', 'PA Speakers', 'Microphones', 'Stage Lighting', 'Effects & Extras'].map(G),
  djs: [['Deejay Cyber G', 'Founder · Lead DJ'], ['Deejay Tzo'], ['Deejay Kaks'], ['Jx Deejay'], ['Mr Genius']]
    .map(([n, t]) => ({ id: uid(), name: n, title: t || 'Cyber Entertainment DJ', bio: '', photo: '', available: true }))
};

let db = null, dbAt = 0, dbEtag = null, loading = null, tail = Promise.resolve();

const localDb = () => { try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return {}; } };

function normalize(d) {
  d.settings = { ...DEF.settings, ...(d.settings || {}) };
  if (!Array.isArray(d.gear)) d.gear = clone(DEF.gear);
  if (!Array.isArray(d.djs)) d.djs = clone(DEF.djs);
  for (const k of ['bookings', 'mixtapes', 'events']) if (!Array.isArray(d[k])) d[k] = [];
  if (!Array.isArray(d.shirts)) d.shirts = d.djs.map(x => ({ id: uid(), djId: x.id, name: x.name + ' Signature Tee', description: 'Official Cyber Entertainment tee.', price: 35000, sizes: 'S,M,L,XL,XXL', image: '', available: true }));
  if (!d.admin) {
    const pw = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
    d.admin = hash(pw);
    console.log('\n=== FIRST RUN ===\nAdmin URL: /admin\nPassword : ' + pw + '\nChange it in Admin > Account.\n');
  }
  return d;
}

async function persist() {
  if (READONLY) throw fail(503, 'Saving is disabled: no Vercel Blob store is connected to this deployment. Connect one in Vercel > Storage, then redeploy.');
  if (USE_BLOB) {
    try {
      const { put } = await blobApi();
      const opts = { access: ACCESS, allowOverwrite: true, addRandomSuffix: false, contentType: 'application/json' };
      if (dbEtag) opts.ifMatch = dbEtag; // optimistic concurrency: fail if another instance saved since we loaded
      await put(BLOB_DB, JSON.stringify(db, null, 1), opts);
    } catch (e) {
      if (isConflict(e)) throw Object.assign(fail(409, 'Someone else saved changes at the same moment. Please try again.'), { conflict: true });
      console.error('Blob save failed:', e);
      throw fail(503, 'Could not save to Vercel Blob. Check that BLOB_ACCESS matches your store (private/public) and that the store is connected.');
    }
  } else {
    fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db, null, 1));
    fs.renameSync(DB_FILE + '.tmp', DB_FILE);
  }
}

async function loadDb() {
  if (!USE_BLOB) { db = normalize(localDb()); dbAt = Date.now(); if (!READONLY) await persist(); return; }
  let next = null;
  dbEtag = null;
  try {
    const { get } = await blobApi();
    const res = await get(BLOB_DB, { access: ACCESS, useCache: false });
    if (res && res.stream) { next = JSON.parse(await new Response(res.stream).text()); dbEtag = (res.blob && res.blob.etag) || null; }
  } catch (e) {
    if (!isNotFound(e)) {
      // Never fall back to the seed on a real error: that would overwrite live data.
      console.error('Blob read failed:', e);
      throw fail(503, 'Storage is unavailable. Check the Vercel Blob connection and the BLOB_ACCESS setting.');
    }
  }
  if (next) { db = normalize(next); }
  else { db = normalize(localDb()); await persist(); } // first run: copy the bundled seed into Blob
  dbAt = Date.now();
}

function ensure(fresh) {
  if (db && !USE_BLOB) return Promise.resolve(); // local/read-only: memory is the source of truth
  if (db && !fresh && Date.now() - dbAt < DB_TTL) return Promise.resolve();
  if (!loading) loading = loadDb().finally(() => { loading = null; });
  return loading;
}
const locked = fn => { const run = tail.then(() => fn()); tail = run.catch(() => {}); return run; };
const save = () => persist();
// Run a read-modify-write on the freshly loaded database; retry if another instance saved first.
async function mutate(fn) {
  for (let i = 0; ; i++) {
    await ensure(true);
    try { return await fn(); }
    catch (e) {
      if (!isConflict(e) || i >= 8) throw e;
      await new Promise(ok => setTimeout(ok, 30 + Math.random() * 100 * (i + 1)));
    }
  }
}

// Delete local uploads no longer referenced (local mode only; only files older than 1 hour).
const sweep = () => {
  if (USE_BLOB || READONLY) return;
  try {
    const keep = new Set();
    db.mixtapes.forEach(x => x.file && keep.add(x.file));
    [...db.shirts, ...db.djs, ...db.events].forEach(x => { const m = (x.image || x.photo || '').match(/^\/media\/([\w.\-]+)$/); if (m) keep.add(m[1]); });
    fs.readdirSync(MEDIA).forEach(f => { try { if (!keep.has(f) && Date.now() - fs.statSync(path.join(MEDIA, f)).mtimeMs > 36e5) fs.unlinkSync(path.join(MEDIA, f)); } catch { /* ignore */ } });
  } catch { /* ignore */ }
};

/* ---------- public shapes ---------- */
const pub = x => ({ id: x.id, djId: x.djId, title: x.title, stream: x.file ? '/media/' + x.file : (AUDRE.test(x.url) ? x.url : ''), link: x.file || AUDRE.test(x.url) ? '' : x.url });
// Events: dates are plain YYYY-MM-DD (Kampala time, UTC+3). An empty date means "date to be announced".
const EVST = ['upcoming', 'soldout', 'postponed', 'cancelled'];
const dateOk = v => /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v + 'T00:00:00Z'));
const today = () => new Date(Date.now() + 108e5).toISOString().slice(0, 10);
const evSort = (a, b) => (a.date ? 0 : 1) - (b.date ? 0 : 1) || a.date.localeCompare(b.date);
const pubEv = x => ({ id: x.id, title: x.title, date: x.date, time: x.time, venue: x.venue, description: x.description, lineup: x.lineup, price: x.price, ticketUrl: x.ticketUrl, image: x.image, status: x.status });

/* ---------- request bodies ---------- */
function readStream(q, limit) {
  return new Promise((ok, no) => {
    const chunks = []; let n = 0, dead = false;
    q.on('data', c => { if (dead) return; n += c.length; if (n > limit) { dead = true; no(fail(413, 'Request too large.')); q.destroy(); } else chunks.push(c); });
    q.on('end', () => { if (!dead) ok(Buffer.concat(chunks)); });
    q.on('error', e => { if (!dead) { dead = true; no(e); } });
  });
}
const parseJson = t => { try { const v = JSON.parse(t || '{}'); return v && typeof v === 'object' ? v : {}; } catch { throw fail(400, 'Invalid JSON.'); } };
async function jsonBody(q) {
  let pre; // Vercel's Node helpers may already have parsed the body
  try { pre = q.body; } catch { throw fail(400, 'Invalid JSON.'); }
  if (Buffer.isBuffer(pre)) return parseJson(pre.toString('utf8'));
  if (typeof pre === 'string') return parseJson(pre);
  if (pre && typeof pre === 'object') return pre;
  return parseJson((await readStream(q, 5e5)).toString('utf8'));
}
async function rawBody(q, limit) {
  let pre; try { pre = q.body; } catch { pre = undefined; }
  if (Buffer.isBuffer(pre)) { if (pre.length > limit) throw fail(413, 'File too large (max ' + (limit >> 20) + ' MB).'); return pre; }
  return readStream(q, limit).catch(e => { throw e.status === 413 ? fail(413, 'File too large (max ' + (limit >> 20) + ' MB).') : e; });
}
const looksLikeImage = (b, ext) => {
  if (ext === '.png') return b.length > 8 && b.readUInt32BE(0) === 0x89504e47;
  if (ext === '.webp') return b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP';
  return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
};

/* ---------- API ---------- */
async function api(q, r, u) {
  const m = q.method, p = u.pathname;
  const ip = (q.headers['x-forwarded-for'] || '').split(',')[0].trim() || q.socket.remoteAddress || '?';

  if (m === 'GET' && p === '/api/health') return send(r, 200, { ok: true, storage: STORAGE, blobAccess: USE_BLOB ? ACCESS : undefined });
  await ensure(false);

  if (m === 'GET' && p === '/api/content') {
    return send(r, 200, { settings: db.settings, gear: db.gear, djs: db.djs, shirts: db.shirts.filter(x => x.available), mixtapes: db.mixtapes.filter(x => x.available).map(pub), events: db.events.filter(x => x.available && (!x.date || x.date >= today())).sort(evSort).map(pubEv) });
  }

  const dm = p.match(/^\/api\/mixtapes\/([\w-]+)\/download$/);
  if (m === 'GET' && dm) {
    const x0 = db.mixtapes.find(y => y.id === dm[1] && y.available);
    const target = x0 && (x0.file ? '/media/' + x0.file + '?dl=1' : x0.url);
    if (!target) return send(r, 404, { error: 'Not found' });
    try { // best-effort counter; a failure must never block the download
      await locked(() => mutate(async () => {
        const x = db.mixtapes.find(y => y.id === dm[1]);
        if (!x) return;
        x.downloads = (x.downloads || 0) + 1;
        await save();
      }));
    } catch (e) { console.error('Download count not saved:', e.message); }
    r.writeHead(302, { Location: target, 'Cache-Control': 'no-store' });
    return r.end();
  }

  if (m === 'POST' && p === '/api/bookings') {
    if (limited('b' + ip, 5, 6e5)) return send(r, 429, { error: 'Too many requests, try later.' });
    const b = await jsonBody(q);
    if (b.web) return send(r, 200, { ok: true }); // honeypot
    const x = { id: uid(), created: new Date().toISOString(), name: s(b.n, 80), phone: s(b.p, 30), service: s(b.s, 40), dj: s(b.dj, 80), date: s(b.d, 10), venue: s(b.v, 120), message: s(b.m, 1000), status: 'new', note: '' };
    if (!x.name || !x.phone) return send(r, 400, { error: 'Name and phone are required.' });
    await locked(() => mutate(async () => { db.bookings.unshift(x); db.bookings = db.bookings.slice(0, 5000); await save(); }));
    return send(r, 201, { ok: true });
  }

  if (m === 'POST' && p === '/api/login') {
    if (limited('l' + ip, 8, 9e5)) return send(r, 429, { error: 'Too many attempts. Wait 15 minutes.' });
    const b = await jsonBody(q);
    if (!check(String(b.password || ''), db.admin)) return send(r, 401, { error: 'Wrong password.' });
    const secure = (process.env.COOKIE_SECURE === '1' || q.headers['x-forwarded-proto'] === 'https') ? '; Secure' : '';
    return send(r, 200, { ok: true }, { 'Set-Cookie': `cy_sid=${makeToken()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure}` });
  }

  if (!p.startsWith('/api/admin/') && p !== '/api/logout') return send(r, 404, { error: 'Not found' });
  if (!authed(q)) return send(r, 401, { error: 'Login required' });
  if (m !== 'GET' && q.headers['x-requested-with'] !== 'admin') return send(r, 403, { error: 'Bad request' });
  if (p === '/api/logout') return send(r, 200, { ok: true }, { 'Set-Cookie': 'cy_sid=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict' });

  if (m === 'GET') {
    await ensure(true);
    if (p === '/api/admin/data') return send(r, 200, { settings: db.settings, gear: db.gear, djs: db.djs, shirts: db.shirts, mixtapes: db.mixtapes, events: db.events, bookings: db.bookings });
    if (p === '/api/admin/bookings.csv') {
      const c = v => '"' + String(v ?? '').replace(/"/g, '""').replace(/^([=+\-@\t\r])/, "'$1") + '"';
      const k = ['created', 'name', 'phone', 'service', 'dj', 'date', 'venue', 'message', 'status', 'note'];
      r.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename=bookings.csv', 'Cache-Control': 'no-store' });
      return r.end([k.join(',')].concat(db.bookings.map(b => k.map(x => c(b[x])).join(','))).join('\n'));
    }
    return send(r, 404, { error: 'Not found' });
  }

  if (m === 'POST' && p === '/api/admin/upload') return upload(q, r, u);

  const b = await jsonBody(q);
  return locked(() => mutate(() => admin(m, p, b, r)));
}

async function admin(m, p, b, r) {
  const bm = p.match(/^\/api\/admin\/bookings\/([\w-]+)$/);
  if (bm) {
    const i = db.bookings.findIndex(x => x.id === bm[1]);
    if (i < 0) return send(r, 404, { error: 'Not found' });
    if (m === 'DELETE') { db.bookings.splice(i, 1); await save(); return send(r, 200, { ok: true }); }
    if (m === 'PATCH') {
      if (['new', 'contacted', 'confirmed', 'done', 'cancelled'].includes(b.status)) db.bookings[i].status = b.status;
      if ('note' in b) db.bookings[i].note = s(b.note, 500);
      await save(); return send(r, 200, db.bookings[i]);
    }
  }
  if (m === 'PUT' && p === '/api/admin/settings') {
    for (const k of Object.keys(DEF.settings)) if (k in b) db.settings[k] = s(b[k], 200);
    db.settings.whatsapp = db.settings.whatsapp.replace(/\D/g, '');
    await save(); return send(r, 200, db.settings);
  }
  if (m === 'PUT' && p === '/api/admin/gear') {
    if (!Array.isArray(b.gear)) return send(r, 400, { error: 'Bad data' });
    db.gear = b.gear.slice(0, 100).map(g => ({ id: idOr(g.id), name: s(g.name, 80) || 'Untitled', description: s(g.description, 300), price: s(g.price, 40), available: !!g.available }));
    await save(); return send(r, 200, db.gear);
  }
  if (m === 'PUT' && p === '/api/admin/djs') {
    if (!Array.isArray(b.djs)) return send(r, 400, { error: 'Bad data' });
    db.djs = b.djs.slice(0, 50).map(d => ({ id: idOr(d.id), name: s(d.name, 60) || 'Untitled DJ', realName: s(d.realName, 60), title: s(d.title, 60), bio: s(d.bio, 600), genres: s(d.genres, 100), instagram: web(s(d.instagram, 300)), photo: okImg(s(d.photo, 300)) ? s(d.photo, 300) : '', available: !!d.available }));
    await save(); sweep(); return send(r, 200, db.djs);
  }
  if (m === 'PUT' && p === '/api/admin/shirts') {
    if (!Array.isArray(b.shirts)) return send(r, 400, { error: 'Bad data' });
    const ids = new Set(db.djs.map(d => d.id));
    db.shirts = b.shirts.slice(0, 300).filter(x => ids.has(x.djId)).map(x => ({ id: idOr(x.id), djId: x.djId, name: s(x.name, 80) || 'Untitled tee', description: s(x.description, 300), price: Math.max(0, Math.round(+x.price) || 0), sizes: s(x.sizes, 60) || 'S,M,L,XL', image: okImg(s(x.image, 300)) ? s(x.image, 300) : '', available: !!x.available }));
    await save(); sweep(); return send(r, 200, db.shirts);
  }
  if (m === 'PUT' && p === '/api/admin/events') {
    if (!Array.isArray(b.events)) return send(r, 400, { error: 'Bad data' });
    db.events = b.events.slice(0, 300).map(x => {
      const d = s(x.date, 10);
      return { id: idOr(x.id), title: s(x.title, 100) || 'Untitled event', date: dateOk(d) ? d : '', time: s(x.time, 30), venue: s(x.venue, 120), description: s(x.description, 600), lineup: s(x.lineup, 200), price: s(x.price, 60), ticketUrl: web(s(x.ticketUrl, 300)), image: okImg(s(x.image, 300)) ? s(x.image, 300) : '', status: EVST.includes(x.status) ? x.status : 'upcoming', available: !!x.available };
    });
    await save(); sweep(); return send(r, 200, db.events);
  }
  if (m === 'PUT' && p === '/api/admin/mixtapes') {
    if (!Array.isArray(b.mixtapes)) return send(r, 400, { error: 'Bad data' });
    const old = new Map(db.mixtapes.map(x => [x.id, x])), ids = new Set(db.djs.map(d => d.id));
    db.mixtapes = b.mixtapes.slice(0, 300).filter(x => ids.has(x.djId)).map(x => {
      const o = old.get(x.id), fn = s(x.file, 200), link = s(x.url, 300);
      const fileOk = /^[\w.\-]+$/.test(fn) && (fs.existsSync(path.join(MEDIA, fn)) || (o && o.file === fn));
      return { id: o ? o.id : uid(), djId: x.djId, title: s(x.title, 100) || 'Untitled mixtape', file: fileOk ? fn : '', url: web(link), available: !!x.available, downloads: o ? o.downloads || 0 : 0, created: o ? o.created : new Date().toISOString() };
    });
    await save(); sweep(); return send(r, 200, db.mixtapes);
  }
  if (m === 'POST' && p === '/api/admin/password') {
    if (!check(String(b.current || ''), db.admin)) return send(r, 400, { error: 'Current password is wrong.' });
    if (String(b.next || '').length < 10) return send(r, 400, { error: 'Use at least 10 characters.' });
    db.admin = hash(String(b.next)); await save(); return send(r, 200, { ok: true });
  }
  return send(r, 404, { error: 'Not found' });
}

async function upload(q, r, u) {
  const name = s(u.searchParams.get('name'), 100).replace(/[^\w.\-]+/g, '_');
  const ext = path.extname(name).toLowerCase(), isImg = IMG.includes(ext);
  if (!isImg && !AUD.includes(ext)) return send(r, 400, { error: 'Use an mp3, m4a, aac, wav, ogg (audio) or jpg, png, webp (image) file.' });
  const lim = isImg ? (USE_BLOB ? MAX_IMG_BLOB : MAX_IMG_LOCAL) : MAX_AUDIO;
  const len = +q.headers['content-length'] || 0;
  if (len > lim) return send(r, 413, { error: 'File too large (max ' + (lim >> 20) + ' MB).' });
  const file = uid() + '-' + name;

  if (READONLY) return send(r, 503, { error: 'Uploads are disabled: no Vercel Blob store is connected to this deployment.' });
  if (USE_BLOB) {
    if (!isImg) return send(r, 400, { error: 'Audio uploads are not supported on the live site. Paste a direct audio link or a YouTube/SoundCloud link instead.' });
    const buf = await rawBody(q, lim);
    if (!buf.length || !looksLikeImage(buf, ext)) return send(r, 400, { error: 'That file is not a valid ' + ext.slice(1) + ' image.' });
    try {
      const { put } = await blobApi();
      await put('media/' + file, buf, { access: ACCESS, addRandomSuffix: false, contentType: MIME[ext] || 'application/octet-stream' });
    } catch (e) {
      console.error('Blob upload failed:', e);
      return send(r, 500, { error: 'Upload failed. Check the Vercel Blob connection and the BLOB_ACCESS setting.' });
    }
    return send(r, 201, { file, size: buf.length });
  }

  // Local: stream straight to disk.
  const fp = path.join(MEDIA, file), ws = fs.createWriteStream(fp);
  let n = 0, dead = false;
  q.on('data', c => { n += c.length; if (n > lim && !dead) { dead = true; ws.destroy(); fs.unlink(fp, () => {}); send(r, 413, { error: 'File too large (max ' + (lim >> 20) + ' MB).' }); q.destroy(); } });
  ws.on('finish', () => { if (!dead) send(r, 201, { file, size: n }); });
  ws.on('error', () => { if (!dead) { dead = true; send(r, 500, { error: 'Upload failed' }); } });
  q.pipe(ws);
}

/* ---------- /media/<file>: bundled/local files first, then Vercel Blob ---------- */
async function media(q, r, u) {
  let f = '';
  try { f = decodeURIComponent(u.pathname.slice(7)); } catch { /* invalid */ }
  if (!/^[\w.\-]+$/.test(f)) { r.writeHead(404); return r.end('Not found'); }
  const ext = path.extname(f).toLowerCase();
  const h = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=86400, s-maxage=31536000' };
  if (u.searchParams.get('dl')) h['Content-Disposition'] = 'attachment; filename="' + f.slice(37).replace(/"/g, '') + '"';

  const fp = path.join(MEDIA, f);
  let st = null;
  try { st = await fs.promises.stat(fp); } catch { /* not on disk */ }
  if (st && st.isFile()) {
    let a = 0, b = st.size - 1, c = 200;
    const mr = /bytes=(\d*)-(\d*)/.exec(q.headers.range || '');
    if (mr && (mr[1] || mr[2])) {
      if (mr[1] === '') a = Math.max(0, st.size - +mr[2]); else { a = +mr[1]; if (mr[2]) b = Math.min(+mr[2], b); }
      if (a > b || a >= st.size) { r.writeHead(416, { 'Content-Range': 'bytes */' + st.size }); return r.end(); }
      c = 206; h['Content-Range'] = 'bytes ' + a + '-' + b + '/' + st.size;
    }
    h['Content-Length'] = b - a + 1; r.writeHead(c, h);
    if (q.method === 'HEAD') return r.end();
    return fs.createReadStream(fp, { start: a, end: b }).pipe(r);
  }

  if (USE_BLOB) {
    try {
      const { get } = await blobApi();
      const res = await get('media/' + f, { access: ACCESS });
      if (res && res.stream) {
        if (res.blob && res.blob.size) h['Content-Length'] = res.blob.size;
        r.writeHead(200, h);
        if (q.method === 'HEAD') return r.end();
        return Readable.fromWeb(res.stream).on('error', () => r.destroy()).pipe(r);
      }
    } catch (e) { if (!isNotFound(e)) console.error('Blob media read failed:', e); }
  }
  r.writeHead(404, { 'Content-Type': 'text/plain' }); r.end('Not found');
}

/* ---------- static files (local development only; Vercel's CDN serves /public) ---------- */
function serveStatic(q, r, u) {
  let p;
  try { p = decodeURIComponent(u.pathname); } catch { r.writeHead(400); return r.end('Bad request'); }
  if (p === '/admin' || p === '/store') p += '/';
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(PUB, p);
  if (!f.startsWith(PUB + path.sep) || /(^|[\\/])\./.test(p)) { r.writeHead(403); return r.end('Forbidden'); }
  fs.readFile(f, (e, d) => {
    if (e) { r.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' }); return r.end('<h1>404</h1><a href="/">Back home</a>'); }
    r.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': p.startsWith('/admin') ? 'no-store' : 'public, max-age=300' });
    r.end(d);
  });
}

/* ---------- entry point ---------- */
async function handler(q, r) {
  try {
    const u = new URL(q.url, 'http://x');
    Object.entries(SEC).forEach(([k, v]) => r.setHeader(k, v));
    if (u.pathname.startsWith('/media/')) return await media(q, r, u);
    if (u.pathname.startsWith('/api/')) return await api(q, r, u);
    return serveStatic(q, r, u);
  } catch (e) {
    const status = (e && e.status) || 500;
    if (status >= 500 && !(e && e.expose)) console.error('Request error:', e);
    if (!r.headersSent) send(r, status, { error: e && e.expose ? e.message : 'Server error' });
    else r.end();
  }
}

module.exports = { handler, init: () => ensure(true), PORT, STORAGE };
