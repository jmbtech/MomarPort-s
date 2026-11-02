# Sartagoda Port Booking System

A ferry booking site for Sartagoda Port: accounts, ID verification, and
bookings all backed by a real SQLite database on the server.

## Requirements

- Node.js 22.5 or newer (for the built-in `node:sqlite` module)

No `npm install` is required — the backend uses only Node's built-in
modules (`http`, `node:sqlite`, `crypto`, `fs`).

## Run it

```bash
node server.js
```

Then open **http://localhost:3000** in your browser.

A file named `anchorbook.db` will be created automatically in this folder
the first time the server starts — that's your database. Uploaded ID
photos are saved to `uploads/ids/` (not inside `public/`, so they're
never served as plain static files). Delete both if you ever want to
wipe everything and start fresh.

On first boot, if you haven't set `ADMIN_KEY`, the console prints a
generated admin key — save it, you'll need it at `/admin.html` to
review ID submissions. Set `ADMIN_KEY=yourkey node server.js` to keep
it stable across restarts.

## What's in here

- `server.js` — HTTP server: serves the frontend and the JSON API
- `db.js` — creates the SQLite tables (`users`, `sessions`,
  `login_attempts`, `bookings`)
- `auth-helpers.js` — password hashing, sessions, CSRF, brute-force
  lockout, ID-image storage
- `sailing-queue.js` — seat capacity and FIFO waitlist per sailing
- `public/` — the frontend (HTML/CSS/JS), including `verify.html`
  (upload your ID) and `admin.html` (review submissions)

## API

| Method | Path                             | Auth  | Description                        |
|--------|----------------------------------|-------|-------------------------------------|
| POST   | /api/auth/signup                 | —     | Create an account                   |
| POST   | /api/auth/login                  | —     | Log in                              |
| POST   | /api/auth/logout                 | ✓     | Log out                             |
| GET    | /api/auth/me                     | ✓     | Current logged-in user + ID status  |
| GET    | /api/account/id-verification     | ✓     | Your ID verification status         |
| POST   | /api/account/id-verification     | ✓     | Upload an ID photo for review       |
| GET    | /api/account/id-verification/image | ✓   | View your own uploaded ID           |
| GET    | /api/admin/id-verifications      | admin | List submitted ID verifications     |
| GET    | /api/admin/id-verifications/:id/image | admin | View a submitted ID photo      |
| POST   | /api/admin/id-verifications/:id  | admin | Approve or reject an ID             |
| GET    | /api/sailings/availability        | ✓     | Seats left / queue length for a route+date+time |
| GET    | /api/bookings                    | ✓     | List your bookings                  |
| POST   | /api/bookings                    | ✓     | Create a booking; body has `counts` per passenger type (requires verified ID) |
| POST   | /api/bookings/:id/pay             | ✓     | Pay a booking with GCash — confirmed bookings only |
| DELETE | /api/bookings/:id                | ✓     | Cancel a booking (may promote queued bookings) |

Authenticated requests are identified by an `httpOnly` session cookie
the browser sends automatically. Admin requests instead send an
`X-Admin-Key` header. All state-changing requests (POST/PUT/DELETE)
also require a matching `X-CSRF-Token` header — see Security below.

## ID verification

Booking a crossing now requires a verified government ID, matching how
real ferry/travel bookings work in the Philippines:

1. After signing up, go to **Verify ID** (linked in the nav) and
   upload a photo of a passport, driver's license, national ID, or
   UMID (JPEG/PNG, max 5MB).
2. The submission goes to `pending`. The booking form stays disabled
   with a banner explaining why until it's reviewed.
3. An admin reviews it at **/admin.html** using the admin key, and
   approves or rejects it (with an optional note shown to the user on
   rejection).
4. Once `verified`, the booking form unlocks.

The photo itself is stored on disk outside `public/` and is never
served as a static file — it's only reachable through the
authenticated "view my ID" and admin "view submission" endpoints, and
the server checks the actual file bytes (not just the filename) to
confirm it's really a JPEG or PNG before saving it.

## Queueing

Each trip (a specific route + date + time, e.g. Guihulngan → Tangil on
2026-08-20 at 7:00 AM) has a fixed seat capacity — 50 by default, set
`SAILING_CAPACITY` to change it.

- A new booking that fits in the remaining seats is **confirmed**
  immediately.
