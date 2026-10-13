/**
 * API ролевой консоли АнКо (Cloudflare Worker + база D1).
 * Хранит сотрудников, сессии и журнал обращений. Пароли хешируются здесь (PBKDF2),
 * уровень допуска и коды проверяются здесь же — браузеру доверять нельзя.
 */

import { ACTIONS, ADMIN_LEVEL, MAX_LEVEL } from './config.js';

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

  if (path === '/api/logout' && method === 'POST') {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
    return { ok: true };
  }

  if (path === '/api/me' && method === 'DELETE') {
    await env.DB.prepare('DELETE FROM sessions WHERE user_key = ?').bind(row.key).run();
    await env.DB.prepare('DELETE FROM attempts WHERE user_key = ?').bind(row.key).run();
    await env.DB.prepare('DELETE FROM mail WHERE to_key = ?').bind(row.key).run();
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
