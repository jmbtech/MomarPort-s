/* ---------------------------------------------------------
   password-toggle.js — wires up the eye icon on any
   .password-field wrapper to show/hide the password text.
--------------------------------------------------------- */

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.toggle-password').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-target');
      const input = document.getElementById(targetId);
      if (!input) return;
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      btn.classList.toggle('showing', !showing);
      btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
    });
  });
});
