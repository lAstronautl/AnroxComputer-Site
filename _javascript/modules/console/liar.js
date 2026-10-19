/**
 * «Колода лжеца» in the casino: lobbies, a waiting room and the game table.
 * The whole game lives on the server (worker/src/liar.js); this file polls it and draws what the player may see.
 */

import { c } from './ansi';
import { KEY, box, center, clip, errorText, fmt, isBack, isEnter, money, pad, sgr } from './tui';

const STAKES = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

// card faces: the letter, the suit sign, its colour and the full name
const CARD = {
  Q: { face: 'Д', suit: '♥', code: '31', name: 'ДАМА' },
  K: { face: 'К', suit: '♠', code: '33', name: 'КОРОЛЬ' },
  A: { face: 'Т', suit: '♦', code: '36', name: 'ТУЗ' },
  J: { face: 'Ж', suit: '★', code: '1;95', name: 'ДЖОКЕР' }
};

const cardTone = (card) => (text) => sgr(CARD[card].code, text);

function cardBox(card, selected) {
  const info = CARD[card];
  const edge = selected ? (text) => sgr('1;93', text) : c.grey;
  const face = (text) => (selected ? sgr(`1;${info.code}`, text) : sgr(info.code, text));
  return [
    edge('┌─────┐'),
    `${edge('│')}${face(info.face)}    ${edge('│')}`,
    `${edge('│')}  ${face(info.suit)}  ${edge('│')}`,
    `${edge('│')}    ${face(info.face)}${edge('│')}`,
    edge('└─────┘')
  ];
}

const back = () => c.red('▐▒▌');

