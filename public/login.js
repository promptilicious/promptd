const form = document.getElementById('login');
const password = document.getElementById('password');
const errorBox = document.getElementById('error');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.hidden = true;
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: password.value }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `sign in failed (${res.status})`);
    location.replace('/');
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.hidden = false;
    password.select();
  } finally {
    button.disabled = false;
  }
});
