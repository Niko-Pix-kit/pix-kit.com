import locales from '../../data/i18n/locales.json' with { type: 'json' };
import { escapeHtml as esc, localPath, messagesFor, portalLocale, renderShell } from './shell.mjs';

const memberScript = '/_platform/member/member.js';
const learn = '/learn/';
const account = '/account/';
const progressPath = '/learn/progress/';

function href(locale, path) {
  return esc(localPath(locale, path));
}

function lessonPath(courseId, lessonId) {
  return `${learn}${encodeURIComponent(courseId)}/${encodeURIComponent(lessonId)}/`;
}

function postForm(endpoint, action, copy, content, attributes = '') {
  return `<form method="post" action="${endpoint}" class="portal-form" data-action="${action}" data-error="${esc(copy.error)}"${attributes}>
    ${content}<p class="portal-status" role="status"></p></form>`;
}

function button(label, danger = false) {
  return `<button type="submit" class="portal-button${danger ? ' portal-danger' : ''}">${esc(label)}</button>`;
}

function link(locale, path, label, type = 'portal-button') {
  return `<a class="${type}" href="${href(locale, path)}">${esc(label)}</a>`;
}

function alert(copy, error) {
  if (!error) return '';
  return `<p class="portal-status" role="alert">${esc(error === 'service_unavailable' ? copy.unavailable : copy.error)}</p>`;
}

export function googleSignInLink(locale, copy) {
  return `<a class="portal-button portal-google" href="/auth/start?provider=google&amp;locale=${encodeURIComponent(locale)}"><img src="/assets/brand/google-g.png" alt="" width="20" height="20"> ${esc(copy.google)}</a>`;
}

function signInPage(locale, copy, authOptions) {
  const providerLinks = [
    authOptions.google && googleSignInLink(locale, copy),
    authOptions.apple && `<a class="portal-button" href="/auth/start?provider=apple&amp;locale=${encodeURIComponent(locale)}">${esc(copy.apple)}</a>`,
  ].filter(Boolean);
  const email = authOptions.email ? `
    ${postForm('/api/account/email', 'email', copy, `
      <label for="sign-in-email">${esc(copy.email)}</label>
      <input id="sign-in-email" name="email" type="email" autocomplete="email" dir="ltr" maxlength="254" required>
      <input name="locale" type="hidden" value="${esc(locale)}">
      ${button(copy.emailSend)}`, ` data-success="${esc(copy.emailSent)}"`)}
    ${postForm('/api/account/verify', 'verify', copy, `
      <input name="email" type="hidden">
      <label for="sign-in-code">${esc(copy.emailCode)}</label>
      <input id="sign-in-code" name="token" type="text" inputmode="numeric" autocomplete="one-time-code" dir="ltr" pattern="[0-9]{6,10}" maxlength="10" required>
      ${button(copy.signIn)}`, ` hidden data-next="${href(locale, account)}"`)}` : '';
  return providerLinks.length || email
    ? `<div class="portal-card portal-narrow"><div class="portal-actions">${providerLinks.join('')}</div>${email}</div>`
    : `<p class="portal-note">${esc(copy.signInUnavailable)}</p>`;
}

function guestImportForm(locale, copy) {
  return postForm('/api/learning/import', 'import', copy,
    `<p>${esc(copy.importPrompt)}</p>${button(copy.importProgress)}`,
    ` hidden data-next="${href(locale, progressPath)}"`);
}

function profileForm(locale, copy, profile) {
  const options = locales.map(entry => (
    `<option value="${esc(entry.code)}"${entry.code === (profile.preferred_language ?? locale) ? ' selected' : ''} lang="${esc(entry.tag)}">${esc(entry.name)}</option>`
  )).join('');
  return postForm('/api/account/profile', 'profile', copy, `
    <label for="display-name">${esc(copy.displayName)}</label>
    <input id="display-name" name="p_display_name" value="${esc(profile.display_name)}" dir="auto" maxlength="80" required>
    <label for="preferred-language">${esc(copy.language)}</label>
    <select id="preferred-language" name="p_preferred_language">${options}</select>
    ${button(copy.save)}`);
}

