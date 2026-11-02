const keyCard = document.getElementById('keyCard');
const reviewCard = document.getElementById('reviewCard');
const adminKeyInput = document.getElementById('adminKey');
const adminList = document.getElementById('adminList');
const toast = document.getElementById('toast');

let adminKey = sessionStorage.getItem('anchorbook_admin_key') || '';

if (adminKey) {
  adminKeyInput.value = adminKey;
  unlock();
}

document.getElementById('unlockBtn').addEventListener('click', unlock);

async function unlock() {
  adminKey = adminKeyInput.value.trim();
  if (!adminKey) {
    showToast('Enter the admin key.', true);
    return;
  }
  const result = await adminRequest('/api/admin/id-verifications', { method: 'GET' });
  if (!result.ok) {
    showToast(result.error || 'Invalid admin key.', true);
    return;
  }
  sessionStorage.setItem('anchorbook_admin_key', adminKey);
  keyCard.style.display = 'none';
  reviewCard.style.display = 'block';
  renderList(result.users);
}

async function adminRequest(path, options = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() }, options.headers || {}, {
    'X-Admin-Key': adminKey
  });
  let res;
  try {
    res = await fetch(path, Object.assign({ credentials: 'include' }, options, { headers }));
  } catch {
    return { ok: false, error: `Can't reach the server at ${path}. Make sure the backend is running (node server.js).` };
  }
  try {
    return await res.json();
  } catch {
    return { ok: false, error: `Server returned an unexpected response (HTTP ${res.status}) instead of JSON. Make sure the backend (node server.js) is running.` };
  }
}

function getCsrfToken() {
  const match = document.cookie.match(/(?:^|; )csrf_token=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : '';
}

function renderList(users) {
  if (!users || users.length === 0) {
    adminList.innerHTML = '<p class="empty-msg">No ID submissions yet.</p>';
    return;
  }

  adminList.innerHTML = users.map(u => `
    <div class="admin-item" data-id="${u.id}">
      <div class="admin-item-header">
        <strong>${escapeHtml(u.name)}</strong>
        <span class="pay-badge ${badgeClass(u.id_status)}">${u.id_status}</span>
      </div>
      <p class="admin-meta">${escapeHtml(u.email)} — submitted ${u.id_uploaded_at ? new Date(u.id_uploaded_at).toLocaleString() : '—'}</p>
      <img class="id-preview admin-id-img" data-user="${u.id}" alt="Loading ID...">
      ${u.id_status === 'pending' ? `
        <div class="admin-actions">
          <input type="text" class="admin-note" placeholder="Note (optional, shown to user if rejected)">
          <button class="btn-primary btn-approve" data-user="${u.id}">Approve</button>
          <button class="btn-ghost-dark btn-reject" data-user="${u.id}">Reject</button>
        </div>
      ` : `<p class="admin-meta">Reviewed ${u.id_reviewed_at ? new Date(u.id_reviewed_at).toLocaleString() : ''}${u.id_review_note ? ' — ' + escapeHtml(u.id_review_note) : ''}</p>`}
    </div>
  `).join('');

  document.querySelectorAll('.admin-id-img').forEach(loadImage);
  document.querySelectorAll('.btn-approve').forEach(btn => btn.addEventListener('click', () => decide(btn.dataset.user, 'verified', btn)));
  document.querySelectorAll('.btn-reject').forEach(btn => btn.addEventListener('click', () => decide(btn.dataset.user, 'rejected', btn)));
}

async function loadImage(imgEl) {
  const userId = imgEl.dataset.user;
  const res = await fetch('/api/admin/id-verifications/' + userId + '/image', {
    headers: { 'X-Admin-Key': adminKey },
    credentials: 'include'
  });
  if (!res.ok) return;
  const blob = await res.blob();
  imgEl.src = URL.createObjectURL(blob);
}

async function decide(userId, status, btn) {
  const item = btn.closest('.admin-item');
  const note = item.querySelector('.admin-note') ? item.querySelector('.admin-note').value : '';
  const result = await adminRequest('/api/admin/id-verifications/' + userId, {
    method: 'POST',
    body: JSON.stringify({ status, note })
  });
  if (!result.ok) {
    showToast(result.error || 'Could not save decision.', true);
    return;
  }
  showToast('Saved.');
  const listResult = await adminRequest('/api/admin/id-verifications', { method: 'GET' });
  if (listResult.ok) renderList(listResult.users);
}

function badgeClass(status) {
  if (status === 'verified') return 'pay-paid';
  if (status === 'pending') return 'pay-pending';
  if (status === 'rejected') return 'pay-unpaid';
  return '';
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
  toastTimeout = setTimeout(() => toast.classList.remove('show'), 3000);
}
