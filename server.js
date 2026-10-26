'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ------------- Google Térkép link feloldás + címkeresés ------------- */
const maps = (() => {

/* ------------------------------------------------------------------ *
 *  Google Térkép linkek feloldása + címkeresés (geokódolás)           *
 * ------------------------------------------------------------------ */

const UA_BROWSER =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const UA_APP = 'cukorvadaszat/1.0 (Halloween cukorvadaszat webapp)';

// Csak Google-os hosztokat követünk (SSRF ellen)
const GOOGLE_HOST =
  /^(?:[a-z0-9-]+\.)*(?:google\.[a-z]{2,3}(?:\.[a-z]{2})?|goo\.gl|g\.co)$/i;

const NUM = '(-?\\d{1,3}(?:\\.\\d+)?)';
const SEP = '(?:,|%2C|%2c|\\+|%20|\\s)+';

const validLat = (v) => Number.isFinite(v) && Math.abs(v) <= 90;
const validLng = (v) => Number.isFinite(v) && Math.abs(v) <= 180;

function pair(m) {
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lng = parseFloat(m[2]);
  return validLat(lat) && validLng(lng) ? { lat, lng } : null;
}

/**
 * Koordináta keresése tetszőleges szövegben / URL-ben / HTML-ben.
 * Sorrend: a konkrét hely (!3d!4d) előbb, mint a nézet közepe (@).
 */
function coordsFromString(text) {
  if (!text) return null;
  const s = String(text);
  const patterns = [
    new RegExp('!3d' + NUM + '!4d' + NUM),
    new RegExp('[?&;](?:q|query|destination|daddr|ll|sll|center|cbll)=(?:loc:|loc%3A)?\\+?' + NUM + SEP + NUM, 'i'),
    new RegExp('/(?:place|search|dir)/' + NUM + ',' + NUM + '(?:[/?@]|$)'),
    new RegExp('@' + NUM + ',' + NUM),
    new RegExp('^\\s*' + NUM + '\\s*[,;\\s]\\s*' + NUM + '\\s*$'),
  ];
  for (const re of patterns) {
    const c = pair(s.match(re));
    if (c) return c;
  }
  return null;
}

/** Szöveges keresés a HTML-ben (a konkrét hely beágyazott adataiban) */
function coordsFromHtml(html) {
  const c = coordsFromString(html);
  if (c) return c;
  // APP_INITIALIZATION_STATE: [null,null,LAT,LNG]
  const m = String(html).match(/\[null,null,(-?\d{1,2}\.\d{3,}),(-?\d{1,3}\.\d{3,})\]/);
  return pair(m);
}

function safeDecode(s) {
  try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch (_) { return s; }
}

/** A hely neve a linkből: /maps/place/NÉV/... vagy ?q=NÉV */
function nameFromUrl(url) {
  let m = String(url).match(/\/maps\/place\/([^/@?]+)/);
  if (m) {
    const n = safeDecode(m[1]).trim();
    if (n && !coordsFromString(n)) return n;
  }
  m = String(url).match(/[?&](?:q|query)=([^&]+)/i);
  if (m) {
    const n = safeDecode(m[1]).trim();
    if (n && !coordsFromString(n)) return n;
  }
  return '';
}

/** Az első URL kinyerése egy megosztott szövegből ("Név\nhttps://maps.app.goo.gl/…") */
function extractUrl(text) {
  const m = String(text || '').match(/https?:\/\/[^\s<>"']+/i);
  return m ? m[0].replace(/[).,;]+$/, '') : '';
}

function googleUrlOrNull(u) {
  try {
    const url = new URL(u);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (!GOOGLE_HOST.test(url.hostname)) return null;
    url.protocol = 'https:';
    return url;
  } catch (_) {
    return null;
  }
}

/**
 * Google Térkép link (rövid vagy hosszú) → { lat, lng, name }
 * `fetchImpl` csak teszteléshez cserélhető.
 */
async function resolveMapsUrl(input, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const raw = extractUrl(input) || String(input || '').trim();

  const direct = coordsFromString(safeDecode(raw)) || coordsFromString(raw);
  if (direct && /^https?:/i.test(raw)) return { ...direct, name: nameFromUrl(raw) };

  let url = googleUrlOrNull(raw);
  if (!url) {
    const err = new Error('Ez nem Google Térkép link.');
    err.status = 400;
    throw err;
  }

  let lastUrl = url.href;
  for (let hop = 0; hop < 8; hop++) {
    const res = await doFetch(url.href, {
      redirect: 'manual',
      headers: {
        'User-Agent': UA_BROWSER,
        'Accept-Language': 'hu,en;q=0.8',
        // EU-s „cookie hozzájárulás” oldal kikerülése
        Cookie: 'CONSENT=YES+cb.20240101-00-p0.hu+FX+000; SOCS=CAI',
      },
      signal: AbortSignal.timeout(7000),
    });

    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      let next = new URL(res.headers.get('location'), url.href);
      // consent.google.com/…?continue=<valódi link>
      if (/^consent\./i.test(next.hostname) && next.searchParams.get('continue')) {
        next = new URL(next.searchParams.get('continue'));
      }
      lastUrl = next.href;
      const c = coordsFromString(next.href) || coordsFromString(safeDecode(next.href));
      if (c) return { ...c, name: nameFromUrl(next.href) };
      const safe = googleUrlOrNull(next.href);
      if (!safe) break; // nem Google – nem követjük
      url = safe;
      continue;
    }

    if (res.ok) {
      const html = (await res.text()).slice(0, 2_000_000);
      const c = coordsFromHtml(html);
      if (c) return { ...c, name: nameFromUrl(lastUrl) };
    }
    break;
  }

  // Nincs koordináta, de a név megvan → a hívó megpróbálhatja geokódolni
  const name = nameFromUrl(lastUrl);
  const err = new Error('Nem találtam koordinátát a linkben.');
  err.status = 422;
  err.name_ = name;
  throw err;
}

/* ----------------------------- geokódolás ----------------------------- */

function photonItem(f) {
  const p = (f && f.properties) || {};
  const g = f && f.geometry && f.geometry.coordinates;
  if (!g || g.length < 2) return null;
  const street = p.street ? p.street + (p.housenumber ? ' ' + p.housenumber : '') : '';
  const title = p.name || street || p.city || '';
  if (!title) return null;
  const place = p.city || p.town || p.village || p.locality || p.district || p.county || '';
  const sub = [];
  if (p.name && street && p.name !== street) sub.push(street);
  const pc = [p.postcode, place].filter(Boolean).join(' ');
  if (pc && pc !== title) sub.push(pc);
  if (p.country && !sub.length) sub.push(p.country);
  return { title, sub: sub.join(', '), lat: g[1], lng: g[0] };
}

function nominatimItem(r) {
  const parts = String(r.display_name || '').split(',').map((x) => x.trim()).filter(Boolean);
  const title = r.name || parts[0] || '';
  if (!title) return null;
  const rest = parts.filter((x) => x !== title);
  return {
    title,
    sub: rest.slice(0, 3).join(', '),
    lat: parseFloat(r.lat),
    lng: parseFloat(r.lon),
  };
}

const cache = new Map();
const CACHE_MAX = 500;
const CACHE_TTL = 10 * 60 * 1000;

async function geocode(q, bias, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  q = String(q || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  if (q.length < 3) return [];

  const lat = bias && Number.isFinite(bias.lat) ? bias.lat : null;
  const lng = bias && Number.isFinite(bias.lng) ? bias.lng : null;
  const key = q.toLowerCase() + '|' + (lat !== null ? lat.toFixed(1) + ',' + lng.toFixed(1) : '');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_TTL) return hit.v;

  const headers = { 'User-Agent': UA_APP, Accept: 'application/json' };
  let items = [];

  try {
    let u = 'https://photon.komoot.io/api/?limit=7&q=' + encodeURIComponent(q);
    if (lat !== null && lng !== null) u += '&lat=' + lat + '&lon=' + lng;
    const r = await doFetch(u, { headers, signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error('photon ' + r.status);
    const j = await r.json();
    items = (j.features || []).map(photonItem).filter(Boolean);
  } catch (_) {
    items = [];
  }

  if (!items.length) {
    try {
      let u = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=7&accept-language=hu&q=' + encodeURIComponent(q);
      if (lat !== null && lng !== null) {
        const d = 1.5; // kb. 150 km-es környék előnyben
        u += '&viewbox=' + [lng - d, lat + d, lng + d, lat - d].join(',');
      }
      const r = await doFetch(u, { headers, signal: AbortSignal.timeout(5000) });
      if (r.ok) items = (await r.json()).map(nominatimItem).filter(Boolean);
    } catch (_) { /* üres lista */ }
  }

  // duplikátumok szűrése
  const seen = new Set();
  items = items.filter((i) => {
    if (!validLat(i.lat) || !validLng(i.lng)) return false;
    const k = i.title + '|' + i.sub + '|' + i.lat.toFixed(4) + ',' + i.lng.toFixed(4);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 6);

  if (items.length) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, { t: Date.now(), v: items });
  }
  return items;
}


  return { coordsFromString, coordsFromHtml, nameFromUrl, extractUrl, resolveMapsUrl, geocode, photonItem };
})();

const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const VALID_STATUS = new Set(['van', 'elfogyott']);
// Ha PUBLIC_STATUS=false, az „elfogyott / van még” jelölést is csak az admin végezheti
const PUBLIC_STATUS = process.env.PUBLIC_STATUS !== 'false';

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

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Új helyet csak az admin vehet fel.' });
  next();
}

