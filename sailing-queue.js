// sailing-queue.js — per-sailing seat capacity and FIFO waitlist.
//
// A "sailing" is one route + date + time slot (e.g. "Guihulngan - Tangil"
// on 2026-08-20 at 07:00 AM). Each sailing has a fixed passenger
// capacity. Bookings that fit go straight to `confirmed`; bookings
// that don't fit are placed in a `queued` waitlist in the order they
// arrived. When a confirmed booking is cancelled, freed seats are
// offered to the queue in order.

const db = require('./db');

const CAPACITY = parseInt(process.env.SAILING_CAPACITY || '50', 10);

function confirmedSeatsUsed(route, date, time, excludeBookingId) {
  const row = db.prepare(
    `SELECT COALESCE(SUM(passengers), 0) AS total FROM bookings
     WHERE route = ? AND date = ? AND time = ? AND booking_status = 'confirmed' AND id != ?`
  ).get(route, date, time, excludeBookingId || '');
  return row.total;
}

function queueLength(route, date, time) {
  const row = db.prepare(
    `SELECT COUNT(*) AS count FROM bookings
     WHERE route = ? AND date = ? AND time = ? AND booking_status = 'queued'`
  ).get(route, date, time);
  return row.count;
}

// Returns { capacity, confirmed, available, queueLength } for a sailing.
function getAvailability(route, date, time) {
  const confirmed = confirmedSeatsUsed(route, date, time);
  return {
    capacity: CAPACITY,
    confirmed,
    available: Math.max(0, CAPACITY - confirmed),
    queueLength: queueLength(route, date, time)
  };
}

// Decides whether a new booking for `passengers` seats fits immediately
// or has to join the queue, and if queued, at what position. If anyone
// is already waiting, new bookings queue behind them too — otherwise a
// small booking could jump ahead of people who arrived earlier.
function assignSlot(route, date, time, passengers) {
  const existingQueue = queueLength(route, date, time);
  const used = confirmedSeatsUsed(route, date, time);
  if (existingQueue === 0 && used + passengers <= CAPACITY) {
    return { booking_status: 'confirmed', queue_position: null };
  }
  return { booking_status: 'queued', queue_position: existingQueue + 1 };
}

// Called after any booking is removed from a sailing (cancellation).
// Promotes queued bookings in FIFO order while seats remain, then
// renumbers whatever is left in the queue so positions stay 1..N with
// no gaps.
function reconcileSailing(route, date, time) {
  let used = confirmedSeatsUsed(route, date, time);
  const queued = db.prepare(
    `SELECT id, passengers FROM bookings
     WHERE route = ? AND date = ? AND time = ? AND booking_status = 'queued'
     ORDER BY queue_position ASC`
  ).all(route, date, time);

  const promoted = [];
  const stillQueued = [];

  for (const b of queued) {
    if (used + b.passengers <= CAPACITY) {
      used += b.passengers;
      promoted.push(b.id);
    } else {
      stillQueued.push(b.id);
    }
  }

  for (const id of promoted) {
    db.prepare(`UPDATE bookings SET booking_status = 'confirmed', queue_position = NULL WHERE id = ?`).run(id);
  }
  stillQueued.forEach((id, index) => {
    db.prepare(`UPDATE bookings SET queue_position = ? WHERE id = ?`).run(index + 1, id);
  });

  return { promoted, stillQueued };
}

module.exports = { CAPACITY, getAvailability, assignSlot, reconcileSailing };
