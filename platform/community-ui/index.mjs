import { escapeHtml, localPath, portalLocale, renderShell } from '../ui/shell.mjs';
import dictionaries from './translations.json' with { type: 'json' };

const uuid = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';

function pageFor(path) {
  const topic = path.match(new RegExp(`^/community/topic/(${uuid})/?$`, 'i'));
  if (topic) return { view: 'topic', topic: topic[1].toLowerCase() };
  switch (path.replace(/\/$/, '')) {
    case '/community': return { view: 'topics' };
    case '/community/activity': return { view: 'activity' };
    case '/community/moderation': return { view: 'moderation' };
    default: return null;
  }
}

function searchForm(t) {
  return `<form class="forum-filters" data-search method="get">
    <label>${t('search')} <input name="p_search" type="search" maxlength="120"></label>
    <label>${t('category')} <select name="p_category"><option value="">${t('all')}</option></select></label>
    <label>${t('sort')} <select name="p_sort"><option value="recent">${t('recent')}</option><option value="top">${t('top')}</option><option value="discussed">${t('discussed')}</option></select></label>
    <button type="submit">${t('search')}</button>
  </form>`;
}

function topicForm(t) {
  return `<details class="forum-panel" data-composer hidden><summary>${t('newTopic')}</summary>
    <form class="forum-fields" data-submit-topic method="post">
      <label>${t('category')} <select name="p_category" required></select></label>
      <label>${t('title')} <input name="p_title" maxlength="180" required dir="auto"></label>
      <label>${t('message')} <textarea name="p_body" rows="6" maxlength="10000" required dir="auto"></textarea></label>
      <button type="submit">${t('post')}</button><p data-result role="status"></p>
    </form></details>`;
}

function pagination(t, label) {
  return `<nav class="forum-pagination" data-pagination hidden aria-label="${t(label)}">
    <button type="button" data-previous>${t('previous')}</button><button type="button" data-next>${t('next')}</button>
  </nav>`;
}

function queueFilter(t) {
  const statuses = ['pending', 'held', 'flagged', 'blocked', 'hidden', 'published'];
  return `<form class="forum-filters" data-queue-filter method="get">
    <label>${t('moderation')} <select name="p_status">
      <option value="">${t('reviewQueue')}</option><option value="all">${t('allStatuses')}</option>
      ${statuses.map((status) => `<option value="${status}">${t(status)}</option>`).join('')}
    </select></label>
    <button type="submit">${t('apply')}</button>
  </form>`;
}

function sanctionForm(t, administrator) {
  return `<details class="forum-panel"><summary>${t('sanctions')}</summary>
    <form class="forum-fields" data-sanction method="post">
      <label>${t('accountId')} <input name="p_user" required dir="ltr" pattern="${uuid}" maxlength="36"></label>
      <label>${t('action')} <select name="p_action">
        <option value="warn">${t('warn')}</option>
        <option value="suspend">${t('suspend')}</option>
        ${administrator ? `<option value="ban">${t('ban')}</option><option value="restore">${t('restore')}</option>` : ''}
      </select></label>
      <label data-duration hidden>${t('days')} <input name="p_days" type="number" min="1" max="365" value="7"></label>
      <label>${t('reason')} <textarea name="p_reason" rows="3" maxlength="300" required dir="auto"></textarea></label>
      <button type="submit">${t('apply')}</button><p data-result role="status"></p>
    </form></details>`;
}

export function renderCommunityPage({ locale = 'en', path = '', profile = null, guidelinesPath = '/community-guidelines/' }) {
  const page = pageFor(path);
  if (!page) return null;
  const language = portalLocale(locale);
  const dictionary = dictionaries[language.code];
  const t = (key) => escapeHtml(dictionary[key]);
  const member = Boolean(profile?.id);
  const admin = profile?.roles?.includes('admin') === true;
  const staff = admin || profile?.roles?.includes('moderator') === true;
  const allowed = page.view === 'activity' ? member : page.view !== 'moderation' || staff;
  const title = { topics: 'forum', topic: 'topic', activity: 'activity', moderation: 'moderation' }[page.view];
  const communityPath = localPath(language.code, '/community/');
  const accountPath = localPath(language.code, '/account/');
  const translationData = escapeHtml(JSON.stringify(dictionary));
  const forumBody = page.view === 'topics' ? `${searchForm(t)}
      ${member ? topicForm(t) : `<p><a class="text-link" href="${accountPath}">${t('signIn')}</a></p>`}
      <section class="forum-list" data-content aria-label="${t('topic')}"></section>
      ${pagination(t, 'topic')}`
    : `${page.view === 'moderation' ? queueFilter(t) : ''}
      <section class="forum-list" data-content aria-label="${t(title)}"></section>
      ${page.view === 'topic' ? `<button type="button" data-more hidden>${t('more')}</button>` : ''}
      ${page.view === 'moderation' ? pagination(t, 'moderation') + sanctionForm(t, admin) : ''}`;

  const body = `<div class="forum-page" data-forum-view="${page.view}" data-community-path="${communityPath}" data-member="${member}" data-topic="${page.topic ?? ''}">
    <h1 data-page-title>${t(title)}</h1>
    <nav class="forum-actions" aria-label="${t('forum')}">
      ${page.view !== 'topics' ? `<a class="text-link" href="${communityPath}">${t('forum')}</a>` : ''}
      ${member && page.view !== 'activity' ? `<a class="text-link" href="${communityPath}activity/">${t('activity')}</a>` : ''}
      ${staff && page.view !== 'moderation' ? `<a class="text-link" href="${communityPath}moderation/">${t('moderation')}</a>` : ''}
      <a class="text-link" href="${escapeHtml(localPath(language.code, guidelinesPath))}">${t('guidelines')}</a>
    </nav>
    ${allowed ? `<noscript><p>${t('javascript')}</p></noscript>
      <template data-labels>${translationData}</template>
      <p class="forum-feedback" role="status" data-page-status></p>
      ${forumBody}` : `<p>${t('restricted')}</p>${member ? '' : `<p><a class="text-link" href="${accountPath}">${t('signIn')}</a></p>`}`}
  </div>`;

  return renderShell({
    locale: language.code, path, profile, title: dictionary[title], body,
    stylesheet: '/_platform/community/community.css',
    script: allowed ? '/_platform/community/community.mjs' : null,
    noindex: true,
  });
}
