/**
 * API ролевой консоли АнКо (Cloudflare Worker + база D1).
 * Хранит сотрудников, сессии и журнал обращений. Пароли хешируются здесь (PBKDF2),
 * уровень допуска и коды проверяются здесь же — браузеру доверять нельзя.
 */

import { ACTIONS, ADMIN_LEVEL, MARKET_ADMIN_LEVEL, MAX_LEVEL } from './config.js';
import { liarCall, liarForfeit, liarPlay, liarStart, liarTimeout, liarView } from './liar.js';
import { ARCADE_MAPS, arcadeAdvance, arcadeForfeit, arcadeStart, arcadeView } from './arcade.js';
import { TANK_MAPS, isDir, tankAdvance, tankForfeit, tankStart, tankView } from './tanks.js';
import {
  ASSETS,
  FEE,
  MAX_BET,
  marketPrice,
  tradeImpact,
  DEMAND_HALF_MS,
  HISTORY_TICKS,
  LIQUIDITY,
  MAX_IMPACT,
  TICK_MS,
  ROULETTE_BETS,
  START_BALANCE,
  CRASH_GRACE_MS,
  CRASH_BET_WINDOW_MS,
  CRASH_RESULT_MS,
  crashDurationMs,
  crashMultiplier,
  crashPoint,
  rollDice,
  snapshot,
  spinRoulette,
  spinSlots,
  randomFloat,
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
