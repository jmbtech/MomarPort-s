// server.js — Sartagoda Port Booking System backend.
// Zero npm dependencies: just run `node server.js` (Node 22+ required
// for the built-in node:sqlite module).

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const { getAvailability, assignSlot, reconcileSailing } = require('./sailing-queue');
const {
  hashPassword,
  verifyPassword,
  createSession,
  getUserByToken,
  deleteSession,
  setSessionCookie,
  clearSessionCookie,
  getSessionTokenFromRequest,
  ensureCsrfCookie,
  verifyCsrf,
  isLockedOut,
  recordFailedLogin,
  clearFailedLogins,
  saveIdImage,
  getIdImage
} = require('./auth-helpers');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
// Set FORCE_HTTPS=1 when this runs behind TLS so cookies get the Secure flag.
const COOKIES_SECURE = process.env.FORCE_HTTPS === '1';

// Admin key protects the ID-verification review endpoints. Set ADMIN_KEY
// yourself for a stable value; otherwise one is generated at boot and
// printed once below (it will change on restart).
const ADMIN_KEY = process.env.ADMIN_KEY || crypto.randomBytes(16).toString('hex');
if (!process.env.ADMIN_KEY) {
  console.log('');
  console.log('No ADMIN_KEY set — generated one for this run:');
  console.log('  ' + ADMIN_KEY);
  console.log('Use it to sign in at /admin.html. Set ADMIN_KEY yourself to keep it stable across restarts.');
  console.log('');
}

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

function readBody(req, maxBytes = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function getAuthedUser(req) {
  const token = getSessionTokenFromRequest(req);
  return { user: getUserByToken(token), token };
}

function isAdmin(req) {
  const key = req.headers['x-admin-key'];
  if (!key || typeof key !== 'string' || key.length !== ADMIN_KEY.length) return false;
  return crypto.timingSafeEqual(Buffer.from(key), Buffer.from(ADMIN_KEY));
}

// --- Simple in-memory rate limiters (per IP) ---
function makeLimiter(windowMs, max) {
  const buckets = new Map();
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [ip, bucket] of buckets) {
      if (bucket.windowStart < cutoff) buckets.delete(ip);
    }
  }, windowMs).unref();

  return function isLimited(ip) {
    const now = Date.now();
    const bucket = buckets.get(ip);
    if (!bucket || now - bucket.windowStart > windowMs) {
      buckets.set(ip, { windowStart: now, count: 1 });
      return false;
    }
    bucket.count++;
    return bucket.count > max;
  };
}

const authRateLimited = makeLimiter(60 * 1000, 15);   // tight: login/signup brute force
const apiRateLimited = makeLimiter(60 * 1000, 120);   // looser: general API abuse

function clientIp(req) {
  return req.socket.remoteAddress || 'unknown';
}

