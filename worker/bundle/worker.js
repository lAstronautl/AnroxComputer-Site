// Единый файл для вставки в редактор Worker в панели Cloudflare (собран из src/config.js + src/economy.js + src/liar.js + src/tanks.js + src/arcade.js + src/index.js).
// Не правьте вручную: меняйте src/ и пересобирайте (python3 worker/build-bundle.py).

// с этого уровня доступны promote, demote, transfer, resetpass, fire, broadcast (adduser — всем вошедшим, но не выше своего уровня)
const ADMIN_LEVEL = 10;
const MAX_LEVEL = 999;
// с этого уровня доступно редактирование рынка (команда marketedit); держите в соответствии с `market_admin_level` в `_data/console.yml`
const MARKET_ADMIN_LEVEL = 999;

const ACTIONS = new Set(['read', 'denied', 'bad-code', 'hack-failed', 'article']);

const START_BALANCE = 1000;
const MAX_BET = 10000;
const FEE = 0.05; // комиссия биржи с каждой сделки (5%)
const TICK_MS = 5000; // как часто меняются цены
const HISTORY_TICKS = 72; // сколько тиков истории отдаём клиенту (6 минут)
const LIQUIDITY = 20000; // сделка на столько КЕ двигает цену примерно на 100% (на деле — на долю этого)
const DEMAND_HALF_MS = 4 * 60 * 1000; // за это время влияние спроса ослабевает вдвое
const MAX_PRESSURE = 0.7; // цена от спроса меняется не больше чем в e^0.7 ≈ 2 раза
const MAX_IMPACT = 0.07; // одна сделка двигает цену не больше чем на ≈ 7%
const CRASH_RATE = 0.09; // рост множителя «Взлёта» в секунду (экспонента)
const CRASH_GRACE_MS = 400; // запас на задержку сети: нажатие «Забрать» засчитывается, если успело до обвала с учётом пинга

// group — корпорация-владелец: компании одной корпорации движутся отчасти вместе
// vol — размах колебаний, noise — «шум» отдельных тиков
const ASSETS = [
  { id: 'ANRX', name: 'AnroxComputers', group: 'Anrox', kind: 'акции', base: 120, vol: 0.2, noise: 0.012 },
  { id: 'AIB', name: 'Anrox InterCorp Bank', group: 'Anrox', kind: 'банк', base: 95, vol: 0.16, noise: 0.01 },
  { id: 'GNG', name: 'Girls&Guns', group: 'Anrox', kind: 'акции', base: 70, vol: 0.38, noise: 0.022 },
  { id: 'ENDI', name: 'EndiCoin', group: 'Anrox', kind: 'крипто', base: 15, vol: 0.75, noise: 0.05 },
  { id: 'MGLX', name: 'MiliGalax', group: 'MiliGalax', kind: 'акции', base: 150, vol: 0.24, noise: 0.014 },
  { id: 'GWPN', name: 'Galax Weapons', group: 'MiliGalax', kind: 'оружие', base: 80, vol: 0.3, noise: 0.018 },
  { id: 'GAUT', name: 'Galax Automatics', group: 'MiliGalax', kind: 'автоматика', base: 55, vol: 0.34, noise: 0.02 },
  { id: 'STDU', name: 'StarDust', group: 'StarDust', kind: 'акции', base: 110, vol: 0.22, noise: 0.013 },
  { id: 'SMIN', name: 'Star Minerals', group: 'StarDust', kind: 'ресурс', base: 40, vol: 0.45, noise: 0.028 },
  { id: 'SARD', name: 'Star Ardon', group: 'StarDust', kind: 'ресурс', base: 210, vol: 0.55, noise: 0.032 },
  { id: 'SUBE', name: 'Subea', group: 'Subea', kind: 'акции', base: 130, vol: 0.2, noise: 0.012 },
  { id: 'SIMP', name: 'Subea Implanters', group: 'Subea', kind: 'импланты', base: 65, vol: 0.36, noise: 0.022 },
  { id: 'SPHA', name: 'Subea Pharmaceutics', group: 'Subea', kind: 'фарма', base: 90, vol: 0.28, noise: 0.017 }
];

/* ---------- цены ---------- */

