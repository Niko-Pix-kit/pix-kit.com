'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const corporate = fs.existsSync(path.join(__dirname, '../assets/carousels.js'));
const source = fs.readFileSync(path.join(__dirname, corporate ? '../assets/carousels.js' : '../assets/js/site.js'), 'utf8');

class Element {
  constructor() {
    this.events = new Map(); this.attrs = {}; this.dataset = {}; this.children = [];
    this.style = {values: {}, setProperty(key, value) {this.values[key] = value;}};
    const classes = new Set();
    this.classList = {add: key => classes.add(key), remove: key => classes.delete(key)};
  }
  addEventListener(type, callback) {this.events.set(type, [...(this.events.get(type) || []), callback]);}
  emit(type, extra = {}) {
    const event = {target: this, preventDefault() {this.prevented = true;}, ...extra};
    for (const callback of this.events.get(type) || []) callback(event);
    return event;
  }
  getAttribute(key) {return this.attrs[key];}
  setAttribute(key, value) {this.attrs[key] = value;}
  querySelector(selector) {return this.selectors?.[selector] || null;}
  querySelectorAll(selector) {return selector === '.slide' ? this.children : [];}
}

function fixture({rtl = false, reduced = false, count = 3} = {}) {
  const gallery = new Element(), track = new Element(), previous = new Element();
  const next = new Element(), status = new Element(), controls = new Element();
  const toggle = new Element(), icon = new Element(), document = new Element();
  const motion = new Element(), observers = [], visibility = [], frames = [], timers = new Map();
  let serial = 0, now = 0;
  motion.matches = reduced;
  status.dataset.positionTemplate = '{current} / {total}';
  toggle.dataset = {pauseLabel: 'Pause slideshow', playLabel: 'Resume slideshow'};
  toggle.selectors = {span: icon};
  gallery.dataset.carouselAutoplay = '2000';
  track.clientWidth = 300; track.scrollLeft = 0;
  track.getBoundingClientRect = () => ({left: 0, right: track.clientWidth});
  const dimensions = [[1024, 500], [891, 2000], [1080, 1920]];
  track.children = Array.from({length: count}, (_, index) => {
    const slide = new Element(), image = new Element();
    image.attrs = {width: String(dimensions[index][0]), height: String(dimensions[index][1])};
    slide.selectors = {img: image};
    slide.getBoundingClientRect = () => {
      const width = track.clientWidth, offset = index * (width + 24);
      const left = rtl ? -offset - track.scrollLeft : offset - track.scrollLeft;
      return {left, right: left + width};
    };
    return slide;
  });
  track.scrollTo = options => {track.lastScroll = options; track.scrollLeft = options.left; track.emit('scroll');};
  gallery.selectors = {'.gallery-track': track, '.carousel-track': track, '.gallery-tools': controls,
    '.carousel-controls': controls, '[data-previous]': previous, '[data-next]': next, '[data-status]': status};
  controls.selectors = {'[data-carousel-prev]': previous, '[data-carousel-next]': next,
    '.carousel-position': status, '[data-carousel-toggle]': toggle};
  const members = new Set([gallery, track, previous, next, toggle, status]);
  gallery.contains = element => members.has(element);
  document.activeElement = null; document.hidden = false;
  document.querySelectorAll = selector => selector === (corporate ? '[data-carousel]' : '[data-gallery]') ? [gallery] : [];
  document.querySelector = () => null;
  const flush = () => {while (frames.length) frames.shift()();};
  const context = {document, matchMedia: () => motion, getComputedStyle: () => ({direction: rtl ? 'rtl' : 'ltr'}),
    requestAnimationFrame: callback => {frames.push(callback); return ++serial;},
    setTimeout: (callback, delay) => {const id = ++serial; timers.set(id, {callback, at: now + delay, delay}); return id;},
    clearTimeout: id => timers.delete(id),
    ResizeObserver: class {constructor(callback) {observers.push(callback);} observe() {}},
    IntersectionObserver: class {constructor(callback) {visibility.push(callback);} observe() {}}
  };
  context.window = context;
  vm.runInNewContext(source, context);
  flush();
  function advance(milliseconds) {
    const end = now + milliseconds;
    for (;;) {
      const pending = [...timers.entries()].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!pending) break;
      now = pending[1].at; timers.delete(pending[0]); pending[1].callback(); flush();
    }
    now = end; flush();
  }
  return {gallery, track, previous, next, status, toggle, document, motion, timers,
    flush, advance, resize: width => {track.clientWidth = width; observers.forEach(callback => callback()); flush();},
    visible: value => visibility.forEach(callback => callback([{isIntersecting: value}]))};
}

const next = env => {env.next.emit('click'); env.flush();};
const previous = env => {env.previous.emit('click'); env.flush();};

