const TOPIC_PAGE_SIZE = 50;
const QUEUE_PAGE_SIZE = 50;
const REPLY_PAGE_SIZE = 200;
const MAX_OFFSET = 10_000;
const REPLY_DEPTH_LIMIT = 4;
const SORT_MODES = ['recent', 'top', 'discussed'];

const translatedCategory = new Map([
  ['general-programming', ['General Programming', 'categoryGeneral']],
  ['android', ['Android Development', 'categoryAndroid']],
  ['artificial-intelligence', ['Artificial Intelligence', 'categoryAi']],
  ['beginner-questions', ['Beginner Questions', 'categoryBeginners']],
  ['projects', ['Projects and Showcase', 'categoryProjects']],
  ['pixkit-tutorials', ['PixKit Tutorials', 'categoryTutorials']],
  ['feedback', ['Feedback and Suggestions', 'categoryFeedback']],
]);

function sortMode(value) {
  return SORT_MODES.includes(value) ? value : 'recent';
}

class CommunityRequestError extends Error {
  constructor(status) {
    super('Community request failed');
    this.status = status;
  }
}

async function request(operation, parameters, method = 'GET') {
  const path = '/api/community/' + operation;
  let url = path;
  const options = { method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
  const accountId = document.body.dataset.accountId;
  if (accountId) options.headers['X-PixKit-Account'] = accountId;
  if (method === 'POST') {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(parameters);
  } else if (parameters) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(parameters)) {
      if (value !== null && value !== '' && value !== undefined) query.set(key, value);
    }
    if (query.size > 0) url += '?' + query;
  }
  const response = await fetch(url, options);
  if (!response.ok) throw new CommunityRequestError(response.status);
  return response.json();
}

function element(tag, text, attributes = {}) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  for (const [key, value] of Object.entries(attributes)) {
    node.setAttribute(key, String(value));
  }
  return node;
}

function hrefLink(label, href) {
  return element('a', label, { href });
}

function field(label, control) {
  const node = element('label', label);
  node.append(control);
  return node;
}

function option(label, value) {
  return element('option', label, { value });
}

function details(label, ...children) {
  const node = element('details', null, { class: 'forum-panel' });
  node.append(element('summary', label), ...children);
  return node;
}