function mix(a, b) {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function saltOf(text) {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
  return h >>> 0;
}

// шум, плавный между отметками, чтобы график выглядел живым, а не «пилой»
function smoothNoise(salt, tick, scale) {
  const x = tick / scale;
  const i = Math.floor(x);
  const f = x - i;
  const t = f * f * (3 - 2 * f);
  return mix(salt, i) * (1 - t) + mix(salt, i + 1) * t - 0.5;
}

function waves(salt, tick) {
  const phase = (n) => mix(salt, 1000 + n) * Math.PI * 2;
  return 0.55 * Math.sin(tick / 42 + phase(1)) + 0.3 * Math.sin(tick / 11.5 + phase(2)) + 0.15 * Math.sin(tick / 3.4 + phase(3));
}

function priceAt(asset, tick, seed = '') {
  const salt = saltOf(`${seed}:${asset.id}`);
  const groupSalt = saltOf(`${seed}:group:${asset.group ?? asset.id}`);
  // half of the swing is shared with the corporation's other companies, half is the company's own
  const swing = 0.5 * waves(groupSalt, tick) + 0.5 * waves(salt, tick);
  const noise = smoothNoise(salt, tick, 6) * 0.5 + smoothNoise(salt ^ 0x5bd1e995, tick, 1.7) * 0.5;
  const price = asset.base * Math.exp(asset.vol * swing * 1.15 + asset.noise * 4 * noise);
  return Math.max(1, Math.round(price * 100) / 100);
}

const tickOf = (now) => Math.floor(now / TICK_MS);

/**
 * Давление спроса на момент `at`: сумма влияний сделок (покупка +, продажа −), каждое затухает со временем.
 * events — [{ t, impact }] по одному активу. Цена = базовая цена × e^давление.
 */
function pressureAt(events, at) {
  let sum = 0;
  for (const event of events) {
    if (event.t <= at) sum += event.impact * 0.5 ** ((at - event.t) / DEMAND_HALF_MS);
  }
  return Math.max(-MAX_PRESSURE, Math.min(MAX_PRESSURE, sum));
}

function marketPrice(asset, tick, seed, events, at) {
  return Math.max(1, Math.round(priceAt(asset, tick, seed) * Math.exp(pressureAt(events ?? [], at)) * 100) / 100);
}

// насколько сделка на сумму `value` сдвинет цену; считается точно, чтобы игрок заранее видел итоговую сумму
function tradeImpact(value) {
  return Math.min(MAX_IMPACT, value / LIQUIDITY);
}

function snapshot(now, seed, demand = {}, assets = ASSETS) {
  const tick = tickOf(now);
  return {
    tick,
    tickMs: TICK_MS,
    nextIn: TICK_MS - (now % TICK_MS),
    assets: assets.map((asset) => {
      const events = demand[asset.id] ?? [];
      const history = [];
      for (let k = tick - HISTORY_TICKS + 1; k <= tick; k += 1) {
        history.push(marketPrice(asset, k, seed, events, k === tick ? now : k * TICK_MS));
      }
      return {
        id: asset.id,
        name: asset.name,
        group: asset.group,
        kind: asset.kind,
        price: history[history.length - 1],
        demand: Math.round(pressureAt(events, now) * 1000) / 1000,
        history
      };
    })
  };
}

/* ---------- казино ---------- */

function randomFloat() {
  return crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;
}

const randomInt = (max, rng = randomFloat) => Math.floor(rng() * max);

// слоты: три барабана, символы с весами, выигрыш — три одинаковых или пара
const SLOT_SYMBOLS = [
  { s: '7', weight: 1, triple: 100 },
  { s: '◆', weight: 2, triple: 40 },
  { s: '★', weight: 3, triple: 20 },
  { s: 'Ω', weight: 4, triple: 12 },
  { s: '♥', weight: 6, triple: 7 },
  { s: '♣', weight: 7, triple: 5 },
  { s: '¤', weight: 8, triple: 3 }
];
const SLOT_PAIR = 1.6; // две одинаковые — небольшой выигрыш (общая отдача около 92%)

function spinSlots(rng = randomFloat) {
  const total = SLOT_SYMBOLS.reduce((sum, item) => sum + item.weight, 0);
  const pick = () => {
    let roll = rng() * total;
    for (const item of SLOT_SYMBOLS) {
      roll -= item.weight;
      if (roll < 0) return item;
    }
    return SLOT_SYMBOLS[SLOT_SYMBOLS.length - 1];
  };
  const reels = [pick(), pick(), pick()];
  let multiplier = 0;
  if (reels[0].s === reels[1].s && reels[1].s === reels[2].s) multiplier = reels[0].triple;
  else if (reels[0].s === reels[1].s || reels[1].s === reels[2].s || reels[0].s === reels[2].s) multiplier = SLOT_PAIR;
  return { reels: reels.map((item) => item.s), multiplier };
}

// рулетка (европейская, один ноль)
const REDS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const rouletteColor = (n) => (n === 0 ? 'green' : REDS.has(n) ? 'red' : 'black');

const ROULETTE_BETS = {
  red: { pays: 2, wins: (n) => rouletteColor(n) === 'red' },
  black: { pays: 2, wins: (n) => rouletteColor(n) === 'black' },
  odd: { pays: 2, wins: (n) => n > 0 && n % 2 === 1 },
  even: { pays: 2, wins: (n) => n > 0 && n % 2 === 0 },
  low: { pays: 2, wins: (n) => n >= 1 && n <= 18 },
  high: { pays: 2, wins: (n) => n >= 19 },
  dozen: { pays: 3, wins: (n, v) => n >= 1 && Math.ceil(n / 12) === v, check: (v) => v >= 1 && v <= 3 },
  number: { pays: 36, wins: (n, v) => n === v, check: (v) => v >= 0 && v <= 36 }
};

function spinRoulette(type, value, rng = randomFloat) {
  const bet = ROULETTE_BETS[type];
  if (!bet || (bet.check && !bet.check(value))) return null;
  const number = randomInt(37, rng);
  return { number, color: rouletteColor(number), multiplier: bet.wins(number, value) ? bet.pays : 0 };
}

// кости: бросок 1–100, ставка «меньше» или «больше» порога; выплата обратно пропорциональна шансу
const DICE_EDGE = 0.98;

function diceChance(mode, target) {
  return mode === 'under' ? (target - 1) / 100 : (100 - target) / 100;
}

const diceMultiplier = (mode, target) => Math.floor((DICE_EDGE / diceChance(mode, target)) * 100) / 100;

function rollDice(mode, target, rng = randomFloat) {
  if (!['under', 'over'].includes(mode) || !Number.isInteger(target) || target < 2 || target > 99) return null;
  if (diceChance(mode, target) <= 0.01 || diceChance(mode, target) >= 0.98) return null;
  const roll = 1 + randomInt(100, rng);
  const win = mode === 'under' ? roll < target : roll > target;
  return { roll, multiplier: win ? diceMultiplier(mode, target) : 0 };
}

// «Взлёт»: множитель растёт, пока не «рухнет»; игрок должен успеть забрать выигрыш
function crashPoint(rng = randomFloat) {
  const r = rng();
  return Math.min(500, Math.max(1, Math.floor(93 / (1 - r)) / 100)); // 93 + запас на пинг ≈ 96% отдачи
}

const crashMultiplier = (elapsedMs) => Math.floor(Math.exp((CRASH_RATE * elapsedMs) / 1000) * 100) / 100;

// общий «Взлёт»: один раунд на всех — кто-то запускает раунд, минута на ставки, полёт, показ итога, затем снова можно запускать
const CRASH_BET_WINDOW_MS = 60000; // минута на ставки после запуска раунда
const CRASH_RESULT_MS = 7000;

// с какого момента полёта раунд считается рухнувшим (с запасом на пинг)
const crashDurationMs = (crash) => Math.ceil((Math.log(crash) / CRASH_RATE) * 1000) + CRASH_GRACE_MS + 50;

const LIAR_TURN_MS = 40000; // время на ход; потом ход делается за игрока
const LIAR_AFK_LIMIT = 3; // сколько ходов подряд можно пропустить, прежде чем вылетишь
const LIAR_HAND = 5;
const LIAR_LOG = 40;
const TABLE_CARDS = ['Q', 'K', 'A'];

// the deck is sized to the number of players still in the game, so every hand is dealt out of the whole deck:
// 4 players — 20 cards, 3 — 15, 2 — 10 (five cards each)
const LIAR_DECKS = {
  4: { A: 6, K: 6, Q: 6, J: 2 },
  3: { A: 4, K: 4, Q: 4, J: 3 },
  2: { A: 3, K: 3, Q: 3, J: 1 }
};

function shuffle(list, rng) {
  const cards = [...list];
  for (let i = cards.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

const aliveSeats = (state) => state.players.map((player, seat) => (player.alive ? seat : -1)).filter((seat) => seat >= 0);

function nextAlive(state, seat) {
  const count = state.players.length;
  for (let step = 1; step <= count; step += 1) {
    const candidate = (seat + step) % count;
    if (state.players[candidate].alive) return candidate;
  }
  return seat;
}

const note = (state, event, now) => {
  state.log.push({ t: now, ...event });
  if (state.log.length > LIAR_LOG) state.log.splice(0, state.log.length - LIAR_LOG);
};

/** A new game: seats in the order given, a secret bullet position in every revolver. */
function liarStart(players, stake, rng, now) {
  const state = {
    round: 0,
    stake,
    pot: stake * players.length,
    players: players.map((player) => ({ key: player.key, name: player.name, alive: true, hand: [], pulls: 0, bullet: Math.floor(rng() * 6), idle: 0 })),
    table: 'A',
    turn: 0,
    last: null,
    deadline: 0,
    log: [],
    winner: null
  };
  newRound(state, 0, rng, now);
  return state;
}

function newRound(state, starter, rng, now) {
  const mix = LIAR_DECKS[Math.min(4, Math.max(2, aliveSeats(state).length))];
  const deck = shuffle(Object.entries(mix).flatMap(([card, count]) => Array(count).fill(card === 'J' ? 'J' : card)), rng);
  for (const player of state.players) player.hand = [];
  for (let round = 0; round < LIAR_HAND; round += 1) {
    for (const player of state.players) if (player.alive) player.hand.push(deck.pop());
  }
  state.round += 1;
  state.table = TABLE_CARDS[Math.floor(rng() * TABLE_CARDS.length)];
  state.last = null;
  state.turn = state.players[starter].alive ? starter : nextAlive(state, starter);
  state.deadline = now + LIAR_TURN_MS;
  note(state, { type: 'round', round: state.round, table: state.table, starter: state.turn }, now);
}

function finishIfAlone(state, now) {
  const alive = aliveSeats(state);
  if (alive.length === 1) {
    state.winner = alive[0];
    state.deadline = 0;
    note(state, { type: 'win', seat: alive[0], pot: state.pot }, now);
    return true;
  }
  return false;
}

function error(code) {
  const failure = new Error(code);
  failure.code = code;
  return failure;
}

/** The player puts 1–3 cards face down and says they are the table card. */
function liarPlay(state, seat, indexes, rng, now) {
  if (state.winner !== null) throw error('over');
  if (seat !== state.turn) throw error('not-your-turn');
  const player = state.players[seat];
  const picked = [...new Set(indexes)];
  if (picked.length < 1 || picked.length > 3 || picked.length !== indexes.length || picked.some((i) => !Number.isInteger(i) || i < 0 || i >= player.hand.length)) {
    throw error('bad-cards');
  }
  const cards = picked.map((i) => player.hand[i]);
  player.hand = player.hand.filter((_, i) => !picked.includes(i));
  player.idle = 0;
  state.last = { seat, cards, count: cards.length };
  note(state, { type: 'play', seat, count: cards.length }, now);
  state.turn = nextAlive(state, seat);
  state.deadline = now + LIAR_TURN_MS;
  // a player with an empty hand has nothing to play: he has to call the previous player a liar
  if (state.players[state.turn].hand.length === 0) liarCall(state, state.turn, rng, now, true);
}

/** "Лжец!": the last cards are shown; the loser of the dispute pulls the trigger of his own revolver. */
function liarCall(state, seat, rng, now, forced = false) {
  if (state.winner !== null) throw error('over');
  if (seat !== state.turn) throw error('not-your-turn');
  if (!state.last) throw error('nothing-to-call');
  const caller = seat;
  const accused = state.last.seat;
  const cards = state.last.cards;
  const truth = cards.every((card) => card === state.table || card === 'J');
  const loser = truth ? caller : accused;
  state.players[caller].idle = forced ? state.players[caller].idle : 0;
  note(state, { type: 'liar', caller, accused, cards, truth, loser, forced, table: state.table }, now);

  const victim = state.players[loser];
  const fired = victim.pulls === victim.bullet;
  victim.pulls += 1;
  note(state, { type: 'shot', seat: loser, pull: victim.pulls, fired }, now);
  if (fired) {
    victim.alive = false;
    victim.hand = [];
    note(state, { type: 'out', seat: loser, reason: 'shot' }, now);
    if (finishIfAlone(state, now)) return;
  }
  newRound(state, loser, rng, now);
}

/** Leaving a running game: the player is out and his stake stays in the pot. */
function liarForfeit(state, seat, reason, rng, now) {
  const player = state.players[seat];
  if (!player || !player.alive || state.winner !== null) return;
  player.alive = false;
  player.hand = [];
  note(state, { type: 'out', seat, reason }, now);
  if (finishIfAlone(state, now)) return;
  newRound(state, nextAlive(state, seat), rng, now);
}

/** Nobody acts for too long: the game plays the first card for the player, and kicks out those who keep sleeping. */
function liarTimeout(state, rng, now) {
  if (state.winner !== null || !state.deadline || now <= state.deadline) return false;
  const seat = state.turn;
  const player = state.players[seat];
  const skipped = player.idle + 1;
  if (skipped >= LIAR_AFK_LIMIT) {
    liarForfeit(state, seat, 'afk', rng, now);
    return true;
  }
  if (player.hand.length > 0) liarPlay(state, seat, [0], rng, now);
  else liarCall(state, seat, rng, now, true);
  player.idle = skipped; // a move made for the player must not look like his own
  return true;
}

/** What one player may see: his own hand, the others' card counts, revolver wear, the public log. */
function liarView(state, key, now) {
  const me = state.players.findIndex((player) => player.key === key);
  const lastBack = state.last ? { seat: state.last.seat, count: state.last.count } : null;
  return {
    round: state.round,
    stake: state.stake,
    pot: state.pot,
    table: state.winner === null ? state.table : null,
    turn: state.winner === null ? state.turn : null,
    deadline: state.deadline,
    now,
    me,
    hand: me >= 0 ? state.players[me].hand : [],
    last: lastBack,
    winner: state.winner,
    players: state.players.map((player, seat) => ({ name: player.name, seat, alive: player.alive, cards: player.hand.length, pulls: player.pulls, me: seat === me })),
    log: state.log
  };
}

const TANK_TICK_MS = 300;
const TANK_COUNTDOWN = 10; // тактов до начала боя
const TANK_MAX_TICKS = 600; // бой не длиннее трёх минут
const TANK_LIVES = 3;
const TANK_SHIELD = 5; // тактов неуязвимости после возрождения
const BULLET_STEPS = 2; // клеток за такт у снаряда
const TANK_LOG = 30;

const TANK_W = 19;
const TANK_H = 13;

// . пусто · B кирпич (пробивается) · S сталь · W вода (танк не проедет, снаряд пролетит) · G кусты (скрывают танк)
const TANK_MAPS = {
  yard: {
    name: 'Кирпичный двор',
    rows: [
      '...................',
      '.BB.BB..S.S..BB.BB.',
      '.BB.BB.......BB.BB.',
      '...................',
      '.SS..BBB...BBB..SS.',
      '.....B.......B.....',
      '..B..B.GGGGG.B..B..',
      '.....B.......B.....',
      '.SS..BBB...BBB..SS.',
      '...................',
      '.BB.BB.......BB.BB.',
      '.BB.BB..S.S..BB.BB.',
      '...................'
    ]
  },
  maze: {
    name: 'Стальной лабиринт',
    rows: [
      '...................',
      '.S.BBB.S...S.BBB.S.',
      '.S.....S.B.S.....S.',
      '.S.SSS.......SSS.S.',
      '...S...BB.BB...S...',
      'BB.S.BB.....BB.S.BB',
      '...W...........W...',
      'BB.S.BB.....BB.S.BB',
      '...S...BB.BB...S...',
      '.S.SSS.......SSS.S.',
      '.S.....S.B.S.....S.',
      '.S.BBB.S...S.BBB.S.',
      '...................'
    ]
  },
  river: {
    name: 'Река',
    rows: [
      '...................',
      '.BB..GG.....GG..BB.',
      '.BB..GG.B.B.GG..BB.',
      '...................',
      '.S...............S.',
      'WWW..WWWWWWWWW..WWW',
      'WWW..W.......W..WWW',
      'WWW..WWWWWWWWW..WWW',
      '.S...............S.',
      '...................',
      '.BB..GG.B.B.GG..BB.',
      '.BB..GG.....GG..BB.',
      '...................'
    ]
  }
};

// где появляется каждый танк: по углам арены
const TANK_SPAWNS = [
  [0, 0],
  [TANK_W - 1, TANK_H - 1],
  [TANK_W - 1, 0],
  [0, TANK_H - 1]
];

const TANK_DIRS = { U: [0, -1], D: [0, 1], L: [-1, 0], R: [1, 0] };
const isDir = (value) => Object.hasOwn(TANK_DIRS, value);

const tankNote = (state, event) => {
  state.log.push({ tick: state.tick, ...event });
  if (state.log.length > TANK_LOG) state.log.splice(0, state.log.length - TANK_LOG);
};

const tankCell = (state, x, y) => (x < 0 || y < 0 || x >= TANK_W || y >= TANK_H ? '#' : state.grid[y][x]);
const tankAt = (state, x, y) => state.players.findIndex((player) => player.alive && player.x === x && player.y === y);

function tankSetCell(state, x, y, value) {
  const row = state.grid[y];
  state.grid[y] = row.slice(0, x) + value + row.slice(x + 1);
}

/** The nearest free cell to a spawn point (the spawn itself unless a tank sits on it). */
function tankFreeNear(state, [sx, sy]) {
  const seen = new Set([`${sx},${sy}`]);
  const queue = [[sx, sy]];
  while (queue.length) {
    const [x, y] = queue.shift();
    if (['.', 'G'].includes(tankCell(state, x, y)) && tankAt(state, x, y) < 0) return [x, y];
    for (const [dx, dy] of Object.values(TANK_DIRS)) {
      const next = [x + dx, y + dy];
      const mark = `${next[0]},${next[1]}`;
      if (tankCell(state, next[0], next[1]) !== '#' && !seen.has(mark)) {
        seen.add(mark);
        queue.push(next);
      }
    }
  }
  return [sx, sy];
}

function tankStart(players, mapId, stake, now) {
  const map = TANK_MAPS[mapId] ?? TANK_MAPS.yard;
  const state = {
    map: TANK_MAPS[mapId] ? mapId : 'yard',
    mapName: map.name,
    grid: [...map.rows],
    tick: 0,
    nextTick: now + TANK_TICK_MS,
    stake,
    pot: stake * players.length,
    players: players.map((player, seat) => ({
      key: player.key,
      name: player.name,
      x: TANK_SPAWNS[seat][0],
      y: TANK_SPAWNS[seat][1],
      dir: seat === 1 || seat === 2 ? 'L' : 'R',
      alive: true,
      lives: TANK_LIVES,
      kills: 0,
      shield: 0,
      cool: 0,
      cmd: { move: null, fire: null },
      seen: 0 // the stamp of the last input that was carried out
    })),
    bullets: [],
    log: [],
    over: false,
    winners: []
  };
  tankNote(state, { type: 'start' });
  return state;
}

/** The player's wish for the next tick: where to drive and/or where to shoot. A newer wish replaces the older one. */
function tankInput(state, seat, move, fire) {
  const player = state.players[seat];
  if (!player || !player.alive || state.over) return;
  if (isDir(move)) player.cmd.move = move;
  if (isDir(fire)) player.cmd.fire = fire;
}

function tankFinish(state, winners) {
  state.over = true;
  state.winners = winners;
  state.bullets = [];
  tankNote(state, { type: 'over', winners });
}

function tankCheckEnd(state) {
  if (state.over) return;
  const alive = state.players.map((player, seat) => (player.alive ? seat : -1)).filter((seat) => seat >= 0);
  if (alive.length <= 1) tankFinish(state, alive);
}

function tankHit(state, victimSeat, ownerSeat) {
  const victim = state.players[victimSeat];
  victim.lives -= 1;
  const owner = state.players[ownerSeat];
  if (owner && ownerSeat !== victimSeat) owner.kills += 1;
  if (victim.lives <= 0) {
    victim.alive = false;
    tankNote(state, { type: 'dead', victim: victimSeat, owner: ownerSeat });
    tankCheckEnd(state);
    return;
  }
  tankNote(state, { type: 'hit', victim: victimSeat, owner: ownerSeat, lives: victim.lives });
  const [x, y] = tankFreeNear(state, TANK_SPAWNS[victimSeat]);
  victim.x = x;
  victim.y = y;
  victim.shield = TANK_SHIELD;
}

function tankMoveBullets(state) {
  for (let step = 0; step < BULLET_STEPS; step += 1) {
    for (const bullet of [...state.bullets]) {
      if (!state.bullets.includes(bullet)) continue; // already removed in this step
      const [dx, dy] = TANK_DIRS[bullet.dir];
      const x = bullet.x + dx;
      const y = bullet.y + dy;
      const remove = () => {
        state.bullets = state.bullets.filter((item) => item !== bullet);
      };
      const cell = tankCell(state, x, y);
      if (cell === '#' || cell === 'S') {
        remove();
        continue;
      }
      if (cell === 'B') {
        tankSetCell(state, x, y, '.');
        remove();
        continue;
      }
      const other = state.bullets.find((item) => item !== bullet && item.x === x && item.y === y);
      if (other) {
        state.bullets = state.bullets.filter((item) => item !== bullet && item !== other);
        continue;
      }
      const victim = tankAt(state, x, y);
      if (victim >= 0) {
        remove();
        if (state.players[victim].shield <= 0) tankHit(state, victim, bullet.owner);
        if (state.over) return;
        continue;
      }
      bullet.x = x;
      bullet.y = y;
    }
  }
}

/** One tick of the battle. */
function tankStep(state) {
  if (state.over) return;
  state.tick += 1;

  if (state.tick <= TANK_COUNTDOWN) {
    for (const player of state.players) player.cmd = { move: null, fire: null };
    if (state.tick === TANK_COUNTDOWN) tankNote(state, { type: 'go' });
    return;
  }

  const count = state.players.length;
  for (let i = 0; i < count; i += 1) {
    // the order of moves is rotated, so nobody always wins the fight for a cell
    const seat = (i + state.tick) % count;
    const player = state.players[seat];
    if (!player.alive) continue;
    const { move, fire } = player.cmd;
    player.cmd = { move: null, fire: null };
    if (move) {
      player.dir = move;
      const [dx, dy] = TANK_DIRS[move];
      const x = player.x + dx;
      const y = player.y + dy;
      if (['.', 'G'].includes(tankCell(state, x, y)) && tankAt(state, x, y) < 0) {
        player.x = x;
        player.y = y;
      }
    }
    // one shell in the air per tank, like in the original
    if (fire && player.cool <= 0 && !state.bullets.some((bullet) => bullet.owner === seat)) {
      state.bullets.push({ x: player.x, y: player.y, dir: fire, owner: seat });
      player.cool = 1;
    }
  }
  for (const player of state.players) {
    if (player.cool > 0) player.cool -= 1;
    if (player.shield > 0) player.shield -= 1;
  }

  tankMoveBullets(state);
  if (state.over) return;

  if (state.tick >= TANK_MAX_TICKS) {
    // time is up: the most lives win, then the most kills; equal tanks share the pot
    const alive = state.players.map((player, seat) => ({ seat, player })).filter((item) => item.player.alive);
    const best = Math.max(...alive.map((item) => item.player.lives * 100 + item.player.kills));
    tankFinish(state, alive.filter((item) => item.player.lives * 100 + item.player.kills === best).map((item) => item.seat));
  }
}

/** Runs the ticks that are due; `inputs` are the newest wishes as { seat, t, move, fire }. Returns true if anything changed. */
function tankAdvance(state, now, inputs = []) {
  if (state.over || now < state.nextTick) return false;
  let first = true;
  let guard = 0;
  while (!state.over && now >= state.nextTick && guard < 6) {
    if (first) {
      for (const input of inputs) {
        const player = state.players[input.seat];
        if (player && input.t > player.seen) {
          tankInput(state, input.seat, input.move, input.fire);
          player.seen = input.t;
        }
      }
      first = false;
    }
    tankStep(state);
    state.nextTick += TANK_TICK_MS;
    guard += 1;
  }
  if (!state.over && now >= state.nextTick) state.nextTick = now + TANK_TICK_MS; // far behind: do not try to catch up
  return true;
}

function tankForfeit(state, seat) {
  const player = state.players[seat];
  if (!player || !player.alive || state.over) return;
  player.alive = false;
  player.lives = 0;
  tankNote(state, { type: 'left', victim: seat });
  tankCheckEnd(state);
}

/** What one player sees: everything, except enemy tanks hiding in the bushes (unless right next to him). */
function tankView(state, key, now) {
  const me = state.players.findIndex((player) => player.key === key);
  const watcher = me >= 0 && state.players[me].alive ? state.players[me] : null;
  return {
    map: state.map,
    mapName: state.mapName,
    grid: state.grid,
    tick: state.tick,
    countdown: Math.max(0, TANK_COUNTDOWN - state.tick),
    timeLeft: Math.max(0, TANK_MAX_TICKS - state.tick),
    tickMs: TANK_TICK_MS,
    now,
    nextTick: state.nextTick,
    me,
    stake: state.stake,
    pot: state.pot,
    over: state.over,
    winners: state.winners,
    bullets: state.bullets.map((bullet) => ({ x: bullet.x, y: bullet.y, dir: bullet.dir, owner: bullet.owner })),
    players: state.players.map((player, seat) => {
      const base = { seat, name: player.name, alive: player.alive, lives: player.lives, kills: player.kills, me: seat === me };
      if (!player.alive) return base;
      const hidden = watcher && seat !== me && tankCell(state, player.x, player.y) === 'G' && (Math.abs(player.x - watcher.x) > 1 || Math.abs(player.y - watcher.y) > 1);
      return hidden ? { ...base, hidden: true } : { ...base, x: player.x, y: player.y, dir: player.dir, shield: player.shield };
    }),
    log: state.log
  };
}

const ARCADE_TICK_MS = 250;
const ARCADE_COUNTDOWN = 12; // тактов на подготовку
const ARCADE_LOG = 20;
const TRON_MAX_TICKS = 480;
const SNAKE_MAX_TICKS = 480;
const SNAKE_START_LEN = 3;

const ARC_DIRS = { U: [0, -1], D: [0, 1], L: [-1, 0], R: [1, 0] };
const ARC_OPPOSITE = { U: 'D', D: 'U', L: 'R', R: 'L' };

const ARC_W = 28;
const ARC_H = 16;

const arcBlank = () => Array.from({ length: ARC_H }, () => '.'.repeat(ARC_W));

function arcCarve(rows, cells) {
  const grid = rows.map((row) => [...row]);
  for (const [x, y] of cells) if (grid[y]?.[x] !== undefined) grid[y][x] = '#';
  return grid.map((row) => row.join(''));
}

const arcRect = (x0, y0, x1, y1) => {
  const cells = [];
  for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) cells.push([x, y]);
  return cells;
};

/** Seats start in the corners, looking at the middle. */
const ARC_STARTS = [
  { x: 3, y: 3, dir: 'R' },
  { x: ARC_W - 4, y: ARC_H - 4, dir: 'L' },
  { x: ARC_W - 4, y: 3, dir: 'D' },
  { x: 3, y: ARC_H - 4, dir: 'U' }
];

const ARCADE_MAPS = {
  open: { name: 'Пустошь', rows: arcBlank() },
  pillars: {
    name: 'Колонны',
    rows: arcCarve(arcBlank(), [...arcRect(8, 4, 9, 5), ...arcRect(18, 4, 19, 5), ...arcRect(8, 10, 9, 11), ...arcRect(18, 10, 19, 11), ...arcRect(13, 7, 14, 8)])
  },
  cross: {
    name: 'Крест',
    rows: arcCarve(arcBlank(), [...arcRect(12, 3, 15, 4), ...arcRect(12, 11, 15, 12), ...arcRect(6, 7, 9, 8), ...arcRect(18, 7, 21, 8)])
  }
};

const arcNote = (state, event) => {
  state.log.push({ ...event, tick: state.tick });
  if (state.log.length > ARCADE_LOG) state.log.shift();
};

const arcWall = (state, x, y) => x < 0 || y < 0 || x >= ARC_W || y >= ARC_H || state.grid[y][x] === '#';

function arcBase(kind, players, mapId, stake, now) {
  const id = ARCADE_MAPS[mapId] ? mapId : 'open';
  return {
    kind,
    map: id,
    mapName: ARCADE_MAPS[id].name,
    w: ARC_W,
    h: ARC_H,
    grid: [...ARCADE_MAPS[id].rows],
    tick: 0,
    nextTick: now + ARCADE_TICK_MS,
    stake,
    pot: stake * players.length,
    players: players.map((player, seat) => ({
      key: player.key,
      name: player.name,
      alive: true,
      x: ARC_STARTS[seat].x,
      y: ARC_STARTS[seat].y,
      dir: ARC_STARTS[seat].dir,
      want: ARC_STARTS[seat].dir,
      seen: 0
    })),
    log: [],
    over: false,
    winners: []
  };
}

function arcadeStart(kind, players, mapId, stake, now) {
  const state = arcBase(kind, players, mapId, stake, now);
  if (kind === 'tron') {
    state.trail = arcBlank(); // the seat digit where a light wall stands
    state.players.forEach((player, seat) => arcTrail(state, player.x, player.y, String(seat)));
  } else {
    state.snakes = state.players.map((player) => {
      const [dx, dy] = ARC_DIRS[player.dir];
      return Array.from({ length: SNAKE_START_LEN }, (_, i) => [player.x - dx * i, player.y - dy * i]); // head first
    });
    state.food = [];
    state.scores = state.players.map(() => 0);
    for (let i = 0; i < 2 + players.length; i += 1) arcFood(state);
  }
  arcNote(state, { type: 'start' });
  return state;
}

function arcTrail(state, x, y, value) {
  const row = [...state.trail[y]];
  row[x] = value;
  state.trail[y] = row.join('');
}

/** A tiny deterministic generator keeps the state reproducible and free of Math.random in the middle of a tick. */
function arcRand(state) {
  state.seed = (Math.imul(state.seed ?? 1234567 + state.tick * 7919, 1103515245) + 12345) >>> 0;
  return state.seed / 4294967296;
}

function arcOccupied(state, x, y) {
  if (state.grid[y][x] === '#') return true;
  if (state.food.some(([fx, fy]) => fx === x && fy === y)) return true;
  return state.snakes.some((snake, seat) => state.players[seat].alive && snake.some(([sx, sy]) => sx === x && sy === y));
}

function arcFood(state) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const x = Math.floor(arcRand(state) * ARC_W);
    const y = Math.floor(arcRand(state) * ARC_H);
    if (!arcOccupied(state, x, y)) {
      state.food.push([x, y]);
      return;
    }
  }
}

