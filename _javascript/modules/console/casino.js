/**
 * Casino: a lobby and four games (slots, roulette, dice, crash) on the same крипто-енды balance as the exchange.
 * Every outcome is rolled by the server (worker/src/economy.js); this file draws the machines and animates the result.
 */

import { c, visibleLength } from './ansi';
import { createLiarScene } from './liar';
import { createTankScene } from './tanks';
import { KEY, UNIT, at, bigText, clip, fmt, barChart, box, center, errorText, isBack, isEnter, money, openScreen, pad, signed, sgr, tooSmall } from './tui';

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
      ctx.scene.begin?.();
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
        { id: 'liar', title: 'ЛЖЕЦ', text: 'Колода лжеца: общие лобби, блеф, револьвер. Победитель берёт банк.', tag: '♠' },
        { id: 'tanks', title: 'ТАНЧИКИ', text: 'Battle City на 2–4 игроков: WASD — ехать, стрелки — стрелять. Банк — победителю.', tag: '▲ ■' },
        { id: 'crash', title: 'ВЗЛЁТ', text: 'Общий раунд: ставят все вместе, множитель растёт — успейте забрать.', tag: '▁▃▅█' }
      ];
      const roomy = rows >= 40;
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
          lines.push(...footer('↑↓ выбор · 1–6 / Enter — играть · Esc — выйти из казино'));
          return lines;
        },
        key(key) {
          if (isBack(key)) finish();
          else if (key === KEY.up) selected = (selected + GAMES.length - 1) % GAMES.length;
          else if (key === KEY.down || key === '\t') selected = (selected + 1) % GAMES.length;
          else if (/^[1-6]$/.test(key)) {
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

    /* ---------- crash ("Взлёт"): one round for everybody ---------- */

    function crash() {
      let state = null; // the latest answer of the server
      let offset = 0; // server clock minus ours
      let message = '';
      let busy = false;
      const multiplierAt = (ms) => Math.floor(Math.exp((CRASH_RATE * Math.max(0, ms)) / 1000) * 100) / 100;
      const serverNow = () => Date.now() + offset;
      const axis = 7;
      const panel = cols >= 100 ? 40 : 0;
      const chartWidth = cols - axis - 4 - (panel ? panel + 2 : 0);
      const chartHeight = Math.max(5, rows - (panel ? 20 : 27));

      const take = (answer) => {
        if (answer?.bets) {
          state = answer;
          offset = answer.now - Date.now();
        }
      };

      async function poll() {
        if (busy) return;
        const answer = await api('crash/state');
        if (answer.error) message = errorText(answer.error);
        else take(answer);
      }

      const mine = () => state?.bets.find((item) => item.me);
      const tone = (m) => (m >= 5 ? c.red : m >= 2 ? c.amber : c.green);

      function betsTable(limit) {
        const lines = [c.bold(c.red('СТАВКИ ИГРОКОВ')) + c.grey(`  ${state.bets.length}`), c.grey(pad('ИГРОК', 11) + pad('СТАВКА', 8, 'right') + '  ИТОГ')];
        const sorted = [...state.bets].sort((a, b) => b.bet - a.bet);
        for (const item of sorted.slice(0, limit)) {
          let result;
          if (item.cashed != null) result = c.green(`×${item.cashed.toFixed(2)} ${signed(item.payout - item.bet)}`);
          else if (state.phase === 'crashed') result = c.red(`✹ −${fmt(item.bet)}`);
          else result = c.amber('летит…');
          const name = item.me ? c.bold(c.bright(pad(clip(item.name, 10), 11))) : pad(clip(item.name, 10), 11);
          lines.push(`${name}${pad(fmt(item.bet), 8, 'right')}  ${result}`);
        }
        if (!sorted.length) lines.push(c.grey('пока никто не поставил'));
        const total = state.bets.reduce((sum, item) => sum + item.bet, 0);
        if (sorted.length > limit) lines.push(c.grey(`…и ещё ${sorted.length - limit}`));
        lines.push(c.grey(`на кону ${money(total)}`));
        return lines;
      }

      return {
        begin: () => start(),
        draw() {
          const lines = header('взлёт');
          if (!state) return [...lines, '', c.grey('  Подключение к раунду…')];

          const now = serverNow();
          const elapsed = now - state.start;
          const phase = state.phase;
          let shown = 1;
          if (phase === 'flying') shown = multiplierAt(elapsed);
          else if (phase === 'crashed') shown = state.at;
          const colour = phase === 'crashed' ? c.red : tone(shown);

          lines.push('');
          bigText(`×${shown.toFixed(2)}`, colour).forEach((row) => lines.push(center(row, cols - (panel ? panel + 2 : 0))));

          // status line under the big number
          let status;
          if (phase === 'idle') {
            status = `${c.bold(c.amber('РАУНД НЕ ЗАПУЩЕН'))}${c.grey('  ·  запустите — у всех будет минута на ставки')}`;
          } else if (phase === 'betting') {
            const left = Math.max(0, Math.ceil((state.betUntil - now) / 1000));
            const filled = Math.max(0, Math.min(20, Math.round((left / (state.window / 1000)) * 20)));
            const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
            status = `${c.bold(c.amber('ПРИЁМ СТАВОК'))} ${c.amber(bar)} ${c.bold(c.bright(`${left} с`))}`;
          } else if (phase === 'flying') {
            status = c.bold(c.green('▲ ВЗЛЁТ…')) + c.grey('  множитель растёт, пока не рухнет');
          } else {
            const next = Math.max(0, Math.ceil((state.start + Math.ceil((Math.log(state.at) / CRASH_RATE) * 1000) + 450 + 7000 - now) / 1000));
            status = `${c.bold(c.red(`✹ РУХНУЛ НА ×${state.at.toFixed(2)}`))}${c.grey(`  ·  новый раунд можно запустить через ${next} с`)}`;
          }
          lines.push(center(status, cols - (panel ? panel + 2 : 0)));
          if (state.peek != null) lines.push(center(c.amber(`⌖ вы видите обвал заранее: ×${state.peek.toFixed(2)}`) + c.grey('  (только уровень 999)'), cols - (panel ? panel + 2 : 0)));

          // chart: the curve up to now
          const flown = phase === 'flying' ? elapsed : phase === 'crashed' ? (Math.log(state.at) / CRASH_RATE) * 1000 : 0;
          const span = Math.max(12000, flown * 1.15);
          const peak = Math.max(2, shown * 1.25);
          const samples = [];
          for (let i = 0; i < chartWidth; i += 1) {
            const t = (i / chartWidth) * span;
            samples.push(t <= flown ? multiplierAt(t) : null);
          }
          const code = phase === 'betting' ? '90' : phase === 'crashed' ? '31' : shown >= 5 ? '31' : shown >= 2 ? '33' : '32';
          const chart = barChart(samples, chartWidth, chartHeight, { min: 1, max: peak, tone: code });
          const body = [];
          chart.forEach((line, index) => {
            const label = index === 0 ? `×${peak.toFixed(1)}` : index === chart.length - 1 ? '×1.0' : '';
            body.push(`${c.grey(pad(label, axis, 'right'))} ${c.red('│')}${line}`);
          });
          body.push(`${' '.repeat(axis)} ${c.red('└' + '─'.repeat(chartWidth + 1))}`);

          // recent crash points
          const chips = state.history.map((value) => (value >= 5 ? c.green : value >= 2 ? c.amber : c.red)(`×${value.toFixed(2)}`)).join(' ');
          body.push(` ${c.grey('прошлые:')} ${chips || c.grey('—')}`);

          // my bet and the controls
          const my = mine();
          let hint;
          if (phase === 'idle') hint = `${betLine()}  ${c.bold(c.amber('Enter — запустить раунд со ставкой'))}`;
          else if (phase === 'betting') hint = my ? c.green(`Ваша ставка принята: ${money(my.bet)}`) : `${betLine()}  ${c.grey('Enter — поставить')}`;
          else if (phase === 'flying') hint = my && my.cashed == null ? `${c.bold(c.amber('ENTER / ПРОБЕЛ — ЗАБРАТЬ'))} ${c.grey('≈')} ${c.bold(c.green(money(Math.floor(my.bet * shown))))}` : my ? c.green(`Вы забрали ×${my.cashed.toFixed(2)}`) : c.grey('Вы наблюдаете: ставки принимаются перед стартом');
          else hint = my ? (my.cashed != null ? c.bold(c.green(`Вы забрали ×${my.cashed.toFixed(2)} → ${signed(my.payout - my.bet)} ${UNIT}`)) : c.bold(c.red(`Ставка ${money(my.bet)} сгорела`))) : c.grey('Вы не участвовали');
          body.push(` ${message ? c.red(message) : hint}`);

          if (panel) {
            const side = betsTable(Math.max(3, body.length - 4));
            body.forEach((line, i) => {
              if (side[i] !== undefined) body[i] = `${line}${at(lines.length + i + 1, cols - panel)}${side[i]}`;
            });
            lines.push(...body);
          } else {
            lines.push(...body, ...betsTable(Math.max(2, rows - lines.length - body.length - 3)));
          }
          while (lines.length < rows - 1) lines.push('');
          lines.push(...footer(phase === 'flying' ? 'Enter / пробел — забрать выигрыш · Esc — в лобби' : '←→ ставка · Enter — поставить / запустить · Esc — в лобби'));
          return lines;
        },
        key(key) {
          if (isBack(key)) {
            go('lobby');
            return;
          }
          if (!state || busy) return;
          const my = mine();
          if ((state.phase === 'betting' || state.phase === 'idle') && changeBet(key)) {
            repaint();
          } else if (isEnter(key) || key === ' ') {
            if (state.phase === 'idle') void launch();
            else if (state.phase === 'betting' && !my) void place();
            else if (state.phase === 'flying' && my && my.cashed == null) void cashOut();
          }
        }
      };

      async function launch() {
        busy = true;
        message = '';
        const answer = await api('crash/launch', { bet: bet() });
        busy = false;
        if (answer.error) message = errorText(answer.error);
        else take(answer);
        repaint();
      }

      async function place() {
        busy = true;
        message = '';
        const answer = await api('crash/bet', { bet: bet() });
        busy = false;
        if (answer.error) message = errorText(answer.error);
        else take(answer);
        repaint();
      }

      async function cashOut() {
        busy = true;
        message = '';
        const shownNow = Math.floor(multiplierAt(serverNow() - state.start) * 100) / 100;
        const answer = await api('crash/cashout', { at: shownNow });
        busy = false;
        if (answer.error) message = errorText(answer.error);
        else take(answer);
        repaint();
      }

      function start() {
        void poll().then(repaint);
        every(350, async () => {
          await poll();
          repaint();
        });
        every(120, repaint);
      }
    }

    function liar() {
      return createLiarScene({ api, repaint, every, header, footer, go, cols, rows, tick });
    }

    function tanks() {
      return createTankScene({ api, repaint, every, header, footer, go, cols, rows, tick });
    }

    const SCENES = { lobby, slots, roulette, dice, crash, liar, tanks };

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

