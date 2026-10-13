/**
 * API ролевой консоли АнКо (Cloudflare Worker + база D1).
 * Хранит сотрудников, сессии и журнал обращений. Пароли хешируются здесь (PBKDF2),
 * уровень допуска и коды проверяются здесь же — браузеру доверять нельзя.
 */

import { ACTIONS, ADMIN_LEVEL, MARKET_ADMIN_LEVEL, MAX_LEVEL } from './config.js';
import {
  ASSETS,
  DOLE_COOLDOWN,
  DOLE_LIMIT,
  FEE,
  MAX_BET,
  marketPrice,
  tradeImpact,
  DEMAND_HALF_MS,
  HISTORY_TICKS,
  TICK_MS,
  ROULETTE_BETS,
  START_BALANCE,
  CRASH_GRACE_MS,
  crashMultiplier,
  crashPoint,
  rollDice,
  snapshot,
  spinRoulette,
  spinSlots,
  tickOf
} from './economy.js';

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
    env.DB.prepare('CREATE TABLE IF NOT EXISTS wallets (user_key TEXT PRIMARY KEY, balance INTEGER NOT NULL, dole_at INTEGER NOT NULL DEFAULT 0)'),
    env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS holdings (user_key TEXT NOT NULL, asset TEXT NOT NULL, qty INTEGER NOT NULL, cost INTEGER NOT NULL, PRIMARY KEY (user_key, asset))'
    ),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS demand (id INTEGER PRIMARY KEY AUTOINCREMENT, asset TEXT NOT NULL, t INTEGER NOT NULL, impact REAL NOT NULL)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS trades (id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, name TEXT NOT NULL, asset TEXT NOT NULL, side TEXT NOT NULL, qty INTEGER NOT NULL, price REAL NOT NULL, pct REAL NOT NULL)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS market_edits (asset TEXT PRIMARY KEY, base REAL, vol REAL, hidden INTEGER NOT NULL DEFAULT 0)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS custom_assets (id TEXT PRIMARY KEY, name TEXT NOT NULL, grp TEXT NOT NULL, kind TEXT NOT NULL, base REAL NOT NULL, vol REAL NOT NULL)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS rounds (user_key TEXT PRIMARY KEY, bet INTEGER NOT NULL, crash REAL NOT NULL, started INTEGER NOT NULL)')
  ]);
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS demand_asset ON demand (asset, t)').run();
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

async function wipeEconomy(env, key) {
  try {
    await ensureEconomy(env);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM wallets WHERE user_key = ?').bind(key),
      env.DB.prepare('DELETE FROM holdings WHERE user_key = ?').bind(key),
      env.DB.prepare('DELETE FROM rounds WHERE user_key = ?').bind(key)
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
    return { ...snapshot(now, seed, await loadDemand(env, now), await assetsOf(env)), ...state, fee: FEE, trades: await recentTrades(env), editor: row.level >= MARKET_ADMIN_LEVEL };
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

  if (path === '/api/wallet/dole' && method === 'POST') {
    const balance = await balanceOf(env, row.key);
    if (balance >= DOLE_LIMIT) throw new ApiError(409, 'no-dole');
    const result = await env.DB.prepare('UPDATE wallets SET balance = ?, dole_at = ? WHERE user_key = ? AND balance < ? AND dole_at <= ?')
      .bind(DOLE_LIMIT, now, row.key, DOLE_LIMIT, now - DOLE_COOLDOWN)
      .run();
    if (!result.meta.changes) {
      const wallet = await env.DB.prepare('SELECT dole_at FROM wallets WHERE user_key = ?').bind(row.key).first();
      return { error: 'dole-wait', wait: Math.max(0, wallet.dole_at + DOLE_COOLDOWN - now) };
    }
    return { dole: DOLE_LIMIT - balance, ...(await economyState(env, row.key)) };
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

  if (game === 'crash/start') {
    const bet = betOf(body);
    await balanceOf(env, row.key);
    await takeMoney(env, row.key, bet); // an abandoned earlier round simply stays lost
    await env.DB.prepare('INSERT OR REPLACE INTO rounds (user_key, bet, crash, started) VALUES (?, ?, ?, ?)').bind(row.key, bet, crashPoint(), now).run();
    return { started: now, bet, balance: await balanceOf(env, row.key) };
  }

  if (game === 'crash/status' || game === 'crash/cashout') {
    await ensureEconomy(env);
    const round = await env.DB.prepare('SELECT bet, crash, started FROM rounds WHERE user_key = ?').bind(row.key).first();
    if (!round) throw new ApiError(409, 'no-round');

    // the plane counts as crashed only once the network delay allowance has passed too,
    // so a press that left the player's screen before the crash is not lost to ping
    const elapsed = now - round.started;
    const high = crashMultiplier(elapsed);
    const low = crashMultiplier(Math.max(0, elapsed - CRASH_GRACE_MS));
    if (low >= round.crash) {
      await env.DB.prepare('DELETE FROM rounds WHERE user_key = ?').bind(row.key).run();
      return { crashed: true, at: round.crash, bet: round.bet, balance: await balanceOf(env, row.key) };
    }
    if (game === 'crash/status') return { alive: true };

    // the player reports the multiplier on their screen; it may only lie between "a moment ago" and "now"
    const claimed = Number(body.at);
    const asked = Number.isFinite(claimed) ? claimed : low;
    const multiplier = Math.max(1, Math.min(Math.max(low, Math.min(asked, high)), Math.floor((round.crash - 0.01) * 100) / 100));

    const taken = await env.DB.prepare('DELETE FROM rounds WHERE user_key = ?').bind(row.key).run();
    if (!taken.meta.changes) throw new ApiError(409, 'no-round');
    const payout = Math.floor(round.bet * multiplier);
    await giveMoney(env, row.key, payout);
    return { won: true, multiplier, bet: round.bet, payout, crashAt: round.crash, balance: await balanceOf(env, row.key) };
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
    if (added.n >= ADDUSER_PER_DAY) throw new ApiError(429, 'rate');

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
