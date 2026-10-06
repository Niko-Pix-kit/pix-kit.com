'use strict';

(() => {
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const galleries = document.querySelectorAll('[data-gallery]');

  galleries.forEach((gallery) => {
    const track = gallery.querySelector('.gallery-track');
    const slides = [...track.querySelectorAll('.slide')];
    const tools = gallery.querySelector('.gallery-tools');
    const previous = gallery.querySelector('[data-previous]');
    const next = gallery.querySelector('[data-next]');
    const status = gallery.querySelector('[data-status]');
    let current = 0;
    let frame = 0;

    const update = () => {
      frame = 0;
      const index = Math.max(0, Math.min(slides.length - 1,
        Math.round(track.scrollLeft / Math.max(1, track.clientWidth))));
      current = index;
      previous.disabled = current === 0;
      next.disabled = current === slides.length - 1;
      status.textContent = `${current + 1} / ${slides.length}`;
    };
    const go = (index) => track.scrollTo({
      left: Math.max(0, Math.min(slides.length - 1, index)) * track.clientWidth,
      behavior: reducedMotion.matches ? 'instant' : 'smooth'
    });
    previous.addEventListener('click', () => go(current - 1));
    next.addEventListener('click', () => go(current + 1));
    track.addEventListener('keydown', (event) => {
      if (event.target !== track) return;
      if (event.key === 'ArrowRight') { event.preventDefault(); go(current + 1); }
      if (event.key === 'ArrowLeft') { event.preventDefault(); go(current - 1); }
      if (event.key === 'Home') { event.preventDefault(); go(0); }
      if (event.key === 'End') { event.preventDefault(); go(slides.length - 1); }
    });
    track.addEventListener('scroll', () => {
      if (!frame) frame = requestAnimationFrame(update);
    }, { passive: true });
    // Keep the same slide after rotating a phone or resizing a window.
    if ('ResizeObserver' in window) {
      let width = track.clientWidth;
      new ResizeObserver(() => {
        if (width === track.clientWidth) return;
        width = track.clientWidth;
        track.scrollTo({ left: current * width, behavior: 'instant' });
        update();
      }).observe(track);
    }
    tools.hidden = false;
    update();
  });

  const dialog = document.querySelector('#image-viewer');
  if (!dialog || typeof dialog.showModal !== 'function') return;
  const image = dialog.querySelector('img');
  const caption = dialog.querySelector('[data-viewer-caption]');
  document.querySelectorAll('[data-image]').forEach((link) => {
    link.addEventListener('click', (event) => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      image.src = link.href;
      image.alt = link.querySelector('img').alt;
      caption.textContent = link.closest('.slide').querySelector('figcaption').textContent;
      dialog.showModal();
    });
  });
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
  dialog.addEventListener('close', () => image.removeAttribute('src'));
})();
