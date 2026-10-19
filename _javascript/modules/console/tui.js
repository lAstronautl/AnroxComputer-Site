/**
 * Drawing helpers for the full-screen console programs (market, casino, map):
 * money formatting, box drawing, sparklines and the alternate screen that gives the terminal back afterwards.
 */

import { ESC, c, visibleLength } from './ansi';

export const KEY = {
  up: `${ESC}[A`,
  down: `${ESC}[B`,
  right: `${ESC}[C`,
  left: `${ESC}[D`,
  shiftTab: `${ESC}[Z`
};

export const isBack = (key) => key === ESC || /^[qQйЙ]$/.test(key);
export const isEnter = (key) => key === '\r' || key === '\n';

export const at = (row, col) => `${ESC}[${row};${col}H`;
export const sgr = (code, text) => `${ESC}[${code}m${text}${ESC}[0m`;

/* ---------- money ---------- */

export const UNIT = 'КЕ'; // крипто-енды
export const fmt = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
export const money = (n) => `${fmt(n)} ${UNIT}`;
export const signed = (n) => (n > 0 ? `+${fmt(n)}` : n < 0 ? `−${fmt(Math.abs(n))}` : '0');
export const toneOf = (n) => (n > 0 ? c.green : n < 0 ? c.red : c.grey);
export const quote = (p) => p.toFixed(2);
export const percent = (p) => `${p >= 0 ? '+' : '−'}${Math.abs(p).toFixed(1)}%`;

/* ---------- text layout ---------- */

export function pad(text, width, align = 'left') {
  const gap = Math.max(0, width - visibleLength(text));
  if (align === 'right') return ' '.repeat(gap) + text;
  if (align === 'center') return ' '.repeat(Math.floor(gap / 2)) + text + ' '.repeat(gap - Math.floor(gap / 2));
  return text + ' '.repeat(gap);
}

export const center = (text, width) => pad(text, width, 'center').replace(/\s+$/, '');

export const clip = (text, width) => {
  const chars = [...String(text)];
  return chars.length > width ? `${chars.slice(0, Math.max(0, width - 1)).join('')}…` : text;
};

/** A box with a title in its top edge; `body` is an array of lines already padded by the caller. */
export function box(width, title, body, tone = c.red) {
  const inner = width - 2;
  const head = title ? ` ${title} ` : '';
  const fill = '═'.repeat(Math.max(0, width - 3 - visibleLength(head)));
  const lines = [`${tone('╔═')}${head ? c.bold(c.bright(head)) : ''}${tone(`${fill}╗`)}`];
  for (const line of body) lines.push(`${tone('║')}${pad(line, inner)}${tone('║')}`);
  lines.push(tone(`╚${'═'.repeat(inner)}╝`));
  return lines;
}

const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/** One-line trend of the values, coloured by their direction. */
export function spark(values, width) {
  if (!values.length) return ' '.repeat(width);
  const step = values.length / width;
  const cells = [];
  for (let i = 0; i < width; i += 1) {
    const from = Math.floor(i * step);
    const to = Math.max(from + 1, Math.floor((i + 1) * step));
    const slice = values.slice(from, to);
    cells.push(slice.reduce((sum, v) => sum + v, 0) / slice.length);
  }
  const low = Math.min(...cells);
  const high = Math.max(...cells);
  const range = high - low || 1;
  const rising = cells[cells.length - 1] >= cells[0];
  const text = cells.map((v) => BLOCKS[Math.min(7, Math.round(((v - low) / range) * 7))]).join('');
  return (rising ? c.green : c.red)(text);
}

/**
 * A filled bar chart of the values, `height` rows tall. Returns `height` strings of `width` columns;
 * the last column is highlighted and every column is coloured by whether it rose compared to the one before.
 */
export function barChart(values, width, height, { min, max, tone } = {}) {
  const data = values.slice(-width);
  const real = data.filter((v) => v != null);
  const low = min ?? Math.min(...real);
  const high = max ?? Math.max(...real);
  const range = high - low || 1;
  const levels = data.map((v) => (v == null ? 0 : Math.max(1, Math.round(((v - low) / range) * (height * 8 - 1)) + 1)));
  const last = data.reduce((found, v, i) => (v == null ? found : i), -1);
  const rows = [];
  for (let row = 0; row < height; row += 1) {
    const floor = (height - 1 - row) * 8; // levels below this row
    let line = '';
    data.forEach((v, i) => {
      const filled = levels[i] - floor;
      const glyph = filled >= 8 ? '█' : filled > 0 ? BLOCKS[filled - 1] : ' ';
      const rose = i === 0 || data[i - 1] == null ? true : v >= data[i - 1];
      const color = i === last ? '1;93' : tone ?? (rose ? '32' : '31');
      line += glyph === ' ' ? ' ' : sgr(color, glyph);
    });
    rows.push(line + ' '.repeat(Math.max(0, width - data.length)));
  }
  return rows;
}

