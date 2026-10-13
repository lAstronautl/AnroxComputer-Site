/**
 * Casino: a lobby and four games (slots, roulette, dice, crash) on the same крипто-енды balance as the exchange.
 * Every outcome is rolled by the server (worker/src/economy.js); this file draws the machines and animates the result.
 */

import { c, visibleLength } from './ansi';
import { KEY, UNIT, bigText, barChart, box, center, errorText, isBack, isEnter, money, openScreen, pad, signed, sgr, tooSmall } from './tui';

const BETS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
const CRASH_RATE = 0.09; // same growth as the server's (worker/src/economy.js)

const SLOT_STYLE = { 7: '1;91', '◆': '1;96', '★': '1;93', Ω: '1;95', '♥': '31', '♣': '32', '¤': '90' };
const SLOT_ORDER = ['7', '◆', '★', 'Ω', '♥', '♣', '¤'];
const SLOT_PAYS = { 7: 100, '◆': 40, '★': 20, Ω: 12, '♥': 7, '♣': 5, '¤': 3 };

const WHEEL = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
const REDS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const colorOf = (n) => (n === 0 ? 'green' : REDS.has(n) ? 'red' : 'black');

const ROULETTE_BETS = [
  { type: 'red', label: 'Красное', pays: 2 },
  { type: 'black', label: 'Чёрное', pays: 2 },
  { type: 'even', label: 'Чётное', pays: 2 },
  { type: 'odd', label: 'Нечётное', pays: 2 },
  { type: 'low', label: '1–18', pays: 2 },
  { type: 'high', label: '19–36', pays: 2 },
  { type: 'dozen', label: 'Дюжина (1, 2 или 3)', pays: 3, input: 'dozen' },
  { type: 'number', label: 'Число (0–36)', pays: 36, input: 'number' }
];

const chip = (n) => {
  const text = ` ${String(n).padStart(2)} `;
  const color = colorOf(n);
  return color === 'red' ? sgr('41;97', text) : color === 'green' ? sgr('42;30', text) : sgr('100;97', text);
};

const boldAmber = (text) => c.bold(c.amber(text));

const randomOf = (list) => list[Math.floor(Math.random() * list.length)];

