// Country names remain searchable when a flag precedes the native option label.
import './avatar-editor.js';

for (const select of document.querySelectorAll('select[name="countryCode"]')) {
  let search = '';
  let lastTyped = 0;
  const normalize = value => value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();
  select.addEventListener('keydown', event => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1 ||
        !/[\p{L}\p{N} ]/u.test(event.key)) return;
    const current = performance.now();
    search = current - lastTyped > 1000 ? event.key : search + event.key;
    lastTyped = current;
    const find = query => [...select.options].find(option => option.value &&
      normalize(option.textContent.replace(/^[\u{1F1E6}-\u{1F1FF}]{2}\s+/u, '')).startsWith(normalize(query)));
    let match = find(search);
    if (!match) { search = event.key; match = find(search); }
    if (!match) return;
    event.preventDefault();
    select.value = match.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
