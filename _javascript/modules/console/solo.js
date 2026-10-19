/**
 * «Змейка: соло» — the classic snake, played right in the console (no server on the way, so no lag).
 * When the run ends the console asks the Worker to pay for the apples: 2 КЕ each, at most 50 КЕ per run.
 */

import { c } from './ansi';
import { box, center, errorText, isBack, isEnter, money } from './tui';

const COLS = 24;
const ROWS = 14;
const DIRS = { U: [0, -1], D: [0, 1], L: [-1, 0], R: [1, 0] };
const OPPOSITE = { U: 'D', D: 'U', L: 'R', R: 'L' };
const STEER = { w: 'U', a: 'L', s: 'D', d: 'R', ц: 'U', ф: 'L', ы: 'D', в: 'R', '\u001b[A': 'U', '\u001b[B': 'D', '\u001b[D': 'L', '\u001b[C': 'R' };

export function createSoloScene(env) {
  const { claim, repaint, every, header, footer, go, cols, rows, tick } = env;

  let phase = 'ready'; // ready | play | over
  let snake = [];
  let dir = 'R';
  let queued = 'R';
  let food = [0, 0];
  let score = 0;
  let delay = 130;
  let last = 0;
  let best = 0;
  let reward = null; // what the server paid for the run (null — still asking)
  let message = '';

  const same = (a, b) => a[0] === b[0] && a[1] === b[1];

  function placeFood() {
    do food = [Math.floor(Math.random() * COLS), Math.floor(Math.random() * ROWS)];
    while (snake.some((part) => same(part, food)));
  }

  function reset() {
    snake = [
      [6, 7],
      [5, 7],
      [4, 7]
    ];
    dir = 'R';
    queued = 'R';
    score = 0;
    delay = 130;
    reward = null;
    message = '';
    placeFood();
    phase = 'play';
    last = Date.now();
  }

  async function settle() {
    const answer = await claim(score);
    if (answer.error) message = errorText(answer.error);
    else reward = answer.reward;
    repaint();
  }

  function step() {
    dir = queued;
    const [dx, dy] = DIRS[dir];
    const head = [snake[0][0] + dx, snake[0][1] + dy];
    const eats = same(head, food);
    const body = eats ? snake : snake.slice(0, -1);
    if (head[0] < 0 || head[1] < 0 || head[0] >= COLS || head[1] >= ROWS || body.some((part) => same(part, head))) {
      phase = 'over';
      best = Math.max(best, score);
      if (score > 0) void settle();
      else reward = 0;
      return;
    }
    snake.unshift(head);
    if (eats) {
      score += 1;
      placeFood();
      if (score % 4 === 0 && delay > 65) delay -= 10;
    } else snake.pop();
  }

  function board() {
    const lines = [c.red(`┌${'─'.repeat(COLS * 2)}┐`)];
    for (let y = 0; y < ROWS; y += 1) {
      let line = '';
      for (let x = 0; x < COLS; x += 1) {
        const cell = [x, y];
        if (same(snake[0], cell)) line += phase === 'over' ? c.amber('XX') : c.bright('██');
        else if (snake.some((part) => same(part, cell))) line += c.red('▓▓');
        else if (same(food, cell)) line += c.amber('◆ ');
        else line += c.grey('· ');
      }
      lines.push(c.red('│') + line + c.red('│'));
    }
    lines.push(c.red(`└${'─'.repeat(COLS * 2)}┘`));
    return lines;
  }

  return {
    begin() {
      // the game steps by its own clock; the timer only checks whether a step is due
      every(20, () => {
        if (phase !== 'play') return;
        const now = Date.now();
        if (now - last >= delay) {
          last = now;
          step();
          repaint();
        }
      });
    },
    draw() {
      const lines = header('змейка соло');
      if (phase === 'ready') {
        lines.push('', center(c.bold(c.green('ЗМЕЙКА: СОЛО')) + c.grey('  ·  играйте бесплатно — каждое яблоко приносит КЕ'), cols), '');
        const body = ['', c.grey('  Бесплатно: ставки нет. Яблоко — 2 КЕ на ваш баланс,'), c.grey('  забег приносит не больше 50 КЕ, не чаще 1 КЕ в секунду.'), c.grey('  Управление: WASD или стрелки.'), ''];
        for (const line of box(Math.min(cols - 4, 62), 'НОВЫЙ ЗАБЕГ', body, c.green)) lines.push(center(line, cols));
        lines.push('', center(c.bold(c.amber('Enter — начать')), cols));
      } else {
        lines.push(` ${c.amber(`Очки: ${score}`)}${c.grey(`   рекорд: ${best}`)}   ${c.grey('заработаете')} ${c.green(money(Math.min(50, score * 2)))}`);
        for (const row of board()) lines.push(` ${row}`);
        if (phase === 'over') {
          lines.push('', ` ${c.red('СИГНАЛ ПОТЕРЯН.')} ${message ? c.red(message) : reward === null ? c.grey('начисляем награду…') : reward > 0 ? c.bold(c.green(`На баланс зачислено ${money(reward)}`)) : c.grey('Награды нет (яблок не было или выплата слишком частая)')}`);
        }
      }
      while (lines.length < rows - 1) lines.push('');
      lines.push(...footer(phase === 'play' ? 'WASD / стрелки — движение · Esc — выйти' : phase === 'over' ? 'Пробел / Enter — заново · Esc — в лобби казино' : 'Enter — играть · Esc — в лобби казино'));
      return lines;
    },
    key(key) {
      tick();
      if (isBack(key)) {
        if (phase === 'play') {
          phase = 'over';
          best = Math.max(best, score);
          if (score > 0) void settle();
          repaint();
        } else go('lobby');
        return;
      }
      if (phase !== 'play') {
        if (isEnter(key) || key === ' ') {
          reset();
          repaint();
        }
        return;
      }
      const next = STEER[key] ?? STEER[key.toLowerCase?.()];
      if (next && next !== OPPOSITE[dir]) queued = next;
    }
  };
}
