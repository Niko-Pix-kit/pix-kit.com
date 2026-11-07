const guestStorageKey = 'pixkit.guest-progress.v1';
const maxImport = 200;
const accountId = document.body.dataset.accountId;
const accountHeader = accountId ? { 'X-PixKit-Account': accountId } : {};
const stableId = /^(?=.{1,96}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
const pendingProgress = new WeakMap();

function guestProgress() {
  try {
    const rows = JSON.parse(localStorage.getItem(guestStorageKey) ?? '[]');
    if (Array.isArray(rows)) {
      return rows.filter(row => typeof row?.course_id === 'string' && typeof row.lesson_id === 'string'
        && stableId.test(row.course_id) && stableId.test(row.lesson_id))
        .map(({ course_id, lesson_id }) => ({ course_id, lesson_id }));
    }
  } catch {
    // Private browsing and corrupt legacy entries must not break the page.
  }
  return [];
}

function key(row) {
  return `${row.course_id}/${row.lesson_id}`;
}

function writeGuestProgress(rows) {
  if (!rows.length) localStorage.removeItem(guestStorageKey);
  else localStorage.setItem(guestStorageKey, JSON.stringify(rows));
}

async function post(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { ...accountHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error('Request failed');
}

function values(form) {
  return Object.fromEntries(new FormData(form));
}

function status(form, message, failed = false) {
  const target = form.querySelector('.portal-status');
  target.setAttribute('role', failed ? 'alert' : 'status');
  target.textContent = message;
}

function complete(form) {
  const submit = form.querySelector('button[type="submit"]');
  submit.hidden = true;
  status(form, `${form.dataset.completed} · ${form.dataset.saved}`);
}

function progressRecord({ p_course_id, p_lesson_id }, completed) {
  return {
    p_course_id, p_lesson_id,
    p_completed: completed,
    p_seen_at: new Date().toISOString(),
  };
}

const actions = {
  async email(form) {
    const payload = values(form);
    await post(form.action, payload);
    const verify = document.querySelector('[data-action="verify"]');
    verify.elements.email.value = payload.email;
    verify.elements.token.value = '';
    verify.hidden = false;
    status(form, form.dataset.success);
    verify.elements.token.focus();
  },
  async verify(form) {
    await post(form.action, values(form));
    location.assign(form.dataset.next);
  },
  async profile(form) {
    const payload = values(form);
    await post(form.action, payload);
    const code = payload.p_preferred_language;
    location.assign(code === 'en' ? '/account/' : `/${encodeURIComponent(code)}/account/`);
  },
  async logout(form) {
    await post(form.action, {});
    location.assign(form.dataset.next);
  },
  async delete(form) {
    await post(form.action, {});
    location.assign(form.dataset.next);
  },
  async progress(form) {
    const payload = pendingProgress.get(form) ?? progressRecord(values(form), true);
    pendingProgress.set(form, payload);
    await post(form.action, payload);
    pendingProgress.delete(form);
    complete(form);
  },
  'guest-progress'(form) {
    const { p_course_id, p_lesson_id } = values(form);
    const row = { course_id: p_course_id, lesson_id: p_lesson_id };
    const rows = guestProgress();
    if (!rows.some(old => key(old) === key(row))) writeGuestProgress([...rows, row]);
    complete(form);
  },
  async import(form) {
    const rows = guestProgress();
    const selected = new Map(rows.map(row => [key(row), row]));
    const payload = [...selected.values()];
    for (let offset = 0; offset < payload.length; offset += maxImport) {
      await post(form.action, { p_completed: payload.slice(offset, offset + maxImport) });
    }
    const response = await fetch('/api/learning/progress', { credentials: 'same-origin', cache: 'no-store', headers: accountHeader });
    if (!response.ok) throw new Error('Cannot confirm imported progress');
    const confirmed = new Set((await response.json()).filter(row => row.completed_at).map(key));
    writeGuestProgress(guestProgress().filter(row => {
      const identity = key(row);
      return !selected.has(identity) || !confirmed.has(identity);
    }));
    location.assign(form.dataset.next);
  },
};

for (const form of document.querySelectorAll('form[data-action]')) {
  const submit = form.querySelector('button[type="submit"]');
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    form.setAttribute('aria-busy', 'true');
    status(form, '');
    try {
      await actions[form.dataset.action](form);
    } catch {
      status(form, form.dataset.error, true);
    } finally {
      submit.disabled = false;
      form.removeAttribute('aria-busy');
    }
  });

  if (form.dataset.action === 'import') form.hidden = !guestProgress().length;
  if (form.dataset.action === 'guest-progress') {
    const { p_course_id, p_lesson_id } = values(form);
    if (guestProgress().some(row => row.course_id === p_course_id && row.lesson_id === p_lesson_id)) complete(form);
  }
}

const lesson = document.querySelector('[data-seen]');
if (lesson) {
  post('/api/learning/progress', progressRecord({
    p_course_id: lesson.dataset.course,
    p_lesson_id: lesson.dataset.lesson,
  }, false)).catch(() => {
    // Completing the lesson retries persistence. The page stays available offline.
  });
}
