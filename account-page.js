const params = new URLSearchParams(window.location.search);
const nextPage = params.get('next') === 'booking' ? 'booking.html' : 'index.html';

const loginForm = document.getElementById('loginForm');
const signupForm = document.getElementById('signupForm');
const tabLogin = document.getElementById('tabLogin');
const tabSignup = document.getElementById('tabSignup');
const toast = document.getElementById('toast');

function showTab(which) {
  const isLogin = which === 'login';
  loginForm.style.display = isLogin ? 'flex' : 'none';
  signupForm.style.display = isLogin ? 'none' : 'flex';
  tabLogin.classList.toggle('active', isLogin);
  tabSignup.classList.toggle('active', !isLogin);
}

tabLogin.addEventListener('click', () => showTab('login'));
tabSignup.addEventListener('click', () => showTab('signup'));
document.getElementById('goSignup').addEventListener('click', e => { e.preventDefault(); showTab('signup'); });
document.getElementById('goLogin').addEventListener('click', e => { e.preventDefault(); showTab('login'); });

if (params.get('next') === 'booking') showTab('signup');

loginForm.addEventListener('submit', async e => {
  e.preventDefault();
  const email = document.getElementById('loginEmail').value;
  const password = document.getElementById('loginPassword').value;
  const result = await logIn(email, password);
  if (!result.ok) {
    showToast(result.error, true);
    return;
  }
  showToast('Welcome back, ' + result.user.name.split(' ')[0] + '!');
  setTimeout(() => (window.location.href = nextPage), 700);
});

signupForm.addEventListener('submit', async e => {
  e.preventDefault();
  const name = document.getElementById('signupName').value;
  const email = document.getElementById('signupEmail').value;
  const phone = document.getElementById('signupPhone').value;
  const password = document.getElementById('signupPassword').value;
  const result = await signUp(name, email, phone, password);
  if (!result.ok) {
    showToast(result.error, true);
    return;
  }
  showToast('Account created. Welcome, ' + result.user.name.split(' ')[0] + '!');
  setTimeout(() => (window.location.href = nextPage), 700);
});

let toastTimeout;
function showToast(message, isError) {
  toast.textContent = message;
  toast.style.background = isError ? '#c0392b' : '#1a7a45';
  toast.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove('show'), 3000);
}
