/**
 * Экономика консоли: единый баланс «крипто-енды» (КЕ), биржа и казино.
 * Чистые функции без обращения к базе: цены и исходы игр считает сервер, браузеру доверять нельзя.
 */

export const START_BALANCE = 1000;
export const MAX_BET = 10000;
export const FEE = 0.01; // комиссия биржи с каждой сделки
export const TICK_MS = 5000; // как часто меняются цены
export const HISTORY_TICKS = 72; // сколько тиков истории отдаём клиенту (6 минут)
export const DOLE_LIMIT = 100; // пособие выдаётся тем, у кого меньше
export const DOLE_COOLDOWN = 10 * 60 * 1000;
export const CRASH_RATE = 0.09; // рост множителя «Взлёта» в секунду (экспонента)

// vol — размах колебаний, noise — «шум» отдельных тиков
export const ASSETS = [
  { id: 'ANRX', name: 'AnroxComputers', kind: 'акции', base: 120, vol: 0.2, noise: 0.012 },
  { id: 'DKB', name: 'ДКБ Оборона', kind: 'акции', base: 85, vol: 0.26, noise: 0.015 },
  { id: 'AME', name: 'АМЕ-Роботикс', kind: 'акции', base: 60, vol: 0.34, noise: 0.02 },
  { id: 'GEOD', name: 'Геод', kind: 'ресурс', base: 40, vol: 0.42, noise: 0.025 },
  { id: 'REDM', name: 'Красный минерал', kind: 'ресурс', base: 210, vol: 0.5, noise: 0.03 },
  { id: 'END', name: 'ЕндКоин', kind: 'крипто', base: 15, vol: 0.75, noise: 0.05 }
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

export function priceAt(asset, tick, seed = '') {
  const salt = saltOf(`${seed}:${asset.id}`);
  const phase = (n) => mix(salt, 1000 + n) * Math.PI * 2;
  const waves =
    0.55 * Math.sin(tick / 42 + phase(1)) + 0.3 * Math.sin(tick / 11.5 + phase(2)) + 0.15 * Math.sin(tick / 3.4 + phase(3));
  const noise = smoothNoise(salt, tick, 6) * 0.5 + smoothNoise(salt ^ 0x5bd1e995, tick, 1.7) * 0.5;
  const price = asset.base * Math.exp(asset.vol * waves + asset.noise * 4 * noise);
  return Math.max(1, Math.round(price * 100) / 100);
}

export const tickOf = (now) => Math.floor(now / TICK_MS);

export function snapshot(now, seed) {
  const tick = tickOf(now);
  return {
    tick,
    tickMs: TICK_MS,
    nextIn: TICK_MS - (now % TICK_MS),
    assets: ASSETS.map((asset) => {
      const history = [];
      for (let k = tick - HISTORY_TICKS + 1; k <= tick; k += 1) history.push(priceAt(asset, k, seed));
      return { id: asset.id, name: asset.name, kind: asset.kind, price: history[history.length - 1], history };
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
  return Math.min(500, Math.max(1, Math.floor((97 / (1 - r))) / 100));
}

export const crashMultiplier = (elapsedMs) => Math.floor(Math.exp((CRASH_RATE * elapsedMs) / 1000) * 100) / 100;