export function createLiarScene(env) {
  const { api, repaint, every, header, footer, go, cols, rows, tick } = env;
  const wide = cols >= 78 && rows >= 38;

  let lobbies = [];
  let state = null; // the lobby the player sits in, as the server shows it (null — none)
  let offset = 0; // server clock minus ours
  let mode = 'browse'; // browse | form
  let picked = 0; // list cursor
  let formStake = 3;
  let formMax = 4;
  let selected = new Set();
  let message = '';
  let confirmLeave = false;
  let busy = false;

  const serverNow = () => Date.now() + offset;
  const mineSeat = () => state?.me ?? -1;

  async function refresh() {
    if (busy) return;
    const answer = await api('liar/state');
    if (answer.error) {
      message = errorText(answer.error);
      return;
    }
    const before = state?.status;
    state = answer.lobby;
    if (state) offset = state.now - Date.now();
    if (state?.hand) selected = new Set([...selected].filter((i) => i < state.hand.length));
    if (!state) {
      const list = await api('liar/list');
      if (!list.error) lobbies = list.lobbies;
      picked = Math.min(picked, Math.max(0, lobbies.length - 1));
    }
    if (before && !state) mode = 'browse';
  }

  async function act(path, body) {
    busy = true;
    message = '';
    const answer = await api(path, body);
    busy = false;
    if (answer.error) message = errorText(answer.error);
    else if ('lobby' in answer) {
      state = answer.lobby;
      if (state) offset = state.now - Date.now();
    }
    repaint();
    return answer;
  }

  /* ---------- pieces ---------- */

  function banner() {
    // the last dispute: "Лжец!", the cards turned over, then the revolver
    const log = state.log ?? [];
    const liar = [...log].reverse().find((event) => event.type === 'liar');
    if (!liar) return [];
    const age = serverNow() - liar.t;
    if (age > 9000) return [];
    const name = (seat) => state.players[seat]?.name ?? '?';
    const shot = log.find((event) => event.type === 'shot' && event.t === liar.t);
    const lines = [];
    lines.push(c.bold(c.red(`«ЛЖЕЦ!»  ${name(liar.caller)} → ${name(liar.accused)}`)));
    if (age < 1400) {
      lines.push(liar.cards.map(() => back()).join(' ') + c.grey('   карты переворачиваются…'));
      return lines;
    }
    lines.push(
      `${liar.cards.map((card) => cardTone(card)(`${CARD[card].face}${CARD[card].suit}`)).join(' ')}   ${liar.truth ? c.bold(c.green('ПРАВДА — усомнился(ась) зря')) : c.bold(c.red('ЛОЖЬ — поймали на блефе'))}${c.grey(`   (на столе был ${CARD[liar.table]?.name ?? ''})`)}`
    );
    if (shot) {
      if (age < 3200) lines.push(c.amber(`${name(shot.seat)} крутит барабан и нажимает на курок…`));
      else if (shot.fired) lines.push(c.bold(c.red(`✹ ВЫСТРЕЛ! ${name(shot.seat)} выбывает, его ставка достаётся победителю`)));
      else lines.push(c.green(`щёлк. ${name(shot.seat)} жив(а)… пока (в барабане уже ${shot.pull} из 6)`));
    }
    return lines;
  }

  function eventLine(event) {
    const name = (seat) => state.players[seat]?.name ?? '?';
    switch (event.type) {
      case 'play':
        return `${name(event.seat)} выкладывает ${event.count} ${event.count === 1 ? 'карту' : 'карты'}`;
      case 'liar':
        return `${name(event.caller)}: «Лжец!» — ${event.truth ? 'это правда' : 'это ложь'}`;
      case 'shot':
        return event.fired ? c.red(`✹ выстрел: ${name(event.seat)} выбывает`) : `${name(event.seat)}: щёлк (${event.pull}/6)`;
      case 'out':
        return event.reason === 'shot' ? '' : c.grey(`${name(event.seat)} покинул(а) игру${event.reason === 'afk' ? ' (не ходил)' : ''}`);
      case 'round':
        return c.amber(`раунд ${event.round}: карта стола — ${CARD[event.table].name}`);
      case 'win':
        return c.bold(c.green(`${name(event.seat)} забирает банк ${money(event.pot)}`));
      default:
        return '';
    }
  }

  function playersStrip() {
    const count = state.players.length;
    const width = Math.min(26, Math.floor((cols - 4) / count));
    const blocks = state.players.map((player) => {
      const turn = state.turn === player.seat && state.winner === null;
      const mark = turn ? c.bold(c.amber('►')) : ' ';
      const title = `${mark} ${player.alive ? (player.me ? c.bold(c.bright(clip(player.name, width - 8))) : clip(player.name, width - 8)) : c.grey(clip(player.name, width - 8))}${player.me ? c.grey(' (вы)') : ''}`;
      const cards = player.alive ? Array.from({ length: player.cards }, back).join('') || c.grey('нет карт') : c.red('✹ выбыл');
      const chambers = Array.from({ length: 6 }, (_, i) => (i < player.pulls ? c.red('●') : c.grey('○'))).join('');
      const revolver = player.alive ? `${c.grey('револьвер')} ${chambers}` : '';
      return [pad(title, width), pad(` ${cards}`, width), pad(` ${revolver}`, width)];
    });
    return [0, 1, 2].map((row) => ` ${blocks.map((block) => block[row]).join(' ')}`);
  }

  /* ---------- screens ---------- */

  function drawBrowse() {
    const lines = header('лжец');
    lines.push('', center(c.bold(c.red('КОЛОДА ЛЖЕЦА')) + c.grey('  ·  выкладывайте карты, блефуйте, ловите на лжи'), cols), '');
    if (mode === 'form') {
      const stake = STAKES[formStake];
      const body = [
        '',
        `  ${c.grey('Ставка с каждого')}   ${c.red('◄')} ${c.bold(c.amber(money(stake)))} ${c.red('►')}`,
        `  ${c.grey('Игроков')}            ${c.red('▲')} ${c.bold(c.bright(String(formMax)))} ${c.red('▼')}`,
        '',
        `  ${c.grey('Банк при полном зале')}  ${c.bold(c.green(money(stake * formMax)))}`,
        c.grey('  Победитель забирает всё. Ставки выбывших сгорают в банк.'),
        ''
      ];
      const width = Math.min(cols - 4, 62);
      for (const line of box(width, 'НОВОЕ ЛОББИ', body)) lines.push(center(line, cols));
      lines.push('', center(message ? c.red(message) : c.grey('←→ ставка · ↑↓ игроков · Enter — создать · Esc — отмена'), cols));
    } else {
      lines.push(` ${c.red('── ОТКРЫТЫЕ ЛОББИ')} ${c.grey('─'.repeat(Math.max(2, cols - 22)))}`);
      if (!lobbies.length) lines.push('', center(c.grey('Пока нет ни одного лобби — создайте своё: N'), cols));
      lobbies.slice(0, Math.max(3, rows - 14)).forEach((lobby, index) => {
        const on = index === picked;
        const mark = on ? c.bold(c.red('►')) : ' ';
        const names = clip(lobby.players.join(', '), Math.max(8, cols - 50));
        lines.push(` ${mark} ${on ? c.bold(c.bright(`#${lobby.id}`)) : c.amber(`#${lobby.id}`)}  ${pad(on ? c.bright(clip(lobby.owner, 12)) : clip(lobby.owner, 12), 13)} ${c.grey('ставка')} ${pad(c.amber(money(lobby.stake)), 12)} ${c.grey('мест')} ${lobby.players.length}/${lobby.max}  ${c.grey(names)}`);
      });
      lines.push('', center(message ? c.red(message) : c.grey('Enter — войти (ставка спишется сразу) · N — создать своё · R — обновить'), cols));
    }
    while (lines.length < rows - 1) lines.push('');
    lines.push(...footer(mode === 'form' ? '←→ ставка · ↑↓ игроков · Enter — создать · Esc — отмена' : '↑↓ выбор · Enter — войти · N — создать · Esc — в лобби казино'));
    return lines;
  }

  function drawRoom() {
    const lines = header(`лжец · лобби #${state.id}`);
    lines.push('');
    const slots = Array.from({ length: state.max }, (_, i) => state.players[i]);
    const body = ['', `  ${c.grey('Ставка с каждого')} ${c.bold(c.amber(money(state.stake)))}   ${c.grey('банк')} ${c.bold(c.green(money(state.stake * state.players.length)))} ${c.grey(`(при ${state.max} игроках ${fmt(state.stake * state.max)})`)}`, ''];
    slots.forEach((player, index) => {
      body.push(player ? `  ${c.bold(c.red(String(index + 1)))}  ${player.me ? c.bold(c.bright(player.name)) : player.name}${player.name === state.owner ? c.grey('  · создатель') : ''}` : c.grey(`  ${index + 1}  ждём игрока…`));
    });
    body.push('');
    const width = Math.min(cols - 4, 66);
    for (const line of box(width, 'ЗАЛ ОЖИДАНИЯ', body)) lines.push(center(line, cols));
    lines.push('');
    lines.push(center(state.mine ? (state.players.length >= 2 ? c.bold(c.amber('S — начать игру')) : c.grey('Для старта нужно минимум два игрока')) : c.grey(`Ждём, пока ${state.owner} начнёт игру`), cols));
    lines.push(center(c.grey('Выйдете до старта — ставка вернётся.'), cols));
    if (message) lines.push(center(c.red(message), cols));
    while (lines.length < rows - 1) lines.push('');
    lines.push(...footer(state.mine ? 'S — начать · Esc — выйти из лобби' : 'Esc — выйти из лобби'));
    return lines;
  }

  function drawGame() {
    const lines = header(`лжец · лобби #${state.id}`);
    const now = serverNow();
    const over = state.winner !== null;
    const me = state.players[mineSeat()];
    const myTurn = !over && state.turn === mineSeat() && me?.alive;

    lines.push(...playersStrip());
    lines.push(c.red('─'.repeat(cols)));

    // the table
    const tableName = state.table ? `${CARD[state.table].name} ${CARD[state.table].suit}` : '—';
    const left = Math.max(0, Math.ceil((state.deadline - now) / 1000));
    lines.push(
      ` ${c.grey('раунд')} ${c.bold(c.bright(String(state.round)))}   ${c.grey('карта стола')} ${state.table ? cardTone(state.table)(c.bold(tableName)) : c.grey('—')}   ${c.grey('банк')} ${c.bold(c.green(money(state.pot)))}${over ? '' : `   ${c.grey('ход')} ${left < 10 ? c.red(`${left} с`) : c.grey(`${left} с`)}`}`
    );
    if (over) {
      const winner = state.players[state.winner];
      lines.push('', center(c.bold(c.green(`★ ПОБЕДИТЕЛЬ: ${winner.name} ★`)) + c.grey(`  забирает ${money(state.pot)}`), cols));
      lines.push(center(winner.me ? c.bold(c.green(`Выигрыш зачислен на баланс: +${money(state.pot - state.stake)} чистыми`)) : c.red(`Ваша ставка ${money(state.stake)} сгорела`), cols));
    } else if (state.last && state.last.seat !== undefined) {
      const who = state.players[state.last.seat];
      const text = `${who.me ? 'Вы выложили' : `${who.name} выложил(а)`} ${state.last.count} ${state.last.count === 1 ? 'карту' : 'карты'} — «все это ${CARD[state.table].name.toLowerCase()}»`;
      lines.push(` ${c.amber(text)}${myTurn ? c.bold(c.bright('   — верите?')) : ''}`);
    } else {
      lines.push(` ${c.grey('Первый ход в раунде: выложите 1–3 карты и заявите, что это карта стола')}`);
    }

    const events = banner();
    if (events.length) {
      lines.push('');
      for (const line of events) lines.push(` ${line}`);
    }

    // the player's own hand
    lines.push('');
    if (me?.alive && state.hand.length) {
      if (wide) {
        const faces = state.hand.map((card, i) => cardBox(card, selected.has(i)));
        for (let row = 0; row < 5; row += 1) lines.push(` ${faces.map((face) => face[row]).join('  ')}`);
        lines.push(` ${state.hand.map((_, i) => pad(selected.has(i) ? c.bold(c.amber(`▲ ${i + 1}`)) : c.grey(`  ${i + 1}`), 7)).join('  ')}`);
      } else {
        lines.push(` ${state.hand.map((card, i) => (selected.has(i) ? c.inverse(` ${i + 1}:${CARD[card].face}${CARD[card].suit} `) : `${c.grey(`${i + 1}:`)}${cardTone(card)(`${CARD[card].face}${CARD[card].suit}`)}`)).join('  ')}`);
      }
    } else if (!over) {
      lines.push(` ${c.grey(me?.alive ? 'У вас нет карт' : 'Вы выбыли — можно наблюдать за игрой')}`);
    }

    // the log
    lines.push('');
    const room = Math.max(2, rows - lines.length - 3);
    const feed = (state.log ?? []).map(eventLine).filter(Boolean).slice(-room);
    for (const line of feed) lines.push(` ${c.grey('·')} ${line}`);
    while (lines.length < rows - 2) lines.push('');

    lines.push(message ? ` ${c.red(message)}` : confirmLeave ? ` ${c.bold(c.red('Выйти из игры? Ваша ставка сгорит.'))} ${c.amber('Y — выйти, любая другая клавиша — остаться')}` : '');
    lines.push(...footer(over ? 'Enter / Esc — вернуться к списку лобби' : myTurn ? '1–5 — выбрать карты · Enter — выложить выбранные · L — «Лжец!» · Esc — выйти' : 'Ждём чужой ход · Esc — выйти из игры (ставка сгорит)'));
    return lines;
  }

  return {
    begin() {
      void refresh().then(repaint);
      every(700, async () => {
        await refresh();
        repaint();
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

      // ----- inside a lobby
      if (state) {
        if (state.status === 'open') {
          if (isBack(key)) void leave();
          else if (/^[sSыЫ]$/.test(key) && state.mine) void act('liar/start');
          return;
        }
        if (state.winner !== null) {
          if (isBack(key) || isEnter(key)) void leave();
          return;
        }
        if (confirmLeave) {
          confirmLeave = false;
          if (/^[yYнН]$/.test(key)) void leave();
          repaint();
          return;
        }
        if (isBack(key)) {
          confirmLeave = true;
          repaint();
          return;
        }
        const myTurn = state.turn === mineSeat();
        if (/^[1-5]$/.test(key)) {
          const index = Number(key) - 1;
          if (index < state.hand.length) {
            if (selected.has(index)) selected.delete(index);
            else if (selected.size < 3) selected.add(index);
          }
          repaint();
        } else if (isEnter(key) || key === ' ') {
          if (!myTurn) message = 'Сейчас не ваш ход.';
          else if (selected.size < 1) message = 'Выберите от 1 до 3 карт (цифры 1–5).';
          else {
            const cards = [...selected].sort((a, b) => a - b);
            selected = new Set();
            void act('liar/play', { cards });
            return;
          }
          repaint();
        } else if (/^[lLдД]$/.test(key)) {
          if (!myTurn) message = 'Сейчас не ваш ход.';
          else {
            void act('liar/call');
            return;
          }
          repaint();
        }
        return;
      }

      // ----- no lobby: the list and the "new lobby" form
      if (mode === 'form') {
        if (isBack(key)) mode = 'browse';
        else if (key === KEY.left) formStake = Math.max(0, formStake - 1);
        else if (key === KEY.right) formStake = Math.min(STAKES.length - 1, formStake + 1);
        else if (key === KEY.up) formMax = Math.min(4, formMax + 1);
        else if (key === KEY.down) formMax = Math.max(2, formMax - 1);
        else if (isEnter(key)) {
          mode = 'browse';
          void act('liar/create', { stake: STAKES[formStake], max: formMax });
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
        void act('liar/join', { id: lobbies[picked].id });
        return;
      }
      repaint();
    }
  };

  async function leave() {
    confirmLeave = false;
    selected = new Set();
    await act('liar/leave');
    state = null;
    mode = 'browse';
    await refresh();
    repaint();
  }
}

