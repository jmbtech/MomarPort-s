const statusBanner = document.getElementById('statusBanner');
const verifyForm = document.getElementById('verifyForm');
const idFile = document.getElementById('idFile');
const idPreview = document.getElementById('idPreview');
const toast = document.getElementById('toast');

let session = null;

async function init() {
  session = await requireAuth();
  if (!session) return;
  await refreshStatus();
}
init();

idFile.addEventListener('change', () => {
  const file = idFile.files[0];
  if (!file) {
    idPreview.style.display = 'none';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    idPreview.src = reader.result;
    idPreview.style.display = 'block';
  };
  reader.readAsDataURL(file);
});

verifyForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = idFile.files[0];
  if (!file) {
    showToast('Please choose an image first.', true);
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    showToast('Image is too large (max 5MB).', true);
    return;
  }

  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

  const result = await apiRequest('/api/account/id-verification', {
    method: 'POST',
    body: JSON.stringify({ imageDataUrl: dataUrl })
  });

  if (!result.ok) {
    showToast(result.error || 'Could not submit ID.', true);
    return;
  }

  showToast('ID submitted — pending review.');
  verifyForm.reset();
  idPreview.style.display = 'none';
  await refreshStatus();
});

async function refreshStatus() {
  const result = await apiRequest('/api/account/id-verification', { method: 'GET' });
  if (!result.ok) return;
  renderStatus(result.verification);
}

function renderStatus(v) {
  const status = v.id_status;
  const messages = {
    unverified: { cls: 'status-unverified', text: "You haven't submitted an ID yet." },
    pending: { cls: 'status-pending', text: 'Your ID is submitted and awaiting review.' },
    verified: { cls: 'status-verified', text: 'Your ID is verified — you can book a crossing.' },
    rejected: { cls: 'status-rejected', text: 'Your ID was rejected' + (v.id_review_note ? ': ' + escapeHtml(v.id_review_note) : '. Please submit a clearer photo.') }
  };
  const m = messages[status] || messages.unverified;
  statusBanner.className = 'status-banner ' + m.cls;
  statusBanner.textContent = m.text;
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
