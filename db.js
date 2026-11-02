// db.js — SQLite database for Sartagoda Port Booking System.
// Uses Node's built-in node:sqlite (Node 22+), so there is nothing to
// `npm install` — just run `node server.js`.

const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(path.join(__dirname, 'anchorbook.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE,
    phone         TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    salt          TEXT NOT NULL,
    id_status     TEXT NOT NULL DEFAULT 'unverified',
    id_file_path  TEXT,
    id_mime_type  TEXT,
    id_uploaded_at TEXT,
    id_reviewed_at TEXT,
    id_review_note TEXT,
    created_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS login_attempts (
    email         TEXT PRIMARY KEY,
    failed_count  INTEGER NOT NULL DEFAULT 0,
    locked_until  TEXT
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id             TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL,
    ref            TEXT NOT NULL,
    passenger      TEXT NOT NULL,
    route          TEXT NOT NULL,
    date           TEXT NOT NULL,
    time           TEXT NOT NULL,
    passengers     INTEGER NOT NULL,
    seat_class     TEXT NOT NULL,
    contact        TEXT NOT NULL,
    total          INTEGER NOT NULL,
    payment_method TEXT,
    payment_status TEXT NOT NULL DEFAULT 'unpaid',
    payment_ref    TEXT,
    paid_at        TEXT,
    booking_status TEXT NOT NULL DEFAULT 'confirmed',
    queue_position INTEGER,
    created_at     TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// Migration for databases created before payments were added.
const bookingColumns = db.prepare("PRAGMA table_info(bookings)").all().map(c => c.name);
for (const [col, ddl] of [
  ['payment_method', 'ALTER TABLE bookings ADD COLUMN payment_method TEXT'],
  ['payment_status', "ALTER TABLE bookings ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'unpaid'"],
  ['payment_ref', 'ALTER TABLE bookings ADD COLUMN payment_ref TEXT'],
  ['paid_at', 'ALTER TABLE bookings ADD COLUMN paid_at TEXT']
]) {
  if (!bookingColumns.includes(col)) db.exec(ddl);
}

// Migration for databases created before session expiry was added.
const sessionColumns = db.prepare("PRAGMA table_info(sessions)").all().map(c => c.name);
if (!sessionColumns.includes('expires_at')) {
  db.exec("ALTER TABLE sessions ADD COLUMN expires_at TEXT NOT NULL DEFAULT '2000-01-01T00:00:00.000Z'");
  // Existing sessions from before this migration are treated as expired
  // so nobody stays logged in on a token that was never given a lifetime.
}

// Migration for databases created before ID verification was added.
const userColumns = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
for (const [col, ddl] of [
  ['id_status', "ALTER TABLE users ADD COLUMN id_status TEXT NOT NULL DEFAULT 'unverified'"],
  ['id_file_path', 'ALTER TABLE users ADD COLUMN id_file_path TEXT'],
  ['id_mime_type', 'ALTER TABLE users ADD COLUMN id_mime_type TEXT'],
  ['id_uploaded_at', 'ALTER TABLE users ADD COLUMN id_uploaded_at TEXT'],
  ['id_reviewed_at', 'ALTER TABLE users ADD COLUMN id_reviewed_at TEXT'],
  ['id_review_note', 'ALTER TABLE users ADD COLUMN id_review_note TEXT']
]) {
  if (!userColumns.includes(col)) db.exec(ddl);
}

// Migration for databases created before the queueing system was added.
{
  const cols = db.prepare("PRAGMA table_info(bookings)").all().map(c => c.name);
  for (const [col, ddl] of [
    ['booking_status', "ALTER TABLE bookings ADD COLUMN booking_status TEXT NOT NULL DEFAULT 'confirmed'"],
    ['queue_position', 'ALTER TABLE bookings ADD COLUMN queue_position INTEGER']
  ]) {
    if (!cols.includes(col)) db.exec(ddl);
  }
}

function purgeExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
}
purgeExpiredSessions();
setInterval(purgeExpiredSessions, 60 * 60 * 1000).unref();

module.exports = db;
