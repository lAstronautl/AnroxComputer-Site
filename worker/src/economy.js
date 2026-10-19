/**
 * Экономика консоли: единый баланс «крипто-енды» (КЕ), биржа и казино.
 * Чистые функции без обращения к базе: цены и исходы игр считает сервер, браузеру доверять нельзя.
 */

export const START_BALANCE = 1000;
export const MAX_BET = 10000;
export const FEE = 0.05; // комиссия биржи с каждой сделки (5%)
export const TICK_MS = 5000; // как часто меняются цены
export const HISTORY_TICKS = 72; // сколько тиков истории отдаём клиенту (6 минут)
export const LIQUIDITY = 20000; // сделка на столько КЕ двигает цену примерно на 100% (на деле — на долю этого)
export const DEMAND_HALF_MS = 4 * 60 * 1000; // за это время влияние спроса ослабевает вдвое
export const MAX_PRESSURE = 0.7; // цена от спроса меняется не больше чем в e^0.7 ≈ 2 раза
export const MAX_IMPACT = 0.07; // одна сделка двигает цену не больше чем на ≈ 7%
export const CRASH_RATE = 0.09; // рост множителя «Взлёта» в секунду (экспонента)
export const CRASH_GRACE_MS = 400; // запас на задержку сети: нажатие «Забрать» засчитывается, если успело до обвала с учётом пинга

// group — корпорация-владелец: компании одной корпорации движутся отчасти вместе
// vol — размах колебаний, noise — «шум» отдельных тиков
export const ASSETS = [
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

export function priceAt(asset, tick, seed = '') {
  const salt = saltOf(`${seed}:${asset.id}`);
  const groupSalt = saltOf(`${seed}:group:${asset.group ?? asset.id}`);
  // half of the swing is shared with the corporation's other companies, half is the company's own
  const swing = 0.5 * waves(groupSalt, tick) + 0.5 * waves(salt, tick);
  const noise = smoothNoise(salt, tick, 6) * 0.5 + smoothNoise(salt ^ 0x5bd1e995, tick, 1.7) * 0.5;
  const price = asset.base * Math.exp(asset.vol * swing * 1.15 + asset.noise * 4 * noise);
  return Math.max(1, Math.round(price * 100) / 100);
}

export const tickOf = (now) => Math.floor(now / TICK_MS);

/**
 * Давление спроса на момент `at`: сумма влияний сделок (покупка +, продажа −), каждое затухает со временем.
 * events — [{ t, impact }] по одному активу. Цена = базовая цена × e^давление.
 */
export function pressureAt(events, at) {
  let sum = 0;
  for (const event of events) {
    if (event.t <= at) sum += event.impact * 0.5 ** ((at - event.t) / DEMAND_HALF_MS);
  }
  return Math.max(-MAX_PRESSURE, Math.min(MAX_PRESSURE, sum));
}

export function marketPrice(asset, tick, seed, events, at) {
  return Math.max(1, Math.round(priceAt(asset, tick, seed) * Math.exp(pressureAt(events ?? [], at)) * 100) / 100);
}

// насколько сделка на сумму `value` сдвинет цену; считается точно, чтобы игрок заранее видел итоговую сумму
export function tradeImpact(value) {
  return Math.min(MAX_IMPACT, value / LIQUIDITY);
}

export function snapshot(now, seed, demand = {}, assets = ASSETS) {
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

export function randomFloat() {
  return crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;
}

export const randomInt = (max, rng = randomFloat) => Math.floor(rng() * max);

// слоты: три барабана, символы с весами, выигрыш — три одинаковых или пара
export const SLOT_SYMBOLS = [
  { s: '7', weight: 1, triple: 100 },
  { s: '◆', weight: 2, triple: 40 },
  { s: '★', weight: 3, triple: 20 },
  { s: 'Ω', weight: 4, triple: 12 },
  { s: '♥', weight: 6, triple: 7 },
  { s: '♣', weight: 7, triple: 5 },
  { s: '¤', weight: 8, triple: 3 }
];
export const SLOT_PAIR = 1.6; // две одинаковые — небольшой выигрыш (общая отдача около 92%)

export function spinSlots(rng = randomFloat) {
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
export const rouletteColor = (n) => (n === 0 ? 'green' : REDS.has(n) ? 'red' : 'black');

export const ROULETTE_BETS = {
  red: { pays: 2, wins: (n) => rouletteColor(n) === 'red' },
  black: { pays: 2, wins: (n) => rouletteColor(n) === 'black' },
  odd: { pays: 2, wins: (n) => n > 0 && n % 2 === 1 },
  even: { pays: 2, wins: (n) => n > 0 && n % 2 === 0 },
  low: { pays: 2, wins: (n) => n >= 1 && n <= 18 },
  high: { pays: 2, wins: (n) => n >= 19 },
  dozen: { pays: 3, wins: (n, v) => n >= 1 && Math.ceil(n / 12) === v, check: (v) => v >= 1 && v <= 3 },
  number: { pays: 36, wins: (n, v) => n === v, check: (v) => v >= 0 && v <= 36 }
};

export function spinRoulette(type, value, rng = randomFloat) {
  const bet = ROULETTE_BETS[type];
  if (!bet || (bet.check && !bet.check(value))) return null;
  const number = randomInt(37, rng);
  return { number, color: rouletteColor(number), multiplier: bet.wins(number, value) ? bet.pays : 0 };
}

// кости: бросок 1–100, ставка «меньше» или «больше» порога; выплата обратно пропорциональна шансу
export const DICE_EDGE = 0.98;

export function diceChance(mode, target) {
  return mode === 'under' ? (target - 1) / 100 : (100 - target) / 100;
}

export const diceMultiplier = (mode, target) => Math.floor((DICE_EDGE / diceChance(mode, target)) * 100) / 100;

export function rollDice(mode, target, rng = randomFloat) {
  if (!['under', 'over'].includes(mode) || !Number.isInteger(target) || target < 2 || target > 99) return null;
  if (diceChance(mode, target) <= 0.01 || diceChance(mode, target) >= 0.98) return null;
  const roll = 1 + randomInt(100, rng);
  const win = mode === 'under' ? roll < target : roll > target;
  return { roll, multiplier: win ? diceMultiplier(mode, target) : 0 };
}

// «Взлёт»: множитель растёт, пока не «рухнет»; игрок должен успеть забрать выигрыш
export function crashPoint(rng = randomFloat) {
  const r = rng();
  return Math.min(500, Math.max(1, Math.floor(93 / (1 - r)) / 100)); // 93 + запас на пинг ≈ 96% отдачи
}

export const crashMultiplier = (elapsedMs) => Math.floor(Math.exp((CRASH_RATE * elapsedMs) / 1000) * 100) / 100;

// общий «Взлёт»: один раунд на всех — кто-то запускает раунд, минута на ставки, полёт, показ итога, затем снова можно запускать
export const CRASH_BET_WINDOW_MS = 60000; // минута на ставки после запуска раунда
export const CRASH_RESULT_MS = 7000;

// с какого момента полёта раунд считается рухнувшим (с запасом на пинг)
export const crashDurationMs = (crash) => Math.ceil((Math.log(crash) / CRASH_RATE) * 1000) + CRASH_GRACE_MS + 50;