if (!ADMIN_TOKEN) {
  console.warn('[figyelem] Nincs ADMIN_TOKEN beállítva – új hely felvétele és törlés nem lehetséges!');
}

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

// A felület ebből tudja, hogy admin-e a látogató, és mit tehet
app.get('/api/config', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ admin: isAdmin(req), publicStatus: PUBLIC_STATUS });
});

app.post('/api/spots', requireAdmin, wrap(async (req, res) => {
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
  if (!PUBLIC_STATUS && !isAdmin(req)) return res.status(403).json({ error: 'Ezt csak az admin teheti.' });
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

// Google Térkép link (akár rövid: maps.app.goo.gl/…) → koordináta
app.get('/api/resolve', requireAdmin, wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const input = String(req.query.url || '').slice(0, 2000);
  try {
    return res.json(await maps.resolveMapsUrl(input));
  } catch (e) {
    // Ha van név, de koordináta nincs a linkben, megpróbáljuk név alapján megkeresni
    if (e.name_) {
      const found = await maps.geocode(e.name_, null);
      if (found.length) return res.json({ lat: found[0].lat, lng: found[0].lng, name: e.name_ });
    }
    const status = e.status || 502;
    const msg = status === 400 || status === 422
      ? e.message
      : 'Nem sikerült feloldani a linket. Nyisd meg a Google Térképen, és illeszd be a címsorból a hosszú linket, vagy a koordinátát.';
    if (!e.status) console.error('[resolve]', e && e.message);
    return res.status(status === 422 ? 422 : status === 400 ? 400 : 502).json({ error: msg });
  }
}));

// Címjavaslatok a hely nevéhez
app.get('/api/geocode', requireAdmin, wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  const bias = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  res.json(await maps.geocode(String(req.query.q || ''), bias));
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
