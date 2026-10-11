/**
 * Terminal effects for the console site themes (data-mode="console-red" / "console-green"):
 * - a post is "typed" on screen the first time it is opened in a session
 * - hovering links, cards and buttons plays a short typing sound
 * Sound is on by default (same switch as the console tab) and waits for the first click or key,
 * because browsers only allow audio after a user gesture.
 */

import { ConsoleSound } from '../console/sound';

const TARGETS = 'p, li, h2, h3, h4, h5, h6, blockquote, dt, dd';
// things that must appear at once: typing inside them would break their layout
const SKIP = 'pre, code, table, figure, img, svg, canvas, iframe, details, script, style, .mermaid, .interactive-map, .obsidian-canvas, [data-nofx]';
const HOVER = 'a, button, summary, label, .card, .post-preview, .nav-link, .tag, .btn';
const CHAR_MS = 7;
const MAX_MS = 5000;
const SEEN_KEY = 'anco-fx-typed';

const sound = new ConsoleSound({});

const isConsoleTheme = () => /^console/.test(document.documentElement.getAttribute('data-mode') ?? '');

function readSeen() {
  try {
    return JSON.parse(sessionStorage.getItem(SEEN_KEY) ?? '[]');
  } catch {
    return [];
  }
}

function markSeen(path) {
  try {
    sessionStorage.setItem(SEEN_KEY, JSON.stringify([...new Set([...readSeen(), path])]));
  } catch {
    // storage blocked: the post will simply be typed again next time
  }
}

/* ---------- hover sound ---------- */

function initHoverSound() {
  const unlock = () => sound.unlock();
  for (const type of ['pointerdown', 'keydown', 'touchstart']) {
    document.addEventListener(type, unlock, { once: true, passive: true });
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

    const now = performance.now();
    if (now - lastAt < 140) {
      return;
    }
    lastAt = now;

    // three quick key clicks, like a short burst of typing
    for (let i = 0; i < 3; i += 1) {
      setTimeout(() => sound.tick(), i * 55);
    }
  });
}

/* ---------- sound switch in the sidebar ---------- */

function initSoundSwitch() {
  const button = document.getElementById('sound-toggle');
  if (!button || button.dataset.bound) {
    return;
  }
  button.dataset.bound = 'true';

  const paint = () => {
    const icon = button.querySelector('i');
    if (icon) {
      icon.className = sound.enabled ? 'fas fa-volume-high' : 'fas fa-volume-xmark';
    }
    const label = sound.enabled ? 'Звук: вкл' : 'Звук: выкл';
    button.setAttribute('title', label);
    button.setAttribute('aria-label', label);
  };

  paint();
  button.addEventListener('click', () => {
    sound.mute(sound.enabled);
    sound.unlock();
    paint();
    if (sound.enabled) {
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
  const path = location.pathname;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (!isConsoleTheme() || reduced || location.hash || readSeen().includes(path)) {
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
    for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll']) {
      window.removeEventListener(type, finish);
    }
    markSeen(path);
  };

  const step = () => {
    if (finished) {
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
    for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll']) {
      window.addEventListener(type, finish, { passive: true });
    }
    requestAnimationFrame(step);
  });
}

export function terminalFx() {
  if (window.__terminalFx) {
    return;
  }
  window.__terminalFx = true;

  initHoverSound();
  initSoundSwitch();
  typePost();
}
