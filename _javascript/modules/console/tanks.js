/**
 * «Танчики» (Battle City) in the casino: lobbies, a waiting room and the battlefield for 2–4 players.
 * The game runs on the server (worker/src/tanks.js) in 0.3 s ticks; this file sends the keys (WASD — drive,
 * arrows — shoot) and draws what the server shows.
 */

import { c } from './ansi';
import { KEY, box, center, clip, errorText, fmt, isBack, isEnter, money, pad, sgr } from './tui';

const STAKES = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

const SEAT = ['92', '96', '93', '95']; // seat colours
const ARROW = { U: '▲', D: '▼', L: '◄', R: '►' };
const DRIVE = { w: 'U', a: 'L', s: 'D', d: 'R', ц: 'U', ф: 'L', ы: 'D', в: 'R' };
const SHOOT = { [KEY.up]: 'U', [KEY.down]: 'D', [KEY.left]: 'L', [KEY.right]: 'R' };

const TERRAIN = {
  '.': '  ',
  B: sgr('38;5;166', '▒▒'),
  S: sgr('37', '██'),
  W: sgr('34', '≈≈'),
  G: sgr('32', '░░')
};

export function createTankScene(env) {
  const { api, repaint, every, header, footer, go, cols, rows, tick } = env;
  const side = cols >= 72; // the scoreboard sits right of the field, otherwise under it

  let lobbies = [];
  let maps = [{ id: 'yard', name: 'Двор' }];
  let state = null;
  let mode = 'browse'; // browse | form
  let picked = 0;
  let formStake = 3;
  let formMax = 4;
  let formMap = 0;
  let message = '';
  let confirmLeave = false;
  let busy = false;
  let flight = false; // an input/state request is on its way
  let pending = null; // {move, fire} keys waiting for the next send
  let phase = 0;

  async function refresh() {
    if (busy || flight) return;
    flight = true;
    const answer = await api('tank/state');
    flight = false;
    if (answer.error) {
      message = errorText(answer.error);
      return;
    }
    const before = state?.status;
    state = answer.lobby;
    if (!state) {
      const list = await api('tank/list');
      if (!list.error) {
        lobbies = list.lobbies;
        maps = list.maps;
      }
      picked = Math.min(picked, Math.max(0, lobbies.length - 1));
    }
    if (before && !state) mode = 'browse';
  }

  async function sendInput() {
    if (flight || !pending || state?.status !== 'playing') return;
    const body = pending;
    pending = null;
    flight = true;
    const answer = await api('tank/input', body);
    flight = false;
    if (!answer.error && answer.lobby) state = answer.lobby;
    repaint();
  }

  async function act(path, body) {
    busy = true;
    message = '';
    const answer = await api(path, body);
    busy = false;
    if (answer.error) message = errorText(answer.error);
    else if ('lobby' in answer) state = answer.lobby;
    repaint();
    return answer;
  }

  /* ---------- pieces ---------- */

  const tone = (seat, text) => sgr(`1;${SEAT[seat] ?? '97'}`, text);

  function field() {
    const cells = state.grid.map((row) => [...row].map((ch) => TERRAIN[ch] ?? '  '));
    for (const bullet of state.bullets) {
      if (cells[bullet.y]?.[bullet.x] !== undefined) cells[bullet.y][bullet.x] = sgr('1;97', '● ');
    }
    for (const player of state.players) {
      if (!player.alive || player.x === undefined) continue;
      const blink = player.shield && phase % 2 === 0;
      const glyph = ARROW[player.dir] ?? '▲';
      cells[player.y][player.x] = blink ? sgr('1;97;44', `${glyph}${glyph}`) : tone(player.seat, `${glyph}${glyph}`);
    }
    const frame = c.red('─'.repeat(state.grid[0].length * 2));
    return [c.red('┌') + frame + c.red('┐'), ...cells.map((row) => c.red('│') + row.join('') + c.red('│')), c.red('└') + frame + c.red('┘')];
  }

  function scoreboard() {
    const lines = [];
    const width = side ? Math.min(cols - 46, 34) : cols - 2;
    for (const player of state.players) {
      const hearts = player.alive ? c.red('♥'.repeat(player.lives)) + c.grey('♡'.repeat(Math.max(0, 3 - player.lives))) : c.grey('✹ выбыл');
      const name = clip(player.name, Math.max(6, width - 22));
      const mine = player.me ? c.grey(' (вы)') : '';
      const hidden = player.hidden ? c.grey(' [в кустах]') : '';
      lines.push(`${tone(player.seat, '■')} ${player.alive ? name : c.grey(name)}${mine}${hidden}`);
      lines.push(`  ${hearts}  ${c.grey('убил')} ${c.bold(c.bright(String(player.kills)))}`);
    }
    return lines;
  }

  function eventLine(event) {
    const name = (seat) => state.players[seat]?.name ?? '?';
    switch (event.type) {
      case 'go':
        return c.bold(c.green('В БОЙ!'));
      case 'hit':
        return `${name(event.owner)} → ${name(event.victim)}  ${c.grey(`(осталось ${event.lives})`)}`;
      case 'dead':
        return c.red(`✹ ${name(event.owner)} уничтожает ${name(event.victim)}`);
      case 'left':
        return c.grey(`${name(event.victim)} покинул(а) бой`);
      case 'over':
        return event.winners.length ? c.bold(c.green(`★ ${event.winners.map(name).join(', ')} — победа`)) : c.grey('бой окончен');
      default:
        return '';
    }
  }

  const feed = (count) => (state.log ?? []).map(eventLine).filter(Boolean).slice(-count);

  /* ---------- screens ---------- */

  function drawBrowse() {
    const lines = header('танчики');
    lines.push('', center(c.bold(c.red('ТАНЧИКИ')) + c.grey('  ·  PvP 2–4 игрока, победитель забирает банк'), cols), '');
    if (mode === 'form') {
      const stake = STAKES[formStake];
      const body = [
        '',
        `  ${c.grey('Ставка с каждого')}   ${c.red('◄')} ${c.bold(c.amber(money(stake)))} ${c.red('►')}`,
        `  ${c.grey('Игроков')}            ${c.red('▲')} ${c.bold(c.bright(String(formMax)))} ${c.red('▼')}`,
        `  ${c.grey('Карта')}              ${c.red('Tab')} ${c.bold(c.bright(maps[formMap]?.name ?? '—'))}`,
        '',
        `  ${c.grey('Банк при полном зале')}  ${c.bold(c.green(money(stake * formMax)))}`,
        c.grey('  Три жизни. Выбывший теряет ставку, последний выживший берёт банк.'),
        ''
      ];
      for (const line of box(Math.min(cols - 4, 66), 'НОВЫЙ БОЙ', body)) lines.push(center(line, cols));
      lines.push('', center(message ? c.red(message) : c.grey('←→ ставка · ↑↓ игроков · Tab карта · Enter — создать · Esc — отмена'), cols));
    } else {
      lines.push(` ${c.red('── ОТКРЫТЫЕ БОИ')} ${c.grey('─'.repeat(Math.max(2, cols - 19)))}`);
      if (!lobbies.length) lines.push('', center(c.grey('Пока нет ни одного боя — создайте свой: N'), cols));
      lobbies.slice(0, Math.max(3, rows - 14)).forEach((lobby, index) => {
        const on = index === picked;
        const mark = on ? c.bold(c.red('►')) : ' ';
        const names = clip(lobby.players.join(', '), Math.max(8, cols - 62));
        lines.push(` ${mark} ${on ? c.bold(c.bright(`#${lobby.id}`)) : c.amber(`#${lobby.id}`)}  ${pad(clip(lobby.owner, 12), 13)} ${c.grey('ставка')} ${pad(c.amber(money(lobby.stake)), 12)} ${pad(c.grey(lobby.mapName), 10)} ${c.grey('мест')} ${lobby.players.length}/${lobby.max}  ${c.grey(names)}`);
      });
      lines.push('', center(message ? c.red(message) : c.grey('Enter — войти (ставка спишется сразу) · N — создать · R — обновить'), cols));
    }
    while (lines.length < rows - 1) lines.push('');
    lines.push(...footer(mode === 'form' ? '←→ ставка · ↑↓ игроков · Tab карта · Enter — создать · Esc — отмена' : '↑↓ выбор · Enter — войти · N — создать · Esc — в лобби казино'));
    return lines;
  }

  function drawRoom() {
    const lines = header(`танчики · бой #${state.id}`);
    lines.push('');
    const body = ['', `  ${c.grey('Ставка с каждого')} ${c.bold(c.amber(money(state.stake)))}   ${c.grey('банк')} ${c.bold(c.green(money(state.stake * state.players.length)))} ${c.grey(`(при ${state.max} игроках ${fmt(state.stake * state.max)})`)}`, `  ${c.grey('Карта')} ${c.bold(c.bright(state.mapName))}`, ''];
    Array.from({ length: state.max }, (_, i) => state.players[i]).forEach((player, index) => {
      body.push(player ? `  ${tone(index, '■')} ${player.me ? c.bold(c.bright(player.name)) : player.name}${player.name === state.owner ? c.grey('  · создатель') : ''}` : c.grey('  □ ждём игрока…'));
    });
    body.push('');
    for (const line of box(Math.min(cols - 4, 66), 'ЗАЛ ОЖИДАНИЯ', body)) lines.push(center(line, cols));
    lines.push('', center(state.mine ? (state.players.length >= 2 ? c.bold(c.amber('S — начать бой')) : c.grey('Для старта нужно минимум два игрока')) : c.grey(`Ждём, пока ${state.owner} начнёт бой`), cols));
    lines.push(center(c.grey('Управление: W A S D — ехать, стрелки — стрелять в четыре стороны.'), cols));
    lines.push(center(c.grey('Выйдете до старта — ставка вернётся.'), cols));
    if (message) lines.push(center(c.red(message), cols));
    while (lines.length < rows - 1) lines.push('');
    lines.push(...footer(state.mine ? 'S — начать · Esc — выйти из лобби' : 'Esc — выйти из лобби'));
    return lines;
  }

  function drawGame() {
    const lines = header(`танчики · бой #${state.id} · ${state.mapName}`);
    const seconds = Math.ceil((state.timeLeft * state.tickMs) / 1000);
    const status = state.over ? '' : state.countdown > 0 ? c.bold(c.amber(`СТАРТ ЧЕРЕЗ ${Math.ceil((state.countdown * state.tickMs) / 1000)} с — займите позицию`)) : `${c.grey('до конца боя')} ${seconds < 30 ? c.red(`${seconds} с`) : c.grey(`${seconds} с`)}`;
    lines.push(` ${c.grey('банк')} ${c.bold(c.green(money(state.pot)))}   ${status}`);

    const board = field();
    const panel = scoreboard();
    if (side) {
      const log = feed(Math.max(2, board.length - panel.length - 2));
      const right = [...panel, '', c.grey('── журнал'), ...log.map((line) => ` ${line}`)];
      board.forEach((row, i) => lines.push(` ${row}  ${right[i] ?? ''}`));
    } else {
      board.forEach((row) => lines.push(` ${row}`));
      lines.push(...panel.map((line) => ` ${line}`));
    }

    if (state.over) {
      const winners = state.winners.map((seat) => state.players[seat]);
      const won = winners.some((player) => player.me);
      lines.push('');
      lines.push(center(winners.length ? c.bold(c.green(`★ ПОБЕДА: ${winners.map((player) => player.name).join(', ')} ★`)) : c.grey('Никто не выжил'), cols));
      lines.push(center(won ? c.bold(c.green(`Банк разделён: вам зачислено ${money(Math.floor(state.pot / winners.length))}`)) : c.red(`Ваша ставка ${money(state.stake)} сгорела`), cols));
    } else if (!side) {
      for (const line of feed(2)) lines.push(` ${c.grey('·')} ${line}`);
    }
    while (lines.length < rows - 2) lines.push('');
    lines.push(message ? ` ${c.red(message)}` : confirmLeave ? ` ${c.bold(c.red('Выйти из боя? Ваша ставка сгорит.'))} ${c.amber('Y — выйти, любая другая клавиша — остаться')}` : '');
    lines.push(...footer(state.over ? 'Enter / Esc — к списку боёв' : 'W A S D — ехать · стрелки — стрелять · Esc — выйти (ставка сгорит)'));
    return lines;
  }

  return {
    begin() {
      void refresh().then(repaint);
      every(280, async () => {
        phase += 1;
        if (pending) await sendInput();
        else await refresh();
        repaint();
      });
      every(120, async () => {
        if (pending) await sendInput();
      });
      every(150, repaint);
    },
    draw() {
      if (!state) return drawBrowse();
      if (state.status === 'open') return drawRoom();
      return drawGame();
    },
    key(key) {
      if (busy) return;
      tick();

      if (state) {
        if (state.status === 'open') {
          if (isBack(key)) void leave();
          else if (/^[sSыЫ]$/.test(key) && state.mine) void act('tank/start');
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
        if (key === '\u001b') {
          confirmLeave = true;
          repaint();
          return;
        }
        if (key.length === 1 && DRIVE[key.toLowerCase()]) pending = { ...pending, move: DRIVE[key.toLowerCase()] };
        else if (SHOOT[key]) pending = { ...pending, fire: SHOOT[key] };
        else if (/^[qQйЙ]$/.test(key)) {
          confirmLeave = true;
          repaint();
        }
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
          void act('tank/create', { stake: STAKES[formStake], max: formMax, map: maps[formMap]?.id });
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
        void act('tank/join', { id: lobbies[picked].id });
        return;
      }
      repaint();
    }
  };

  async function leave() {
    confirmLeave = false;
    pending = null;
    await act('tank/leave');
    state = null;
    mode = 'browse';
    await refresh();
    repaint();
  }
}
