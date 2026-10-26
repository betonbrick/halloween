'use strict';

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

module.exports = { coordsFromString, coordsFromHtml, nameFromUrl, extractUrl, resolveMapsUrl, geocode, photonItem };
