(() => {
  'use strict';

  const form = document.querySelector('form[data-email-confirmation]');
  if (!form) return;
  const status = document.querySelector('[data-confirmation-status]');
  const submit = form.querySelector('button[type="submit"]');
  const prompt = status.textContent;
  const retry = document.querySelector('[data-confirmation-retry]');
  const retryPath = retry?.href;

  function readLink() {
    const fields = new URLSearchParams(location.hash.slice(1));
    // Fragments never reach the server. Remove them before any later navigation.
    history.replaceState(null, '', location.pathname);
    form.reset();
    submit.disabled = true;
    const selector = fields.get('selector');
    const verificationToken = fields.get('token');
    const pattern = /^[A-Za-z0-9_-]{43}$/;
    if (fields.getAll('selector').length !== 1 || fields.getAll('token').length !== 1 ||
        !pattern.test(selector ?? '') || !pattern.test(verificationToken ?? '')) {
      status.textContent = status.dataset.invalidLink;
      return;
    }
    form.elements.namedItem('selector').value = selector;
    form.elements.namedItem('verificationToken').value = verificationToken;
    const resetting = fields.get('purpose') === 'reset';
    form.elements.namedItem('password').autocomplete = resetting ? 'new-password' : 'current-password';
    if (resetting) form.elements.namedItem('password').minLength = 15;
    else form.elements.namedItem('password').removeAttribute('minlength');
    if (retry) retry.href = resetting ? retryPath.replace('/account/sign-up/', '/account/password/reset/') : retryPath;
    status.textContent = prompt;
    submit.disabled = false;
  }
  readLink();
  window.addEventListener('hashchange', readLink);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    form.setAttribute('aria-busy', 'true');
    try {
      const response = await fetch(form.action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(new FormData(form)),
        credentials: 'same-origin',
        referrerPolicy: 'same-origin',
        cache: 'no-store',
        redirect: 'follow',
      });
      const target = new URL(response.url);
      if (!response.ok || !response.redirected || target.origin !== location.origin || target.hash ||
          !/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?account\/$/.test(target.pathname)) {
        throw new Error('Confirmation was not accepted');
      }
      location.assign(target.href);
    } catch {
      status.textContent = status.dataset.invalidLink;
      submit.disabled = false;
      form.removeAttribute('aria-busy');
    }
  });
})();