// five-row block digits for big numbers (multipliers, dice rolls) and the lobby banner
const FONT = {
  0: ['███', '█ █', '█ █', '█ █', '███'],
  1: [' █ ', '██ ', ' █ ', ' █ ', '███'],
  2: ['███', '  █', '███', '█  ', '███'],
  3: ['███', '  █', '███', '  █', '███'],
  4: ['█ █', '█ █', '███', '  █', '  █'],
  5: ['███', '█  ', '███', '  █', '███'],
  6: ['███', '█  ', '███', '█ █', '███'],
  7: ['███', '  █', '  █', '  █', '  █'],
  8: ['███', '█ █', '███', '█ █', '███'],
  9: ['███', '█ █', '███', '  █', '███'],
  '.': [' ', ' ', ' ', ' ', '█'],
  '×': ['   ', '█ █', ' █ ', '█ █', '   '],
  '·': ['   ', '   ', ' █ ', '   ', '   '],
  ' ': ['  ', '  ', '  ', '  ', '  '],
  C: [' ███', '█   ', '█   ', '█   ', ' ███'],
  A: [' ██ ', '█  █', '████', '█  █', '█  █'],
  S: [' ███', '█   ', ' ██ ', '   █', '███ '],
  I: ['███', ' █ ', ' █ ', ' █ ', '███'],
  N: ['█  █', '██ █', '█ ██', '█  █', '█  █'],
  O: [' ██ ', '█  █', '█  █', '█  █', ' ██ ']
};

export function bigText(text, tone = c.bright) {
  const rows = ['', '', '', '', ''];
  for (const ch of String(text)) {
    const glyph = FONT[ch] ?? FONT[' '];
    glyph.forEach((part, i) => {
      rows[i] += `${part} `;
    });
  }
  return rows.map((row) => tone(row));
}

/* ---------- screen ---------- */

const ERRORS = {
  network: 'Сервер недоступен. Попробуйте позже.',
  offline: 'Биржа и казино работают только с подключённым сервером консоли.',
  funds: 'Недостаточно крипто-енд.',
  'bad-bet': 'Недопустимая ставка.',
  'bad-trade': 'Недопустимая сделка.',
  'no-assets': 'У вас нет столько бумаг.',
  'no-dole': 'Пособие выдают тем, у кого меньше 100 КЕ.',
  'no-round': 'Забирать нечего: ставки нет или раунд уже завершён.',
  closed: 'Приём ставок закрыт — дождитесь следующего раунда.',
  placed: 'Ставка в этом раунде уже сделана.',
  running: 'Раунд уже идёт — дождитесь его конца.',
  'in-lobby': 'Вы уже сидите в лобби: сначала выйдите из него.',
  full: 'В лобби нет мест.',
  'no-lobby': 'Такого лобби нет или оно уже закрыто.',
  'few-players': 'Для старта нужно минимум два игрока.',
  started: 'Игра уже началась.',
  'not-your-turn': 'Сейчас не ваш ход.',
  'bad-cards': 'Выберите от 1 до 3 карт.',
  'nothing-to-call': 'Назвать лжецом некого: вы ходите первым в раунде.',
  over: 'Игра уже закончена.',
  self: 'Нельзя отправить самому себе.',
  'not-found': 'Такого сотрудника нет в базе.',
  'bad-amount': 'Сумма — целое число от 1 до 1 000 000 КЕ.',
  busy: 'Сервер занят, повторите.',
  forbidden: 'ДОСТУП ЗАПРЕЩЁН. Рынок правят только с высшим допуском.',
  'no-asset': 'Такой компании нет на бирже (тикер — как в таблице).',
  'bad-value': 'Недопустимое значение.',
  taken: 'Такой тикер уже занят.',
  unauthorized: 'Сеанс истёк. Войдите снова: login.',
  server: 'Сбой сервера. Попробуйте позже.'
};

export const errorText = (code) => ERRORS[code] ?? ERRORS.server;

/**
 * Takes over the terminal: alternate screen, hidden cursor, one key handler.
 * `paint(lines)` overwrites the screen line by line without clearing it (no flicker while animating).
 */
export function openScreen(shell, onKey) {
  const cols = shell.term.cols ?? 80;
  const rows = shell.term.rows ?? 24;
  shell.screen?.classList.add('map-mode');
  shell.raw(`${ESC}[?1049h${ESC}[?25l${ESC}[2J`);
  shell.setKeyHandler(onKey);

  let open = true;
  return {
    cols,
    rows,
    paint(lines) {
      if (!open) return;
      let out = '';
      lines.slice(0, rows).forEach((line, index) => {
        out += `${at(index + 1, 1)}${line}${ESC}[K`;
      });
      if (lines.length < rows) out += `${at(lines.length + 1, 1)}${ESC}[J`;
      shell.raw(out);
    },
    close() {
      if (!open) return;
      open = false;
      shell.setKeyHandler(null);
      shell.screen?.classList.remove('map-mode');
      shell.raw(`${ESC}[?25h${ESC}[?1049l`);
    }
  };
}

export const tooSmall = (shell, minCols = 36, minRows = 18) => (shell.term.cols ?? 80) < minCols || (shell.term.rows ?? 24) < minRows;