/** The player's wish: a direction (a turn back into oneself is ignored). */
function arcadeInput(state, seat, move) {
  const player = state.players[seat];
  if (!player || !player.alive || state.over || !ARC_DIRS[move]) return;
  if (move !== ARC_OPPOSITE[player.dir]) player.want = move;
}

function arcAlive(state) {
  const alive = state.players.map((player, seat) => (player.alive ? seat : -1)).filter((seat) => seat >= 0);
  return alive;
}

function arcFinish(state, winners) {
  state.over = true;
  state.winners = winners;
  arcNote(state, { type: 'over', winners });
}

function arcKill(state, seat, reason) {
  const player = state.players[seat];
  if (!player.alive) return;
  player.alive = false;
  arcNote(state, { type: 'crash', seat, reason });
  if (state.kind === 'tron') {
    // a dead cycle's wall vanishes, so the arena does not clog up
    state.trail = state.trail.map((row) => [...row].map((ch) => (ch === String(seat) ? '.' : ch)).join(''));
  }
}

function arcJudge(state, diedNow) {
  const alive = arcAlive(state);
  if (alive.length === 1) arcFinish(state, alive);
  else if (alive.length === 0) arcFinish(state, diedNow); // everyone fell in the same tick: a draw
  else if (state.tick - ARCADE_COUNTDOWN >= (state.kind === 'tron' ? TRON_MAX_TICKS : SNAKE_MAX_TICKS)) {
    if (state.kind === 'tron') arcFinish(state, alive);
    else {
      const best = Math.max(...alive.map((seat) => state.snakes[seat].length));
      arcFinish(state, alive.filter((seat) => state.snakes[seat].length === best));
    }
  }
}

/** One tick of the match. */
function arcadeStep(state) {
  if (state.over) return;
  state.tick += 1;
  if (state.tick <= ARCADE_COUNTDOWN) {
    for (const player of state.players) player.dir = player.want;
    if (state.tick === ARCADE_COUNTDOWN) arcNote(state, { type: 'go' });
    return;
  }

  const heads = state.players.map((player) => {
    if (!player.alive) return null;
    player.dir = player.want;
    const [dx, dy] = ARC_DIRS[player.dir];
    return [player.x + dx, player.y + dy];
  });
  const dead = new Map(); // seat -> reason

  if (state.kind === 'tron') {
    heads.forEach((head, seat) => {
      if (!head) return;
      const [x, y] = head;
      if (arcWall(state, x, y)) dead.set(seat, 'wall');
      else if (state.trail[y][x] !== '.') dead.set(seat, 'trail');
    });
  } else {
    const eats = heads.map((head) => head && state.food.some(([fx, fy]) => fx === head[0] && fy === head[1]));
    const solid = new Set();
    state.snakes.forEach((snake, seat) => {
      if (!state.players[seat].alive) return;
      snake.forEach(([sx, sy], i) => {
        if (i === snake.length - 1 && !eats[seat]) return; // the tail moves away
        solid.add(`${sx},${sy}`);
      });
    });
    heads.forEach((head, seat) => {
      if (!head) return;
      if (arcWall(state, head[0], head[1])) dead.set(seat, 'wall');
      else if (solid.has(`${head[0]},${head[1]}`)) dead.set(seat, 'body');
    });
    state.eats = eats;
  }

  // two heads in one cell, or two cycles swapping places: both are lost
  heads.forEach((head, a) => {
    if (!head) return;
    heads.forEach((other, b) => {
      if (a >= b || !other) return;
      const same = head[0] === other[0] && head[1] === other[1];
      const swap = head[0] === state.players[b].x && head[1] === state.players[b].y && other[0] === state.players[a].x && other[1] === state.players[a].y;
      if (same || swap) {
        dead.set(a, 'head');
        dead.set(b, 'head');
      }
    });
  });

  heads.forEach((head, seat) => {
    if (!head || dead.has(seat)) return;
    const player = state.players[seat];
    player.x = head[0];
    player.y = head[1];
    if (state.kind === 'tron') arcTrail(state, head[0], head[1], String(seat));
    else {
      const snake = state.snakes[seat];
      snake.unshift([head[0], head[1]]);
      if (state.eats[seat]) {
        state.food = state.food.filter(([fx, fy]) => fx !== head[0] || fy !== head[1]);
        state.scores[seat] += 1;
        arcFood(state);
      } else snake.pop();
    }
  });
  delete state.eats;
  for (const [seat, reason] of dead) arcKill(state, seat, reason);
  arcJudge(state, [...dead.keys()]);
}

/** Runs the ticks that are due. Steering wishes arrive as inputs [{seat, t, move}]. */
function arcadeAdvance(state, now, inputs = []) {
  if (state.over || now < state.nextTick) return false;
  let first = true;
  let guard = 0;
  while (!state.over && now >= state.nextTick && guard < 6) {
    if (first) {
      for (const input of inputs) {
        const player = state.players[input.seat];
        if (player && input.t > player.seen) {
          arcadeInput(state, input.seat, input.move);
          player.seen = input.t;
        }
      }
      first = false;
    }
    arcadeStep(state);
    state.nextTick += ARCADE_TICK_MS;
    guard += 1;
  }
  if (!state.over && now >= state.nextTick) state.nextTick = now + ARCADE_TICK_MS;
  return true;
}

function arcadeForfeit(state, seat) {
  const player = state.players[seat];
  if (!player || !player.alive || state.over) return;
  arcKill(state, seat, 'left');
  if (state.kind === 'snake') state.snakes[seat] = [];
  arcJudge(state, []);
}

function arcadeView(state, key, now) {
  const base = {
    kind: state.kind,
    map: state.map,
    mapName: state.mapName,
    w: state.w,
    h: state.h,
    grid: state.grid,
    tick: state.tick,
    countdown: Math.max(0, ARCADE_COUNTDOWN - state.tick),
    timeLeft: Math.max(0, (state.kind === 'tron' ? TRON_MAX_TICKS : SNAKE_MAX_TICKS) - Math.max(0, state.tick - ARCADE_COUNTDOWN)),
    tickMs: ARCADE_TICK_MS,
    now,
    nextTick: state.nextTick,
    me: state.players.findIndex((player) => player.key === key),
    stake: state.stake,
    pot: state.pot,
    over: state.over,
    winners: state.winners,
    players: state.players.map((player, seat) => ({
      seat,
      name: player.name,
      alive: player.alive,
      me: player.key === key,
      x: player.x,
      y: player.y,
      dir: player.dir,
      ...(state.kind === 'snake' ? { len: state.snakes[seat].length, score: state.scores[seat] } : {})
    })),
    log: state.log
  };
  if (state.kind === 'tron') return { ...base, trail: state.trail };
  return { ...base, snakes: state.snakes, food: state.food };
}

