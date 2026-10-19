/**
 * «Трон», «Змейка» (онлайн со ставками) и «Змейка: соло» (бесплатная, платит за яблоки) in the casino.
 * The game runs on the server (worker/src/arcade.js); this file only steers (WASD or arrows) and draws.
 */

import { c } from './ansi';
import { KEY, box, center, clip, errorText, fmt, isBack, isEnter, money, pad, sgr } from './tui';

const STAKES = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
const SEAT = ['92', '96', '93', '95'];
const STEER = { w: 'U', a: 'L', s: 'D', d: 'R', ц: 'U', ф: 'L', ы: 'D', в: 'R', [KEY.up]: 'U', [KEY.down]: 'D', [KEY.left]: 'L', [KEY.right]: 'R' };
const HEAD = { U: '▲▲', D: '▼▼', L: '◄◄', R: '►►' };

const TITLES = {
  tron: { name: 'ТРОН', tag: 'трон', blurb: 'световые мотоциклы: не врезайтесь в стены и чужие следы', rules: 'Мотоцикл едет сам и оставляет световую стену. Врезался — выбыл.' },
  snake: { name: 'ЗМЕЙКА', tag: 'змейка', blurb: 'змейки на общей арене: ешьте яблоки и растите', rules: 'Ешьте яблоки и растите. Врезался в стену или змейку — выбыл. Кто длиннее к концу — выиграл.' },
  solo: { name: 'ЗМЕЙКА: СОЛО', tag: 'змейка соло', blurb: 'играйте бесплатно — каждое яблоко приносит крипто-енды', rules: '' }
};

