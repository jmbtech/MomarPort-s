/* ---------------------------------------------------------
   Sartagoda Port — Auth (frontend)
   The session token lives in an httpOnly cookie set by the
   server — this script never sees or stores it, so it can't
   be stolen via XSS. The browser attaches the cookie to every
   same-origin request automatically (credentials: 'include').
--------------------------------------------------------- */

function getCookie(name) {
  const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

async function apiRequest(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const headers = Object.assign(
    { 'Content-Type': 'application/json' },
    options.headers || {}
  );
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
    const csrfToken = getCookie('csrf_token');
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  }

  let res;
  try {
    res = await fetch(path, Object.assign({ credentials: 'include' }, options, { headers }));
  } catch {
    // fetch() itself threw — the backend isn't reachable at all (not
    // running, wrong port, or this page was opened without the server).
    return { ok: false, error: `Can't reach the server at ${path}. Make sure the backend is running (node server.js).` };
  }

  try {
    return await res.json();
  } catch {
    // The server responded, but not with JSON — usually means something
    // other than server.js answered this request (a static-file preview,
    // a proxy error page, etc.) rather than a bug in the request itself.
    return { ok: false, error: `Server returned an unexpected response (HTTP ${res.status}) instead of JSON. Make sure the backend (node server.js) is running and serving this page.` };
  }
}

async function signUp(name, email, phone, password) {
  return apiRequest('/api/auth/signup', {
    method: 'POST',
    body: JSON.stringify({ name, email, phone, password })
  });
}

async function logIn(email, password) {
  return apiRequest('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password })
  });
}

async function logOut() {
  return apiRequest('/api/auth/logout', { method: 'POST' });
}

async function getSession() {
  const result = await apiRequest('/api/auth/me', { method: 'GET' });
  return result.ok ? result.user : null;
}

// Paints the navbar's account slot depending on session state.
async function renderAccountNav() {
  const slot = document.getElementById('navAccountSlot');
  if (!slot) return;
  const session = await getSession();

  if (session) {
    const statusBadge = idStatusBadge(session.id_status);
    slot.innerHTML = `
      <a href="verify.html" class="nav-verify">Verify ID ${statusBadge}</a>
      <span class="nav-user">${escapeHtmlAuth(session.name.split(' ')[0])}</span>
      <a href="#" id="navLogout">Log out</a>
    `;
    document.getElementById('navLogout').addEventListener('click', async (e) => {
      e.preventDefault();
      await logOut();
      window.location.href = 'index.html';
    });
  } else {
    slot.innerHTML = `<a href="account.html" class="nav-cta">Log in / Sign up</a>`;
  }
}

function idStatusBadge(status) {
  const map = {
    verified: '<span class="id-dot id-dot-verified" title="Verified"></span>',
    pending: '<span class="id-dot id-dot-pending" title="Pending review"></span>',
    rejected: '<span class="id-dot id-dot-rejected" title="Rejected"></span>',
    unverified: '<span class="id-dot id-dot-unverified" title="Not verified"></span>'
  };
  return map[status] || map.unverified;
}

async function requireAuth() {
  const session = await getSession();
  if (!session) {
    window.location.href = 'account.html?next=booking';
  }
  return session;
}

function escapeHtmlAuth(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

document.addEventListener('DOMContentLoaded', renderAccountNav);