export function playCasino(shell) {
  return new Promise((resolve) => {
    if (tooSmall(shell, 40, 22)) {
      shell.println(c.red('Окно слишком маленькое для казино.') + c.grey(' Увеличьте его или сверните панели.'));
      resolve();
      return;
    }

    const ctx = {
      balance: null,
      betIndex: 3,
      scene: null,
      timers: new Set(),
      busy: false
    };
    const view = openScreen(shell, (key) => ctx.scene?.key(key));
    const { cols, rows } = view;

    /* ---------- shared pieces ---------- */

    const bet = () => BETS[ctx.betIndex];
    const repaint = () => view.paint(ctx.scene.draw());
    const later = (ms, fn) => {
      const id = setTimeout(() => {
        ctx.timers.delete(id);
        fn();
      }, ms);
      ctx.timers.add(id);
    };
    const every = (ms, fn) => {
      const id = setInterval(fn, ms);
      ctx.timers.add(id);
      return () => {
        clearInterval(id);
        ctx.timers.delete(id);
      };
    };
    const clearTimers = () => {
      ctx.timers.forEach((id) => {
        clearTimeout(id);
        clearInterval(id);
      });
      ctx.timers.clear();
    };
    const tick = () => shell.sound?.tick?.();

    async function api(path, body) {
      const result = await shell.backend.call('POST', `/api/casino/${path}`, body ?? {});
      if (typeof result.balance === 'number') ctx.balance = result.balance;
      return result;
    }

    function go(name) {
      clearTimers();
      ctx.busy = false;
      ctx.scene = SCENES[name]();
      repaint();
    }

    function finish() {
      clearTimers();
      view.close();
      resolve();
    }

    const header = (title) => {
      const left = ` ${c.bold(c.red('♠ ЕНД-КАЗИНО АнКо ♦'))}${title ? c.grey(`  ·  ${title}`) : ''}`;
      const right = ctx.balance == null ? '' : `${c.grey('баланс ')}${c.bold(c.amber(money(ctx.balance)))} `;
      return [`${left}${' '.repeat(Math.max(1, cols - visibleLength(left) - visibleLength(right)))}${right}`, c.red('━'.repeat(cols))];
    };

    const betLine = () => {
      const left = ctx.betIndex > 0 ? c.red('◄') : c.grey('◄');
      const right = ctx.betIndex < BETS.length - 1 ? c.red('►') : c.grey('►');
      return `${c.grey('Ставка')} ${left} ${c.bold(c.amber(money(bet())))} ${right}`;
    };

    const changeBet = (key) => {
      if (key === KEY.left) ctx.betIndex = Math.max(0, ctx.betIndex - 1);
      else if (key === KEY.right) ctx.betIndex = Math.min(BETS.length - 1, ctx.betIndex + 1);
      else return false;
      tick();
      return true;
    };

    const resultLine = (r) => {
      if (!r) return '';
      if (r.payout > r.bet) return c.bold(c.green(`▲ ВЫИГРЫШ ${signed(r.payout - r.bet)} ${UNIT}`)) + c.grey(`  (×${r.multiplier})`);
      if (r.payout === r.bet) return c.bold(c.amber('● ставка возвращена'));
      if (r.payout > 0) return c.amber(`▼ вернули ${money(r.payout)}`) + c.grey(`  (${signed(r.payout - r.bet)} ${UNIT})`);
      return c.red(`▼ проигрыш −${money(r.bet)}`);
    };

    const errorLine = (code) => c.red(errorText(code));

    const footer = (text) => [c.grey(' ' + text)];

    /* ---------- lobby ---------- */

    function lobby() {
      let selected = 0;
      let phase = 0;
      const GAMES = [
        { id: 'slots', title: 'СЛОТЫ', text: 'Три барабана. Пара — ×1.6, три семёрки — ×100.', tag: '♣ ★ 7' },
        { id: 'roulette', title: 'РУЛЕТКА', text: 'Европейская, один ноль. Цвет ×2, число ×36.', tag: '● ● 0' },
        { id: 'dice', title: 'КОСТИ', text: 'Меньше или больше — шанс и выплата на ваш выбор.', tag: '⚀ ⚃ ⚅' },
        { id: 'crash', title: 'ВЗЛЁТ', text: 'Множитель растёт — заберите выигрыш до обвала.', tag: '▁▃▅█' }
      ];
      const roomy = rows >= 34;
      const cardWidth = Math.min(cols - 4, 66);
      every(500, () => {
        phase += 1;
        repaint();
      });

      return {
        draw() {
          const lines = header('');
          lines.push('');
          if (roomy) {
            const art = bigText('CASINO', (text) => c.red(text));
            // a chasing light under the sign
            const bulbs = Array.from({ length: Math.min(cols - 8, 44) }, (_, i) => ((i + phase) % 3 === 0 ? c.bold(c.amber('●')) : c.grey('○'))).join(' ');
            art.forEach((row) => lines.push(center(row, cols)));
            lines.push('', center(bulbs, cols), center(c.grey('ЕНД-КАЗИНО АнКо · один баланс с биржей — крипто-енды'), cols), '');
          } else {
            lines.push(center(c.bold(c.red('ЕНД-КАЗИНО АнКо')) + c.grey(' · один баланс с биржей'), cols), '');
          }

          GAMES.forEach((game, index) => {
            const on = index === selected;
            const tone = on ? boldAmber : c.red;
            const title = `[${index + 1}] ${game.title}`;
            const body = [`  ${on ? game.text : c.grey(game.text)}`];
            const framed = box(cardWidth, on ? `${c.bold(c.amber('►'))} ${title}` : title, body, on ? tone : c.grey);
            if (roomy) framed.forEach((line) => lines.push(center(line, cols)));
            else lines.push(center(`${on ? c.bold(c.amber('►')) : ' '} ${on ? c.bold(c.bright(title)) : c.amber(title)}  ${on ? game.text : c.grey(game.text)}`, cols));
          });

          lines.push('', center(c.grey('Пособие: раз в 10 минут, если на счёте меньше 100 КЕ — команда dole'), cols));
          while (lines.length < rows - 1) lines.push('');
          lines.push(...footer('↑↓ выбор · 1–4 / Enter — играть · Esc — выйти из казино'));
          return lines;
        },
        key(key) {
          if (isBack(key)) finish();
          else if (key === KEY.up) selected = (selected + GAMES.length - 1) % GAMES.length;
          else if (key === KEY.down || key === '\t') selected = (selected + 1) % GAMES.length;
          else if (/^[1-4]$/.test(key)) {
            go(GAMES[Number(key) - 1].id);
            return;
          } else if (isEnter(key)) {
            go(GAMES[selected].id);
            return;
          } else return;
          tick();
          repaint();
        }
      };
    }

    /* ---------- slots ---------- */

    function slots() {
      const random3 = () => Array.from({ length: 5 }, () => randomOf(SLOT_ORDER));
      let reels = [random3(), random3(), random3()];
      let result = null;
      let error = '';
      let flash = false;
      let spinning = false;
      let phase = 0;

      const glyph = (symbol, row) => {
        if (row === 2) return sgr(SLOT_STYLE[symbol], symbol);
        return row === 1 || row === 3 ? c.grey(symbol) : sgr('2;90', symbol);
      };
      const inner = Math.min(cols - 6, 43);

      return {
        draw() {
          const lines = header('слоты');
          const frame = flash ? boldAmber : c.red;
          const bulbCount = Math.floor((inner - 2) / 2);
          const bulbs = Array.from({ length: bulbCount }, (_, i) => {
            const lit = spinning || flash ? (i + phase) % 2 === 0 : false;
            return lit ? c.bold(c.amber('●')) : c.grey('○');
          }).join(' ');
          const reelRow = (row) => reels.map((reel) => `${c.red('│')}   ${glyph(reel[row], row)}   ${c.red('│')}`).join(' ');
          const top = reels.map(() => c.red('┌───────┐')).join(' ');
          const bottom = reels.map(() => c.red('└───────┘')).join(' ');

          const body = ['', center(bulbs, inner), '', center(top, inner)];
          for (let row = 0; row < 5; row += 1) {
            const line = center(reelRow(row), inner - 4);
            body.push(row === 2 ? `${c.bold(c.red('▶'))}  ${line}  ${c.bold(c.red('◀'))}`.replace(/\s+$/, '') : `   ${line}   `);
          }
          body.push(center(bottom, inner), '', center(bulbs, inner), '');

          lines.push('');
          for (const line of box(inner + 2, '◆ СЛОТЫ АНКО ◆', body, frame)) lines.push(center(line, cols));
          lines.push('', center(betLine(), cols), center(error ? errorLine(error) : resultLine(result) || c.grey('Нажмите Enter, чтобы крутить'), cols), '');

          const table = SLOT_ORDER.map((symbol) => `${sgr(SLOT_STYLE[symbol], symbol)}${c.grey(`×${SLOT_PAYS[symbol]}`)}`).join('  ');
          lines.push(center(`${c.grey('три в ряд:')}  ${table}`, cols), center(c.grey('любая пара — ×1.6'), cols));
          while (lines.length < rows - 1) lines.push('');
          lines.push(...footer('←→ ставка · Enter / пробел — крутить · Esc — в лобби'));
          return lines;
        },
        key(key) {
          if (ctx.busy) return;
          if (isBack(key)) go('lobby');
          else if (changeBet(key)) repaint();
          else if (isEnter(key) || key === ' ') void spin();
        }
      };

      async function spin() {
        ctx.busy = true;
        error = '';
        result = null;
        const outcome = await api('slots', { bet: bet() });
        if (outcome.error) {
          error = outcome.error;
          ctx.busy = false;
          repaint();
          return;
        }

        spinning = true;
        const stops = [800, 1300, 1800];
        const started = Date.now();
        const stopSpinning = every(70, () => {
          const elapsed = Date.now() - started;
          phase += 1;
          reels = reels.map((reel, i) => {
            if (elapsed < stops[i]) return random3();
            const done = random3();
            done[2] = outcome.reels[i];
            return done;
          });
          if (phase % 2 === 0) tick();
          if (elapsed >= stops[2] + 40) {
            stopSpinning();
            spinning = false;
            result = outcome;
            ctx.busy = false;
            if (outcome.payout > outcome.bet) blink(0);
          }
          repaint();
        });
      }

      function blink(n) {
        flash = n % 2 === 0;
        phase += 1;
        repaint();
        if (n < 9) later(150, () => blink(n + 1));
        else {
          flash = false;
          repaint();
        }
      }
    }

    /* ---------- roulette ---------- */

    function roulette() {
      let selected = 0;
      let value = '';
      let result = null;
      let error = '';
      let center0 = 0; // wheel index in the middle of the strip
      let history = [];
      const reach = Math.min(7, Math.floor((cols - 6) / 8));

      const strip = (position) => {
        const cells = [];
        for (let i = -reach; i <= reach; i += 1) cells.push(chip(WHEEL[(((position + i) % 37) + 37) % 37]));
        return cells.join(' ');
      };

      return {
        draw() {
          const lines = header('рулетка');
          const stripText = strip(center0);
          const width = visibleLength(stripText) + 4;
          const frame = [
            center(c.bold(c.amber('▼')), width - 2),
            center(stripText, width - 2),
            center(c.bold(c.amber('▲')), width - 2)
          ];
          lines.push('');
          for (const line of box(width, 'РУЛЕТКА · ЕВРОПЕЙСКАЯ', frame)) lines.push(center(line, cols));
          lines.push(
            center(
              result
                ? `${chip(result.number)}  ${c.bold(c.bright(String(result.number)))} ${{ red: c.red('красное'), black: c.grey('чёрное'), green: c.green('зеро') }[result.color]}`
                : c.grey('· · ·'),
              cols
            )
          );
          lines.push(center(error ? errorLine(error) : result ? resultLine(result) : c.grey('Выберите ставку и нажмите Enter'), cols), '');

          const swatch = { red: sgr('41', '  '), black: sgr('100', '  ') };
          ROULETTE_BETS.forEach((option, index) => {
            const on = index === selected;
            const extra = option.input ? ` ${c.inverse(` ${on ? value || '·' : '·'} `)}` : '';
            const label = (swatch[option.type] ?? '  ') + ' ' + (on ? c.bold(c.bright(option.label)) : option.label) + extra;
            lines.push(center(`${on ? c.bold(c.red('►')) : ' '} ${pad(label, 32)}${c.grey(`×${option.pays}`)}`, cols));
          });
          lines.push('', center(betLine(), cols));
          if (history.length) lines.push(center(c.grey('выпадало ') + history.map(chip).join(''), cols));
          while (lines.length < rows - 1) lines.push('');
          lines.push(...footer('↑↓ ставка · ←→ сумма · цифры — число/дюжина · Enter — крутить · Esc'));
          return lines;
        },
        key(key) {
          if (ctx.busy) return;
          const option = ROULETTE_BETS[selected];
          if (isBack(key)) go('lobby');
          else if (key === KEY.up) selected = (selected + ROULETTE_BETS.length - 1) % ROULETTE_BETS.length;
          else if (key === KEY.down || key === '\t') selected = (selected + 1) % ROULETTE_BETS.length;
          else if (changeBet(key)) {
            // bet amount changed
          } else if (option.input && /^[0-9]$/.test(key)) value = (value + key).slice(-2);
          else if (option.input && (key === '\x7f' || key === '\b')) value = value.slice(0, -1);
          else if (isEnter(key) || key === ' ') {
            void spin();
            return;
          } else return;
          repaint();
        }
      };

      async function spin() {
        const option = ROULETTE_BETS[selected];
        const chosen = Number(value);
        if (option.input === 'dozen' && !(chosen >= 1 && chosen <= 3)) {
          error = 'bad-bet';
          repaint();
          return;
        }
        if (option.input === 'number' && (value === '' || chosen > 36)) {
          error = 'bad-bet';
          repaint();
          return;
        }

        ctx.busy = true;
        error = '';
        result = null;
        const outcome = await api('roulette', { bet: bet(), type: option.type, value: option.input ? chosen : 0 });
        if (outcome.error) {
          error = outcome.error;
          ctx.busy = false;
          repaint();
          return;
        }

        const target = WHEEL.indexOf(outcome.number);
        const distance = ((target - center0 + 37) % 37) + 37 * 3;
        const from = center0;
        const started = Date.now();
        const duration = 4200;
        let shown = from;
        const stopSpinning = every(45, () => {
          const t = Math.min(1, (Date.now() - started) / duration);
          const position = from + Math.round(distance * (1 - (1 - t) ** 3));
          if (position !== shown) {
            shown = position;
            tick();
          }
          center0 = position % 37;
          if (t >= 1) {
            stopSpinning();
            result = outcome;
            history = [outcome.number, ...history].slice(0, 12);
            ctx.busy = false;
          }
          repaint();
        });
      }
    }

    /* ---------- dice ---------- */

    function dice() {
      let mode = 'under';
      let target = 50;
      let result = null;
      let error = '';
      let shown = null; // the number that flickers while rolling

      const chance = () => (mode === 'under' ? target - 1 : 100 - target);
      const multiplier = () => Math.floor((0.98 / (chance() / 100)) * 100) / 100;
      const barWidth = Math.min(64, cols - 8);

      return {
        draw() {
          const lines = header('кости');
          lines.push('');
          const big = bigText(shown ?? (result ? result.roll : '··'), result ? (result.payout > 0 ? c.green : c.red) : c.bright);
          lines.push(center(c.grey('бросок кубика 1–100'), cols));
          big.forEach((row) => lines.push(center(row, cols)));
          lines.push('');

          // the bar 1..100: green where the bet wins
          let barText = '';
          const marker = Math.round(((target - 0.5) / 100) * barWidth);
          for (let x = 0; x < barWidth; x += 1) {
            const v = 1 + Math.floor((x * 100) / barWidth);
            const win = mode === 'under' ? v < target : v > target;
            barText += x === marker ? c.bold(c.amber('┃')) : win ? c.green('█') : c.red('░');
          }
          lines.push(center(barText, cols));
          const pointer = result ? Math.round(((result.roll - 0.5) / 100) * barWidth) : -1;
          const pointerRow = pointer >= 0 ? ' '.repeat(pointer) + (result.payout > 0 ? c.green('▲') : c.red('▲')) : '';
          lines.push(center(pad(pointerRow, barWidth), cols));
          const scale = [1, 25, 50, 75, 100].map((n) => n);
          let ruler = '';
          scale.forEach((n) => {
            const at = Math.round(((n - 0.5) / 100) * barWidth);
            const label = String(n);
            ruler += ' '.repeat(Math.max(0, at - [...ruler].length - Math.floor(label.length / 2))) + label;
          });
          lines.push(center(c.grey(ruler), cols));
          lines.push('');
          const side = mode === 'under' ? `меньше ${c.bold(c.amber(String(target)))}` : `больше ${c.bold(c.amber(String(target)))}`;
          lines.push(center(`${c.grey('Выпадет')} ${side}   ${c.grey('шанс')} ${c.bold(c.bright(chance() + '%'))}   ${c.grey('выплата')} ${c.bold(c.bright('×' + multiplier().toFixed(2)))}`, cols));
          lines.push(center(`${betLine()}   ${c.grey('выиграете')} ${c.green(money(Math.floor(bet() * multiplier())))}`, cols));
          lines.push('', center(error ? errorLine(error) : result ? resultLine({ ...result, multiplier: result.multiplier }) : c.grey('Enter — бросить кости'), cols));
          while (lines.length < rows - 1) lines.push('');
          lines.push(...footer('←→ порог · ↑↓ ставка · Tab — меньше/больше · Enter — бросок · Esc'));
          return lines;
        },
        key(key) {
          if (ctx.busy) return;
          if (isBack(key)) go('lobby');
          else if (key === KEY.left) target = Math.max(3, target - 1);
          else if (key === KEY.right) target = Math.min(98, target + 1);
          else if (key === KEY.up) ctx.betIndex = Math.min(BETS.length - 1, ctx.betIndex + 1);
          else if (key === KEY.down) ctx.betIndex = Math.max(0, ctx.betIndex - 1);
          else if (key === '\t' || /^[mMьЬ]$/.test(key)) mode = mode === 'under' ? 'over' : 'under';
          else if (isEnter(key) || key === ' ') {
            void roll();
            return;
          } else return;
          tick();
          repaint();
        }
      };

      async function roll() {
        ctx.busy = true;
        error = '';
        result = null;
        const outcome = await api('dice', { bet: bet(), mode, target });
        if (outcome.error) {
          error = outcome.error;
          ctx.busy = false;
          repaint();
          return;
        }
        const started = Date.now();
        const stopRolling = every(60, () => {
          shown = 1 + Math.floor(Math.random() * 100);
          tick();
          if (Date.now() - started > 1100) {
            stopRolling();
            shown = null;
            result = outcome;
            ctx.busy = false;
          }
          repaint();
        });
      }
    }

    /* ---------- crash ("Взлёт") ---------- */

    function crash() {
      let phase = 'idle'; // idle | flying | over
      let startedAt = 0;
      let outcome = null; // { won, multiplier, payout } or { crashed, at }
      let error = '';
      let last = 1;
      const multiplierAt = (ms) => Math.floor(Math.exp((CRASH_RATE * ms) / 1000) * 100) / 100;
      const axis = 7;
      const chartWidth = cols - axis - 4;
      const chartHeight = Math.max(5, rows - 19);

      return {
        draw() {
          const lines = header('взлёт');
          const now = phase === 'flying' ? multiplierAt(Date.now() - startedAt) : phase === 'over' ? (outcome.crashed ? outcome.at : outcome.multiplier) : 1;
          last = now;
          const tone = outcome?.crashed ? c.red : outcome?.won ? c.green : now >= 5 ? c.red : now >= 2 ? c.amber : c.green;
          const big = bigText(`×${now.toFixed(2)}`, tone);
          lines.push('');
          big.forEach((row) => lines.push(center(row, cols)));

          // curve: the multiplier at every time slice, drawn up to "now"
          const elapsed = phase === 'flying' ? Date.now() - startedAt : Math.log(Math.max(1.0001, now)) / CRASH_RATE * 1000;
          const span = Math.max(12000, elapsed * 1.15);
          const peak = Math.max(2, now * 1.25);
          const samples = [];
          for (let i = 0; i < chartWidth; i += 1) {
            const t = (i / chartWidth) * span;
            samples.push(t <= elapsed ? multiplierAt(t) : null);
          }
          const toneCode = outcome?.crashed ? '31' : outcome?.won ? '32' : now >= 5 ? '31' : now >= 2 ? '33' : '32';
          const chart = barChart(samples, chartWidth, chartHeight, { min: 1, max: peak, tone: phase === 'idle' ? '90' : toneCode });
          chart.forEach((line, index) => {
            const label = index === 0 ? `×${peak.toFixed(1)}` : index === chart.length - 1 ? '×1.0' : '';
            lines.push(`${c.grey(pad(label, axis, 'right'))} ${c.red('│')}${line}`);
          });
          lines.push(`${' '.repeat(axis)} ${c.red('└' + '─'.repeat(chartWidth + 1))}`);

          if (phase === 'flying') {
            lines.push(center(`${c.grey('ставка')} ${money(bet())}   ${c.grey('заберёте')} ${c.bold(c.green(money(Math.floor(bet() * now))))}`, cols));
            lines.push(center(c.bold(c.amber('ENTER / ПРОБЕЛ — ЗАБРАТЬ')), cols));
          } else if (phase === 'over') {
            if (outcome.crashed) lines.push(center(c.bold(c.red(`✹ ВЗЛЁТ РУХНУЛ НА ×${outcome.at.toFixed(2)} — ставка ${money(bet())} потеряна`)), cols));
            else lines.push(center(c.bold(c.green(`▲ ЗАБРАЛИ ×${outcome.multiplier.toFixed(2)} → +${money(outcome.payout - outcome.bet)}`)) + c.grey(`  (рухнул бы на ×${outcome.crashAt.toFixed(2)})`), cols));
            lines.push(center(error ? errorLine(error) : c.grey('Enter — ещё раз'), cols));
          } else {
            lines.push(center(betLine(), cols));
            lines.push(center(error ? errorLine(error) : c.grey('Enter — старт'), cols));
          }
          while (lines.length < rows - 1) lines.push('');
          lines.push(...footer(phase === 'flying' ? 'Enter / пробел — забрать выигрыш' : '←→ ставка · Enter — старт · Esc — в лобби'));
          return lines;
        },
        key(key) {
          if (phase === 'flying') {
            if (isEnter(key) || key === ' ') void cashOut();
            return;
          }
          if (ctx.busy) return;
          if (isBack(key)) go('lobby');
          else if (changeBet(key)) repaint();
          else if (isEnter(key) || key === ' ') void start();
        }
      };

      async function start() {
        ctx.busy = true;
        error = '';
        const answer = await api('crash/start', { bet: bet() });
        if (answer.error) {
          error = answer.error;
          ctx.busy = false;
          repaint();
          return;
        }
        ctx.busy = false;
        phase = 'flying';
        outcome = null;
        startedAt = Date.now();
        let polling = false;
        const stopLoop = every(120, () => {
          if (phase !== 'flying') {
            stopLoop();
            return;
          }
          repaint();
        });
        // the server tells when the round has crashed; the picture runs on the local clock in between
        every(250, async () => {
          if (phase !== 'flying' || polling) return;
          polling = true;
          const status = await api('crash/status');
          polling = false;
          if (phase !== 'flying') return;
          if (status.crashed) {
            phase = 'over';
            outcome = { crashed: true, at: status.at, bet: status.bet };
            repaint();
          } else if (status.error === 'no-round') {
            phase = 'over';
            outcome = { crashed: true, at: last, bet: bet() };
            repaint();
          }
        });
      }

      async function cashOut() {
        const answer = await api('crash/cashout', { at: Math.floor(multiplierAt(Date.now() - startedAt) * 100) / 100 });
        if (phase !== 'flying') return;
        phase = 'over';
        if (answer.won) outcome = { won: true, multiplier: answer.multiplier, payout: answer.payout, bet: answer.bet, crashAt: answer.crashAt };
        else if (answer.crashed) outcome = { crashed: true, at: answer.at, bet: answer.bet };
        else {
          error = answer.error;
          outcome = { crashed: true, at: last, bet: bet() };
        }
        repaint();
      }
    }

    const SCENES = { lobby, slots, roulette, dice, crash };

    /* ---------- start ---------- */

    ctx.scene = { draw: () => [...header(''), '', c.grey('  Подключение к кассе…')], key: (key) => isBack(key) && finish() };
    repaint();
    shell.backend.call('GET', '/api/wallet').then((wallet) => {
      if (wallet.error) {
        finish();
        shell.println(c.red(errorText(wallet.error)));
        return;
      }
      ctx.balance = wallet.balance;
      go('lobby');
    });
  });
}