/**
 * API ролевой консоли АнКо (Cloudflare Worker + база D1).
 * Хранит сотрудников, сессии и журнал обращений. Пароли хешируются здесь (PBKDF2),
 * уровень допуска и коды проверяются здесь же — браузеру доверять нельзя.
 */


const NAME_RULE = /^[\p{L}\p{N}_-]{2,24}$/u;
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const PBKDF2_ITERATIONS = 100000;
const MAX_FAILS = 5;
const LOCK_MS = 60 * 1000;
const KEEP_ATTEMPTS = 200;
const SHOW_ATTEMPTS = 20;
const MAX_BODY = 4096;
const MAIL_SUBJECT = 60;
const MAIL_TEXT = 1000;
const MAIL_INBOX = 100; // older letters are dropped beyond this
const MAIL_PER_HOUR = 20;
const ADDUSER_PER_DAY = 2;

class ApiError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

/* ---------- helpers ---------- */

const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

function randomHex(length) {
  return hex(crypto.getRandomValues(new Uint8Array(length)));
}

async function sha256(text) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

// readable password without look-alike characters (no 0/O, 1/l/I)
function generatePassword(length = 10) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: PBKDF2_ITERATIONS },
    key,
    256
  );
  return hex(bits);
}

function sameText(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const userKey = (name) => name.trim().toLowerCase();

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') ?? '';
  const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  const ok = allowed.includes(origin) || (local && env.ALLOW_LOCALHOST === 'true');

  return {
    ...(ok ? { 'Access-Control-Allow-Origin': origin } : {}),
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400'
  };
}

function reply(request, env, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...corsHeaders(request, env) }
  });
}

async function readBody(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) throw new ApiError(413, 'too-large');
  try {
    const body = JSON.parse(text || '{}');
    return body && typeof body === 'object' ? body : {};
  } catch {
    throw new ApiError(400, 'bad-json');
  }
}

/* ---------- data access ---------- */

async function publicUser(env, row) {
  const unread = await env.DB.prepare('SELECT COUNT(*) AS n FROM mail WHERE to_key = ? AND is_read = 0').bind(row.key).first();
  const { results } = await env.DB.prepare('SELECT t, action, target FROM attempts WHERE user_key = ? ORDER BY id DESC LIMIT ?')
    .bind(row.key, SHOW_ATTEMPTS)
    .all();

  return {
    name: row.name,
    realName: row.real_name,
    department: row.department,
    baseLevel: row.base_level,
    level: row.level,
    codes: JSON.parse(row.codes),
    attempts: results.reverse().map((item) => ({ t: item.t, action: item.action, ...(item.target ? { target: item.target } : {}) })),
    stats: { snake: row.snake, hacks: row.hacks },
    registered: row.registered,
    unread: unread?.n ?? 0
  };
}

async function startSession(env, row) {
  const token = randomHex(32);
  const now = Date.now();
  await env.DB.prepare('DELETE FROM sessions WHERE expires < ?').bind(now).run();
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_key, expires) VALUES (?, ?, ?)')
    .bind(await sha256(token), row.key, now + SESSION_MS)
    .run();
  return token;
}

async function authenticate(request, env) {
  const header = request.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw new ApiError(401, 'unauthorized');

  const session = await env.DB.prepare('SELECT user_key, expires FROM sessions WHERE token_hash = ?')
    .bind(await sha256(token))
    .first();
  if (!session || session.expires < Date.now()) throw new ApiError(401, 'unauthorized');

  const row = await env.DB.prepare('SELECT * FROM users WHERE key = ?').bind(session.user_key).first();
  if (!row) throw new ApiError(401, 'unauthorized');
  return { row, tokenHash: await sha256(token) };
}

/* ---------- admin helpers ---------- */

/** Real (out-of-game) name: 2–60 letters, digits, spaces and . , ' -. Null when invalid. */
function cleanRealName(value) {
  const name = String(value ?? '').replace(/\s+/g, ' ').trim();
  return name.length >= 2 && name.length <= 60 && /^[\p{L}\p{N} .,'-]+$/u.test(name) ? name : null;
}

/** The department is written in by hand: 2–60 characters, no control characters. Null when invalid. */
function resolveDepartment(body) {
  const name = String(body.customDepartment ?? '').replace(/\s+/g, ' ').trim();
  // eslint-disable-next-line no-control-regex
  if (name.length < 2 || name.length > 60 || /[\x00-\x1f\x7f]/.test(name)) return null;
  return { name, level: 1 };
}

function requireAdmin(row) {
  if (row.level < ADMIN_LEVEL) throw new ApiError(403, 'forbidden');
}

/** Whole number 0..MAX_LEVEL, or the fallback when none was given; null when it is not valid. */
function parseLevel(value, fallback) {
  if (value === undefined || value === null || value === '') return Number.isInteger(fallback) ? fallback : null;
  const level = Number(value);
  return Number.isInteger(level) && level >= 0 && level <= MAX_LEVEL ? level : null;
}

function mailFields(body) {
  const subject = String(body.subject ?? '').trim().slice(0, MAIL_SUBJECT);
  const text = String(body.body ?? '').trim();
  if (!subject) throw new ApiError(400, 'bad-subject');
  if (!text || text.length > MAIL_TEXT) throw new ApiError(400, 'bad-text');
  return { subject, text };
}

async function deliver(env, toKey, from, subject, text) {
  await env.DB.prepare('INSERT INTO mail (to_key, from_name, subject, body, t) VALUES (?, ?, ?, ?, ?)')
    .bind(toKey, from, subject, text, Date.now())
    .run();
  await env.DB.prepare('DELETE FROM mail WHERE to_key = ? AND id NOT IN (SELECT id FROM mail WHERE to_key = ? ORDER BY id DESC LIMIT ?)')
    .bind(toKey, toKey, MAIL_INBOX)
    .run();
}

/** The employee an admin wants to manage: must exist, not be the admin, and rank below them. */
async function manageable(env, actor, name) {
  const key = userKey(String(name ?? ''));
  const target = key ? await env.DB.prepare('SELECT * FROM users WHERE key = ?').bind(key).first() : null;
  if (!target) throw new ApiError(404, 'not-found');
  if (target.key === actor.key) throw new ApiError(403, 'self');
  if (target.level >= actor.level) throw new ApiError(403, 'above');
  return target;
}

/* ---------- routes ---------- */

/** Open registration is closed: only the very first account can be created this way (it becomes an administrator). */
async function register(request, env) {
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
  if (count.n > 0) throw new ApiError(403, 'closed');

  const body = await readBody(request);
  const name = String(body.name ?? '').trim();
  const password = String(body.password ?? '');
  const department = resolveDepartment(body);
  const realName = body.realName ? cleanRealName(body.realName) : '';

  if (!NAME_RULE.test(name)) throw new ApiError(400, 'bad-name');
  if (password.length < 4 || password.length > 100) throw new ApiError(400, 'bad-password');
  if (!department) throw new ApiError(400, 'bad-department');
  if (realName === null) throw new ApiError(400, 'bad-realname');

  const key = userKey(name);
  const salt = randomHex(16);
  await env.DB.prepare(
    'INSERT INTO users (key, name, real_name, department, salt, hash, base_level, level, registered) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )
    .bind(key, name, realName, department.name, salt, await hashPassword(password, salt), ADMIN_LEVEL, ADMIN_LEVEL, Date.now())
    .run();

  const row = await env.DB.prepare('SELECT * FROM users WHERE key = ?').bind(key).first();
  return { token: await startSession(env, row), user: await publicUser(env, row) };
}

async function login(request, env) {
  const body = await readBody(request);
  const key = userKey(String(body.name ?? ''));
  const password = String(body.password ?? '');
  const row = key ? await env.DB.prepare('SELECT * FROM users WHERE key = ?').bind(key).first() : null;

  if (!row) {
    await hashPassword(password, 'no-such-user'); // keep the timing similar
    throw new ApiError(401, 'credentials');
  }

  if (row.locked_until > Date.now()) throw new ApiError(429, 'rate');

  if (!sameText(await hashPassword(password, row.salt), row.hash)) {
    const fails = row.fails + 1;
    const lock = fails >= MAX_FAILS ? Date.now() + LOCK_MS : 0;
    await env.DB.prepare('UPDATE users SET fails = ?, locked_until = ? WHERE key = ?')
      .bind(lock ? 0 : fails, lock, key)
      .run();
    throw new ApiError(lock ? 429 : 401, lock ? 'rate' : 'credentials');
  }

  await env.DB.prepare('UPDATE users SET fails = 0, locked_until = 0 WHERE key = ?').bind(key).run();
  return { token: await startSession(env, row), user: await publicUser(env, row) };
}

async function addAttempt(env, key, action, target) {
  await env.DB.prepare('INSERT INTO attempts (user_key, t, action, target) VALUES (?, ?, ?, ?)')
    .bind(key, Date.now(), action, target || null)
    .run();
  await env.DB.prepare(
    'DELETE FROM attempts WHERE user_key = ? AND id NOT IN (SELECT id FROM attempts WHERE user_key = ? ORDER BY id DESC LIMIT ?)'
  )
    .bind(key, key, KEEP_ATTEMPTS)
    .run();
}

/* ---------- economy: wallet, market, casino ---------- */

let economyReady = false;

// the tables are created on first use, so the economy needs no manual database migration
async function ensureEconomy(env) {
  if (economyReady) return;
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS solo_claims (user_key TEXT PRIMARY KEY, t INTEGER NOT NULL)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS wallets (user_key TEXT PRIMARY KEY, balance INTEGER NOT NULL, dole_at INTEGER NOT NULL DEFAULT 0)'),
    env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS holdings (user_key TEXT NOT NULL, asset TEXT NOT NULL, qty INTEGER NOT NULL, cost INTEGER NOT NULL, PRIMARY KEY (user_key, asset))'
    ),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS demand (id INTEGER PRIMARY KEY AUTOINCREMENT, asset TEXT NOT NULL, t INTEGER NOT NULL, impact REAL NOT NULL)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS trades (id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, name TEXT NOT NULL, asset TEXT NOT NULL, side TEXT NOT NULL, qty INTEGER NOT NULL, price REAL NOT NULL, pct REAL NOT NULL)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS market_edits (asset TEXT PRIMARY KEY, base REAL, vol REAL, hidden INTEGER NOT NULL DEFAULT 0)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS custom_assets (id TEXT PRIMARY KEY, name TEXT NOT NULL, grp TEXT NOT NULL, kind TEXT NOT NULL, base REAL NOT NULL, vol REAL NOT NULL)'),
    env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS liar_lobbies (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_key TEXT NOT NULL, owner_name TEXT NOT NULL, stake INTEGER NOT NULL, max INTEGER NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL, ended INTEGER NOT NULL DEFAULT 0, rev INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT \'{}\')'
    ),
    env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS tank_lobbies (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_key TEXT NOT NULL, owner_name TEXT NOT NULL, stake INTEGER NOT NULL, max INTEGER NOT NULL, map TEXT NOT NULL, kind TEXT NOT NULL DEFAULT \'tank\', status TEXT NOT NULL, created INTEGER NOT NULL, ended INTEGER NOT NULL DEFAULT 0, rev INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT \'{}\')'
    ),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS tank_players (lobby INTEGER NOT NULL, user_key TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (lobby, user_key))'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS tank_inputs (lobby INTEGER NOT NULL, user_key TEXT NOT NULL, t INTEGER NOT NULL, move TEXT, fire TEXT, PRIMARY KEY (lobby, user_key))'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS liar_players (lobby INTEGER NOT NULL, user_key TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (lobby, user_key))'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS crash_rounds (id INTEGER PRIMARY KEY AUTOINCREMENT, bet_until INTEGER NOT NULL, start INTEGER NOT NULL, crash REAL NOT NULL)'),
    env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS crash_bets (id INTEGER PRIMARY KEY AUTOINCREMENT, round INTEGER NOT NULL, user_key TEXT NOT NULL, name TEXT NOT NULL, bet INTEGER NOT NULL, cashed REAL, payout INTEGER NOT NULL DEFAULT 0, UNIQUE (round, user_key))'
    )
  ]);
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS demand_asset ON demand (asset, t)').run();
  try {
    await env.DB.prepare('ALTER TABLE tank_lobbies ADD COLUMN kind TEXT NOT NULL DEFAULT \'tank\'').run(); // lobbies made before «Трон» and «Змейка»
  } catch {
    // the column is already there
  }
  economyReady = true;
}

const seedOf = (env) => String(env.MARKET_SEED ?? 'anrox-market');

async function balanceOf(env, key) {
  await ensureEconomy(env);
  await env.DB.prepare('INSERT OR IGNORE INTO wallets (user_key, balance) VALUES (?, ?)').bind(key, START_BALANCE).run();
  return (await env.DB.prepare('SELECT balance FROM wallets WHERE user_key = ?').bind(key).first()).balance;
}

async function holdingsOf(env, key) {
  const { results } = await env.DB.prepare('SELECT asset, qty, cost FROM holdings WHERE user_key = ? AND qty > 0 ORDER BY asset').bind(key).all();
  return results.map((item) => ({ asset: item.asset, qty: item.qty, cost: item.cost }));
}

// money is taken in one conditional statement, so two parallel requests cannot spend the same crypto-ends twice
async function takeMoney(env, key, amount) {
  const result = await env.DB.prepare('UPDATE wallets SET balance = balance - ? WHERE user_key = ? AND balance >= ?').bind(amount, key, amount).run();
  if (!result.meta.changes) throw new ApiError(402, 'funds');
}

async function giveMoney(env, key, amount) {
  if (amount > 0) await env.DB.prepare('UPDATE wallets SET balance = balance + ? WHERE user_key = ?').bind(amount, key).run();
}

function betOf(body) {
  const bet = Math.floor(Number(body.bet));
  if (!Number.isFinite(bet) || bet < 1 || bet > MAX_BET) throw new ApiError(400, 'bad-bet');
  return bet;
}

/** The shared "Взлёт" round: a player launches it, everybody has a minute to bet, then it flies. */
async function latestCrash(env) {
  await ensureEconomy(env);
  return env.DB.prepare('SELECT id, bet_until, start, crash FROM crash_rounds ORDER BY id DESC LIMIT 1').first();
}

