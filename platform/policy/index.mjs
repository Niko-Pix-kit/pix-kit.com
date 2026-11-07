import translations from './messages.json' with { type: 'json' };
import { escapeHtml, localPath, messagesFor, portalLocale, renderShell } from '../ui/shell.mjs';

const contactEmail = 'info@pix-kit.com';
const pageDefinitions = new Map([
  ['/community-guidelines/', {
    key: 'guidelines',
    sections: ['purpose', 'rules', 'moderation', 'reports-and-appeals'],
  }],
  ['/platform-privacy/', {
    key: 'privacy',
    sections: ['account-and-learning', 'forum-and-safety', 'retention-and-rights'],
  }],
  ['/platform-terms/', {
    key: 'terms',
    sections: ['membership-and-access', 'participation'],
  }],
]);

function policyLinks(code, path, copy, profile) {
  const navigation = messagesFor(code);
  const links = [
    ...Array.from(pageDefinitions, ([href, { key }]) => [href, copy[key][0]])
      .filter(([href]) => href !== path),
    ...(profile ? [['/community/', navigation.community]] : []),
    ['/account/', navigation.account],
    ['/terms-of-use/', navigation.terms],
    ['/cookie-policy/', navigation.cookies],
  ];
  return links.map(([href, label]) => (
    `<a href="${escapeHtml(localPath(code, href))}">${escapeHtml(label)}</a>`
  )).join('\n');
}

export function renderPolicyPage({ locale, path, profile }) {
  const definition = pageDefinitions.get(path);
  if (!definition) return null;

  const { code } = portalLocale(locale);
  const copy = translations[code];
  const [title, ...sections] = copy[definition.key];
  const cards = sections.map(([heading, paragraph], index) => {
    const sectionId = definition.sections[index];
    return `<section class="legal-card" id="${sectionId}" aria-labelledby="heading-${sectionId}">
      <h2 id="heading-${sectionId}">${escapeHtml(heading)}</h2>
      <p>${escapeHtml(paragraph)}</p>
    </section>`;
  });
  return renderShell({
    locale: code,
    path,
    profile,
    title,
    body: `<article class="legal-page">
      <header class="legal-hero">
        <h1>${escapeHtml(title)}</h1>
        <div class="legal-links">${policyLinks(code, path, copy, profile)}</div>
      </header>
      ${cards.join('\n')}
      <p class="legal-links"><a href="mailto:${contactEmail}"><bdi>${contactEmail}</bdi></a></p>
    </article>`,
  });
}
