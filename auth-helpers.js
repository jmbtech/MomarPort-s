// auth-helpers.js — password hashing (scrypt), session tokens, and
// brute-force protection. Uses only Node's built-in crypto module.

const crypto = require('crypto');
const db = require('./db');

const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

const SESSION_COOKIE = 'anchorbook_session';

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, salt, expectedHash) {
  const { hash } = hashPassword(password, salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// --- Sessions ---

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS);
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, now.toISOString(), expiresAt.toISOString());
  return { token, expiresAt };
}

function getUserByToken(token) {
  if (!token) return null;
  const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!session) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return db.prepare('SELECT id, name, email, phone, id_status FROM users WHERE id = ?').get(session.user_id);
}

function deleteSession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

// --- Cookies (httpOnly, so client-side JS/XSS can't read the session token) ---

function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  });
  return cookies;
}

function appendCookie(res, cookieString) {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', cookieString);
  } else if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', [...existing, cookieString]);
  } else {
    res.setHeader('Set-Cookie', [existing, cookieString]);
  }
}

function setSessionCookie(res, token, expiresAt, secure) {
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${expiresAt.toUTCString()}`
  ];
  if (secure) attrs.push('Secure');
  appendCookie(res, attrs.join('; '));
}

function clearSessionCookie(res, secure) {
  const attrs = [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT'
  ];
  if (secure) attrs.push('Secure');
  appendCookie(res, attrs.join('; '));
}

function getSessionTokenFromRequest(req) {
  return parseCookies(req)[SESSION_COOKIE] || null;
}

// --- CSRF (double-submit cookie) ---
// csrf_token is readable by JS on purpose (unlike the session cookie) —
// the frontend echoes it back as a header on every state-changing
// request, and the server checks the two match. A cross-site page
// can make the browser send the cookie automatically, but it cannot
// read the cookie's value to also set the header, so forged requests
// from other origins fail this check even with SameSite alone.
const CSRF_COOKIE = 'csrf_token';

function ensureCsrfCookie(req, res, secure) {
  const existing = parseCookies(req)[CSRF_COOKIE];
  if (existing) return existing;
  const token = crypto.randomBytes(24).toString('hex');
  const attrs = [`${CSRF_COOKIE}=${token}`, 'Path=/', 'SameSite=Lax'];
  if (secure) attrs.push('Secure');
  appendCookie(res, attrs.join('; '));
  return token;
}

function verifyCsrf(req) {
  const cookieToken = parseCookies(req)[CSRF_COOKIE];
  const headerToken = req.headers['x-csrf-token'];
  return Boolean(cookieToken) && cookieToken === headerToken;
}

// --- Brute-force protection on login ---

function isLockedOut(email) {
  const row = db.prepare('SELECT * FROM login_attempts WHERE email = ?').get(email);
  if (!row || !row.locked_until) return false;
  if (new Date(row.locked_until).getTime() > Date.now()) return true;
  return false;
}

function recordFailedLogin(email) {
  const row = db.prepare('SELECT * FROM login_attempts WHERE email = ?').get(email);
  const count = (row ? row.failed_count : 0) + 1;
  const lockedUntil = count >= MAX_FAILED_LOGINS
    ? new Date(Date.now() + LOCKOUT_MS).toISOString()
    : null;

  if (row) {
    db.prepare('UPDATE login_attempts SET failed_count = ?, locked_until = ? WHERE email = ?')
      .run(count, lockedUntil, email);
  } else {
    db.prepare('INSERT INTO login_attempts (email, failed_count, locked_until) VALUES (?, ?, ?)')
      .run(email, count, lockedUntil);
  }
}

function clearFailedLogins(email) {
  db.prepare('DELETE FROM login_attempts WHERE email = ?').run(email);
}

// --- ID verification uploads ---
// Stored outside public/ so files are never served as static assets —
// only reachable through the authenticated endpoints in server.js.

const fs = require('fs');
const path = require('path');
const ID_UPLOAD_DIR = path.join(__dirname, 'uploads', 'ids');
fs.mkdirSync(ID_UPLOAD_DIR, { recursive: true });

const MAX_ID_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB

// Sniff real file type from bytes rather than trusting the client's
// declared MIME type, which is easy to spoof.
function sniffImageType(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
  ) {
    return 'image/png';
  }
  return null;
}

function saveIdImage(userId, dataUrl) {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || '');
  if (!match) {
    return { ok: false, error: 'Invalid image data.' };
  }
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length === 0) {
    return { ok: false, error: 'Invalid image data.' };
  }
  if (buffer.length > MAX_ID_IMAGE_BYTES) {
    return { ok: false, error: 'Image is too large (max 5MB).' };
  }
  const mimeType = sniffImageType(buffer);
  if (!mimeType) {
    return { ok: false, error: 'Only JPEG or PNG images are accepted.' };
  }
  const ext = mimeType === 'image/png' ? 'png' : 'jpg';
  const filePath = path.join(ID_UPLOAD_DIR, `${userId}.${ext}`);
  fs.writeFileSync(filePath, buffer);

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE users
     SET id_status = 'pending', id_file_path = ?, id_mime_type = ?, id_uploaded_at = ?, id_reviewed_at = NULL, id_review_note = NULL
     WHERE id = ?`
  ).run(filePath, mimeType, now, userId);

  return { ok: true };
}

function getIdImage(filePath) {
  if (!filePath) return null;
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(ID_UPLOAD_DIR)) return null; // guard against a corrupted path escaping the upload dir
  try {
    return fs.readFileSync(resolved);
  } catch {
    return null;
  }
}

module.exports = {
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
};