const crashOver = (round, now) => now >= round.start + crashDurationMs(round.crash) + CRASH_RESULT_MS;

function crashPhase(round, now) {
  if (!round || crashOver(round, now)) return 'idle';
  if (now < round.start) return 'betting';
  const low = crashMultiplier(Math.max(0, now - round.start - CRASH_GRACE_MS));
  return low >= round.crash ? 'crashed' : 'flying';
}

async function crashState(env, row, now) {
  const round = await latestCrash(env);
  const phase = crashPhase(round, now);
  const live = phase !== 'idle';
  const { results: bets } = live
    ? await env.DB.prepare('SELECT name, user_key, bet, cashed, payout FROM crash_bets WHERE round = ? ORDER BY id').bind(round.id).all()
    : { results: [] };
  // the finished rounds, newest first (the round that just ended counts once its result is gone)
  const { results: past } = await env.DB.prepare('SELECT crash FROM crash_rounds WHERE id < ? ORDER BY id DESC LIMIT 14')
    .bind(live ? round.id : (round?.id ?? 0) + 1)
    .all();
  return {
    round: round?.id ?? 0,
    phase,
    now,
    start: round?.start ?? 0,
    betUntil: round?.bet_until ?? 0,
    window: CRASH_BET_WINDOW_MS,
    ...(phase === 'crashed' ? { at: round.crash } : {}),
    // the top level sees where the plane will fall
    ...(live && row.level >= MARKET_ADMIN_LEVEL ? { peek: round.crash } : {}),
    history: past.map((item) => item.crash),
    bets: bets.map((item) => ({ name: item.name, bet: item.bet, cashed: item.cashed, payout: item.payout, me: item.user_key === row.key })),
    balance: await balanceOf(env, row.key)
  };
}

async function placeCrashBet(env, row, round, bet) {
  const placed = await env.DB.prepare('SELECT 1 AS x FROM crash_bets WHERE round = ? AND user_key = ?').bind(round.id, row.key).first();
  if (placed) throw new ApiError(409, 'placed');
  await takeMoney(env, row.key, bet);
  await env.DB.prepare('INSERT INTO crash_bets (round, user_key, name, bet) VALUES (?, ?, ?, ?)').bind(round.id, row.key, row.name, bet).run();
}

async function wipeEconomy(env, key) {
  try {
    await ensureEconomy(env);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM wallets WHERE user_key = ?').bind(key),
      env.DB.prepare('DELETE FROM holdings WHERE user_key = ?').bind(key),
      env.DB.prepare('DELETE FROM crash_bets WHERE user_key = ?').bind(key),
      env.DB.prepare('DELETE FROM liar_players WHERE user_key = ?').bind(key),
      env.DB.prepare('DELETE FROM tank_players WHERE user_key = ?').bind(key)
    ]);
  } catch {
    // the economy was never used
  }
}

// a company that left the exchange is bought back at the price the player paid for it
async function refundRetired(env, key) {
  const assets = await assetsOf(env);
  const held = await holdingsOf(env, key);
  const gone = held.filter((item) => !assets.some((asset) => asset.id === item.asset));
  if (!gone.length) return 0;
  const refund = gone.reduce((sum, item) => sum + item.cost, 0);
  await env.DB.prepare(`DELETE FROM holdings WHERE user_key = ? AND asset IN (${gone.map(() => '?').join(',')})`)
    .bind(key, ...gone.map((item) => item.asset))
    .run();
  await giveMoney(env, key, refund);
  return refund;
}

// recent trades of everyone: they are what moves the prices (older ones have faded away)
async function loadDemand(env, now) {
  await ensureEconomy(env);
  const { results } = await env.DB.prepare('SELECT asset, t, impact FROM demand WHERE t > ?').bind(now - 12 * DEMAND_HALF_MS).all();
  const byAsset = {};
  for (const item of results) (byAsset[item.asset] ??= []).push({ t: item.t, impact: item.impact });
  return byAsset;
}

// the companies on the exchange: the built-in ones with the market editor's changes, plus the ones it added
async function assetsOf(env) {
  await ensureEconomy(env);
  const { results: edits } = await env.DB.prepare('SELECT asset, base, vol, hidden FROM market_edits').all();
  const { results: custom } = await env.DB.prepare('SELECT id, name, grp, kind, base, vol FROM custom_assets ORDER BY rowid').all();
  const changed = new Map(edits.map((item) => [item.asset, item]));
  const builtin = ASSETS.filter((asset) => !changed.get(asset.id)?.hidden).map((asset) => {
    const edit = changed.get(asset.id);
    return { ...asset, base: edit?.base ?? asset.base, vol: edit?.vol ?? asset.vol };
  });
  const added = custom.map((item) => ({ id: item.id, name: item.name, group: item.grp, kind: item.kind, base: item.base, vol: item.vol, noise: Math.min(0.06, item.vol * 0.07) }));
  return [...builtin, ...added];
}

async function recentTrades(env) {
  await ensureEconomy(env);
  const { results } = await env.DB.prepare('SELECT t, name, asset, side, qty, price, pct FROM trades ORDER BY id DESC LIMIT 40').all();
  return results;
}

async function economyState(env, key) {
  await balanceOf(env, key);
  const refunded = await refundRetired(env, key);
  return { balance: await balanceOf(env, key), holdings: await holdingsOf(env, key), ...(refunded ? { refunded } : {}) };
}

/* ---------- «Колода лжеца»: lobbies, stakes and the game itself ---------- */

const LIAR_OPEN_MS = 20 * 60 * 1000; // an open lobby nobody starts is closed and the stakes are returned
const LIAR_RESULT_MS = 120 * 1000; // how long the players still see the finished game

async function liarPlayersOf(env, id) {
  const { results } = await env.DB.prepare('SELECT user_key, name FROM liar_players WHERE lobby = ? ORDER BY rowid').bind(id).all();
  return results;
}

// the lobby a player is sitting in: waiting, playing, or just finished
async function liarMine(env, key, now) {
  await ensureEconomy(env);
  return env.DB.prepare(
    'SELECT l.* FROM liar_lobbies l JOIN liar_players p ON p.lobby = l.id WHERE p.user_key = ? AND (l.status IN (\'open\', \'playing\') OR (l.status = \'done\' AND l.ended > ?)) ORDER BY l.id DESC LIMIT 1'
  )
    .bind(key, now - LIAR_RESULT_MS)
    .first();
}

// a lobby that did not start: everybody gets the stake back
async function liarCancel(env, lobby, now) {
  const closed = await env.DB.prepare('UPDATE liar_lobbies SET status = \'closed\', ended = ? WHERE id = ? AND status = \'open\'').bind(now, lobby.id).run();
  if (!closed.meta.changes) return;
  for (const player of await liarPlayersOf(env, lobby.id)) await giveMoney(env, player.user_key, lobby.stake);
  await env.DB.prepare('DELETE FROM liar_players WHERE lobby = ?').bind(lobby.id).run();
}

const liarFail = (error) => (error instanceof ApiError || !error.code ? error : new ApiError(409, error.code));

/** Changes the game state of a running lobby; two players acting at once cannot overwrite each other (retry on a clash). */
async function liarMutate(env, id, now, change) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const row = await env.DB.prepare('SELECT * FROM liar_lobbies WHERE id = ?').bind(id).first();
    if (!row || row.status !== 'playing') return null;
    const state = JSON.parse(row.state);
    let changed;
    try {
      changed = change(state, row);
    } catch (error) {
      throw liarFail(error);
    }
    if (changed === false) return { row, state };
    const done = state.winner !== null;
    const saved = await env.DB.prepare('UPDATE liar_lobbies SET state = ?, rev = rev + 1, status = ?, ended = ? WHERE id = ? AND rev = ?')
      .bind(JSON.stringify(state), done ? 'done' : 'playing', done ? now : 0, id, row.rev)
      .run();
    if (saved.meta.changes) {
      // the winner takes the whole pot: his own stake and the stakes of everybody who was shot or left
      if (done) await giveMoney(env, state.players[state.winner].key, state.pot);
      return { row: { ...row, status: done ? 'done' : 'playing' }, state };
    }
  }
  throw new ApiError(409, 'busy');
}

// a player who does not move for too long is moved for (see liarTimeout)
async function liarSettle(env, row, now) {
  if (row.status !== 'playing') return;
  const state = JSON.parse(row.state);
  if (!state.deadline || now <= state.deadline) return;
  await liarMutate(env, row.id, now, (current) => {
    let any = false;
    for (let guard = 0; guard < 8 && liarTimeout(current, randomFloat, now); guard += 1) any = true;
    return any;
  });
}

async function liarSnapshot(env, row, key, now) {
  const balance = await balanceOf(env, key);
  if (!row) return { lobby: null, balance };
  const fresh = await env.DB.prepare('SELECT * FROM liar_lobbies WHERE id = ?').bind(row.id).first();
  if (fresh.status === 'open') {
    const players = await liarPlayersOf(env, fresh.id);
    return {
      balance,
      lobby: {
        id: fresh.id,
        status: 'open',
        stake: fresh.stake,
        max: fresh.max,
        owner: fresh.owner_name,
        mine: fresh.owner_key === key,
        players: players.map((player) => ({ name: player.name, me: player.user_key === key })),
        now
      }
    };
  }
  return { balance, lobby: { id: fresh.id, status: fresh.status, max: fresh.max, owner: fresh.owner_name, ...liarView(JSON.parse(fresh.state), key, now) } };
}

async function liarRoute(game, env, row, body, now) {
  const key = row.key;

  if (game === 'liar/list') {
    const { results: stale } = await env.DB.prepare('SELECT * FROM liar_lobbies WHERE status = \'open\' AND created < ?').bind(now - LIAR_OPEN_MS).all();
    for (const lobby of stale) await liarCancel(env, lobby, now);
    const { results: open } = await env.DB.prepare('SELECT id, owner_name, stake, max FROM liar_lobbies WHERE status = \'open\' ORDER BY id DESC LIMIT 20').all();
    const lobbies = [];
    for (const lobby of open) lobbies.push({ id: lobby.id, owner: lobby.owner_name, stake: lobby.stake, max: lobby.max, players: (await liarPlayersOf(env, lobby.id)).map((player) => player.name) });
    const mine = await liarMine(env, key, now);
    return { lobbies, mine: mine ? mine.id : null, balance: await balanceOf(env, key) };
  }

  if (game === 'liar/state') {
    let mine = await liarMine(env, key, now);
    if (mine) {
      await liarSettle(env, mine, now);
      mine = await liarMine(env, key, now);
    }
    return liarSnapshot(env, mine, key, now);
  }

  if (game === 'liar/create') {
    const stake = Math.floor(Number(body.stake));
    const max = Math.floor(Number(body.max ?? 4));
    if (!Number.isFinite(stake) || stake < 10 || stake > MAX_BET || !(max >= 2 && max <= 4)) throw new ApiError(400, 'bad-bet');
    await balanceOf(env, key);
    const active = await liarMine(env, key, now);
    if (active && active.status !== 'done') throw new ApiError(409, 'in-lobby');
    await takeMoney(env, key, stake);
    const created = await env.DB.prepare('INSERT INTO liar_lobbies (owner_key, owner_name, stake, max, status, created) VALUES (?, ?, ?, ?, \'open\', ?)').bind(key, row.name, stake, max, now).run();
    if (!created.meta.changes) {
      await giveMoney(env, key, stake);
      throw new ApiError(500, 'server');
    }
    const lobby = await env.DB.prepare('SELECT id FROM liar_lobbies WHERE owner_key = ? ORDER BY id DESC LIMIT 1').bind(key).first();
    await env.DB.prepare('INSERT INTO liar_players (lobby, user_key, name) VALUES (?, ?, ?)').bind(lobby.id, key, row.name).run();
    return liarSnapshot(env, await liarMine(env, key, now), key, now);
  }

  if (game === 'liar/join') {
    const id = Math.floor(Number(body.id));
    const lobby = await env.DB.prepare('SELECT * FROM liar_lobbies WHERE id = ? AND status = \'open\'').bind(id).first();
    if (!lobby) throw new ApiError(404, 'no-lobby');
    await balanceOf(env, key);
    const active = await liarMine(env, key, now);
    if (active && active.status !== 'done') throw new ApiError(409, 'in-lobby');
    await takeMoney(env, key, lobby.stake);
    // the seat is taken only while the lobby is still open and has room
    const seated = await env.DB.prepare(
      'INSERT INTO liar_players (lobby, user_key, name) SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM liar_players WHERE lobby = ?) < (SELECT max FROM liar_lobbies WHERE id = ? AND status = \'open\')'
    )
      .bind(id, key, row.name, id, id)
      .run();
    if (!seated.meta.changes) {
      await giveMoney(env, key, lobby.stake);
      throw new ApiError(409, 'full');
    }
    return liarSnapshot(env, await liarMine(env, key, now), key, now);
  }

  if (game === 'liar/leave') {
    const mine = await liarMine(env, key, now);
    if (!mine) return { lobby: null, balance: await balanceOf(env, key) };
    if (mine.status === 'open') {
      if (mine.owner_key === key) {
        await liarCancel(env, mine, now);
      } else {
        const left = await env.DB.prepare('DELETE FROM liar_players WHERE lobby = ? AND user_key = ?').bind(mine.id, key).run();
        if (left.meta.changes) await giveMoney(env, key, mine.stake);
      }
    } else if (mine.status === 'playing') {
      // leaving a running game: the player is out and his stake stays in the pot
      await liarMutate(env, mine.id, now, (state) => {
        const seat = state.players.findIndex((player) => player.key === key);
        liarForfeit(state, seat, 'left', randomFloat, now);
      });
      await env.DB.prepare('DELETE FROM liar_players WHERE lobby = ? AND user_key = ?').bind(mine.id, key).run();
    } else {
      await env.DB.prepare('DELETE FROM liar_players WHERE lobby = ? AND user_key = ?').bind(mine.id, key).run();
    }
    return { lobby: null, balance: await balanceOf(env, key) };
  }

  const mine = await liarMine(env, key, now);
  if (!mine) throw new ApiError(409, 'no-lobby');

  if (game === 'liar/start') {
    if (mine.status !== 'open') throw new ApiError(409, 'started');
    if (mine.owner_key !== key) throw new ApiError(403, 'forbidden');
    const players = await liarPlayersOf(env, mine.id);
    if (players.length < 2) throw new ApiError(409, 'few-players');
    const state = liarStart(players.map((player) => ({ key: player.user_key, name: player.name })), mine.stake, randomFloat, now);
    const started = await env.DB.prepare('UPDATE liar_lobbies SET status = \'playing\', state = ?, rev = rev + 1 WHERE id = ? AND status = \'open\'').bind(JSON.stringify(state), mine.id).run();
    if (!started.meta.changes) throw new ApiError(409, 'started');
    return liarSnapshot(env, mine, key, now);
  }

  if (game === 'liar/play' || game === 'liar/call') {
    if (mine.status !== 'playing') throw new ApiError(409, 'over');
    await liarSettle(env, mine, now);
    const cards = Array.isArray(body.cards) ? body.cards.map(Number) : [];
    const result = await liarMutate(env, mine.id, now, (state) => {
      const seat = state.players.findIndex((player) => player.key === key);
      if (seat < 0 || !state.players[seat].alive) throw new ApiError(409, 'not-your-turn');
      if (game === 'liar/play') liarPlay(state, seat, cards, randomFloat, now);
      else liarCall(state, seat, randomFloat, now);
    });
    if (!result) throw new ApiError(409, 'over');
    return liarSnapshot(env, await liarMine(env, key, now), key, now);
  }

  throw new ApiError(404, 'not-found');
}

