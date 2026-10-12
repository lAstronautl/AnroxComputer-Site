/**
 * First-visit theme picker and the console-style boot screen (see _includes/boot-overlay.html).
 * theme.js decides before paint which one is needed and marks <html> with `boot-choose` or `boot-run`.
 */

import { ConsoleSound } from '../console/sound';
import { LOGO, LOGO_SMALL } from '../console/logo';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runBoot(overlay, sound) {
  const root = document.documentElement;
  const screen = overlay.querySelector('#boot-screen');
  screen.replaceChildren();
  Theme.markBootDone();

  let skipped = false;
  const skip = () => {
    skipped = true;
  };
  for (const type of ['pointerdown', 'keydown']) {
    window.addEventListener(type, skip, { once: true });
  }

  void sound.sting();

  const print = async (text, { ok = false, wait = 0, cls = '' } = {}) => {
    const line = document.createElement('div');
    line.className = cls;
    line.textContent = text || '\u00a0';
    if (ok) {
      const mark = document.createElement('span');
      mark.className = 'boot-ok';
      mark.textContent = ' OK';
      line.append(mark);
    }
    screen.append(line);
    sound.tick();
    if (!skipped && wait) {
      await sleep(wait);
    }
  };

  const checks = (() => {
    try {
      return JSON.parse(overlay.dataset.checks || '[]') ?? [];
    } catch {
      return [];
    }
  })();

  const logo = window.innerWidth >= 720 ? LOGO : LOGO_SMALL;
  for (const row of logo) {
    await print(row, { wait: 40, cls: 'boot-logo' });
  }
  await print('');
  await print(overlay.dataset.title, { cls: 'boot-title' });
  await print(overlay.dataset.version);
  await print(overlay.dataset.subtitle, { wait: 150 });

  for (const check of checks) {
    await print(`${check} `.padEnd(38, '.'), { ok: true, wait: 130 + Math.random() * 120 });
  }

  await print('');
  await print('ДОСТУП К СЕТИ ОТКРЫТ', { cls: 'boot-title', wait: skipped ? 0 : 450 });

  overlay.classList.add('boot-fade');
  await sleep(500);
  root.classList.remove('boot-run');
  overlay.classList.remove('boot-fade');
}

export function bootScreen() {
  if (window.__bootScreen) {
    return;
  }
  window.__bootScreen = true;

  const overlay = document.getElementById('boot-overlay');
  if (!overlay) {
    return;
  }
  overlay.dataset.ready = 'true';

  const root = document.documentElement;
  const sound = new ConsoleSound({ startUrl: overlay.dataset.sound });

  if (root.classList.contains('boot-run')) {
    void runBoot(overlay, sound);
    return;
  }

  if (!root.classList.contains('boot-choose')) {
    return;
  }

  const choose = (theme) => {
    sound.unlock(); // the click is the gesture that lets the start-up sound play
    Theme.setTheme(theme);
    root.classList.remove('boot-choose');

    if (theme === Theme.CONSOLE_RED) {
      root.classList.add('boot-run');
      void runBoot(overlay, sound);
    } else {
      Theme.markBootDone();
    }
  };

  const buttons = overlay.querySelectorAll('#boot-choose button[data-theme]');
  for (const button of buttons) {
    button.addEventListener('click', () => choose(button.dataset.theme));
  }

  window.addEventListener('keydown', (event) => {
    if (!root.classList.contains('boot-choose')) {
      return;
    }
    if (event.key === '1') {
      choose(Theme.ANCO);
    } else if (event.key === '2') {
      choose(Theme.CONSOLE_RED);
    }
  });

  buttons[0]?.focus({ preventScroll: true });
}