function accountPage(locale, copy, profile) {
  const active = profile.status === 'active';
  return `<div class="portal-narrow portal-stack">
    <section class="portal-card">
      ${profile.email ? `<p>${esc(copy.email)} <bdi>${esc(profile.email)}</bdi></p>` : ''}
      ${active ? profileForm(locale, copy, profile) : `<p class="portal-note">${esc(copy.unavailable)}</p>`}
      ${active ? guestImportForm(locale, copy) : ''}
      ${postForm('/api/account/logout', 'logout', copy, button(copy.signOut), ` data-next="${href(locale, learn)}"`)}
    </section>
    <section class="portal-card">
      <h2>${esc(copy.deleteAccount)}</h2><p id="delete-warning">${esc(copy.deleteWarning)}</p>
      ${postForm('/api/account/delete', 'delete', copy, `
        <label class="portal-check"><input type="checkbox" required aria-describedby="delete-warning"> ${esc(copy.deleteConfirm)}</label>
        ${button(copy.deleteAccount, true)}`, ` data-next="${href(locale, learn)}"`)}
    </section>
  </div>`;
}

function catalogPage(locale, copy, profile, catalog, error) {
  if (!catalog.length) return error ? '' : `<p class="portal-note">${esc(copy.catalogEmpty)}</p>`;
  return `<div class="portal-stack">${catalog.map(course => `
    <article class="portal-card">
      <h2 dir="auto">${esc(course.title)}</h2><p dir="auto">${esc(course.description)}</p>
      <ol>${course.lessons.map(lesson => {
        const title = `<bdi>${esc(lesson.title)}</bdi>`;
        const accessNote = lesson.access === 'public' ? copy.preview
          : lesson.available ? '' : profile ? copy.restricted : copy.membersOnly;
        return `<li><a href="${href(locale, lessonPath(course.id, lesson.id))}">${title}</a>
          ${accessNote ? `<span class="portal-badge">${esc(accessNote)}</span>` : ''}</li>`;
      }).join('')}</ol>
    </article>`).join('')}</div>`;
}