/* ---------- «Танчики»: lobbies, stakes and the battle ---------- */

// «Танчики», «Трон» and «Змейка» share one kind of lobby: same tables, same stakes, a different battle inside
const ARENAS = {
  tank: { maps: TANK_MAPS, start: tankStart, advance: tankAdvance, forfeit: tankForfeit, view: tankView },
  tron: { maps: ARCADE_MAPS, start: (...args) => arcadeStart('tron', ...args), advance: arcadeAdvance, forfeit: arcadeForfeit, view: arcadeView },
  snake: { maps: ARCADE_MAPS, start: (...args) => arcadeStart('snake', ...args), advance: arcadeAdvance, forfeit: arcadeForfeit, view: arcadeView }
};

const TANK_OPEN_MS = 20 * 60 * 1000;
const TANK_RESULT_MS = 120 * 1000;

async function tankPlayersOf(env, id) {
  const { results } = await env.DB.prepare('SELECT user_key, name FROM tank_players WHERE lobby = ? ORDER BY rowid').bind(id).all();
  return results;
}

async function tankMine(env, key, now) {
  await ensureEconomy(env);
  return env.DB.prepare(
    'SELECT l.* FROM tank_lobbies l JOIN tank_players p ON p.lobby = l.id WHERE p.user_key = ? AND (l.status IN (\'open\', \'playing\') OR (l.status = \'done\' AND l.ended > ?)) ORDER BY l.id DESC LIMIT 1'
  )
    .bind(key, now - TANK_RESULT_MS)
    .first();
}

async function tankCancel(env, lobby, now) {
  const closed = await env.DB.prepare('UPDATE tank_lobbies SET status = \'closed\', ended = ? WHERE id = ? AND status = \'open\'').bind(now, lobby.id).run();
  if (!closed.meta.changes) return;
  for (const player of await tankPlayersOf(env, lobby.id)) await giveMoney(env, player.user_key, lobby.stake);
  await env.DB.prepare('DELETE FROM tank_players WHERE lobby = ?').bind(lobby.id).run();
}

// the pot goes to the winner, or is shared by tanks that finished equal; a remainder smaller than a share is burnt
async function tankPayout(env, state) {
  if (!state.winners.length) return;
  const share = Math.floor(state.pot / state.winners.length);
  for (const seat of state.winners) await giveMoney(env, state.players[seat].key, share);
}

async function tankMutate(env, id, now, change) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const row = await env.DB.prepare('SELECT * FROM tank_lobbies WHERE id = ?').bind(id).first();
    if (!row || row.status !== 'playing') return null;
    const state = JSON.parse(row.state);
    let changed;
    try {
      changed = change(state, row);
    } catch (error) {
      throw liarFail(error);
    }
    if (changed === false) return { row, state };
    const done = state.over;
    const saved = await env.DB.prepare('UPDATE tank_lobbies SET state = ?, rev = rev + 1, status = ?, ended = ? WHERE id = ? AND rev = ?')
      .bind(JSON.stringify(state), done ? 'done' : 'playing', done ? now : 0, id, row.rev)
      .run();
    if (saved.meta.changes) {
      if (done) await tankPayout(env, state);
      return { row: { ...row, status: done ? 'done' : 'playing' }, state };
    }
  }
  return null; // somebody else advanced the battle at the same moment: that is fine
}

// runs the ticks that are due, with the newest wishes of the players
async function tankSettle(env, row, now) {
  if (row.status !== 'playing') return;
  const state = JSON.parse(row.state);
  if (now < state.nextTick) return;
  const { results } = await env.DB.prepare('SELECT user_key, t, move, fire FROM tank_inputs WHERE lobby = ?').bind(row.id).all();
  await tankMutate(env, row.id, now, (current) => {
    const inputs = results
      .map((item) => ({ seat: current.players.findIndex((player) => player.key === item.user_key), t: item.t, move: item.move, fire: item.fire }))
      .filter((item) => item.seat >= 0);
    return ARENAS[row.kind ?? 'tank'].advance(current, now, inputs);
  });
}

async function tankSnapshot(env, row, key, now) {
  const balance = await balanceOf(env, key);
  if (!row) return { lobby: null, balance };
  const fresh = await env.DB.prepare('SELECT * FROM tank_lobbies WHERE id = ?').bind(row.id).first();
  if (fresh.status === 'open') {
    const players = await tankPlayersOf(env, fresh.id);
    return {
      balance,
      lobby: {
        id: fresh.id,
        status: 'open',
        stake: fresh.stake,
        max: fresh.max,
        map: fresh.map,
        kind: fresh.kind,
        mapName: ARENAS[fresh.kind]?.maps[fresh.map]?.name ?? fresh.map,
        owner: fresh.owner_name,
        mine: fresh.owner_key === key,
        players: players.map((player) => ({ name: player.name, me: player.user_key === key })),
        now
      }
    };
  }
  return { balance, lobby: { id: fresh.id, status: fresh.status, max: fresh.max, owner: fresh.owner_name, ...ARENAS[fresh.kind].view(JSON.parse(fresh.state), key, now) } };
}

async function tankRoute(game, env, row, body, now) {
  const key = row.key;
  const [kind, action] = game.split('/');
  const arena = ARENAS[kind];
  if (!arena) throw new ApiError(404, 'not-found');

  if (action === 'list') {
    const { results: stale } = await env.DB.prepare('SELECT * FROM tank_lobbies WHERE status = \'open\' AND created < ?').bind(now - TANK_OPEN_MS).all();
    for (const lobby of stale) await tankCancel(env, lobby, now);
    const { results: open } = await env.DB.prepare('SELECT id, owner_name, stake, max, map FROM tank_lobbies WHERE status = \'open\' AND kind = ? ORDER BY id DESC LIMIT 20').bind(kind).all();
    const lobbies = [];
    for (const lobby of open) {
      lobbies.push({ id: lobby.id, owner: lobby.owner_name, stake: lobby.stake, max: lobby.max, mapName: arena.maps[lobby.map]?.name ?? lobby.map, players: (await tankPlayersOf(env, lobby.id)).map((player) => player.name) });
    }
    const mine = await tankMine(env, key, now);
    return { lobbies, maps: Object.entries(arena.maps).map(([id, map]) => ({ id, name: map.name })), mine: mine ? mine.id : null, balance: await balanceOf(env, key) };
  }

  if (action === 'state') {
    let mine = await tankMine(env, key, now);
    if (mine && mine.kind !== kind) return { lobby: null, balance: await balanceOf(env, key), busy: mine.kind };
    if (mine) {
      await tankSettle(env, mine, now);
      mine = await tankMine(env, key, now);
    }
    return tankSnapshot(env, mine, key, now);
  }

  if (action === 'create') {
    const stake = Math.floor(Number(body.stake));
    const max = Math.floor(Number(body.max ?? 4));
    const map = String(body.map ?? Object.keys(arena.maps)[0]);
    if (!Number.isFinite(stake) || stake < 10 || stake > MAX_BET || !(max >= 2 && max <= 4) || !arena.maps[map]) throw new ApiError(400, 'bad-bet');
    await balanceOf(env, key);
    const active = await tankMine(env, key, now);
    if (active && active.status !== 'done') throw new ApiError(409, 'in-lobby');
    await takeMoney(env, key, stake);
    const created = await env.DB.prepare('INSERT INTO tank_lobbies (owner_key, owner_name, stake, max, map, kind, status, created) VALUES (?, ?, ?, ?, ?, ?, \'open\', ?)').bind(key, row.name, stake, max, map, kind, now).run();
    if (!created.meta.changes) {
      await giveMoney(env, key, stake);
      throw new ApiError(500, 'server');
    }
    const lobby = await env.DB.prepare('SELECT id FROM tank_lobbies WHERE owner_key = ? ORDER BY id DESC LIMIT 1').bind(key).first();
    await env.DB.prepare('INSERT INTO tank_players (lobby, user_key, name) VALUES (?, ?, ?)').bind(lobby.id, key, row.name).run();
    return tankSnapshot(env, await tankMine(env, key, now), key, now);
  }

  if (action === 'join') {
    const id = Math.floor(Number(body.id));
    const lobby = await env.DB.prepare('SELECT * FROM tank_lobbies WHERE id = ? AND status = \'open\' AND kind = ?').bind(id, kind).first();
    if (!lobby) throw new ApiError(404, 'no-lobby');
    await balanceOf(env, key);
    const active = await tankMine(env, key, now);
    if (active && active.status !== 'done') throw new ApiError(409, 'in-lobby');
    await takeMoney(env, key, lobby.stake);
    const seated = await env.DB.prepare(
      'INSERT INTO tank_players (lobby, user_key, name) SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM tank_players WHERE lobby = ?) < (SELECT max FROM tank_lobbies WHERE id = ? AND status = \'open\')'
    )
      .bind(id, key, row.name, id, id)
      .run();
    if (!seated.meta.changes) {
      await giveMoney(env, key, lobby.stake);
      throw new ApiError(409, 'full');
    }
    return tankSnapshot(env, await tankMine(env, key, now), key, now);
  }

  if (action === 'leave') {
    const mine = await tankMine(env, key, now);
    if (!mine) return { lobby: null, balance: await balanceOf(env, key) };
    if (mine.status === 'open') {
      if (mine.owner_key === key) {
        await tankCancel(env, mine, now);
      } else {
        const left = await env.DB.prepare('DELETE FROM tank_players WHERE lobby = ? AND user_key = ?').bind(mine.id, key).run();
        if (left.meta.changes) await giveMoney(env, key, mine.stake);
      }
    } else if (mine.status === 'playing') {
      await tankMutate(env, mine.id, now, (state) => {
        const seat = state.players.findIndex((player) => player.key === key);
        ARENAS[mine.kind].forfeit(state, seat);
      });
      await env.DB.prepare('DELETE FROM tank_players WHERE lobby = ? AND user_key = ?').bind(mine.id, key).run();
    } else {
      await env.DB.prepare('DELETE FROM tank_players WHERE lobby = ? AND user_key = ?').bind(mine.id, key).run();
    }
    return { lobby: null, balance: await balanceOf(env, key) };
  }

  const mine = await tankMine(env, key, now);
  if (!mine || mine.kind !== kind) throw new ApiError(409, 'no-lobby');

  if (action === 'start') {
    if (mine.status !== 'open') throw new ApiError(409, 'started');
    if (mine.owner_key !== key) throw new ApiError(403, 'forbidden');
    const players = await tankPlayersOf(env, mine.id);
    if (players.length < 2) throw new ApiError(409, 'few-players');
    const state = arena.start(players.map((player) => ({ key: player.user_key, name: player.name })), mine.map, mine.stake, now);
    const started = await env.DB.prepare('UPDATE tank_lobbies SET status = \'playing\', state = ?, rev = rev + 1 WHERE id = ? AND status = \'open\'').bind(JSON.stringify(state), mine.id).run();
    if (!started.meta.changes) throw new ApiError(409, 'started');
    await env.DB.prepare('DELETE FROM tank_inputs WHERE lobby = ?').bind(mine.id).run();
    return tankSnapshot(env, mine, key, now);
  }

  if (action === 'input') {
    if (mine.status === 'playing') {
      const move = isDir(body.move) ? body.move : null;
      const fire = isDir(body.fire) ? body.fire : null;
      if (move || fire) {
        await env.DB.prepare(
          'INSERT INTO tank_inputs (lobby, user_key, t, move, fire) VALUES (?, ?, ?, ?, ?) ON CONFLICT (lobby, user_key) DO UPDATE SET t = excluded.t, move = excluded.move, fire = excluded.fire'
        )
          .bind(mine.id, key, now, move, fire)
          .run();
      }
      await tankSettle(env, mine, now);
    }
    return tankSnapshot(env, await tankMine(env, key, now), key, now);
  }

  throw new ApiError(404, 'not-found');
}