function serveStatic(req, res) {
  let filePath = req.url.split('?')[0];
  if (filePath === '/') filePath = '/index.html';
  const fullPath = path.join(PUBLIC_DIR, path.normalize(filePath));

  // Prevent path traversal outside of public/
  if (!fullPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(fullPath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const ext = path.extname(fullPath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

// Routes, trip times and fares for Sartagoda Port. Both directions run the
// same three trips. Bookings with any other route/time are rejected.
const ROUTES = ['Guihulngan - Tangil', 'Tangil - Guihulngan'];
const TRIP_TIMES = ['07:00 AM', '11:00 AM', '04:00 PM'];
const FARES = { Regular: 350, Child: 250, 'Senior/PWD': 280 };
const MAX_PASSENGERS = 20;
const PAYMENT_METHODS = {
  gcash: { label: 'GCash', refPrefix: 'GC-' }
};

async function handleApi(req, res, urlPath) {
  try {
    const ip = clientIp(req);

    if (urlPath.startsWith('/api/auth/') && authRateLimited(ip)) {
      return sendJson(res, 429, { ok: false, error: 'Too many requests. Please slow down and try again shortly.' });
    }
    if (apiRateLimited(ip)) {
      return sendJson(res, 429, { ok: false, error: 'Too many requests. Please slow down and try again shortly.' });
    }

    // CSRF check on every state-changing request. Safe (read-only) methods
    // are exempt since they can't be exploited to change server state.
    const isMutating = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method);
    if (isMutating && !verifyCsrf(req)) {
      return sendJson(res, 403, { ok: false, error: 'Request could not be verified. Please refresh the page and try again.' });
    }

    // --- Auth ---
    if (urlPath === '/api/auth/signup' && req.method === 'POST') {
      const { name, email, phone, password } = await readBody(req);
      if (!name || !email || !phone || !password) {
        return sendJson(res, 400, { ok: false, error: 'All fields are required.' });
      }
      if (name.length > 100 || email.length > 200 || phone.length > 30) {
        return sendJson(res, 400, { ok: false, error: 'One of the fields is too long.' });
      }
      if (password.length < 8) {
        return sendJson(res, 400, { ok: false, error: 'Password must be at least 8 characters.' });
      }
      const normalizedEmail = email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
        return sendJson(res, 400, { ok: false, error: 'Enter a valid email address.' });
      }
      const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail);
      if (existing) {
        return sendJson(res, 409, { ok: false, error: 'An account with that email already exists.' });
      }
      const { hash, salt } = hashPassword(password);
      const id = 'U-' + crypto.randomBytes(4).toString('hex').toUpperCase();
      db.prepare(
        'INSERT INTO users (id, name, email, phone, password_hash, salt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(id, name.trim(), normalizedEmail, phone.trim(), hash, salt, new Date().toISOString());

      const { token, expiresAt } = createSession(id);
      setSessionCookie(res, token, expiresAt, COOKIES_SECURE);
      return sendJson(res, 201, {
        ok: true,
        user: { id, name: name.trim(), email: normalizedEmail, phone: phone.trim(), id_status: 'unverified' }
      });
    }

    if (urlPath === '/api/auth/login' && req.method === 'POST') {
      const { email, password } = await readBody(req);
      const normalizedEmail = (email || '').trim().toLowerCase();

      if (isLockedOut(normalizedEmail)) {
        return sendJson(res, 429, { ok: false, error: 'Too many failed attempts. Please try again in 15 minutes.' });
      }

      const user = db.prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail);
      const valid = user && verifyPassword(password || '', user.salt, user.password_hash);

      if (!valid) {
        if (normalizedEmail) recordFailedLogin(normalizedEmail);
        return sendJson(res, 401, { ok: false, error: 'Email or password is incorrect.' });
      }

      clearFailedLogins(normalizedEmail);
      const { token, expiresAt } = createSession(user.id);
      setSessionCookie(res, token, expiresAt, COOKIES_SECURE);
      return sendJson(res, 200, {
        ok: true,
        user: { id: user.id, name: user.name, email: user.email, phone: user.phone, id_status: user.id_status }
      });
    }

    if (urlPath === '/api/auth/logout' && req.method === 'POST') {
      const { token } = getAuthedUser(req);
      if (token) deleteSession(token);
      clearSessionCookie(res, COOKIES_SECURE);
      return sendJson(res, 200, { ok: true });
    }

    if (urlPath === '/api/auth/me' && req.method === 'GET') {
      const { user } = getAuthedUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Not logged in.' });
      return sendJson(res, 200, { ok: true, user });
    }

    // --- ID verification ---
    if (urlPath === '/api/account/id-verification' && req.method === 'GET') {
      const { user } = getAuthedUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Not logged in.' });
      const row = db.prepare(
        'SELECT id_status, id_uploaded_at, id_reviewed_at, id_review_note FROM users WHERE id = ?'
      ).get(user.id);
      return sendJson(res, 200, { ok: true, verification: row });
    }

    if (urlPath === '/api/account/id-verification' && req.method === 'POST') {
      const { user } = getAuthedUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Not logged in.' });
      const { imageDataUrl } = await readBody(req);
      const result = saveIdImage(user.id, imageDataUrl);
      if (!result.ok) return sendJson(res, 400, { ok: false, error: result.error });
      return sendJson(res, 200, { ok: true, id_status: 'pending' });
    }

    if (urlPath === '/api/account/id-verification/image' && req.method === 'GET') {
      const { user } = getAuthedUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Not logged in.' });
      const row = db.prepare('SELECT id_file_path, id_mime_type FROM users WHERE id = ?').get(user.id);
      const buf = row && getIdImage(row.id_file_path);
      if (!buf) return sendJson(res, 404, { ok: false, error: 'No ID on file.' });
      res.writeHead(200, { 'Content-Type': row.id_mime_type });
      return res.end(buf);
    }

    // --- Admin: ID verification review ---
    if (urlPath === '/api/admin/id-verifications' && req.method === 'GET') {
      if (!isAdmin(req)) return sendJson(res, 401, { ok: false, error: 'Invalid admin key.' });
      const rows = db.prepare(
        `SELECT id, name, email, id_status, id_uploaded_at, id_reviewed_at, id_review_note
         FROM users WHERE id_status != 'unverified' ORDER BY id_uploaded_at DESC`
      ).all();
      return sendJson(res, 200, { ok: true, users: rows });
    }

    const adminImageMatch = urlPath.match(/^\/api\/admin\/id-verifications\/([^/]+)\/image$/);
    if (adminImageMatch && req.method === 'GET') {
      if (!isAdmin(req)) return sendJson(res, 401, { ok: false, error: 'Invalid admin key.' });
      const row = db.prepare('SELECT id_file_path, id_mime_type FROM users WHERE id = ?').get(adminImageMatch[1]);
      const buf = row && getIdImage(row.id_file_path);
      if (!buf) return sendJson(res, 404, { ok: false, error: 'No ID on file.' });
      res.writeHead(200, { 'Content-Type': row.id_mime_type });
      return res.end(buf);
    }

    const adminDecisionMatch = urlPath.match(/^\/api\/admin\/id-verifications\/([^/]+)$/);
    if (adminDecisionMatch && req.method === 'POST') {
      if (!isAdmin(req)) return sendJson(res, 401, { ok: false, error: 'Invalid admin key.' });
      const { status, note } = await readBody(req);
      if (!['verified', 'rejected'].includes(status)) {
        return sendJson(res, 400, { ok: false, error: 'Status must be verified or rejected.' });
      }
      db.prepare(
        `UPDATE users SET id_status = ?, id_reviewed_at = ?, id_review_note = ? WHERE id = ?`
      ).run(status, new Date().toISOString(), (note || '').slice(0, 300), adminDecisionMatch[1]);
      return sendJson(res, 200, { ok: true });
    }

    // --- Sailing availability (for the queue system) ---
    if (urlPath === '/api/sailings/availability' && req.method === 'GET') {
      const { user } = getAuthedUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Not logged in.' });
      const parsed = new URL(req.url, 'http://localhost');
      const route = parsed.searchParams.get('route');
      const date = parsed.searchParams.get('date');
      const time = parsed.searchParams.get('time');
      if (!route || !date || !time) {
        return sendJson(res, 400, { ok: false, error: 'route, date, and time are required.' });
      }
      return sendJson(res, 200, { ok: true, ...getAvailability(route, date, time) });
    }

    // --- Bookings (all require auth + a verified ID, all scoped to the owner) ---
    if (urlPath === '/api/bookings' && req.method === 'GET') {
      const { user } = getAuthedUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Not logged in.' });
      const rows = db
        .prepare('SELECT * FROM bookings WHERE user_id = ? ORDER BY created_at DESC')
        .all(user.id);
      return sendJson(res, 200, { ok: true, bookings: rows });
    }

    if (urlPath === '/api/bookings' && req.method === 'POST') {
      const { user } = getAuthedUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Not logged in.' });
      if (user.id_status !== 'verified') {
        return sendJson(res, 403, { ok: false, error: 'Please verify a valid ID before booking.', id_status: user.id_status });
      }

      const { passenger, route, date, time, counts, contact } = await readBody(req);
      if (!passenger || !route || !date || !time || !counts || !contact) {
        return sendJson(res, 400, { ok: false, error: 'Please fill in all fields.' });
      }
      if (passenger.length > 100 || contact.length > 30) {
        return sendJson(res, 400, { ok: false, error: 'One of the fields is too long.' });
      }
      if (!ROUTES.includes(route)) {
        return sendJson(res, 400, { ok: false, error: 'Invalid route.' });
      }
      if (!TRIP_TIMES.includes(time)) {
        return sendJson(res, 400, { ok: false, error: 'Invalid trip time.' });
      }
      // Travel date must be a YYYY-MM-DD string that is today or later (Philippine time).
      const todayPH = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
      if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < todayPH) {
        return sendJson(res, 400, { ok: false, error: 'Pick a valid travel date (today or later).' });
      }

      // Count each passenger type (Regular / Child / Senior-PWD) and price it server-side.
      let passengerCount = 0;
      let total = 0;
      const parts = [];
      for (const [type, fare] of Object.entries(FARES)) {
        const n = counts[type] === undefined ? 0 : Number(counts[type]);
        if (!Number.isInteger(n) || n < 0 || n > MAX_PASSENGERS) {
          return sendJson(res, 400, { ok: false, error: 'Invalid passenger count.' });
        }
        if (n > 0) parts.push(`${type} x${n}`);
        passengerCount += n;
        total += n * fare;
      }
      if (passengerCount < 1 || passengerCount > MAX_PASSENGERS) {
        return sendJson(res, 400, { ok: false, error: 'Number of passengers must be between 1 and 20.' });
      }
      const seatClass = parts.join(', ');
      const ref = 'BLD-' + Math.floor(100000 + Math.random() * 900000);
      const id = crypto.randomUUID();
      const slot = assignSlot(route, date, time, passengerCount);

      db.prepare(
        `INSERT INTO bookings (id, user_id, ref, passenger, route, date, time, passengers, seat_class, contact, total, payment_status, booking_status, queue_position, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unpaid', ?, ?, ?)`
      ).run(id, user.id, ref, passenger, route, date, time, passengerCount, seatClass, contact, total, slot.booking_status, slot.queue_position, new Date().toISOString());

      const booking = db.prepare('SELECT * FROM bookings WHERE id = ? AND user_id = ?').get(id, user.id);
      return sendJson(res, 201, { ok: true, booking });
    }

    // --- Payment (simulated — see README): GCash only ---
    const payMatch = urlPath.match(/^\/api\/bookings\/([^/]+)\/pay$/);
    if (payMatch && req.method === 'POST') {
      const { user } = getAuthedUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Not logged in.' });

      const bookingId = payMatch[1];
      const booking = db.prepare('SELECT * FROM bookings WHERE id = ? AND user_id = ?').get(bookingId, user.id);
      if (!booking) return sendJson(res, 404, { ok: false, error: 'Booking not found.' });
      if (booking.booking_status === 'queued') {
        return sendJson(res, 403, { ok: false, error: `You're still in the queue (position ${booking.queue_position}) — you can pay once a seat is confirmed.` });
      }
      if (booking.payment_status === 'paid') {
        return sendJson(res, 409, { ok: false, error: 'This booking is already paid.' });
      }

      const { method } = await readBody(req);
      if (method !== 'gcash') {
        return sendJson(res, 400, { ok: false, error: 'Only GCash payments are accepted.' });
      }
      const { label, refPrefix } = PAYMENT_METHODS.gcash;
      const paymentRef = refPrefix + crypto.randomBytes(5).toString('hex').toUpperCase();
      db.prepare(
        `UPDATE bookings SET payment_method = ?, payment_status = 'paid', payment_ref = ?, paid_at = ? WHERE id = ? AND user_id = ?`
      ).run(label, paymentRef, new Date().toISOString(), bookingId, user.id);

      const updated = db.prepare('SELECT * FROM bookings WHERE id = ? AND user_id = ?').get(bookingId, user.id);
      return sendJson(res, 200, { ok: true, booking: updated });
    }

    const cancelMatch = urlPath.match(/^\/api\/bookings\/([^/]+)$/);
    if (cancelMatch && req.method === 'DELETE') {
      const { user } = getAuthedUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Not logged in.' });
      const bookingId = cancelMatch[1];
      const booking = db.prepare('SELECT * FROM bookings WHERE id = ? AND user_id = ?').get(bookingId, user.id);
      if (!booking) return sendJson(res, 404, { ok: false, error: 'Booking not found.' });
      db.prepare('DELETE FROM bookings WHERE id = ? AND user_id = ?').run(bookingId, user.id);
      reconcileSailing(booking.route, booking.date, booking.time);
      return sendJson(res, 200, { ok: true });
    }

    sendJson(res, 404, { ok: false, error: 'Not found.' });
  } catch (err) {
    // Never leak internals (stack traces, query text) to the client.
    sendJson(res, 500, { ok: false, error: 'Server error.' });
  }
}

const server = http.createServer((req, res) => {
  // Baseline security headers on every response.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'"
  );
  if (COOKIES_SECURE) {
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  }

  // Every response carries a CSRF cookie so the frontend always has a
  // fresh token to echo back on its next state-changing request.
  ensureCsrfCookie(req, res, COOKIES_SECURE);

  const urlPath = req.url.split('?')[0];
  if (urlPath.startsWith('/api/')) {
    handleApi(req, res, urlPath);
  } else {
    serveStatic(req, res);
  }
});

server.listen(PORT, () => {
  console.log(`Sartagoda Port Booking System running at http://localhost:${PORT}`);
  console.log(`Database file: ${path.join(__dirname, 'anchorbook.db')}`);
});
