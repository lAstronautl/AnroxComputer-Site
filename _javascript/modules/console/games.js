/**
 * Mini-games for the console. Both talk to the shell only through a small
 * interface: `raw()` / `println()` to draw, `ask()` for lines of input and
 * `setKeyHandler()` to grab single key presses while a game runs.
 */

import { ESC, c } from './ansi';

const KEY = {
  up: `${ESC}[A`,
  down: `${ESC}[B`,
  right: `${ESC}[C`,
  left: `${ESC}[D`
};

const DIRECTIONS = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 }
};

function directionFor(key) {
  if (key === KEY.up || /^[wцWЦ]$/.test(key)) return 'up';
  if (key === KEY.down || /^[sыЫS]$/.test(key)) return 'down';
  if (key === KEY.left || /^[aфФA]$/.test(key)) return 'left';
  if (key === KEY.right || /^[dвВD]$/.test(key)) return 'right';
  return null;
}

/* ------------------------------------------------------------------ */
/* Snake                                                               */
/* ------------------------------------------------------------------ */

const COLS = 24;
const ROWS = 14;
const TOP = 4; // first board row on screen (1-based)
const LEFT = 3;

export function playSnake(shell) {
  return new Promise((resolve) => {
    let snake;
    let dir;
    let queued;
    let food;
    let score;
    let alive;
    let timer = 0;
    let delay;
    let best = shell.user?.stats?.snake ?? 0;

    const at = (row, col) => `${ESC}[${row};${col}H`;
    const same = (a, b) => a.x === b.x && a.y === b.y;

    function placeFood() {
      do {
        food = { x: Math.floor(Math.random() * COLS), y: Math.floor(Math.random() * ROWS) };
      } while (snake.some((part) => same(part, food)));
    }

    function reset() {
      snake = [
        { x: 6, y: 7 },
        { x: 5, y: 7 },
        { x: 4, y: 7 }
      ];
      dir = 'right';
      queued = 'right';
      score = 0;
      alive = true;
      delay = 130;
      placeFood();
    }

    function draw(message = '') {
      let out = `${ESC}[2J${at(1, LEFT)}${c.bold(c.red('ЗМЕЙКА'))}  ${c.grey('стрелки / WASD — движение, Esc — выход')}`;
      out += at(2, LEFT) + c.amber(`Очки: ${score}`) + c.grey(`   рекорд: ${best}`);
      out += at(TOP - 1, LEFT) + c.red(`┌${'─'.repeat(COLS * 2)}┐`);

      for (let y = 0; y < ROWS; y += 1) {
        let line = '';
        for (let x = 0; x < COLS; x += 1) {
          const cell = { x, y };
          if (same(snake[0], cell)) line += alive ? c.bright('██') : c.amber('XX');
          else if (snake.some((part) => same(part, cell))) line += c.red('▓▓');
          else if (same(food, cell)) line += c.amber('◆ ');
          else line += c.grey('· ');
        }
        out += at(TOP + y, LEFT) + c.red('│') + line + c.red('│');
      }

      out += at(TOP + ROWS, LEFT) + c.red(`└${'─'.repeat(COLS * 2)}┘`);
      if (message) out += at(TOP + ROWS + 2, LEFT) + message;
      shell.raw(out);
    }

    function stopTimer() {
      clearInterval(timer);
      timer = 0;
    }

    function startTimer() {
      stopTimer();
      timer = setInterval(tick, delay);
    }

    function tick() {
      dir = queued;
      const step = DIRECTIONS[dir];
      const head = { x: snake[0].x + step.x, y: snake[0].y + step.y };
      const hitsWall = head.x < 0 || head.y < 0 || head.x >= COLS || head.y >= ROWS;
      const eats = same(head, food);
      const body = eats ? snake : snake.slice(0, -1);

      if (hitsWall || body.some((part) => same(part, head))) {
        alive = false;
        stopTimer();
        if (score > best) {
          best = score;
          shell.saveStats({ snake: best });
        }
        draw(`${c.red('СИГНАЛ ПОТЕРЯН.')} ${c.grey('Пробел — заново, Esc — выход')}`);
        return;
      }

      snake.unshift(head);
      if (eats) {
        score += 1;
        placeFood();
        if (score % 4 === 0 && delay > 65) {
          delay -= 10;
          startTimer();
        }
      } else {
        snake.pop();
      }
      draw();
    }

    function finish() {
      stopTimer();
      shell.setKeyHandler(null);
      shell.raw(`${ESC}[?25h${ESC}[?1049l`);
      resolve();
    }

    shell.setKeyHandler((key) => {
      if (key === ESC || /^[qQйЙ]$/.test(key)) {
        finish();
        return;
      }

      if (!alive) {
        if (key === ' ' || key === '\r') {
          reset();
          draw();
          startTimer();
        }
        return;
      }

      const next = directionFor(key);
      if (!next) return;
      const opposite = { up: 'down', down: 'up', left: 'right', right: 'left' };
      if (next !== opposite[dir]) queued = next;
    });

    shell.raw(`${ESC}[?1049h${ESC}[?25l`);
    reset();
    draw();
    startTimer();
  });
}

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