/** Market editor (level MARKET_ADMIN_LEVEL and up): news shocks, price levels, volatility, new and removed companies. */
async function editMarket(env, row, body, now) {
  const op = String(body.op ?? '');
  const id = String(body.asset ?? '').trim().toUpperCase();
  const assets = await assetsOf(env);
  const known = assets.find((asset) => asset.id === id);
  const number = Number(body.value);
  const need = () => {
    if (!known) throw new ApiError(404, 'no-asset');
    return known;
  };
  let summary;

  if (op === 'shock') {
    const asset = need();
    if (!Number.isFinite(number) || Math.abs(number) > 90) throw new ApiError(400, 'bad-value');
    await env.DB.prepare('INSERT INTO demand (asset, t, impact) VALUES (?, ?, ?)').bind(asset.id, now, Math.log(1 + number / 100)).run();
    summary = `shock ${asset.id} ${number}%`;
  } else if (op === 'base') {
    const asset = need();
    if (!Number.isFinite(number) || number < 1 || number > 100000) throw new ApiError(400, 'bad-value');
    await env.DB.prepare('INSERT INTO market_edits (asset, base) VALUES (?, ?) ON CONFLICT (asset) DO UPDATE SET base = excluded.base').bind(asset.id, number).run();
    if (!ASSETS.some((entry) => entry.id === asset.id)) await env.DB.prepare('UPDATE custom_assets SET base = ? WHERE id = ?').bind(number, asset.id).run();
    summary = `base ${asset.id} ${number}`;
  } else if (op === 'vol') {
    const asset = need();
    if (!Number.isFinite(number) || number < 0.01 || number > 2) throw new ApiError(400, 'bad-value');
    await env.DB.prepare('INSERT INTO market_edits (asset, vol) VALUES (?, ?) ON CONFLICT (asset) DO UPDATE SET vol = excluded.vol').bind(asset.id, number).run();
    if (!ASSETS.some((entry) => entry.id === asset.id)) await env.DB.prepare('UPDATE custom_assets SET vol = ? WHERE id = ?').bind(number, asset.id).run();
    summary = `vol ${asset.id} ${number}`;
  } else if (op === 'add') {
    const name = String(body.name ?? '').trim().slice(0, 40);
    const group = String(body.group ?? '').trim().slice(0, 24) || 'Прочее';
    const kind = String(body.kind ?? '').trim().slice(0, 16) || 'акции';
    const base = Number(body.base);
    const vol = Number(body.vol ?? 0.3);
    if (!/^[A-Z0-9]{2,5}$/.test(id) || !name || !(base >= 1 && base <= 100000) || !(vol >= 0.01 && vol <= 2)) throw new ApiError(400, 'bad-value');
    const taken = known || ASSETS.some((entry) => entry.id === id);
    if (taken) throw new ApiError(409, 'taken');
    await env.DB.prepare('INSERT INTO custom_assets (id, name, grp, kind, base, vol) VALUES (?, ?, ?, ?, ?, ?)').bind(id, name, group, kind, base, vol).run();
    summary = `add ${id} ${name}`;
  } else if (op === 'remove') {
    const asset = need();
    if (ASSETS.some((entry) => entry.id === asset.id)) {
      await env.DB.prepare('INSERT INTO market_edits (asset, hidden) VALUES (?, 1) ON CONFLICT (asset) DO UPDATE SET hidden = 1').bind(asset.id).run();
    } else {
      await env.DB.prepare('DELETE FROM custom_assets WHERE id = ?').bind(asset.id).run();
    }
    summary = `remove ${asset.id}`;
  } else if (op === 'reset') {
    if (!id) throw new ApiError(400, 'bad-value');
    await env.DB.prepare('DELETE FROM market_edits WHERE asset = ?').bind(id).run();
    await env.DB.prepare('DELETE FROM demand WHERE asset = ?').bind(id).run();
    summary = `reset ${id}`;
  } else {
    throw new ApiError(400, 'bad-value');
  }

  await addAttempt(env, row.key, 'market-edit', summary.slice(0, 120));
  return { ok: true, summary, assets: (await assetsOf(env)).map((asset) => ({ id: asset.id, name: asset.name, group: asset.group, kind: asset.kind, base: asset.base, vol: asset.vol })) };
}

