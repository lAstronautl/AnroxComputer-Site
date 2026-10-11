// Единый файл для вставки в редактор Worker в панели Cloudflare (собран из src/config.js + src/index.js).
// Не правьте вручную: меняйте src/ и пересобирайте (python3 worker/build-bundle.py).

const DEPARTMENTS = {
  staff: { name: 'Рядовой сотрудник', level: 1 },
  osn: { name: 'ОСН — отряд специального назначения', level: 2 },
  otkb: { name: 'ОтКБ — отряд корпоративной безопасности', level: 2 },
  dzis: { name: 'ДЗИС — департамент защиты интеллектуальной собственности', level: 2 },
  dkb: { name: 'ДКБ — департамент корпоративной безопасности', level: 2 }
};

const CODES = [
  { code: 'ВЕКТОР-7', level: 3 },
  { code: 'РУБИН-12', level: 4 },
  { code: 'ЧЁРНАЯ-ЖЕОДА', level: 5 }
];

const ACTIONS = new Set(['read', 'denied', 'bad-code', 'auth', 'hack-failed', 'article']);

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
  const { results } = await env.DB.prepare('SELECT t, action, target FROM attempts WHERE user_key = ? ORDER BY id DESC LIMIT ?')
    .bind(row.key, SHOW_ATTEMPTS)
    .all();

  return {
    name: row.name,
    department: row.department,
    baseLevel: row.base_level,
    level: row.level,
    codes: JSON.parse(row.codes),
    attempts: results.reverse().map((item) => ({ t: item.t, action: item.action, ...(item.target ? { target: item.target } : {}) })),
    stats: { snake: row.snake, hacks: row.hacks },
    registered: row.registered
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

/* ---------- routes ---------- */

async function register(request, env) {
  const body = await readBody(request);
  const name = String(body.name ?? '').trim();
  const password = String(body.password ?? '');
  const department = DEPARTMENTS[String(body.department ?? '')];

  if (!NAME_RULE.test(name)) throw new ApiError(400, 'bad-name');
  if (password.length < 4 || password.length > 100) throw new ApiError(400, 'bad-password');
  if (!department) throw new ApiError(400, 'bad-department');

  const key = userKey(name);
  if (await env.DB.prepare('SELECT key FROM users WHERE key = ?').bind(key).first()) throw new ApiError(409, 'taken');

  const salt = randomHex(16);
  await env.DB.prepare(
    'INSERT INTO users (key, name, department, salt, hash, base_level, level, registered) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  )
    .bind(key, name, department.name, salt, await hashPassword(password, salt), department.level, department.level, Date.now())
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

  if (path === '/api/auth' && method === 'POST') {
    const body = await readBody(request);
    const typed = String(body.code ?? '').trim().toUpperCase();
    const entry = CODES.find((item) => item.code.toUpperCase() === typed);

    if (!entry) {
      await addAttempt(env, row.key, 'bad-code', typed.slice(0, 120));
      throw new ApiError(400, 'invalid');
    }
    if (entry.level <= row.level) throw new ApiError(409, 'already');

    const codes = [...new Set([...JSON.parse(row.codes), entry.code])];
    await env.DB.prepare('UPDATE users SET level = ?, codes = ? WHERE key = ?').bind(entry.level, JSON.stringify(codes), row.key).run();
    await addAttempt(env, row.key, 'auth', `L${entry.level}`);
    const fresh = await env.DB.prepare('SELECT * FROM users WHERE key = ?').bind(row.key).first();
    return { user: await publicUser(env, fresh) };
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
