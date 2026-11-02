// Same 3 trips for both directions (7:00 AM, 11:00 AM, 4:00 PM).
const ROUTES = [
  ['GUIHULNGAN → TANGIL', '07:00 AM'],
  ['GUIHULNGAN → TANGIL', '11:00 AM'],
  ['GUIHULNGAN → TANGIL', '04:00 PM'],
  ['TANGIL → GUIHULNGAN', '07:00 AM'],
  ['TANGIL → GUIHULNGAN', '11:00 AM'],
  ['TANGIL → GUIHULNGAN', '04:00 PM'],
];
const STATUSES = ['SCHEDULED', 'SCHEDULED', 'SCHEDULED', 'SCHEDULED', 'SCHEDULED', 'SCHEDULED'];

const rowsEl = document.getElementById('boardRows');
rowsEl.innerHTML = ROUTES.map(([route, time], i) => `
  <div class="board-row" style="animation-delay:${i * 0.12}s">
    <span>${route}</span><span>${time}</span><span class="status">${STATUSES[i]}</span>
  </div>
`).join('');

function tickClock() {
  const now = new Date();
  document.getElementById('boardClock').textContent =
    now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}
tickClock();
setInterval(tickClock, 1000 * 30);

// Reveal the routes/steps sections as they scroll into view, instead of
// animating them on page load where they'd finish before anyone sees them.
if ('IntersectionObserver' in window) {
  const revealObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('in-view');
        revealObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' });

  document.querySelectorAll('.reveal').forEach(el => revealObserver.observe(el));
} else {
  // No IntersectionObserver support — just show everything immediately.
  document.querySelectorAll('.reveal').forEach(el => el.classList.add('in-view'));
}