- If the sailing is full, the booking joins a **FIFO queue** instead.
  The booking form shows live availability ("12 seats left" / "Sailing
  full — you'll join the queue") as soon as a route, date, and time are
  picked.
- **Fairness**: once anyone is waiting, later bookings queue behind
  them too, even if they'd technically fit in the leftover seats — no
  cutting the line.
- Queued bookings can't be paid yet (the pay endpoint rejects them);
  the person just sees their queue position on **My Bookings**.
- When a confirmed booking is cancelled, the freed seats are offered to
  the queue in order — as many waiting bookings get promoted to
  confirmed as now fit, and everyone still waiting gets renumbered so
  positions stay 1, 2, 3… with no gaps.
- Cancelling a queued booking (not just a confirmed one) also
  renumbers the rest of the queue.

This all happens server-side (`sailing-queue.js`), so it stays correct
even if multiple people are booking the same sailing at once.

## Routes, trips & fares

- **Routes:** Guihulngan → Tangil and Tangil → Guihulngan
- **Trips (both directions):** 7:00 AM, 11:00 AM, 4:00 PM
- **Fares per passenger:** Regular ₱350 · Child (bata) ₱250 · Senior / PWD ₱280

A booking can mix passenger types (e.g. 2 Regular + 1 Child). The
server calculates the total from its own price list and only accepts
the routes and trip times above. The `seat_class` column stores the
breakdown, e.g. `Regular x2, Child x1`.

## Payments

Payment is **GCash only**. After filling in the trip details, the
person scans a QR code with the GCash app and taps "I've Scanned & Paid".

- The checkout is a simulated wallet flow: a QR code appears (styled
  like a merchant QR, with the standard finder-pattern corners).
  **This QR is a visual sandbox pattern only — it does not encode real
  payment data and cannot be scanned by a GCash app to move money.**
  Every screen in this flow is labeled "Sandbox" for that reason. On
  confirmation the booking is marked `paid` with a mock reference like
  `GC-4EB39A1053`.

To accept *real* GCash payments, you need to register as a merchant
with GCash (or a gateway that supports GCash, like PayMongo or Xendit),
which issues real merchant QR codes and API credentials. That can't be
faked into working from a codebase alone.

## Security

Protections in place for user credentials and everyone's booking and
ID data:

- **Passwords** are hashed with scrypt + a per-user random salt, and
  compared with a timing-safe check — never stored or logged in plain
  text.
- **Sessions** use a random 256-bit token delivered as an `httpOnly`,
  `SameSite=Lax` cookie, not `localStorage` — client-side JavaScript
  (and therefore XSS) can't read or exfiltrate it. Sessions expire
  after 7 days and are purged from the database automatically.
- **CSRF protection**: a separate, JS-readable `csrf_token` cookie is
  issued on every request; the frontend echoes it back as an
  `X-CSRF-Token` header on every state-changing request, and the
  server rejects the request if the header doesn't match the cookie.
  A malicious site can make your browser send the session cookie, but
  it can't read the CSRF cookie to forge the matching header.
- **Login brute-forcing** is throttled: 5 failed attempts on one email
  locks it out for 15 minutes. All `/api/auth/*` endpoints are
  additionally rate-limited per IP, and the rest of the API has a
  broader rate limit too.
- **Every booking and ID document is scoped to its owner** at the
  database query level (`WHERE user_id = ?`) — one account can never
  read, pay, or cancel another account's bookings, or view another
  person's ID photo, even by guessing an ID.
- **ID uploads are validated by content, not filename**: the server
  reads the actual file header bytes to confirm it's a real JPEG/PNG
  before saving, rejects anything else, and caps size at 5MB. Files
  live outside the web root and require authentication to view.
- **Admin actions require a separate key** (`X-Admin-Key`), checked
  with a timing-safe comparison, distinct from normal user sessions —
  a compromised user account can't reach admin endpoints.
- **Generic error messages** on login ("email or password is
  incorrect") avoid confirming which registered emails exist.
- Responses carry standard hardening headers: `Content-Security-Policy`
  (blocking inline scripts and cross-origin script sources),
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and
  `Referrer-Policy: no-referrer`.
- Server errors return a generic message instead of leaking stack
  traces or query details.

Still worth doing before this ever faces real users:
- **Run it behind HTTPS** (a reverse proxy like Caddy or nginx is the
  usual approach) and set `FORCE_HTTPS=1` when you start the server —
  that adds the `Secure` cookie flag and HSTS header.
- Email verification, so people can't sign up with an email they don't
  own.
- A proper audit log of login attempts, admin decisions, and payment
  events.
- Real GCash merchant integration, if you want actual money to
  move (see Payments above).

This is a solid, learning/prototype-grade setup — good practices
throughout, but not a substitute for a professional security review
if you're taking real money or real personal/ID data in production.
