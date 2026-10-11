/**
 * Everything the role-play console keeps in the browser: employee accounts,
 * the current session and the virtual file system built from `_data/console.yml`.
 * Accounts live in localStorage only — this is a game, not real security.
 */

const USERS_KEY = 'anco-console-users';
const SESSION_KEY = 'anco-console-session';

function readJson(storage, key, fallback) {
  try {
    return JSON.parse(storage.getItem(key) ?? 'null') ?? fallback;
  } catch {
    return fallback;
  }
}

function userKey(name) {
  return name.trim().toLowerCase();
}

export function loadUsers() {
  return readJson(localStorage, USERS_KEY, {});
}

export function saveUsers(users) {
  try {
    localStorage.setItem(USERS_KEY, JSON.stringify(users));
  } catch {
    // storage may be blocked (private mode): the session just will not persist
  }
}

export function getUser(name) {
  return loadUsers()[userKey(name)] ?? null;
}

export function updateUser(name, patch) {
  const users = loadUsers();
  const key = userKey(name);
  if (!users[key]) return null;
  users[key] = { ...users[key], ...patch };
  saveUsers(users);
  return users[key];
}

export function deleteUser(name) {
  const users = loadUsers();
  delete users[userKey(name)];
  saveUsers(users);
}

export function getSessionName() {
  try {
    return sessionStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

export function setSessionName(name) {
  try {
    if (name) sessionStorage.setItem(SESSION_KEY, name);
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // ignore
  }
}

function randomSalt() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hashPassword(password, salt) {
  const data = new TextEncoder().encode(`${salt}:${password}`);
  if (globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // insecure contexts have no SubtleCrypto: fall back to a simple checksum
  let h = 5381;
  for (const byte of data) h = ((h << 5) + h + byte) >>> 0;
  return h.toString(16);
}

export async function createUser({ name, department, password, level }) {
  const users = loadUsers();
  const key = userKey(name);
  if (users[key]) return null;

  const salt = randomSalt();
  users[key] = {
    name: name.trim(),
    department,
    salt,
    hash: await hashPassword(password, salt),
    baseLevel: level,
    level,
    codes: [],
    attempts: [],
    stats: { snake: 0, hacks: 0 },
    registered: Date.now()
  };
  saveUsers(users);
  return users[key];
}

export async function verifyUser(name, password) {
  const user = getUser(name);
  if (!user) return null;
  return (await hashPassword(password, user.salt)) === user.hash ? user : null;
}

export async function setPassword(name, password) {
  const salt = randomSalt();
  return updateUser(name, { salt, hash: await hashPassword(password, salt) });
}

export function logAttempt(name, entry) {
  const user = getUser(name);
  if (!user) return;
  const attempts = [...(user.attempts ?? []), { t: Date.now(), ...entry }].slice(-20);
  updateUser(name, { attempts });
}

/* ---------- virtual file system ---------- */

function normalize(path) {
  const parts = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

export function buildFs(files) {
  const byPath = new Map();
  const dirs = new Set(['/']);

  for (const file of files) {
    const path = normalize(file.path);
    byPath.set(path.toLowerCase(), { ...file, path });

    const parts = path.split('/').filter(Boolean);
    for (let i = 1; i < parts.length; i += 1) dirs.add(`/${parts.slice(0, i).join('/')}`);
  }

  const dirByLower = new Map([...dirs].map((d) => [d.toLowerCase(), d]));

  return {
    files: [...byPath.values()],
    resolve(cwd, input) {
      const raw = (input ?? '').trim();
      if (!raw || raw === '~') return '/';
      return normalize(raw.startsWith('/') ? raw : `${cwd}/${raw}`);
    },
    getFile: (path) => byPath.get(path.toLowerCase()) ?? null,
    getDir: (path) => dirByLower.get(path.toLowerCase()) ?? null,
    list(dirPath) {
      const prefix = dirPath === '/' ? '/' : `${dirPath}/`;
      const folders = new Set();
      const here = [];

      for (const file of byPath.values()) {
        if (!file.path.startsWith(prefix)) continue;
        const rest = file.path.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash === -1) here.push(file);
        else folders.add(rest.slice(0, slash));
      }

      return {
        folders: [...folders].sort((a, b) => a.localeCompare(b, 'ru')),
        files: here.sort((a, b) => a.path.localeCompare(b.path, 'ru'))
      };
    }
  };
}