/** Render text and fenced code only. The submitted text never becomes HTML or a link. */
export function renderMessage(body) {
  const message = element('div', null, { class: 'forum-prose', dir: 'auto' });
  const lines = String(body ?? '').split('\n');
  let block = [];
  let inCode = false;
  function appendBlock() {
    if (!block.length) return;
    const text = block.join('\n');
    if (inCode) {
      const pre = element('pre', null, { dir: 'ltr', tabindex: 0 });
      pre.append(element('code', text));
      message.append(pre);
    } else if (text.trim()) {
      message.append(element('p', text));
    }
    block = [];
  }
  for (const line of lines) {
    if ((inCode && /^\s*```\s*$/.test(line)) || (!inCode && /^\s*```[\w.+#-]*\s*$/.test(line))) {
      appendBlock();
      inCode = !inCode;
    } else {
      block.push(line);
    }
  }
  appendBlock();
  return message;
}

function busyButton(button, task) {
  if (button.disabled) return;
  button.disabled = true;
  return Promise.resolve().then(task).finally(() => { button.disabled = false; });
}

function dateFormat(value, locale) {
  const date = new Date(value ?? NaN);
  return Number.isFinite(date.valueOf())
    ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
    : '';
}

function topicHref(base, id) {
  return base + 'topic/' + encodeURIComponent(id) + '/';
}

function queryInputs(form, offset) {
  const data = new FormData(form);
  return {
    p_search: String(data.get('p_search') ?? '').trim(),
    p_category: String(data.get('p_category') ?? ''),
    p_sort: sortMode(data.get('p_sort')),
    p_offset: offset,
  };
}

export async function setupCommunity(root) {
  const labels = JSON.parse(root.querySelector('[data-labels]').content.textContent);
  const t = (key) => labels[String(key).replace(/^auto_/, '')] ?? labels.unknown;
  const language = document.documentElement.lang;
  const formatNumber = new Intl.NumberFormat(language);
  const pageStatus = root.querySelector('[data-page-status]');
  const content = root.querySelector('[data-content]');
  const heading = root.querySelector('[data-page-title]');
  const base = root.dataset.communityPath;
  const topicId = root.dataset.topic;
  const member = root.dataset.member === 'true';
  let writingOpen = false;
  let readPage;
  let renderGeneration = 0;
  let categories = new Map();

  const errorLabel = (error) => t({
    400: 'invalid', 401: 'signIn', 403: 'restricted', 404: 'unavailable', 409: 'conflict', 429: 'tooMany',
  }[error?.status] ?? 'failed');
  const setPageStatus = (text) => { pageStatus.textContent = text; };
  const setContent = (items) => {
    content.replaceChildren(...items);
    if (!items.length) content.append(element('p', t('empty')));
  };
  const metadata = (...values) => {
    const line = element('p', null, { class: 'forum-meta' });
    for (const value of values.filter((item) => item !== '' && item !== null && item !== undefined)) {
      if (line.childNodes.length) line.append(' · ');
      line.append(element('bdi', value));
    }
    return line;
  };
  const categoryTitle = (category) => {
    const [defaultTitle, label] = translatedCategory.get(category.slug) ?? [];
    return category.title === defaultTitle ? t(label) : category.title;
  };
  const stateTag = (state) => element('p', t(state), { class: 'forum-status' });

  function actionForm(label, controls, endpoint, payload, success, after = null) {
    const form = element('form', null, { method: 'post', class: 'forum-fields' });
    const submit = element('button', label, { type: 'submit' });
    const result = element('p', null, { role: 'status' });
    form.append(...controls, submit, result);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      return busyButton(submit, async () => {
        result.textContent = '';
        try {
          const response = await request(endpoint, payload(), 'POST');
          result.textContent = t(success);
          if (after) await after(response, result);
        } catch (error) {
          result.textContent = errorLabel(error);
        }
      });
    });
    return form;
  }

  function reasonForm(label, endpoint, post, success, after = null) {
    const input = element('textarea', null, { required: '', maxlength: 300, rows: 3, dir: 'auto' });
    return details(t(label), actionForm(t(label), [field(t('reason'), input)], endpoint,
      () => ({ p_post: post, p_reason: input.value }), success, after));
  }

  function composer(post, editing = false) {
    const isTopic = !post.parent && (!post.depth || post.depth === 0);
    const title = element('input', null, { maxlength: 180, required: '', dir: 'auto' });
    const body = element('textarea', null, { rows: 6, maxlength: 10000, required: '', dir: 'auto' });
    if (editing) {
      title.value = post.title ?? '';
      body.value = post.body ?? '';
    }
    const controls = [];
    if (editing && isTopic) controls.push(field(t('title'), title));
    controls.push(field(t('message'), body));
    const label = editing ? 'edit' : 'reply';
    let lastBody;
    let requestId;
    return details(t(label), actionForm(t(editing ? 'save' : 'post'), controls,
      editing ? 'edit' : 'submit', () => {
        if (editing) {
          return { p_post: post.id, p_version: post.version, p_title: isTopic ? title.value : null, p_body: body.value };
        }
        if (body.value !== lastBody) {
          requestId = crypto.randomUUID();
          lastBody = body.value;
        }
        return { p_request: requestId, p_category: null, p_parent: post.id, p_title: null, p_body: body.value };
      }, 'sent', async (_response, result) => {
        if (editing) {
          await readPage();
          setPageStatus(t('sent'));
          return;
        }
        body.value = '';
        lastBody = undefined;
        result.textContent = t('sent');
      }));
  }

  function voteControls(post) {
    const group = element('div', null, { class: 'forum-actions', role: 'group', 'aria-label': t('vote') });
    const score = element('span');
    const result = element('p', null, { class: 'forum-feedback', role: 'status' });
    let currentVote = post.vote ?? 0;
    let currentScore = Number(post.score);
    let submitting = false;
    const buttons = new Map([1, -1].map((value) => [value, element('button', value > 0 ? '↑' : '↓', {
      type: 'button', 'aria-label': t(value > 0 ? 'up' : 'down'),
    })]));
    function refresh() {
      score.textContent = formatNumber.format(currentScore);
      for (const [value, button] of buttons) {
        button.setAttribute('aria-pressed', currentVote === value ? 'true' : 'false');
      }
    }
    refresh();
    for (const [value, button] of buttons) {
      button.addEventListener('click', async () => {
        if (submitting) return;
        submitting = true;
        result.textContent = '';
        const target = currentVote === value ? 0 : value;
        try {
          await request('vote', { p_post: post.id, p_value: target }, 'POST');
          currentScore += target - currentVote;
          currentVote = target;
          refresh();
        } catch (error) {
          result.textContent = errorLabel(error);
        } finally {
          submitting = false;
        }
      });
    }
    group.append(buttons.get(1), score, buttons.get(-1));
    return [group, result];
  }

  function deletePanel(post) {
    return details(t('delete'), element('p', t('confirmDelete')),
      actionForm(t('delete'), [], 'delete', () => ({ p_post: post.id }), 'saved', async () => {
        await readPage();
        setPageStatus(t('saved'));
      }));
  }

  function topicCard(topic) {
    const card = element('article', null, { class: 'forum-card' });
    const title = element('h2', null, { dir: 'auto' });
    title.append(hrefLink(topic.title, topicHref(base, topic.id)));
    card.append(title, metadata(categories.has(topic.category) ? categoryTitle(categories.get(topic.category)) : null, topic.author,
      dateFormat(topic.created_at, language), t('vote') + ' ' + formatNumber.format(topic.score),
      t('replies') + ' ' + formatNumber.format(topic.comment_count)));
    return card;
  }

  function threadCard(post, topic = false) {
    const card = element('article', null, { class: 'forum-card' });
    if (!topic) card.append(element('h3', post.author ?? t('reply'), { dir: 'auto' }));
    card.append(metadata(topic ? post.author : null, dateFormat(post.created_at, language),
      t('vote') + ' ' + formatNumber.format(post.score)));
    if (post.deleted) {
      card.append(element('p', t('deleted')));
      return card;
    }
    card.append(renderMessage(post.body));
    if (member) {
      card.append(reasonForm('report', 'report', post.id, 'saved'));
      if (writingOpen) {
        card.append(...voteControls(post));
        if ((post.depth ?? 0) < REPLY_DEPTH_LIMIT) card.append(composer(post));
        if (post.own) card.append(composer(post, true));
      }
      if (post.own) card.append(deletePanel(post));
    }
    return card;
  }

  function renderThread(topic, replies) {
    const main = threadCard(topic, true);
    const responseSection = element('section', null, { class: 'forum-thread', 'aria-label': t('replies') });
    const replyNodes = new Map(replies.map((reply) => [reply.id, { reply, card: threadCard(reply) }]));
    const replyGroups = new Map();
    for (const { reply, card } of replyNodes.values()) {
      const parent = replyNodes.get(reply.parent);
      if (!parent || parent.reply.depth >= reply.depth) {
        responseSection.append(card);
        continue;
      }
      if (!replyGroups.has(reply.parent)) {
        const group = element('div', null, { class: 'forum-thread' });
        replyGroups.set(reply.parent, group);
        parent.card.append(group);
      }
      replyGroups.get(reply.parent).append(card);
    }
    setContent(replies.length ? [main, responseSection] : [main]);
  }

  function activityCards(data) {
    const cards = data.posts.map((post) => {
      const card = element('article', null, { class: 'forum-card' });
      const heading = element('h2', null, { dir: 'auto' });
      if (post.status === 'published') {
        heading.append(hrefLink(post.title ?? t('reply'), topicHref(base, post.topic)));
      } else {
        heading.textContent = post.title ?? t('reply');
      }
      card.append(heading, stateTag(post.status), metadata(dateFormat(post.created_at, language), post.reason),
        renderMessage(post.body));
      if (post.appeal) {
        card.append(metadata(t('appeal'), t(post.appeal.status), post.appeal.reason, post.appeal.response));
      } else if (['hold', 'held', 'blocked', 'flagged', 'hidden'].includes(post.status)) {
        card.append(reasonForm('appeal', 'appeal', post.id, 'saved', async () => {
          await readPage();
          setPageStatus(t('saved'));
        }));
      }
      if (!['deleted', 'published'].includes(post.status)) {
        if (writingOpen && post.status !== 'hidden') card.append(composer(post, true));
        card.append(deletePanel(post));
      }
      return card;
    });
    if (data.sanctions.length) {
      const card = element('article', null, { class: 'forum-card' });
      card.append(element('h2', t('sanctions')));
      for (const entry of data.sanctions) {
        card.append(metadata(t(entry.action), dateFormat(entry.created_at, language),
          dateFormat(entry.expires_at, language), entry.reason));
      }
      cards.push(card);
    }
    return cards;
  }

  function moderationCards(data) {
    const cards = data.posts.map((post) => {
      const card = element('article', null, { class: 'forum-card' });
      card.append(element('h2', post.title ?? t('reply'), { dir: 'auto' }), stateTag(post.status),
        metadata(post.author, dateFormat(post.created_at, language)), renderMessage(post.body));
      if (post.user) {
        const identifier = element('bdi', post.user, { dir: 'ltr' });
        const account = element('p', t('accountId') + ' ');
        const actionButton = element('button', t('sanctions'), { type: 'button' });
        actionButton.addEventListener('click', () => {
          const sanction = root.querySelector('[data-sanction]');
          sanction.reset();
          sanction.elements.p_action.dispatchEvent(new Event('change'));
          sanction.elements.p_user.value = post.user;
          sanction.closest('details').open = true;
          sanction.elements.p_action.focus();
        });
        account.append(identifier);
        const accountActions = element('div', null, { class: 'forum-actions' });
        accountActions.append(actionButton);
        card.append(account, accountActions);
      }
      if (post.reason) card.append(metadata(t('reason'), post.reason));
      if (post.signals && Object.keys(post.signals).length) {
        card.append(details(t('signals'), element('pre', JSON.stringify(post.signals, null, 2), { dir: 'ltr', tabindex: 0 })));
      }
      if (post.reports?.length) {
        card.append(details(t('reports'), ...post.reports.map((report) =>
          metadata(dateFormat(report.created_at, language), report.reason))));
      }
      if (post.appeal) {
        card.append(metadata(t('appeal'), t(post.appeal.status), post.appeal.reason, post.appeal.response));
      }
      const action = element('select', null, { required: '' });
      action.append(option(t('choose'), ''));
      const actions = ['publish', 'hold', 'block', 'flag', 'hide'];
      if (post.appeal?.status === 'pending') actions.push('appeal_accept', 'appeal_deny');
      for (const value of actions) action.append(option(t(value), value));
      const reason = element('textarea', null, { rows: 3, maxlength: 300, required: '', dir: 'auto' });
      card.append(actionForm(t('apply'), [field(t('action'), action), field(t('reason'), reason)], 'review',
        () => ({ p_post: post.id, p_version: post.version, p_action: action.value, p_reason: reason.value }),
        'saved', async () => {
          await readPage();
          setPageStatus(t('saved'));
        }));
      return card;
    });
    if (data.history.length) {
      const card = element('article', null, { class: 'forum-card' });
      card.append(element('h2', t('history')));
      for (const entry of data.history) {
        card.append(metadata(dateFormat(entry.created_at, language), t(entry.action), entry.reason));
      }
      cards.push(card);
    }
    return cards;
  }

  function bindTopicForm() {
    const form = root.querySelector('[data-submit-topic]');
    if (!form) return;
    const select = form.elements.p_category;
    for (const category of categories.values()) select.append(option(categoryTitle(category), category.slug));
    if (!writingOpen || !categories.size) return;
    root.querySelector('[data-composer]').hidden = false;
    const button = form.querySelector('button');
    const result = form.querySelector('[data-result]');
    let draft;
    let requestId;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      return busyButton(button, async () => {
        result.textContent = '';
        const { p_category, p_title, p_body } = Object.fromEntries(new FormData(form));
        const currentDraft = JSON.stringify([p_category, p_title, p_body]);
        if (currentDraft !== draft) {
          requestId = crypto.randomUUID();
          draft = currentDraft;
        }
        try {
          await request('submit', { p_request: requestId, p_category, p_parent: null, p_title, p_body }, 'POST');
          form.reset();
          draft = undefined;
          result.textContent = t('sent');
        } catch (error) {
          result.textContent = errorLabel(error);
        }
      });
    });
  }

  function bindSanctionForm() {
    const form = root.querySelector('[data-sanction]');
    const duration = form.querySelector('[data-duration]');
    const action = form.elements.p_action;
    const button = form.querySelector('button');
    const result = form.querySelector('[data-result]');
    const updateDuration = () => {
      duration.hidden = action.value !== 'suspend';
      form.elements.p_days.required = !duration.hidden;
      form.elements.p_days.disabled = duration.hidden;
    };
    action.addEventListener('change', updateDuration);
    updateDuration();
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      return busyButton(button, async () => {
        result.textContent = '';
        const data = Object.fromEntries(new FormData(form));
        try {
          await request('sanction', { ...data, p_days: data.p_days ? Number(data.p_days) : null }, 'POST');
          form.reset();
          updateDuration();
          await readPage();
          setPageStatus(t('saved'));
        } catch (error) {
          result.textContent = errorLabel(error);
        }
      });
    });
  }

  async function loadTopics() {
    const form = root.querySelector('[data-search]');
    const paginator = root.querySelector('[data-pagination]');
    const previous = paginator.querySelector('[data-previous]');
    const next = paginator.querySelector('[data-next]');
    const [categoryList, settings] = await Promise.all([request('categories'), request('settings')]);
    categories = new Map(categoryList.map((category) => [category.slug, category]));
    writingOpen = settings.writing_open;
    const selector = form.elements.p_category;
    for (const category of categories.values()) selector.append(option(categoryTitle(category), category.slug));
    const query = new URLSearchParams(location.search);
    form.elements.p_search.value = query.get('p_search') ?? '';
    selector.value = categories.has(query.get('p_category')) ? query.get('p_category') : '';
    form.elements.p_sort.value = sortMode(query.get('p_sort'));
    bindTopicForm();
    let offset = 0;
    readPage = async () => {
      const generation = ++renderGeneration;
      setPageStatus(t('loading'));
      const parameters = queryInputs(form, offset);
      const topics = await request('topics', parameters);
      if (generation !== renderGeneration) return;
      setContent(topics.map(topicCard));
      setPageStatus(writingOpen ? '' : t('readOnly'));
      paginator.hidden = offset === 0 && topics.length < TOPIC_PAGE_SIZE;
      previous.disabled = offset === 0;
      next.disabled = topics.length < TOPIC_PAGE_SIZE || offset >= MAX_OFFSET;
    };
    const rerun = () => readPage().catch((error) => setPageStatus(errorLabel(error)));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      offset = 0;
      const filters = queryInputs(form, offset);
      const search = new URLSearchParams();
      if (filters.p_search) search.set('p_search', filters.p_search);
      if (filters.p_category) search.set('p_category', filters.p_category);
      if (filters.p_sort !== 'recent') search.set('p_sort', filters.p_sort);
      history.replaceState(null, '', location.pathname + (search.size ? '?' + search : ''));
      return rerun();
    });
    previous.addEventListener('click', () => { offset = Math.max(0, offset - TOPIC_PAGE_SIZE); return rerun(); });
    next.addEventListener('click', () => { offset = Math.min(MAX_OFFSET, offset + TOPIC_PAGE_SIZE); return rerun(); });
    await readPage();
  }

  async function loadThread() {
    const more = root.querySelector('[data-more]');
    let offset = 0;
    const replies = new Map();
    async function loadPage() {
      setPageStatus(t('loading'));
      const thread = await request('thread', { p_topic: topicId, p_offset: offset });
      if (!thread?.topic) {
        content.replaceChildren();
        more.hidden = true;
        setPageStatus(t('unavailable'));
        return;
      }
      writingOpen = thread.writing_open;
      heading.textContent = thread.topic.title;
      heading.dir = 'auto';
      for (const reply of thread.replies) replies.set(reply.id, reply);
      renderThread(thread.topic, [...replies.values()]);
      more.hidden = offset + thread.replies.length >= thread.reply_count || offset >= MAX_OFFSET;
      setPageStatus(writingOpen ? '' : t('readOnly'));
    }
    readPage = () => {
      offset = 0;
      replies.clear();
      return loadPage();
    };
    more.addEventListener('click', () => busyButton(more, async () => {
      offset += REPLY_PAGE_SIZE;
      try {
        await loadPage();
      } catch (error) {
        offset -= REPLY_PAGE_SIZE;
        setPageStatus(errorLabel(error));
      }
    }));
    await readPage();
  }

  async function loadModeration() {
    const form = root.querySelector('[data-queue-filter]');
    const paginator = root.querySelector('[data-pagination]');
    const previous = paginator.querySelector('[data-previous]');
    const next = paginator.querySelector('[data-next]');
    let offset = 0;
    readPage = async () => {
      const generation = ++renderGeneration;
      setPageStatus(t('loading'));
      const parameters = { p_status: form.elements.p_status.value, p_offset: offset };
      const data = await request('queue', parameters);
      if (generation !== renderGeneration) return;
      if (offset && !data.posts.length) {
        offset = Math.max(0, offset - QUEUE_PAGE_SIZE);
        return readPage();
      }
      setContent(moderationCards(data));
      paginator.hidden = offset === 0 && data.total <= QUEUE_PAGE_SIZE;
      previous.disabled = offset === 0;
      next.disabled = offset + QUEUE_PAGE_SIZE >= data.total || offset >= MAX_OFFSET;
      setPageStatus('');
    };
    const rerun = () => readPage().catch((error) => setPageStatus(errorLabel(error)));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      offset = 0;
      return rerun();
    });
    previous.addEventListener('click', () => { offset = Math.max(0, offset - QUEUE_PAGE_SIZE); return rerun(); });
    next.addEventListener('click', () => { offset = Math.min(MAX_OFFSET, offset + QUEUE_PAGE_SIZE); return rerun(); });
    bindSanctionForm();
    await readPage();
  }

  setPageStatus(t('loading'));
  try {
    switch (root.dataset.forumView) {
      case 'topics': await loadTopics(); break;
      case 'topic': await loadThread(); break;
      case 'activity':
        writingOpen = (await request('settings')).writing_open;
        readPage = async () => {
          setContent(activityCards(await request('activity')));
          setPageStatus('');
        };
        await readPage();
        break;
      case 'moderation': await loadModeration(); break;
    }
  } catch (error) {
    setPageStatus(errorLabel(error));
  }
}

const forum = globalThis.document?.querySelector('[data-forum-view] [data-labels]')?.closest('[data-forum-view]');
if (forum) setupCommunity(forum);
