/**
 * Terminal effects for the console site theme (data-mode="console"):
 * - a post is "typed" on screen every time it is opened (a click or key press skips the typing)
 * - hovering links, cards and buttons plays a short typing sound
 * Sound is on by default (same volume knob setting as the console) and waits for the first click or key,
 * because browsers only allow audio after a user gesture.
 */

import { ConsoleSound } from '../console/sound';
import { createKnob } from '../console/knob';

const TARGETS = 'p, li, h2, h3, h4, h5, h6, blockquote, dt, dd';
// things that must appear at once: typing inside them would break their layout
const SKIP = 'pre, code, table, figure, img, svg, canvas, iframe, details, script, style, .mermaid, .interactive-map, .obsidian-canvas, [data-nofx]';
const HOVER = 'a, button, summary, label, .card, .post-preview, .nav-link, .tag, .btn';
const CHAR_MS = 7;
const MAX_MS = 5000;

const sound = new ConsoleSound({});

const isConsoleTheme = () => /^console/.test(document.documentElement.getAttribute('data-mode') ?? '');

/* ---------- hover sound ---------- */

function initHoverSound() {
  // browsers start audio only after a click / key press: create the context now and resume it on the first one
  sound.unlock();
  const unlock = () => sound.unlock();
  for (const type of ['pointerdown', 'keydown', 'touchstart', 'click']) {
    document.addEventListener(type, unlock, { passive: true });
  }

  let last = null;
  let lastAt = 0;

  document.addEventListener('pointerover', (event) => {
    if (!isConsoleTheme() || event.pointerType === 'touch') {
      return;
    }

    const element = event.target instanceof Element ? event.target.closest(HOVER) : null;
    if (!element) {
      last = null;
      return;
    }
    if (element === last) {
      return;
    }
    last = element;

    // a single key click per element; sweeping the pointer across many of them is rate-limited
    const now = performance.now();
    if (now - lastAt < 220) {
      return;
    }
    lastAt = now;
    sound.key();
  });
}

/* ---------- volume knob in the sidebar ---------- */

function initVolumeKnob() {
  const host = document.getElementById('sound-toggle');
  if (!host || host.dataset.bound) {
    return;
  }
  host.dataset.bound = 'true';

  createKnob(host, {
    value: sound.level,
    onInput: (value) => {
      sound.unlock();
      sound.setVolume(value);
      sound.tick();
    }
  });
}

/* ---------- typing a post ---------- */

function collectTextNodes(article) {
  const nodes = [];
  const roots = [article.querySelector('h1'), article.querySelector('.content')].filter(Boolean);

  for (const root of roots) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || !node.nodeValue.trim() || parent.closest(SKIP)) {
        continue;
      }
      if (root.tagName !== 'H1' && !parent.closest(TARGETS)) {
        continue;
      }
      nodes.push(node);
    }
  }
  return nodes;
}

function typePost() {
  const article = document.querySelector('article[data-typefx]');
  if (!article) {
    return;
  }

  const ready = () => article.setAttribute('data-fx-ready', 'true');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (!isConsoleTheme() || reduced || location.hash) {
    ready();
    return;
  }

  const parts = collectTextNodes(article).map((node) => {
    const full = node.nodeValue;
    const shown = document.createTextNode('');
    const hidden = document.createElement('span');
    hidden.className = 'fx-hidden';
    hidden.textContent = full;
    node.replaceWith(shown, hidden);
    return { full, shown, hidden, original: node };
  });

  if (parts.length === 0) {
    ready();
    return;
  }

  const caret = document.createElement('span');
  caret.className = 'fx-caret';
  caret.textContent = '█';

  const total = parts.reduce((sum, part) => sum + part.full.length, 0);
  const perChar = Math.min(CHAR_MS, MAX_MS / total);
  let index = 0;
  let offset = 0;
  let finished = false;
  let skipHandler = null;
  const started = performance.now();

  const finish = () => {
    if (finished) {
      return;
    }
    finished = true;

    for (const part of parts) {
      part.shown.replaceWith(part.original);
      part.hidden.remove();
    }
    caret.remove();
    for (const type of ['click', 'keydown']) {
      window.removeEventListener(type, skipHandler);
    }
  };

  const step = () => {
    if (finished) {
      return;
    }

    // text the reader has already scrolled past is shown at once, so typing carries on where they are looking
    while (index < parts.length && parts[index].hidden.getBoundingClientRect().bottom < -40) {
      const passed = parts[index];
      passed.shown.nodeValue = passed.full;
      passed.hidden.textContent = '';
      index += 1;
      offset = 0;
    }
    if (index >= parts.length) {
      finish();
      return;
    }

    let count = Math.max(1, Math.floor((performance.now() - started) / perChar) - typed());
    const before = typed();
    while (count > 0 && index < parts.length) {
      const part = parts[index];
      const take = Math.min(count, part.full.length - offset);
      offset += take;
      count -= take;
      part.shown.nodeValue = part.full.slice(0, offset);
      part.hidden.textContent = part.full.slice(offset);
      if (offset >= part.full.length) {
        index += 1;
        offset = 0;
      }
    }

    if (index >= parts.length) {
      finish();
      return;
    }

    parts[index].shown.after(caret);
    if (typed() - before >= 1) {
      sound.tick();
    }
    requestAnimationFrame(step);
  };

  const typed = () => parts.slice(0, index).reduce((sum, part) => sum + part.full.length, 0) + offset;

  ready();
  requestAnimationFrame(() => {
    // a tap or key press skips the typing; scrolling (touch swipes included) does not.
    // While the browser still keeps the audio locked, that first tap only unlocks it, so the typing sound can start.
    const skip = () => {
      if (sound.enabled && sound.ctx && sound.ctx.state !== 'running') {
        sound.unlock();
        return;
      }
      finish();
    };
    skipHandler = skip;
    for (const type of ['click', 'keydown']) {
      window.addEventListener(type, skip, { passive: true });
    }
    requestAnimationFrame(step);
  });
}

/* ---------- screen glitch bursts ---------- */

function initGlitch() {
  const root = document.documentElement;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  const schedule = () => {
    setTimeout(burst, 4000 + Math.random() * 7000);
  };

  const burst = () => {
    if (isConsoleTheme() && !reduced.matches && !document.hidden) {
      const sign = Math.random() < 0.5 ? -1 : 1;
      root.style.setProperty('--gx', `${sign * (3 + Math.random() * 6)}px`);
      root.style.setProperty('--gy', `${5 + Math.random() * 85}%`);
      root.classList.add('crt-glitch');
      setTimeout(() => root.classList.remove('crt-glitch'), 140 + Math.random() * 140);
    }
    schedule();
  };

  schedule();
}

export function terminalFx() {
  if (window.__terminalFx) {
    return;
  }
  window.__terminalFx = true;

  initHoverSound();
  initGlitch();
  initVolumeKnob();
  typePost();
}
