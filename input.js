// Fares shown live on the form. The server recalculates the real total
// from its own price list, so these are only for display.
const FARES = {
  Regular: 350,
  Child: 250,
  'Senior/PWD': 280
};
const MAX_PASSENGERS = 20;

const form = document.getElementById('bookingForm');
const bookingsList = document.getElementById('bookingsList');
const toast = document.getElementById('toast');
const idGateBanner = document.getElementById('idGateBanner');
const bookingSubmitBtn = document.getElementById('bookingSubmitBtn');

// Payment modal elements
const paymentOverlay = document.getElementById('paymentOverlay');
const paymentChoiceView = document.getElementById('paymentChoiceView');
const walletQrView = document.getElementById('walletQrView');
const gcashProcessingView = document.getElementById('gcashProcessingView');
const gcashSuccessView = document.getElementById('gcashSuccessView');

let session = null;
let pendingBooking = null; // booking awaiting payment

// Prevent picking a past date
const dateInput = document.getElementById('date');
dateInput.min = new Date().toISOString().split('T')[0];

const routeInput = document.getElementById('route');
const timeInput = document.getElementById('time');
const availabilityNote = document.getElementById('availabilityNote');

const qtyInputs = {
  Regular: document.getElementById('qtyRegular'),
  Child: document.getElementById('qtyChild'),
  'Senior/PWD': document.getElementById('qtySenior')
};

async function init() {
  session = await requireAuth();
  if (!session) return; // requireAuth already redirected

  document.getElementById('passenger').value = session.name || '';
  document.getElementById('contact').value = session.phone || '';

  applyIdGate(session.id_status);
  updateFareTotal();
  await loadBookings();
}

init();

[routeInput, dateInput, timeInput].forEach(el => el.addEventListener('change', checkAvailability));
Object.values(qtyInputs).forEach(el => el.addEventListener('input', updateFareTotal));

// Reads the three passenger-type counts. Invalid or empty fields count as 0.
function readCounts() {
  const counts = {};
  for (const [type, el] of Object.entries(qtyInputs)) {
    const n = parseInt(el.value, 10);
    counts[type] = Number.isInteger(n) && n > 0 ? Math.min(n, MAX_PASSENGERS) : 0;
  }
  return counts;
}

function updateFareTotal() {
  const counts = readCounts();
  const pax = Object.values(counts).reduce((a, b) => a + b, 0);
  const fare = Object.entries(counts).reduce((sum, [type, n]) => sum + n * FARES[type], 0);
  document.getElementById('paxTotal').textContent = pax;
  document.getElementById('fareTotal').textContent = '₱' + fare.toLocaleString();
}

async function checkAvailability() {
  const route = routeInput.value;
  const date = dateInput.value;
  const time = timeInput.value;
  if (!route || !date || !time) {
    availabilityNote.style.display = 'none';
    return;
  }
  const params = new URLSearchParams({ route, date, time });
  const result = await apiRequest('/api/sailings/availability?' + params.toString(), { method: 'GET' });
  if (!result.ok) {
    availabilityNote.style.display = 'none';
    return;
  }
  availabilityNote.style.display = 'block';
  if (result.available > 0) {
    availabilityNote.className = 'availability-note availability-open';
    availabilityNote.textContent = `${result.available} of ${result.capacity} seats left on this trip.`;
  } else {
    availabilityNote.className = 'availability-note availability-full';
    const waiting = result.queueLength;
    availabilityNote.textContent = `This trip is full. Your booking will join the queue` +
      (waiting > 0 ? ` (${waiting} ${waiting === 1 ? 'booking' : 'bookings'} already waiting).` : '.');
  }
}

function applyIdGate(status) {
  if (status === 'verified') {
    idGateBanner.style.display = 'none';
    bookingSubmitBtn.disabled = false;
    return;
  }
  idGateBanner.style.display = 'block';
  bookingSubmitBtn.disabled = true;
  const messages = {
    unverified: 'Please verify a valid government ID before booking. <a href="verify.html">Verify now</a>.',
    pending: 'Your ID is submitted and awaiting review — you can book once it\'s verified.',
    rejected: 'Your ID was rejected. <a href="verify.html">Submit a new photo</a> to continue.'
  };
  idGateBanner.className = 'status-banner status-' + (status === 'verified' ? 'verified' : status || 'unverified');
  idGateBanner.innerHTML = messages[status] || messages.unverified;
}

form.addEventListener('submit', async function (e) {
  e.preventDefault();

  const passenger = document.getElementById('passenger').value.trim();
  const route = routeInput.value;
  const date = dateInput.value;
  const time = timeInput.value;
  const counts = readCounts();
  const pax = Object.values(counts).reduce((a, b) => a + b, 0);
  const contact = document.getElementById('contact').value.trim();

  if (!passenger || !route || !date || !time || !contact) {
    showToast('Please fill in all fields.', true);
    return;
  }
  if (pax < 1) {
    showToast('Add at least one passenger.', true);
    return;
  }
  if (pax > MAX_PASSENGERS) {
    showToast(`Maximum ${MAX_PASSENGERS} passengers per booking.`, true);
    return;
  }

  const result = await apiRequest('/api/bookings', {
    method: 'POST',
    body: JSON.stringify({ passenger, route, date, time, counts, contact })
  });

  if (!result.ok) {
    showToast(result.error || 'Could not create booking.', true);
    if (result.id_status) applyIdGate(result.id_status);
    return;
  }

  await loadBookings();
  form.reset();
  document.getElementById('passenger').value = session.name || '';
  document.getElementById('contact').value = session.phone || '';
  updateFareTotal();
  availabilityNote.style.display = 'none';

  if (result.booking.booking_status === 'queued') {
    showToast(`Trip is full — you're #${result.booking.queue_position} in the queue. We'll confirm your seats once one opens up.`);
  } else {
    openPaymentModal(result.booking);
  }
});

