/* Color descriptive copy only; links, controls and their layout stay intact. */
(function () {
  'use strict';

  const scope = 'main[data-pixkit-copy], [data-brand-letters]';
  const excluded = 'a,button,input,textarea,select,option,label,summary,nav,script,style,svg,code,pre,template,noscript,dialog,.cookie-banner,#cookie-banner,.cookie-policy,.legal-article,[hidden],[aria-hidden="true"],[inert],[contenteditable],[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="slider"],[role="tab"],span:not([data-brand-letters]),.brand-p,.brand-k';

  // Every ASCII P/p and K/k in copy receives its color, regardless of the word.
  // Visible URLs and email addresses remain a single untouched text segment.
  function tokenizeLetters(value) {
    const text = String(value);
    const parts = [];
    function plain(value) {
      if (!value) return;
      const previous = parts[parts.length - 1];
      if (previous && !previous.letter) previous.text += value;
      else parts.push({ text: value, letter: null });
    }
    function letters(value) {
      for (const character of value) {
        const letter = character.toLowerCase();
        if (letter === 'p' || letter === 'k') parts.push({ text: character, letter });
        else plain(character);
      }
    }
    const urls = /(?:https?:\/\/|mailto:|www\.)[^\s]+|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
    let cursor = 0;
    for (const match of text.matchAll(urls)) {
      letters(text.slice(cursor, match.index));
      plain(match[0]);
      cursor = match.index + match[0].length;
    }
    letters(text.slice(cursor));
    return parts;
  }

  function colorize(root) {
    if (root.closest(excluded)) return;
    const nodes = [];
    const walker = document.createTreeWalker(root, 4 /* SHOW_TEXT */);
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      if (!node.parentElement || node.parentElement.closest(excluded)) continue;
      const parts = tokenizeLetters(node.data);
      if (!parts.some(part => part.letter)) continue;
      const fragment = document.createDocumentFragment();
      for (const part of parts) {
        if (part.letter) {
          const span = document.createElement('span');
          span.className = 'brand-' + part.letter;
          span.textContent = part.text;
          fragment.appendChild(span);
        } else fragment.appendChild(document.createTextNode(part.text));
      }
      node.replaceWith(fragment);
    }
  }

  function start() {
    // The sites are static. A scoped initial pass needs no mutation observer.
    const roots = Array.from(document.querySelectorAll(scope));
    for (const root of roots) {
      if (!roots.some(other => other !== root && other.contains(root))) colorize(root);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