export function createArcadeScene(env, kind) {
  const { api, repaint, every, header, footer, go, cols, rows, tick } = env;
  const info = TITLES[kind];
  const solo = kind === 'solo';
  const side = cols >= 72;

  let lobbies = [];
  let maps = [
    { id: 'open', name: 'Пустошь' },
    { id: 'pillars', name: 'Колонны' },
    { id: 'cross', name: 'Крест' }
  ];
  let state = null;
  let mode = solo ? 'solo' : 'browse'; // browse | form | solo (the start screen)
  let picked = 0;
  let formStake = 3;
  let formMax = 4;
  let formMap = 0;
  let message = '';
  let confirmLeave = false;
  let busy = false;
  let flight = false;
  let pending = null;
  let phase = 0;

  const tone = (seat, text) => sgr(`1;${SEAT[seat] ?? '97'}`, text);

  async function refresh() {
    if (busy || flight) return;
    flight = true;
    const answer = await api(`${kind}/state`);
    flight = false;
    if (answer.error) {
      message = errorText(answer.error);
      return;
    }
    if (answer.busy) message = 'Вы уже сидите в лобби другой игры: сначала выйдите из него.';
    const before = state?.status;
    state = answer.lobby;
    if (!state && !solo) {
      const list = await api(`${kind}/list`);
      if (!list.error) {
        lobbies = list.lobbies;
        maps = list.maps;
      }
      picked = Math.min(picked, Math.max(0, lobbies.length - 1));
    }
    if (before && !state) mode = solo ? 'solo' : 'browse';
  }

  async function sendInput() {
    if (flight || !pending || state?.status !== 'playing') return;
    const body = pending;
    pending = null;
    flight = true;
    const answer = await api(`${kind}/input`, body);
    flight = false;
    if (!answer.error && answer.lobby) state = answer.lobby;
    repaint();
  }

  async function act(path, body) {
    busy = true;
    message = '';
    const answer = await api(`${kind}/${path}`, body);
    busy = false;
    if (answer.error) message = errorText(answer.error);
    else if ('lobby' in answer) state = answer.lobby;
    repaint();
    return answer;
  }

  /* ---------- the field ---------- */

  function field() {
    const cells = state.grid.map((row) => [...row].map((ch) => (ch === '#' ? sgr('90', '██') : '  ')));
    if (state.trail) {
      state.trail.forEach((row, y) =>
        [...row].forEach((ch, x) => {
          if (ch !== '.') cells[y][x] = sgr(SEAT[Number(ch)], '██');
        })
      );
    }
    if (state.snakes) {
      state.snakes.forEach((snake, seat) => snake.forEach(([x, y]) => (cells[y][x] = sgr(SEAT[seat], '▓▓'))));
      for (const [x, y] of state.food) cells[y][x] = sgr('1;91', '●') + ' ';
    }
    for (const player of state.players) {
      if (player.alive) cells[player.y][player.x] = phase % 2 === 0 || !player.me ? tone(player.seat, HEAD[player.dir]) : sgr('1;97', HEAD[player.dir]);
    }
    const frame = c.red('─'.repeat(state.w * 2));
    return [c.red('┌') + frame + c.red('┐'), ...cells.map((row) => c.red('│') + row.join('') + c.red('│')), c.red('└') + frame + c.red('┘')];
  }

  function scoreboard() {
    const lines = [];
    if (solo) {
      const me = state.players[0];
      lines.push(`${c.grey('яблок')} ${c.bold(c.bright(String(me.score)))}   ${c.grey('длина')} ${c.bold(c.bright(String(me.len)))}`);
      lines.push(`${c.grey('заработано')} ${c.bold(c.green(money(state.reward)))}`);
      lines.push(c.grey('2 КЕ за яблоко, не больше 50 КЕ за забег'));
      return lines;
    }
    for (const player of state.players) {
      const name = clip(player.name, 16);
      lines.push(`${tone(player.seat, '■')} ${player.alive ? name : c.grey(name)}${player.me ? c.grey(' (вы)') : ''}`);
      lines.push(`  ${player.alive ? c.green('едет') : c.red('✹ выбыл')}${kind === 'snake' ? `  ${c.grey('длина')} ${c.bold(c.bright(String(player.len)))}` : ''}`);
    }
    return lines;
  }

  function eventLine(event) {
    const name = (seat) => state.players[seat]?.name ?? '?';
    switch (event.type) {
      case 'go':
        return c.bold(c.green('ПОЕХАЛИ!'));
      case 'crash':
        return event.reason === 'left' ? c.grey(`${name(event.seat)} покинул(а) игру`) : c.red(`✹ ${name(event.seat)} разбился`);
      case 'over':
        return event.winners.length ? c.bold(c.green(`★ ${event.winners.map(name).join(', ')} — победа`)) : c.grey('игра окончена');
      default:
        return '';
    }
  }

  const feed = (count) => (state.log ?? []).map(eventLine).filter(Boolean).slice(-count);

  /* ---------- screens ---------- */

  function drawSolo() {
    const lines = header(info.tag);
    lines.push('', center(c.bold(c.green(info.name)) + c.grey(`  ·  ${info.blurb}`), cols), '');
    const body = [
      '',
      `  ${c.grey('Карта')}  ${c.red('Tab')} ${c.bold(c.bright(maps[formMap]?.name ?? '—'))}`,
      '',
      c.grey('  Бесплатно: ставки нет. Каждое яблоко — 2 КЕ на ваш баланс,'),
      c.grey('  забег приносит не больше 50 КЕ. Врезались — деньги уже ваши.'),
      c.grey('  Забег длится не дольше пяти минут. Управление: WASD или стрелки.'),
      ''
    ];
    for (const line of box(Math.min(cols - 4, 66), 'НОВЫЙ ЗАБЕГ', body, c.green)) lines.push(center(line, cols));
    lines.push('', center(message ? c.red(message) : c.bold(c.amber('Enter — начать')), cols));
    while (lines.length < rows - 1) lines.push('');
    lines.push(...footer('Enter — играть · Tab — карта · Esc — в лобби казино'));
    return lines;
  }

  function drawBrowse() {
    const lines = header(info.tag);
    lines.push('', center(c.bold(c.red(info.name)) + c.grey(`  ·  ${info.blurb}`), cols), '');
    if (mode === 'form') {
      const stake = STAKES[formStake];
      const body = [
        '',
        `  ${c.grey('Ставка с каждого')}   ${c.red('◄')} ${c.bold(c.amber(money(stake)))} ${c.red('►')}`,
        `  ${c.grey('Игроков')}            ${c.red('▲')} ${c.bold(c.bright(String(formMax)))} ${c.red('▼')}`,
        `  ${c.grey('Карта')}              ${c.red('Tab')} ${c.bold(c.bright(maps[formMap]?.name ?? '—'))}`,
        '',
        `  ${c.grey('Банк при полном зале')}  ${c.bold(c.green(money(stake * formMax)))}`,
        c.grey(`  ${info.rules}`),
        c.grey('  Победитель берёт банк, ставки выбывших сгорают.'),
        ''
      ];
      for (const line of box(Math.min(cols - 4, 70), 'НОВАЯ ИГРА', body)) lines.push(center(line, cols));
      lines.push('', center(message ? c.red(message) : c.grey('←→ ставка · ↑↓ игроков · Tab карта · Enter — создать · Esc — отмена'), cols));
    } else {
      lines.push(` ${c.red('── ОТКРЫТЫЕ ЛОББИ')} ${c.grey('─'.repeat(Math.max(2, cols - 22)))}`);
      if (!lobbies.length) lines.push('', center(c.grey('Пока нет ни одного лобби — создайте своё: N'), cols));
      lobbies.slice(0, Math.max(3, rows - 14)).forEach((lobby, index) => {
        const on = index === picked;
        const names = clip(lobby.players.join(', '), Math.max(8, cols - 62));
        lines.push(` ${on ? c.bold(c.red('►')) : ' '} ${on ? c.bold(c.bright(`#${lobby.id}`)) : c.amber(`#${lobby.id}`)}  ${pad(clip(lobby.owner, 12), 13)} ${c.grey('ставка')} ${pad(c.amber(money(lobby.stake)), 12)} ${pad(c.grey(lobby.mapName), 10)} ${c.grey('мест')} ${lobby.players.length}/${lobby.max}  ${c.grey(names)}`);
      });
      lines.push('', center(message ? c.red(message) : c.grey('Enter — войти (ставка спишется сразу) · N — создать · R — обновить'), cols));
    }
    while (lines.length < rows - 1) lines.push('');
    lines.push(...footer(mode === 'form' ? '←→ ставка · ↑↓ игроков · Tab карта · Enter — создать · Esc — отмена' : '↑↓ выбор · Enter — войти · N — создать · Esc — в лобби казино'));
    return lines;
  }

  function drawRoom() {
    const lines = header(`${info.tag} · лобби #${state.id}`);
    lines.push('');
    const body = ['', `  ${c.grey('Ставка с каждого')} ${c.bold(c.amber(money(state.stake)))}   ${c.grey('банк')} ${c.bold(c.green(money(state.stake * state.players.length)))} ${c.grey(`(при ${state.max} игроках ${fmt(state.stake * state.max)})`)}`, `  ${c.grey('Карта')} ${c.bold(c.bright(state.mapName))}`, ''];
    Array.from({ length: state.max }, (_, i) => state.players[i]).forEach((player, index) => {
      body.push(player ? `  ${tone(index, '■')} ${player.me ? c.bold(c.bright(player.name)) : player.name}${player.name === state.owner ? c.grey('  · создатель') : ''}` : c.grey('  □ ждём игрока…'));
    });
    body.push('');
    for (const line of box(Math.min(cols - 4, 66), 'ЗАЛ ОЖИДАНИЯ', body)) lines.push(center(line, cols));
    lines.push('', center(state.mine ? (state.players.length >= 2 ? c.bold(c.amber('S — начать игру')) : c.grey('Для старта нужно минимум два игрока')) : c.grey(`Ждём, пока ${state.owner} начнёт игру`), cols));
    lines.push(center(c.grey('Управление: W A S D или стрелки. Выйдете до старта — ставка вернётся.'), cols));
    if (message) lines.push(center(c.red(message), cols));
    while (lines.length < rows - 1) lines.push('');
    lines.push(...footer(state.mine ? 'S — начать · Esc — выйти из лобби' : 'Esc — выйти из лобби'));
    return lines;
  }

  function drawGame() {
    const lines = header(`${info.tag} · ${state.mapName}`);
    const seconds = Math.ceil((state.timeLeft * state.tickMs) / 1000);
    const status = state.over ? '' : state.countdown > 0 ? c.bold(c.amber(`СТАРТ ЧЕРЕЗ ${Math.ceil((state.countdown * state.tickMs) / 1000)} с — выберите направление`)) : `${c.grey('до конца')} ${seconds < 30 ? c.red(`${seconds} с`) : c.grey(`${seconds} с`)}`;
    lines.push(` ${solo ? '' : `${c.grey('банк')} ${c.bold(c.green(money(state.pot)))}   `}${status}`);

    const board = field();
    const panel = scoreboard();
    if (side) {
      const log = solo ? [] : feed(Math.max(2, board.length - panel.length - 2));
      const right = [...panel, '', ...(log.length ? [c.grey('── журнал')] : []), ...log.map((line) => ` ${line}`)];
      board.forEach((row, i) => lines.push(` ${row}  ${right[i] ?? ''}`));
    } else {
      board.forEach((row) => lines.push(` ${row}`));
      lines.push(...panel.map((line) => ` ${line}`));
    }

    if (state.over) {
      lines.push('');
      if (solo) {
        lines.push(center(c.bold(c.amber('ЗАБЕГ ОКОНЧЕН')) + c.grey(`  яблок: ${state.players[0].score}`), cols));
        lines.push(center(state.reward ? c.bold(c.green(`На баланс зачислено ${money(state.reward)}`)) : c.grey('Ни одного яблока — ничего не заработано'), cols));
      } else {
        const winners = state.winners.map((seat) => state.players[seat]);
        const won = winners.some((player) => player.me);
        lines.push(center(winners.length ? c.bold(c.green(`★ ПОБЕДА: ${winners.map((player) => player.name).join(', ')} ★`)) : c.grey('Никто не выжил'), cols));
        lines.push(center(won ? c.bold(c.green(`Банк разделён: вам зачислено ${money(Math.floor(state.pot / winners.length))}`)) : c.red(`Ваша ставка ${money(state.stake)} сгорела`), cols));
      }
    } else if (!side && !solo) {
      for (const line of feed(2)) lines.push(` ${c.grey('·')} ${line}`);
    }
    while (lines.length < rows - 2) lines.push('');
    lines.push(message ? ` ${c.red(message)}` : confirmLeave ? ` ${c.bold(c.red(solo ? 'Закончить забег? Заработанное останется у вас.' : 'Выйти из игры? Ваша ставка сгорит.'))} ${c.amber('Y — выйти, любая другая клавиша — остаться')}` : '');
    lines.push(...footer(state.over ? 'Enter / Esc — назад' : `W A S D / стрелки — поворот · Esc — выйти${solo ? '' : ' (ставка сгорит)'}`));
    return lines;
  }

  return {
    begin() {
      void refresh().then(repaint);
      every(260, async () => {
        phase += 1;
        if (pending) await sendInput();
        else await refresh();
        repaint();
      });
      every(100, async () => {
        if (pending) await sendInput();
      });
      every(150, repaint);
    },
    draw() {
      if (!state) return solo ? drawSolo() : drawBrowse();
      if (state.status === 'open') return drawRoom();
      return drawGame();
    },
    key(key) {
      if (busy) return;
      tick();

      if (state) {
        if (state.status === 'open') {
          if (isBack(key)) void leave();
          else if (/^[sSыЫ]$/.test(key) && state.mine) void act('start');
          return;
        }
        if (state.over) {
          if (isBack(key) || isEnter(key)) void leave();
          return;
        }
        if (confirmLeave) {
          confirmLeave = false;
          if (/^[yYнН]$/.test(key)) void leave();
          repaint();
          return;
        }
        const steer = STEER[key] ?? STEER[key.toLowerCase?.()];
        if (steer) pending = { move: steer };
        else if (isBack(key)) {
          confirmLeave = true;
          repaint();
        }
        return;
      }

      if (solo) {
        if (isBack(key)) go('lobby');
        else if (key === '\t') formMap = (formMap + 1) % maps.length;
        else if (isEnter(key)) {
          void act('create', { map: maps[formMap]?.id });
          return;
        }
        repaint();
        return;
      }
      if (mode === 'form') {
        if (isBack(key)) mode = 'browse';
        else if (key === KEY.left) formStake = Math.max(0, formStake - 1);
        else if (key === KEY.right) formStake = Math.min(STAKES.length - 1, formStake + 1);
        else if (key === KEY.up) formMax = Math.min(4, formMax + 1);
        else if (key === KEY.down) formMax = Math.max(2, formMax - 1);
        else if (key === '\t') formMap = (formMap + 1) % maps.length;
        else if (isEnter(key)) {
          mode = 'browse';
          void act('create', { stake: STAKES[formStake], max: formMax, map: maps[formMap]?.id });
          return;
        }
        repaint();
        return;
      }
      if (isBack(key)) go('lobby');
      else if (key === KEY.up) picked = Math.max(0, picked - 1);
      else if (key === KEY.down) picked = Math.min(Math.max(0, lobbies.length - 1), picked + 1);
      else if (/^[nNтТ]$/.test(key)) mode = 'form';
      else if (/^[rRкК]$/.test(key)) void refresh().then(repaint);
      else if (isEnter(key) && lobbies[picked]) {
        void act('join', { id: lobbies[picked].id });
        return;
      }
      repaint();
    }
  };

  async function leave() {
    confirmLeave = false;
    pending = null;
    await act('leave');
    state = null;
    mode = solo ? 'solo' : 'browse';
    await refresh();
    repaint();
  }
}