// --- Payment modal (GCash only) ---

function openPaymentModal(booking) {
  pendingBooking = booking;
  document.getElementById('paySummaryRef').textContent = booking.ref;
  document.getElementById('paySummaryRoute').textContent = booking.route.replace(' - ', ' → ');
  document.getElementById('paySummaryTotal').textContent = '₱' + booking.total.toLocaleString();
  showPaymentView('choice');
  paymentOverlay.style.display = 'flex';
}

function closePaymentModal() {
  paymentOverlay.style.display = 'none';
  pendingBooking = null;
}

function showPaymentView(view) {
  paymentChoiceView.style.display = view === 'choice' ? 'block' : 'none';
  walletQrView.style.display = view === 'wallet' ? 'block' : 'none';
  gcashProcessingView.style.display = view === 'processing' ? 'block' : 'none';
  gcashSuccessView.style.display = view === 'success' ? 'block' : 'none';
}

document.getElementById('paymentClose').addEventListener('click', async () => {
  closePaymentModal();
  await loadBookings();
});

document.getElementById('chooseGcash').addEventListener('click', () => openWalletQr());
document.getElementById('walletBack').addEventListener('click', () => showPaymentView('choice'));

function openWalletQr() {
  if (!pendingBooking) return;
  document.getElementById('walletAmount').textContent = pendingBooking.total.toLocaleString();

  const qrText = `GCash|${pendingBooking.ref}|${pendingBooking.total}`;
  drawFakeQr(document.getElementById('walletQrCanvas'), qrText);

  showPaymentView('wallet');
}

document.getElementById('walletConfirmBtn').addEventListener('click', async () => {
  if (!pendingBooking) return;

  showPaymentView('processing');

  // Simulated confirmation delay for a realistic checkout feel.
  await new Promise(resolve => setTimeout(resolve, 1200));

  const result = await apiRequest('/api/bookings/' + pendingBooking.id + '/pay', {
    method: 'POST',
    body: JSON.stringify({ method: 'gcash' })
  });

  if (!result.ok) {
    showPaymentView('wallet');
    showToast(result.error || 'Payment failed.', true);
    return;
  }

  document.getElementById('gcashPaidRef').textContent = result.booking.payment_ref;
  showPaymentView('success');
  await loadBookings();
});

document.getElementById('gcashDone').addEventListener('click', () => {
  closePaymentModal();
  showToast('Payment received via GCash!');
});

// --- Bookings list ---

async function loadBookings() {
  const result = await apiRequest('/api/bookings', { method: 'GET' });
  if (!result.ok) {
    showToast(result.error || 'Could not load bookings.', true);
    return;
  }
  renderBookings(result.bookings);
}

function paymentBadge(b) {
  if (b.booking_status === 'queued') {
    return `<span class="pay-badge pay-pending">Queued — position #${b.queue_position}</span>`;
  }
  if (b.payment_status === 'paid') {
    return `<span class="pay-badge pay-paid">Paid via GCash</span>`;
  }
  return `<span class="pay-badge pay-unpaid">Unpaid</span> <button class="pay-now-btn" onclick="resumePayment('${b.id}')">Pay now</button>`;
}

function renderBookings(bookings) {
  if (!bookings || bookings.length === 0) {
    bookingsList.innerHTML = '<p class="empty-msg">No bookings yet. Book your trip above!</p>';
    return;
  }

  bookingsList.innerHTML = bookings
    .map(
      (b) => `
    <div class="booking-item">
      <button class="cancel-btn" onclick="cancelBooking('${b.id}')">Cancel</button>
      <span class="ref">${b.ref}</span>
      ${paymentBadge(b)}
      <h3>${b.route.replace(' - ', ' → ')}</h3>
      <p><strong>Passenger:</strong> ${escapeHtml(b.passenger)}</p>
      <p><strong>Date/Trip:</strong> ${b.date} — ${b.time}</p>
      <p><strong>Passengers:</strong> ${b.passengers} (${escapeHtml(b.seat_class)})</p>
      <p><strong>Contact:</strong> ${escapeHtml(b.contact)}</p>
      <p><strong>Total:</strong> ₱${b.total.toLocaleString()}</p>
    </div>
  `
    )
    .join('');
}

async function resumePayment(id) {
  const result = await apiRequest('/api/bookings', { method: 'GET' });
  if (!result.ok) return;
  const booking = result.bookings.find(b => b.id === id);
  if (!booking) return;
  if (booking.booking_status === 'queued') {
    showToast(`Still queued (position #${booking.queue_position}) — you can pay once a seat is confirmed.`, true);
    return;
  }
  openPaymentModal(booking);
}

async function cancelBooking(id) {
  const result = await apiRequest('/api/bookings/' + id, { method: 'DELETE' });
  if (!result.ok) {
    showToast(result.error || 'Could not cancel booking.', true);
    return;
  }
  await loadBookings();
  showToast('Booking cancelled.');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

let toastTimeout;
function showToast(message, isError) {
  toast.textContent = message;
  toast.style.background = isError ? '#c0392b' : '#1a7a45';
  toast.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toast.classList.remove('show');
  }, 3000);
}