test('manual navigation wraps at both ends and keeps controls available', () => {
  const env = fixture();
  previous(env);
  assert.equal(env.status.textContent, '3 / 3');
  assert.equal(env.track.lastScroll.behavior, 'instant');
  next(env);
  assert.equal(env.status.textContent, '1 / 3');
  assert.equal(env.previous.disabled, false);
  assert.equal(env.next.disabled, false);
});

test('rotation preserves the selected image', () => {
  const env = fixture(); next(env); env.advance(180); env.resize(640);
  assert.equal(env.status.textContent, '2 / 3');
  assert.equal(env.track.lastScroll.left, corporate ? 664 : 640);
  assert.equal(env.track.lastScroll.behavior, 'instant');
});

test('reduced motion uses immediate navigation', () => {
  const env = fixture({reduced: true}); next(env);
  assert.equal(env.track.lastScroll.behavior, 'instant');
  assert.equal([...env.timers.values()].filter(timer => timer.delay === 2000).length, 0);
});

if (!corporate) {
  test('gallery ratio follows the active landscape or portrait image', () => {
    const env = fixture();
    assert.equal(env.gallery.style.values['--gallery-ratio'], '1024 / 500');
    next(env);
    assert.equal(env.gallery.style.values['--gallery-ratio'], '891 / 2000');
    assert.equal(env.timers.size, 0, 'Pix-kit must remain a manual gallery');
  });
  test('keyboard navigation and one-image galleries remain usable', () => {
    const env = fixture();
    assert.equal(env.track.emit('keydown', {key: 'End'}).prevented, true); env.flush();
    assert.equal(env.status.textContent, '3 / 3');
    assert.equal(env.track.emit('keydown', {key: 'Home'}).prevented, true); env.flush();
    assert.equal(env.status.textContent, '1 / 3');
    const one = fixture({count: 1});
    assert.equal(one.previous.disabled, true); assert.equal(one.next.disabled, true);
  });
} else {
  test('autoplay advances after two seconds and cycles back to the start', () => {
    const env = fixture(); env.advance(1999); assert.equal(env.status.textContent, '1 / 3');
    env.advance(1); assert.equal(env.status.textContent, '2 / 3');
    env.advance(2180); assert.equal(env.status.textContent, '3 / 3');
    env.advance(2180); assert.equal(env.status.textContent, '1 / 3');
    assert.equal(env.track.lastScroll.behavior, 'instant');
  });
  test('pause and resume controls update their accessible labels', () => {
    const env = fixture(); env.toggle.emit('click'); env.advance(5000);
    assert.equal(env.status.textContent, '1 / 3');
    assert.equal(env.toggle.attrs['aria-label'], 'Resume slideshow');
    assert.equal(env.toggle.attrs['aria-pressed'], 'true');
    env.toggle.emit('click'); env.advance(2000);
    assert.equal(env.status.textContent, '2 / 3');
    assert.equal(env.toggle.attrs['aria-label'], 'Pause slideshow');
  });
  test('hover, focus, hidden pages and offscreen sections pause autoplay', () => {
    const env = fixture();
    env.gallery.emit('pointerenter', {pointerType: 'mouse'}); env.advance(3000);
    assert.equal(env.status.textContent, '1 / 3');
    env.gallery.emit('pointerleave'); env.document.activeElement = env.track; env.gallery.emit('focusin'); env.advance(3000);
    assert.equal(env.status.textContent, '1 / 3');
    env.document.activeElement = null; env.gallery.emit('focusout'); env.advance(0);
    env.document.hidden = true; env.document.emit('visibilitychange'); env.advance(3000);
    assert.equal(env.status.textContent, '1 / 3');
    env.document.hidden = false; env.document.emit('visibilitychange'); env.visible(false); env.advance(3000);
    assert.equal(env.status.textContent, '1 / 3');
    env.visible(true); env.advance(2000); assert.equal(env.status.textContent, '2 / 3');
  });
  test('a tap without scrolling resumes the timer', () => {
    const env = fixture(); env.track.emit('pointerdown'); env.advance(2500);
    assert.equal(env.status.textContent, '1 / 3');
    env.track.emit('pointerup'); env.advance(2000); assert.equal(env.status.textContent, '2 / 3');
  });
  test('RTL arrows wrap correctly and preserve the active slide on rotation', () => {
    const env = fixture({rtl: true}); previous(env); env.advance(180);
    assert.equal(env.status.textContent, '3 / 3');
    next(env); env.advance(180); assert.equal(env.status.textContent, '1 / 3');
    next(env); env.advance(180); env.resize(640);
    assert.equal(env.status.textContent, '2 / 3');
    assert.equal(env.track.lastScroll.left, -664);
  });
}
