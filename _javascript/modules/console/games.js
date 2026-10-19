/**
 * Mini-games for the console. Both talk to the shell only through a small
 * interface: `raw()` / `println()` to draw, `ask()` for lines of input and
 * `setKeyHandler()` to grab single key presses while a game runs.
 */

import { c } from './ansi';

/* ------------------------------------------------------------------ */
/* Hack (word-guessing, in the spirit of terminal hacking mini-games)  */
/* ------------------------------------------------------------------ */

const NOISE = '!@#$%^&*()_+-=[]{};:,.<>/?|~';

function shuffle(list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function noise(length) {
  let s = '';
  for (let i = 0; i < length; i += 1) s += NOISE[Math.floor(Math.random() * NOISE.length)];
  return s;
}

function likeness(a, b) {
  let n = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) if (a[i] === b[i]) n += 1;
  return n;
}

function maskedFragment(words) {
  if (!words.length) return null;
  const word = words[Math.floor(Math.random() * words.length)];
  return [...word].map((ch, i) => (/[A-Za-zА-Яа-яЁё]/.test(ch) && i % 2 === 1 ? '█' : ch)).join('');
}

export async function playHack(shell) {
  const pool = (shell.data.hack_words ?? []).map((w) => w.toUpperCase());
  if (pool.length < 4) {
    shell.println(c.red('Словарь взлома пуст.'));
    return;
  }

  const words = shuffle(pool).slice(0, 8);
  const answer = words[Math.floor(Math.random() * words.length)];
  const lineWidth = 30;
  const lines = Array.from({ length: 14 }, () => noise(lineWidth));
  const slots = shuffle([...lines.keys()]).slice(0, words.length);

  words.forEach((word, i) => {
    const row = slots[i];
    const col = Math.floor(Math.random() * (lineWidth - word.length));
    lines[row] = lines[row].slice(0, col) + word + lines[row].slice(col + word.length);
  });

  shell.println('');
  shell.println(c.red('=== ПЕРЕХВАТ ДАМПА ПАМЯТИ ==='));
  shell.println(c.grey('Найдите пароль среди слов. После каждой попытки — число совпавших позиций.'));
  shell.println(c.grey('Пустая строка или «q» — отмена.'));
  shell.println('');
  lines.forEach((line, i) => {
    const addr = `0x${(0xf4a0 + i * 16).toString(16).toUpperCase()}`;
    const painted = line.replace(new RegExp(`(${words.join('|')})`, 'g'), (w) => c.bright(w));
    shell.println(`${c.grey(addr)}  ${painted}`);
  });
  shell.println('');

  let attempts = 4;
  while (attempts > 0) {
    const reply = await shell.ask(`${c.amber(`Попытки ${'▮'.repeat(attempts)}`)} > `, { visible: 10 + attempts });
    const guess = (reply ?? '').trim().toUpperCase();

    if (!guess || guess === 'Q' || guess === 'Й') {
      shell.println(c.grey('Взлом прерван.'));
      return;
    }

    if (!words.includes(guess)) {
      shell.println(c.red('Такого слова нет в дампе.'));
      continue;
    }

    if (guess === answer) {
      const stats = shell.user?.stats ?? {};
      shell.saveStats({ hacks: (stats.hacks ?? 0) + 1 });
      shell.println(c.green('ПАРОЛЬ ПРИНЯТ. ДОСТУП К ДАМПУ ОТКРЫТ.'));

      const closed = shell.closedKeywords();
      const fragment = Math.random() < 0.6 ? maskedFragment(closed) : null;
      shell.println(
        fragment
          ? `${c.amber('Перехвачен фрагмент ключевого слова:')} ${c.bright(fragment)}`
          : c.grey('В дампе нет ничего полезного. Но вы справились.')
      );
      return;
    }

    attempts -= 1;
    shell.println(`${c.red('Отказ.')} Совпадение: ${likeness(guess, answer)}/${answer.length}`);
  }

  shell.println(c.red('ТЕРМИНАЛ ЗАБЛОКИРОВАН. Попытки исчерпаны.'));
  shell.log({ action: 'hack-failed' });
}
