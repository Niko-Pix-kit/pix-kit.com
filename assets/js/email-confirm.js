(() => {
  'use strict';

  const form = document.querySelector('form[data-email-confirmation]');
  if (!form) return;
  const status = document.querySelector('[data-confirmation-status]');
  const resetFields = form.querySelector('[data-reset-password]');
  const submit = resetFields.querySelector('button[type="submit"]');
  const prompt = status.textContent;
  const retry = document.querySelector('[data-confirmation-retry]');
  const retryPath = retry?.href;
  let busy = false;

  async function exchange() {
    if (busy) return;
    busy = true;
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
      busy = false;
      submit.disabled = false;
      form.removeAttribute('aria-busy');
    }
  }

  function readLink() {
    const fields = new URLSearchParams(location.hash.slice(1));
    // Fragments never reach the server. Clear the proof before any later navigation.
    history.replaceState(null, '', location.pathname);
    form.reset();
    resetFields.hidden = true;
    resetFields.disabled = true;
    submit.disabled = true;
    const selector = fields.get('selector');
    const verificationToken = fields.get('token');
    const purposes = fields.getAll('purpose');
    const pattern = /^[A-Za-z0-9_-]{43}$/;
    if (fields.getAll('selector').length !== 1 || fields.getAll('token').length !== 1 ||
        !pattern.test(selector ?? '') || !pattern.test(verificationToken ?? '') ||
        purposes.length > 1 || (purposes.length === 1 && !['signup', 'reset'].includes(purposes[0]))) {
      status.textContent = status.dataset.invalidLink;
      return;
    }
    form.elements.namedItem('selector').value = selector;
    form.elements.namedItem('verificationToken').value = verificationToken;
    const resetting = purposes[0] === 'reset';
    if (retry) retry.href = resetting ? retryPath.replace('/account/sign-up/', '/account/password/reset/') : retryPath;
    if (resetting) {
      resetFields.hidden = false;
      resetFields.disabled = false;
      submit.disabled = false;
      document.querySelector('h1').textContent = form.dataset.resetTitle;
      status.textContent = '';
    } else {
      status.textContent = prompt;
      void exchange();
    }
  }
  readLink();
  window.addEventListener('hashchange', readLink);
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (resetFields.disabled || submit.disabled) return;
    void exchange();
  });
})();
