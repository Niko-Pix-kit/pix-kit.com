/* Optional enhancement. The underlying page is complete, readable HTML. */
(() => {
  if (new URLSearchParams(location.search).get('letters') === 'off') return;
  document.querySelectorAll('[data-brand-letters]').forEach((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.parentElement.closest('a:not(.brand), button, input, textarea, select, script, style, .brand-p, .brand-k')
          ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      }
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach((node) => {
      if (!/[pk]/i.test(node.data)) return;
      const fragment = document.createDocumentFragment();
      node.data.split(/([pk])/i).forEach((part) => {
        if (/^[pk]$/i.test(part)) {
          const span = document.createElement('span');
          span.className = `brand-${part.toLowerCase()}`;
          span.textContent = part;
          fragment.append(span);
        } else {
          fragment.append(document.createTextNode(part));
        }
      });
      node.replaceWith(fragment);
    });
  });
})();
