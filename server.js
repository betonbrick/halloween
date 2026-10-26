'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const VALID_STATUS = new Set(['van', 'elfogyott']);

/* ------------------------------------------------------------------ *
 *  Tárolás: DATABASE_URL esetén Postgres (Renderen ez kell, mert az   *
 *  ingyenes webszolgáltatás fájlrendszere újraindításkor törlődik),   *
 *  különben egy egyszerű JSON fájl (helyi fejlesztéshez).             *
 * ------------------------------------------------------------------ */

function createFileStore() {
  const dir = process.env.DATA_DIR || path.join(__dirname, 'data');
  const file = path.join(dir, 'spots.json');
  fs.mkdirSync(dir, { recursive: true });
  let spots = [];
  try { spots = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { /* új fájl */ }
  let nextId = spots.reduce((m, s) => Math.max(m, s.id), 0) + 1;

  const save = () => {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(spots));
    fs.renameSync(tmp, file);
  };

  return {
    kind: 'file',
    async init() {},
    async list() { return spots.slice(); },
    async add({ name, note, lat, lng }) {
      const s = { id: nextId++, name, note, lat, lng, status: 'van', createdAt: new Date().toISOString() };
      spots.push(s);
      save();
      return s;
    },
    async setStatus(id, status) {
      const s = spots.find((x) => x.id === id);
      if (!s) return null;
      s.status = status;
      save();
      return s;
    },
    async remove(id) {
      const i = spots.findIndex((x) => x.id === id);
      if (i < 0) return false;
      spots.splice(i, 1);
      save();
      return true;
    },
  };
}

function createPgStore(url) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: url,
    ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false },
  });
  const toSpot = (r) => ({
    id: r.id,
    name: r.name,
    note: r.note,
    lat: r.lat,
    lng: r.lng,
    status: r.status,
    createdAt: new Date(r.created_at).toISOString(),
  });

  return {
    kind: 'postgres',
    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS spots (
          id         SERIAL PRIMARY KEY,
          name       TEXT NOT NULL,
          note       TEXT NOT NULL DEFAULT '',
          lat        DOUBLE PRECISION NOT NULL,
          lng        DOUBLE PRECISION NOT NULL,
          status     TEXT NOT NULL DEFAULT 'van',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
    },
    async list() {
      const r = await pool.query('SELECT * FROM spots ORDER BY id');
      return r.rows.map(toSpot);
    },
    async add({ name, note, lat, lng }) {
      const r = await pool.query(
        'INSERT INTO spots (name, note, lat, lng) VALUES ($1, $2, $3, $4) RETURNING *',
        [name, note, lat, lng]
      );
      return toSpot(r.rows[0]);
    },
    async setStatus(id, status) {
      const r = await pool.query('UPDATE spots SET status = $2 WHERE id = $1 RETURNING *', [id, status]);
      return r.rows[0] ? toSpot(r.rows[0]) : null;
    },
    async remove(id) {
      const r = await pool.query('DELETE FROM spots WHERE id = $1', [id]);
      return r.rowCount > 0;
    },
  };
}

const store = process.env.DATABASE_URL ? createPgStore(process.env.DATABASE_URL) : createFileStore();

/* ------------------------------ segédek ------------------------------ */

const cleanText = (v, max) =>
  typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function isAdmin(req) {
  const given = String(req.get('x-admin-token') || '');
  if (!ADMIN_TOKEN || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(ADMIN_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Egyszerű IP-alapú korlátozás az új helyek felvételére (spam ellen)
const hits = new Map();
function rateLimit(req, res, next) {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const max = 15;
  const list = (hits.get(req.ip) || []).filter((t) => now - t < windowMs);
  if (list.length >= max) {
    return res.status(429).json({ error: 'Túl sok új hely rövid idő alatt, próbáld kicsit később.' });
  }
  list.push(now);
  hits.set(req.ip, list);
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of hits) {
    const fresh = list.filter((t) => now - t < 10 * 60 * 1000);
    if (fresh.length) hits.set(ip, fresh); else hits.delete(ip);
  }
}, 5 * 60 * 1000).unref();

/* -------------------------------- app -------------------------------- */

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));
const PUBLIC_DIR = path.join(__dirname, 'public');
// Az index.html-t a public/ mappában keressük; ha oda nem került be
// (pl. rosszul töltötték fel GitHubra), a server.js melletti példányt használjuk.
const INDEX_CANDIDATES = [
  path.join(PUBLIC_DIR, 'index.html'),
  path.join(__dirname, 'index.html'),
];
const findIndex = () => INDEX_CANDIDATES.find((f) => fs.existsSync(f));

console.log('[start] server.js helye:', __dirname);
console.log('[start] index.html:', findIndex() || 'HIÁNYZIK');
try { console.log('[start] mappa tartalma:', fs.readdirSync(__dirname).join(', ')); } catch (_) {}

app.use(express.static(PUBLIC_DIR, { maxAge: '5m' }));

app.get('/', (_req, res) => {
  const file = findIndex();
  if (!file) {
    return res.status(500).type('text').send(
      'Hiányzik az index.html (sem public/, sem a server.js mellett).\n' +
      'A server.js mappájában: ' + fs.readdirSync(__dirname).join(', ')
    );
  }
  res.sendFile(file);
});

app.get('/healthz', (_req, res) => res.send('ok'));

app.get('/api/spots', wrap(async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await store.list());
}));

app.post('/api/spots', rateLimit, wrap(async (req, res) => {
  const name = cleanText(req.body && req.body.name, 60);
  const note = cleanText(req.body && req.body.note, 200);
  const lat = Number(req.body && req.body.lat);
  const lng = Number(req.body && req.body.lng);

  if (!name) return res.status(400).json({ error: 'Adj nevet a helynek!' });
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return res.status(400).json({ error: 'Érvénytelen koordináta.' });
  }

  const spot = await store.add({
    name,
    note,
    lat: Math.round(lat * 1e6) / 1e6,
    lng: Math.round(lng * 1e6) / 1e6,
  });
  res.status(201).json(spot);
}));

app.post('/api/spots/:id/status', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const status = req.body && req.body.status;
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Hibás azonosító.' });
  if (!VALID_STATUS.has(status)) return res.status(400).json({ error: 'Hibás státusz.' });
  const spot = await store.setStatus(id, status);
  if (!spot) return res.status(404).json({ error: 'Nincs ilyen hely.' });
  res.json(spot);
}));

app.delete('/api/spots/:id', wrap(async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Nincs jogosultság.' });
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Hibás azonosító.' });
  const ok = await store.remove(id);
  if (!ok) return res.status(404).json({ error: 'Nincs ilyen hely.' });
  res.json({ ok: true });
}));

app.use('/api', (_req, res) => res.status(404).json({ error: 'Nem található.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Szerverhiba, próbáld újra.' });
});

store.init()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Cukorvadászat fut a ${PORT} porton (tárolás: ${store.kind})`);
    });
  })
  .catch((err) => {
    console.error('Az adatbázis inicializálása sikertelen:', err);
    process.exit(1);
  });