async function economyRoute(path, method, request, env, row) {
  const now = Date.now();
  const seed = seedOf(env);

  if (path === '/api/wallet' && method === 'GET') {
    const state = await economyState(env, row.key);
    const tick = tickOf(now);
    const demand = await loadDemand(env, now);
    const assets = await assetsOf(env);
    const quote = (asset) => marketPrice(asset, tick, seed, demand[asset.id], now);
    const worth = state.holdings.reduce((sum, item) => {
      const asset = assets.find((entry) => entry.id === item.asset);
      return sum + (asset ? Math.floor(quote(asset) * item.qty) : 0);
    }, 0);
    return { ...state, worth, assets: assets.map((asset) => ({ id: asset.id, name: asset.name, price: quote(asset) })) };
  }

  if (path === '/api/market' && method === 'GET') {
    const state = await economyState(env, row.key);
    return { ...snapshot(now, seed, await loadDemand(env, now), await assetsOf(env)), ...state, fee: FEE, liquidity: LIQUIDITY, maxImpact: MAX_IMPACT, trades: await recentTrades(env), editor: row.level >= MARKET_ADMIN_LEVEL };
  }

  if (path === '/api/market/trade' && method === 'POST') {
    const body = await readBody(request);
    const asset = (await assetsOf(env)).find((entry) => entry.id === String(body.asset ?? '').toUpperCase());
    const qty = Math.floor(Number(body.qty));
    if (!asset || !Number.isFinite(qty) || qty < 1 || qty > 1000000) throw new ApiError(400, 'bad-trade');
    const side = String(body.side ?? '');
    if (side !== 'buy' && side !== 'sell') throw new ApiError(400, 'bad-trade');

    await balanceOf(env, row.key);
    const demand = await loadDemand(env, now);
    const quoted = marketPrice(asset, tickOf(now), seed, demand[asset.id], now);
    // a big order moves the price, and it is filled at the average of the price before and after
    const impact = tradeImpact(quoted * qty);
    const price = Math.round(quoted * Math.exp(side === 'buy' ? impact / 2 : -impact / 2) * 100) / 100;
    let total;
    if (side === 'buy') {
      total = Math.ceil(price * qty * (1 + FEE));
      await takeMoney(env, row.key, total);
      await env.DB.prepare(
        'INSERT INTO holdings (user_key, asset, qty, cost) VALUES (?, ?, ?, ?) ON CONFLICT (user_key, asset) DO UPDATE SET qty = qty + excluded.qty, cost = cost + excluded.cost'
      )
        .bind(row.key, asset.id, qty, total)
        .run();
    } else {
      const held = await env.DB.prepare('SELECT qty, cost FROM holdings WHERE user_key = ? AND asset = ?').bind(row.key, asset.id).first();
      if (!held || held.qty < qty) throw new ApiError(409, 'no-assets');
      const costOut = Math.round((held.cost * qty) / held.qty);
      const sold = await env.DB.prepare('UPDATE holdings SET qty = qty - ?, cost = MAX(0, cost - ?) WHERE user_key = ? AND asset = ? AND qty >= ?')
        .bind(qty, costOut, row.key, asset.id, qty)
        .run();
      if (!sold.meta.changes) throw new ApiError(409, 'no-assets');
      await env.DB.prepare('DELETE FROM holdings WHERE user_key = ? AND qty <= 0').bind(row.key).run();
      total = Math.floor(price * qty * (1 - FEE));
      await giveMoney(env, row.key, total);
    }
    // the journal everyone sees: who traded what, and where the price stood against six minutes ago
    const sixMinutesAgo = marketPrice(asset, tickOf(now) - HISTORY_TICKS + 1, seed, demand[asset.id], (tickOf(now) - HISTORY_TICKS + 1) * TICK_MS);
    const pct = Math.round((quoted / sixMinutesAgo - 1) * 1000) / 10;
    await env.DB.prepare('INSERT INTO trades (t, name, asset, side, qty, price, pct) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(now, row.name, asset.id, side, qty, price, pct).run();
    await env.DB.prepare('DELETE FROM trades WHERE id <= (SELECT MAX(id) FROM trades) - 200').run();
    await env.DB.prepare('INSERT INTO demand (asset, t, impact) VALUES (?, ?, ?)').bind(asset.id, now, side === 'buy' ? impact : -impact).run();
    await env.DB.prepare('DELETE FROM demand WHERE t < ?').bind(now - 12 * DEMAND_HALF_MS).run();
    return { trade: { asset: asset.id, side, qty, price, total }, ...(await economyState(env, row.key)) };
  }

  if (path === '/api/market/edit' && method === 'POST') {
    if (row.level < MARKET_ADMIN_LEVEL) throw new ApiError(403, 'forbidden');
    return editMarket(env, row, await readBody(request), now);
  }

  if (path === '/api/wallet/send' && method === 'POST') {
    const body = await readBody(request);
    const key = userKey(String(body.to ?? ''));
    const target = key ? await env.DB.prepare('SELECT key, name FROM users WHERE key = ?').bind(key).first() : null;
    if (!target) throw new ApiError(404, 'not-found');
    if (target.key === row.key) throw new ApiError(403, 'self');
    const amount = Math.floor(Number(body.amount));
    if (!Number.isFinite(amount) || amount < 1 || amount > 1000000) throw new ApiError(400, 'bad-amount');
    const note = String(body.note ?? '').trim().slice(0, 200);
    await balanceOf(env, row.key);
    await balanceOf(env, target.key);
    await takeMoney(env, row.key, amount);
    await giveMoney(env, target.key, amount);
    await deliver(env, target.key, row.name, `Перевод ${amount} КЕ`, `${row.name} перевёл(а) вам ${amount} КЕ (крипто-енды).${note ? `\n\n${note}` : ''}`);
    return { sent: { to: target.name, amount }, balance: await balanceOf(env, row.key) };
  }

  // «Змейка: соло» runs in the player's console, so the server only caps what a run may pay:
  // 2 КЕ per apple, 50 КЕ per run and no more than 1 КЕ per second since the previous payout
  if (path === '/api/wallet/solo' && method === 'POST') {
    const body = await readBody(request);
    const apples = Math.floor(Number(body.apples));
    if (!Number.isFinite(apples) || apples < 0 || apples > 1000) throw new ApiError(400, 'bad-value');
    await balanceOf(env, row.key);
    const last = await env.DB.prepare('SELECT t FROM solo_claims WHERE user_key = ?').bind(row.key).first();
    const seconds = Math.floor((now - (last?.t ?? now - 60000)) / 1000);
    const reward = Math.max(0, Math.min(50, apples * 2, seconds));
    await env.DB.prepare('INSERT INTO solo_claims (user_key, t) VALUES (?, ?) ON CONFLICT (user_key) DO UPDATE SET t = excluded.t').bind(row.key, now).run();
    await giveMoney(env, row.key, reward);
    return { reward, balance: await balanceOf(env, row.key) };
  }

  if (path === '/api/rich' && method === 'GET') {
    await ensureEconomy(env);
    const tick = tickOf(now);
    const { results: wallets } = await env.DB.prepare('SELECT w.user_key AS key, u.name AS name, w.balance AS balance FROM wallets w JOIN users u ON u.key = w.user_key').all();
    const { results: held } = await env.DB.prepare('SELECT user_key, asset, qty FROM holdings WHERE qty > 0').all();
    const demand = await loadDemand(env, now);
    const assets = await assetsOf(env);
    const worth = new Map(wallets.map((item) => [item.key, item.balance]));
    for (const item of held) {
      const asset = assets.find((entry) => entry.id === item.asset);
      if (asset && worth.has(item.user_key)) worth.set(item.user_key, worth.get(item.user_key) + Math.floor(marketPrice(asset, tick, seed, demand[asset.id], now) * item.qty));
    }
    const top = wallets.map((item) => ({ name: item.name, worth: worth.get(item.key), me: item.key === row.key })).sort((a, b) => b.worth - a.worth).slice(0, 10);
    return { top };
  }

  if (!path.startsWith('/api/casino/') || method !== 'POST') return null;
  const body = await readBody(request);
  const game = path.slice('/api/casino/'.length);

  if (game === 'slots') {
    const bet = betOf(body);
    await balanceOf(env, row.key);
    await takeMoney(env, row.key, bet);
    const spin = spinSlots();
    const payout = Math.floor(bet * spin.multiplier);
    await giveMoney(env, row.key, payout);
    return { ...spin, bet, payout, balance: await balanceOf(env, row.key) };
  }

  if (game === 'roulette') {
    const bet = betOf(body);
    const type = String(body.type ?? '');
    const value = Math.floor(Number(body.value ?? 0));
    if (!ROULETTE_BETS[type]) throw new ApiError(400, 'bad-bet');
    await balanceOf(env, row.key);
    const spin = spinRoulette(type, value);
    if (!spin) throw new ApiError(400, 'bad-bet');
    await takeMoney(env, row.key, bet);
    const payout = Math.floor(bet * spin.multiplier);
    await giveMoney(env, row.key, payout);
    return { ...spin, type, value, bet, payout, balance: await balanceOf(env, row.key) };
  }

  if (game === 'dice') {
    const bet = betOf(body);
    const target = Math.floor(Number(body.target));
    const roll = rollDice(String(body.mode ?? ''), target);
    if (!roll) throw new ApiError(400, 'bad-bet');
    await balanceOf(env, row.key);
    await takeMoney(env, row.key, bet);
    const payout = Math.floor(bet * roll.multiplier);
    await giveMoney(env, row.key, payout);
    return { ...roll, mode: body.mode, target, bet, payout, balance: await balanceOf(env, row.key) };
  }

  if (game.startsWith('liar/')) return liarRoute(game, env, row, body, now);
  if (/^(tank|tron|snake)\//.test(game)) return tankRoute(game, env, row, body, now);

  if (game === 'crash/state') return crashState(env, row, now);

  if (game === 'crash/launch') {
    // anybody may start a round when none is running; the launcher's own bet is optional
    const last = await latestCrash(env);
    if (crashPhase(last, now) !== 'idle') throw new ApiError(409, 'running');
    const bet = body.bet == null ? 0 : betOf(body);
    await balanceOf(env, row.key);
    if (bet) await takeMoney(env, row.key, bet);
    const betUntil = now + CRASH_BET_WINDOW_MS;
    // only one of several simultaneous launches starts the round
    const started = await env.DB.prepare('INSERT INTO crash_rounds (bet_until, start, crash) SELECT ?, ?, ? WHERE COALESCE((SELECT MAX(id) FROM crash_rounds), 0) = ?')
      .bind(betUntil, betUntil, crashPoint(), last?.id ?? 0)
      .run();
    if (!started.meta.changes) {
      await giveMoney(env, row.key, bet);
      throw new ApiError(409, 'running');
    }
    const round = await latestCrash(env);
    if (bet) await env.DB.prepare('INSERT INTO crash_bets (round, user_key, name, bet) VALUES (?, ?, ?, ?)').bind(round.id, row.key, row.name, bet).run();
    await env.DB.prepare('DELETE FROM crash_rounds WHERE id < ?').bind(round.id - 60).run();
    await env.DB.prepare('DELETE FROM crash_bets WHERE round < ?').bind(round.id - 60).run();
    return crashState(env, row, now);
  }

  if (game === 'crash/bet') {
    const bet = betOf(body);
    const round = await latestCrash(env);
    if (crashPhase(round, now) !== 'betting') throw new ApiError(409, 'closed');
    await balanceOf(env, row.key);
    await placeCrashBet(env, row, round, bet);
    return crashState(env, row, now);
  }

  if (game === 'crash/cashout') {
    const round = await latestCrash(env);
    if (!round) throw new ApiError(409, 'no-round');
    const mine = await env.DB.prepare('SELECT bet, cashed FROM crash_bets WHERE round = ? AND user_key = ?').bind(round.id, row.key).first();
    if (!mine || mine.cashed != null) throw new ApiError(409, 'no-round');
    const phase = crashPhase(round, now);
    if (phase === 'betting') throw new ApiError(409, 'closed');
    if (phase === 'idle') throw new ApiError(409, 'no-round');
    if (phase === 'crashed') return { crashed: true, at: round.crash, ...(await crashState(env, row, now)) };

    // the player reports the multiplier on their screen; it may only lie between "a moment ago" and "now"
    const elapsed = now - round.start;
    const high = crashMultiplier(elapsed);
    const low = crashMultiplier(Math.max(0, elapsed - CRASH_GRACE_MS));
    const claimed = Number(body.at);
    const asked = Number.isFinite(claimed) ? claimed : low;
    const multiplier = Math.max(1, Math.min(Math.max(low, Math.min(asked, high)), Math.floor((round.crash - 0.01) * 100) / 100));
    const payout = Math.floor(mine.bet * multiplier);
    const done = await env.DB.prepare('UPDATE crash_bets SET cashed = ?, payout = ? WHERE round = ? AND user_key = ? AND cashed IS NULL').bind(multiplier, payout, round.id, row.key).run();
    if (!done.meta.changes) throw new ApiError(409, 'no-round');
    await giveMoney(env, row.key, payout);
    return { won: true, multiplier, payout, ...(await crashState(env, row, now)) };
  }

  throw new ApiError(404, 'not-found');
}

async function route(request, env) {
  const { pathname } = new URL(request.url);
  const path = pathname.replace(/\/+$/, '') || '/';
  const method = request.method;

  if (path === '/api/register' && method === 'POST') return register(request, env);
  if (path === '/api/login' && method === 'POST') return login(request, env);
  if (path === '/' || path === '/api') return { ok: true, service: 'anco-console' };

  if (!path.startsWith('/api/')) throw new ApiError(404, 'not-found');
  const { row, tokenHash } = await authenticate(request, env);

  if (path === '/api/me' && method === 'GET') return { user: await publicUser(env, row) };

  const economy = await economyRoute(path, method, request, env, row);
  if (economy) return economy;

  if (path === '/api/logout' && method === 'POST') {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
    return { ok: true };
  }

  if (path === '/api/me' && method === 'DELETE') {
    await env.DB.prepare('DELETE FROM sessions WHERE user_key = ?').bind(row.key).run();
    await env.DB.prepare('DELETE FROM attempts WHERE user_key = ?').bind(row.key).run();
    await env.DB.prepare('DELETE FROM mail WHERE to_key = ?').bind(row.key).run();
    await wipeEconomy(env, row.key);
    await env.DB.prepare('DELETE FROM users WHERE key = ?').bind(row.key).run();
    return { ok: true };
  }

  if (path === '/api/log' && method === 'POST') {
    const body = await readBody(request);
    const action = String(body.action ?? '');
    if (!ACTIONS.has(action)) throw new ApiError(400, 'bad-action');
    await addAttempt(env, row.key, action, String(body.target ?? '').slice(0, 120));
    return { user: await publicUser(env, row) };
  }

  if (path === '/api/stats' && method === 'POST') {
    const body = await readBody(request);
    const snake = Number.isFinite(body.snake) ? Math.min(10000, Math.max(row.snake, Math.floor(body.snake))) : row.snake;
    const hacks = Number.isFinite(body.hacks) ? Math.min(row.hacks + 1, Math.max(row.hacks, Math.floor(body.hacks))) : row.hacks;
    await env.DB.prepare('UPDATE users SET snake = ?, hacks = ? WHERE key = ?').bind(snake, hacks, row.key).run();
    const fresh = await env.DB.prepare('SELECT * FROM users WHERE key = ?').bind(row.key).first();
    return { user: await publicUser(env, fresh) };
  }

  if (path === '/api/adduser' && method === 'POST') {
    // any signed-in employee may add someone, but never above their own level
    const body = await readBody(request);
    const name = String(body.name ?? '').trim();
    const password = String(body.password ?? '');
    const department = resolveDepartment(body);
    const realName = cleanRealName(body.realName);
    const level = parseLevel(body.level, department ? Math.min(department.level, row.level) : undefined);

    if (!NAME_RULE.test(name)) throw new ApiError(400, 'bad-name');
    if (!realName) throw new ApiError(400, 'bad-realname');
    if (password.length < 4 || password.length > 100) throw new ApiError(400, 'bad-password');
    if (!department) throw new ApiError(400, 'bad-department');
    if (level === null) throw new ApiError(400, 'bad-level');
    if (level > row.level) throw new ApiError(403, 'too-high');

    const added = await env.DB.prepare('SELECT COUNT(*) AS n FROM attempts WHERE user_key = ? AND action = ? AND t > ?')
      .bind(row.key, 'adduser', Date.now() - 24 * 3600000)
      .first();
    // the top level (market editor) adds people without a daily limit
    if (row.level < MARKET_ADMIN_LEVEL && added.n >= ADDUSER_PER_DAY) throw new ApiError(429, 'rate');

    const key = userKey(name);
    if (await env.DB.prepare('SELECT key FROM users WHERE key = ?').bind(key).first()) throw new ApiError(409, 'taken');

    const salt = randomHex(16);
    await env.DB.prepare(
      'INSERT INTO users (key, name, real_name, department, salt, hash, base_level, level, registered) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
      .bind(key, name, realName, department.name, salt, await hashPassword(password, salt), department.level, level, Date.now())
      .run();
    await addAttempt(env, row.key, 'adduser', `${name} L${level}`);
    return { created: { name, department: department.name, level } };
  }

  if (path === '/api/mail' && method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT id, from_name AS "from", subject, t, is_read AS read FROM mail WHERE to_key = ? ORDER BY id DESC LIMIT 50'
    )
      .bind(row.key)
      .all();
    return { mail: results.map((item) => ({ ...item, read: Boolean(item.read) })) };
  }

  if (path === '/api/mail' && method === 'POST') {
    const body = await readBody(request);
    const key = userKey(String(body.to ?? ''));
    const target = key ? await env.DB.prepare('SELECT key, name FROM users WHERE key = ?').bind(key).first() : null;
    if (!target) throw new ApiError(404, 'not-found');
    if (target.key === row.key) throw new ApiError(403, 'self');
    const { subject, text } = mailFields(body);

    const sent = await env.DB.prepare('SELECT COUNT(*) AS n FROM mail WHERE from_name = ? AND t > ?').bind(row.name, Date.now() - 3600000).first();
    if (sent.n >= MAIL_PER_HOUR) throw new ApiError(429, 'rate');

    await deliver(env, target.key, row.name, subject, text);
    return { sent: { to: target.name } };
  }

  if (path === '/api/broadcast' && method === 'POST') {
    requireAdmin(row);
    const { subject, text } = mailFields(await readBody(request));
    const { results } = await env.DB.prepare('SELECT key FROM users WHERE key != ?').bind(row.key).all();
    for (const person of results) await deliver(env, person.key, row.name, subject, text);
    await addAttempt(env, row.key, 'broadcast', subject);
    return { sent: { count: results.length } };
  }

  const mailId = path.match(/^\/api\/mail\/(\d+)$/);
  if (mailId && method === 'GET') {
    const message = await env.DB.prepare('SELECT id, from_name AS "from", subject, body, t FROM mail WHERE id = ? AND to_key = ?')
      .bind(Number(mailId[1]), row.key)
      .first();
    if (!message) throw new ApiError(404, 'not-found');
    await env.DB.prepare('UPDATE mail SET is_read = 1 WHERE id = ?').bind(message.id).run();
    return { message };
  }

  if (mailId && method === 'DELETE') {
    await env.DB.prepare('DELETE FROM mail WHERE id = ? AND to_key = ?').bind(Number(mailId[1]), row.key).run();
    return { ok: true };
  }

  if (path === '/api/unlock' && method === 'POST') {
    // the browser checks the word against the files; here it is only remembered for this employee
    const body = await readBody(request);
    const keyword = String(body.keyword ?? '').trim().toUpperCase();
    if (keyword.length < 1 || keyword.length > 40) throw new ApiError(400, 'bad-keyword');

    const known = JSON.parse(row.codes);
    if (known.includes(keyword)) throw new ApiError(409, 'already');
    if (known.length >= 50) throw new ApiError(400, 'bad-keyword');

    await env.DB.prepare('UPDATE users SET codes = ? WHERE key = ?').bind(JSON.stringify([...known, keyword]), row.key).run();
    await addAttempt(env, row.key, 'auth', keyword);
    const fresh = await env.DB.prepare('SELECT * FROM users WHERE key = ?').bind(row.key).first();
    return { user: await publicUser(env, fresh) };
  }

  if (path === '/api/staff' && method === 'GET') {
    // real names are only sent to administrators; everyone else gets none (the console shows scrambled symbols)
    const { results } = await env.DB.prepare('SELECT name, real_name, department, level FROM users ORDER BY level DESC, name COLLATE NOCASE ASC').all();
    const seeReal = row.level >= ADMIN_LEVEL;
    return { staff: results.map(({ name, real_name: realName, department, level }) => ({ name, department, level, ...(seeReal ? { realName } : {}) })) };
  }

  if (path === '/api/setname' && method === 'POST') {
    // your own real name, or (administrators) the real name of someone below you
    const body = await readBody(request);
    const realName = cleanRealName(body.realName);
    if (!realName) throw new ApiError(400, 'bad-realname');

    const own = !body.name || userKey(String(body.name)) === row.key;
    let target = row;
    if (!own) {
      requireAdmin(row);
      target = await manageable(env, row, body.name);
    }

    await env.DB.prepare('UPDATE users SET real_name = ? WHERE key = ?').bind(realName, target.key).run();
    await addAttempt(env, row.key, 'setname', target.name);
    return { target: { name: target.name } };
  }

  if (path === '/api/promote' && method === 'POST') {
    requireAdmin(row);
    const body = await readBody(request);
    const target = await manageable(env, row, body.name);

    const level = parseLevel(body.level, target.level + 1);
    if (level === null) throw new ApiError(400, 'bad-level');
    if (level > row.level) throw new ApiError(403, 'too-high');
    if (level <= target.level) throw new ApiError(409, 'not-higher');

    await env.DB.prepare('UPDATE users SET level = ? WHERE key = ?').bind(level, target.key).run();
    await addAttempt(env, row.key, 'promote', `${target.name} L${target.level}→L${level}`);
    return { target: { name: target.name, level } };
  }

  if (path === '/api/demote' && method === 'POST') {
    requireAdmin(row);
    const body = await readBody(request);
    const target = await manageable(env, row, body.name);

    const level = parseLevel(body.level, target.level - 1);
    if (level === null || level < 0) throw new ApiError(400, 'bad-level');
    if (level >= target.level) throw new ApiError(409, 'not-lower');

    await env.DB.prepare('UPDATE users SET level = ? WHERE key = ?').bind(level, target.key).run();
    await addAttempt(env, row.key, 'demote', `${target.name} L${target.level}→L${level}`);
    return { target: { name: target.name, level } };
  }

  if (path === '/api/transfer' && method === 'POST') {
    requireAdmin(row);
    const body = await readBody(request);
    const target = await manageable(env, row, body.name);
    const department = resolveDepartment(body);
    if (!department) throw new ApiError(400, 'bad-department');

    await env.DB.prepare('UPDATE users SET department = ? WHERE key = ?').bind(department.name, target.key).run();
    await addAttempt(env, row.key, 'transfer', `${target.name} → ${department.name}`.slice(0, 120));
    return { target: { name: target.name, department: department.name } };
  }

  if (path === '/api/resetpass' && method === 'POST') {
    requireAdmin(row);
    const body = await readBody(request);
    const target = await manageable(env, row, body.name);
    // an empty password means "make one up": it is shown to the administrator once and stored only as a hash
    const generated = String(body.password ?? '') === '';
    const password = generated ? generatePassword() : String(body.password);
    if (password.length < 4 || password.length > 100) throw new ApiError(400, 'bad-password');

    const salt = randomHex(16);
    await env.DB.prepare('UPDATE users SET salt = ?, hash = ?, fails = 0, locked_until = 0 WHERE key = ?')
      .bind(salt, await hashPassword(password, salt), target.key)
      .run();
    await env.DB.prepare('DELETE FROM sessions WHERE user_key = ?').bind(target.key).run(); // sign them out everywhere
    await addAttempt(env, row.key, 'resetpass', target.name);
    return { target: { name: target.name }, ...(generated ? { password } : {}) };
  }

  if (path === '/api/fire' && method === 'POST') {
    requireAdmin(row);
    const body = await readBody(request);
    const target = await manageable(env, row, body.name);

    await env.DB.prepare('DELETE FROM sessions WHERE user_key = ?').bind(target.key).run();
    await env.DB.prepare('DELETE FROM attempts WHERE user_key = ?').bind(target.key).run();
    await env.DB.prepare('DELETE FROM mail WHERE to_key = ?').bind(target.key).run();
    await wipeEconomy(env, target.key);
    await env.DB.prepare('DELETE FROM users WHERE key = ?').bind(target.key).run();
    await addAttempt(env, row.key, 'fire', `${target.name} L${target.level}`);
    return { target: { name: target.name } };
  }

  throw new ApiError(404, 'not-found');
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request, env) });

    try {
      return reply(request, env, await route(request, env));
    } catch (error) {
      if (error instanceof ApiError) return reply(request, env, { error: error.code }, error.status);
      console.error(error);
      return reply(request, env, { error: 'server' }, 500);
    }
  }
};