function inline(text) {
  return esc(text).replace(/`([^`\n]+)`/g, '<code>$1</code>');
}

/** Render a small Markdown subset with raw HTML treated as text. */
export function renderLessonBody(markdown) {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const output = [];
  let paragraph = [];
  let code = null;

  function flushParagraph() {
    if (paragraph.length) output.push(`<p dir="auto">${inline(paragraph.join(' '))}</p>`);
    paragraph = [];
  }

  for (const line of lines) {
    if (code !== null) {
      if (/^\s*```\s*$/.test(line)) {
        output.push(`<pre dir="ltr"><code>${esc(code.join('\n'))}</code></pre>`);
        code = null;
      } else {
        code.push(line);
      }
      continue;
    }
    if (/^\s*```[^\n]*$/.test(line)) {
      flushParagraph();
      code = [];
      continue;
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      const level = heading[1].length + 1;
      output.push(`<h${level} dir="auto">${inline(heading[2])}</h${level}>`);
    } else if (line.trim()) {
      paragraph.push(line);
    } else {
      flushParagraph();
    }
  }
  flushParagraph();
  if (code !== null) output.push(`<pre dir="ltr"><code>${esc(code.join('\n'))}</code></pre>`);
  return output.join('\n');
}

function lessonPage(locale, copy, profile, lesson, progress) {
  const back = link(locale, learn, copy.tutorials, 'text-link');
  if (!lesson) return back;
  const isPublic = lesson.access === 'public';
  const active = profile?.status === 'active';
  const canRender = lesson.available !== false && typeof lesson.body === 'string' && (active || isPublic);
  if (!canRender) {
    return `<div class="portal-card portal-narrow">
      <p>${esc(profile ? copy.restricted : copy.membersOnly)}</p>
      <div class="portal-actions">${profile ? '' : link(locale, account, copy.signIn)}${back}</div>
    </div>`;
  }

  const completed = progress.some(row => (
    row.course_id === lesson.course_id && row.lesson_id === lesson.id && row.completed_at
  ));
  const attributes = ` data-saved="${esc(copy.progressSaved)}" data-completed="${esc(copy.completed)}"`;
  const identity = `
    <input type="hidden" name="p_course_id" value="${esc(lesson.course_id)}">
    <input type="hidden" name="p_lesson_id" value="${esc(lesson.id)}">`;
  return `<article class="portal-card portal-narrow">
    ${isPublic ? `<span class="portal-badge">${esc(copy.preview)}</span>` : ''}
    <div class="portal-markdown">${renderLessonBody(lesson.body)}</div>
    ${completed ? `<p class="portal-note">${esc(copy.completed)}</p>` : profile && !active ? '' : postForm(
      '/api/learning/progress', profile ? 'progress' : 'guest-progress', copy,
      identity + button(copy.markComplete), attributes,
    )}
    ${active ? `<div data-seen data-course="${esc(lesson.course_id)}" data-lesson="${esc(lesson.id)}"></div>` : ''}
    ${back}
  </article>`;
}

function progressPage(locale, copy, profile, catalog, progress, error) {
  if (!profile) return link(locale, account, copy.signIn);
  if (profile.status !== 'active') return `<p class="portal-note">${esc(copy.unavailable)}</p>`;
  if (error) return '';
  const number = new Intl.NumberFormat(portalLocale(locale).tag, { style: 'percent' });
  const rowsByCourse = Map.groupBy(progress, row => row.course_id);
  const courses = catalog.flatMap(course => {
    const available = course.lessons.filter(lesson => lesson.available);
    const byLesson = new Map((rowsByCourse.get(course.id) ?? []).map(row => [row.lesson_id, row]));
    const started = available.filter(lesson => byLesson.has(lesson.id));
    if (!started.length) return [];
    const completed = started.filter(lesson => byLesson.get(lesson.id).completed_at).length;
    const lastSeen = started.reduce((latest, lesson) => {
      const date = row => Date.parse(byLesson.get(row.id).last_accessed_at) || 0;
      return date(lesson) > date(latest) ? lesson : latest;
    });
    const next = byLesson.get(lastSeen.id).completed_at
      ? available.find(lesson => !byLesson.get(lesson.id)?.completed_at) ?? lastSeen : lastSeen;
    const progressLabel = `${course.title} · ${number.format(completed / available.length)}`;
    return `<article class="portal-card">
      <h2 dir="auto">${esc(course.title)}</h2>
      <div class="portal-actions">
        <progress max="${available.length}" value="${completed}" aria-label="${esc(progressLabel)}"></progress>
        <bdi>${esc(number.format(completed / available.length))}</bdi>
        ${link(locale, lessonPath(course.id, next.id), copy.resume)}
      </div>
      <ol>${started.map(lesson => `<li><a href="${href(locale, lessonPath(course.id, lesson.id))}"><bdi>${esc(lesson.title)}</bdi></a>
        <span class="portal-badge">${esc(byLesson.get(lesson.id).completed_at ? copy.completed : copy.started)}</span></li>`).join('')}</ol>
    </article>`;
  });
  return `<div class="portal-stack">${guestImportForm(locale, copy)}${courses.join('') || `<p class="portal-note">${esc(copy.progressEmpty)}</p>`}</div>`;
}

export function renderMemberPage({
  locale = 'en', path, profile = null, catalog = [], lesson = null, progress = [],
  error = null, authOptions = {},
}) {
  const code = portalLocale(locale).code;
  const copy = messagesFor(code);
  let title;
  let content;
  let noindex;
  if (path === account) {
    title = profile ? copy.account : copy.signIn;
    content = profile ? accountPage(code, copy, profile) : signInPage(code, copy, authOptions);
    noindex = true;
  } else if (path === learn) {
    title = copy.tutorials;
    content = catalogPage(code, copy, profile, catalog, error);
  } else if (path === progressPath) {
    title = copy.progress;
    content = progressPage(code, copy, profile, catalog, progress, error);
    noindex = true;
  } else if (/^\/learn\/[^/]+\/[^/]+\/$/.test(path)) {
    title = lesson?.title ?? (error ? copy.tutorials : copy.notFound);
    content = lessonPage(code, copy, profile, lesson, progress);
    noindex = !lesson || lesson.access !== 'public';
  } else {
    return null;
  }
  return renderShell({
    locale: code, path, profile, title, noindex,
    body: `<h1 dir="auto">${esc(title)}</h1>${alert(copy, error)}${content}`,
    script: memberScript,
  });
}
